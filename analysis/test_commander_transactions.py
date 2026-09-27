import copy
import json
import math
import subprocess
import unittest
from pathlib import Path

from commander_transactions import AMOUNTS,CASH_FLOORS,analyze_records,committed_stock,summarize

CATALOGUE=[{'name':'MTNK','queue':3},{'name':'CMIN','queue':3},
           {'name':'GAREFN','queue':0,'grants':'CMIN'}]


def observation(tick,own=None,items=None,status=0,credits=1000):
    queues=[{'type':q,'status':0,'size':0,'items':[]} for q in range(6)]
    queues[3].update(status=status,items=items or [],size=sum(x['quantity'] for x in items or []))
    return {'tick':tick,'credits':credits,'own':own if own is not None else [{'ref':'t1','name':'MTNK'},{'ref':'t2','name':'MTNK'}],
            'queues':queues,'catalogue':copy.deepcopy(CATALOGUE)}


def records(observation,choice=0,amount=1,reserve=0,queue=3):
    obs=observation;products=[]
    for p in obs['catalogue']:
        row=[0.]*24;row[17]=1;row[18]=math.log1p(sum(u['name']==p['name'] for u in obs['own']))/5
        row[19]=math.log1p(committed_stock(obs,p['name']))/5;products.append(row)
    global_features=[0.]*32;global_features[1]=math.log1p(obs['credits'])/10
    world={'tick':obs['tick'],'ownRefs':[u['ref'] for u in obs['own']],
      'entityNames':[u['name'] for u in obs['own']],'productNames':[p['name'] for p in obs['catalogue']],
      'productQueues':[p['queue'] for p in obs['catalogue']],'products':products,
      'global':global_features,'queues':[[q['status']]+[0.]*15 for q in obs['queues']]}
    action={'queues':[0]*6,'amounts':[0]*6,'cash':[0]*6};action['queues'][queue]=choice
    action['amounts'][queue]=AMOUNTS.index(amount);action['cash'][queue]=CASH_FLOORS.index(reserve)
    return [{'kind':'observation','observation':obs},
            {'kind':'commander_decision','record':{'world':world,'action':action,'executionSource':'policy'}}]


