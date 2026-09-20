"""Finite expansion: measured sampling, independent repeats, then pressure adaptation.

All maps remain development maps. This never changes the maintained player entry.
With defaults: 3,520 new games, plus the preceding 720-game sprint.
"""
import argparse, hashlib, json, os, random, subprocess, sys, time
from pathlib import Path
from launch_batch import atomic

def main():
    p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    base=Path(a.base).resolve();root=Path(a.out).resolve();root.mkdir(parents=True,exist_ok=True)
    if json.loads((base/'status.json').read_text())['phase']!='complete':raise ValueError('Finish the initial sprint first')
    node=os.environ.get('WARBOOK_NODE','node');models=root/'models';models.mkdir(exist_ok=True)
    source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    identity={'git':source,'base':str(base),'baseSprintSha256':hashlib.sha256((base/'sprint.json').read_bytes()).hexdigest(),'plannedNewGames':3520}
    if (root/'expansion.json').exists() and json.loads((root/'expansion.json').read_text())!=identity:raise ValueError('Expansion identity changed')
    atomic(root/'expansion.json',identity)
    def status(phase,**kw):
        atomic(root/'status.json',{'phase':phase,'updatedAt':time.time(),**kw});print(json.dumps({'phase':phase,**kw}),flush=True)
    def command(name,cmd):
        marker=root/(name+'.done.json')
        if marker.exists():return
        status(name)
        with (root/(name+'.log')).open('w') as log:subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,check=True)
        atomic(marker,{'completedAt':time.time()})
    maps=['mp29u2.map','mp06t2.map','mp08t2.map','mp03t4.map']
    opponents={'main-016':{'ref':'v0.1.16'},'pressure-016':{'ref':'v0.1.16','mode':'pressure'},'old-defense':{'ref':'b3a1f7c'},'supalosa':{'native':'supalosa'}}
    initial=base/'models/ppo-03.json'
    command('scale',[sys.executable,'analysis/launch_scale.py','--model',str(initial),'--out',str(root/'scale')])
    measured=[m for m in json.loads((root/'scale/summary.json').read_text()) if m['measurementComplete']]
    if not measured:raise ValueError('No uninterrupted throughput measurement; review before scaling')
    workers=max(measured,key=lambda m:m['engineTicksPerSecond'])['workers']
    atomic(root/'workers.json',{'workers':workers,'measurements':measured})
    def batch(name,subjects,rounds,ops=None,seed=47):
        plan={'subjects':subjects,'opponents':ops or opponents,'maps':maps,'rounds':rounds,'workers':workers,'trace':'launch','orderSeed':seed,'policySeed':seed,'seconds':900}
        path=root/(name+'.plan.json');atomic(path,plan)
        command(name,[sys.executable,'analysis/launch_batch.py',str(path),'--out',str(root/name),'--resume'])
        return json.loads((root/name/'summary.json').read_text())
    def train(name,method,episodes,seed,previous=None):
        model=models/(name+'.json')
        cmd=[sys.executable,'analysis/launch_train.py',method,'--episodes',str(episodes),'--out',str(model),'--seed',str(seed),'--threads','4']
        if previous:cmd+=['--input',str(previous)]
        command(name,cmd)
        command(name+'-parity',[node,'--import','tsx','scripts/check-launch-model.ts',str(model),str(model.with_suffix('.golden.json'))])
        return model
    def neural(path,mode='bastion',deterministic=True):
        return {'policy':'model','model':str(path),'mode':mode,'deterministic':deterministic}
    wide=train('main-wide','ppo',root/'scale/policy-episodes.json',47,initial)
    candidates={'ppo-initial':neural(initial),'ppo-wide':neural(wide)}
    for seed in [47,83]:
        previous=train(f'bc-seed-{seed}','bc',base/'teacher/teacher-episodes.json',seed)
        for i in range(4):
            name=f'seed-{seed}-rollout-{i}'
            batch(name,{'policy':neural(previous,deterministic=False)},8,seed=seed*10+i)
            previous=train(f'ppo-seed-{seed}-{i}','ppo',root/name/'policy-episodes.json',seed*10+i,previous)
        candidates[f'ppo-seed-{seed}']=neural(previous)
    # Give the cheap comparator a substantial search budget too.
    rng=random.Random(47);linear={}
    for i in range(32):
        path=models/f'linear-extra-{i:02d}.json'
        params={'bias':rng.uniform(-8,-1),'power':rng.uniform(.5,1.5),'threat':rng.uniform(.7,2.),'distance':rng.uniform(.01,.06),'objective':rng.uniform(0,3),'retained':rng.uniform(-.2,.2),'spread':rng.uniform(0,.8),'fog':rng.uniform(0,3)}
        atomic(path,{'format':'warbook-launch-linear-v1','schema':'launch-v1','params':params})
        linear[f'extra-{i:02d}']={'policy':'linear','model':str(path),'deterministic':True}
    search=batch('linear-extra-search',linear,1)
    ranking={k:v['W'] for k,v in search['counts'].items()}
    old=json.loads((base/'linear-search/summary.json').read_text())
    for name,count in old['counts'].items():
        linear[name]={'policy':'linear','model':str(base/'models'/f'{name}.json'),'deterministic':True};ranking[name]=count['W']
    top={name:linear[name] for name in sorted(ranking,key=lambda k:(-ranking[k],k))[:4]}
    recheck=batch('linear-recheck',top,4)
    best=max(top,key=lambda name:recheck['counts'][name]['W']);candidates['linear']=top[best]
    comparison=batch('main-comparison',{**candidates,'bc':neural(base/'models/bc.json'),'teacher':{'policy':'teacher'},'baseline':{'ref':'v0.1.16'}},4)
    selected=max(candidates,key=lambda name:(comparison['counts'][name]['W'],name=='linear'))
    atomic(root/'main-selection.json',{'name':selected,'subject':candidates[selected],'counts':comparison['counts'],'note':'Development selection for an opponent; not a product promotion or unseen evaluation.'})
    # Alternate routes: train the distinct pressure policy against the frozen new main.
    marker=root/'frozen-main.json'
    if not marker.exists():
        status('freeze-main')
        output=subprocess.check_output([node,'--import','tsx','scripts/build-bot.ts','--ref','HEAD','--mode','bastion','--launch-model',candidates[selected]['model']],text=True)
        atomic(marker,json.loads(output.splitlines()[-1]))
    main_release=json.loads(marker.read_text())['path']
    pressure_pool={'new-main':{'release':main_release},'main-016':{'ref':'v0.1.16'}}
    batch('pressure-teacher',{'teacher':{'policy':'teacher','mode':'pressure'}},8,pressure_pool,seed=101)
    pressure_bc=train('pressure-bc','bc',root/'pressure-teacher/teacher-episodes.json',101)
    previous=pressure_bc
    for i in range(4):
        name=f'pressure-rollout-{i}'
        batch(name,{'policy':neural(previous,'pressure',False)},16,pressure_pool,seed=102+i)
        previous=train(f'pressure-ppo-{i}','ppo',root/name/'policy-episodes.json',102+i,previous)
    pressure=batch('pressure-comparison',{'ppo':neural(previous,'pressure'),'bc':neural(pressure_bc,'pressure'),'teacher':{'policy':'teacher','mode':'pressure'},'baseline':{'ref':'v0.1.16','mode':'pressure'}},4,pressure_pool,seed=111)
    status('complete',workers=workers,mainSelection=selected,mainCounts=comparison['counts'],pressureCounts=pressure['counts'],pressureModel=str(previous))

if __name__=='__main__':
    try:main()
    except Exception as exc:
        if '--out' in sys.argv:
            root=Path(sys.argv[sys.argv.index('--out')+1]);root.mkdir(parents=True,exist_ok=True)
            atomic(root/'status.json',{'phase':'failed','error':f'{type(exc).__name__}: {exc}','updatedAt':time.time()})
        raise
