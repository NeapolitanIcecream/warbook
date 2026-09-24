"""Sequence BC/PPO for the whole-strategy interface, reusing real-game storage/outcomes."""
import argparse,hashlib,json,random,subprocess,time,os,datetime,math
from pathlib import Path
import numpy as np
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel
from commander_model import CommanderModel,pack,pack_actions,export,HIDDEN,FIELDS
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
    actor=next(p['name'] for p in manifest['participants'] if p['role']=='subject')
    rows=[]
    with open_text(path/'decisions.ndjson') as f:
        for line in f:
            e=json.loads(line)
            if e.get('actor')==actor and e.get('kind')=='commander_decision':
                row=e['record']
                if compact:compact_world(row['world'])
                rows.append(row)
    if not rows:return None
    if any(r.get('encoding') not in ['graph-plan-v1','graph-plan-v2','graph-plan-v3'] or r['schema']!='commander-v1' for r in rows):raise ValueError('Unsupported commander encoding')
    if any(b['tick']-a['tick']!=75 for a,b in zip(rows,rows[1:])):raise ValueError('Missing strategy step')
    if not 0<=result['tick']-rows[-1]['tick']<=75:raise ValueError('Invalid terminal boundary')
    return {'path':str(path),'rows':rows,'reward':float(outcome=='W'),'outcome':outcome,
      'modelSha':manifest.get('commanderExperiment',{}).get('modelSha256'),'source':manifest['git'],
      'encoderSha':manifest.get('sourceHashes',{}).get('src/commander/world.ts')}

def load_model(artifact):
    model=CommanderModel(artifact['vocabulary'],artifact['encoding'],artifact.get('temperature',1.))
    model.load_state_dict({name:torch.tensor(x['values'],dtype=torch.float32).reshape(x['shape']) for name,x in artifact['tensors'].items()})
    return model

def windows(episodes,length,burn):
    out=[]
    for e in episodes:
        for start in range(0,len(e['rows']),length):
            selected=e['rows'][start:start+length]
            if not any(r['executionSource']=='policy' for r in selected) and e.get('ppo'):continue
            before=e['rows'][max(0,start-burn):start]
            out.append((e,before,selected))
    return out

def batch_steps(batch,model,args,train):
    """BC carries the forward state across adjacent blocks; PPO uses recorded state plus burn-in."""
    if not batch:
        zero=sum((p.sum()*0 for p in model.parameters()))
        return zero,0.,0,torch.zeros((0,HIDDEN))
    burn=0 if args.method=='bc' else args.burn;length=args.sequence
    worlds=[];actions=[];valid=[];present=[];returns=[];oldlog=[];adv=[];weights=[];first_hidden=[]
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
    h=torch.tensor(first_hidden,dtype=torch.float32);losses=[];kls=[]
    encoded=model.encode_world(d)
    for t in range(burn+length):
        start=t*b;end=start+b
        dt={k:v[start:end] for k,v in d.items() if k not in ['entityEdges','regionEdges','productEdges']}
        at={k:v[start:end] for k,v in a.items()};et=tuple(v[start:end] for v in encoded)
        if t<burn:
            with torch.no_grad():p=model(dt,h,at,encoded=et)
            h=torch.where(present[t,:,None],p['hidden'],h).detach();continue
        p=model(dt,h,at,encoded=et,bc_factor_boost=getattr(args,'bc_event_weight',32.) if args.method=='bc' and getattr(args,'bc_loss','legacy')=='factor' else 0.);h=torch.where(present[t,:,None],p['hidden'],h);active=valid[t]
        if not active.any():continue
        if args.method=='bc':policy=(p['bcLoss']*weights[t])[active].mean();kl=policy.detach()*0
        else:
            delta=p['logp']-old[t];ratio=delta.exp();aa=advantages[t]
            policy=torch.maximum(-aa*ratio,-aa*ratio.clamp(.9,1.1))[active].mean()-args.entropy*p['entropy'][active].mean()
            kl=((ratio-1)-delta)[active].mean().detach()
        losses.append((policy+.5*((p['value']-ret[t])**2)[active].mean())*active.sum());kls.append(kl)
    frames=valid[burn:].sum().item()
    if not losses:return sum(p.sum()*0 for p in model.parameters()),0.,0,h.detach()
    return torch.stack(losses).sum()/frames,float(torch.stack(kls).mean()),frames,h.detach()

