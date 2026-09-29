"""Zero-update R/M/I member-scoring initialization and one scalar KEEP match.

Calibration uses the predeclared C0 panel, actual upstream action prefixes and
continuous actual-world history. No outcome, controller or optimizer is used.
"""
import argparse
import copy
import hashlib
import json
import math
import platform
import shutil
import subprocess
import time
from collections import defaultdict
from pathlib import Path

import torch

from commander_model import export,member_keep_eligible
from commander_parameter_probe import prepare_panel,write_golden
from commander_train import load_model

R_SCORING={'mode':'separate-v1'}
M_SCORING={'mode':'current-task-keep-v1'}
FIT_TOLERANCE=1e-10
MAX_BISECTION_STEPS=80


def file_sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def keep_log_odds(log_probabilities,keep_index=18):
    """KEEP versus all other legal categories, without log(rounded probability)."""
    logs=torch.as_tensor(log_probabilities,dtype=torch.float64)
    if logs.ndim<1 or not 0<=keep_index<logs.shape[-1] or logs.shape[-1]<2:
        raise ValueError('Expected KEEP and at least one other category')
    other=torch.cat((logs[...,:keep_index],logs[...,keep_index+1:]),-1)
    odds=logs[...,keep_index]-torch.logsumexp(other,-1)
    if not torch.isfinite(odds).all():raise ValueError('Nonfinite eligible KEEP log-odds')
    return odds


def weighted_panel(frames):
    """Equal source -> equal nonempty frame -> equal eligible unit weighting."""
    grouped=defaultdict(list)
    for frame in frames:
        r=torch.as_tensor(frame['rLogOdds'],dtype=torch.float64).reshape(-1)
        m=torch.as_tensor(frame['mLogOdds'],dtype=torch.float64).reshape(-1)
        if r.shape!=m.shape or not torch.isfinite(r).all() or not torch.isfinite(m).all():
            raise ValueError('Invalid paired KEEP log-odds')
        if (m<r-1e-9).any():raise ValueError('M reduced KEEP on an eligible row')
        grouped[frame['source']].append((r,m))
    usable={source:[pair for pair in pairs if pair[0].numel()] for source,pairs in grouped.items()}
    eligible_sources=sum(bool(pairs) for pairs in usable.values())
    if not eligible_sources:raise ValueError('Calibration panel has no eligible member rows')
    baseline=[];merged=[];weights=[]
    for pairs in usable.values():
        for r,m in pairs:
            baseline.append(r);merged.append(m)
            weights.append(torch.full_like(r,1/(eligible_sources*len(pairs)*len(r))))
    counts={'sources':len(grouped),'eligibleSources':eligible_sources,
            'zeroEligibleSources':[source for source,pairs in usable.items() if not pairs],
            'frames':len(frames),'eligibleFrames':sum(len(pairs) for pairs in usable.values()),
            'zeroEligibleFrames':sum(not r.numel() for pairs in grouped.values() for r,_ in pairs),
            'eligibleUnits':sum(r.numel() for pairs in usable.values() for r,_ in pairs),
            'sourcesDetail':{source:{'frames':len(grouped[source]),'eligibleFrames':len(pairs),
                                    'zeroEligibleFrames':len(grouped[source])-len(pairs),
                                    'eligibleUnits':sum(r.numel() for r,_ in pairs)} for source,pairs in usable.items()}}
    return torch.cat(baseline),torch.cat(merged),torch.cat(weights),counts


def mean_keep(log_odds,weights,bias=0.):
    if not math.isfinite(bias) or bias<0:raise ValueError('KEEP bias must be finite and nonnegative')
    return float((torch.sigmoid(log_odds+bias)*weights).sum())


