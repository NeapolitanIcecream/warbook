"""Sequence BC/PPO for the whole-strategy interface, reusing real-game storage/outcomes."""
import argparse,hashlib,json,random,subprocess,time,os,datetime,math,shutil
from contextlib import nullcontext
from pathlib import Path
import numpy as np
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel
from commander_model import CommanderModel,pack,pack_actions,export,HIDDEN,FIELDS,ENCODINGS,recorded_temperature_config,recorded_member_scoring_config,artifact_encoding
from experiment_storage import open_text
from launch_outcome import classify
from commander_sequence import stream_batches,unique_batches,event_weight,training_action,canonical_action

def compact_world(world):
    # pack() already converts these fields to float32. Keep that exact numeric
    # representation instead of millions of boxed Python numbers between updates.
    for field,width in FIELDS.items():
        world[field]=np.asarray(world[field],dtype=np.float32).reshape(-1,width)
    world['global']=np.asarray(world['global'],dtype=np.float32)
    for field in ['entityEdges','regionEdges','productEdges']:
        world[field]=np.asarray(world[field],dtype=np.int32).reshape(-1,2)
    return world

def plain_world(world):
    return {key:value.tolist() if isinstance(value,np.ndarray) else value for key,value in world.items()}

def read_episode(path,compact=True):
    path=Path(path);manifest=json.loads((path/'manifest.json').read_text());result=json.loads((path/'result.json').read_text())
    outcome,reason,eligible=classify(result,manifest)
    if not eligible:return None
    subject=next(p for p in manifest['participants'] if p['role']=='subject');actor=subject['name']
    rows=[]
    with open_text(path/'decisions.ndjson') as f:
        for line in f:
            e=json.loads(line)
            if e.get('actor')==actor and e.get('kind')=='commander_decision':
                row=e['record']
                if compact:compact_world(row['world'])
                rows.append(row)
    if not rows:return None
    if any(r.get('encoding') not in ENCODINGS or r['schema']!='commander-v1' for r in rows):raise ValueError('Unsupported commander encoding')
    if any(b['tick']-a['tick']!=75 for a,b in zip(rows,rows[1:])):raise ValueError('Missing strategy step')
    if not 0<=result['tick']-rows[-1]['tick']<=75:raise ValueError('Invalid terminal boundary')
    behavior=manifest.get('commanderExperiment',{})
    if 'commanderExperiment' not in manifest and subject.get('release'):
        release=subject['release']
        # Frozen actors bypass the live experiment CLI; their journal and release
        # still identify the actual behavior distribution and production executor.
        behavior={key:rows[0][key] for key in ['encoding','temperature','productionTemperatures','memberScoring'] if key in rows[0]}
        behavior.update({'executionMode':release.get('commanderExecutionMode','single-item-v1'),
          'deterministic':release.get('deterministicLaunch',False),'modelSha256':release.get('launchModelSha256')})
    encoder_hashes=(subject.get('release') or {}).get('sourceHashes') or {}
    return {'path':str(path),'rows':rows,'reward':float(outcome=='W'),'outcome':outcome,
      'modelSha':behavior.get('modelSha256'),'deterministic':behavior.get('deterministic',False),'source':manifest['git'],
      'behavior':behavior,
      'encoderSha':encoder_hashes.get('src/commander/world.ts',manifest.get('sourceHashes',{}).get('src/commander/world.ts'))}

def load_model(artifact):
    model=CommanderModel(artifact['vocabulary'],artifact_encoding(artifact),artifact.get('temperature',1.),
      **({'production_temperatures':artifact['productionTemperatures']} if 'productionTemperatures' in artifact else {}),
      **({'member_scoring':artifact['memberScoring']} if 'memberScoring' in artifact else {}))
    model.load_state_dict({name:torch.tensor(x['values'],dtype=torch.float32).reshape(x['shape']) for name,x in artifact['tensors'].items()})
    return model

def validate_ppo_behavior(episodes,model,expected_sha):
    expected=(model.encoding,model.temperature,model.effective_production_temperatures())
    modes={e['behavior'].get('executionMode','single-item-v1') for e in episodes}
    if len(modes)!=1 or not modes<={'single-item-v1','native-finite-batches-v1'}:
        raise ValueError('PPO needs a single recorded production executor')
    for episode in episodes:
        if episode['deterministic']:raise ValueError('Greedy behavior is not the recorded stochastic PPO distribution')
        if episode['modelSha']!=expected_sha:raise ValueError('Mixed behavior checkpoints')
        if recorded_temperature_config(episode['behavior'])!=expected:raise ValueError('PPO manifest temperature/encoding mismatch')
        if recorded_member_scoring_config(episode['behavior'])!=model.member_scoring:raise ValueError('PPO manifest member scoring mismatch')
        for row in episode['rows']:
            if row['encoding']!=model.encoding:raise ValueError('PPO behavior encoding mismatch')
            if row['executionSource']=='policy':
                if recorded_temperature_config(row)!=expected:raise ValueError('PPO behavior temperature mismatch')
                if recorded_member_scoring_config(row)!=model.member_scoring:raise ValueError('PPO behavior member scoring mismatch')
                if model.encoding=='graph-plan-v3' and 'edits' not in row['action']:raise ValueError('PPO needs the recorded edit decisions; do not infer latent choices')

def configure_bc_temperature(model,temperature):
    if temperature is None:
        if model.production_temperatures:raise ValueError('BC with production overrides requires explicit --bc-temperature to normalize every head')
        return
    model.change_temperature(temperature)
    # Explicit BC temperature applies to every head, including v4 production.
    if model.encoding=='graph-plan-v4':model.change_production_temperatures({})

def windows(episodes,length,burn):
    out=[]
    for e in episodes:
        for start in range(0,len(e['rows']),length):
            selected=e['rows'][start:start+length]
            if not any(r['executionSource']=='policy' for r in selected) and e.get('ppo'):continue
            before=e['rows'][max(0,start-burn):start]
            out.append((e,before,selected))
    return out

