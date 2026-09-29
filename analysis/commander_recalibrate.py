"""Initialize a controlled v4 amount/cash recalibration from parent-policy targets.

This is an offline exploration initializer, not PPO or a demonstration learner.
The output B0/E0 pair requires fresh, separately collected on-policy trajectories.
"""
import argparse
import copy
import hashlib
import json
import math
import shutil
import subprocess
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from commander_model import AMOUNTS,FLOORS,pack,pack_actions,export,recorded_temperature_config,recorded_member_scoring_config
from commander_train import load_model,compact_world,golden
from experiment_storage import open_text
from launch_outcome import classify

TARGET_PARAMETERS=('queueParameter.weight','queueParameter.bias')
EPSILON=.1
STARTUP={'GAPOWR':'power','NAPOWR':'power','NANRCT':'power',
         'GAREFN':'refinery','NAREFN':'refinery','GAWEAP':'factory','NAWEAP':'factory'}


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tensor_sha(tensor):
    raw=tensor.detach().cpu().contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
    return hashlib.sha256(raw).hexdigest()


def parameter_summary(model):
    return {name:{'shape':list(value.shape),'sha256':tensor_sha(value),
                  'min':float(value.min()),'max':float(value.max()),'norm':float(value.norm())}
            for name,value in model.state_dict().items() if name in TARGET_PARAMETERS}


def select_sources(paths,fit_repeat=0,holdout_repeat=1):
    """Predeclare one whole game per cell in each split, without inspecting outcomes."""
    if fit_repeat==holdout_repeat:raise ValueError('Fit and holdout repeats must differ')
    cells=defaultdict(dict)
    for raw in paths:
        path=Path(raw).resolve();repeat=int(path.name.split('-',1)[0])
        cell=(path.parent.parent.name,path.parent.name)
        if not cell[0].endswith('.map'):raise ValueError('Expected launch_batch map/opponent/repeat directories')
        if repeat in cells[cell]:raise ValueError('Duplicate game in a source cell/repeat')
        cells[cell][repeat]=str(path)
    if len(cells)!=16 or len({m for m,_ in cells})!=4 or len({o for _,o in cells})!=4:
        raise ValueError('Expected exactly four maps by four opponent cells')
    result={'fit':[],'holdout':[]}
    for (map_name,opponent),repeats in sorted(cells.items()):
        for split,repeat in [('fit',fit_repeat),('holdout',holdout_repeat)]:
            if repeat not in repeats:raise ValueError(f'Missing predeclared repeat {repeat}: {map_name}/{opponent}')
            result[split].append({'path':repeats[repeat],'map':map_name,'opponent':opponent,'repeat':repeat})
    if {g['path'] for g in result['fit']}&{g['path'] for g in result['holdout']}:
        raise ValueError('A complete game crosses the split')
    return result


def select_set_ticks(events,maximum=8):
    first={}
    for tick,names in events:
        for name in names:
            if name in STARTUP:first.setdefault(STARTUP[name],tick)
    selected=set(first.values());ticks=[tick for tick,_ in events]
    for denominator in [4,7]:
        for numerator in range(denominator+1):
            if len(selected)>=maximum:break
            if ticks:selected.add(ticks[round((len(ticks)-1)*numerator/denominator)])
    for tick in ticks:
        if len(selected)>=maximum:break
        selected.add(tick)
    return selected


