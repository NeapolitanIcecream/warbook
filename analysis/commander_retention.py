"""Forward conditional KL on frozen-teacher prefixes of actual world histories.

The reference samples actions only; it never applies them to a controller or
constructs a teacher world. Both recurrent states come from the recorded worlds,
and the student's pre-window state is rebuilt after every weight update.
"""
import time

import torch

from commander_model import HIDDEN,pack,pack_actions


def _configuration(model):
    return (tuple(model.vocabulary),model.encoding,model.temperature,
            tuple(sorted(model.effective_production_temperatures().items())))


def _teacher_version(model):
    return tuple((name,id(value),value._version) for name,value in model.named_parameters())


def zero_loss(model):
    """Touch every parameter so an empty anchor rank participates in DDP."""
    return sum(parameter.sum()*0 for parameter in model.parameters())


def conditional_kl(reference,student):
    """Per-frame sum of forward KLs, each on the full reference action prefix.

    ``reference`` and ``student`` are the model's ``conditionals`` mappings.
    Singleton/invalid factors are zero. Masked entries are replaced before
    subtraction, so zero-probability categories never create ``0 * inf``.
    """
    if reference.keys()!=student.keys():raise ValueError('Conditional factor mismatch')
    total=None
    for name,target in reference.items():
        current=student[name]
        if not torch.equal(target['mask'],current['mask']):raise ValueError('Conditional mask mismatch: '+name)
        if not torch.equal(target['active'],current['active']):raise ValueError('Conditional activity mismatch: '+name)
        mask=target['mask']
        teacher_logs=torch.where(mask,target['log_probabilities'].detach(),0.)
        student_logs=torch.where(mask,current['log_probabilities'],0.)
        terms=(target['probabilities'].detach()*(teacher_logs-student_logs)).sum(-1)
        terms=torch.where(target['active'],terms,0.)
        if terms.ndim>1:terms=terms.sum(tuple(range(1,terms.ndim)))
        total=terms if total is None else total+terms
    if total is None:raise ValueError('No conditional factors')
    return total


@torch.no_grad()
def reconstruct_hidden(model,episode,stop,chunk_size=64):
    """Detached current-weight state immediately before row ``stop``.

    All preceding actual worlds are replayed from zero. Recorded hidden states
    and actions are deliberately unused, including teacher/intervention rows.
    """
    if chunk_size<1:raise ValueError('History chunk size must be positive')
    rows=episode['rows']
    if not 0<=stop<=len(rows):raise ValueError('Invalid history boundary')
    hidden=next(model.parameters()).new_zeros((1,HIDDEN))
    for start in range(0,stop,chunk_size):
        data=pack([row['world'] for row in rows[start:min(stop,start+chunk_size)]],model.vocabulary)
        encoded=model.encode_world(data)
        for index in range(len(encoded[-1])):
            hidden=model.advance_hidden(None,hidden,encoded=tuple(value[index:index+1] for value in encoded))
    return hidden.detach()


@torch.no_grad()
def current_hidden_for_batch(model,batch,chunk_size=64):
    """Current-weight hidden before each PPO burn-in segment, plus replay cost.

    Input items retain the trainer's ``(episode, before, rows[, old_hidden])``
    shape. Row identity verifies that burn-in and selected rows form one real,
    contiguous history segment; an old supplied hidden is deliberately ignored.
    The caller then performs its unchanged burn-in and selected-window BPTT.
    Prefixes may be shared inside this call only, never across weight updates.
    """
    if chunk_size<1:raise ValueError('History chunk size must be positive')
    if not batch:return next(model.parameters()).new_zeros((0,HIDDEN)),0
    positions={};prefixes={};hidden=[];frames=0
    for item in batch:
        episode,before,rows=item[:3]
        if not rows:raise ValueError('Full-history PPO needs selected rows')
        history=episode['rows'];identity=id(history)
        if identity not in positions:
            positions[identity]={id(row):index for index,row in enumerate(history)}
            if len(positions[identity])!=len(history):raise ValueError('Ambiguous repeated history row')
        segment=[*before,*rows];start=positions[identity].get(id(segment[0]))
        if start is None or start+len(segment)>len(history) or any(history[start+offset] is not row for offset,row in enumerate(segment)):
            raise ValueError('PPO burn-in/selected rows are not a contiguous actual history')
        key=(identity,start)
        if key not in prefixes:
            prefixes[key]=reconstruct_hidden(model,episode,start,chunk_size)
            frames+=start
        hidden.append(prefixes[key])
    return torch.cat(hidden).detach(),frames


def _plain_actions(actions,index,world):
    result={name:value[index].tolist() for name,value in actions.items()}
    result['units']=result['units'][:len(world['unitIndices'])]
    result['buildings']=result['buildings'][:len(world['buildingIndices'])]
    return result


