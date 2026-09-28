"""Bounded decoder parameter probes; no optimizer, controller, or game runner.

Eight signed directions are fixed before calibration. A stable rare-alternative
log-odds slope sets one center, followed by exactly four actual-forward scales.
Exports are generator candidates, never declarations of safe or strong play.
"""
import argparse
import copy
import hashlib
import json
import math
import platform
import subprocess
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from commander_model import HIDDEN,pack,pack_actions,export
from commander_train import load_model,plain_world,read_episode,validate_ppo_behavior

DIRECTIONS={
    'D1':('kind','roleKeys'),
    'D2':('goalQuery','roleKeys'),
    'D3':('unitQuery','roleSpecialKeys'),
    'D4':('kind','goalQuery','roleKeys','unitQuery','engagement'),
}
PRIMARY={'D1':('task',),'D2':('goal',),'D3':('member',),'D4':('task','goal','member')}
FAMILIES=('queue','amount','cash','task','goal','member','engagement')
GRID=(.25,.5,1.,2.)
LOG_RARE=math.log(1e-3)
TARGET_LOG_ODDS=-math.log(9.)


def file_sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tensor_sha(value):
    return hashlib.sha256(value.detach().contiguous().view(torch.uint8).numpy().tobytes()).hexdigest()


def phase_indices(length,phases=8):
    """Eight evenly spaced decisions, each followed by its actual adjacent row."""
    if phases<2 or length<2*phases:raise ValueError('Source is too short for distinct phase pairs')
    starts=[round(index*(length-2)/(phases-1)) for index in range(phases)]
    result=[(start+offset,phase,offset) for phase,start in enumerate(starts) for offset in (0,1)]
    if len({row for row,_,_ in result})!=2*phases:raise ValueError('Overlapping phase pairs')
    return result


def goal_semantics(goal):
    """Program.plan: native has no destination; refs follow entities then fall back.

    Stored fallback coordinates and bridge state remain part of reference identity.
    Only plain point aliases with the same destination can ignore their goal kind.
    """
    point=(goal['x'],goal['y'],bool(goal.get('onBridge',False)))
    if goal['kind']=='native':return ('native',goal.get('ref'),*point)
    if goal.get('ref') is not None:return ('reference',goal['ref'],*point)
    return ('point',*point)


def semantic_groups(world,mask,head):
    groups={}
    for index,allowed in enumerate(mask.tolist()):
        if allowed:
            key=goal_semantics(world['goalObjects'][index]) if head=='goal' else index
            groups.setdefault(key,[]).append(index)
    return tuple(tuple(indices) for indices in groups.values())


def group_logs(logs,groups):
    return torch.stack([torch.logsumexp(logs[list(indices)],0) for indices in groups])


def log_odds(logs,index):
    # Do not take log(probability): legal tails can underflow even in float64.
    rest=torch.cat((logs[:index],logs[index+1:]))
    return logs[index]-torch.logsumexp(rest,0)


def required_scale(base_logs,trial_logs,step):
    """Numerically best rare alternative, using alternative-versus-rest odds."""
    modal=int(base_logs.argmax());best=None
    for alternative in range(len(base_logs)):
        if alternative==modal or float(base_logs[alternative])>=LOG_RARE:continue
        original=float(log_odds(base_logs,alternative))
        slope=float((log_odds(trial_logs,alternative)-original)/step)
        if not math.isfinite(slope) or slope<=1e-10:continue
        scale=(TARGET_LOG_ODDS-original)/slope
        if math.isfinite(scale) and scale>0 and (best is None or scale<best['scale']):
            best={'scale':scale,'alternativeGroup':alternative,'logOdds':original,'slope':slope}
    return best