def batch_steps(batch,model,args,train,actor_only=False):
    """BC carries state; PPO optionally rebuilds the current-weight prefix before burn-in."""
    if not batch:
        zero=sum((p.sum()*0 for p in model.parameters()))
        return zero,0.,0,torch.zeros((0,HIDDEN))
    burn=0 if args.method=='bc' else args.burn;length=args.sequence
    full_history=args.method=='ppo' and getattr(args,'ppo_history','recorded')=='full'
    worlds=[];actions=[];valid=[];present=[];returns=[];oldlog=[];adv=[];weights=[];first_hidden=[]
    if not full_history:
        for item in batch:
            e,before,rows=item[:3];first=(before or rows)[0]
            first_hidden.append(item[3] if len(item)>3 else first['hidden'] if e.get('ppo') else [0.]*HIDDEN)
    for t in range(burn+length):
        for item in batch:
            e,before,rows=item[:3]
            if t<burn:
                index=t-(burn-len(before));r=before[max(0,index)] if before else rows[0];exists=index>=0 and bool(before);active=exists
            else:
                index=t-burn;r=rows[min(index,len(rows)-1)];exists=index<len(rows);active=exists and (not e.get('ppo') or r['executionSource']=='policy')
            label=training_action(r,args.method)
            if args.method=='bc':label=canonical_action(label,r['world'],model.encoding)
            worlds.append(r['world']);actions.append(label);valid.append(active);present.append(exists);returns.append(e['reward']);oldlog.append(r['logp']);adv.append(r.get('_advantage',0.))
            weights.append(event_weight(label,getattr(args,'bc_event_weight',1)) if train and args.method=='bc' and getattr(args,'bc_loss','legacy')=='legacy' else 1.)
    d=pack(worlds,model.vocabulary);a=pack_actions(actions,d);b=len(batch)
    valid=torch.tensor(valid,dtype=torch.bool).reshape(burn+length,b);present=torch.tensor(present,dtype=torch.bool).reshape(burn+length,b)
    ret=torch.tensor(returns,dtype=torch.float32).reshape(burn+length,b);weights=torch.tensor(weights,dtype=torch.float32).reshape(burn+length,b)
    old=torch.tensor(oldlog,dtype=torch.float64).reshape(burn+length,b);advantages=torch.tensor(adv,dtype=torch.float32).reshape(burn+length,b)
    if full_history:
        from commander_retention import current_hidden_for_batch
        wall=time.monotonic();cpu=time.process_time();h,prefix_frames=current_hidden_for_batch(model,batch)
        cost=getattr(args,'_ppo_history_cost',{'prefixFrames':0,'forwardCalls':0,'cpuSeconds':0.,'rankSeconds':0.})
        cost['prefixFrames']+=prefix_frames;cost['forwardCalls']+=1
        cost['cpuSeconds']+=time.process_time()-cpu;cost['rankSeconds']+=time.monotonic()-wall
        args._ppo_history_cost=cost
    else:h=torch.tensor(first_hidden,dtype=torch.float32)
    losses=[];kls=[]
    encoded=model.encode_world(d)
    for t in range(burn+length):
        start=t*b;end=start+b
        dt={k:v[start:end] for k,v in d.items() if k not in ['entityEdges','regionEdges','productEdges']}
        at={k:v[start:end] for k,v in a.items()};et=tuple(v[start:end] for v in encoded)
        if t<burn:
            with torch.no_grad():p=model(dt,h,at,encoded=et)
            h=torch.where(present[t,:,None],p['hidden'],h).detach();continue
        queue_set_weight=getattr(args,'bc_queue_set_weight',None) if args.method=='bc' else None
        p=model(dt,h,at,encoded=et,bc_factor_boost=getattr(args,'bc_event_weight',32.) if args.method=='bc' and getattr(args,'bc_loss','legacy')=='factor' else 0.,return_conditionals=queue_set_weight is not None);h=torch.where(present[t,:,None],p['hidden'],h);active=valid[t]
        if not active.any():continue
        if args.method=='bc':
            if queue_set_weight is not None:
                from sprint_bc_events import queue_set_factor_loss
                p['bcLoss']=queue_set_factor_loss(p['conditionals'],at,args.bc_event_weight,queue_set_weight)
            policy=(p['bcLoss']*weights[t])[active].mean();kl=policy.detach()*0
        else:
            delta=p['logp']-old[t];ratio=delta.exp();aa=advantages[t]
            policy=torch.maximum(-aa*ratio,-aa*ratio.clamp(.9,1.1))[active].mean()-args.entropy*p['entropy'][active].mean()
            kl=((ratio-1)-delta)[active].mean().detach()
        objective=policy if actor_only else policy+.5*((p['value']-ret[t])**2)[active].mean()
        losses.append(objective*active.sum());kls.append(kl)
    frames=valid[burn:].sum().item()
    if not losses:return sum(p.sum()*0 for p in model.parameters()),0.,0,h.detach()
    return torch.stack(losses).sum()/frames,float(torch.stack(kls).mean()),frames,h.detach()

class SequenceObjective(torch.nn.Module):
    def __init__(self,model,args,retention=None):
        super().__init__();self.model=model;self.args=args;self.retention=retention
        self.profile=bool(retention is not None or getattr(args,'max_coverage',None) or getattr(args,'coverage_checkpoints',[]) or getattr(args,'ppo_history','recorded')=='full')
        self.rl_cpu_seconds=0.;self.rl_seconds=0.
    def forward(self,batch,kind='rl'):
        if kind=='rl':
            if not self.profile:return batch_steps(batch,self.model,self.args,True)
            wall=time.monotonic();cpu=time.process_time();result=batch_steps(batch,self.model,self.args,True)
            self.rl_cpu_seconds+=time.process_time()-cpu;self.rl_seconds+=time.monotonic()-wall
            return result
        if kind!='anchor' or self.retention is None:raise ValueError('Missing retention objective')
        return self.retention(self.model,batch)

def all_objects(value,world_size):
    if world_size==1:return [value]
    output=[None]*world_size;dist.all_gather_object(output,value);return output

def positive_int(value):
    number=int(value)
    if number<1:raise argparse.ArgumentTypeError('Must be a positive integer')
    return number

def positive_float(value):
    number=float(value)
    if not math.isfinite(number) or number<=0:raise argparse.ArgumentTypeError('Must be a finite positive number')
    return number

def coverage_suffix(level):
    return '-coverage-'+format(level,'.12g').replace('.','p')

def frame_keys(batch):
    """Identity of loss-bearing decisions; burn-in, teacher prefix and padding do not count."""
    return {(e['path'],row['tick']) for e,_,rows,*_ in batch for row in rows
            if not e.get('ppo') or row['executionSource']=='policy'}

