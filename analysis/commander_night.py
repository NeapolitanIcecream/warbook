"""Detached full-strategy bootstrap and joint adaptation, with frozen v1/v2 controls."""
import argparse,concurrent.futures,datetime,hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
from launch_batch import atomic
from experiment_storage import require_batch_space

class TrainingBoundary(TimeoutError):pass

def verified_candidate_receipts(root):
    result={}
    for path in Path(root).rglob('candidate-verified.json'):
        row=json.loads(path.read_text())
        if row['name'] not in result or row['cycle']>result[row['name']]['cycle']:result[row['name']]=row
    for row in result.values():
        model=Path(row['model'])
        if not model.resolve().is_relative_to(Path(root).resolve()):raise ValueError('Candidate outside this experiment')
        if hashlib.sha256(model.read_bytes()).hexdigest()!=row['sha256']:raise ValueError('Candidate receipt hash changed')
    return result

def completed_games(root):
    return sum(json.loads(p.read_text())['completed'] for p in Path(root).rglob('batch-complete.json'))

def next_learning_state(stage,incumbent,candidate,old_wins,new_wins,threshold):
    ready=stage=='ppo' or max(old_wins,new_wins)>=threshold
    retained=candidate if new_wins>old_wins else incumbent
    current=(candidate if new_wins>=old_wins else incumbent) if ready else candidate
    return current,retained,'ppo' if ready else 'bc'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('plan');ap.add_argument('--out',required=True);args=ap.parse_args()
    plan=json.loads(Path(args.plan).read_text());root=Path(args.out).resolve();root.mkdir(parents=True,exist_ok=True)
    if (root/'state.json').exists():raise ValueError('Use a fresh night directory; never append interrupted runs')
    node=os.environ.get('WARBOOK_NODE','node');python=sys.executable
    cutoff=datetime.datetime.fromisoformat(plan['trainingCutoff']).timestamp();end=datetime.datetime.fromisoformat(plan['hardDeadline']).timestamp()
    phase_end=datetime.datetime.fromisoformat(plan.get('trainingPhaseDeadline',plan['trainingCutoff'])).timestamp()
    state={'phase':'initializing','profiles':{},'history':[],'games':0,'source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'startedAt':time.time()}
    atomic(root/'plan.json',plan)
    def save():atomic(root/'state.json',state)
    def command(cmd,log):
        training=state['phase']!='final-evaluation'
        remaining=(min(end,phase_end) if training else end)-time.time()
        if remaining<30:raise TrainingBoundary('Training phase deadline') if training else TimeoutError('Hard deadline reached')
        with Path(log).open('w') as f:
            p=subprocess.Popen(cmd,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
            try:code=p.wait(timeout=remaining)
            except BaseException as error:
                try:os.killpg(p.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:p.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
                if training and isinstance(error,subprocess.TimeoutExpired):raise TrainingBoundary('Training phase deadline') from error
                raise
        if code:raise RuntimeError(f'Command failed ({code}); see {log}')
    def parity(model,log):command([node,'--import','tsx','scripts/check-commander-model.ts',str(model),str(Path(model).with_suffix('.golden.json'))],log)
    def freeze(model,route,directory):
        log=directory/'freeze.log';command([node,'--import','tsx','scripts/build-bot.ts','--ref',state['source'],'--mode','bastion' if route=='main' else 'pressure','--launch-model',str(model)],log)
        return json.loads(log.read_text().splitlines()[-1])['path']
    def spec(profile,model,teacher=False):
        result={'commander':True,'policy':'model','mode':'bastion' if profile['route']=='main' else 'pressure','model':str(model),'policySeed':profile['seed']}
        if teacher:result.update(daggerBeta=.25,deterministic=True)
        return result
    def batch(directory,subjects,opponents,rounds,workers,seed):
        directory.mkdir(parents=True,exist_ok=True);p={'maps':plan['maps'],'rounds':rounds,'workers':workers,'trace':'launch','seconds':600,'storageMiBPerGame':192,'orderSeed':seed,'subjects':subjects,'opponents':opponents}
        atomic(directory/'plan.json',p);command([python,'analysis/launch_batch.py',str(directory/'plan.json'),'--out',str(directory/'games')],directory/'batch.log')
        s=json.loads((directory/'games/summary.json').read_text())
        if not s['complete'] or any(c['E'] for c in s['counts'].values()):raise RuntimeError('Incomplete/error batch cannot train or select')
        atomic(directory/'batch-complete.json',{'completed':s['completed'],'counts':s['counts'],'at':time.time()})
        return s
    def train(profile,episodes,source,target,method,updates):
        episode_file=target.with_suffix('.episodes.json');atomic(episode_file,episodes)
        cmd=[str(Path(python).with_name('torchrun')),'--standalone','--nproc-per-node',str(plan.get('ranks',8)),'analysis/commander_train.py',method,'--episodes',str(episode_file),'--out',str(target),'--seed',str(profile['seed']),'--epochs','24' if method=='bc' else '3','--batch',str(plan.get('localBatch',4)),'--sequence','16','--burn','8','--threads','1','--validation-fraction','0','--action-encoding',profile['encoding']]
        if method=='bc':cmd+=['--bc-loss','factor','--bc-event-weight','32','--max-updates',str(updates)]
        if source:cmd+=['--input',str(source)]
        elif method=='bc':cmd+=['--checkpoints','4','8','12']
        command(cmd,target.with_suffix('.log'));parity(target,target.with_suffix('.parity.log'));return str(target)
    def initialize(item):
        name=item['name'];directory=root/name;directory.mkdir();p={**item,'stage':'bc','recent':[]}
        if item.get('fresh'):
            model=train(p,plan['anchors'][item['route']],None,directory/'initial.json','bc',plan.get('freshUpdates',1600))
        else:
            model=directory/'initial.json';command([python,'analysis/commander_migrate.py','--input',item['input'],'--out',str(model),'--encoding',item['encoding']],directory/'migration.log');parity(model,directory/'initial.parity.log');model=str(model)
        p.update(initial=model,current=model,retained=model);return name,p
    try:
        save()
        rules={}
        # Shared frozen controls must be built once before concurrent matrices.
        for route,mode in [('main','bastion'),('pressure','pressure')]:
            log=root/(route+'-rule-freeze.log');command([node,'--import','tsx','scripts/build-bot.ts','--ref','v0.1.16','--mode',mode],log)
            rules[route]=json.loads(log.read_text().splitlines()[-1])['path']
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(plan['profiles'])) as ex:
            for name,p in ex.map(initialize,plan['profiles']):state['profiles'][name]=p;save()
        for cycle in range(plan.get('maxCycles',40)):
            if time.time()>=cutoff or state['games']>=plan.get('maxGames',20000):break
            # Bound combined concurrent journal space, not each child in isolation.
            simultaneous=len(state['profiles'])*len(plan['maps'])*4*max(plan.get('rounds',4),2)
            try:require_batch_space(root,simultaneous,'launch',192)
            except RuntimeError as error:state['stopReason']=str(error);save();break
            state.update(phase='sampling-update',cycle=cycle);save()
            profiles=state['profiles'];releases={}
            for name,p in profiles.items():
                d=root/f'cycle-{cycle:02d}'/name;d.mkdir(parents=True,exist_ok=True);releases[name]=freeze(p['current'],p['route'],d)
            def step(name):
                p=profiles[name];d=root/f'cycle-{cycle:02d}'/name
                peer=next(n for n,q in profiles.items() if q['arm']==p['arm'] and q['route']!=p['route'])
                opponents={'supalosa':{'native':'supalosa'},'opposite-rule':{'release':rules['pressure' if p['route']=='main' else 'main']},'current-peer':{'release':releases[peer]},'strong-history':{'release':plan['strongReference']}}
                learning=p['stage']=='ppo';sampling=batch(d/'sample',{'learner':spec(p,p['current'],not learning)},opponents,plan.get('rounds',4),plan.get('workersPerProfile',16),10000+cycle*37+p['seed'])
                new=json.loads((d/'sample/games/learner-episodes.json').read_text())
                recent=[*p['recent'],new][-2:]
                episodes=new if learning else [*plan['anchors'][p['route']],*[x for chunk in recent for x in chunk]]
                candidate=train(p,episodes,p['current'],d/'candidate.json','ppo' if learning else 'bc',plan.get('updates',400))
                atomic(d/'candidate-verified.json',{'name':name,'cycle':cycle,'model':candidate,'sha256':hashlib.sha256(Path(candidate).read_bytes()).hexdigest(),'encoding':p['encoding'],'verifiedAt':time.time(),'source':state['source']})
                check=batch(d/'check',{'incumbent':spec(p,p['retained']),'candidate':spec(p,candidate)},opponents,1,plan.get('workersPerProfile',16),20000+cycle*37+p['seed'])
                old=check['counts']['incumbent']['W'];won=check['counts']['candidate']['W']
                # Bootstrap can make useful partial progress before first wins; RL
                # keeps the directly compared incumbent when its update regresses.
                current,kept,stage=next_learning_state(p['stage'],p['retained'],candidate,old,won,plan.get('readyWins',4))
                updated={**p,'current':current,'retained':kept,'recent':recent,'stage':stage}
                row={'cycle':cycle,'name':name,'method':'ppo' if learning else 'dagger-bc','sampling':sampling['counts'],'check':check['counts'],'candidate':candidate,'retained':kept,'games':sampling['completed']+check['completed']}
                atomic(d/'profile-complete.json',{'profile':updated,'result':row})
                return name,updated,row
            boundary=False;failures=[]
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(profiles)) as ex:
                futures={ex.submit(step,name):name for name in profiles}
                for future in concurrent.futures.as_completed(futures):
                    try:
                        name,p,row=future.result();profiles[name]=p;state['history'].append(row)
                    except TrainingBoundary:boundary=True
                    except Exception as error:failures.append({'name':futures[future],'error':str(error)})
                    state['games']=completed_games(root);state['pending']=verified_candidate_receipts(root);save()
            if failures:state['failures']=failures;save();raise RuntimeError('A profile failed; verified candidates are preserved')
            state['phase']='cycle-complete';save()
            if boundary:state['stopReason']='Training phase deadline; finalize verified models';break
        state['phase']='final-evaluation';save()
        final_counts={}
        pending=verified_candidate_receipts(root)
        for name,p in state['profiles'].items():
            subjects={};seen=set()
            candidates={'initial':p['initial'],'retained':p['retained'],'latest-verified':pending.get(name,{}).get('model',p['current'])}
            for which,model in candidates.items():
                key=hashlib.sha256(Path(model).read_bytes()).hexdigest()
                if key in seen:continue
                seen.add(key);subjects[name+'-'+which]=spec(p,model)
            opponents={'supalosa':{'native':'supalosa'},'main-rule':{'release':rules['main']},'pressure-rule':{'release':rules['pressure']},'strong-history':{'release':plan['strongReference']}}
            final=batch(root/'final'/name,subjects,opponents,2,plan.get('finalWorkers',96),29024);state['games']=completed_games(root);final_counts.update(final['counts']);state['final']=final_counts;save()
        state.update(phase='complete',finishedAt=time.time());save()
    except BaseException as error:
        state.update(phase='stopped',error=str(error),finishedAt=time.time());save();raise

if __name__=='__main__':main()
