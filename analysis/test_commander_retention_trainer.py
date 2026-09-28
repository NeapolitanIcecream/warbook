"""Retention/PPO integration: separate means, unchanged RNG, one Adam and DDP."""
import argparse
import copy
import datetime
import hashlib
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch
import torch.distributed as dist
import torch.multiprocessing as mp
from torch.nn.parallel import DistributedDataParallel

from commander_model import CommanderModel,HIDDEN,export,pack,pack_actions
from commander_retention import build_teacher_cache
from commander_train import (RetentionObjective,SequenceObjective,anchor_windows,batch_steps,
                             backward_microbatches,backward_with_retention,load_model,prepare_retention,windows)
from test_commander_temperature import fixture


def toy_rows(indices):
    return [{'executionSource':'policy','x':[i/7.,(i%3-1)/2.],'target':(i%5)/4.} for i in indices]


def rl_block(rows):return [({'ppo':True},[],rows)] if rows else []


def anchor_block(rows):return [({'path':'anchor','rows':rows},0,len(rows))] if rows else []


def mean_square(model,rows):
    if not rows:return sum(parameter.sum()*0 for parameter in model.parameters())
    dtype=next(model.parameters()).dtype
    x=torch.tensor([row['x'] for row in rows],dtype=dtype);target=torch.tensor([row['target'] for row in rows],dtype=dtype)
    return (model(x).squeeze(-1)-target).square().mean()


class DualObjective(torch.nn.Module):
    def __init__(self,dtype=torch.float64):
        super().__init__();self.model=torch.nn.Sequential(torch.nn.Linear(2,3),torch.nn.Tanh(),torch.nn.Linear(3,1)).to(dtype)
        self.anchor_calls=0
    def forward(self,batch,kind='rl'):
        if kind=='rl':
            rows=[row for _,_,records in batch for row in records if row['executionSource']=='policy']
            return mean_square(self.model,rows),0.,len(rows),torch.zeros(0)
        self.anchor_calls+=1;rows=[row for episode,start,end in batch for row in episode['rows'][start:end]]
        return mean_square(self.model,rows),len(rows),{}


def distributed_retention(rank,world_size,rendezvous):
    torch.set_num_threads(1)
    dist.init_process_group('gloo',init_method='file://'+rendezvous,rank=rank,world_size=world_size,
                            timeout=datetime.timedelta(seconds=45))
    try:
        torch.manual_seed(31);objective=DualObjective();expected=copy.deepcopy(objective.model)
        parallel=DistributedDataParallel(objective,broadcast_buffers=False);communication={'calls':0}
        def hook(state,bucket):
            state['calls']+=1;buffer=bucket.buffer().div_(world_size)
            return dist.all_reduce(buffer,async_op=True).get_future().then(lambda result:result.value()[0])
        parallel.register_comm_hook(communication,hook)
        optimizer=torch.optim.Adam(objective.parameters(),lr=.003);reference_optimizer=torch.optim.Adam(expected.parameters(),lr=.003)
        for update in range(2):
            # Rank 1 has no anchors; the second update also has no RL work on
            # rank 0. Both accumulated contributions must survive the last sync.
            rl_by_rank=[[toy_rows([0,1,2]),toy_rows([3])],[toy_rows([4]),toy_rows([5,6])]] if update==0 else [[[],[]],[toy_rows([7,8]),[]]]
            anchor_by_rank=[[toy_rows([9,10]),toy_rows([11])],[[],[]]]
            rl=[rl_block(rows) for rows in rl_by_rank[rank]];anchors=[anchor_block(rows) for rows in anchor_by_rank[rank]]
            optimizer.zero_grad();backward_with_retention(parallel,rl,anchors,world_size,.7)
            reference_optimizer.zero_grad()
            combined=mean_square(expected,[row for groups in rl_by_rank for group in groups for row in group])+.7*mean_square(expected,[row for groups in anchor_by_rank for group in groups for row in group])
            combined.backward()
            for actual,reference in zip(objective.model.parameters(),expected.parameters()):
                torch.testing.assert_close(actual.grad,reference.grad,rtol=1e-12,atol=1e-12)
            if communication['calls']!=update+1:raise AssertionError('Expected one DDP reduction per combined update')
            torch.nn.utils.clip_grad_norm_(objective.parameters(),.5);torch.nn.utils.clip_grad_norm_(expected.parameters(),.5)
            optimizer.step();reference_optimizer.step()
            for actual,reference in zip(objective.model.parameters(),expected.parameters()):
                torch.testing.assert_close(actual,reference,rtol=1e-12,atol=1e-12)
            if any(state['step']!=update+1 for state in optimizer.state.values()):raise AssertionError('More than one Adam step')
    finally:dist.destroy_process_group()


