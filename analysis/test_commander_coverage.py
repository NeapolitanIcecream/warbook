"""Actor-frame coverage and independently seeded, rank-local anchor scheduling."""
import argparse
import datetime
import random
import tempfile
import unittest
from pathlib import Path

import torch
import torch.distributed as dist
import torch.multiprocessing as mp

from commander_train import ActorFrameCoverage,AnchorScheduler,anchor_frames,anchor_windows,coverage_suffix,positive_float,windows


def episode(path,sources):
    return {'path':path,'ppo':True,'rows':[{'tick':75*i,'executionSource':source} for i,source in enumerate(sources)]}


def distributed_coverage(rank,world_size,rendezvous):
    torch.set_num_threads(1)
    dist.init_process_group('gloo',init_method='file://'+rendezvous,rank=rank,world_size=world_size,
                            timeout=datetime.timedelta(seconds=30))
    try:
        source=episode(str(rank),['teacher']+['policy']*(3 if rank==0 else 5))
        blocks=windows([source],3,2)
        tracker=ActorFrameCoverage(8,[.25,.5,1.],1.)
        for update in range(2):
            batch=[blocks[update]] if update<len(blocks) else []
            crossed=tracker.observe([batch],update+1,world_size)
            # Exercise a collective for every triggered checkpoint: a local-only
            # trigger would hang or produce different gathered endpoint lists.
            for endpoint in crossed:
                all_endpoints=[None]*world_size;dist.all_gather_object(all_endpoints,endpoint)
                if any(value!=endpoint for value in all_endpoints):raise AssertionError('Ranks crossed different endpoints')
        if tracker.used!=8 or tracker.unique!=8 or not tracker.reached():raise AssertionError('Wrong global coverage')
        if [point['updates'] for point in tracker.endpoints]!=[1,1,2]:raise AssertionError('Wrong global checkpoint boundary')
    finally:dist.destroy_process_group()


class CoverageTests(unittest.TestCase):
    def test_effective_frames_ignore_burn_teacher_rows_and_absent_padding(self):
        source=episode('a',['teacher','policy','policy','teacher','policy','policy','policy'])
        blocks=windows([source],3,2)
        tracker=ActorFrameCoverage(5,[.25,.5,1.],.5)
        first=tracker.observe([[blocks[0],blocks[1]]],1)
        self.assertEqual([point['requestedCoverage'] for point in first],[.25,.5])
        self.assertEqual(tracker.used,4);self.assertEqual(tracker.unique,4);self.assertTrue(tracker.reached())
        self.assertEqual([point['overshootActorFrames'] for point in first],[2,1])
        final=tracker.observe([[blocks[2]]],2)
        self.assertEqual(final[0]['actualActorFrames'],5)
        self.assertEqual(tracker.metadata()['uniqueCoverage'],1.)
        self.assertEqual(tracker.metadata()['repeatedActorFrames'],0)

    def test_reuse_is_reported_separately_and_each_endpoint_fires_once(self):
        source=episode('a',['policy']*4);block=windows([source],2,0)[0]
        tracker=ActorFrameCoverage(4,[.5,1.],1.)
        snapshot=tracker.metadata()
        self.assertEqual(len(tracker.observe([[block]],1)),1)
        self.assertEqual(len(tracker.observe([[block]],2)),1)
        self.assertEqual(tracker.observe([[block]],3),[])
        self.assertEqual((tracker.used,tracker.unique),(6,2))
        self.assertEqual(tracker.metadata()['repeatedActorFrames'],4)
        self.assertEqual(tracker.metadata()['effectiveCoverage'],1.5)
        self.assertEqual(tracker.metadata()['uniqueCoverage'],.5)
        self.assertEqual(snapshot['checkpoints'],[])

    def test_coverage_fraction_validation_and_stable_suffixes(self):
        self.assertEqual(positive_float('.25'),.25)
        self.assertEqual([coverage_suffix(x) for x in [.25,.5,1.]],['-coverage-0p25','-coverage-0p5','-coverage-1'])
        for value in ['0','-1','nan','inf']:
            with self.subTest(value=value),self.assertRaises(argparse.ArgumentTypeError):positive_float(value)

    def test_16_rank_local_batch_2_rotates_8_global_anchor_windows(self):
        sources=[episode('fixed',['teacher']*16),episode('current',['policy']*16)]
        pools=[anchor_windows([source],16) for source in sources]
        samplers=[AnchorScheduler(pools,[[1,1]]*16,rank,100+rank,.25) for rank in range(16)]
        owners=[]
        for _ in range(2):
            selected=[sampler.select(32)[0] for sampler in samplers]
            owners.append({rank for rank,items in enumerate(selected) if items})
            self.assertEqual(sum(map(len,selected)),8)
            self.assertTrue(all(len(items)<=1 for items in selected))
            self.assertEqual([sum(source==which for items in selected for source,_ in items) for which in range(2)],[4,4])
            self.assertEqual(sum(anchor_frames([window for _,window in items]) for items in selected),128)
        self.assertFalse(owners[0]&owners[1]);self.assertEqual(owners[0]|owners[1],set(range(16)))

    def test_short_updates_and_empty_source_ranks_preserve_source_mix(self):
        fixed=anchor_windows([episode('fixed',['policy']*2)],2)
        current=anchor_windows([episode('current',['policy']*2)],2)
        samplers=[AnchorScheduler([fixed,[]],[[1,0],[0,1],[0,0]],0,2,.25),
                  AnchorScheduler([[],current],[[1,0],[0,1],[0,0]],1,3,.25),
                  AnchorScheduler([[],[]],[[1,0],[0,1],[0,0]],2,4,.25)]
        chosen=[[],[],[]]
        for _ in range(8):
            for rank,sampler in enumerate(samplers):chosen[rank].extend(sampler.select(1)[0])
        self.assertEqual([len(items) for items in chosen],[1,1,0])
        self.assertEqual(chosen[0][0][0],0);self.assertEqual(chosen[1][0][0],1)

    def test_anchor_sampling_does_not_change_rl_window_shuffle(self):
        pools=[anchor_windows([episode('fixed',['policy']*9)],3),anchor_windows([episode('current',['policy']*9)],3)]
        random.seed(47);before=random.getstate();expected=list(range(40));random.shuffle(expected)
        random.setstate(before);sampler=AnchorScheduler(pools,[[3,3]],0,123,.25)
        for _ in range(12):sampler.select(32)
        actual=list(range(40));random.shuffle(actual)
        self.assertEqual(actual,expected)

    def test_real_ddp_unequal_local_frames_trigger_same_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            mp.spawn(distributed_coverage,args=(2,str(Path(directory)/'rendezvous')),nprocs=2,join=True)


if __name__=='__main__':unittest.main()
