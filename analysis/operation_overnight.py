"""Executable-teacher initialization, then bounded alternating operation learning.

All artifacts and continuations live on the experiment host. Durable state owns
selection/cursor; restarting after the deadline cannot revert to initial models.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import threading
from pathlib import Path
from launch_batch import atomic

ROUTES = {'main':'bastion','pressure':'pressure'}
SEEDS = [47,83]
class BoundaryReached(Exception): pass

def read(p): return json.loads(Path(p).read_text())
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def choose(counts,names): return max(names,key=lambda name:counts[name]['W'])
def cutoff(value):
    stamp=dt.datetime.fromisoformat(value)
    if stamp.tzinfo is None: raise ValueError('Deadline needs an explicit timezone')
    return stamp.timestamp()
def neural(path,route,scope,deterministic=True):
    return dict(policy='model',model=str(path),mode=ROUTES[route],scope=scope,deterministic=deterministic)

def checkpoint_artifact(state,field,key,path):
    # Called only after training and cross-runtime probability validation succeed.
    state.setdefault(field,{})[key]=dict(model=str(path),sha256=digest(path))

def final_subjects(state,route):
    subjects={};seen={}
    def add(label,path,scope,expected=None):
        sha=digest(path)
        if expected and sha!=expected:raise ValueError('Validated pending checkpoint changed')
        if sha in seen:return
        seen[sha]=label;subjects[label]=neural(path,route,scope)
    for collection,label in [('initial','initial'),('reference','bc'),('current','latest')]:
        for key,path in state[collection].items():
            if key.startswith(route+'-'):add(key+'-'+label,path,'operation' if collection=='reference' else key.split('-')[1])
    for key,record in state.get('pendingUpdated',{}).items():
        if key.startswith(route+'-'):add(key+'-pending',record['model'],key.split('-')[1],record['sha256'])
    for scope in ['launch','operation']:add(f'{route}-{scope}-retained',state['retained'][f'{route}-{scope}'],scope)
    subjects['rule-016']=dict(ref='v0.1.16',mode=ROUTES[route])
    return subjects,seen

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--previous',required=True);ap.add_argument('--out',required=True)
    ap.add_argument('--train-until',required=True);ap.add_argument('--finish-by',required=True)
    ap.add_argument('--game-budget',type=int,default=80000);ap.add_argument('--cycles',type=int,default=40)
    ap.add_argument('--workers',type=int,default=128);ap.add_argument('--calibrate',action='store_true')
    ap.add_argument('--smoke',action='store_true');ap.add_argument('--initialize-only',action='store_true');a=ap.parse_args()
    train_until,finish_by=cutoff(a.train_until),cutoff(a.finish_by)
    if train_until>=finish_by or not 1<=a.workers<=192 or not 1<=a.cycles<=40 or not 100<=a.game_budget<=100000:
        raise ValueError('Invalid bounded experiment configuration')
    previous=Path(a.previous).resolve();root=Path(a.out).resolve();root.mkdir(parents=True,exist_ok=True)
    if read(previous/'status.json')['phase']!='complete':raise ValueError('Previous comparison is incomplete')
    models=root/'models';models.mkdir(exist_ok=True)
    source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    node=os.environ.get('WARBOOK_NODE','node')
    identity=dict(source=source,previous=str(previous),previousAuditSha=digest(previous/'audit.json'),
                  trainUntil=a.train_until,finishBy=a.finish_by,gameBudget=a.game_budget,cycles=a.cycles,
                  workers=a.workers,calibrate=a.calibrate,smoke=a.smoke,
                  teacher='menu-v2',evaluation='seen maps; independent uncontrolled starts; W=1,L=0,U=0; E excluded')
    if (root/'experiment.json').exists() and read(root/'experiment.json')!=identity:raise ValueError('Resume identity changed')
    atomic(root/'experiment.json',identity)
    state=read(root/'state.json') if (root/'state.json').exists() else dict(phase='initializing',cycle=0,routeIndex=0,workers=min(a.workers,4) if a.smoke else a.workers)
    if state['phase']=='complete':return
    maps=['mp06t2.map'] if a.smoke else ['mp29u2.map','mp06t2.map','mp08t2.map','mp03t4.map']
    seeds=[47] if a.smoke else SEEDS
    fixed={'supalosa':{'native':'supalosa'}} if a.smoke else {'main-016':{'ref':'v0.1.16'},'pressure-016':{'ref':'v0.1.16','mode':'pressure'},'old-defense':{'ref':'b3a1f7c'},'supalosa':{'native':'supalosa'}}
    final_reserve=80 if a.smoke else 4096
    status_lock=threading.Lock()
    def save(): atomic(root/'state.json',state)
    def completed():
        return sum(read(p)['completed'] for p in [*root.glob('*/summary.json'),*root.glob('calibration/*/summary.json')] if isinstance(read(p),dict) and 'completed' in read(p))
    def status(phase,**kw):
        record=dict(phase=phase,updatedAt=time.time(),workers=state['workers'],completedGames=completed(),cycle=state.get('cycle',0),**kw)
        with status_lock:
            atomic(root/'status.json',record);print(json.dumps(record),flush=True)
    def boundary(games=0,seconds=0):
        if (root/'STOP_TRAINING').exists():raise BoundaryReached('operator requested final comparison')
        if completed()+games+final_reserve>a.game_budget:raise BoundaryReached('game budget reserved for final comparison')
        # Conservative measured-order forecast; the hard timeout remains authoritative.
        estimate=seconds or (60+games*3600/3000 if games else 0)
        if time.time()+estimate>=train_until:raise BoundaryReached('training cutoff / next-stage forecast')
    def command(name,cmd,final=False,estimate=0):
        marker=root/(name+'.done.json')
        if marker.exists():return
        if not final:boundary(seconds=estimate)
        stop=finish_by if final else train_until
        remaining=stop-time.time()
        if remaining<=0:raise BoundaryReached('hard execution deadline')
        status(name)
        with (root/(name+'.log')).open('w') as log:
            child=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try: code=child.wait(timeout=remaining)
            except (subprocess.TimeoutExpired,KeyboardInterrupt):
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
                atomic(root/(name+'.interrupted.json'),dict(at=time.time(),reason='deadline or interruption'))
                raise BoundaryReached('hard execution deadline or interruption')
        if code:raise RuntimeError(f'{name} exited {code}; inspect its preserved log')
        atomic(marker,dict(completedAt=time.time()))
    def batch(name,subjects,rounds,pool=None,seed=5101,final=False):
        pool=pool or fixed
        plan=dict(subjects=subjects,opponents=pool,maps=maps,rounds=rounds,workers=state['workers'],trace='launch',orderSeed=seed,policySeed=seed,seconds=900)
        path=root/(name+'.plan.json')
        if path.exists() and read(path)!=plan:raise ValueError(f'{name}: plan changed')
        atomic(path,plan)
        if not (root/(name+'.done.json')).exists():
            already=read(root/name/'summary.json')['completed'] if (root/name/'summary.json').exists() else 0
            remaining=len(subjects)*len(pool)*len(maps)*rounds-already
            if not final:boundary(remaining)
            elif completed()+remaining>a.game_budget:raise ValueError('Final comparison exceeds game budget')
        command(name,[sys.executable,'analysis/launch_batch.py',str(path),'--out',str(root/name),'--resume'],final)
        summary=read(root/name/'summary.json')
        if not summary['complete'] or any(c.get('E',0) for c in summary['counts'].values()):raise RuntimeError(f'{name}: incomplete or erroneous evidence')
        return summary
    def train(name,method,episodes,seed,previous_model=None):
        path=models/(name+'.json')
        cmd=[sys.executable,'analysis/launch_train.py',method,'--episodes',str(episodes),'--out',str(path),'--seed',str(seed),'--threads','4']
        if previous_model:cmd+=['--input',str(previous_model)]
        if a.smoke:cmd+=['--epochs','1']
        command(name,cmd,estimate=600 if not a.smoke else 30)
        command(name+'-parity',[node,'--import','tsx','scripts/check-launch-model.ts',str(path),str(path.with_suffix('.golden.json'))])
        return str(path)
    def parallel_train(tasks, field):
        results={};errors=[]
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8,len(tasks))) as pool:
            futures={pool.submit(train,**spec):key for key,spec in tasks.items()}
            for future in concurrent.futures.as_completed(futures):
                key=futures[future]
                try:
                    path=future.result();results[key]=path
                    checkpoint_artifact(state,field,key,path);save()
                except Exception as error:errors.append(error)
        if errors:raise next((e for e in errors if not isinstance(e,BoundaryReached)),errors[0])
        return results
    def freeze(path,route):
        key=f'freeze-{route}-{digest(path)[:16]}';marker=root/(key+'.release.json')
        if not marker.exists():
            command(key,[node,'--import','tsx','scripts/build-bot.ts','--ref',source,'--mode',ROUTES[route],'--launch-model',str(path)],final=True)
            lines=(root/(key+'.log')).read_text().splitlines();atomic(marker,json.loads(lines[-1]))
        return {'release':read(marker)['path']}
    def opponents(route):
        other='pressure' if route=='main' else 'main'
        return {**fixed,**{f'adaptive-{other}-{scope}':freeze(state['retained'][f'{other}-{scope}'],other) for scope in ['launch','operation']}}
    try:
        if state['phase']=='initializing':
            teacher_specs={f'{route}-{kind}':dict(policy='teacher-menu' if kind=='menu' else 'teacher',scope='operation',mode=mode)
                           for route,mode in ROUTES.items() for kind in ['menu','legacy']}
            batch('teacher',teacher_specs,2 if a.smoke else 8)
            command('teacher-lifecycle',[sys.executable,'analysis/operation_lifecycle.py',str(root/'teacher'),'--require-menu'])
            tasks={f'{route}-{kind}-{seed}':dict(name=f'{route}-{kind}-{seed}-bc',method='bc',episodes=root/'teacher'/f'{route}-{kind}-episodes.json',seed=seed)
                   for route in ROUTES for kind in ['menu','legacy'] for seed in seeds}
            bc=parallel_train(tasks,'bcArtifacts')
            initial={};reference={};retained={};initial_counts={}
            for route in ROUTES:
                subjects={f'{kind}-{seed}':neural(bc[f'{route}-{kind}-{seed}'],route,'operation') for kind in ['menu','legacy'] for seed in seeds}
                for seed in seeds:
                    key=f'{route}-launch-{seed}'
                    step=0 if route=='main' and seed==47 else 1
                    path=previous/'models'/f'{key}-ppo-{step}.json'
                    audit=read(previous/'audit.json')
                    expected=next(m['sha256'] for m in audit['models'] if m['name']==path.stem)
                    if digest(path)!=expected:raise ValueError('Narrow starting checkpoint differs from audit')
                    prior=read(previous/'status.json')['retained'][f'{route}-launch']
                    incumbent=(route=='main' and seed==47) or (route=='pressure' and seed==83)
                    if incumbent and Path(prior).resolve()!=path.resolve():raise ValueError('Prior route incumbent changed')
                    state.setdefault('narrowStarts',{})[key]=dict(model=str(path),sha256=expected,role='prior route incumbent' if incumbent else 'second seed latest endpoint')
                    save()
                    initial[key]=str(path)
                    initial[f'{route}-operation-{seed}']=bc[f'{route}-menu-{seed}']
                    reference[f'{route}-legacy-{seed}']=bc[f'{route}-legacy-{seed}']
                    subjects[f'launch-{seed}']=neural(path,route,'launch')
                subjects['rule-016']=dict(ref='v0.1.16',mode=ROUTES[route])
                check=batch(f'initial-{route}',subjects,1 if a.smoke else 4)
                initial_counts[route]=check['counts']
                for scope,label in [('operation','menu'),('launch','launch')]:
                    best=choose(check['counts'],[f'{label}-{s}' for s in seeds])
                    retained[f'{route}-{scope}']=subjects[best]['model']
            state.update(phase='learning',initial=initial,current=dict(initial),reference=reference,retained=retained,initialCounts=initial_counts)
            save()
        if a.initialize_only:
            status('initialized',initialCounts=state['initialCounts'],retained=state['retained']);return
        if a.calibrate and not a.smoke and not state.get('calibrated') and state['phase']=='learning':
            boundary(1536)
            command('calibration',[sys.executable,'analysis/launch_scale.py','--model',state['retained']['main-operation'],'--out',str(root/'calibration'),'--workers','128,160,192','--rounds','32'])
            measures=[x for x in read(root/'calibration/summary.json') if x['measurementComplete'] and x['sampledPeakTreeRssKiB']<180*2**20]
            if not measures:raise RuntimeError('No measured concurrency fits the 180 GiB allowance')
            state['workers']=max(measures,key=lambda x:x['engineTicksPerSecond'])['workers'];state['calibrated']=True
            atomic(root/'workers.json',dict(workers=state['workers'],measurements=measures));save()
        while state['phase']=='learning' and state['cycle']<(1 if a.smoke else a.cycles):
            boundary()
            route=list(ROUTES)[state['routeIndex']];cycle=state['cycle'];name=f'cycle-{cycle:02d}-{route}'
            keys=[key for key in state['current'] if key.startswith(route+'-')]
            pool=opponents(route)
            subjects={key:neural(state['current'][key],route,key.split('-')[1],False) for key in keys}
            batch(name+'-rollout',subjects,1 if a.smoke else 8,pool,seed=6000+cycle*10+state['routeIndex'])
            tasks={key:dict(name=name+'-'+key+'-ppo',method='ppo',episodes=root/(name+'-rollout')/(key+'-episodes.json'),seed=7000+cycle*100+int(key.split('-')[-1]),previous_model=state['current'][key]) for key in keys}
            updated=parallel_train(tasks,'pendingUpdated')
            candidates={f'{scope}-incumbent':neural(state['retained'][f'{route}-{scope}'],route,scope) for scope in ['launch','operation']}
            candidates.update({key:neural(path,route,key.split('-')[1]) for key,path in updated.items()})
            check=batch(name+'-development',candidates,1 if a.smoke else 2,pool,seed=8000+cycle*10+state['routeIndex'])
            for scope in ['launch','operation']:
                names=[f'{scope}-incumbent',*[key for key in keys if key.split('-')[1]==scope]]
                best=choose(check['counts'],names);state['retained'][f'{route}-{scope}']=candidates[best]['model']
            state['current'].update(updated)
            for key in updated:state.get('pendingUpdated',{}).pop(key,None)
            state['routeIndex']+=1
            if state['routeIndex']==len(ROUTES):state['routeIndex']=0;state['cycle']+=1
            save()
            atomic(root/(name+'-selection.json'),dict(retained=state['retained'],counts=check['counts'],note='Development selection; ties retain incumbent. No player promotion.'))
    except BoundaryReached as error:
        state['stopReason']=str(error);save()
    except Exception as error:
        state['stopReason']=f'{type(error).__name__}: {error}';state['failure']=True;save()
    if not state.get('initial'):
        status('initialization-incomplete',reason=state.get('stopReason'));raise SystemExit(1)
    if state['phase']!='final':
        state['phase']='final';state['finalPools']={route:opponents(route) for route in ROUTES};save()
    try:
        for route in ROUTES:
            subjects,seen=final_subjects(state,route)
            check=batch('final-'+route,subjects,1 if a.smoke else 4,state['finalPools'][route],seed=9101,final=True)
            state.setdefault('final',{})[route]=dict(counts=check['counts'],modelLabels=seen);save()
        state['phase']='complete';save();status('complete',final=state['final'],retained=state['retained'],stopReason=state.get('stopReason','cycle budget completed'),hadFailure=state.get('failure',False))
    except Exception as error:
        state['phase']='final-incomplete';state['finalError']=str(error);save();status('final-incomplete',reason=str(error));raise

if __name__=='__main__':main()