def fit_keep_bias(frames):
    baseline,merged,weights,counts=weighted_panel(frames)
    before=mean_keep(baseline,weights);target=mean_keep(merged,weights)
    offset=(merged-baseline).clamp_min(0)
    upper=max(1.,float(offset.max()))
    if not math.isfinite(upper):raise ValueError('No finite KEEP-bias calibration bracket')
    if mean_keep(baseline,weights,upper)+FIT_TOLERANCE<target:
        raise ValueError('M target lies outside the derived finite bias bracket')
    lower=0.;bound=upper;bias=0.;achieved=before;iterations=0
    if abs(target-before)>FIT_TOLERANCE:
        for iterations in range(1,MAX_BISECTION_STEPS+1):
            bias=lower+(upper-lower)/2;achieved=mean_keep(baseline,weights,bias)
            if abs(achieved-target)<=FIT_TOLERANCE:break
            if achieved<target:lower=bias
            else:upper=bias
    if abs(achieved-target)>FIT_TOLERANCE:raise ValueError('Bounded KEEP calibration did not meet tolerance')
    return {'bias':bias,'baselineMeanKeep':before,'mergedMeanKeep':target,'inertiaMeanKeep':achieved,
            'mergedMeanIncrement':target-before,'inertiaMeanIncrement':achieved-before,
            'absoluteMeanError':abs(achieved-target),'initialBracket':[0.,bound],
            'bracketDefinition':'Maximum eligible per-row M minus R KEEP log-odds shift, at least 1; its biased KEEP probability dominates M rowwise.',
            'bisectionSteps':iterations,'maximumBisectionSteps':MAX_BISECTION_STEPS,'tolerance':FIT_TOLERANCE,
            'weighting':'Mean eligible units per frame, then mean eligible frames per source, then equal mean over sources with eligibility; empty frames/sources excluded and counted.',
            'counts':counts}


def tensors_identical(left,right):
    a=left.state_dict();b=right.state_dict()
    return a.keys()==b.keys() and all(torch.equal(value,b[key]) for key,value in a.items())


@torch.no_grad()
def member_frame(base,candidate,case):
    prediction=candidate(case['data'],case['hidden'],case['packedAction'],encoded=case['encoded'],return_conditionals=True)
    reference=case['baseline']
    if not torch.equal(prediction['hidden'],reference['hidden']) or not torch.equal(prediction['value'],reference['value']):
        raise ValueError('Member scoring changed the frozen world recurrence/value')
    for name,term in reference['conditionals'].items():
        current=prediction['conditionals'][name]
        if not torch.equal(term['mask'],current['mask']):raise ValueError('Member scoring changed legality')
        if name!='unit' and not torch.equal(term['log_probabilities'],current['log_probabilities']):
            raise ValueError('Member scoring changed another conditional head')
    data=case['data'];action=case['packedAction']
    actual_kind=torch.where(action['kinds']==0,data['previousKind'],action['kinds'])
    eligible=member_keep_eligible(data,actual_kind,reference['conditionals']['unit']['mask'])
    r=reference['conditionals']['unit']['log_probabilities'];current=prediction['conditionals']['unit']['log_probabilities']
    torch.testing.assert_close(r[~eligible],current[~eligible],rtol=1e-12,atol=1e-12)
    previous=data['previousRole'];slot=previous.clamp(0,15)
    retyped=data['unitIndexMask']&(previous>=0)&(previous<16)&(data['previousKind'].gather(1,slot)!=actual_kind.gather(1,slot))
    return {'source':case['source'],'map':case['map'],'opponent':case['opponent'],'tick':case['tick'],
            'rowIndex':case['rowIndex'],'phase':case['phase'],'adjacent':case['adjacent'],
            'actualUnits':int(data['unitIndexMask'].sum()),'eligibleUnits':int(eligible.sum()),
            'retypedUnits':int(retyped.sum()),'rLogOdds':keep_log_odds(r[eligible]),
            'mLogOdds':keep_log_odds(current[eligible])}


def golden_cases(cases,frames):
    """Small deterministic QA set: eligibility, retyping when present, and padding."""
    eligible=[i for i,frame in enumerate(frames) if frame['eligibleUnits']]
    retyped=[i for i,frame in enumerate(frames) if frame['retypedUnits']]
    choices=[eligible[0],*(retyped[:1]),0,max(range(len(frames)),key=lambda i:frames[i]['eligibleUnits']),eligible[-1],len(cases)-1]
    selected=[]
    for index in choices:
        if index not in selected:selected.append(index)
        if len(selected)==4:break
    return [cases[index] for index in selected],[{key:frames[index][key] for key in ['source','rowIndex','tick','eligibleUnits','retypedUnits']} for index in selected]