def opening(base_logs,current_logs):
    modal=int(base_logs.argmax())
    other=torch.cat((base_logs[:modal],base_logs[modal+1:]))
    strict=float(torch.logsumexp(other,0))<LOG_RARE
    current_other=torch.cat((current_logs[:modal],current_logs[modal+1:]))
    strict_open=strict and float(torch.logsumexp(current_other,0))>=math.log(.1)
    rare=[index for index in range(len(base_logs)) if index!=modal and float(base_logs[index])<LOG_RARE]
    rare_open=any(float(current_logs[index])>=math.log(.1) for index in rare)
    return strict,strict_open,bool(rare),rare_open


def make_direction(model,name,seed=928603):
    """One rank-1 outer product per [weight|bias] block, with one shared sign."""
    if name not in DIRECTIONS:raise ValueError('Unknown direction')
    generator=torch.Generator().manual_seed(seed+list(DIRECTIONS).index(name)*1000003)
    state=model.state_dict();deltas={};blocks=[]
    for module in DIRECTIONS[name]:
        if module=='roleSpecialKeys':
            names=[module];base=state[module];augmented=base
        else:
            names=[module+'.weight',module+'.bias'];base=state[names[0]]
            augmented=torch.cat((base,state[names[1]][:,None]),1)
        norm=float(augmented.double().norm())
        if not math.isfinite(norm) or norm<=0:raise ValueError('Zero/nonfinite target block: '+module)
        u=torch.randn(augmented.shape[0],generator=generator,dtype=torch.float64)
        v=torch.randn(augmented.shape[1],generator=generator,dtype=torch.float64)
        delta=torch.outer(u/u.norm(),v/v.norm())*norm
        if len(names)==1:deltas[names[0]]=delta.to(base.dtype)
        else:
            deltas[names[0]]=delta[:,:-1].to(base.dtype)
            deltas[names[1]]=delta[:,-1].to(base.dtype)
        blocks.append({'module':module,'parameters':names,'baseNorm':norm,
                       'directionSha256':tensor_sha(delta),'shape':list(augmented.shape)})
    return {'name':name,'seed':seed,'generatorSeed':seed+list(DIRECTIONS).index(name)*1000003,
            'deltas':deltas,'blocks':blocks}


def apply_direction(base,direction,sign,scale,max_relative=2.):
    if sign not in (-1,1) or not math.isfinite(scale) or scale<=0:raise ValueError('Invalid signed scale')
    if not math.isfinite(max_relative) or max_relative<=0:raise ValueError('Invalid relative bound')
    if scale>max_relative:raise ValueError('Scale exceeds hard relative Frobenius bound')
    candidate=copy.deepcopy(base);original=base.state_dict();state=candidate.state_dict()
    with torch.no_grad():
        for name,delta in direction['deltas'].items():state[name].copy_(original[name]+sign*scale*delta)
    bounds=[]
    for block in direction['blocks']:
        differences=[(state[name]-original[name]).double().flatten() for name in block['parameters']]
        ratio=float(torch.cat(differences).norm())/block['baseNorm']
        if not math.isfinite(ratio) or ratio>max_relative*(1+1e-6):raise ValueError('Actual perturbation exceeds hard bound')
        bounds.append({'module':block['module'],'relativeFrobenius':ratio})
    for name,value in state.items():
        if name not in direction['deltas'] and not torch.equal(value,original[name]):
            raise ValueError('Changed frozen tensor: '+name)
        if not torch.isfinite(value).all():raise ValueError('Nonfinite candidate parameter')
    return candidate,bounds


def occupied_slots(world):
    return sorted({role for role in world['previousRoles'] if 0<=role<16 and world['previousKinds'][role]>=2})


def family_name(head):
    for name in ('queue','amount','cash'):
        if head.startswith(name):return name
    return {'kind':'task','goal':'goal','unit':'member','engagement':'engagement'}.get(head)