class ActorFrameCoverage:
    """All ranks advance the same global counter at complete Adam boundaries.

    Coverage is cumulative actor-frame uses / distinct available actor frames.
    Unique coverage is reported separately, so a later epoch cannot hide reuse.
    """
    def __init__(self,available,levels=(),maximum=None):
        if available<1:raise ValueError('Coverage needs active actor frames')
        self.available=int(available);self.levels=sorted(set(levels));self.maximum=maximum
        self.used=0;self.unique=0;self.seen=set();self.endpoints=[]
    def threshold(self,level):return math.ceil(level*self.available)
    def observe(self,batches,updates,world_size=1):
        keys=set().union(*(frame_keys(batch) for batch in batches))
        counts=torch.tensor([sum(active_frames(batch) for batch in batches),len(keys-self.seen)],dtype=torch.int64)
        self.seen.update(keys)
        if world_size>1:dist.all_reduce(counts)
        self.used+=int(counts[0]);self.unique+=int(counts[1])
        done={row['requestedCoverage'] for row in self.endpoints};crossed=[]
        for level in self.levels:
            target=self.threshold(level)
            if level not in done and self.used>=target:
                row={'requestedCoverage':level,'targetActorFrames':target,'actualActorFrames':self.used,
                     'uniqueActorFrames':self.unique,'overshootActorFrames':self.used-target,'updates':updates,
                     'suffix':coverage_suffix(level)}
                crossed.append(row);self.endpoints.append(row)
        return crossed
    def reached(self):return self.maximum is not None and self.used>=self.threshold(self.maximum)
    def metadata(self):
        return {'availableActorFrames':self.available,'actorFrameUses':self.used,'uniqueActorFrames':self.unique,
                'effectiveCoverage':self.used/self.available,'uniqueCoverage':self.unique/self.available,
                'repeatedActorFrames':self.used-self.unique,'maximum':self.maximum,
                'maximumTargetActorFrames':self.threshold(self.maximum) if self.maximum is not None else None,
                'maximumOvershootActorFrames':max(0,self.used-self.threshold(self.maximum)) if self.maximum is not None else None,
                'checkpoints':[dict(row) for row in self.endpoints],
                'definition':'Cumulative policy actor-frame uses / distinct available policy frames; excludes burn-in, teacher prefix and padding; save and stop after complete Adam updates'}

def anchor_windows(episodes,length):
    return [(episode,start,min(start+length,len(episode['rows']))) for episode in episodes
            for start in range(0,len(episode['rows']),length)]

def anchor_frames(batch):return sum(end-start for _,start,end in batch)

class AnchorScheduler:
    """Two local pools, a separate RNG, and a shared rotating rank allocation.

    Counts, never worlds, are shared. Eight global windows at 16 x 2 RL windows
    occupy eight ranks; a rank without either source can still train normally.
    """
    def __init__(self,pools,counts,rank,seed,fraction):
        self.pools=pools;self.counts=counts;self.rank=rank;self.fraction=fraction
        self.rng=random.Random(seed);self.seen_rl_windows=0;self.used_windows=0;self.cursors=[0,0]
        self.order=[[],[]];self.positions=[0,0];self.used_by_source=[0,0]
        for source in range(2):
            if not any(count[source] for count in counts):raise ValueError('Retention needs fixed and current anchor sources')
    def _next(self,source):
        if self.positions[source]>=len(self.order[source]):
            self.order[source]=list(range(len(self.pools[source])));self.rng.shuffle(self.order[source]);self.positions[source]=0
        window=self.pools[source][self.order[source][self.positions[source]]];self.positions[source]+=1
        return window
    def select(self,global_rl_windows):
        self.seen_rl_windows+=global_rl_windows
        target=math.floor(self.seen_rl_windows*self.fraction+.5)
        count=target-self.used_windows;selected=[]
        # Alternate source globally, including short updates, to retain 50/50.
        for i in range(self.used_windows,target):
            source=i%2;eligible=[rank for rank,n in enumerate(self.counts) if n[source]]
            # Offset the second source so a full 16-rank profile spreads 4+4
            # windows across eight ranks instead of assigning both to four.
            offset=len(eligible)//2 if source else 0
            owner=eligible[(self.cursors[source]+offset)%len(eligible)];self.cursors[source]+=1
            self.used_by_source[source]+=1
            if owner==self.rank:selected.append((source,self._next(source)))
        self.used_windows=target
        return selected,count

def microbatch_groups(steps,accumulation):
    for start in range(0,steps,accumulation):
        yield range(start,min(steps,start+accumulation))

def active_frames(batch):
    # The same non-burn, non-padding decisions that batch_steps includes in its loss.
    return sum(sum(r['executionSource']=='policy' for r in rows) if e.get('ppo') else len(rows)
               for e,_,rows,*_ in batch)

def backward_microbatches(objective,batches,world_size):
    """Accumulate one global valid-frame mean; caller zeroes, clips and steps once."""
    expected=[active_frames(batch) for batch in batches]
    total=torch.tensor(float(sum(expected)),dtype=torch.float64)
    if world_size>1:dist.all_reduce(total)
    if float(total)<=0:raise ValueError('Global empty optimization step')
    results=[]
    for i,(batch,count) in enumerate(zip(batches,expected)):
        # DDP must see both the forward and backward inside no_sync. The last
        # microbatch synchronizes the accumulated gradients, including empty ranks.
        context=objective.no_sync() if world_size>1 and i+1<len(batches) else nullcontext()
        with context:
            result=objective(batch)
            if result is None:raise ValueError('Empty training block')
            loss,kl,frames,last_hidden=result
            if frames!=count:raise ValueError('Active-frame count differs from objective')
            if not torch.isfinite(loss):raise ValueError('Nonfinite update')
            # With one microbatch this is the original loss scaling exactly.
            (loss*(frames*world_size/float(total))).backward()
        results.append((float(loss.detach()),kl,frames,last_hidden))
    return results

def backward_with_retention(objective,batches,anchors,world_size,weight):
    """Separate global frame means, one DDP reduction, caller clips/steps once.

    Teacher samples only enter the anchor forward. RL batches, recorded logp and
    advantages are passed through unchanged. Zero-anchor ranks still participate
    in the last forward/backward and flush their accumulated PPO gradients.
    """
    if weight==0:return backward_microbatches(objective,batches,world_size),[]
    rl_counts=[active_frames(batch) for batch in batches];anchor_counts=[anchor_frames(batch) for batch in anchors]
    totals=torch.tensor([sum(rl_counts),sum(anchor_counts)],dtype=torch.float64)
    if world_size>1:dist.all_reduce(totals)
    if float(totals[0])<=0:raise ValueError('Global empty optimization step')
    if float(totals[1])<=0:return backward_microbatches(objective,batches,world_size),[]
    stages=[('rl',batch,count) for batch,count in zip(batches,rl_counts)]+[('anchor',batch,count) for batch,count in zip(anchors,anchor_counts)]
    rl_results=[];anchor_results=[]
    for i,(kind,batch,count) in enumerate(stages):
        context=objective.no_sync() if world_size>1 and i+1<len(stages) else nullcontext()
        with context:
            result=objective(batch,kind)
            if kind=='rl':
                loss,kl,frames,last_hidden=result;scale=frames*world_size/float(totals[0])
                rl_results.append((float(loss.detach()),kl,frames,last_hidden))
            else:
                loss,frames,diagnostics=result;scale=weight*frames*world_size/float(totals[1])
                anchor_results.append((float(loss.detach()),frames,diagnostics))
            if frames!=count:raise ValueError('Active-frame count differs from objective')
            if not torch.isfinite(loss):raise ValueError('Nonfinite update')
            wall=time.monotonic();cpu=time.process_time();(loss*scale).backward()
            if kind=='anchor':
                diagnostics['backward_cpu_seconds']=time.process_time()-cpu
                diagnostics['backward_seconds']=time.monotonic()-wall
    return rl_results,anchor_results