class TransactionTests(unittest.TestCase):
    def test_quantity_eight_cleared_next_step_is_not_eight_units(self):
        stream=records(observation(0),choice=4,amount=8)
        stream+=records(observation(75,items=[{'name':'MTNK','quantity':1}],status=1),choice=1)
        stream+=records(observation(150,own=[{'ref':n,'name':'MTNK'} for n in ['t1','t2','t3']]))
        result=analyze_records(stream,'/game',200);event=result['events'][0]
        self.assertEqual(event['eventId'],{'directory':'/game','tick':0,'queue':3})
        self.assertEqual((event['amount'],event['target'],event['durationTicks'],event['endReason']),(8,10,75,'clear'))
        self.assertEqual(event['peakCommitted'],3);self.assertFalse(event['peakCommittedExceedsStartPlusOne'])
        self.assertEqual(event['firstOwnedAppearances'],0);self.assertEqual(event['activeDecisionCount'],1)
        self.assertEqual(result['rawEncodedStockChecks'],9)

    def test_keep_preserves_order_and_boundary_stock_precedes_next_set(self):
        stream=records(observation(0),choice=4,amount=4)
        stream+=records(observation(75,items=[{'name':'MTNK','quantity':1}],status=1))
        stream+=records(observation(150,own=[{'ref':n,'name':'MTNK'} for n in ['t1','t2','t3']],items=[{'name':'MTNK','quantity':1}],status=1))
        stream+=records(observation(225,own=[{'ref':n,'name':'MTNK'} for n in ['t1','t2','t3','t4']]),choice=5)
        events=analyze_records(stream,'/game',250)['events'];first,second=events
        self.assertEqual((first['durationTicks'],first['endReason'],first['activeDecisionCount']),(225,'set',3))
        self.assertTrue(first['peakCommittedExceedsStartPlusOne']);self.assertEqual(first['firstOwnedAppearances'],2)
        self.assertEqual(second['firstOwnedAppearances'],0);self.assertTrue(second['rightCensored'])

    def test_reserve_choice_binding_and_pause_are_distinct(self):
        stream=records(observation(0,status=1,credits=1000),choice=4,reserve=500)
        stream+=records(observation(75,status=1,credits=400))
        stream+=records(observation(150,status=2,credits=300))
        stream+=records(observation(225,status=2,credits=200),choice=1)
        event=analyze_records(stream,'/game',250)['events'][0]
        self.assertEqual(event['belowReserveDecisionCount'],2)
        self.assertEqual(event['belowReserveWhileProducingCount'],1)
        self.assertEqual(event['belowReserveWithPausedQueueCount'],1)
        self.assertTrue(event['pausedQueueObservedAfterSet']);self.assertEqual(event['pauseTransitionsNearCashFloor'],1)
        passive=records(observation(0,credits=3000),choice=4,reserve=2000)+records(observation(75,credits=3000),choice=1)
        self.assertEqual(analyze_records(passive,'/other',100)['events'][0]['belowReserveDecisionCount'],0)

    def test_cross_queue_refinery_grants_are_excluded_from_extra_stock_metric(self):
        a=observation(0,own=[]);b=observation(75,own=[])
        b['queues'][0].update(status=1,size=2,items=[{'name':'GAREFN','quantity':2}])
        event=analyze_records(records(a,choice=5,amount=8)+records(b,choice=1),'/game',100)['events'][0]
        self.assertEqual(event['peakCommitted'],2);self.assertEqual(event['crossQueueGrantSources'],['GAREFN'])
        self.assertIsNone(event['peakCommittedExceedsStartPlusOne'])

    def test_temporarily_absent_refs_are_not_counted_as_births_again(self):
        stream=records(observation(0),choice=4,amount=8)
        stream+=records(observation(75,own=[{'ref':'t1','name':'MTNK'}]))
        stream+=records(observation(150),choice=1)
        event=analyze_records(stream,'/game',180)['events'][0]
        self.assertTrue(event['stockDropObserved']);self.assertEqual(event['firstOwnedAppearances'],0)
        self.assertEqual(summarize([event])['stockDropObserved'],1)

    def test_pause_ends_run_segment_and_keep_does_not_resume_it(self):
        stream=records(observation(0),choice=4,amount=-1)
        stream+=records(observation(75),choice=2)
        stream+=records(observation(150,status=2))
        stream+=records(observation(225,status=2),choice=4,amount=2)
        stream+=records(observation(300,status=1),choice=3)
        first,second=analyze_records(stream,'/game',330)['events']
        self.assertEqual((first['target'],first['endReason'],first['durationTicks']),(-1,'pause',75))
        self.assertEqual((second['tick'],second['endReason'],second['durationTicks']),(225,'cancel',75))
        self.assertEqual(first['activeDecisionCount'],1)

    def test_committed_accounting_matches_actual_node_helper(self):
        obs=observation(0,own=[{'ref':'m1','name':'CMIN'},{'ref':'r1','name':'GAREFN','buildStatus':0},
                              {'ref':'r2','name':'GAREFN','buildStatus':1}],
                        items=[{'name':'CMIN','quantity':2},{'name':'MTNK','quantity':1}])
        obs['queues'][0]['items']=[{'name':'GAREFN','quantity':3}]
        script="""import fs from 'node:fs';import {committedStock} from './src/control/program-production.ts';import {AMOUNTS,CASH_FLOORS} from './src/commander/world.ts';const o=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({stocks:['CMIN','GAREFN','MTNK'].map(n=>committedStock(o,n)),amounts:AMOUNTS,reserves:CASH_FLOORS}));"""
        result=subprocess.run(['node','--import','tsx','--input-type=module','-e',script],input=json.dumps(obs),capture_output=True,text=True,check=True,cwd=Path(__file__).resolve().parents[1])
        actual=json.loads(result.stdout)
        self.assertEqual(actual['stocks'],[committed_stock(obs,n) for n in ['CMIN','GAREFN','MTNK']])
        self.assertEqual(actual['stocks'],[7,5,1]);self.assertEqual(actual['amounts'],AMOUNTS);self.assertEqual(actual['reserves'],CASH_FLOORS)


if __name__=='__main__':unittest.main()
