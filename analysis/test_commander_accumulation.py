"""Global-frame accumulation checks against single combined batches and real DDP."""
import argparse
import copy
import datetime
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch
import torch.distributed as dist
import torch.multiprocessing as mp
from torch.nn.parallel import DistributedDataParallel

from commander_train import active_frames,backward_microbatches,microbatch_groups,positive_int


def frame(i,source='policy'):
    return {'executionSource':source,'x':[i/7.,(i%3-1)/2.], 'target':(i%5)/4.}


def block(rows):
    return [({'ppo':True},[frame(90,'teacher')],rows)] if rows else []


class SmallObjective(torch.nn.Module):
    def __init__(self,dtype=torch.float64):
        super().__init__()
        self.model=torch.nn.Sequential(torch.nn.Linear(2,3),torch.nn.Tanh(),torch.nn.Linear(3,1)).to(dtype)
    def forward(self,batch):
        rows=[r for e,_,records in batch for r in records if not e.get('ppo') or r['executionSource']=='policy']
        if rows:
            dtype=next(self.parameters()).dtype
            x=torch.tensor([r['x'] for r in rows],dtype=dtype)
            y=torch.tensor([r['target'] for r in rows],dtype=dtype)
            loss=(self.model(x).squeeze(-1)-y).square().mean()
        else:loss=sum(p.sum()*0 for p in self.parameters())
        return loss,0.,len(rows),torch.zeros(0)


def combined_loss(model,rows):
    dtype=next(model.parameters()).dtype
    x=torch.tensor([r['x'] for r in rows],dtype=dtype)
    y=torch.tensor([r['target'] for r in rows],dtype=dtype)
    return (model(x).squeeze(-1)-y).square().mean()


def assert_gradients(actual,expected):
    for a,e in zip(actual.parameters(),expected.parameters()):
        torch.testing.assert_close(a.grad,e.grad,rtol=1e-12,atol=1e-12)


def distributed_worker(rank,world_size,rendezvous):
    torch.set_num_threads(1)
    dist.init_process_group('gloo',init_method='file://'+rendezvous,rank=rank,world_size=world_size,
                            timeout=datetime.timedelta(seconds=45))
    try:
        torch.manual_seed(37)
        objective=SmallObjective()
        reference=copy.deepcopy(objective.model)
        parallel=DistributedDataParallel(objective,broadcast_buffers=False)
        communication={'calls':0}
        def hook(state,bucket):
            state['calls']+=1
            buffer=bucket.buffer().div_(world_size)
            return dist.all_reduce(buffer,async_op=True).get_future().then(lambda result:result.value()[0])
        parallel.register_comm_hook(communication,hook)
        # Empty rank 1 in the last microbatch of group 1 still flushes its earlier
        # gradients; group 2 is short and has an entirely empty rank 0.
        ranks=[[[frame(0),frame(1),frame(2)],[],[frame(3),frame(4)],[],[]],
               [[],[frame(5),frame(6),frame(7),frame(8)],[],[frame(9),frame(10)],[]]]
        optimizer=torch.optim.Adam(objective.parameters(),lr=.002)
        expected_optimizer=torch.optim.Adam(reference.parameters(),lr=.002)
        for update,indices in enumerate(microbatch_groups(5,3),1):
            batches=[block(ranks[rank][i]) for i in indices]
            optimizer.zero_grad()
            result=backward_microbatches(parallel,batches,world_size)
            expected_optimizer.zero_grad()
            rows=[row for r in ranks for i in indices for row in r[i]]
            combined_loss(reference,rows).backward()
            assert_gradients(objective.model,reference)
            if sum(r[2] for r in result)!=sum(len(ranks[rank][i]) for i in indices):
                raise AssertionError('Wrong local active frame count')
            if communication['calls']!=update:
                raise AssertionError('DDP did not synchronize exactly once per accumulation group')
            torch.nn.utils.clip_grad_norm_(objective.parameters(),.5)
            torch.nn.utils.clip_grad_norm_(reference.parameters(),.5)
            optimizer.step();expected_optimizer.step()
            for actual,expected in zip(objective.model.parameters(),reference.parameters()):
                torch.testing.assert_close(actual,expected,rtol=1e-12,atol=1e-12)
    finally:
        dist.destroy_process_group()


class AccumulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)

    def test_unequal_active_frames_match_one_combined_batch(self):
        torch.manual_seed(3)
        objective=SmallObjective()
        reference=copy.deepcopy(objective.model)
        rows=[frame(i) for i in range(8)]
        batches=[block(rows[:1]+[frame(30,'teacher')]),block(rows[1:6]),[],block(rows[6:])]
        self.assertEqual([active_frames(b) for b in batches],[1,5,0,2])
        result=backward_microbatches(objective,batches,1)
        combined_loss(reference,rows).backward()
        assert_gradients(objective.model,reference)
        self.assertEqual(sum(r[2] for r in result),8)
        # Weighting by microbatch count instead of frames would fail this objective.
        self.assertAlmostEqual(sum(loss*n for loss,_,n,_ in result)/8,float(combined_loss(reference,rows).detach()),places=12)

    def test_trailing_group_takes_one_step_on_its_actual_frames(self):
        torch.manual_seed(7)
        objective=SmallObjective()
        reference=copy.deepcopy(objective.model)
        samples=[[frame(0)],[frame(1),frame(2),frame(3)],[],[frame(4),frame(5)],[]]
        optimizer=torch.optim.Adam(objective.parameters(),lr=.003)
        expected_optimizer=torch.optim.Adam(reference.parameters(),lr=.003)
        groups=list(microbatch_groups(len(samples),3))
        self.assertEqual([len(g) for g in groups],[3,2])
        for indices in groups:
            optimizer.zero_grad()
            backward_microbatches(objective,[block(samples[i]) for i in indices],1)
            expected_optimizer.zero_grad()
            combined_loss(reference,[r for i in indices for r in samples[i]]).backward()
            assert_gradients(objective.model,reference)
            torch.nn.utils.clip_grad_norm_(objective.parameters(),.5)
            torch.nn.utils.clip_grad_norm_(reference.parameters(),.5)
            optimizer.step();expected_optimizer.step()
        for actual,expected in zip(objective.model.parameters(),reference.parameters()):
            torch.testing.assert_close(actual,expected,rtol=1e-12,atol=1e-12)
        self.assertTrue(all(state['step'].item()==2 for state in optimizer.state.values()))

    def test_default_one_matches_original_float32_update_bit_for_bit(self):
        torch.manual_seed(13)
        objective=SmallObjective(torch.float32)
        original=copy.deepcopy(objective)
        optimizer=torch.optim.Adam(objective.parameters(),lr=.003)
        old_optimizer=torch.optim.Adam(original.parameters(),lr=.003)
        for rows in [[frame(1),frame(2)],[frame(3)],[frame(4),frame(5),frame(6)]]:
            batch=block(rows)
            optimizer.zero_grad()
            backward_microbatches(objective,[batch],1)
            torch.nn.utils.clip_grad_norm_(objective.parameters(),.5)
            optimizer.step()
            # The former trainer sequence, including when zero_grad is called.
            loss,_,frames,_=original(batch)
            total=torch.tensor(float(frames),dtype=torch.float64)
            old_optimizer.zero_grad();(loss*(frames/float(total))).backward()
            torch.nn.utils.clip_grad_norm_(original.parameters(),.5)
            old_optimizer.step()
        for actual,expected in zip(objective.parameters(),original.parameters()):
            self.assertTrue(torch.equal(actual,expected))
            for key,value in optimizer.state[actual].items():
                self.assertTrue(torch.equal(value,old_optimizer.state[expected][key]))

    def test_empty_global_group_is_rejected_before_backward(self):
        with self.assertRaisesRegex(ValueError,'Global empty'):
            backward_microbatches(SmallObjective(),[[],[]],1)

    def test_positive_accumulation_argument(self):
        self.assertEqual(positive_int('8'),8)
        for value in ['0','-1']:
            with self.assertRaises(argparse.ArgumentTypeError):positive_int(value)

    def test_bc_rejects_accumulation_before_loading_data(self):
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('commander_train.py')),
            'bc','--episodes','missing-episodes','--out','unused-output','--gradient-accumulation','2'],
            capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Gradient accumulation is PPO-only',result.stderr)

    def test_real_ddp_empty_rank_short_group_and_one_reduction_per_update(self):
        with tempfile.TemporaryDirectory() as directory:
            mp.spawn(distributed_worker,args=(2,str(Path(directory)/'rendezvous')),nprocs=2,join=True)


if __name__=='__main__':unittest.main()