def selected_records(game,parent,parent_sha):
    path=Path(game['path']);manifest=json.loads((path/'manifest.json').read_text())
    result=json.loads((path/'result.json').read_text())
    _,reason,eligible=classify(result,manifest)
    if not eligible:raise ValueError(f'Predeclared source is not a verified complete game: {path}')
    behavior=manifest.get('commanderExperiment',{})
    expected=(parent.encoding,parent.temperature,parent.effective_production_temperatures())
    if behavior.get('modelSha256')!=parent_sha or behavior.get('deterministic'):
        raise ValueError('Sources must use the recorded stochastic parent')
    if recorded_temperature_config(behavior)!=expected:raise ValueError('Source behavior configuration mismatch')
    if recorded_member_scoring_config(behavior)!=parent.member_scoring:raise ValueError('Source member scoring mismatch')
    actor=next(p['name'] for p in manifest['participants'] if p['role']=='subject')
    def records():
        with open_text(path/'decisions.ndjson') as stream:
            for line in stream:
                if '"commander_decision"' not in line:continue
                event=json.loads(line)
                if event.get('kind')=='commander_decision' and event.get('actor')==actor:yield event['record']
    events=[];previous=None;first_tick=None;count=0
    for row in records():
        if row['schema']!='commander-v1' or row['executionSource']!='policy' or recorded_temperature_config(row)!=expected or recorded_member_scoring_config(row)!=parent.member_scoring:
            raise ValueError('Source contains a different actor, encoding or temperature')
        if previous is not None and row['tick']-previous!=75:raise ValueError('Missing strategy decision')
        previous=row['tick'];first_tick=row['tick'] if first_tick is None else first_tick;count+=1
        names=[row['world']['productNames'][a-4] for a in row['action']['queues'] if a>=4]
        if names:events.append((row['tick'],names))
    if not count or not 0<=result['tick']-previous<=75:raise ValueError('Invalid source terminal boundary')
    ticks=select_set_ticks(events)
    if not ticks:raise ValueError(f'Predeclared source has no SET conditions: {path}')
    selected=[];fixture=None
    for row in records():
        if row['tick'] in ticks or row['tick']==first_tick:
            compact_world(row['world'])
            if row['tick']==first_tick:fixture=row
            if row['tick'] in ticks:selected.append(row)
    info={**game,'runId':manifest['runId'],'selectedSetTicks':sorted(ticks),'availableSetMoments':len(events),'decisions':count,
          'manifestSha256':file_sha(path/'manifest.json'),'resultSha256':file_sha(path/'result.json'),
          'encoderSha256':manifest.get('sourceHashes',{}).get('src/commander/world.ts'),
          'completionReason':reason,'outcomeUsedForTargets':False}
    return selected,fixture,info


def parent_targets(logits,temperatures,epsilon=EPSILON):
    if not 0<epsilon<1:raise ValueError('Expected a soft-target mixing coefficient in (0,1)')
    logits=logits.detach()
    probabilities={}
    for family,part in [('amount',slice(0,5)),('cash',slice(5,11))]:
        values=logits[:,part].double()
        probabilities[family]=((values-values.max(-1,keepdim=True).values)/temperatures[family]).log_softmax(-1).exp()
    targets={family:(1-epsilon)*p+epsilon/p.shape[-1] for family,p in probabilities.items()}
    return probabilities,targets


def build_conditions(model,games,parent_sha,counterfactual_products=1):
    features=[];raw_logits=[];metadata=[];sources=[];fixture_rows=[];condition_checks=[];captured=[]
    handle=model.queueParameter.register_forward_hook(
        lambda _module,inputs,value:captured.append((inputs[0].detach().clone(),value.detach().clone())))
    try:
        for game in games:
            rows,opening,source=selected_records(game,model,parent_sha);sources.append(source)
            if len(fixture_rows)<4 and opening is not None:fixture_rows.append(opening)
            if len(condition_checks)<8:condition_checks.extend([rows[0],rows[-1]])
            for row in rows:
                w=row['world'];action=row['action'];d=pack([w],model.vocabulary)
                with torch.no_grad():
                    encoded=model.encode_world(d);hidden=torch.tensor([row['hidden']],dtype=torch.float32)
                    def extract(forced):
                        captured.clear();model(d,hidden,pack_actions([forced],d),encoded=encoded)
                        return [(x[0].clone(),z[0].clone()) for x,z in captured]
                    inputs=extract(action)
                    active=[q for q,choice in enumerate(action['queues']) if choice>=4]
                    for q in active:
                        product=action['queues'][q]-4
                        features.append(inputs[q][0]);raw_logits.append(inputs[q][1]);metadata.append({'game':game['path'],'tick':row['tick'],'queue':q,
                            'product':w['productNames'][product],'counterfactual':False})
                    # At most one extra product condition per chosen SET moment.
                    choices=[(q,i) for q in active for i,pq in enumerate(w['productQueues'])
                             if pq==q and i!=action['queues'][q]-4]
                    if counterfactual_products and choices:
                        key=f"{game['path']}:{row['tick']}".encode()
                        q,product=choices[int.from_bytes(hashlib.sha256(key).digest()[:8],'big')%len(choices)]
                        forced=copy.deepcopy(action);forced['queues'][q]=product+4
                        inputs=extract(forced)
                        features.append(inputs[q][0]);raw_logits.append(inputs[q][1]);metadata.append({'game':game['path'],'tick':row['tick'],'queue':q,
                            'product':w['productNames'][product],'counterfactual':True})
            if len(fixture_rows)<8:fixture_rows.append(rows[-1])
    finally:handle.remove()
    x=torch.stack(features);z=torch.stack(raw_logits)
    # Use the logits from each actual conditional forward, not a later batched
    # GEMM whose last-bit rounding can differ at very low parent temperatures.
    with torch.no_grad():probabilities,targets=parent_targets(z,model.effective_production_temperatures())
    return {'x':x,'parentProbabilities':probabilities,'targets':targets,'conditions':metadata,'sources':sources,
            'fixtures':fixture_rows,'checks':condition_checks,'parentRawLogits':z}