def source_identity(sources):
    result=[]
    for original in sources:
        entry=dict(original);path=Path(entry['path']);archive=path/'decisions.ndjson.archive.json'
        if archive.exists():entry['journalArchiveReceiptSha256']=file_sha(archive)
        result.append(entry)
    return result


@torch.no_grad()
def initialize(input_path,episode_list,out,optimizer_path=None,exclude_sources=()):
    started=time.monotonic();cpu=time.process_time();parent=Path(input_path).resolve();out=Path(out).resolve()
    if out.exists():raise ValueError('Use a fresh output directory')
    optimizer=Path(optimizer_path).resolve() if optimizer_path else parent.with_suffix('.optimizer.pt')
    if not optimizer.is_file():raise ValueError('C0 requires its paired Adam file')
    artifact=json.loads(parent.read_text());base=load_model(artifact).eval()
    if base.encoding!='graph-plan-v4' or base.member_scoring!=R_SCORING:
        raise ValueError('Initializer requires the predeclared separate-v1 graph-plan-v4 C0')
    parent_sha=file_sha(parent);optimizer_sha=file_sha(optimizer);paths=json.loads(Path(episode_list).read_text())
    if not isinstance(paths,list) or any(not isinstance(path,str) or not path for path in paths):
        raise ValueError('Expected a predeclared source path list')
    if len({str(Path(path).resolve()) for path in paths})!=len(paths):raise ValueError('Duplicate canonical source path')
    cases,sources=prepare_panel(base,paths,parent_sha,exclude_sources)
    merged=copy.deepcopy(base);merged.change_member_scoring(M_SCORING)
    frames=[member_frame(base,merged,case) for case in cases]
    calibration=fit_keep_bias(frames)
    inertia=copy.deepcopy(base);inertia.change_member_scoring({'mode':'keep-bias-v1','bias':calibration['bias']})
    actual_i=[member_frame(base,inertia,case) for case in cases]
    _,i_odds,i_weights,_=weighted_panel(actual_i);actual_mean=mean_keep(i_odds,i_weights)
    if abs(actual_mean-calibration['mergedMeanKeep'])>FIT_TOLERANCE*2:
        raise ValueError('Actual I forward does not match the calibrated effective-logit bias')
    calibration['actualForwardInertiaMeanKeep']=actual_mean
    calibration['actualForwardAbsoluteMeanError']=abs(actual_mean-calibration['mergedMeanKeep'])
    selected,golden_selection=golden_cases(cases,frames)
    if not tensors_identical(base,merged) or not tensors_identical(base,inertia):raise ValueError('Initializer changed model tensors')
    tensors={name:{'shape':list(value.shape),'dtype':str(value.dtype),
                   'sha256':hashlib.sha256(value.detach().contiguous().view(torch.uint8).numpy().tobytes()).hexdigest()} for name,value in base.state_dict().items()}
    source_hashes={name:file_sha(Path(__file__).with_name(name)) for name in
                   ['commander_member_adapter.py','commander_model.py','commander_train.py','commander_parameter_probe.py']}
    common={'method':'member-scoring-zero-update-initializer','updates':0,'parentPath':str(parent),'parentSha256':parent_sha,
            'inputOptimizerPath':str(optimizer),'inputOptimizerSha256':optimizer_sha,'optimizerStart':'unchanged copy',
            'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'sourceCodeSha256':source_hashes,
            'panelListSha256':file_sha(episode_list),'torchVersion':torch.__version__,'pythonVersion':platform.python_version(),
            'scope':'No optimizer, gradients, games, controller application or temperature changes; the same C0 tensors and Adam initialize different policy parameterizations.'}
    out.mkdir(parents=True)
    arms={}
    for label,model in [('R',base),('M',merged),('I',inertia)]:
        target=out/(label+'.json')
        if label=='R':shutil.copyfile(parent,target)
        else:export(model,target,{**common,'arm':label,'memberScoring':dict(model.member_scoring),'calibrationBias':calibration['bias']})
        shutil.copyfile(optimizer,target.with_suffix('.optimizer.pt'))
        old_golden=parent.with_suffix('.golden.json')
        if label=='R' and old_golden.is_file():
            shutil.copyfile(old_golden,target.with_suffix('.golden.json'));golden_mode='byte-copy original C0 golden'
        else:write_golden(model,selected,target.with_suffix('.golden.json'));golden_mode='regenerated on selected actual full-history panel frames'
        exported=json.loads(target.read_text())
        expected_format='warbook-commander-model-v1' if label=='R' else 'warbook-commander-model-v2'
        if exported.get('format')!=expected_format:raise ValueError('Member scoring export lacks its required transport version')
        if label!='R' and (exported.get('actionEncoding')!=model.encoding or 'encoding' in exported):
            raise ValueError('Nondefault member scoring requires the v2 actionEncoding header')
        if exported['tensors']!=artifact['tensors']:raise ValueError('Export changed C0 tensor representation')
        if file_sha(target.with_suffix('.optimizer.pt'))!=optimizer_sha:raise ValueError('Optimizer copy changed')
        arms[label]={'path':str(target),'sha256':file_sha(target),'format':exported['format'],'actionEncoding':model.encoding,'effectiveMemberScoring':dict(model.member_scoring),
                     'memberScoringFieldPresent':'memberScoring' in exported,'tensorsIdenticalToC0':True,
                     'optimizerSha256':optimizer_sha,'optimizerByteIdenticalToC0':True,
                     'goldenPath':str(target.with_suffix('.golden.json')),'goldenSha256':file_sha(target.with_suffix('.golden.json')),
                     'goldenMode':golden_mode,'artifactByteIdenticalToC0':file_sha(target)==parent_sha}
    rows=[]
    for frame,i in zip(frames,actual_i):
        row={key:value for key,value in frame.items() if key not in ['rLogOdds','mLogOdds']}
        for label,odds in [('R',frame['rLogOdds']),('M',frame['mLogOdds']),('I',i['mLogOdds'])]:
            row[label+'MeanKeep']=float(torch.sigmoid(odds).mean()) if odds.numel() else None
        rows.append(row)
    if file_sha(parent)!=parent_sha or file_sha(optimizer)!=optimizer_sha:raise ValueError('C0 source changed during initialization')
    report={**common,'schema':'commander-member-scoring-calibration-v1','calibration':calibration,'arms':arms,
            'tensorIdentities':tensors,'panelSources':source_identity(sources),'excludedSources':[str(Path(p).resolve()) for p in exclude_sources],
            'phaseSampling':'Eight evenly spaced actual decisions plus each adjacent successor:16 frames per source;256 total before eligibility exclusions.',
            'history':'Continuous C0-weight actual-world recurrence from zero; recorded hidden is diagnostic only. Identical encoder/GRU tensors make each arm’s prefix state identical; each arm’s selected next hidden and value are checked bitwise.',
            'actionPrefix':'The complete actual recorded action chain is forced. No counterfactual action is applied to a world; no outcome labels enter calibration.',
            'goldenSelection':golden_selection,'panelFrames':rows,'seconds':time.monotonic()-started,'cpuSeconds':time.process_time()-cpu,
            'limits':'I matches M mean KEEP increment on this fixed panel only. Actual state visits and KEEP rates can differ in new games; no strength or preservation result is implied.'}
    (out/'calibration.json').write_text(json.dumps(report,indent=2)+'\n')
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True);parser.add_argument('--optimizer')
    parser.add_argument('--episodes',required=True);parser.add_argument('--out',required=True)
    parser.add_argument('--exclude-source',action='append',default=[]);parser.add_argument('--threads',type=int,default=1)
    args=parser.parse_args()
    if args.threads<1:raise ValueError('Expected positive thread count')
    torch.set_num_threads(args.threads)
    result=initialize(args.input,args.episodes,args.out,args.optimizer,args.exclude_source)
    print(json.dumps({'out':str(Path(args.out).resolve()),'bias':result['calibration']['bias'],
                      'eligibleSources':result['calibration']['counts']['eligibleSources'],
                      'actualMeanError':result['calibration']['actualForwardAbsoluteMeanError'],'seconds':result['seconds']}),flush=True)


if __name__=='__main__':main()