def episode_shards(paths,world_size):
    shards=[[] for _ in range(world_size)];loads=[0]*world_size
    lengths={path:json.loads((Path(path)/'result.json').read_text())['tick'] for path in paths}
    for path in sorted(paths,key=lambda p:lengths[p],reverse=True):
        rank=min(range(world_size),key=lambda i:loads[i]);shards[rank].append(path);loads[rank]+=lengths[path]
    return shards

class RetentionObjective:
    """Plain callable keeps the frozen teacher outside DDP's module/optimizer tree."""
    def __init__(self,teacher,cache):
        self.teacher=teacher;self.cache=cache;self.cpu_seconds=0.;self.seconds=0.;self.prefix_frames=0
        self.kl_sum=0.;self.active_factors=0
    def __call__(self,student,batch):
        from commander_retention import retention_batch
        wall=time.monotonic();cpu=time.process_time()
        loss,frames,diagnostics=retention_batch(student,self.teacher,self.cache,batch)
        self.cpu_seconds+=time.process_time()-cpu;self.seconds+=time.monotonic()-wall
        self.prefix_frames+=diagnostics.get('prefix_frames',0)
        self.kl_sum+=diagnostics.get('kl_sum',float(loss.detach())*frames)
        self.active_factors+=diagnostics.get('active_factors',0)
        return loss,frames,diagnostics

def prepare_retention(args,model,train,rank,world_size,encoder_sha,execution_modes):
    from commander_retention import build_teacher_cache
    reference=Path(args.retention_reference);reference_sha=hashlib.sha256(reference.read_bytes()).hexdigest()
    # Loading the reference must not consume the PPO model's random stream.
    with torch.random.fork_rng():teacher=load_model(json.loads(reference.read_text()))
    if (teacher.vocabulary,teacher.encoding,teacher.temperature,teacher.effective_production_temperatures(),teacher.member_scoring)!=(model.vocabulary,model.encoding,model.temperature,model.effective_production_temperatures(),model.member_scoring):
        raise ValueError('Retention reference must preserve vocabulary, encoding, deployment temperatures and member scoring')
    teacher.eval();teacher.requires_grad_(False)
    path=Path(args.retention_episodes);fixed_paths=json.loads(path.read_text())
    if not isinstance(fixed_paths,list) or not fixed_paths or len(set(fixed_paths))!=len(fixed_paths):
        raise ValueError('Retention episodes must be a nonempty predeclared list without duplicates')
    by_path={e['path']:e for e in train};fixed=[];excluded=[]
    for source in episode_shards(fixed_paths,world_size)[rank]:
        episode=by_path.get(str(Path(source)))
        if episode is None:episode=read_episode(source)
        if episode is None:excluded.append(source);continue
        if episode['modelSha']!=reference_sha:raise ValueError('Fixed anchor source is not the frozen reference checkpoint')
        if episode['encoderSha']!=encoder_sha or any(row['encoding']!=model.encoding for row in episode['rows']):
            raise ValueError('Fixed anchor encoding/source mismatch')
        if episode['behavior'].get('executionMode','single-item-v1') not in execution_modes:
            raise ValueError('Fixed anchors use a different production executor')
        if recorded_temperature_config(episode['behavior'])!=(teacher.encoding,teacher.temperature,teacher.effective_production_temperatures()):
            raise ValueError('Fixed anchor deployment temperature mismatch')
        if recorded_member_scoring_config(episode['behavior'])!=teacher.member_scoring:
            raise ValueError('Fixed anchor member scoring mismatch')
        fixed.append(episode);by_path[episode['path']]=episode
    pools=[anchor_windows(fixed,args.sequence),anchor_windows(train,args.sequence)]
    counts=all_objects([len(pool) for pool in pools],world_size)
    scheduler=AnchorScheduler(pools,counts,rank,args.seed+104729+rank,args.retention_fraction)
    # A rank caches only its own fixed-source shard plus already-loaded learner
    # histories. The teacher cache holds row references, never a second world copy.
    cpu=time.process_time();cache=build_teacher_cache(teacher,list(by_path.values()),seed=args.seed+15485863+rank)
    preparation_cpu=time.process_time()-cpu
    records=all_objects({'episodes':[e['path'] for e in fixed],'excluded':excluded,
                        'cacheFrames':cache.get('preparation_frames',0),'cacheSeconds':cache.get('preparation_seconds',0.),
                        'cacheCpuSeconds':preparation_cpu},world_size)
    metadata={'enabled':True,'weight':args.retention_weight,'anchorWindowFraction':args.retention_fraction,
              'referencePath':str(reference),'referenceSha256':reference_sha,
              'anchorListPath':str(path),'anchorListSha256':hashlib.sha256(path.read_bytes()).hexdigest(),
              'fixedEpisodes':[p for record in records for p in record['episodes']],
              'excludedFixedEpisodes':[p for record in records for p in record['excluded']],
              'windowCountsByRank':counts,'cachePreparationFrames':sum(record['cacheFrames'] for record in records),
              'teacherSamplingSeedBase':args.seed+15485863,'anchorSelectionSeedBase':args.seed+104729,
              'cachePreparationCpuSeconds':sum(record['cacheCpuSeconds'] for record in records),
              'cachePreparationMaxRankSeconds':max(record['cacheSeconds'] for record in records),
              'sampling':'Half predeclared C0 source windows, half current actual learner-world windows; separate RNG; rotating eligible ranks',
              'normalization':'Global RL and anchor frame means separately; weighted sum; one joint clip and Adam step',
              'history':'Each model replays the same actual world prefix with its own weights; teacher-prefix forward conditional KL',
              'retentionCodeSha256':hashlib.sha256(Path(__file__).with_name('commander_retention.py').read_bytes()).hexdigest()}
    return RetentionObjective(teacher,cache),scheduler,metadata

