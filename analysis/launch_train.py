"""Small shared candidate scorer: behavior cloning and bounded on-policy PPO updates.
Consumes complete-game files produced by the existing Node runner; no simulator or privileged critic.
"""
import argparse, hashlib, json, random, subprocess, sys
from pathlib import Path
import numpy as np
import torch
from torch import nn
from launch_outcome import classify
from experiment_storage import open_text

G, C, K = 116, 32, 33
SCHEMA = 'launch-v1'
CONTROL_SCOPE = None
CONTACT_INPUT = None
MANEUVER_SCOPE = None
class Policy(nn.Module):
    def __init__(self):
        super().__init__()
        self.actor = nn.Sequential(nn.Linear(G+C,128),nn.Tanh(),nn.Linear(128,128),nn.Tanh(),nn.Linear(128,1))
        self.critic = nn.Sequential(nn.Linear(G,128),nn.Tanh(),nn.Linear(128,128),nn.Tanh(),nn.Linear(128,1))
    def forward(self,g,c,mask):
        x=torch.cat((g[:,None,:].expand(-1,K,-1),c),-1)
        logits=self.actor(x).squeeze(-1).masked_fill(~mask,-1e9)
        return torch.distributions.Categorical(logits=logits), torch.sigmoid(self.critic(g).squeeze(-1))

def layers(module):
    return [dict(input=m.in_features,output=m.out_features,weights=m.weight.detach().cpu().numpy().T.reshape(-1).tolist(),bias=m.bias.detach().cpu().tolist()) for m in module if isinstance(m,nn.Linear)]
def export(model,path,version,metadata):
    artifact={'format':'warbook-launch-model-v1','schema':SCHEMA,'policyVersion':version,'actor':layers(model.actor),'critic':layers(model.critic),'training':{k:v for k,v in metadata.items() if k in ['method','seed','torch','numpy','inputSha256','architecture','objective']}}
    if CONTROL_SCOPE:artifact['controlScope']=CONTROL_SCOPE
    if CONTACT_INPUT:artifact['contactInput']=CONTACT_INPUT
    if MANEUVER_SCOPE:artifact['maneuverScope']=MANEUVER_SCOPE
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(artifact,separators=(',',':'))+'\n');tmp.replace(path)
    torch.save(model.state_dict(),path.with_suffix('.pt'))
    return hashlib.sha256(path.read_bytes()).hexdigest()
def load_artifact(model,path):
    a=json.loads(path.read_text());assert a['schema']==SCHEMA
    for net,name in [(model.actor,'actor'),(model.critic,'critic')]:
        for dst,src in zip([m for m in net if isinstance(m,nn.Linear)],a[name],strict=True):
            with torch.no_grad():
                dst.weight.copy_(torch.tensor(src['weights']).reshape(src['input'],src['output']).T)
                dst.bias.copy_(torch.tensor(src['bias']))

def write_golden(model,path,g,c,mask,act):
    # Early PPO records usually have only forced KEEP. Include real choices and
    # distinct menu sizes so parity actually checks the candidate scorer too.
    sizes=mask.sum(-1);ids=[]
    def take(indices):
        for i in indices:
            i=int(i)
            if i not in ids and len(ids)<6:ids.append(i)
    take(torch.nonzero(sizes==1).flatten()[:1])
    take(torch.nonzero((sizes>1)&(act>0)).flatten()[:1])
    for size in sorted(set(sizes.tolist()),reverse=True):
        take(torch.nonzero(sizes==size).flatten()[:1])
    take(torch.nonzero(sizes>1).flatten()[:6])
    if not any(sizes[i]>1 for i in ids):raise ValueError('Parity needs actual policy choices')
    with torch.no_grad():
        dist,val=model(g[ids],c[ids],mask[ids]);gold=[]
        for j,i in enumerate(ids):
            count=int(sizes[i]);gold.append({'global':g[i].tolist(),'candidates':c[i,:count].tolist(),'probabilities':dist.probs[j,:count].tolist(),'value':float(val[j])})
    path.write_text(json.dumps(gold))

def read_episode(directory):
    result=json.loads((directory/'result.json').read_text());manifest=json.loads((directory/'manifest.json').read_text())
    subject=next(p['name'] for p in manifest['participants'] if p['role']=='subject')
    outcome,reason,trainable=classify(result,manifest)
    if not trainable:return None
    rows=[]
    with open_text(directory/'decisions.ndjson') as journal:
        for line in journal:
            e=json.loads(line)
            if e['kind'] in ['launch_decision','operation_decision'] and e['actor']==subject: rows.append(e['record'])
    for r in rows:
        assert r['schema']==SCHEMA and len(r['global'])==G and 1<=len(r['candidates'])<=K
        assert all(len(c)==C for c in r['candidates'])
        assert 0<=r['action']<len(r['candidates']) or r['action']==-1 and r.get('executionSource')=='teacher' and r['teacherAction']==-1
        if CONTROL_SCOPE:assert r['scope']==CONTROL_SCOPE
        if CONTACT_INPUT:assert r.get('contactInput')==CONTACT_INPUT
        if MANEUVER_SCOPE:assert r.get('maneuverScope')==MANEUVER_SCOPE
    return {'path':str(directory),'outcome':outcome,'reward':float(outcome=='W'),'rows':rows,'modelSha':manifest.get('launchExperiment',{}).get('modelSha256')}

