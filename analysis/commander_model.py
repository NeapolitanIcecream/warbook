"""Shared graph/state encoder and conditional whole-plan policy.

The actor reads legal entity/terrain/product facts. Native references are used only
to resolve pointers. Products and unit types use a public rules-name vocabulary.
"""
import math
import numpy as np
import torch
from torch import nn
from commander_sequence import action_edits

SLOTS=16
HIDDEN=128
AMOUNTS=[1,2,4,8,-1]
FLOORS=[0,250,500,1000,2000,4000]
FIELDS={'entities':64,'regions':16,'products':24,'goals':32,'tasks':32,'placements':32,'queues':16}

def pack(worlds,vocabulary):
    ids={name:i+1 for i,name in enumerate(vocabulary)}
    b=len(worlds);out={}
    for field,size in FIELDS.items():
        n=max(1,max(len(w[field]) for w in worlds));x=np.zeros((b,n,size),np.float32);mask=np.zeros((b,n),bool)
        for i,w in enumerate(worlds):
            a=np.asarray(w[field],dtype=np.float32).reshape(-1,size);x[i,:len(a)]=a;mask[i,:len(a)]=True
        out[field]=torch.from_numpy(x);out[field+'Mask']=torch.from_numpy(mask)
    out['global']=torch.tensor([w['global'] for w in worlds],dtype=torch.float32)
    for field,source,rows in [('entityIds','entityNames','entities'),('productIds','productNames','products'),('queueIds','queueNames','queues'),('goalIds','goalNames','goals')]:
        data=np.zeros(out[rows].shape[:2],np.int64)
        for i,w in enumerate(worlds):data[i,:len(w[source])]=[ids.get(n,0) for n in w[source]]
        out[field]=torch.from_numpy(data)
    for field,size in [('entityEdges',out['entities'].shape[1]),('regionEdges',out['regions'].shape[1]),('productEdges',out['products'].shape[1])]:
        pairs=[(i*size+a,i*size+c) for i,w in enumerate(worlds) for a,c in w[field]]
        out[field]=torch.tensor(pairs,dtype=torch.long).reshape(-1,2).T.contiguous()
    for field,source,pad in [('unitIndex','unitIndices',0),('buildingIndex','buildingIndices',0),('goalEntity','goalEntities',-1),('productQueue','productQueues',-1),('previousRole','previousRoles',19),('placementQueue',None,-1)]:
        values=[[p['queue'] for p in w['placementObjects']] if source is None else w[source] for w in worlds]
        n=max(1,max(map(len,values)));x=np.full((b,n),pad,np.int64);mask=np.zeros((b,n),bool)
        for i,v in enumerate(values):x[i,:len(v)]=v;mask[i,:len(v)]=True
        out[field]=torch.from_numpy(x);out[field+'Mask']=torch.from_numpy(mask)
    out['previousKind']=torch.tensor([w['previousKinds'] for w in worlds],dtype=torch.long)
    out['previousGoal']=torch.tensor([w['previousGoals'] for w in worlds],dtype=torch.long)
    kinds=['native','region','own','enemy','memory','ore','tech','start','previous']
    x=np.full(out['goals'].shape[:2],-1,np.int64)
    for i,w in enumerate(worlds):x[i,:len(w['goalObjects'])]=[kinds.index(g['kind']) for g in w['goalObjects']]
    out['goalKind']=torch.from_numpy(x)
    for field,source,keys,rows in [('unitCap','unitCapabilities',['miner','engineer','deploy','building'],'unitIndex'),('buildingCap','buildingCapabilities',['repair','sell'],'buildingIndex')]:
        x=np.zeros((*out[rows].shape,len(keys)),bool)
        for i,w in enumerate(worlds):
            if w[source]:x[i,:len(w[source])]=[[v[k] for k in keys] for v in w[source]]
        out[field]=torch.from_numpy(x)
    return out

def pack_actions(actions,data):
    out={'edits':torch.tensor([a.get('edits',action_edits(a)) for a in actions],dtype=torch.long)}
    for name in ['queues','amounts','cash','kinds','goals','engagement','units','buildings','placements']:
        n=data['unitIndex'].shape[1] if name=='units' else data['buildingIndex'].shape[1] if name=='buildings' else len(actions[0][name])
        x=np.zeros((len(actions),n),np.int64)
        for i,a in enumerate(actions):x[i,:len(a[name])]=a[name]
        out[name]=torch.from_numpy(x)
    return out

