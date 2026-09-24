"""Detached full-strategy bootstrap and joint adaptation, with frozen v1/v2 controls."""
import argparse,concurrent.futures,datetime,hashlib,json,os,shutil,signal,subprocess,sys,time
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
        if row.get('optimizerSha256') and hashlib.sha256(model.with_suffix('.optimizer.pt').read_bytes()).hexdigest()!=row['optimizerSha256']:raise ValueError('Candidate optimizer receipt hash changed')
    return result

def completed_games(root):
    # Kept as the existing entry point; the budget now includes failed/interrupted starts.
    receipts=list(Path(root).rglob('batch-attempted.json'));covered={p.parent for p in receipts}
    return sum(json.loads(p.read_text())['started'] for p in receipts)+sum(json.loads(p.read_text())['completed'] for p in Path(root).rglob('batch-complete.json') if p.parent not in covered)

def next_learning_state(stage,incumbent,candidate,old_wins,new_wins,threshold):
    ready=stage=='ppo' or max(old_wins,new_wins)>=threshold
    retained=candidate if new_wins>old_wins else incumbent
    current=(candidate if new_wins>=old_wins else incumbent) if ready else candidate
    return current,retained,'ppo' if ready else 'bc'

def active_profiles(profiles):
    return {name:p for name,p in profiles.items() if not p.get('quarantined') and not p.get('learningStopped')}

def peer_model(profile):
    return profile['retained'] if profile.get('quarantined') or profile.get('learningStopped') else profile['current']

def quarantine_profile(state,name,cycle,error):
    failure={'name':name,'cycle':cycle,'error':str(error)}
    state.setdefault('failures',[]).append(failure)
    state['profiles'][name]['quarantined']=failure

def comparison_score(summary,subject):
    rows=[r for r in summary['rows'] if r['subject']==subject]
    return (sum(r['outcome']=='W' and r['opponent']!='current-peer' for r in rows),sum(r['outcome']=='W' for r in rows))

def choose_peer(profiles,name,cycle):
    p=profiles[name]
    group='peerGroup' if 'peerGroup' in p else 'arm'
    candidates=[n for n,q in profiles.items() if q['route']!=p['route'] and q.get(group)==p.get(group)]
    if not candidates:raise ValueError('Each evolving route needs an opposing peer')
    return sorted(candidates)[cycle%len(candidates)]

def policy_spec(profile,model,teacher=False,evaluation=False):
    result={'commander':True,'policy':'model','mode':'bastion' if profile['route']=='main' else 'pressure','model':str(model),'policySeed':profile['seed']}
    if teacher:result.update(daggerBeta=profile.get('daggerBeta',.25),deterministic=profile.get('samplingDeterministic',True))
    elif evaluation and profile.get('evaluationDeterministic'):result['deterministic']=True
    elif not evaluation and profile.get('samplingDeterministic'):raise ValueError('PPO sampling must be stochastic')
    return result

def final_game_reserve(plan,profiles):
    fixed=len(profiles)*4*len(plan['maps'])*4*plan.get('finalRounds',2)
    cross=sum(a['route']!=b['route'] for a in profiles.values() for b in profiles.values())*len(plan['maps'])*plan.get('crossFinalRounds',1) if plan.get('crossFinal') else 0
    return fixed+cross

def cycle_game_reserve(plan,profiles,cycle):
    return sum((0 if cycle==0 and p.get('initialEpisodes') else len(plan['maps'])*4*p.get('rounds',plan.get('rounds',4)))+len(plan['maps'])*4*2*plan.get('checkRounds',1) for p in profiles.values())

