"""Small shared unit/target policy for actual native movement and attack orders."""
import json,hashlib
import torch
from torch import nn

def pack(worlds):
    b=len(worlds);n=max(1,max(len(w['entities']) for w in worlds));u=max(1,max(w['ownCount'] for w in worlds));c=max(1,max((len(row) for w in worlds for row in w['candidates']),default=1))
    d={'entities':torch.zeros(b,n,20),'own':torch.zeros(b,n,dtype=torch.bool),'enemy':torch.zeros(b,n,dtype=torch.bool),
       'global':torch.tensor([w['global'] for w in worlds]),'candidates':torch.zeros(b,u,c,24),'targets':torch.zeros(b,u,c,dtype=torch.long),
       'targetMask':torch.zeros(b,u,c,dtype=torch.bool),'mask':torch.zeros(b,u,c,dtype=torch.bool),'units':torch.zeros(b,u,dtype=torch.bool)}
    d['mask'][:,:,0]=True
    for i,w in enumerate(worlds):
        ne=len(w['entities']);nu=w['ownCount']
        if ne:d['entities'][i,:ne]=torch.tensor(w['entities'])
        d['own'][i,:nu]=True;d['enemy'][i,nu:ne]=True;d['units'][i,:nu]=True
        for j,row in enumerate(w['candidates']):
            nc=len(row);d['candidates'][i,j,:nc]=torch.tensor(row);d['mask'][i,j,:nc]=True
            d['targets'][i,j,:nc]=torch.tensor(w['targets'][j]).clamp_min(0);d['targetMask'][i,j,:nc]=torch.tensor(w['targets'][j])>=0
    return d

class TacticalModel(nn.Module):
    def __init__(self):
        super().__init__();self.entity0=nn.Linear(20,48);self.entity1=nn.Linear(48,48)
        self.context=nn.Linear(112,64);self.query=nn.Linear(112,64);self.key=nn.Linear(72,64)
        self.value0=nn.Linear(64,32);self.value1=nn.Linear(32,1)
    def forward(self,d,choices):
        e=torch.tanh(self.entity1(torch.tanh(self.entity0(d['entities']))))
        def pool(mask):return (e*mask[:,:,None]).sum(1)/mask.sum(1).clamp_min(1)[:,None]
        h=torch.tanh(self.context(torch.cat([d['global'],pool(d['own']),pool(d['enemy'])],-1)))
        b,u,c=d['mask'].shape
        own=e[:,:u]
        if own.shape[1]<u:own=torch.nn.functional.pad(own,(0,0,0,u-own.shape[1]))
        query=torch.tanh(self.query(torch.cat([own,h[:,None].expand(-1,u,-1)],-1)))
        targets=e[torch.arange(b)[:,None,None],d['targets']]*d['targetMask'][:,:,:,None]
        key=torch.tanh(self.key(torch.cat([d['candidates'],targets],-1)))
        logits=(key*query[:,:,None]).sum(-1)/8
        logprobs=logits.masked_fill(~d['mask'],-1e9).log_softmax(-1)
        selected=logprobs.gather(-1,choices[:,:,None]).squeeze(-1)*d['units']
        entropy=-(logprobs.exp()*logprobs).sum(-1)*d['units']
        return {'logp':selected.sum(-1),'bc':-selected.sum(-1)/d['units'].sum(-1).clamp_min(1),
                'entropy':entropy.sum(-1)/d['units'].sum(-1).clamp_min(1),
                'value':torch.sigmoid(self.value1(torch.tanh(self.value0(h)))).squeeze(-1),'probabilities':logprobs.exp()}

def load(path):
    artifact=json.loads(path.read_text())
    if artifact['format']!='warbook-armor-skill-v1':raise ValueError('Wrong tactical format')
    model=TacticalModel();model.load_state_dict({k:torch.tensor(v['values']).reshape(v['shape']) for k,v in artifact['tensors'].items()});return model

def export(model,path,training):
    a={'format':'warbook-armor-skill-v1','tensors':{k:{'shape':list(v.shape),'values':v.detach().flatten().tolist()} for k,v in model.state_dict().items()},'training':training}
    path.write_text(json.dumps(a,separators=(',',':'))+'\n');return hashlib.sha256(path.read_bytes()).hexdigest()
