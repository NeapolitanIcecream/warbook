"""Bounded CPU experiments: each replica learns against the same frozen native/BC pool."""
import argparse,concurrent.futures,json,os,subprocess,sys,time,hashlib
from pathlib import Path
from tactical_batch import atomic

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--initial47',required=True);ap.add_argument('--initial83',required=True);ap.add_argument('--out',required=True);ap.add_argument('--cycles',type=int,default=8);ap.add_argument('--workers',type=int,default=32);args=ap.parse_args()
    root=Path(args.out).resolve();root.mkdir(parents=True,exist_ok=True)
    if (root/'status.json').exists():raise ValueError('Use a fresh experiment directory')
    initial={47:str(Path(args.initial47).resolve()),83:str(Path(args.initial83).resolve())};current=dict(initial)
    manifest={'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'initial':initial,'initialSha256':{s:hashlib.sha256(Path(p).read_bytes()).hexdigest() for s,p in initial.items()},'cycles':args.cycles,'workersPerReplica':args.workers,'objective':'Local armor task returns; fixed opponents; two independent initializations'}
    atomic(root/'experiment.json',manifest);history=[];begin=time.monotonic()
    def run(cmd,log,timeout=1800):
        with log.open('w') as f:subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=timeout)
    def cycle(seed,index):
        base=root/f'cycle-{index:02d}'/str(seed);base.mkdir(parents=True)
        plan={'maps':['mp06t2.map','mp08t2.map','mp03t4.map'],'tanks':[2,3,4,5],'rounds':8,'workers':args.workers,'seed':seed*1000+index,
          'subjects':{'learner':{'model':current[seed]}},'opponents':{'focus':{'native':'focus'},'attack-move':{'native':'attack-move'},'frozen-peer':{'model':initial[83 if seed==47 else 47]}}}
        atomic(base/'plan.json',plan);run([sys.executable,'analysis/tactical_batch.py',str(base/'plan.json'),'--out',str(base/'rollout')],base/'rollout.log')
        model=base/'model.json';run([sys.executable,'analysis/tactical_train.py','ppo','--episodes',str(base/'rollout/learner-episodes.json'),'--input',current[seed],'--out',str(model),'--seed',str(seed*100+index),'--epochs','3','--threads','1'],base/'train.log')
        run([os.environ.get('WARBOOK_NODE','node'),'--import','tsx','scripts/check-tactical-model.ts',str(model),str(model.with_suffix('.golden.json'))],base/'parity.log')
        return {'seed':seed,'index':index,'model':str(model),'sha256':hashlib.sha256(model.read_bytes()).hexdigest(),'sampling':json.loads((base/'rollout/summary.json').read_text())['counts'],'training':json.loads(model.with_suffix('.training.json').read_text())['history']}
    for index in range(args.cycles):
        atomic(root/'status.json',{'phase':'rollout-update','cycle':index,'current':current,'history':history,'seconds':time.monotonic()-begin})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:results=list(ex.map(lambda seed:cycle(seed,index),[47,83]))
        for result in results:current[result['seed']]=result['model']
        history+=results;atomic(root/'status.json',{'phase':'cycle-complete','cycle':index,'current':current,'history':history,'seconds':time.monotonic()-begin})
    plan={'maps':['mp06t2.map','mp08t2.map','mp03t4.map'],'tanks':[2,3,4,5],'rounds':4,'workers':args.workers*2,'seed':47083,
      'subjects':{'teacher':{'teacher':True}},'opponents':{'focus':{'native':'focus'},'attack-move':{'native':'attack-move'},'frozen47':{'model':initial[47]},'frozen83':{'model':initial[83]}}}
    for seed in [47,83]:
        plan['subjects'][f'initial{seed}']={'model':initial[seed],'deterministic':True}
        plan['subjects'][f'final{seed}']={'model':current[seed],'deterministic':True}
    atomic(root/'evaluation-plan.json',plan);run([sys.executable,'analysis/tactical_batch.py',str(root/'evaluation-plan.json'),'--out',str(root/'evaluation')],root/'evaluation.log')
    atomic(root/'status.json',{'phase':'complete','current':current,'history':history,'seconds':time.monotonic()-begin,'evaluation':json.loads((root/'evaluation/summary.json').read_text())['counts']})

if __name__=='__main__':main()
