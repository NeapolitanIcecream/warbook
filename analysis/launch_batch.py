"""Run a bounded/resumable matrix of independent full games on one machine.
Every child receives a fixed code/model/opponent version; no laptop RPC is involved.
"""
import argparse,concurrent.futures,hashlib,json,os,random,shutil,subprocess,time
from pathlib import Path
from launch_outcome import classify
from experiment_storage import compact_completed, require_batch_space

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def atomic(path,value):
    p=Path(path);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');tmp.replace(p)
def fresh_attempt(directory):
    """A killed runner has no row marker; never append a new game to its journal."""
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    if not any(directory.iterdir()):return directory
    attempts=directory/'attempts';attempts.mkdir(exist_ok=True)
    number=1
    while (attempts/f'{number:04d}').exists():number+=1
    attempt=attempts/f'{number:04d}';attempt.mkdir();return attempt
def stage_release(path):
    # External SDK imports must resolve to this runner's module instance. A frozen
    # bundle under another worktree otherwise fails the driver's Bot type check.
    source=Path(path).resolve();release=json.loads(source.read_text());bot=source.parent/'bot.mjs'
    if release.get('format')!='warbook-bot-v1' or digest(bot)!=release.get('sha256'):
        raise ValueError('Invalid frozen release before runtime staging')
    target=Path.cwd()/'dist/imported-bots'/digest(source);target.mkdir(parents=True,exist_ok=True)
    for original,name in [(bot,'bot.mjs'),(source,'release.json')]:
        destination=target/name
        if original==destination:continue
        tmp=target/(name+f'.{os.getpid()}.tmp');shutil.copyfile(original,tmp);tmp.replace(destination)
    return str(target/'release.json')
def main():
    ap=argparse.ArgumentParser();ap.add_argument('plan');ap.add_argument('--out',required=True);ap.add_argument('--workers',type=int);ap.add_argument('--resume',action='store_true');args=ap.parse_args()
    plan=json.loads(Path(args.plan).read_text());root=Path(args.out).resolve();root.mkdir(parents=True,exist_ok=True)
    node=os.environ.get('WARBOOK_NODE','node');commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    for s in [*plan['subjects'].values(),*plan['opponents'].values()]:
        if s.get('release'):
            s['releaseSource']=str(Path(s['release']).resolve());s['release']=stage_release(s['release'])
        for field in ['model','release']:
            if s.get(field):s[field]=str(Path(s[field]).resolve());s[field+'Sha256']=digest(s[field])
    identity={'plan':plan,'git':commit};fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest();manifest=root/'batch.json'
    if manifest.exists():
        if not args.resume or json.loads(manifest.read_text())['fingerprint']!=fingerprint:raise ValueError('Batch already exists or source/plan changed')
    else:atomic(manifest,{**identity,'fingerprint':fingerprint,'startedAt':time.time(),'slots':'alternate creation order; not seeded or controlled spawns'})
    releases={}
    for side in ['subjects','opponents']:
        for name,s in plan[side].items():
            if 'ref' not in s:continue
            key=(s['ref'],s.get('mode','bastion'))
            if key not in releases:
                out=subprocess.check_output([node,'--import','tsx','scripts/build-bot.ts','--ref',key[0],'--mode',key[1]],text=True)
                releases[key]=json.loads(out.splitlines()[-1])['path']
    tasks=[]
    for map_name in plan['maps']:
        for opponent in plan['opponents']:
            for repeat in range(plan['rounds']):
                for subject in plan['subjects']:tasks.append((map_name,opponent,repeat,subject))
    random.Random(plan.get('orderSeed',1)).shuffle(tasks)
    remaining=sum(not (root/m/o/f'{r}-{s}'/'batch-row.json').exists() for m,o,r,s in tasks)
    atomic(root/'storage-budget.json',require_batch_space(root,remaining,plan.get('trace','launch'),plan.get('storageMiBPerGame')))
    started=time.monotonic();rows=[];workers=args.workers or plan.get('workers',4)
    if workers<1 or workers>192:raise ValueError('Explicit worker bound is 1..192; calibrate CPU and memory before scaling')
    def run(task):
        map_name,opponent,repeat,subject=task;s=plan['subjects'][subject];p=plan['opponents'][opponent]
        directory=root/map_name/opponent/f'{repeat}-{subject}';directory.mkdir(parents=True,exist_ok=True)
        completed=directory/'batch-row.json'
        if completed.exists():return json.loads(completed.read_text())
        directory=fresh_attempt(directory)
        seconds=plan.get('seconds',300)
        cmd=[node,'--env-file-if-exists=.env','--import','./src/engine-diagnostics.mjs','--import','tsx','src/runner.ts','--units','0','--map',map_name,'--mode',s.get('mode','bastion'),'--out',str(directory),'--seconds',str(seconds)]
        if 'ref' in s:cmd+=['--actor-release',releases[(s['ref'],s.get('mode','bastion'))]]
        if 'release' in s:cmd+=['--actor-release',s['release']]
        if 'policy' in s:cmd+=['--launch-policy',s['policy'],'--policy-seed',str(s.get('policySeed',plan.get('policySeed',1))*100000+repeat*31+plan['maps'].index(map_name)*7+list(plan['opponents']).index(opponent))]
        if s.get('model'):cmd+=['--launch-model',s['model']]
        if s.get('scope'):cmd+=['--operation-scope',s['scope']]
        if s.get('deterministic'):cmd+=['--launch-deterministic']
        if plan.get('trace','launch')=='launch':cmd+=['--trace-level','launch']
        if 'native' in p:cmd+=['--opponent',p['native']]
        elif 'release' in p:cmd+=['--opponent-release',p['release']]
        else:cmd+=['--opponent-release',releases[(p['ref'],p.get('mode','bastion'))]]
        if repeat%2:cmd+=['--swap']
        attempt=time.monotonic();error=None;reason='execution_error';training_eligible=False
        try:
            with (directory/'console.log').open('w') as log:subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=seconds+45)
            result=json.loads((directory/'result.json').read_text());m=json.loads((directory/'manifest.json').read_text())
            status,reason,training_eligible=classify(result,m)
        except Exception as exc:error=f'{type(exc).__name__}: {exc}';result={};status='E'
        row={'map':map_name,'opponent':opponent,'repeat':repeat,'subject':subject,'outcome':status,'termination':reason,'trainingEligible':training_eligible,'tick':result.get('tick'),'seconds':time.monotonic()-attempt,'dir':str(directory),'error':error}
        if completed.parent!=directory:atomic(directory/'batch-row.json',row)
        atomic(completed,row);return row
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures=[executor.submit(run,t) for t in tasks]
        for future in concurrent.futures.as_completed(futures):
            row=future.result();rows.append(row);elapsed=time.monotonic()-started
            counts={s:{o:sum(r['subject']==s and r['outcome']==o for r in rows) for o in ['W','L','U','E']} for s in plan['subjects']}
            atomic(root/'summary.json',{'rows':rows,'counts':counts,'completed':len(rows),'planned':len(tasks),'elapsedSeconds':elapsed,'workers':workers,'complete':len(rows)==len(tasks)})
            print(json.dumps({'completed':len(rows),'planned':len(tasks),'last':row,'counts':counts}),flush=True)
    for subject in plan['subjects']:
        atomic(root/f'{subject}-episodes.json',[r['dir'] for r in rows if r['subject']==subject and r.get('trainingEligible',r['outcome']!='E')])
    print(json.dumps({'storage':compact_completed(root)}),flush=True)
    if any(r['outcome']=='E' for r in rows):raise RuntimeError('Batch includes errors; inspect them before training')
if __name__=='__main__':main()