def make_rows(case,prediction):
    rows=[];world=case['world'];occupied=occupied_slots(world)
    for head,term in prediction['conditionals'].items():
        family=family_name(head)
        if family is None:continue
        positions=occupied if head in ('kind','goal','engagement') else range(len(world['unitIndices'])) if head=='unit' else [None]
        for position in positions:
            index=(0,) if position is None else (0,position)
            if not bool(term['active'][index]):continue
            mask=term['mask'][index];groups=semantic_groups(world,mask,head)
            if len(groups)<2:continue
            logs=group_logs(term['log_probabilities'][index],groups)
            rows.append({'head':head,'family':family,'index':index,'groups':groups,'logs':logs,
                         'mask':mask.clone(),'position':position})
    return rows


@torch.no_grad()
def prepare_panel(model,paths,parent_sha,exclude_sources=()):
    if len(paths)!=16 or len(set(paths))!=16:raise ValueError('Expected exactly 16 distinct predeclared C0 episodes')
    excluded={str(Path(path).resolve()) for path in exclude_sources}
    if any(str(Path(path).resolve()) in excluded for path in paths):raise ValueError('Excluded failure source is in calibration panel')
    cells=[(Path(path).parent.parent.name,Path(path).parent.name) for path in paths]
    if len(set(cells))!=16 or len({m for m,_ in cells})!=4 or len({o for _,o in cells})!=4:
        raise ValueError('Expected one source per four-map/four-opponent cell')
    cases=[];sources=[]
    for path,(map_name,opponent) in zip(paths,cells):
        episode=read_episode(path)
        if episode is None:raise ValueError('Ineligible predeclared source; no replacement: '+path)
        validate_ppo_behavior([episode],model,parent_sha)
        selected=phase_indices(len(episode['rows']));wanted={index:(phase,offset) for index,phase,offset in selected}
        hidden=next(model.parameters()).new_zeros((1,HIDDEN));maximum=0.
        # Recurrence sees every actual world, including rows between sampled phases.
        for start in range(0,len(episode['rows']),64):
            records=episode['rows'][start:start+64]
            packed=pack([row['world'] for row in records],model.vocabulary);encoded=model.encode_world(packed)
            for local,row in enumerate(records):
                index=start+local
                if index in wanted:
                    phase,offset=wanted[index];world=row['world'];data=pack([world],model.vocabulary)
                    features=model.encode_world(data);action=pack_actions([row['action']],data)
                    baseline=model(data,hidden,action,encoded=features,return_conditionals=True)
                    maximum=max(maximum,float((hidden-torch.tensor([row['hidden']],dtype=torch.float32)).abs().max()))
                    case={'source':path,'map':map_name,'opponent':opponent,'tick':row['tick'],'rowIndex':index,
                          'phase':phase,'adjacent':offset,'world':world,'action':row['action'],'hidden':hidden.clone(),
                          'data':data,'encoded':features,'packedAction':action,'baseline':baseline}
                    case['rows']=make_rows(case,baseline);cases.append(case)
                hidden=model.advance_hidden(None,hidden,encoded=tuple(value[local:local+1] for value in encoded))
        sources.append({'path':path,'map':map_name,'opponent':opponent,'selectedRows':[index for index,_,_ in selected],
                        'manifestSha256':file_sha(Path(path)/'manifest.json'),'resultSha256':file_sha(Path(path)/'result.json'),
                        'maximumReconstructedVsRecordedHiddenCoordinateDifference':maximum,'outcomeUsedForSelection':False})
    if len(cases)!=256:raise ValueError('Expected exactly 256 phase/adjacent frames')
    return cases,sources


@torch.no_grad()
def score_case(candidate,case):
    prediction=candidate(case['data'],case['hidden'],case['packedAction'],encoded=case['encoded'],return_conditionals=True)
    baseline=case['baseline']
    if not torch.equal(prediction['hidden'],baseline['hidden']):raise ValueError('Frozen world recurrence changed')
    for name,term in baseline['conditionals'].items():
        current=prediction['conditionals'][name]
        if not torch.equal(term['mask'],current['mask']):raise ValueError('Same-prefix action mask changed')
        if name.startswith(('queue','amount','cash')) and not torch.equal(term['probabilities'],current['probabilities']):
            raise ValueError('Frozen production conditional probability changed')
    return prediction


