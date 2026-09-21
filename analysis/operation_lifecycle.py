"""Check the observed teacher gap at withdrawal arrival, not overall KEEP accuracy.

Counts describe recorded trajectories. No old teacher record is a counterfactual
continuation of the new teacher; waiting alone is not declared an error.
"""
import argparse
import collections
import json
from pathlib import Path
from experiment_storage import open_text
from launch_batch import atomic


def episode(directory, require_menu=False):
    manifest=json.loads((directory/'manifest.json').read_text())
    subject=next(p['name'] for p in manifest['participants'] if p['role']=='subject')
    counts=collections.Counter(); reasons=collections.Counter(); previous=None; arrived=None; kept=0
    max_wait=0; recovered_id=None
    with open_text(directory/'decisions.ndjson') as stream:
        for line in stream:
            event=json.loads(line)
            if event.get('kind')!='operation_decision' or event.get('actor')!=subject:continue
            r=event['record'];op=r['operation'];action=r['action'];counts['decisions']+=1
            reasons[r['teacherCoverage']]+=1
            if action<0:counts['unrepresentable']+=1
            if r['policy']=='teacher-menu':
                counts['menuDecisions']+=1
                if action<0 or action>=len(r['actions']) or action!=r['teacherAction'] or r['executionSource']!='teacher':
                    raise ValueError(f'{directory}: menu teacher did not execute its own legal label')
            elif require_menu and manifest['launchExperiment']['policy']=='teacher-menu':
                raise ValueError('Menu teacher manifest/record mismatch')
            if op.get('kind')=='withdraw' and (previous is None or previous.get('kind')!='withdraw'):
                counts['withdrawalEntries']+=1
            # operation-v2 = 4*(28 global + 24 operation) + 4 masks.
            # Fact 18 is surviving original cohort arrival fraction at the current goal.
            at_anchor=op.get('kind')=='withdraw' and op['members']>0 and r['global'][202]>=.999
            if at_anchor and arrived is None:
                arrived=(op['id'],r['tick']);counts['arrivedWithdrawals']+=1;kept=0
                recovered_id=op['id']
            selected=r['actions'][action] if action>=0 else {}
            next_kind=selected.get('order',{}).get('kind')
            if recovered_id is not None:
                if op['members']==0 or op['id']!=recovered_id:
                    counts['arrivedForceLostBeforeRelaunch']+=1;recovered_id=None
                elif next_kind=='advance' or op.get('kind')=='advance':
                    counts['arrivedForceRelaunched']+=1;recovered_id=None
            if arrived:
                if op['members']==0:
                    counts['arrivalThenRelease']+=1;arrived=None
                elif op.get('kind')!='withdraw' or next_kind and next_kind!='withdraw':
                    counts['arrivalThen_'+str(next_kind or op.get('kind'))]+=1;arrived=None
                elif action<0:counts['unrepresentableAtArrival']+=1
                elif action==0:
                    kept+=1;max_wait=max(max_wait,kept*75)
            previous=op
    if arrived:counts['arrivalStillWaitingAtStop']+=1
    if recovered_id is not None:counts['arrivedForceNotRelaunchedAtStop']+=1
    return dict(counts=dict(counts),reasons=dict(reasons),maxArrivedKeepTicks=max_wait)


def main():
    p=argparse.ArgumentParser();p.add_argument('batch',type=Path);p.add_argument('--require-menu',action='store_true');a=p.parse_args()
    summary=json.loads((a.batch/'summary.json').read_text())
    if not summary['complete']:raise ValueError('Need a complete batch')
    groups={}
    for row in summary['rows']:
        report=episode(Path(row['dir']),a.require_menu)
        group=groups.setdefault(row['subject'],dict(games=0,counts=collections.Counter(),reasons=collections.Counter(),maxArrivedKeepTicks=0))
        group['games']+=1;group['counts'].update(report['counts']);group['reasons'].update(report['reasons'])
        group['maxArrivedKeepTicks']=max(group['maxArrivedKeepTicks'],report['maxArrivedKeepTicks'])
    atomic(a.batch/'lifecycle.json',groups)
    print(json.dumps(groups))

if __name__=='__main__':main()