def gather_rows(x,index):
    return x.gather(1,index.clamp_min(0).unsqueeze(-1).expand(-1,-1,x.shape[-1]))

def neighbor_mean(x,edges):
    flat=x.reshape(-1,x.shape[-1]);sums=torch.zeros_like(flat);counts=torch.zeros((len(flat),1),dtype=x.dtype)
    if edges.numel():
        sums.index_add_(0,edges[1],flat[edges[0]])
        counts.index_add_(0,edges[1],torch.ones((edges.shape[1],1),dtype=x.dtype))
    return (sums/counts.clamp_min(1)).reshape_as(x)

def summary(x,mask):
    mean=(x*mask.unsqueeze(-1)).sum(1)/mask.sum(1).clamp_min(1).unsqueeze(-1)
    maximum=x.masked_fill(~mask.unsqueeze(-1),-1e9).max(1).values
    maximum=torch.where(mask.any(1).unsqueeze(-1),maximum,torch.zeros_like(maximum))
    return torch.cat([mean,maximum],-1)

class CommanderModel(nn.Module):
    def __init__(self,vocabulary,encoding='graph-plan-v2'):
        super().__init__();self.vocabulary=vocabulary;self.encoding=encoding
        self.names=nn.Embedding(len(vocabulary)+1,16)
        self.entity0=nn.Linear(80,64);self.entity1=nn.Linear(128,64)
        self.region0=nn.Linear(16,32);self.region1=nn.Linear(64,32)
        self.product0=nn.Linear(40,64);self.product1=nn.Linear(128,64)
        self.goal0=nn.Linear(112,64);self.place0=nn.Linear(32,64);self.task0=nn.Linear(32,32)
        self.world0=nn.Linear(608,128);self.memory=nn.GRUCell(128,HIDDEN)
        self.queue0=nn.Linear(224,64);self.queueSpecial=nn.Linear(64,4)
        self.queueParameter=nn.Linear(128,11);self.queueContext=nn.Linear(144,64)
        self.queueSpecialKeys=nn.Parameter(torch.randn(4,64)*.05)
        self.slots=nn.Embedding(SLOTS,16);self.kindEmbedding=nn.Embedding(11,16)
        self.taskQuery=nn.Linear(240,64);self.kind=nn.Linear(64,11);self.goalQuery=nn.Linear(80,64)
        self.engagement=nn.Linear(64,8);self.roleKeys=nn.Linear(144,64);self.unitQuery=nn.Linear(192,64)
        self.roleSpecialKeys=nn.Parameter(torch.randn(4,64)*.05)
        self.building0=nn.Linear(192,64);self.building1=nn.Linear(64,4)
        self.placeQuery=nn.Linear(160,64);self.placeKeep=nn.Linear(64,1)
        self.value0=nn.Linear(HIDDEN,64);self.value1=nn.Linear(64,1)
        self.editGate=None
        self.change_encoding(encoding)
    def change_encoding(self,encoding):
        if encoding not in ['graph-plan-v1','graph-plan-v2','graph-plan-v3']:raise ValueError('Unsupported encoding')
        self.encoding=encoding
        if encoding=='graph-plan-v3' and self.editGate is None:
            self.editGate=nn.Linear(HIDDEN,5)
            nn.init.zeros_(self.editGate.weight);nn.init.constant_(self.editGate.bias,math.log(19.))
        elif encoding!='graph-plan-v3':self.editGate=None
    def encode_world(self,d):
        e=torch.tanh(self.entity0(torch.cat([d['entities'],self.names(d['entityIds'])],-1)))
        e=torch.tanh(self.entity1(torch.cat([e,neighbor_mean(e,d['entityEdges'])],-1)))
        r=torch.tanh(self.region0(d['regions']));r=torch.tanh(self.region1(torch.cat([r,neighbor_mean(r,d['regionEdges'])],-1)))
        p=torch.tanh(self.product0(torch.cat([d['products'],self.names(d['productIds'])],-1)));p=torch.tanh(self.product1(torch.cat([p,neighbor_mean(p,d['productEdges'])],-1)))
        ge=gather_rows(e,d['goalEntity'])*((d['goalEntity']>=0)&d['goalsMask']).unsqueeze(-1)
        goals=torch.tanh(self.goal0(torch.cat([d['goals'],ge,self.names(d['goalIds'])],-1)))
        places=torch.tanh(self.place0(d['placements']));tasks=torch.tanh(self.task0(d['tasks']))
        x=torch.cat([d['global'],summary(e,d['entitiesMask']),summary(r,d['regionsMask']),summary(p,d['productsMask']),
                     summary(tasks,d['tasksMask']),d['queues'].flatten(1),self.names(d['queueIds']).flatten(1)],-1)
        return e,p,goals,places,tasks,torch.tanh(self.world0(x))
    def forward(self,d,hidden,a,return_probabilities=False,encoded=None,bc_factor_boost=0.):
        e,p,g,places,tasks,x=self.encode_world(d) if encoded is None else encoded
        h=self.memory(x,hidden);b=len(h)
        zero=torch.zeros(b,dtype=h.dtype);logp=zero.double();entropy=zero;factors=zero;bc=zero;bc_weight=zero
        probabilities={};domains={}
        def choice(name,logits,mask,selected,valid=None,keep=None):
            nonlocal logp,entropy,factors,bc,bc_weight
            if valid is None:valid=torch.ones(selected.shape,dtype=torch.bool)
            probs=logits.masked_fill(~mask,-1e9).double().softmax(-1)
            selected_valid=mask.gather(-1,selected.unsqueeze(-1)).squeeze(-1)
            if not selected_valid[valid].all():raise ValueError('Recorded action outside mask: '+name)
            lp=probs.double().clamp_min(1e-30).log().gather(-1,selected.unsqueeze(-1)).squeeze(-1)
            ent=-(probs*probs.clamp_min(1e-30).log()).sum(-1)
            active=valid & (mask.sum(-1)>1)
            dims=tuple(range(1,selected.ndim))
            def summed(x):return x.sum(dims) if dims else x
            logp=logp+summed(lp*active);entropy=entropy+summed(ent*active);factors=factors+summed(active.float())
            weight=torch.where(selected!=keep,4.,1.) if keep is not None else torch.ones_like(ent)
            bc=bc+summed(-lp.float()*active*weight);bc_weight=bc_weight+summed(active*weight)
            if bc_factor_boost:
                domain=['production','tasks','units','buildings','placement'][int(name[4:])] if name.startswith('edit') else 'production' if name.startswith(('queue','amount','cash')) else 'tasks' if name in ['kind','goal','engagement'] else 'units' if name=='unit' else 'buildings' if name=='building' else 'placement'
                keep_mask=active&(selected==keep) if keep is not None else torch.zeros_like(active)
                changed=active&~keep_mask
                importance=1.
                if name=='unit':importance=torch.where(selected==17,float(bc_factor_boost),min(float(bc_factor_boost),4.))
                elif name.startswith('place'):importance=min(float(bc_factor_boost),8.)
                elif name.startswith('queue') or name in ['kind','building']:importance=min(float(bc_factor_boost),4.)
                elif name.startswith('edit'):importance=min(float(bc_factor_boost),4.)
                terms=(summed(-lp.float()*changed*importance),summed(-lp.float()*keep_mask),summed(changed.float()),summed(keep_mask.float()))
                old=domains.get(domain,(zero,zero,zero,zero));domains[domain]=tuple(x+y for x,y in zip(old,terms))
            if return_probabilities:probabilities[name]=probs
            return selected
        gate_logits=self.editGate(h) if self.editGate is not None else None
        def edit(index,required=None,available=None):
            if gate_logits is None:return torch.ones(b,dtype=torch.bool)
            if required is None:required=torch.zeros(b,dtype=torch.bool)
            if available is None:available=torch.ones(b,dtype=torch.bool)
            logits=torch.stack([zero,gate_logits[:,index]],-1)
            return choice(f'edit{index}',logits,torch.stack([~required,available],-1),a['edits'][:,index],keep=0).bool()
        edit_production=edit(0)
        context=torch.zeros((b,64),dtype=h.dtype)
        queue_queries=[]
        for q in range(6):
            query=torch.tanh(self.queue0(torch.cat([h,d['queues'][:,q],self.names(d['queueIds'][:,q]),context],-1)))
            queue_queries.append(query)
            logits=torch.cat([self.queueSpecial(query),torch.einsum('bd,bnd->bn',query,p)/8],-1)
            mask=torch.cat([torch.ones((b,4),dtype=torch.bool),d['productsMask']&(d['productQueue']==q)],-1)
            mask&=edit_production[:,None]|(torch.arange(mask.shape[-1])[None,:]==0)
            selected=choice(f'queue{q}',logits,mask,a['queues'][:,q],keep=0)
            product=gather_rows(p,(selected-4).clamp_min(0)[:,None]).squeeze(1)
            special=self.queueSpecialKeys[selected.clamp_max(3)]
            key=torch.where((selected>=4)[:,None],product,special)
            param=self.queueParameter(torch.cat([query,key],-1));active=selected>=4
            for name,logit,label,size in [('amount',param[:,:5],a['amounts'][:,q],5),('cash',param[:,5:],a['cash'][:,q],6)]:
                m=active[:,None].expand(-1,size)|((torch.arange(size)[None,:]==0)&~active[:,None])
                choice(f'{name}{q}',logit,m,label,valid=active)
            coded=torch.cat([torch.nn.functional.one_hot(a['amounts'][:,q],5),torch.nn.functional.one_hot(a['cash'][:,q],6),
                              torch.nn.functional.one_hot(selected.clamp_max(4),5)],-1).float()
            context=torch.tanh(self.queueContext(torch.cat([context,key,coded],-1)))
        slot=self.slots(torch.arange(SLOTS))[None].expand(b,-1,-1)
        tq=torch.tanh(self.taskQuery(torch.cat([h[:,None].expand(-1,SLOTS,-1),tasks,slot,context[:,None].expand(-1,SLOTS,-1)],-1)))
        edit_tasks=edit(1)
        km=torch.ones((b,SLOTS,11),dtype=torch.bool);km[:,:,1]=d['previousKind']>=2
        km[:,:,7]=(d['goalKind']==6).any(1)[:,None]
        km&=edit_tasks[:,None,None]|(torch.arange(11)[None,None,:]==0)
        choice('kind',self.kind(tq),km,a['kinds'],keep=0)
        kind=a['kinds'];ke=self.kindEmbedding(torch.where(kind==0,d['previousKind'],kind))
        gq=torch.tanh(self.goalQuery(torch.cat([tq,ke],-1)))
        gl=torch.einsum('bsd,bgd->bsg',gq,g)/8
        goal_kinds=d['goalKind'][:,None,:]
        gm=d['goalsMask'][:,None,:].expand(-1,SLOTS,-1)&(goal_kinds!=0)
        gm=torch.where((kind==8)[:,:,None],d['goalsMask'][:,None,:]&((goal_kinds==0)|(goal_kinds==5)),gm)
        gm=torch.where((kind==7)[:,:,None],d['goalsMask'][:,None,:]&(goal_kinds==6),gm)
        active=(kind>=2)&(kind!=10)
        gm=torch.where(active[:,:,None],gm,torch.arange(g.shape[1])[None,None,:]==d['previousGoal'][:,:,None])
        choice('goal',gl,gm,a['goals'],valid=active)
        em=active[:,:,None].expand(-1,-1,8)|((torch.arange(8)[None,None,:]==0)&~active[:,:,None])
        choice('engagement',self.engagement(tq),em,a['engagement'],valid=active)
        actual_kind=torch.where(kind==0,d['previousKind'],kind)
        actual_goal=torch.where(kind==0,d['previousGoal'],a['goals'])
        actual_goal=torch.where((actual_kind<2)|(actual_kind==10),torch.zeros_like(actual_goal),actual_goal)
        task_keys=torch.tanh(self.roleKeys(torch.cat([tq,gather_rows(g,actual_goal),self.kindEmbedding(actual_kind)],-1)))
        unit_e=gather_rows(e,d['unitIndex']);uq=torch.tanh(self.unitQuery(torch.cat([unit_e,h[:,None].expand(-1,unit_e.shape[1],-1)],-1)))
        role_keys=torch.cat([task_keys,self.roleSpecialKeys[None].expand(b,-1,-1)],1)
        ul=torch.einsum('bud,brd->bur',uq,role_keys)/8
        allowed=~d['unitCap'][:,:,3,None]&(actual_kind[:,None,:]>=2)&((actual_kind[:,None,:]!=8)|d['unitCap'][:,:,0,None])&((actual_kind[:,None,:]!=7)|d['unitCap'][:,:,1,None])
        previous=d['previousRole'];previous_allowed=allowed.gather(-1,previous.clamp_max(SLOTS-1).unsqueeze(-1)).squeeze(-1)
        special=torch.stack([torch.ones_like(previous,dtype=torch.bool),d['unitCap'][:,:,2],(previous>=SLOTS)|previous_allowed,torch.ones_like(previous,dtype=torch.bool)],-1)
        um=torch.cat([allowed,special],-1)
        if self.encoding!='graph-plan-v1':
            before=d['previousKind'].gather(1,previous.clamp_max(SLOTS-1))
            after=actual_kind.gather(1,previous.clamp_max(SLOTS-1))
            changed=(previous<SLOTS)&(before!=after)
            um[:,:,18]&=~changed
            duplicate=(previous!=17)&um[:,:,18]
            um=um&~(torch.nn.functional.one_hot(previous,20).bool()&duplicate[:,:,None])
        edit_units=edit(2,required=((~um[:,:,18])&d['unitIndexMask']).any(1),available=d['unitIndexMask'].any(1))
        um&=edit_units[:,None,None]|(torch.arange(20)[None,None,:]==18)
        choice('unit',ul,um,a['units'],valid=d['unitIndexMask'],keep=18)
        building_e=gather_rows(e,d['buildingIndex']);bq=torch.tanh(self.building0(torch.cat([building_e,h[:,None].expand(-1,building_e.shape[1],-1)],-1)))
        bm=torch.stack([torch.ones_like(d['buildingCap'][:,:,0]),d['buildingCap'][:,:,0],d['buildingCap'][:,:,0],d['buildingCap'][:,:,1]],-1)
        edit_buildings=edit(3,available=d['buildingIndexMask'].any(1))
        bm&=edit_buildings[:,None,None]|(torch.arange(4)[None,None,:]==0)
        choice('building',self.building1(bq),bm,a['buildings'],valid=d['buildingIndexMask'],keep=0)
        edit_placements=edit(4,available=d['placementsMask'].any(1))
        for q in range(2):
            pq=torch.tanh(self.placeQuery(torch.cat([h,d['queues'][:,q],self.names(d['queueIds'][:,q])],-1)))
            pl=torch.cat([self.placeKeep(pq),torch.einsum('bd,bnd->bn',pq,places)/8],-1)
            pm=torch.cat([torch.ones((b,1),dtype=torch.bool),d['placementsMask']&(d['placementQueue']==q)],-1)
            pm&=edit_placements[:,None]|(torch.arange(pm.shape[-1])[None,:]==0)
            choice(f'place{q}',pl,pm,a['placements'][:,q],keep=0)
        value=torch.sigmoid(self.value1(torch.tanh(self.value0(h)))).squeeze(-1)
        if bc_factor_boost:
            # Explicit per-frame objective: each domain has one aggregate KEEP
            # negative plus each changed factor. The outer frame mean is exactly
            # compatible with the trainer's global valid-frame DDP weighting.
            domain_loss=zero;domain_count=zero
            for changed_loss,keep_loss,changed_count,keep_count in domains.values():
                count=changed_count+(keep_count>0)
                domain_loss=domain_loss+(changed_loss+keep_loss/keep_count.clamp_min(1))/count.clamp_min(1)
                domain_count=domain_count+(count>0)
            bc_loss=domain_loss/domain_count.clamp_min(1)
        else:bc_loss=bc/bc_weight.clamp_min(1)
        return {'logp':logp,'entropy':entropy/factors.clamp_min(1),'value':value,'hidden':h,
                'bcLoss':bc_loss,'factors':factors,'probabilities':probabilities}

def export(model,path,metadata):
    import json,hashlib
    artifact={'format':'warbook-commander-model-v1','schema':'commander-v1','encoding':model.encoding,'hidden':HIDDEN,
      'vocabulary':model.vocabulary,'tensors':{name:{'shape':list(t.shape),'values':t.detach().cpu().reshape(-1).tolist()} for name,t in model.state_dict().items()},'training':metadata}
    path.write_text(json.dumps(artifact,separators=(',',':'))+'\n')
    return hashlib.sha256(path.read_bytes()).hexdigest()