def tensors(episodes,bc):
    records=[(e,r) for e in episodes for r in e['rows'] if not bc or r['trainable'] and r['teacherAction']>=0]
    if not records:raise ValueError('No trainable launch decisions')
    n=len(records);g=np.zeros((n,G),np.float32);c=np.zeros((n,K,C),np.float32);mask=np.zeros((n,K),bool)
    action=[];returns=[];oldlog=[];oldvalue=[];valid=[]
    for i,(e,r) in enumerate(records):
        g[i]=r['global'];c[i,:len(r['candidates'])]=r['candidates'];mask[i,:len(r['candidates'])]=True
        action.append(r['teacherAction'] if bc else r['action']);returns.append(e['reward']);oldlog.append(r['logp']);oldvalue.append(r['value']);valid.append(r['trainable'])
    assert np.isfinite(g).all() and np.isfinite(c).all()
    return (torch.from_numpy(g),torch.from_numpy(c),torch.from_numpy(mask),torch.tensor(action),torch.tensor(returns),torch.tensor(oldlog),torch.tensor(oldvalue),torch.tensor(valid))

def main():
    global G,C,K,SCHEMA,CONTROL_SCOPE,CONTACT_INPUT,MANEUVER_SCOPE
    ap=argparse.ArgumentParser();ap.add_argument('method',choices=['init','bc','ppo']);ap.add_argument('--episodes');ap.add_argument('--input');ap.add_argument('--out',required=True);ap.add_argument('--seed',type=int,default=1);ap.add_argument('--epochs',type=int);ap.add_argument('--threads',type=int,default=4);ap.add_argument('--schema',choices=['launch-v1','operation-v2','operation-contact-v1']);ap.add_argument('--scope',choices=['launch','operation']);args=ap.parse_args()
    torch.set_num_threads(args.threads);torch.manual_seed(args.seed);np.random.seed(args.seed);random.seed(args.seed)
    artifact=json.loads(Path(args.input).read_text()) if args.input else {}
    first_manifest={}
    if args.episodes:
        paths=json.loads(Path(args.episodes).read_text())
        if paths:first_manifest=json.loads((Path(paths[0])/'manifest.json').read_text()).get('launchExperiment',{})
    SCHEMA=args.schema or artifact.get('schema') or first_manifest.get('schema') or 'launch-v1'
    CONTROL_SCOPE=args.scope or artifact.get('controlScope') or first_manifest.get('controlScope')
    CONTACT_INPUT=artifact.get('contactInput') or first_manifest.get('contactInput')
    MANEUVER_SCOPE=artifact.get('maneuverScope') or first_manifest.get('maneuverScope')
    if SCHEMA in ['operation-v2','operation-contact-v1']:
        if CONTROL_SCOPE not in ['launch','operation']:raise ValueError('Operation schema requires an explicit scope')
        G,C,K=(217 if SCHEMA=='operation-contact-v1' else 212),48,75
    elif CONTROL_SCOPE:raise ValueError('Control scope requires operation-v2')
    if SCHEMA=='operation-contact-v1':
        if CONTACT_INPUT not in ['local','zero']:raise ValueError('Contact schema requires local/zero input mode')
    elif CONTACT_INPUT:raise ValueError('Contact mode with non-contact schema')
    if MANEUVER_SCOPE:
        if SCHEMA!='operation-contact-v1' or CONTROL_SCOPE!='operation' or MANEUVER_SCOPE not in ['base','local']:raise ValueError('Invalid local maneuver scope')
        K=77
    model=Policy()
    if args.input:load_artifact(model,Path(args.input))
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True);metadata={'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'trainerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'python':sys.version.split()[0],'method':args.method,'seed':args.seed,'torch':torch.__version__,'numpy':np.__version__,'threads':args.threads,'objective':'formal win within 54000 ticks; W=1,L=0,tick-cap or error-free mutual-defeat U=0; E excluded and reported','schema':SCHEMA,'controlScope':CONTROL_SCOPE,'architecture':f'shared candidate scorer; global={G}, candidate={C}, maximum actions={K}'}
    if CONTACT_INPUT:metadata['contactInput']=CONTACT_INPUT
    if MANEUVER_SCOPE:metadata['maneuverScope']=MANEUVER_SCOPE
    if args.method=='init':
        print(json.dumps({'sha256':export(model,out,'launch-init',metadata),'parameters':sum(p.numel() for p in model.parameters())}));return
    paths=json.loads(Path(args.episodes).read_text());episodes=[];excluded=[]
    for path in paths:
        e=read_episode(Path(path))
        if e is None or not e['rows']:excluded.append(path)
        else:episodes.append(e)
    if args.method=='ppo':
        if not args.input:raise ValueError('PPO needs the behavior checkpoint')
        expected=hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        if any(e['modelSha']!=expected for e in episodes):raise ValueError('PPO mixed checkpoints')
    if len(episodes)<2:raise ValueError('Need complete-game groups')
    bc=args.method=='bc';random.shuffle(episodes)
    validation=episodes[-max(1,len(episodes)//5):] if bc else []
    training=episodes[:-len(validation)] if bc else episodes
    data=tensors(training,bc);g,c,mask,act,ret,oldlog,oldvalue,valid=data
    optimizer=torch.optim.Adam(model.parameters(),lr=3e-4 if bc else 1e-4)
    if not bc and args.input:
        previous_optimizer=Path(args.input).with_suffix('.optimizer.pt')
        if previous_optimizer.exists() and json.loads(Path(args.input).read_text()).get('training',{}).get('method')=='ppo':optimizer.load_state_dict(torch.load(previous_optimizer,map_location='cpu',weights_only=True))
    launch_weight=max(1.,min(8.,float((act==0).sum())/max(1,int((act>0).sum()))))
    adv=ret-oldvalue
    if not bc:
        if not valid.any():raise ValueError('Batch has no actionable policy decisions')
        mean=adv[valid].mean();std=adv[valid].std(unbiased=False).clamp_min(1e-6);adv=(adv-mean)/std
    history=[];epochs=args.epochs or (20 if bc else 3)
    for epoch in range(epochs):
        losses=[];kls=[]
        for idx in torch.randperm(len(g)).split(256):
            dist,value=model(g[idx],c[idx],mask[idx]);logp=dist.log_prob(act[idx])
            if bc:
                weight=torch.where(act[idx]>0,launch_weight,1.);policy_loss=-(logp*weight).mean();kl=0.
            else:
                active=valid[idx];ratio=(logp-oldlog[idx]).exp();a=adv[idx]
                terms=torch.maximum(-a*ratio,-a*ratio.clamp(.9,1.1))
                policy_loss=terms[active].mean() if active.any() else terms.sum()*0
                if active.any():policy_loss-=.005*dist.entropy()[active].mean()
                kl=float(((ratio-1)-(logp-oldlog[idx]))[active].mean().detach()) if active.any() else 0.
            loss=policy_loss+.5*((value-ret[idx])**2).mean()
            if not torch.isfinite(loss):raise ValueError('Nonfinite training objective')
            optimizer.zero_grad();loss.backward();nn.utils.clip_grad_norm_(model.parameters(),.5);optimizer.step();losses.append(float(loss.detach()));kls.append(kl)
        history.append({'epoch':epoch,'loss':float(np.mean(losses)),'approxKL':float(np.mean(kls))})
        if not bc and np.mean(kls)>.02:break
    validation_metrics={}
    if validation:
        vg,vc,vm,va,*_=tensors(validation,True)
        with torch.no_grad():
            pred=model(vg,vc,vm)[0].probs.argmax(-1);positive=va>0
            validation_metrics={'decisionAccuracy':float((pred==va).float().mean()),'nonKeepAccuracy':float((pred[positive]==va[positive]).float().mean()) if positive.any() else None,'predictedNonKeepFraction':float((pred>0).float().mean()),'teacherNonKeepFraction':float(positive.float().mean())}
    from collections import Counter
    metadata['teacherCoverage']=dict(Counter(r.get('teacherCoverage','legacy-projection') for e in episodes for r in e['rows']))
    metadata.update(episodes=[e['path'] for e in training],validationEpisodes=[e['path'] for e in validation],excludedEpisodes=excluded,outcomes={k:sum(e['outcome']==k for e in episodes) for k in ['W','L','U']},records=len(g),actorRecords=int(valid.sum()),history=history,validation=validation_metrics,inputSha256=hashlib.sha256(Path(args.input).read_bytes()).hexdigest() if args.input else None)
    torch.save(optimizer.state_dict(),out.with_suffix('.optimizer.pt'))
    sha=export(model,out,f'launch-{args.method}-{args.seed}',metadata)
    write_golden(model,out.with_suffix('.golden.json'),g,c,mask,act)
    out.with_suffix('.training.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps({'sha256':sha,'parameters':sum(p.numel() for p in model.parameters()),'episodes':len(episodes),'records':len(g),'validation':validation_metrics,'lastUpdate':history[-1]}))
if __name__=='__main__':main()