def quantiles(values):
    if not values:return {'rows':0,'median':None,'p95':None,'p99':None,'maximum':None}
    q=np.quantile(values,[.5,.95,.99])
    return {'rows':len(values),'median':float(q[0]),'p95':float(q[1]),'p99':float(q[2]),'maximum':max(values)}


def gate(count,eligible,sources,maps):
    return eligible>0 and count>=math.ceil(.05*eligible) and len(sources)>=2 and len(maps)>=2


@torch.no_grad()
def measure(candidate,cases,primary):
    values={family:[] for family in FAMILIES};opened={family:defaultdict(int) for family in FAMILIES}
    sources={family:{key:set() for key in ('strict','rare')} for family in FAMILIES}
    maps={family:{key:set() for key in ('strict','rare')} for family in FAMILIES};worlds=[]
    for case in cases:
        prediction=score_case(candidate,case);world={'source':case['source'],'map':case['map'],'tick':case['tick'],
            'rowsAtTVAtLeastPoint1':dict.fromkeys(FAMILIES,0),'maximumTV':0.}
        for row in case['rows']:
            current=group_logs(prediction['conditionals'][row['head']]['log_probabilities'][row['index']],row['groups'])
            tv=float((row['logs'].exp()-current.exp()).abs().sum()/2)
            family=row['family'];values[family].append(tv);world['maximumTV']=max(world['maximumTV'],tv)
            world['rowsAtTVAtLeastPoint1'][family]+=int(tv>=.1)
            strict,strict_open,rare,rare_open=opening(row['logs'],current)
            for key,eligible,is_open in [('strict',strict,strict_open),('rare',rare,rare_open)]:
                opened[family][key+'Eligible']+=int(eligible);opened[family][key+'Opened']+=int(is_open)
                if is_open:sources[family][key].add(case['source']);maps[family][key].add(case['map'])
        worlds.append(world)
    families={};passes=[]
    for family in FAMILIES:
        info={'tv':quantiles(values[family])}
        for key in ('strict','rare'):
            eligible=opened[family][key+'Eligible'];count=opened[family][key+'Opened']
            info[key+'Opening']={'eligibleRows':eligible,'openedRows':count,'fraction':count/eligible if eligible else None,
                'sources':sorted(sources[family][key]),'maps':sorted(maps[family][key]),
                'passes':gate(count,eligible,sources[family][key],maps[family][key])}
        info['highRisk']=info['tv']['p99'] is not None and info['tv']['p99']>.8
        if family in primary and (info['strictOpening']['passes'] or info['rareOpening']['passes']):passes.append(family)
        families[family]=info
    return {'families':families,'passedPrimaryFamilies':passes,'usefulOpening':bool(passes),
            'highRiskFamilies':[name for name,value in families.items() if value['highRisk']],
            'topTenWorlds':sorted(worlds,key=lambda row:row['maximumTV'],reverse=True)[:10],
            'worlds':worlds,'productionProbabilitiesBitwiseEqual':True,'nextHiddenBitwiseEqual':True}


@torch.no_grad()
def calibrate_center(candidate,cases,primary,step,quantile=.25):
    required=[];by_family=defaultdict(list);examples=[]
    for case in cases:
        prediction=score_case(candidate,case)
        for row in case['rows']:
            if row['family'] not in primary:continue
            current=group_logs(prediction['conditionals'][row['head']]['log_probabilities'][row['index']],row['groups'])
            estimate=required_scale(row['logs'],current,step)
            if estimate is None:continue
            required.append(estimate['scale']);by_family[row['family']].append(estimate['scale'])
            examples.append({'source':case['source'],'map':case['map'],'tick':case['tick'],'head':row['head'],
                             'position':row['position'],**estimate,
                             'rawAlternativeIndices':list(row['groups'][estimate['alternativeGroup']])})
    return {'center':float(np.quantile(required,quantile)) if required else None,'quantile':quantile,
            'rowEstimates':len(required),'requiredScalesByFamily':{key:quantiles(values) for key,values in by_family.items()},
            'smallestTenEstimates':sorted(examples,key=lambda row:row['scale'])[:10]}