def golden(model,episodes,path):
    selected=[]
    predicates=[lambda r:True,lambda r:len(r['world']['unitRefs'])>=8,
      lambda r:bool(r['world']['placementObjects']),lambda r:any(x>=4 for x in r['action']['queues'])]
    for predicate in predicates:
        match=next((r for e in episodes for r in e['rows'] if predicate(r)),None)
        if match is not None and all(match is not x for x in selected):selected.append(match)
    samples=[];h=torch.zeros(1,HIDDEN)
    with torch.no_grad():
        for r in selected:
            w=r['world'];action=canonical_action(r['action'],w,model.encoding);d=pack([w],model.vocabulary);a=pack_actions([action],d);before=h[0].tolist();p=model(d,h,a,True)
            probs={k:(v[0,:len(w['unitRefs'])].tolist() if k=='unit' else v[0,:len(w['buildingRefs'])].tolist() if k=='building' else v[0].tolist() if v.ndim==3 else v[:,:len(w['placementObjects'])+1].tolist() if k.startswith('place') else v.tolist()) for k,v in p['probabilities'].items()}
            samples.append({'world':plain_world(w),'action':action,'hidden':before,'expected':{'logp':p['logp'].item(),'value':p['value'].item(),'hidden':p['hidden'][0].tolist(),'probabilities':probs}});h=p['hidden']
    path.write_text(json.dumps(samples)+'\n')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('method',choices=['bc','ppo']);ap.add_argument('--episodes',required=True);ap.add_argument('--input');ap.add_argument('--out',required=True);ap.add_argument('--seed',type=int,default=47)
    ap.add_argument('--epochs',type=int);ap.add_argument('--batch',type=int,default=4);ap.add_argument('--sequence',type=int,default=16);ap.add_argument('--burn',type=int,default=8);ap.add_argument('--threads',type=int,default=1)
    ap.add_argument('--bc-event-weight',type=float,default=32.);ap.add_argument('--bc-loss',choices=['legacy','factor'],default='factor');ap.add_argument('--max-updates',type=int);ap.add_argument('--entropy',type=float,default=.001);ap.add_argument('--checkpoints',type=int,nargs='*',default=[])
    ap.add_argument('--bc-queue-set-weight',type=positive_float,help='Explicit queue SET factor importance; overrides the legacy min(bcEventWeight,4) cap, retaining all other factor weights and denominators')
    ap.add_argument('--update-checkpoints',type=int,nargs='*',default=[])
    ap.add_argument('--max-coverage',type=positive_float,help='Stop after cumulative actor frames / unique available actor frames reaches this fraction, after a complete update')
    ap.add_argument('--coverage-checkpoints',type=positive_float,nargs='*',default=[],help='Save at actor-frame coverage fractions; endpoints crossed together alias one checkpoint')
    ap.add_argument('--gradient-accumulation',type=positive_int,default=1)
    ap.add_argument('--learning-rate',type=float);ap.add_argument('--bc-temperature',type=float)
    ap.add_argument('--ppo-history',choices=['recorded','full'],default='recorded',help='Recorded hidden plus burn-in (default), or rebuild actual current-weight history before the same burn-in and active window')
    ap.add_argument('--retention-reference',help='Frozen C0 artifact; never replaces the on-policy --input behavior checkpoint')
    ap.add_argument('--retention-episodes',help='Predeclared JSON list of complete C0 source episodes')
    ap.add_argument('--retention-weight',type=float,default=0.)
    ap.add_argument('--retention-fraction',type=positive_float,default=.25,help='Approximate anchor/RL frame ratio, implemented by same-length windows with actual counts recorded')
    ap.add_argument('--action-encoding',choices=ENCODINGS);ap.add_argument('--validation-fraction',type=float,default=.2);args=ap.parse_args()
    if not 0<=args.validation_fraction<1:raise ValueError('Invalid validation fraction')
    if args.learning_rate is not None and (not math.isfinite(args.learning_rate) or args.learning_rate<=0):raise ValueError('Invalid learning rate')
    if args.bc_temperature is not None and args.method!='bc':raise ValueError('PPO must retain the recorded behavior temperature')
    if args.bc_queue_set_weight is not None and (args.method!='bc' or args.bc_loss!='factor'):raise ValueError('Queue SET importance requires factor BC')
    if args.gradient_accumulation>1 and args.method!='ppo':raise ValueError('Gradient accumulation is PPO-only')
    if args.ppo_history!='recorded' and args.method!='ppo':raise ValueError('Full PPO history is PPO-only')
    coverage_requested=args.max_coverage is not None or bool(args.coverage_checkpoints)
    retention_requested=args.retention_reference is not None or args.retention_episodes is not None or args.retention_weight!=0
    if (coverage_requested or retention_requested) and args.method!='ppo':raise ValueError('Coverage and retention are PPO-only')
    if not math.isfinite(args.retention_weight) or args.retention_weight<0:raise ValueError('Invalid retention weight')
    if args.retention_weight and (not args.retention_reference or not args.retention_episodes):raise ValueError('Positive retention requires a frozen reference and predeclared source episodes')
    world_size=int(os.environ.get('WORLD_SIZE','1'));rank=int(os.environ.get('RANK','0'))
    torch.set_num_threads(args.threads)
    if world_size>1:dist.init_process_group('gloo',timeout=datetime.timedelta(minutes=10))
    training_started=time.monotonic();paths=json.loads(Path(args.episodes).read_text());random.Random(args.seed).shuffle(paths)
    if (coverage_requested or retention_requested) and len(set(paths))!=len(paths):raise ValueError('Coverage/retention requires distinct episode paths')
    validation_paths=paths[-max(1,int(len(paths)*args.validation_fraction)):] if args.method=='bc' and args.validation_fraction else []
    train_paths=paths[:-len(validation_paths)] if validation_paths else paths
    # Balance whole episodes by measured length. No rank loads all other ranks' raw journals.
    shards=episode_shards(train_paths,world_size)
    train=[];excluded=[]
    for path in shards[rank]:
        e=read_episode(path)
        if e is None or args.method=='ppo' and not any(r['executionSource']=='policy' for r in e['rows']):excluded.append(path)
        else:train.append(e)
    if not train:raise ValueError('Each rank needs a valid whole episode')
    details=all_objects({'paths':[e['path'] for e in train],'excluded':excluded,'hashes':list({e['encoderSha'] for e in train}),'greedy':any(e['deterministic'] for e in train),
                        'executionModes':list({e['behavior'].get('executionMode','single-item-v1') for e in train})},world_size)
    hashes={h for d in details for h in d['hashes']}
    if len(hashes)!=1 or None in hashes:raise ValueError('Mixed/unrecorded encoder source')
    execution_modes={mode for d in details for mode in d['executionModes']}
    if args.method=='ppo' and (len(execution_modes)!=1 or not execution_modes<={'single-item-v1','native-finite-batches-v1'}):
        raise ValueError('PPO cannot combine different production executors across ranks')
    torch.manual_seed(args.seed);np.random.seed(args.seed);random.seed(args.seed+rank)
    if args.input:
        artifact=json.loads(Path(args.input).read_text());model=load_model(artifact)
    else:
        if args.method=='ppo':raise ValueError('PPO needs a behavior checkpoint')
        local_names={n for e in train for r in e['rows'] for f in ['entityNames','productNames','goalNames'] for n in r['world'][f] if n}
        vocabulary=sorted({n for names in all_objects(list(local_names),world_size) for n in names});model=CommanderModel(vocabulary)
    if args.action_encoding:
        if args.method=='ppo' and args.action_encoding!=model.encoding:raise ValueError('PPO cannot change behavior encoding')
        model.change_encoding(args.action_encoding)
    if args.method=='bc':configure_bc_temperature(model,args.bc_temperature)
    advantage_info=None
    if args.method=='ppo':
        if any(d['greedy'] for d in details):raise ValueError('Greedy behavior is not the recorded stochastic PPO distribution')
        expected=hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        validate_ppo_behavior(train,model,expected)
        values=np.asarray([e['reward']-r['value'] for e in train for r in e['rows'] if r['executionSource']=='policy'])
        moments=torch.tensor([values.sum(),(values**2).sum(),len(values)],dtype=torch.float64)
        if world_size>1:dist.all_reduce(moments)
        mean=float(moments[0]/moments[2]);std=max(1e-6,math.sqrt(max(0.,float(moments[1]/moments[2])-mean**2)))
        advantage_info={'mean':mean,'std':std,'count':int(moments[2]),'definition':'Global policy-frame terminal return minus recorded behavior value; population standard deviation, floored at 1e-6'}
        for e in train:
            e['ppo']=True
            for r in e['rows']:r['_advantage']=(e['reward']-r['value']-mean)/std
    retention=None;scheduler=None;retention_info=None
    if args.retention_weight:
        retention,scheduler,retention_info=prepare_retention(args,model,train,rank,world_size,next(iter(hashes)),execution_modes)
    elif retention_requested:
        retention_info={'enabled':False,'weight':0.,'reason':'Zero weight uses the unchanged PPO path and does not load/cache/sample the reference'}
    sequence_objective=SequenceObjective(model,args,retention);objective=sequence_objective
    if world_size>1:objective=DistributedDataParallel(objective,broadcast_buffers=False)
    learning_rate=args.learning_rate if args.learning_rate is not None else 3e-4 if args.method=='bc' else 1e-4
    optimizer=torch.optim.Adam(model.parameters(),lr=learning_rate)
    optimizer_source=Path(args.input).with_suffix('.optimizer.pt') if args.method=='ppo' else None
    optimizer_sha=None
    if optimizer_source is not None and optimizer_source.exists():
        optimizer_sha=hashlib.sha256(optimizer_source.read_bytes()).hexdigest()
        optimizer.load_state_dict(torch.load(optimizer_source,weights_only=True,map_location='cpu'))
    # Restoring Adam moments must not silently restore the BC learning rate for PPO.
    for group in optimizer.param_groups:group['lr']=learning_rate
    samples=windows(train,args.sequence,args.burn)
    window_counts=all_objects(len(samples),world_size)
    coverage=None
    if coverage_requested or retention_requested:
        available=torch.tensor(len(frame_keys([(e,[],e['rows']) for e in train])),dtype=torch.int64)
        if world_size>1:dist.all_reduce(available)
        coverage=ActorFrameCoverage(int(available),args.coverage_checkpoints,args.max_coverage)
    history=[];updates=0;epochs=args.epochs or (12 if args.method=='bc' else 3)
    microbatch_steps=0;rank_microbatches=0;window_uses=0;frame_uses=0;seen_windows=set()
    seen_games=set();production_sets=set();production_alternatives=set()
    anchor_window_uses=[0,0];anchor_frame_uses=[0,0];anchor_seen=[set(),set()]
    anchor_microbatches=0;anchor_backward_cpu=0.;anchor_backward_seconds=0.;optimization_cpu=0.;checkpoint_records=[]
    accumulation_info={'gradientAccumulation':args.gradient_accumulation,
        'effectiveGlobalBatch':args.batch*world_size*args.gradient_accumulation,
        'gradientNormalization':'One global valid-frame mean across the update; one clip and Adam step; trailing groups use their actual frames'}
    history_info={'mode':args.ppo_history,'burnIn':args.burn,'activeWindow':args.sequence,
                  'definition':'Actual world history replayed from zero with current weights before each window; detached prefix, unchanged burn-in and active-window BPTT; no hidden cache across updates' if args.ppo_history=='full' else 'Recorded hidden at the first burn/window row, followed by burn-in'}
    def training_usage():
        counts=torch.tensor([rank_microbatches,window_uses,frame_uses,len(seen_windows),len(seen_games),len(production_sets),len(production_alternatives)],dtype=torch.int64)
        if world_size>1:dist.all_reduce(counts)
        usage={'microbatchSteps':microbatch_steps,'nonemptyRankMicrobatches':int(counts[0]),
            'windowUses':int(counts[1]),'activeFrames':int(counts[2]),'uniqueWindows':int(counts[3]),
            'sourceGamesUsed':int(counts[4]),'uniqueProductionSets':int(counts[5]),'uniqueNondefaultProductionSets':int(counts[6])}
        if coverage is not None:
            usage['coverage']=coverage.metadata()
        if sequence_objective.profile:
            cpu=torch.tensor([sequence_objective.rl_cpu_seconds,sequence_objective.rl_seconds,optimization_cpu],dtype=torch.float64)
            if world_size>1:dist.all_reduce(cpu)
            usage['cost']={'rlForwardCpuSeconds':float(cpu[0]),'rlForwardRankSeconds':float(cpu[1]),'optimizationCpuSeconds':float(cpu[2]),
                           'scope':'Summed rank process CPU; optimization includes forward/backward, synchronization and optimizer; cache preparation separate'}
        if args.ppo_history=='full':
            local=getattr(args,'_ppo_history_cost',{})
            history_counts=torch.tensor([local.get('prefixFrames',0),local.get('forwardCalls',0)],dtype=torch.int64)
            history_cost=torch.tensor([local.get('cpuSeconds',0.),local.get('rankSeconds',0.)],dtype=torch.float64)
            if world_size>1:dist.all_reduce(history_counts);dist.all_reduce(history_cost)
            usage['ppoHistory']={'prefixFrames':int(history_counts[0]),'nonemptyRankForwards':int(history_counts[1]),
                                 'prefixCpuSeconds':float(history_cost[0]),'prefixRankSeconds':float(history_cost[1]),
                                 'includedIn':'RL forward and optimization CPU costs; not additional cost to sum twice'}
        if retention is not None:
            ac=torch.tensor([*anchor_window_uses,*anchor_frame_uses,*(len(seen) for seen in anchor_seen),anchor_microbatches,
                             retention.prefix_frames,retention.active_factors],dtype=torch.int64)
            cost=torch.tensor([retention.cpu_seconds,retention.seconds,anchor_backward_cpu,anchor_backward_seconds,retention.kl_sum],dtype=torch.float64)
            if world_size>1:dist.all_reduce(ac);dist.all_reduce(cost)
            usage['retention']={'windowUses':int(ac[0]+ac[1]),'activeFrames':int(ac[2]+ac[3]),
                                'fixedWindowUses':int(ac[0]),'currentWindowUses':int(ac[1]),
                                'fixedFrames':int(ac[2]),'currentFrames':int(ac[3]),
                                'uniqueFixedWindows':int(ac[4]),'uniqueCurrentWindows':int(ac[5]),
                                'nonemptyRankMicrobatches':int(ac[6]),'studentPrefixFrames':int(ac[7]),'activeFactors':int(ac[8]),
                                'forwardCpuSeconds':float(cost[0]),'forwardRankSeconds':float(cost[1]),
                                'backwardCpuSeconds':float(cost[2]),'backwardRankSeconds':float(cost[3]),
                                'meanConditionalKL':float(cost[4]/(ac[2]+ac[3])) if int(ac[2]+ac[3]) else 0.,
                                'actualFrameFraction':int(ac[2]+ac[3])/max(1,usage['activeFrames'])}
        return usage
    def checkpoint(suffix,epoch,aliases=()):
        checkpoint_records.append({'suffix':suffix,'aliases':list(aliases),'updates':updates,
                                   **({'actorFrameUses':coverage.used,'uniqueActorFrames':coverage.unique} if coverage is not None else {})})
        usage=training_usage()
        if rank==0:
            base=Path(args.out);base.parent.mkdir(parents=True,exist_ok=True);target=base.with_name(base.stem+suffix+'.json')
            info={'method':args.method,'seed':args.seed,'epochs':epoch+1,'updates':updates,'encoderSha256':next(iter(hashes)),
                'inputSha256':hashlib.sha256(Path(args.input).read_bytes()).hexdigest() if args.input else None,
                'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
                'worldSize':world_size,'sequence':args.sequence,'burnIn':args.burn,'bcEventWeight':args.bc_event_weight,'bcLoss':args.bc_loss,'bcQueueSetWeight':args.bc_queue_set_weight,
                **accumulation_info,'trainingUsage':usage,'executionModes':sorted(execution_modes),
                'encoding':model.encoding,'temperature':model.temperature,'memberScoring':dict(model.member_scoring),'learningRate':learning_rate,'bcMemory':'continuous episode carry','objective':'terminal MC; checkpoint before final validation'}
            if coverage is not None or retention_info is not None:
                info['optimizerStart']='restored' if optimizer_sha else 'cold';info['inputOptimizerSha256']=optimizer_sha
            if model.encoding=='graph-plan-v4':info['productionTemperatures']=model.effective_production_temperatures()
            if advantage_info is not None:info['advantageNormalization']=advantage_info
            if args.method=='ppo':info['ppoHistory']=history_info
            if coverage is not None:info['checkpointAliases']=[suffix,*aliases];info['coverage']=coverage.metadata()
            if retention_info is not None:info['retention']=retention_info
            sha=export(model,target,info);torch.save(optimizer.state_dict(),target.with_suffix('.optimizer.pt'));golden(model,train,target.with_suffix('.golden.json'))
            target.with_suffix('.done.json').write_text(json.dumps({'sha256':sha,'epoch':epoch+1,'updates':updates})+'\n')
            for alias in aliases:
                alternate=base.with_name(base.stem+alias+'.json')
                for extension in ['.json','.optimizer.pt','.golden.json','.done.json']:
                    shutil.copyfile(target.with_suffix(extension),alternate.with_suffix(extension))
        if world_size>1:dist.barrier()
    for epoch in range(epochs):
        losses=[];kls=[];count=0;epoch_windows=0;epoch_microbatches=0;epoch_nonempty=0;epoch_start=time.monotonic();carry={}
        if args.method=='bc':
            ordered=list(train);random.shuffle(ordered);schedule=stream_batches(ordered,args.sequence,args.batch)
        else:
            random.shuffle(samples);schedule=unique_batches(samples,args.batch)
        steps=max(all_objects(len(schedule),world_size))
        for indices in microbatch_groups(steps,args.gradient_accumulation):
            descriptors=[schedule[i] if i<len(schedule) else [] for i in indices]
            batches=[[(e,[],e['rows'][start:start+args.sequence],carry.get(e['path'],[0.]*HIDDEN) if start else [0.]*HIDDEN) for e,start in block] if args.method=='bc' else block for block in descriptors]
            selected=[];anchor_batches=[]
            if scheduler is not None:
                global_windows=torch.tensor(sum(len(batch) for batch in batches),dtype=torch.int64)
                if world_size>1:dist.all_reduce(global_windows)
                selected,_=scheduler.select(int(global_windows))
                anchor_batches=unique_batches([window for _,window in selected],args.batch)
                anchor_steps=max(all_objects(len(anchor_batches),world_size))
                anchor_batches.extend([] for _ in range(anchor_steps-len(anchor_batches)))
            optimizer.zero_grad()
            cpu=time.process_time() if sequence_objective.profile else 0.
            if retention is None:results=backward_microbatches(objective,batches,world_size);anchor_results=[]
            else:results,anchor_results=backward_with_retention(objective,batches,anchor_batches,world_size,args.retention_weight)
            nnorm=torch.nn.utils.clip_grad_norm_(model.parameters(),.5)
            if not torch.isfinite(nnorm):raise ValueError('Nonfinite gradient')
            optimizer.step();updates+=1
            if sequence_objective.profile:optimization_cpu+=time.process_time()-cpu
            for source,(episode,start,end) in selected:
                anchor_window_uses[source]+=1;anchor_frame_uses[source]+=end-start
                anchor_seen[source].add((episode['path'],start,end))
            anchor_microbatches+=sum(bool(batch) for batch in anchor_batches)
            anchor_backward_cpu+=sum(d.get('backward_cpu_seconds',0.) for _,_,d in anchor_results)
            anchor_backward_seconds+=sum(d.get('backward_seconds',0.) for _,_,d in anchor_results)
            for block,batch,(loss,kl,frames,last_hidden) in zip(descriptors,batches,results):
                if args.method=='bc':
                    for j,(e,start) in enumerate(block):carry[e['path']]=last_hidden[j].tolist()
                    seen_windows.update((e['path'],start) for e,start in block)
                else:
                    seen_windows.update((e['path'],rows[0]['tick']) for e,_,rows in batch)
                    for e,_,rows in batch:
                        for record in rows:
                            if record['executionSource']!='policy':continue
                            for queue,choice in enumerate(record['action']['queues']):
                                if choice<4:continue
                                key=(e['path'],record['tick'],queue)
                                production_sets.add(key)
                                if record['action']['amounts'][queue]!=0 or record['action']['cash'][queue]!=0:
                                    production_alternatives.add(key)
                seen_games.update(item[0]['path'] for item in batch)
                losses.append(loss*frames);kls.append(kl*frames);count+=frames
                epoch_windows+=len(batch);epoch_nonempty+=bool(batch);epoch_microbatches+=1
                window_uses+=len(batch);frame_uses+=frames;rank_microbatches+=bool(batch);microbatch_steps+=1
            crossed=coverage.observe(batches,updates,world_size) if coverage is not None else []
            suffixes=([f'-update-{updates}'] if updates in args.update_checkpoints else [])+[row['suffix'] for row in crossed]
            if suffixes:checkpoint(suffixes[0],epoch,suffixes[1:])
            if args.max_updates and updates>=args.max_updates or coverage is not None and coverage.reached():break
        metrics=torch.tensor([sum(losses),sum(kls),count,epoch_windows,epoch_nonempty],dtype=torch.float64)
        if world_size>1:dist.all_reduce(metrics)
        row={'epoch':epoch,'loss':float(metrics[0]/metrics[2]),'approxKL':float(metrics[1]/metrics[2]),'frames':int(metrics[2]),
            'windows':int(metrics[3]),'microbatchSteps':epoch_microbatches,'nonemptyRankMicrobatches':int(metrics[4]),
            'seconds':time.monotonic()-epoch_start,'updates':updates};history.append(row)
        if coverage is not None:row['coverage']=coverage.metadata()
        if rank==0:print(json.dumps(row),flush=True)
        if epoch+1 in args.checkpoints:
            checkpoint(f'-after-{epoch+1}',epoch)
        if args.max_updates and updates>=args.max_updates or coverage is not None and coverage.reached() or args.method=='ppo' and row['approxKL']>.02:break
    usage=training_usage()
    alternative_events=all_objects(sorted(production_alternatives),world_size)
    if world_size>1:dist.barrier();dist.destroy_process_group()
    if rank!=0:return
    validation=[];metrics={}
    if validation_paths:
        losses=[]
        with torch.no_grad():
            for path in validation_paths:
                e=read_episode(path)
                if e is None:continue
                validation.append(e['path'])
                h=[0.]*HIDDEN
                for start in range(0,len(e['rows']),args.sequence):
                    r=batch_steps([(e,[],e['rows'][start:start+args.sequence],h)],model,args,False)
                    losses.append(float(r[0]));h=r[3][0].tolist()
        metrics={'sequenceLoss':float(np.mean(losses)),'windows':len(losses),'scope':'Per-invocation whole-episode split; warm starts may already have seen these sources; not independent holdout or playing strength'}
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
    event_path=out.with_suffix('.production-events.json')
    event_path.write_text(json.dumps({'scope':'Distinct nondefault SET decisions included in PPO loss; join with observed order lifetimes by directory/tick/queue',
        'events':[{'directory':path,'tick':tick,'queue':queue} for group in alternative_events for path,tick,queue in group]},indent=2)+'\n')
    metadata={'method':args.method,'seed':args.seed,'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
      'trainerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'modelCodeSha256':hashlib.sha256(Path(__file__).with_name('commander_model.py').read_bytes()).hexdigest(),
      'encoderSha256':next(iter(hashes)),'worldSize':world_size,'localBatch':args.batch,'globalBatch':args.batch*world_size,'windowCounts':window_counts,
      **accumulation_info,'trainingUsage':usage,'executionModes':sorted(execution_modes),'productionEventsSha256':hashlib.sha256(event_path.read_bytes()).hexdigest(),
      'padding':'Zero-loss empty ranks, no repeated training windows','bcEventWeight':args.bc_event_weight,'bcMemory':'Chronological whole episodes with detached carried hidden state',
      'bcLoss':args.bc_loss,'bcQueueSetWeight':args.bc_queue_set_weight,'bcFactorNormalization':'Per frame: mean across active domains; changed factors weighted directly; one mean KEEP negative per domain; global valid-frame DDP mean',
      'encoding':model.encoding,'temperature':model.temperature,'memberScoring':dict(model.member_scoring),'learningRate':learning_rate,'optimizerStart':'restored' if optimizer_sha else 'cold','inputOptimizerSha256':optimizer_sha,'episodeMemory':'float32 feature blocks and int32 edges; identical pack tensors','validationFraction':args.validation_fraction,'labelAdapter':'v2 confirms retyped members; v3 BC labels edit decisions from demonstrated plan changes; PPO retains recorded choices',
      'trainingEpisodes':[p for d in details for p in d['paths']],'validationEpisodes':validation,'excluded':[p for d in details for p in d['excluded']],
      'inputSha256':hashlib.sha256(Path(args.input).read_bytes()).hexdigest() if args.input else None,
      'labels':'BC uses explicit teacherAction where recorded; PPO uses executed action only',
      'history':history,'validation':metrics,'sequence':args.sequence,'burnIn':args.burn,'updates':updates,
      'objective':'terminal W=1,L/U=0; E excluded; PPO gamma1 terminal MC; prefix teacher actor steps excluded',
      'seconds':time.monotonic()-training_started,'parameters':sum(p.numel() for p in model.parameters())}
    if model.encoding=='graph-plan-v4':metadata['productionTemperatures']=model.effective_production_temperatures()
    if advantage_info is not None:metadata['advantageNormalization']=advantage_info
    if args.method=='ppo':metadata['ppoHistory']=history_info
    if coverage is not None:metadata['coverage']=coverage.metadata();metadata['checkpointRecords']=checkpoint_records
    if retention_info is not None:metadata['retention']=retention_info
    torch.save(optimizer.state_dict(),out.with_suffix('.optimizer.pt'))
    sha=export(model,out,{k:v for k,v in metadata.items() if k not in ['trainingEpisodes','validationEpisodes','excluded','history']})
    out.with_suffix('.training.json').write_text(json.dumps(metadata,indent=2)+'\n');golden(model,train,out.with_suffix('.golden.json'))
    print(json.dumps({'sha256':sha,'parameters':metadata['parameters'],'games':len(metadata['trainingEpisodes']),'validationGames':len(validation),'updates':updates,'seconds':metadata['seconds']}),flush=True)

if __name__=='__main__':main()