def fit_parameter_head(parent_layer,x,targets,amount_scale=3.55,cash_scale=3.46,max_iterations=100):
    if any(not math.isfinite(s) or s<=0 for s in [amount_scale,cash_scale]):raise ValueError('Invalid initial row scale')
    layer=copy.deepcopy(parent_layer).double()
    with torch.no_grad():
        layer.weight[:5].div_(amount_scale);layer.bias[:5].div_(amount_scale)
        layer.weight[5:].div_(cash_scale);layer.bias[5:].div_(cash_scale)
    # Center fixed inputs so a constant soft target is fitted through the bias,
    # rather than an arbitrary training-feature direction. This is an invertible
    # fit-only parameterization; convert the bias back before exporting.
    x=x.double();center=x.mean(0)
    with torch.no_grad():layer.bias.add_(layer.weight@center)
    x=x-center;targets={key:value.double() for key,value in targets.items()}
    def loss_value():
        z=layer(x)
        return sum(-(targets[key]*z[:,part].log_softmax(-1)).sum(-1).mean()
                   for key,part in [('amount',slice(0,5)),('cash',slice(5,11))])/2
    initial=float(loss_value().detach());calls=0
    optimizer=torch.optim.LBFGS(layer.parameters(),lr=1.,max_iter=max_iterations,max_eval=max_iterations*2,
        history_size=20,tolerance_grad=1e-9,tolerance_change=1e-12,line_search_fn='strong_wolfe')
    def closure():
        nonlocal calls
        optimizer.zero_grad();loss=loss_value()
        if not torch.isfinite(loss):raise ValueError('Nonfinite calibration loss')
        loss.backward();calls+=1
        if any(p.grad is None or not torch.isfinite(p.grad).all() for p in layer.parameters()):raise ValueError('Nonfinite calibration gradient')
        return loss
    started=time.monotonic();optimizer.step(closure)
    if any(not torch.isfinite(p).all() for p in layer.parameters()):raise ValueError('Nonfinite calibrated parameters')
    final_loss=float(loss_value().detach())
    with torch.no_grad():layer.bias.sub_(layer.weight@center)
    result={name:tensor.detach().to(parent_layer.weight.dtype) for name,tensor in layer.state_dict().items()}
    return result,{'optimizer':'LBFGS; calibration state discarded','maxIterations':max_iterations,
        'iterations':int(optimizer.state[next(iter(layer.parameters()))].get('n_iter',0)),
        'closureCalls':calls,'initialLoss':initial,'finalLoss':final_loss,'seconds':time.monotonic()-started,
        'parameterization':'Centered fixed inputs; exported bias converted back to original input coordinates','featureCenterSha256':tensor_sha(center),
        'initialRowDivisors':{'amount':amount_scale,'cash':cash_scale},'fitTemperature':1.}