def action_tasks(world,action):
    result=[]
    for slot,selected in enumerate(action['kinds']):
        kind=world['previousKinds'][slot] if selected==0 else selected
        index=world['previousGoals'][slot] if selected==0 else action['goals'][slot]
        goal=goal_semantics(world['goalObjects'][index]) if kind>=2 and kind!=10 else None
        # Legal world task features encode allowCrush/interrupt/focus at20/21/24.
        # KEEP retains those bits; an explicit task edit uses its sampled mode.
        old_mode=int(world['tasks'][slot][20])+2*int(world['tasks'][slot][21])+4*int(world['tasks'][slot][24])
        engagement=(old_mode if selected==0 else action['engagement'][slot]) if kind>=2 else None
        result.append((kind,goal,engagement))
    return result


def plain_action(action,world):
    result={name:value[0].tolist() for name,value in action.items()}
    result['units']=result['units'][:len(world['unitIndices'])]
    result['buildings']=result['buildings'][:len(world['buildingIndices'])]
    return result


@torch.no_grad()
def validate_free_chains(base,candidate,cases,seed):
    worlds=[]
    for index,case in enumerate(cases):
        predictions=[]
        for model in (base,candidate):
            prediction=model(case['data'],case['hidden'],encoded=case['encoded'],generator=torch.Generator().manual_seed(seed+index))
            forced=model(case['data'],case['hidden'],prediction['actions'],encoded=case['encoded'])
            if not torch.equal(prediction['logp'],forced['logp']):raise ValueError('Free-chain/forced-chain logp mismatch')
            predictions.append(plain_action(prediction['actions'],case['world']))
        before,after=predictions
        for family in ('queues','amounts','cash'):
            if before[family]!=after[family]:raise ValueError('Coupled free production samples changed')
        old_tasks,new_tasks=[action_tasks(case['world'],action) for action in predictions]
        old_roles=[case['world']['previousRoles'][i] if choice==18 else choice for i,choice in enumerate(before['units'])]
        new_roles=[case['world']['previousRoles'][i] if choice==18 else choice for i,choice in enumerate(after['units'])]
        affected=sum(old!=new or old<16 and new<16 and old_tasks[old]!=new_tasks[new] for old,new in zip(old_roles,new_roles))
        occupied=occupied_slots(case['world'])
        worlds.append({'source':case['source'],'map':case['map'],'tick':case['tick'],
            'taskKindChanges':sum(old[0]!=new[0] for old,new in zip(old_tasks,new_tasks)),
            'occupiedTaskKindChanges':sum(old_tasks[i][0]!=new_tasks[i][0] for i in occupied),
            'taskGoalSemanticChanges':sum(old[1]!=new[1] for old,new in zip(old_tasks,new_tasks)),
            'taskEngagementChanges':sum(old[2]!=new[2] for old,new in zip(old_tasks,new_tasks)),
            'memberAssignmentChanges':sum(old!=new for old,new in zip(old_roles,new_roles)),
            'unitsAffectedByTaskOrAssignmentChanges':affected,'actualUnits':len(old_roles)})
    return {'cases':len(cases),'completeLegalChains':True,'sampleForcedLogpBitwiseEqual':True,
            'coupledProductionSamplesEqual':True,'worlds':worlds,
            'warning':'One free sample per model/world; same RNG seed couples comparisons. No actions were applied to create candidate worlds.'}


