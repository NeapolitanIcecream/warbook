"""Bounded independent local task episodes; errors stay explicit and block training."""
import argparse,concurrent.futures,gzip,hashlib,json,os,random,shutil,subprocess,time
from pathlib import Path
from experiment_storage import require_batch_space

def atomic(path,value):
    tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');tmp.replace(path)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('plan');ap.add_argument('--out',required=True);args=ap.parse_args()
    plan=json.loads(Path(args.plan).read_text());out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    if (out/'batch.json').exists():raise ValueError('Use a fresh arena batch directory')
    if not 1<=plan.get('workers',16)<=128:raise ValueError('Invalid worker count')
    for spec in [*plan['subjects'].values(),*plan['opponents'].values()]:
        if spec.get('model'):spec['modelSha256']=hashlib.sha256(Path(spec['model']).read_bytes()).hexdigest()
    source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    atomic(out/'batch.json',{'git':source,'plan':plan,'startedAt':time.time(),'scope':'Native local armor task; seed is policy sampling only'})
    tasks=[(m,t,o,r,s) for m in plan['maps'] for t in plan['tanks'] for o in plan['opponents'] for r in range(plan['rounds']) for s in plan['subjects']]
    random.Random(plan.get('seed',47)).shuffle(tasks);require_batch_space(out,len(tasks),'launch',8)
    def run(task):
        m,t,o,r,s=task;directory=out/m/str(t)/o/f'{r}-{s}';directory.mkdir(parents=True)
        subject=plan['subjects'][s];opponent=plan['opponents'][o]
        cmd=[os.environ.get('WARBOOK_NODE','node'),'--env-file-if-exists=.env','--import','tsx','scripts/arena.ts','--map',m,'--tanks',str(t),'--out',str(directory),'--seed',str(plan.get('seed',47)*100000+r*13+t)]
        if subject.get('model'):cmd+=['--model',subject['model']]
        elif subject.get('teacher'):cmd+=['--teacher']
        if subject.get('deterministic'):cmd+=['--deterministic']
        if opponent.get('model'):cmd+=['--opponent-model',opponent['model']]
        else:cmd+=['--opponent',opponent['native']]
        if r%2:cmd+=['--swap']
        begin=time.monotonic();result={};error=None
        try:
            with (directory/'console.log').open('w') as f:subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=90)
            result=json.loads((directory/'result.json').read_text())
            journal=directory/'decisions.ndjson'
            with journal.open('rb') as src,gzip.open(str(journal)+'.gz','wb',compresslevel=3) as dst:shutil.copyfileobj(src,dst)
            journal.unlink()
        except Exception as e:error=str(e)
        row={'map':m,'tanks':t,'opponent':o,'repeat':r,'subject':s,'outcome':result.get('outcome','E'),'stop':result.get('stop'),'dir':str(directory),'error':error,'seconds':time.monotonic()-begin}
        atomic(directory/'batch-row.json',row);return row
    rows=[];begin=time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=plan.get('workers',16)) as ex:
        for row in ex.map(run,tasks):
            rows.append(row);counts={s:{k:sum(x['subject']==s and x['outcome']==k for x in rows) for k in ['A','B','U','E']} for s in plan['subjects']}
            atomic(out/'summary.json',{'rows':rows,'counts':counts,'completed':len(rows),'planned':len(tasks),'complete':len(rows)==len(tasks),'seconds':time.monotonic()-begin});print(json.dumps({'completed':len(rows),'counts':counts}),flush=True)
    for s in plan['subjects']:atomic(out/(s+'-episodes.json'),[x['dir'] for x in rows if x['subject']==s and x['outcome']!='E'])
    if any(x['error'] or x['outcome']=='E' for x in rows):raise RuntimeError('Arena batch contains failures; inspect before training')

if __name__=='__main__':main()