def segment_decision(profile,models,counts,minimum_gain,patience,cycle):
    reference=counts['reference']['W'];winner=max(['current','retained'],key=lambda k:counts[k]['W'])
    improved=counts[winner]['W']>=reference+minimum_gain
    misses=0 if improved else profile.get('segmentsWithoutGain',0)+1
    result={**profile,'segmentsWithoutGain':misses}
    if improved:result['segmentReference']=models[winner]
    if misses>=patience:result['learningStopped']={'cycle':cycle,'reason':'No confirmed segment gain; allocation stop, not proof of convergence'}
    return result,{'referenceWins':reference,'candidateWins':counts[winner]['W'],'gainRequired':minimum_gain,'improved':improved,'stopped':bool(result.get('learningStopped'))}

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
        training=state['phase'] not in ['final-evaluation','cross-evaluation']
        remaining=(min(end,phase_end) if training else min(end,state.get('evaluationDeadline',end)))-time.time()
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
        directory.mkdir(parents=True,exist_ok=True)
        log=directory/'freeze.log';command([node,'--import','tsx','scripts/build-bot.ts','--ref',state['source'],'--mode','bastion' if route=='main' else 'pressure','--launch-model',str(model)],log)
        return json.loads(log.read_text().splitlines()[-1])['path']
    spec=policy_spec
    def batch(directory,subjects,opponents,rounds,workers,seed):
        directory.mkdir(parents=True,exist_ok=True);p={'maps':plan['maps'],'rounds':rounds,'workers':workers,'trace':'launch','seconds':600,'storageMiBPerGame':192,'orderSeed':seed,'subjects':subjects,'opponents':opponents}
        atomic(directory/'plan.json',p)
        try:command([python,'analysis/launch_batch.py',str(directory/'plan.json'),'--out',str(directory/'games')],directory/'batch.log')
        finally:
            progress=directory/'games/summary.json'
            partial=json.loads(progress.read_text()) if progress.exists() else {}
            starts=set((directory/'games').rglob('attempt-started.json'))
            atomic(directory/'batch-attempted.json',{'started':len(starts) if starts else partial.get('completed',0),'completed':partial.get('completed',0),'counts':partial.get('counts',{}),'at':time.time()})
        s=json.loads((directory/'games/summary.json').read_text())
        if not s['complete'] or any(c['E'] for c in s['counts'].values()):raise RuntimeError('Incomplete/error batch cannot train or select')
        atomic(directory/'batch-complete.json',{'completed':s['completed'],'counts':s['counts'],'at':time.time()})
        return s
    def train(profile,episodes,source,target,method,updates):
        if method=='ppo' and profile.get('optimizerStart') is not None:
            needs=profile.get('ppoIterations',0)>0 or profile['optimizerStart']=='resume'
            if needs and not Path(source).with_suffix('.optimizer.pt').exists():raise ValueError('Continuing PPO requires its corresponding Adam state')
        episode_file=target.with_suffix('.episodes.json');atomic(episode_file,episodes)
        fitted=target.with_name(target.stem+'.fit.json') if method=='bc' and 'temperature' in profile else target
        cmd=[str(Path(python).with_name('torchrun')),'--standalone','--nproc-per-node',str(plan.get('ranks',8)),'analysis/commander_train.py',method,'--episodes',str(episode_file),'--out',str(fitted),'--seed',str(profile['seed']),'--epochs','24' if method=='bc' else '3','--batch',str(plan.get('localBatch',4)),'--sequence','16','--burn','8','--threads','1','--validation-fraction','0','--action-encoding',profile['encoding']]
        if method=='bc':cmd+=['--bc-loss','factor','--bc-event-weight','32','--max-updates',str(updates)]
        if method=='bc' and 'temperature' in profile:cmd+=['--bc-temperature','1']
        if method=='ppo' and profile.get('ppoUpdates'):cmd+=['--max-updates',str(profile['ppoUpdates'])]
        if profile.get('learningRate'):cmd+=['--learning-rate',str(profile['learningRate'])]
        if source:cmd+=['--input',str(source)]
        elif method=='bc':cmd+=['--checkpoints','4','8','12']
        if plan.get('numaInterleave'):
            numa=shutil.which('numactl')
            if not numa:raise ValueError('Requested NUMA interleave requires numactl')
            cmd=[numa,'--interleave=all',*cmd]
        command(cmd,target.with_suffix('.log'));parity(fitted,fitted.with_suffix('.parity.log'))
        if fitted!=target:
            command([python,'analysis/commander_migrate.py','--input',str(fitted),'--out',str(target),'--encoding',profile['encoding'],'--temperature',str(profile['temperature'])],target.with_suffix('.migration.log'))
            parity(target,target.with_suffix('.parity.log'))
        return str(target)
    def initialize(item):
        name=item['name'];directory=root/name;directory.mkdir();p={**item,'stage':item.get('fixedStage','bc'),'recent':[]}
        if item.get('fresh'):
            model=train(p,plan['anchors'][item['route']],None,directory/'initial.json','bc',plan.get('freshUpdates',1600))
        elif item.get('copyInput'):
            original=Path(item['input']);artifact=json.loads(original.read_text())
            if artifact['encoding']!=item['encoding'] or artifact.get('temperature',1.)!=item.get('temperature',artifact.get('temperature',1.)):raise ValueError('Exact initializer grammar/temperature mismatch')
            model=directory/'initial.json';shutil.copyfile(original,model)
            for suffix in ['.golden.json','.optimizer.pt']:
                src=original.with_suffix(suffix)
                if suffix=='.optimizer.pt' and item.get('optimizerStart')=='cold':continue
                if suffix=='.optimizer.pt' and item.get('optimizerStart')=='resume' and not src.exists():raise ValueError('Declared warm PPO initializer has no Adam state')
                if src.exists():shutil.copyfile(src,model.with_suffix(suffix))
            parity(model,directory/'initial.parity.log');model=str(model)
        else:
            model=directory/'initial.json';command([python,'analysis/commander_migrate.py','--input',item['input'],'--out',str(model),'--encoding',item['encoding']],directory/'migration.log');parity(model,directory/'initial.parity.log');model=str(model)
        optimizer=Path(model).with_suffix('.optimizer.pt')
        p.update(initial=model,current=model,retained=model,segmentReference=model,ppoIterations=0,
            initialModelSha256=hashlib.sha256(Path(model).read_bytes()).hexdigest(),
            initialOptimizerSha256=hashlib.sha256(optimizer.read_bytes()).hexdigest() if optimizer.exists() else None)
        return name,p
    try:
        save()
        rules={}
        # Shared frozen controls must be built once before concurrent matrices.
        for route,mode in [('main','bastion'),('pressure','pressure')]:
            log=root/(route+'-rule-freeze.log');command([node,'--import','tsx','scripts/build-bot.ts','--ref','v0.1.16','--mode',mode],log)
            rules[route]=json.loads(log.read_text().splitlines()[-1])['path']
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(plan['profiles'])) as ex:
            futures={ex.submit(initialize,item):item['name'] for item in plan['profiles']}
            for future in concurrent.futures.as_completed(futures):
                try:
                    name,p=future.result();state['profiles'][name]=p
                except Exception as error:state.setdefault('initializationFailures',[]).append({'name':futures[future],'error':str(error)})
                save()
        # Preserve configured order for peer rotation, logs and final matrices.
        state['profiles']={item['name']:state['profiles'][item['name']] for item in plan['profiles'] if item['name'] in state['profiles']}
        for cycle in range(plan.get('maxCycles',40)):
            if time.time()>=cutoff or state['games']>=plan.get('maxGames',20000):break
            profiles=active_profiles(state['profiles'])
            if not profiles:state['stopReason']='No active learning profiles';save();break
            final_reserve=final_game_reserve(plan,state['profiles'])
            cycle_reserve=cycle_game_reserve(plan,profiles,cycle)
            segment_due=bool(plan.get('segmentEvery') and (cycle+1)%plan['segmentEvery']==0)
            segment_reserve=len(profiles)*3*len(plan['maps'])*4*plan.get('segmentRounds',8) if segment_due else 0
            if state['games']+cycle_reserve+segment_reserve+final_reserve>plan.get('maxGames',20000):
                state['stopReason']='Game budget reserves the next cycle, segment review and final matrices';save();break
            workers=max(1,plan['totalWorkers']//len(profiles)) if plan.get('totalWorkers') else plan.get('workersPerProfile',16)
            # Bound combined concurrent journal space, not each child in isolation.
            try:require_batch_space(root,cycle_reserve+segment_reserve+final_reserve,'launch',192,live_games=max(len(profiles)*workers,plan.get('finalWorkers',96)),compressed_mib_per_game=16)
            except RuntimeError as error:state['stopReason']=str(error);save();break
            state.update(phase='sampling-update',cycle=cycle);save()
            releases={};boundary=False
            for name,p in state['profiles'].items():
                d=root/f'cycle-{cycle:02d}'/name;d.mkdir(parents=True,exist_ok=True)
                try:
                    cached=state.setdefault('retainedReleases',{}).get(name)
                    retained_sha=hashlib.sha256(Path(p['retained']).read_bytes()).hexdigest()
                    if not cached or cached['modelSha256']!=retained_sha:
                        cached={'modelSha256':retained_sha,'release':freeze(p['retained'],p['route'],d/'retained')}
                        state['retainedReleases'][name]=cached
                    releases[name]=cached['release'] if peer_model(p)==p['retained'] else freeze(peer_model(p),p['route'],d/'current')
                except TrainingBoundary:
                    boundary=True;state['stopReason']='Training boundary during freezing; enter final evaluation';break
                except Exception as error:
                    quarantine_profile(state,name,cycle,error)
                    cached=state.get('retainedReleases',{}).get(name)
                    if cached:
                        releases[name]=cached['release']
                        state.setdefault('frozenFallbacks',[]).append({'cycle':cycle,'name':name,**cached})
                save()
            if boundary:break
            profiles=active_profiles(state['profiles'])
            if not profiles:state['stopReason']='No active profiles after freezing';break
            def step(name):
                p=profiles[name];d=root/f'cycle-{cycle:02d}'/name
                peer=choose_peer(state['profiles'],name,cycle)
                opponents={'supalosa':{'native':'supalosa'},'opposite-rule':{'release':rules['pressure' if p['route']=='main' else 'main']},'current-peer':{'release':releases[peer]},'strong-history':{'release':plan['strongReference']}}
                learning=p['stage']=='ppo'
                reused=p.get('initialEpisodes') if cycle==0 else None
                if reused:
                    new=json.loads(Path(reused).read_text());sampling=json.loads(Path(p['initialSummary']).read_text())
                    if not sampling['complete'] or any(v['E'] for v in sampling['counts'].values()):raise ValueError('Invalid shared initial sampling')
                    expected=hashlib.sha256(Path(p['current']).read_bytes()).hexdigest()
                    for episode in new:
                        m=json.loads((Path(episode)/'manifest.json').read_text()).get('commanderExperiment',{})
                        if m.get('modelSha256')!=expected or m.get('deterministic') or m.get('prefixUntil',0):raise ValueError('Shared initial data must be fully stochastic on-policy')
                        if not learning and m.get('daggerBeta')!=0:raise ValueError('Shared correction data needs queried teacher labels without intervention')
                    atomic(d/'sampling-reused.json',{'episodes':reused,'summary':p['initialSummary'],'uses':len(new),'newGames':0})
                else:
                    sampling=batch(d/'sample',{'learner':spec({**p,'seed':p['seed']+1009*cycle},p['current'],not learning)},opponents,p.get('rounds',plan.get('rounds',4)),workers,10000+cycle*37+p['seed'])
                    new=json.loads((d/'sample/games/learner-episodes.json').read_text())
                recent=[*p['recent'],new][-2:]
                episodes=new if learning else [*plan['anchors'][p['route']],*[x for chunk in recent for x in chunk]]
                candidate=train(p,episodes,p['current'],d/'candidate.json','ppo' if learning else 'bc',p.get('updates',plan.get('updates',400)))
                optimizer=Path(candidate).with_suffix('.optimizer.pt')
                atomic(d/'candidate-verified.json',{'name':name,'cycle':cycle,'model':candidate,'sha256':hashlib.sha256(Path(candidate).read_bytes()).hexdigest(),'optimizerSha256':hashlib.sha256(optimizer.read_bytes()).hexdigest() if optimizer.exists() else None,'encoding':p['encoding'],'verifiedAt':time.time(),'source':state['source']})
                check_profile={**p,'seed':p['seed']+2003*cycle}
                check=batch(d/'check',{'incumbent':spec(check_profile,p['retained'],evaluation=True),'candidate':spec(check_profile,candidate,evaluation=True)},opponents,plan.get('checkRounds',1),workers,20000+cycle*37+p['seed'])
                old=check['counts']['incumbent']['W'];won=check['counts']['candidate']['W']
                # Bootstrap can make useful partial progress before first wins; RL
                # keeps the directly compared incumbent when its update regresses.
                current,kept,stage=next_learning_state(p['stage'],p['retained'],candidate,old,won,plan.get('readyWins',4))
                scores=None
                if plan.get('controlFirstSelection'):
                    scores={s:comparison_score(check,s) for s in ['incumbent','candidate']}
                    better=scores['candidate']>scores['incumbent'];kept=candidate if better else p['retained']
                    current=candidate if scores['candidate']>=scores['incumbent'] else p['retained']
                if p.get('continueCandidates'):current=candidate
                if p.get('fixedStage'):stage=p['fixedStage']
                updated={**p,'current':current,'retained':kept,'recent':recent,'stage':stage,'ppoIterations':p.get('ppoIterations',0)+int(learning)}
                row={'cycle':cycle,'name':name,'method':'ppo' if learning else 'dagger-bc','peer':peer,'sampling':sampling['counts'],'sampleUses':len(new),'reusedInitialSampling':bool(reused),'check':check['counts'],'controlFirstScores':scores,'candidate':candidate,'retained':kept,'games':(0 if reused else sampling['completed'])+check['completed']}
                atomic(d/'profile-complete.json',{'profile':updated,'result':row})
                return name,updated,row
            boundary=False
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(profiles)) as ex:
                futures={ex.submit(step,name):name for name in profiles}
                for future in concurrent.futures.as_completed(futures):
                    try:
                        name,p,row=future.result();state['profiles'][name]=p;state['history'].append(row)
                    except TrainingBoundary:boundary=True
                    except Exception as error:quarantine_profile(state,futures[future],cycle,error)
                    state['games']=completed_games(root);state['pending']=verified_candidate_receipts(root);save()
            state['phase']='cycle-complete';save()
            if boundary:state['stopReason']='Training phase deadline; finalize verified models';break
            if segment_due:
                state['phase']='segment-evaluation';save()
                reviewing=active_profiles(state['profiles'])
                def review(name):
                    p=reviewing[name];models={'reference':p['segmentReference'],'current':p['current'],'retained':p['retained']};subjects={};aliases={};seen={}
                    for label,model in models.items():
                        sha=hashlib.sha256(Path(model).read_bytes()).hexdigest()
                        if sha not in seen:
                            seen[sha]=label;subjects[label]=spec({**p,'seed':p['seed']+7001*(cycle+1)},model,evaluation=True)
                        aliases[label]=seen[sha]
                    opponents={'supalosa':{'native':'supalosa'},'main-rule':{'release':rules['main']},'pressure-rule':{'release':rules['pressure']},'strong-history':{'release':plan['strongReference']}}
                    result=batch(root/'segments'/f'{cycle+1:02d}'/name,subjects,opponents,plan.get('segmentRounds',8),max(1,plan.get('finalWorkers',96)//max(1,len(reviewing))),40000+cycle)
                    counts={label:result['counts'][alias] for label,alias in aliases.items()}
                    updated,decision=segment_decision(p,models,counts,plan.get('segmentGain',8),plan.get('segmentPatience',2),cycle)
                    return name,updated,{'cycle':cycle,'name':name,'models':models,'counts':counts,**decision}
                with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,len(reviewing))) as ex:
                    futures={ex.submit(review,name):name for name in reviewing}
                    for future in concurrent.futures.as_completed(futures):
                        try:
                            name,p,row=future.result();state['profiles'][name]=p;state.setdefault('segments',[]).append(row)
                        except TrainingBoundary:boundary=True
                        except Exception as error:quarantine_profile(state,futures[future],cycle,error)
                        state['games']=completed_games(root);save()
                if boundary:state['stopReason']='Training boundary during segment review';break
        state['phase']='final-evaluation';save()
        final_counts={};matrices={}
        pending=verified_candidate_receipts(root)
        for name,p in state['profiles'].items():
            subjects={};seen=set()
            candidates={'initial':p['initial'],'retained':p['retained'],'latest-verified':pending.get(name,{}).get('model',p['current']),'confirmed':p.get('segmentReference',p['initial'])}
            for which,model in candidates.items():
                key=hashlib.sha256(Path(model).read_bytes()).hexdigest()
                if key in seen:continue
                seen.add(key);subjects[name+'-'+which]=spec(p,model,evaluation=True)
            matrices[name]=subjects
        state['evaluationDeadline']=end-plan.get('crossReserveSeconds',2700) if plan.get('crossFinal') else end
        def accumulate(target,counts):
            for subject,values in counts.items():
                previous=target.setdefault(subject,{k:0 for k in ['W','L','U','E']})
                for key,value in values.items():previous[key]+=value
        # One repetition across every model before spending time on later repetitions.
        for repetition in range(plan.get('finalRounds',2)):
            if time.time()+30>=state['evaluationDeadline']:break
            def final_step(name):
                subjects={label:{**p,'policySeed':p['policySeed']+repetition*1009} for label,p in matrices[name].items()}
                opponents={'supalosa':{'native':'supalosa'},'main-rule':{'release':rules['main']},'pressure-rule':{'release':rules['pressure']},'strong-history':{'release':plan['strongReference']}}
                return name,batch(root/'final'/name/f'pass-{repetition:02d}',subjects,opponents,1,max(1,plan.get('finalWorkers',96)//max(1,len(matrices))),29024+repetition)
            with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,len(matrices))) as ex:
                futures={ex.submit(final_step,name):name for name in matrices}
                for future in concurrent.futures.as_completed(futures):
                    try:
                        name,final=future.result();accumulate(final_counts,final['counts'])
                    except Exception as error:state.setdefault('finalFailures',[]).append({'name':futures[future],'pass':repetition,'error':str(error)})
                    state['games']=completed_games(root);state['final']=final_counts;save()
            state['finalPassesCompleted']=repetition+1;save()
        if state.get('finalPassesCompleted',0)<plan.get('finalRounds',2):state.setdefault('finalFailures',[]).append({'phase':'fixed-pool','error':'Time boundary before all balanced passes completed'})
        if plan.get('crossFinal'):
            state.update(phase='cross-evaluation',evaluationDeadline=end);save()
            releases={}
            for name,p in state['profiles'].items():
                directory=root/'cross'/name;directory.mkdir(parents=True,exist_ok=True)
                try:releases[name]=freeze(p['retained'],p['route'],directory)
                except Exception as error:state.setdefault('finalFailures',[]).append({'name':name,'phase':'cross-freeze','error':str(error)})
            def cross_step(name):
                p=state['profiles'][name]
                opponents={peer:{'release':release} for peer,release in releases.items() if state['profiles'][peer]['route']!=p['route']}
                if not opponents:return name,None
                return name,batch(root/'cross'/name/'evaluation',{'retained':spec(p,p['retained'],evaluation=True)},opponents,plan.get('crossFinalRounds',1),max(1,plan.get('finalWorkers',96)//max(1,len(state['profiles']))),30024)
            with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,len(state['profiles']))) as ex:
                futures={ex.submit(cross_step,name):name for name in state['profiles']}
                for future in concurrent.futures.as_completed(futures):
                    try:
                        name,cross=future.result()
                        if cross:state.setdefault('cross',{})[name]=cross['counts']
                    except Exception as error:state.setdefault('finalFailures',[]).append({'name':futures[future],'phase':'cross-evaluation','error':str(error)})
                    state['games']=completed_games(root);save()
        failed=bool(state.get('initializationFailures') or state.get('failures') or state.get('finalFailures'))
        state.update(phase='complete_with_failures' if failed else 'complete',finishedAt=time.time());save()
        return 1 if failed else 0
    except BaseException as error:
        state.update(phase='stopped',error=str(error),finishedAt=time.time());save();raise

if __name__=='__main__':sys.exit(main())