class SequenceObjective(torch.nn.Module):
    def __init__(self,model,args):super().__init__();self.model=model;self.args=args
    def forward(self,batch):return batch_steps(batch,self.model,self.args,True)

def all_objects(value,world_size):
    if world_size==1:return [value]
    output=[None]*world_size;dist.all_gather_object(output,value);return output

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
    ap.add_argument('--update-checkpoints',type=int,nargs='*',default=[])
    ap.add_argument('--learning-rate',type=float);ap.add_argument('--bc-temperature',type=float)
    ap.add_argument('--action-encoding',choices=['graph-plan-v1','graph-plan-v2','graph-plan-v3']);ap.add_argument('--validation-fraction',type=float,default=.2);args=ap.parse_args()
    if not 0<=args.validation_fraction<1:raise ValueError('Invalid validation fraction')
    if args.learning_rate is not None and (not math.isfinite(args.learning_rate) or args.learning_rate<=0):raise ValueError('Invalid learning rate')
    if args.bc_temperature is not None and args.method!='bc':raise ValueError('PPO must retain the recorded behavior temperature')
    world_size=int(os.environ.get('WORLD_SIZE','1'));rank=int(os.environ.get('RANK','0'))
    torch.set_num_threads(args.threads)
    if world_size>1:dist.init_process_group('gloo',timeout=datetime.timedelta(minutes=10))
    training_started=time.monotonic();paths=json.loads(Path(args.episodes).read_text());random.Random(args.seed).shuffle(paths)
    validation_paths=paths[-max(1,int(len(paths)*args.validation_fraction)):] if args.method=='bc' and args.validation_fraction else []
    train_paths=paths[:-len(validation_paths)] if validation_paths else paths
    # Balance whole episodes by measured length. No rank loads all other ranks' raw journals.
    shards=[[] for _ in range(world_size)];loads=[0]*world_size
    lengths={path:json.loads((Path(path)/'result.json').read_text())['tick'] for path in train_paths}
    for path in sorted(train_paths,key=lambda p:lengths[p],reverse=True):
        r=min(range(world_size),key=lambda i:loads[i]);shards[r].append(path);loads[r]+=lengths[path]
    train=[];excluded=[]
    for path in shards[rank]:
        e=read_episode(path)
        if e is None or args.method=='ppo' and not any(r['executionSource']=='policy' for r in e['rows']):excluded.append(path)
        else:train.append(e)
    if not train:raise ValueError('Each rank needs a valid whole episode')
    details=all_objects({'paths':[e['path'] for e in train],'excluded':excluded,'hashes':list({e['encoderSha'] for e in train})},world_size)
    hashes={h for d in details for h in d['hashes']}
    if len(hashes)!=1 or None in hashes:raise ValueError('Mixed/unrecorded encoder source')
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
    if args.bc_temperature is not None:model.change_temperature(args.bc_temperature)
    if args.method=='ppo':
        expected=hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        if any(e['modelSha']!=expected for e in train):raise ValueError('Mixed behavior checkpoints')
        if any(r['encoding']!=model.encoding for e in train for r in e['rows']):raise ValueError('PPO behavior encoding mismatch')
        if any(r.get('temperature',1.)!=model.temperature for e in train for r in e['rows'] if r['executionSource']=='policy'):raise ValueError('PPO behavior temperature mismatch')
        if model.encoding=='graph-plan-v3' and any('edits' not in r['action'] for e in train for r in e['rows'] if r['executionSource']=='policy'):raise ValueError('PPO needs the recorded edit decisions; do not infer latent choices')
        values=np.asarray([e['reward']-r['value'] for e in train for r in e['rows'] if r['executionSource']=='policy'])
        moments=torch.tensor([values.sum(),(values**2).sum(),len(values)],dtype=torch.float64)
        if world_size>1:dist.all_reduce(moments)
        mean=float(moments[0]/moments[2]);std=max(1e-6,math.sqrt(max(0.,float(moments[1]/moments[2])-mean**2)))
        for e in train:
            e['ppo']=True
            for r in e['rows']:r['_advantage']=(e['reward']-r['value']-mean)/std
    objective=SequenceObjective(model,args)
    if world_size>1:objective=DistributedDataParallel(objective,broadcast_buffers=False)
    learning_rate=args.learning_rate if args.learning_rate is not None else 3e-4 if args.method=='bc' else 1e-4
    optimizer=torch.optim.Adam(model.parameters(),lr=learning_rate)
    if args.method=='ppo' and Path(args.input).with_suffix('.optimizer.pt').exists():optimizer.load_state_dict(torch.load(Path(args.input).with_suffix('.optimizer.pt'),weights_only=True,map_location='cpu'))
    # Restoring Adam moments must not silently restore the BC learning rate for PPO.
    for group in optimizer.param_groups:group['lr']=learning_rate
    samples=windows(train,args.sequence,args.burn)
    window_counts=all_objects(len(samples),world_size)
    history=[];updates=0;epochs=args.epochs or (12 if args.method=='bc' else 3)
    def checkpoint(suffix,epoch):
        if rank==0:
            base=Path(args.out);base.parent.mkdir(parents=True,exist_ok=True);target=base.with_name(base.stem+suffix+'.json')
            info={'method':args.method,'seed':args.seed,'epochs':epoch+1,'updates':updates,'encoderSha256':next(iter(hashes)),
                'inputSha256':hashlib.sha256(Path(args.input).read_bytes()).hexdigest() if args.input else None,
                'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
                'worldSize':world_size,'sequence':args.sequence,'burnIn':args.burn,'bcEventWeight':args.bc_event_weight,'bcLoss':args.bc_loss,
                'encoding':model.encoding,'temperature':model.temperature,'learningRate':learning_rate,'bcMemory':'continuous episode carry','objective':'terminal MC; checkpoint before final validation'}
            sha=export(model,target,info);torch.save(optimizer.state_dict(),target.with_suffix('.optimizer.pt'));golden(model,train,target.with_suffix('.golden.json'))
            target.with_suffix('.done.json').write_text(json.dumps({'sha256':sha,'epoch':epoch+1,'updates':updates})+'\n')
        if world_size>1:dist.barrier()
    for epoch in range(epochs):
        losses=[];kls=[];count=0;epoch_start=time.monotonic();carry={}
        if args.method=='bc':
            ordered=list(train);random.shuffle(ordered);schedule=stream_batches(ordered,args.sequence,args.batch)
        else:
            random.shuffle(samples);schedule=unique_batches(samples,args.batch)
        steps=max(all_objects(len(schedule),world_size))
        for i in range(steps):
            descriptors=schedule[i] if i<len(schedule) else []
            batch=[(e,[],e['rows'][start:start+args.sequence],carry.get(e['path'],[0.]*HIDDEN) if start else [0.]*HIDDEN) for e,start in descriptors] if args.method=='bc' else descriptors
            result=objective(batch)
            if result is None:raise ValueError('Empty training block')
            loss,kl,frames,last_hidden=result
            if args.method=='bc':
                for j,(e,start) in enumerate(descriptors):carry[e['path']]=last_hidden[j].tolist()
            if not torch.isfinite(loss):raise ValueError('Nonfinite update')
            # DDP averages gradients. Scale by the actual non-padding decision count.
            total=torch.tensor(float(frames),dtype=torch.float64)
            if world_size>1:dist.all_reduce(total)
            if float(total)<=0:raise ValueError('Global empty optimization step')
            optimizer.zero_grad();(loss*(frames*world_size/float(total))).backward()
            nnorm=torch.nn.utils.clip_grad_norm_(model.parameters(),.5)
            if not torch.isfinite(nnorm):raise ValueError('Nonfinite gradient')
            optimizer.step();updates+=1;losses.append(float(loss.detach())*frames);kls.append(kl*frames);count+=frames
            if updates in args.update_checkpoints:checkpoint(f'-update-{updates}',epoch)
            if args.max_updates and updates>=args.max_updates:break
        metrics=torch.tensor([sum(losses),sum(kls),count],dtype=torch.float64)
        if world_size>1:dist.all_reduce(metrics)
        row={'epoch':epoch,'loss':float(metrics[0]/metrics[2]),'approxKL':float(metrics[1]/metrics[2]),'frames':int(metrics[2]),'seconds':time.monotonic()-epoch_start,'updates':updates};history.append(row)
        if rank==0:print(json.dumps(row),flush=True)
        if epoch+1 in args.checkpoints:
            checkpoint(f'-after-{epoch+1}',epoch)
        if args.max_updates and updates>=args.max_updates or args.method=='ppo' and row['approxKL']>.02:break
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
    metadata={'method':args.method,'seed':args.seed,'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
      'trainerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'modelCodeSha256':hashlib.sha256(Path(__file__).with_name('commander_model.py').read_bytes()).hexdigest(),
      'encoderSha256':next(iter(hashes)),'worldSize':world_size,'localBatch':args.batch,'globalBatch':args.batch*world_size,'windowCounts':window_counts,
      'padding':'Zero-loss empty ranks, no repeated training windows','bcEventWeight':args.bc_event_weight,'bcMemory':'Chronological whole episodes with detached carried hidden state',
      'bcLoss':args.bc_loss,'bcFactorNormalization':'Per frame: mean across active domains; changed factors weighted directly; one mean KEEP negative per domain; global valid-frame DDP mean',
      'encoding':model.encoding,'temperature':model.temperature,'learningRate':learning_rate,'episodeMemory':'float32 feature blocks and int32 edges; identical pack tensors','validationFraction':args.validation_fraction,'labelAdapter':'v2 confirms retyped members; v3 BC labels edit decisions from demonstrated plan changes; PPO retains recorded choices',
      'trainingEpisodes':[p for d in details for p in d['paths']],'validationEpisodes':validation,'excluded':[p for d in details for p in d['excluded']],
      'inputSha256':hashlib.sha256(Path(args.input).read_bytes()).hexdigest() if args.input else None,
      'labels':'BC uses explicit teacherAction where recorded; PPO uses executed action only',
      'history':history,'validation':metrics,'sequence':args.sequence,'burnIn':args.burn,'updates':updates,
      'objective':'terminal W=1,L/U=0; E excluded; PPO gamma1 terminal MC; prefix teacher actor steps excluded',
      'seconds':time.monotonic()-training_started,'parameters':sum(p.numel() for p in model.parameters())}
    torch.save(optimizer.state_dict(),out.with_suffix('.optimizer.pt'))
    sha=export(model,out,{k:v for k,v in metadata.items() if k not in ['trainingEpisodes','validationEpisodes','excluded','history']})
    out.with_suffix('.training.json').write_text(json.dumps(metadata,indent=2)+'\n');golden(model,train,out.with_suffix('.golden.json'))
    print(json.dumps({'sha256':sha,'parameters':metadata['parameters'],'games':len(metadata['trainingEpisodes']),'validationGames':len(validation),'updates':updates,'seconds':metadata['seconds']}),flush=True)

if __name__=='__main__':main()