@torch.no_grad()
def build_teacher_cache(teacher,episodes,seed=0,chunk_size=64):
    """Cache C0 hidden-before/actions for every row of each complete source.

    The rows are referenced, never copied. A private generator makes teacher
    sampling independent of the PPO/window RNG. Distributions are recomputed
    only for selected windows rather than stored for every entity/category.
    """
    if chunk_size<1:raise ValueError('History chunk size must be positive')
    started=time.monotonic();generator=torch.Generator().manual_seed(seed)
    sources={};frames=0
    for episode in episodes:
        path=episode['path'];rows=episode['rows']
        if path in sources:
            if sources[path]['rows'] is not rows:raise ValueError('Duplicate retention source path')
            continue
        hidden=next(teacher.parameters()).new_zeros((1,HIDDEN));states=[];actions=[]
        for start in range(0,len(rows),chunk_size):
            selected=rows[start:start+chunk_size]
            data=pack([row['world'] for row in selected],teacher.vocabulary)
            encoded=teacher.encode_world(data);before=[]
            for index in range(len(selected)):
                before.append(hidden)
                hidden=teacher.advance_hidden(None,hidden,encoded=tuple(value[index:index+1] for value in encoded))
            before=torch.cat(before)
            prediction=teacher(data,before,encoded=encoded,generator=generator)
            states.append(before)
            actions.extend(_plain_actions(prediction['actions'],index,row['world']) for index,row in enumerate(selected))
        sources[path]={'rows':rows,'hidden':torch.cat(states) if states else hidden[:0],'actions':actions}
        frames+=len(rows)
    return {'episodes':sources,'teacher_id':id(teacher),'teacher_version':_teacher_version(teacher),
            'configuration':_configuration(teacher),'seed':seed,'chunk_size':chunk_size,'preparation_frames':frames,
            'preparation_seconds':time.monotonic()-started}


def retention_batch(student,teacher,cache,windows,chunk_size=64):
    """Return ``(mean_kl, real_frame_count, diagnostics)`` for anchor windows.

    A window is ``(episode, start, end)`` with an exclusive end. Student prefix
    reconstruction has no autograd graph; recurrence inside each selected window
    does. The caller separately normalizes RL and anchor frames globally before
    their combined gradient clipping and one optimizer step.
    """
    started=time.monotonic()
    if _configuration(student)!=_configuration(teacher):raise ValueError('Retention student/teacher configuration mismatch')
    if cache['teacher_id']!=id(teacher) or cache['teacher_version']!=_teacher_version(teacher):
        raise ValueError('Retention teacher changed after cache preparation')
    if cache['configuration']!=_configuration(teacher):raise ValueError('Retention teacher configuration changed')
    selected=[]
    for episode,start,end in windows:
        source=cache['episodes'].get(episode['path'])
        if source is None or source['rows'] is not episode['rows']:raise ValueError('Uncached retention source')
        if not 0<=start<=end<=len(episode['rows']):raise ValueError('Invalid retention window')
        if end>start:selected.append((episode,start,end,source))
    zero=zero_loss(student)
    if not selected:
        return zero,0,{'prefix_frames':0,'anchor_frames':0,'kl_sum':0.,'active_factors':0,
                       'elapsed_seconds':time.monotonic()-started}
    prefixes={};prefix_frames=0
    for episode,start,_,_ in selected:
        key=(episode['path'],start)
        if key not in prefixes:
            prefixes[key]=reconstruct_hidden(student,episode,start,chunk_size)
            prefix_frames+=start
    hidden=torch.cat([prefixes[(episode['path'],start)] for episode,start,_,_ in selected])
    length=max(end-start for _,start,end,_ in selected);batch=len(selected)
    worlds=[];actions=[];teacher_hidden=[];present=[]
    for t in range(length):
        for episode,start,end,source in selected:
            index=min(start+t,end-1)
            worlds.append(episode['rows'][index]['world']);actions.append(source['actions'][index])
            teacher_hidden.append(source['hidden'][index]);present.append(start+t<end)
    data=pack(worlds,student.vocabulary);actions=pack_actions(actions,data)
    present=torch.tensor(present,dtype=torch.bool).reshape(length,batch)
    with torch.no_grad():
        reference=teacher(data,torch.stack(teacher_hidden),actions,return_conditionals=True)['conditionals']
    encoded=student.encode_world(data);loss_sum=zero;active_factors=0
    for t in range(length):
        start=t*batch;end=start+batch
        dt={name:value[start:end] for name,value in data.items() if name not in ['entityEdges','regionEdges','productEdges']}
        at={name:value[start:end] for name,value in actions.items()}
        et=tuple(value[start:end] for value in encoded)
        prediction=student(dt,hidden,at,encoded=et,return_conditionals=True)
        hidden=torch.where(present[t,:,None],prediction['hidden'],hidden)
        target={name:{key:value[start:end] for key,value in factor.items()} for name,factor in reference.items()}
        loss_sum=loss_sum+conditional_kl(target,prediction['conditionals'])[present[t]].sum()
        active_factors+=sum(int(factor['active'][present[t]].sum()) for factor in target.values())
    frames=int(present.sum())
    return loss_sum/frames,frames,{'prefix_frames':prefix_frames,'anchor_frames':frames,
        'kl_sum':float(loss_sum.detach()),'active_factors':active_factors,'elapsed_seconds':time.monotonic()-started}