def distribution_report(layer,data):
    if not len(data['x']):return {family:{'conditions':0} for family in ['amount','cash']}
    with torch.no_grad():z=layer(data['x']).double()
    result={}
    for family,part,values in [('amount',slice(0,5),AMOUNTS),('cash',slice(5,11),FLOORS)]:
        logs=z[:,part].log_softmax(-1);p=logs.exp();parent=data['parentProbabilities'][family];old_mode=parent.argmax(-1)
        alternatives=1-p.gather(1,old_mode[:,None]).squeeze(1)
        per_value=[]
        for j,value in enumerate(values):
            selected=p[old_mode!=j,j]
            per_value.append({'value':value,'meanProbability':float(p[:,j].mean()),'minimumProbability':float(p[:,j].min()),
                'alternativeConditions':len(selected),'alternativeMean':float(selected.mean()) if len(selected) else None,
                'alternativeMinimum':float(selected.min()) if len(selected) else None,
                'alternativeFractionAbove001':float((selected>=.01).double().mean()) if len(selected) else None})
        result[family]={'conditions':len(p),'parentArgmaxPreservation':float((p.argmax(-1)==old_mode).double().mean()),
            'parentAlternativeMean':float(alternatives.mean()),'parentAlternativeP10':float(torch.quantile(alternatives,.1)),
            'parentAlternativeP90':float(torch.quantile(alternatives,.9)),'parentAlternativeMinimum':float(alternatives.min()),
            'parentAlternativeMaximum':float(alternatives.max()),'meanWithinDevelopmentRange':.05<=float(alternatives.mean())<=.1,
            'softTargetKL':float((data['targets'][family]*(data['targets'][family].log()-logs)).sum(-1).mean()),'values':per_value}
    return result


def condition_subset(data,counterfactual):
    indices=[i for i,condition in enumerate(data['conditions']) if condition['counterfactual']==counterfactual]
    return {'x':data['x'][indices],
            'parentProbabilities':{key:p[indices] for key,p in data['parentProbabilities'].items()},
            'targets':{key:q[indices] for key,q in data['targets'].items()}}


def reset_head_adam(model,state):
    """Reset identical full output tensors in B0/E0; preserve every other state."""
    result=copy.deepcopy(state);named=list(model.named_parameters())
    groups=result.get('param_groups',[]);ids=[key for group in groups for key in group['params']]
    if len(groups)!=1 or len(ids)!=len(named) or len(set(ids))!=len(ids) or any('betas' not in group for group in groups):
        raise ValueError('Expected parent Adam parameter ordering from model.parameters()')
    reset=[]
    for key,(name,parameter) in zip(ids,named):
        entry=result['state'].get(key,{})
        for field in ['exp_avg','exp_avg_sq','max_exp_avg_sq']:
            if field in entry and entry[field].shape!=parameter.shape:raise ValueError('Parent Adam tensor shape/order mismatch')
        if name in TARGET_PARAMETERS:result['state'].pop(key,None);reset.append({'name':name,'stateId':key})
    if {r['name'] for r in reset}!=set(TARGET_PARAMETERS):raise ValueError('Missing output parameters')
    for key in state['state']:
        if key in {r['stateId'] for r in reset}:continue
        before,after=state['state'][key],result['state'][key]
        if before.keys()!=after.keys():raise ValueError('Non-target Adam state keys changed')
        for field,value in before.items():
            equal=torch.equal(value,after[field]) if torch.is_tensor(value) else value==after[field]
            if not equal:raise ValueError('Non-target Adam state changed')
    return result,{'reset':reset,'resetSemantics':'Remove only these two Adam state entries; their next step lazily starts at zero',
                   'allOtherStatesTensorEqual':True,'parameterGroupsCopied':True}


def assert_frozen(parent,candidate,allowed=TARGET_PARAMETERS):
    a=parent.state_dict();b=candidate.state_dict()
    if a.keys()!=b.keys():raise ValueError('Initializer changed parameter names')
    changed=[name for name in a if not torch.equal(a[name],b[name])]
    if set(changed)-set(allowed):raise ValueError('Initializer changed frozen parameters')
    return changed


def gradient_contract(layer,x):
    """A throwaway PPO-sign test, never an update to the exported initializer."""
    results={};original={name:value.detach().clone() for name,value in layer.state_dict().items()}
    for family,part in [('amount',slice(0,5)),('cash',slice(5,11))]:
        with torch.no_grad():before=layer(x[None])[0,part].double().softmax(-1)
        selected=(int(before.argmax())+1)%len(before);checks=[]
        for advantage in [1.,-1.]:
            probe=copy.deepcopy(layer);optimizer=torch.optim.SGD(probe.parameters(),lr=1e-3)
            logp=probe(x[None])[0,part].double().log_softmax(-1)[selected]
            ratio=(logp-logp.detach()).exp()
            loss=torch.maximum(-advantage*ratio,-advantage*ratio.clamp(.9,1.1))
            loss.backward()
            gradients=[p.grad for p in probe.parameters()]
            if any(g is None or not torch.isfinite(g).all() for g in gradients):raise ValueError('Nonfinite sign-probe gradient')
            norm=float(torch.sqrt(sum(g.double().square().sum() for g in gradients)))
            optimizer.step()
            with torch.no_grad():after=float(probe(x[None])[0,part].double().softmax(-1)[selected])
            if not norm>0 or not (after-float(before[selected]))*advantage>0:raise ValueError('Alternative probability did not follow test advantage')
            checks.append({'advantage':advantage,'before':float(before[selected]),'after':after,'gradientNorm':norm})
        results[family]={'alternativeIndex':selected,'checks':checks}
    if any(not torch.equal(value,layer.state_dict()[name]) for name,value in original.items()):raise ValueError('Sign probe modified E0')
    return results


