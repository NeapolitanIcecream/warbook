"""Finite experiment sequence; safe to run under tmux without a client connection."""
import argparse,hashlib,json,os,random,subprocess,sys,time
from pathlib import Path
from launch_batch import atomic

def main():
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--workers',type=int,default=8);p.add_argument('--updates',type=int,default=4);p.add_argument('--seed',type=int,default=1);a=p.parse_args()
    root=Path(a.out).resolve();root.mkdir(parents=True,exist_ok=True)
    spec={'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'workers':a.workers,'updates':a.updates,'seed':a.seed}
    if (root/'sprint.json').exists() and json.loads((root/'sprint.json').read_text())!=spec:raise ValueError('Sprint identity changed')
    atomic(root/'sprint.json',spec)
    def status(phase,**kw):atomic(root/'status.json',{'phase':phase,'updatedAt':time.time(),**kw});print(json.dumps({'phase':phase,**kw}),flush=True)
    def command(name,cmd):
        marker=root/(name+'.done.json')
        if marker.exists():return
        status(name)
        with (root/(name+'.log')).open('w') as f:subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,check=True)
        atomic(marker,{'completedAt':time.time()})
    maps=['mp29u2.map','mp06t2.map','mp08t2.map','mp03t4.map']
    opponents={'main-016':{'ref':'v0.1.16','mode':'bastion'},'pressure-016':{'ref':'v0.1.16','mode':'pressure'},'old-defense':{'ref':'b3a1f7c','mode':'bastion'},'supalosa':{'native':'supalosa'}}
    def batch(name,subjects,rounds,ops=None,mp=None,trace='launch'):
        plan={'subjects':subjects,'opponents':ops or opponents,'maps':mp or maps,'rounds':rounds,'workers':a.workers,'trace':trace,'orderSeed':a.seed+len(name),'policySeed':a.seed,'seconds':600}
        path=root/(name+'.plan.json');atomic(path,plan)
        command(name,[sys.executable,'analysis/launch_batch.py',str(path),'--out',str(root/name),'--workers',str(a.workers),'--resume'])
        return json.loads((root/name/'summary.json').read_text())
    try:
        pilot=batch('interface-pilot',{'teacher':{'policy':'teacher'},'baseline':{'ref':'v0.1.16'}},1,{k:v for k,v in opponents.items() if k in ['pressure-016','supalosa']},trace='full')
        if pilot['counts']['teacher']['W']+3<pilot['counts']['baseline']['W']:
            status('needs-review',reason='large teacher interface regression',counts=pilot['counts']);return
        batch('teacher',{'teacher':{'policy':'teacher'}},8)
        models=root/'models';models.mkdir(exist_ok=True);bc=models/'bc.json'
        command('bc',[sys.executable,'analysis/launch_train.py','bc','--episodes',str(root/'teacher/teacher-episodes.json'),'--out',str(bc),'--seed',str(a.seed),'--threads','4'])
        command('bc-parity',[os.environ.get('WARBOOK_NODE','node'),'--import','tsx','scripts/check-launch-model.ts',str(bc),str(bc.with_suffix('.golden.json'))])
        batch('bc-evaluation',{'bc':{'policy':'model','model':str(bc),'deterministic':True},'teacher':{'policy':'teacher'}},1)
        previous=bc
        for update in range(a.updates):
            name=f'rollout-{update:02d}'
            batch(name,{'policy':{'policy':'model','model':str(previous)}},2)
            model=models/f'ppo-{update:02d}.json'
            command(f'update-{update:02d}',[sys.executable,'analysis/launch_train.py','ppo','--episodes',str(root/name/'policy-episodes.json'),'--input',str(previous),'--out',str(model),'--seed',str(a.seed+update+1),'--threads','4'])
            command(f'parity-{update:02d}',[os.environ.get('WARBOOK_NODE','node'),'--import','tsx','scripts/check-launch-model.ts',str(model),str(model.with_suffix('.golden.json'))])
            previous=model
        batch('learned-evaluation',{'ppo':{'policy':'model','model':str(previous),'deterministic':True},'bc':{'policy':'model','model':str(bc),'deterministic':True},'teacher':{'policy':'teacher'},'baseline':{'ref':'v0.1.16'}},2)
        rng=random.Random(a.seed);subjects={}
        for i in range(12):
            linear=models/f'linear-{i:02d}.json'
            params={'bias':rng.uniform(-8,-1),'power':rng.uniform(.5,1.5),'threat':rng.uniform(.7,2.),'distance':rng.uniform(.01,.06),'objective':rng.uniform(0,3),'retained':rng.uniform(-.2,.2),'spread':rng.uniform(0,.8),'fog':rng.uniform(0,3)}
            atomic(linear,{'format':'warbook-launch-linear-v1','schema':'launch-v1','params':params})
            subjects[f'linear-{i:02d}']={'policy':'linear','model':str(linear),'deterministic':True}
        search=batch('linear-search',subjects,1)
        best=max(subjects,key=lambda s:search['counts'][s]['W'])
        batch('final-comparison',{'linear':subjects[best],'ppo':{'policy':'model','model':str(previous),'deterministic':True},'bc':{'policy':'model','model':str(bc),'deterministic':True}},2)
        status('complete',lastModel=str(previous),bestLinear=subjects[best]['model'])
    except Exception as exc:
        status('failed',error=f'{type(exc).__name__}: {exc}');raise
if __name__=='__main__':main()
