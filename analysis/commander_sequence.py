"""Whole-episode stream scheduling; padding never repeats a real training frame."""
def stream_batches(episodes,length,batch_size):
    pending=iter(episodes);active=[]
    for _ in range(batch_size):
        e=next(pending,None)
        if e is not None:active.append((e,0))
    result=[]
    while active:
        result.append(list(active));following=[]
        for e,start in active:
            start+=length
            if start<len(e['rows']):following.append((e,start))
            else:
                replacement=next(pending,None)
                if replacement is not None:following.append((replacement,0))
        active=following
    return result

def unique_batches(items,batch_size,steps=None):
    result=[items[i:i+batch_size] for i in range(0,len(items),batch_size)]
    if steps is not None:result.extend([] for _ in range(max(0,steps-len(result))))
    return result

def event_weight(action,boost):
    if boost<=1:return 1.
    if 17 in action['units']:return float(boost)
    if any(action['placements']):return min(float(boost),8.)
    if any(q>=4 for q in action['queues']) or any(u!=18 for u in action['units']):return min(float(boost),4.)
    return 1.

def training_action(record,method):
    # DAgger queries the expert without pretending it executed that action.
    return record.get('teacherAction',record['action']) if method=='bc' else record['action']

def action_edits(action):
    return [int(any(x!=keep for x in action[name])) for name,keep in [('queues',0),('kinds',0),('units',18),('buildings',0),('placements',0)]]

def canonical_action(action,world,encoding):
    if encoding=='graph-plan-v1':return action
    result={**action,'units':list(action['units'])}
    for i,selected in enumerate(result['units']):
        old=world['previousRoles'][i]
        changed=old<16 and action['kinds'][old] not in [0,world['previousKinds'][old]]
        if selected==18 and changed:result['units'][i]=old
        elif selected==old and old!=17 and not changed:result['units'][i]=18
    if encoding=='graph-plan-v3':result['edits']=action_edits(result)
    return result