def check_other_heads(parent,baseline,explorer,records):
    maximum=0.
    with torch.no_grad():
        for row in records:
            d=pack([row['world']],parent.vocabulary);a=pack_actions([row['action']],d)
            hidden=torch.tensor([row['hidden']],dtype=torch.float32)
            p=parent(d,hidden,a,True);b=baseline(d,hidden,a,True);e=explorer(d,hidden,a,True)
            if not torch.equal(p['logp'],b['logp']):raise ValueError('B0 changed the parent distribution')
            for key in ['hidden','value']:
                if not torch.equal(p[key],e[key]):raise ValueError('A frozen state/value output changed')
            for name,probability in p['probabilities'].items():
                if name.startswith(('amount','cash')):continue
                delta=float((probability-e['probabilities'][name]).abs().max());maximum=max(maximum,delta)
                if delta!=0:raise ValueError('A non-target conditional distribution changed')
    return {'states':len(records),'maximumNonTargetProbabilityDifference':maximum,'baselineJointLogpEqual':True,
            'scope':'Recorded hidden and forced full action prefix; free decoding and gameplay can change'}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--input',required=True);ap.add_argument('--optimizer');ap.add_argument('--episodes',required=True);ap.add_argument('--out',required=True)
    ap.add_argument('--fit-repeat',type=int,default=0);ap.add_argument('--holdout-repeat',type=int,default=1)
    ap.add_argument('--amount-scale',type=float,default=3.55);ap.add_argument('--cash-scale',type=float,default=3.46)
    ap.add_argument('--max-iterations',type=int,default=100);ap.add_argument('--counterfactual-products',type=int,choices=[0,1],default=1)
    args=ap.parse_args()
    if args.max_iterations<1:raise ValueError('Expected a positive fit iteration cap')
    torch.set_num_threads(1);torch.set_num_interop_threads(1);torch.manual_seed(0)
    started=time.monotonic();source=Path(args.input).resolve();parent_sha=file_sha(source)
    parent=load_model(json.loads(source.read_text()))
    if parent.encoding not in ['graph-plan-v2','graph-plan-v4'] or any(t!=parent.temperature for t in parent.effective_production_temperatures().values()):
        raise ValueError('This first controlled initializer requires a v2-equivalent parent with all heads at base temperature')
    optimizer_source=Path(args.optimizer).resolve() if args.optimizer else source.with_suffix('.optimizer.pt')
    if not optimizer_source.exists():raise ValueError('The parent Adam state is required for the matched B0/E0 reset')
    sources=select_sources(json.loads(Path(args.episodes).read_text()),args.fit_repeat,args.holdout_repeat)
    out=Path(args.out).resolve()
    if out.exists():raise ValueError('Use a new initializer output directory')
    out.mkdir(parents=True)
    source_plan={'parent':str(source),'parentSha256':parent_sha,'episodesFileSha256':file_sha(args.episodes),'sources':sources,
        'fitRepeat':args.fit_repeat,'holdoutRepeat':args.holdout_repeat,'maxSetMomentsPerGame':8,
        'selection':'First power/refinery/factory SETs plus time-spread SET moments; no outcome selection',
        'counterfactualProductsPerMoment':args.counterfactual_products,'counterfactualSelection':'SHA256(game path:tick) modulo legal alternate (queue,product) conditions',
        'epsilon':EPSILON,'target':'0.9 parent-policy distribution + 0.1 uniform over original legal amount/cash values',
        'holdoutScope':'Whole games excluded from this recalibration fit; parent policy may have previously trained on these sources'}
    (out/'source-plan.json').write_text(json.dumps(source_plan,indent=2)+'\n')
    data={split:build_conditions(parent,games,parent_sha,args.counterfactual_products) for split,games in sources.items()}
    if {s['runId'] for s in data['fit']['sources']}&{s['runId'] for s in data['holdout']['sources']}:
        raise ValueError('The same complete-game runId crosses the calibration split')
    encoder_hashes={s['encoderSha256'] for d in data.values() for s in d['sources']}
    if len(encoder_hashes)!=1 or None in encoder_hashes:raise ValueError('Mixed/unrecorded source encoder')
    baseline=copy.deepcopy(parent);baseline.change_encoding('graph-plan-v4');baseline.change_production_temperatures({})
    explorer=copy.deepcopy(baseline);explorer.change_production_temperatures({'amount':1.,'cash':1.})
    fitted,fit=fit_parameter_head(parent.queueParameter,data['fit']['x'],data['fit']['targets'],args.amount_scale,args.cash_scale,args.max_iterations)
    explorer.queueParameter.load_state_dict(fitted)
    assert_frozen(parent,baseline,());changed=assert_frozen(parent,explorer)
    state=torch.load(optimizer_source,weights_only=True,map_location='cpu')
    reset_state,reset=reset_head_adam(parent,state)
    torch.save(reset_state,out/'B0.optimizer.pt');shutil.copyfile(out/'B0.optimizer.pt',out/'E0.optimizer.pt')
    coverage={split:distribution_report(explorer.queueParameter,d) for split,d in data.items()}
    actual_coverage={split:distribution_report(explorer.queueParameter,condition_subset(d,False)) for split,d in data.items()}
    probe_coverage={split:distribution_report(explorer.queueParameter,condition_subset(d,True)) for split,d in data.items()}
    contracts=gradient_contract(explorer.queueParameter,data['holdout']['x'][0])
    parity=check_other_heads(parent,baseline,explorer,data['holdout']['checks'])
    provenance={**source_plan,'method':'parent-policy amount/cash soft-target recalibration','git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
        'generatorSha256':file_sha(__file__),'modelCodeSha256':file_sha(Path(__file__).with_name('commander_model.py')),
        'encoderSha256':next(iter(encoder_hashes)),'torchVersion':torch.__version__,'numpyVersion':np.__version__,
        'parentOptimizerSha256':file_sha(optimizer_source),'initializerOptimizerSha256':file_sha(out/'B0.optimizer.pt'),
        'optimizerReset':reset,'changedParameterNames':changed,'allNonTargetTensorsIdentical':True,
        'parametersBefore':parameter_summary(parent),'parametersAfter':parameter_summary(explorer),'fit':fit,
        'requiresFreshOnPolicyRollouts':True,'calibrationOptimizerTransferred':False,'gameOutcomesOrTeacherActionsUsedAsTargets':False}
    artifacts={}
    for name,model in [('B0',baseline),('E0',explorer)]:
        target=out/(name+'.json');sha=export(model,target,{**provenance,'initializer':name,
            'policyChanged':name=='E0','productionTemperatures':model.effective_production_temperatures(),
            'changedParameterNames':[] if name=='B0' else changed,'parametersAfter':parameter_summary(model)})
        golden(model,[{'rows':data['holdout']['fixtures']}],target.with_suffix('.golden.json'))
        target.with_suffix('.done.json').write_text(json.dumps({'sha256':sha,'initializer':name,'ppoUpdates':0})+'\n')
        artifacts[name]={'model':str(target),'sha256':sha,'optimizerSha256':file_sha(target.with_suffix('.optimizer.pt'))}
    report={**provenance,'artifacts':artifacts,'coverage':coverage,'actualSetCoverage':actual_coverage,
        'counterfactualCoverage':probe_coverage,'gradientContract':contracts,'conditionalParity':parity,
        'data':{split:{'sources':d['sources'],'conditions':d['conditions'],'featureSha256':tensor_sha(d['x']),
            'parentRawLogitSha256':tensor_sha(d['parentRawLogits']),
            'targetSha256':{family:tensor_sha(q) for family,q in d['targets'].items()}} for split,d in data.items()},
        'seconds':time.monotonic()-started}
    (out/'calibration.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'artifacts':artifacts,'fit':fit,'holdoutCoverage':coverage['holdout'],
                      'holdoutActualSetCoverage':actual_coverage['holdout'],'conditionalParity':parity,
                      'seconds':report['seconds']}),flush=True)


if __name__=='__main__':main()
