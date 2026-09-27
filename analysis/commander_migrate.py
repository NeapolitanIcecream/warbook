"""Change only the explicit action grammar; do not call this behavior-preserving."""
import argparse,json,hashlib,subprocess
from pathlib import Path
import torch
from commander_model import pack,pack_actions,export,HIDDEN,ENCODINGS,PRODUCTION_FAMILIES
from commander_train import load_model
from commander_sequence import canonical_action

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--out',required=True);ap.add_argument('--encoding',required=True,choices=ENCODINGS);ap.add_argument('--temperature',type=float)
    for family in PRODUCTION_FAMILIES:ap.add_argument('--'+family+'-temperature',type=float)
    args=ap.parse_args()
    overrides={family:getattr(args,family+'_temperature') for family in PRODUCTION_FAMILIES if getattr(args,family+'_temperature') is not None}
    if overrides and args.encoding!='graph-plan-v4':raise ValueError('Production temperature flags require graph-plan-v4')
    torch.set_num_threads(1);source=Path(args.input);artifact=json.loads(source.read_text());model=load_model(artifact);before=sum(p.numel() for p in model.parameters());previous_production=model.effective_production_temperatures();model.change_encoding(args.encoding)
    added=sum(p.numel() for p in model.parameters())-before
    if args.temperature is not None:model.change_temperature(args.temperature)
    if overrides:model.change_production_temperatures({**model.production_temperatures,**overrides})
    grammar=lambda encoding:'graph-plan-v2' if encoding=='graph-plan-v4' else encoding
    policy_changed=grammar(artifact['encoding'])!=grammar(args.encoding) or artifact.get('temperature',1.)!=model.temperature or previous_production!=model.effective_production_temperatures()
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True)
    sha=export(model,out,{'method':'policy-reparameterization','git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'inputSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'parentEncoding':artifact['encoding'],'parentTemperature':artifact.get('temperature',1.),'parentProductionTemperatures':artifact.get('productionTemperatures',{}),'productionTemperatures':dict(model.production_temperatures),'effectiveProductionTemperatures':model.effective_production_temperatures(),'sharedWeightsChanged':False,'parametersAdded':added,'policyChanged':policy_changed,'scope':'Grammar, edit gates or temperature can change the policy; collect fresh PPO data'})
    cases=json.loads(source.with_suffix('.golden.json').read_text());result=[]
    with torch.no_grad():
        for case in cases:
            w=case['world'];action=canonical_action(case['action'],w,args.encoding);d=pack([w],model.vocabulary);a=pack_actions([action],d);p=model(d,torch.tensor([case['hidden']]),a,True)
            probs={k:(v[0,:len(w['unitRefs'])].tolist() if k=='unit' else v[0,:len(w['buildingRefs'])].tolist() if k=='building' else v[0].tolist() if v.ndim==3 else v[:,:len(w['placementObjects'])+1].tolist() if k.startswith('place') else v.tolist()) for k,v in p['probabilities'].items()}
            result.append({'world':w,'action':action,'hidden':case['hidden'],'expected':{'logp':p['logp'].item(),'value':p['value'].item(),'hidden':p['hidden'][0].tolist(),'probabilities':probs}})
    out.with_suffix('.golden.json').write_text(json.dumps(result)+'\n');print(json.dumps({'sha256':sha,'encoding':args.encoding,'temperature':model.temperature,'productionTemperatures':model.production_temperatures,'effectiveProductionTemperatures':model.effective_production_temperatures(),'sharedWeightsChanged':False,'parametersAdded':added,'policyChanged':policy_changed}))
if __name__=='__main__':main()