@torch.no_grad()
def write_golden(model,cases,path):
    result=[]
    for index in sorted({0,len(cases)//3,2*len(cases)//3,len(cases)-1}):
        case=cases[index];world=case['world'];prediction=score_case(model,case)
        probabilities={}
        for name,term in prediction['conditionals'].items():
            value=term['probabilities']
            if name=='unit':value=value[0,:len(world['unitRefs'])]
            elif name=='building':value=value[0,:len(world['buildingRefs'])]
            elif value.ndim==3:value=value[0]
            elif name.startswith('place'):value=value[:,:len(world['placementObjects'])+1]
            probabilities[name]=value.tolist()
        result.append({'world':plain_world(world),'action':case['action'],'hidden':case['hidden'][0].tolist(),
            'expected':{'logp':float(prediction['logp'][0]),'value':float(prediction['value'][0]),
                        'hidden':prediction['hidden'][0].tolist(),'probabilities':probabilities}})
    path.write_text(json.dumps(result,separators=(',',':'))+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True);parser.add_argument('--episodes',required=True);parser.add_argument('--out',required=True)
    parser.add_argument('--exclude-source',action='append',default=[]);parser.add_argument('--seed',type=int,default=928603)
    parser.add_argument('--threads',type=int,default=1);parser.add_argument('--numerical-step',type=float,default=1e-3)
    parser.add_argument('--max-relative',type=float,default=2.);parser.add_argument('--quantile',type=float,default=.25)
    args=parser.parse_args()
    if args.threads<1 or not 0<args.numerical_step<args.max_relative or not math.isfinite(args.max_relative) or not 0<args.quantile<.5:
        raise ValueError('Invalid bounded calibration configuration')
    out=Path(args.out)
    if out.exists():raise ValueError('Use a fresh output directory')
    torch.set_num_threads(args.threads);started=time.monotonic();parent=Path(args.input);parent_sha=file_sha(parent)
    model=load_model(json.loads(parent.read_text())).eval()
    if model.encoding!='graph-plan-v4':raise ValueError('This fixed probe requires the agreed v4 C0 grammar')
    paths=json.loads(Path(args.episodes).read_text());cases,sources=prepare_panel(model,paths,parent_sha,args.exclude_source)
    out.mkdir(parents=True);directions=[make_direction(model,name,args.seed) for name in DIRECTIONS]
    common={'method':'bounded-decoder-parameter-probe','parentPath':str(parent),'parentSha256':parent_sha,'seed':args.seed,
        'git':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'probeCodeSha256':file_sha(__file__),
        'modelCodeSha256':file_sha(Path(__file__).with_name('commander_model.py')),
        'trainerCodeSha256':file_sha(Path(__file__).with_name('commander_train.py')),
        'sourceNote':'Git identifies the execution checkout; exact loaded probe/model/trainer file hashes identify working-copy snapshots as well as frozen runs.',
        'torchVersion':torch.__version__,'pythonVersion':platform.python_version(),'panelListSha256':file_sha(args.episodes),
        'panelSources':sources,'excludedSources':args.exclude_source,'phaseFrames':len(cases),
        'numericalStep':args.numerical_step,'centerQuantile':args.quantile,'gridMultipliers':list(GRID),
        'maximumRelativeFrobenius':args.max_relative,
        'boundDefinition':'Each augmented [weight|bias] block, and standalone roleSpecialKeys, has perturbation Frobenius/RMS norm at most this multiple of the original block norm.',
        'calibration':'Stable semantic-group log-odds versus all other legal groups; numerically best rare nonmodal alternative per row; no action-name target.',
        'rareAlternativeCorrection':'Root-requested extension to Pro09 row saturation: multimodal goal rows can contain closed rare alternatives. Strict row opening and rare alternative opening are reported separately.',
        'selection':'Smallest tested in-bound scale opening >=5% eligible rows of a primary family across >=2 sources and >=2 maps. P99 TV >.8 is a high-risk flag, not a safety guarantee or automatic replacement.',
        'frozenHistory':'C0 hidden reconstructed through complete actual histories. Exact frozen encoder/recurrent tensors establish identical candidate recurrence; every selected next hidden is checked bitwise.',
        'sourceScope':'Original predeclared calibration sources only. No failure-case scoring, games, optimizer updates, or runtime rule changes.'}
    report={**common,'candidates':[]};(out/'panel.json').write_text(json.dumps({**common,'cases':[{key:case[key] for key in ('source','map','opponent','tick','rowIndex','phase','adjacent')} for case in cases]},indent=2)+'\n')
    for direction in directions:
        for sign in (1,-1):
            identity=direction['name']+('plus' if sign==1 else 'minus');primary=PRIMARY[direction['name']]
            entry={'id':identity,'direction':direction['name'],'sign':sign,'generatorSeed':direction['generatorSeed'],'primaryFamilies':list(primary),
                   'targetParameters':sorted(direction['deltas']),'blocks':direction['blocks'],'status':'invalid','trials':[]}
            small,_=apply_direction(model,direction,sign,args.numerical_step,args.max_relative)
            center=calibrate_center(small,cases,primary,args.numerical_step,args.quantile);entry['calibration']=center
            selected=None
            if center['center'] is None:entry['reason']='No finite positive rare-alternative log-odds slopes in primary rows'
            else:
                for multiplier in GRID:
                    scale=center['center']*multiplier;trial={'multiplier':multiplier,'scale':scale}
                    if not math.isfinite(scale) or scale>args.max_relative:
                        trial.update(status='outside-bound');entry['trials'].append(trial);continue
                    candidate,bounds=apply_direction(model,direction,sign,scale,args.max_relative)
                    metrics=measure(candidate,cases,primary);trial.update(status='measured',relativeBounds=bounds,metrics=metrics)
                    entry['trials'].append(trial)
                    if selected is None and metrics['usefulOpening']:selected=(scale,candidate,metrics,bounds)
                if selected is None:entry['reason']='Four-scale grid did not meet a primary-family opening criterion within the hard bound'
            if selected is not None:
                scale,candidate,metrics,bounds=selected
                free=validate_free_chains(model,candidate,cases,args.seed+7000001)
                path=out/(identity+'.json');metadata={**common,'candidate':identity,'direction':direction['name'],'sign':sign,
                    'scale':scale,'targetParameters':sorted(direction['deltas']),'blocks':direction['blocks'],'relativeBounds':bounds,
                    'primaryFamilies':list(primary),'highRiskFamilies':metrics['highRiskFamilies'],'generatorOpeningFamilies':metrics['passedPrimaryFamilies'],
                    'untargetedTensorsBitwiseEqual':True,'productionConditionalsBitwiseEqual':True,'freeChainsValidated':free['cases'],
                    'scope':'Untested-in-games frozen candidate; offline generator criteria are not strength or safety evidence'}
                digest=export(candidate,path,metadata);write_golden(candidate,cases,path.with_suffix('.golden.json'))
                entry.update(status='exported',selectedScale=scale,artifact=str(path),sha256=digest,
                             golden=str(path.with_suffix('.golden.json')),selectedMetrics=metrics,freeChains=free)
            report['candidates'].append(entry)
            (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps({'candidate':identity,'status':entry['status'],'center':center['center'],
                              'selectedScale':entry.get('selectedScale'),'reason':entry.get('reason')}),flush=True)
    if file_sha(parent)!=parent_sha:raise ValueError('Parent artifact changed during probe')
    report['seconds']=time.monotonic()-started;report['exported']=sum(row['status']=='exported' for row in report['candidates'])
    report['invalid']=8-report['exported'];(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'out':str(out),'exported':report['exported'],'invalid':report['invalid'],'seconds':report['seconds']}),flush=True)


if __name__=='__main__':main()