def model_episode(model,path='fixture',length=4,reward=1.):
    rows=[];hidden=torch.zeros(1,HIDDEN)
    with torch.no_grad():
        for index in range(length):
            world,action=fixture();world['tick']=index*75;world['global'][0]=index*.03
            data=pack([world],model.vocabulary);prediction=model(data,hidden,pack_actions([action],data))
            rows.append({'schema':'commander-v1','encoding':model.encoding,'temperature':model.temperature,
                         'productionTemperatures':model.effective_production_temperatures(),
                         'tick':index*75,'world':world,'action':action,'executionSource':'policy',
                         'hidden':hidden[0].tolist(),'logp':float(prediction['logp'][0]),'value':float(prediction['value'][0]),
                         '_advantage':(-1.)**index})
            hidden=prediction['hidden']
    return {'path':str(path),'ppo':True,'reward':reward,'rows':rows}


def write_episode(episode,sha):
    path=Path(episode['path']);path.mkdir()
    config={key:episode['rows'][0][key] for key in ['encoding','temperature','productionTemperatures']}
    manifest={'git':'synthetic-mechanism-fixture','participants':[{'role':'subject','name':'a'},{'role':'opponent','name':'b'}],
              'commanderExperiment':{**config,'modelSha256':sha,'deterministic':False,'executionMode':'native-finite-batches-v1'},
              'sourceHashes':{'src/commander/world.ts':'fixture-encoder'}}
    survivor='a' if episode['reward'] else 'b'
    result={'tick':episode['rows'][-1]['tick']+75,'cleanCompletionVerified':True,
            'stopState':{'status':'Ended','turnManagerError':False},'outcome':{'survivor':survivor},
            'stats':[{'name':name,'defeated':name!=survivor} for name in ['a','b']]}
    (path/'manifest.json').write_text(json.dumps(manifest));(path/'result.json').write_text(json.dumps(result))
    (path/'decisions.ndjson').write_text(''.join(json.dumps({'actor':'a','kind':'commander_decision','record':row})+'\n' for row in episode['rows']))
    episode.update({'modelSha':sha,'encoderSha':'fixture-encoder','behavior':manifest['commanderExperiment'],'deterministic':False})


class RetentionTrainerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def test_separate_global_means_match_combined_reference_gradient(self):
        torch.manual_seed(3);objective=DualObjective();reference=copy.deepcopy(objective.model)
        rl=toy_rows(range(7));anchors=toy_rows(range(10,13))
        backward_with_retention(objective,[rl_block(rl[:1]),[],rl_block(rl[1:])],[anchor_block(anchors[:2]),anchor_block(anchors[2:])],1,.4)
        (mean_square(reference,rl)+.4*mean_square(reference,anchors)).backward()
        for actual,expected in zip(objective.model.parameters(),reference.parameters()):torch.testing.assert_close(actual.grad,expected.grad,rtol=1e-12,atol=1e-12)

    def test_zero_weight_is_bit_exact_and_never_calls_anchor_forward(self):
        torch.manual_seed(11);original=DualObjective(torch.float32);actual=copy.deepcopy(original)
        rows=toy_rows(range(8));batches=[rl_block(rows[:3]),rl_block(rows[3:])]
        backward_microbatches(original,batches,1)
        backward_with_retention(actual,batches,[anchor_block(toy_rows(range(50,54)))],1,0.)
        self.assertEqual(actual.anchor_calls,0)
        for left,right in zip(actual.parameters(),original.parameters()):self.assertTrue(torch.equal(left.grad,right.grad))

    def test_actor_calibration_omits_value_heads(self):
        torch.manual_seed(7);model=CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.2)
        episode=model_episode(model);args=argparse.Namespace(method='ppo',burn=1,sequence=2,entropy=.001)
        loss,_,_,_=batch_steps(windows([episode],2,1)[:1],model,args,True,actor_only=True);loss.backward()
        for name,value in model.named_parameters():
            if name.startswith(('value0.','value1.')):self.assertIsNone(value.grad,name)
        self.assertGreater(float(model.queueSpecial.weight.grad.norm()),0.)

    def test_reference_preparation_keeps_rng_actions_and_ddp_parameter_tree(self):
        torch.manual_seed(19);model=CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.2)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);reference=root/'c0.json';sha=export(model,reference,{})
            episode=model_episode(model,root/'episode');write_episode(episode,sha)
            paths=root/'anchors.json';paths.write_text(json.dumps([episode['path']]))
            args=argparse.Namespace(retention_reference=str(reference),retention_episodes=str(paths),retention_fraction=.25,retention_weight=.1,sequence=2,seed=47,method='ppo',burn=1,entropy=.001)
            before_actions=copy.deepcopy([row['action'] for row in episode['rows']]);before_torch=torch.random.get_rng_state();before_random=random.getstate()
            retention,scheduler,metadata=prepare_retention(args,model,[episode],0,1,'fixture-encoder',{'native-finite-batches-v1'})
            for _ in range(4):scheduler.select(4)
            self.assertTrue(torch.equal(torch.random.get_rng_state(),before_torch));self.assertEqual(random.getstate(),before_random)
            self.assertEqual([row['action'] for row in episode['rows']],before_actions)
            objective=SequenceObjective(model,args,retention)
            self.assertEqual({id(parameter) for parameter in objective.parameters()},{id(parameter) for parameter in model.parameters()})
            self.assertEqual(metadata['cachePreparationFrames'],4)
            self.assertTrue(all(not parameter.requires_grad for parameter in retention.teacher.parameters()))

    def test_cli_zero_control_checkpoint_aliases_and_matched_adam(self):
        torch.manual_seed(23);model=CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.2)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);reference=root/'c0.json'
            optimizer=torch.optim.Adam(model.parameters(),lr=.002)
            sum(parameter.square().sum()*1e-6 for parameter in model.parameters()).backward();optimizer.step();optimizer.zero_grad()
            sha=export(model,reference,{});torch.save(optimizer.state_dict(),reference.with_suffix('.optimizer.pt'))
            paths=[]
            for i in range(4):
                episode=model_episode(model,root/f'episode-{i}',4,float(i%2));write_episode(episode,sha);paths.append(episode['path'])
            episodes=root/'episodes.json';episodes.write_text(json.dumps(paths));anchors=root/'anchors.json';anchors.write_text(json.dumps(paths[:1]))
            command=[sys.executable,str(Path(__file__).with_name('commander_train.py')),'ppo','--episodes',str(episodes),'--input',str(reference),
                     '--epochs','1','--batch','2','--sequence','2','--burn','1','--threads','1','--max-updates','3','--learning-rate','.0001']
            for name,extra in [('plain',[]),('zero',['--retention-weight','0','--retention-reference',str(reference),'--retention-episodes',str(anchors),
                                                   '--max-coverage','1','--coverage-checkpoints','.01','.25','.5','--update-checkpoints','1']),
                               ('plus',['--retention-weight','.001','--retention-reference',str(reference),'--retention-episodes',str(anchors),'--max-coverage','1'])]:
                result=subprocess.run(command+['--out',str(root/(name+'.json'))]+extra,capture_output=True,text=True,timeout=120)
                self.assertEqual(result.returncode,0,result.stderr)
            plain=json.loads((root/'plain.json').read_text());zero=json.loads((root/'zero.json').read_text())
            self.assertEqual(plain['tensors'],zero['tensors'])
            states=[torch.load(root/(name+'.optimizer.pt'),weights_only=True) for name in ['plain','zero']]
            self.assertEqual(states[0]['param_groups'],states[1]['param_groups'])
            for index in states[0]['state']:
                for key,value in states[0]['state'][index].items():self.assertTrue(torch.equal(value,states[1]['state'][index][key]))
            self.assertEqual((root/'zero-update-1.json').read_bytes(),(root/'zero-coverage-0p01.json').read_bytes())
            self.assertEqual((root/'zero-update-1.json').read_bytes(),(root/'zero-coverage-0p25.json').read_bytes())
            self.assertEqual((root/'zero-update-1.optimizer.pt').read_bytes(),(root/'zero-coverage-0p25.optimizer.pt').read_bytes())
            metadata=json.loads((root/'zero.training.json').read_text());self.assertEqual(metadata['optimizerStart'],'restored')
            self.assertEqual(metadata['inputOptimizerSha256'],hashlib.sha256(reference.with_suffix('.optimizer.pt').read_bytes()).hexdigest())
            self.assertEqual(metadata['coverage']['actorFrameUses'],12);self.assertEqual(metadata['coverage']['uniqueActorFrames'],12)
            self.assertEqual(metadata['advantageNormalization']['count'],16)
            update=json.loads((root/'zero-update-1.json').read_text());self.assertEqual(update['training']['advantageNormalization'],metadata['advantageNormalization'])
            plus=json.loads((root/'plus.training.json').read_text());usage=plus['trainingUsage']['retention']
            self.assertEqual((usage['fixedWindowUses'],usage['currentWindowUses']),(1,1))
            self.assertEqual(usage['activeFrames'],4);self.assertGreater(usage['studentPrefixFrames'],0)
            self.assertGreater(usage['forwardCpuSeconds'],0.);self.assertEqual(plus['retention']['referenceSha256'],sha)
            self.assertEqual(plus['inputOptimizerSha256'],metadata['inputOptimizerSha256'])

    def test_real_ddp_empty_anchor_rank_and_one_clip_adam_update(self):
        with tempfile.TemporaryDirectory() as directory:
            mp.spawn(distributed_retention,args=(2,str(Path(directory)/'rendezvous')),nprocs=2,join=True)

    def test_commander_cli_ddp_with_fixed_source_on_one_rank(self):
        torch.manual_seed(43);model=CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.2)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);reference=root/'c0.json';sha=export(model,reference,{})
            sources=[]
            for i in range(4):
                episode=model_episode(model,root/f'episode-{i}',3,float(i%2));write_episode(episode,sha);sources.append(episode['path'])
            episodes=root/'episodes.json';episodes.write_text(json.dumps(sources))
            anchors=root/'anchors.json';anchors.write_text(json.dumps(sources[:1]))
            command=[sys.executable,'-m','torch.distributed.run','--standalone','--nproc-per-node','2',str(Path(__file__).with_name('commander_train.py')),
                     'ppo','--episodes',str(episodes),'--input',str(reference),'--out',str(root/'plus.json'),
                     '--epochs','1','--batch','1','--sequence','2','--burn','1','--threads','1','--max-updates','3',
                     '--retention-reference',str(reference),'--retention-episodes',str(anchors),'--retention-weight','.001',
                     '--max-coverage','1','--coverage-checkpoints','.25','.5','--update-checkpoints','1']
            result=subprocess.run(command,capture_output=True,text=True,timeout=120)
            self.assertEqual(result.returncode,0,result.stderr)
            metadata=json.loads((root/'plus.training.json').read_text());usage=metadata['trainingUsage']['retention']
            self.assertEqual(metadata['worldSize'],2);self.assertEqual(metadata['updates'],3)
            self.assertEqual([count[0] for count in metadata['retention']['windowCountsByRank']],[2,0])
            self.assertEqual((usage['fixedWindowUses'],usage['currentWindowUses']),(1,1))
            self.assertEqual(usage['nonemptyRankMicrobatches'],2)
            self.assertEqual(metadata['coverage']['availableActorFrames'],12)
            self.assertEqual(metadata['coverage']['repeatedActorFrames'],0)
            self.assertTrue((root/'plus-coverage-0p25.done.json').exists())
            self.assertTrue((root/'plus-coverage-0p5.done.json').exists())


if __name__=='__main__':unittest.main()
