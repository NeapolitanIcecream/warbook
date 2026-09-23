"""Change only the explicit action grammar; do not call this behavior-preserving."""
import argparse,json,hashlib,subprocess
from pathlib import Path
import torch
from commander_model import pack,pack_actions,export,HIDDEN
from commander_train import load_model
from commander_sequence import canonical_action

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--out',required=True);ap.add_argument('--encoding',required=True,choices=['graph-plan-v1','graph-plan-v2']);args=ap.parse_args()
    torch.set_num_threads(1);source=Path(args.input);artifact=json.loads(source.read_text());model=load_model(artifact);model.encoding=args.encoding
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
    sha=export(model,out,{'method':'action-grammar-migration','git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'inputSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'parentEncoding':artifact['encoding'],'weightsChanged':False,'policyChanged':artifact['encoding']!=args.encoding,'scope':'New action masks change the policy; collect fresh PPO data'})
    cases=json.loads(source.with_suffix('.golden.json').read_text());result=[]
    with torch.no_grad():
        for case in cases:
            w=case['world'];action=canonical_action(case['action'],w,args.encoding);d=pack([w],model.vocabulary);a=pack_actions([action],d);p=model(d,torch.tensor([case['hidden']]),a,True)
            probs={k:(v[0,:len(w['unitRefs'])].tolist() if k=='unit' else v[0,:len(w['buildingRefs'])].tolist() if k=='building' else v[0].tolist() if v.ndim==3 else v[:,:len(w['placementObjects'])+1].tolist() if k.startswith('place') else v.tolist()) for k,v in p['probabilities'].items()}
            result.append({'world':w,'action':action,'hidden':case['hidden'],'expected':{'logp':p['logp'].item(),'value':p['value'].item(),'hidden':p['hidden'][0].tolist(),'probabilities':probs}})
    out.with_suffix('.golden.json').write_text(json.dumps(result)+'\n');print(json.dumps({'sha256':sha,'encoding':args.encoding,'weightsChanged':False,'policyChanged':artifact['encoding']!=args.encoding}))
if __name__=='__main__':main()
