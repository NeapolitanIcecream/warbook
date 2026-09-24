"""BC/PPO for local armor tasks. Local returns never masquerade as whole-game wins."""
import argparse,json,random,time,hashlib,subprocess
from experiment_storage import open_text
from pathlib import Path
import numpy as np
import torch
from tactical_model import TacticalModel,pack,load,export

def read_episode(path):
    path=Path(path);result=json.loads((path/'result.json').read_text())
    if result['protocol']!='api-shroud-local-arena-v1' or result['stop'] not in ['task-elimination','task-boundary','time-limit']:raise ValueError('Invalid arena task')
    stream=open_text(path/'decisions.ndjson')
    with stream:rows=[r['record'] for line in stream if (r:=json.loads(line))['side']==0 and r.get('record',{}).get('schema')=='armor-skill-v1']
    return {'path':str(path),'rows':rows,'reward':float(result['outcome']=='A'),'modelSha':result.get('actorModelSha256')}

def predict(model,rows):
    d=pack([r['world'] for r in rows]);a=torch.zeros(d['units'].shape,dtype=torch.long)
    for i,r in enumerate(rows):a[i,:len(r['choices'])]=torch.tensor(r['choices'])
    return model(d,a),d

def main():
    ap=argparse.ArgumentParser();ap.add_argument('method',choices=['bc','ppo']);ap.add_argument('--episodes',required=True);ap.add_argument('--out',required=True);ap.add_argument('--input');ap.add_argument('--seed',type=int,default=47);ap.add_argument('--epochs',type=int);ap.add_argument('--batch',type=int,default=64);ap.add_argument('--threads',type=int,default=1);args=ap.parse_args()
    torch.set_num_threads(args.threads);torch.manual_seed(args.seed);random.seed(args.seed);np.random.seed(args.seed);begin=time.monotonic()
    paths=json.loads(Path(args.episodes).read_text());random.shuffle(paths)
    n=max(1,len(paths)//5) if args.method=='bc' else 0
    train=[read_episode(p) for p in (paths[:-n] if n else paths)];validation=[read_episode(p) for p in paths[-n:]] if n else []
    rows=[{**r,'return':e['reward']} for e in train for r in e['rows']]
    if not rows:raise ValueError('No training rows')
    model=load(Path(args.input)) if args.input else TacticalModel()
    if args.method=='ppo':
        if not args.input:raise ValueError('PPO requires behavior model')
        sha=hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        if any(e['modelSha']!=sha for e in train) or any(r['executionSource']!='policy' for r in rows):raise ValueError('Mixed behavior')
        adv=np.asarray([r['return']-r['value'] for r in rows]);mean=float(adv.mean());std=max(1e-6,float(adv.std()))
        for r in rows:r['advantage']=(r['return']-r['value']-mean)/std
    optimizer=torch.optim.Adam(model.parameters(),lr=3e-4 if args.method=='bc' else 1e-4)
    if args.method=='ppo' and Path(args.input).with_suffix('.optimizer.pt').exists():optimizer.load_state_dict(torch.load(Path(args.input).with_suffix('.optimizer.pt'),weights_only=True,map_location='cpu'))
    for group in optimizer.param_groups:group['lr']=3e-4 if args.method=='bc' else 1e-4
    history=[]
    for epoch in range(args.epochs or (12 if args.method=='bc' else 3)):
        random.shuffle(rows);losses=[];kls=[]
        for start in range(0,len(rows),args.batch):
            batch=rows[start:start+args.batch];p,_=predict(model,batch);returns=torch.tensor([r['return'] for r in batch])
            if args.method=='bc':actor=p['bc'].mean();kl=torch.tensor(0.)
            else:
                old=torch.tensor([r['logp'] for r in batch]);delta=p['logp']-old;ratio=delta.exp();adv=torch.tensor([r['advantage'] for r in batch])
                actor=torch.maximum(-adv*ratio,-adv*ratio.clamp(.9,1.1)).mean()-.003*p['entropy'].mean();kl=((ratio-1)-delta).mean().detach()
            loss=actor+.5*((p['value']-returns)**2).mean()
            if not torch.isfinite(loss):raise ValueError('Nonfinite tactical loss')
            optimizer.zero_grad();loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),.5);optimizer.step()
            losses.append(float(loss.detach()));kls.append(float(kl))
        metrics={'epoch':epoch,'loss':float(np.mean(losses)),'approxKL':float(np.mean(kls))};history.append(metrics);print(json.dumps(metrics),flush=True)
        if args.method=='ppo' and metrics['approxKL']>.02:break
    with torch.no_grad():
        losses=[];correct=total=0
        for e in validation:
            for start in range(0,len(e['rows']),args.batch):
                batch=e['rows'][start:start+args.batch];p,d=predict(model,batch);losses+=p['bc'].tolist();greedy=p['probabilities'].argmax(-1)
                for i,r in enumerate(batch):correct+=sum(int(greedy[i,j])==a for j,a in enumerate(r['choices']));total+=len(r['choices'])
        metrics={'bcLoss':float(np.mean(losses)) if losses else None,'commandAccuracy':correct/max(1,total),'commands':total,'scope':'Whole-episode held-out teacher labels; not task or full-game strength'}
        gold=[]
        for r in rows[:4]:
            p,_=predict(model,[r]);w=r['world'];gold.append({'world':w,'choices':r['choices'],'expected':{'logp':float(p['logp'][0]),'value':float(p['value'][0]),'probabilities':[p['probabilities'][0,i,:len(c)].tolist() for i,c in enumerate(w['candidates'])]}})
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
    meta={'method':args.method,'seed':args.seed,'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'parameters':sum(p.numel() for p in model.parameters()),'trainingEpisodes':[e['path'] for e in train],'validationEpisodes':[e['path'] for e in validation],'history':history,'validation':metrics,'seconds':time.monotonic()-begin,'objective':'Local armor task A=1, B/U=0; no whole-game win claim',
      'inputSha256':hashlib.sha256(Path(args.input).read_bytes()).hexdigest() if args.input else None,
      'trainerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'modelCodeSha256':hashlib.sha256(Path(__file__).with_name('tactical_model.py').read_bytes()).hexdigest(),'learningRate':optimizer.param_groups[0]['lr']}
    sha=export(model,out,{k:v for k,v in meta.items() if k not in ['trainingEpisodes','validationEpisodes','history']});torch.save(optimizer.state_dict(),out.with_suffix('.optimizer.pt'));out.with_suffix('.training.json').write_text(json.dumps(meta,indent=2)+'\n');out.with_suffix('.golden.json').write_text(json.dumps(gold)+'\n');print(json.dumps({'sha256':sha,**metrics,'seconds':meta['seconds'],'parameters':meta['parameters']}))

if __name__=='__main__':main()
