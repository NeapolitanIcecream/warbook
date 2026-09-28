import collections
import random
import unittest
from launch_batch import global_repeat, initialization_summary, policy_seed, scheduled_tasks


class InitializationScheduleTests(unittest.TestCase):
    def plan(self):
        return {'maps':['m1','m2'],'opponents':{'o1':{},'o2':{}},'subjects':{'base':{},'minus':{},'plus':{}},'rounds':4,'orderSeed':19}

    def test_default_matches_existing_shuffle_seed_and_swap_semantics(self):
        plan=self.plan()
        tasks=[(m,o,r,s) for m in plan['maps'] for o in plan['opponents'] for r in range(4) for s in plan['subjects']]
        random.Random(19).shuffle(tasks)
        self.assertEqual(scheduled_tasks(plan),tasks)
        self.assertEqual(global_repeat(plan,3),3)
        self.assertEqual(policy_seed(plan,{},'m2','o2',3),100000+3*31+7+1)

    def test_one_round_passes_cover_both_slots_and_continue_policy_stream_ids(self):
        seeds=[];slots=[]
        for offset in range(4):
            plan={**self.plan(),'rounds':1,'repeatOffset':offset}
            slots.append(global_repeat(plan,0)%2)
            seeds.append(policy_seed(plan,{'policySeed':47},'m1','o1',0))
        self.assertEqual(slots,[0,1,0,1])
        self.assertEqual(seeds,[4700000,4700031,4700062,4700093])
        self.assertEqual(policy_seed({**self.plan(),'repeatOffset':3},{'policySeed':47},'m1','o1',0),policy_seed(self.plan(),{'policySeed':47},'m1','o1',3))

    def test_interleaving_keeps_all_arms_together_and_balances_queue_positions(self):
        plan={**self.plan(),'schedule':'interleaved'};tasks=scheduled_tasks(plan)
        self.assertEqual(set(tasks),set(scheduled_tasks(self.plan())))
        positions=collections.defaultdict(collections.Counter)
        for i in range(0,len(tasks),3):
            block=tasks[i:i+3]
            self.assertEqual(len({t[:3] for t in block}),1)
            self.assertEqual({t[3] for t in block},set(plan['subjects']))
            for pos,task in enumerate(block):positions[task[3]][pos]+=1
        for counts in positions.values():self.assertLessEqual(max(counts.values())-min(counts.values()),1)
        self.assertEqual(tasks,scheduled_tasks(plan))

    def test_bad_offsets_or_schedule_are_rejected(self):
        for offset in [-1,0.5,True,'1']:
            with self.assertRaises(ValueError):scheduled_tasks({**self.plan(),'repeatOffset':offset})
        with self.assertRaises(ValueError):scheduled_tasks({**self.plan(),'schedule':'unsupported'})

    def test_summary_counts_shared_sources_across_arms_and_preserves_missing_records(self):
        rows=[{'subject':s,'initialization':{'randomSourceKey':key}} for s,key in [('base','0:1'),('plus','0:1'),('base','0:2')]]
        rows.append({'subject':'plus','initialization':None})
        summary=initialization_summary(rows)
        self.assertEqual([summary[k] for k in ['games','recorded','sources','repeatedSources','gamesInRepeatedSources','largestSource']],[4,3,2,1,2,2])
        self.assertEqual(summary['bySubject']['plus']['recorded'],1)


if __name__=='__main__':unittest.main()
