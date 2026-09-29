"""KEEP parameterization mechanisms; no optimizer steps or gameplay claims."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import torch

from commander_model import (CommanderModel,HIDDEN,export,member_keep_eligible,pack,pack_actions,
    recorded_member_scoring_config,validate_member_scoring)
from test_commander_retention import fixture


R={'mode':'separate-v1'}
M={'mode':'current-task-keep-v1'}
I={'mode':'keep-bias-v1','bias':1.25}


def member_fixture(previous=0,before=3,after=3,units=1):
    world,action=fixture(units=units,products=True)
    world['previousKinds'][:2]=[before,4]
    world['previousGoals'][:2]=[1,1]
    world['previousRoles']=[previous]*units
    world['goals'][1]=[.6,-.3,.9]+[0.]*29
    if after in [7,8]:world['goalObjects'][1]['kind']='tech' if after==7 else 'ore'
    world['goals'].append([-.7,.8,-.4]+[0.]*29)
    world['goalNames'].append('');world['goalEntities'].append(-1)
    world['goalObjects'].append({'kind':'region','x':2,'y':3})
    action['kinds'][0]=after
    action['goals'][:2]=[1,1]
    action['units']=[18]*units
    if previous==0 and (before!=after or after<2 or after in [7,8]):
        action['units']=[19]*units
    return world,action


def prepared(model,worlds=None,actions=None):
    if worlds is None:
        world,action=member_fixture();worlds=[world];actions=[action]
    d=pack(worlds,model.vocabulary)
    return d,torch.zeros(len(worlds),HIDDEN),pack_actions(actions,d)


def capture(model,d,hidden,action):
    """Observe existing module outputs without changing scores or parameters."""
    values={}
    def hook(name):
        def save(_module,_args,output):
            values[name]=output
            if output.requires_grad:output.retain_grad()
        return save
    handles=[model.unitQuery.register_forward_hook(hook('unit')),
             model.roleKeys.register_forward_hook(hook('task'))]
    try:result=model(d,hidden,action,return_probabilities=True,return_conditionals=True)
    finally:
        for handle in handles:handle.remove()
    query=torch.tanh(values['unit'])
    keys=torch.cat([torch.tanh(values['task']),model.roleSpecialKeys[None].expand(len(hidden),-1,-1)],1)
    raw=torch.einsum('bud,brd->bur',query,keys)/8
    return result,raw,values


class MemberScoringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def model(self,mode=R,temperature=.2,encoding='graph-plan-v4'):
        torch.manual_seed(928610)
        return CommanderModel(['GAPOWR','MTNK'],encoding,temperature,member_scoring=mode)

    def assert_prediction_equal(self,left,right):
        for key in ['logp','entropy','value','hidden','bcLoss','factors']:
            self.assertTrue(torch.equal(left[key],right[key]),key)
        for name in left['conditionals']:
            for key in ['probabilities','log_probabilities','mask','active']:
                self.assertTrue(torch.equal(left['conditionals'][name][key],right['conditionals'][name][key]),(name,key))

    def test_canonical_configuration_validation_and_encoding_guard(self):
        for encoding in ['graph-plan-v1','graph-plan-v2','graph-plan-v3','graph-plan-v4']:
            self.assertEqual(validate_member_scoring(encoding),R)
            self.assertEqual(validate_member_scoring(encoding,R),R)
            self.assertEqual(recorded_member_scoring_config({'encoding':encoding}),R)
            if encoding!='graph-plan-v4':
                for config in [M,I]:
                    with self.subTest(encoding=encoding,config=config),self.assertRaisesRegex(ValueError,'requires graph-plan-v4'):
                        self.model(config,encoding=encoding)
        for config in [None,[],{},'separate-v1',{'mode':'unknown'},{'mode':'separate-v1','bias':0},
                       {'mode':'current-task-keep-v1','bias':1},{'mode':'keep-bias-v1'},
                       {'mode':'keep-bias-v1','bias':0,'other':0}]:
            with self.subTest(config=config),self.assertRaises(ValueError):validate_member_scoring('graph-plan-v4',config)
        for bias in [True,None,'1',-1,float('nan'),float('inf'),-float('inf'),10**400]:
            with self.subTest(bias=bias),self.assertRaises(ValueError):
                validate_member_scoring('graph-plan-v4',{'mode':'keep-bias-v1','bias':bias})
        with self.assertRaises(ValueError):recorded_member_scoring_config({'encoding':'graph-plan-v4','memberScoring':None})
        config={'mode':'keep-bias-v1','bias':2};model=self.model(config)
        config['bias']=10
        self.assertEqual(model.member_scoring,{'mode':'keep-bias-v1','bias':2.})
        with self.assertRaises(ValueError):model.change_encoding('graph-plan-v2')
        self.assertEqual(model.encoding,'graph-plan-v4')
        model.change_member_scoring();model.change_encoding('graph-plan-v2')
        self.assertEqual(model.member_scoring,R)

    def test_new_exports_are_explicit_without_tensor_or_parameter_changes(self):
        model=self.model();original=copy.deepcopy(model.state_dict())
        with tempfile.TemporaryDirectory() as directory:
            for mode in [R,M,I,{'mode':'keep-bias-v1','bias':0}]:
                model.change_member_scoring(mode)
                path=Path(directory)/'artifact.json';export(model,path,{'check':'only-export'})
                artifact=json.loads(path.read_text())
                self.assertEqual(artifact['memberScoring'],mode)
                self.assertEqual(artifact['training'],{'check':'only-export'})
                self.assertEqual(set(artifact['tensors']),set(original))
                for name,value in original.items():self.assertTrue(torch.equal(value,model.state_dict()[name]),name)

    def test_default_and_zero_bias_are_bitwise_legacy_including_gradients(self):
        for temperature in [.01,.2]:
            legacy=self.model(encoding='graph-plan-v2',temperature=temperature)
            inputs=prepared(legacy)
            expected=legacy(*inputs,return_conditionals=True)
            objective=lambda p: p['logp'].sum()+.13*p['entropy'].sum()+.7*p['value'].sum()+p['bcLoss'].sum()
            objective(expected).backward()
            for mode in [R,{'mode':'keep-bias-v1','bias':0}]:
                model=self.model(mode,temperature);actual=model(*inputs,return_conditionals=True)
                self.assert_prediction_equal(expected,actual)
                objective(actual).backward()
                for (name,left),(_,right) in zip(legacy.named_parameters(),model.named_parameters()):
                    if left.grad is None:self.assertIsNone(right.grad,name)
                    else:self.assertTrue(torch.equal(left.grad,right.grad),name)
            torch.manual_seed(928610)
            omitted=CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',temperature)
            self.assert_prediction_equal(expected,omitted(*inputs,return_conditionals=True))

    def test_merge_matches_added_probability_mass_at_effective_temperature(self):
        for temperature in [1.,.2,.01]:
            model=self.model(temperature=temperature);d,h,a=prepared(model)
            reference,raw,_=capture(model,d,h,a);mask=reference['conditionals']['unit']['mask']
            model.change_member_scoring(M);actual=model(d,h,a,return_conditionals=True)
            logits=raw.detach().double()/temperature
            masses=(logits-logits.max(-1,keepdim=True).values).exp()
            masses[:,:,18]+=masses[:,:,0]
            masses*=mask
            expected=masses/masses.sum(-1,keepdim=True)
            conditional=actual['conditionals']['unit']
            torch.testing.assert_close(conditional['probabilities'],expected,rtol=1e-12,atol=1e-14)
            torch.testing.assert_close(conditional['log_probabilities'][mask],expected[mask].log(),rtol=1e-12,atol=1e-13)
            torch.testing.assert_close(expected.sum(-1),torch.ones_like(expected.sum(-1)),rtol=0,atol=2e-15)
            self.assertFalse(bool(mask[0,0,0]));self.assertEqual(float(expected[0,0,0]),0.)
            self.assertGreater(float(expected[0,0,18]),float(reference['conditionals']['unit']['probabilities'][0,0,18].detach()))
            total_entropy=torch.zeros(1,dtype=torch.float64)
            for term in actual['conditionals'].values():
                probabilities=term['probabilities'];logs=term['log_probabilities']
                ent=-(probabilities*torch.where(probabilities>0,logs,torch.zeros_like(logs))).sum(-1)*term['active']
                total_entropy+=ent.flatten(1).sum(1) if ent.ndim>1 else ent
            torch.testing.assert_close(actual['entropy'],total_entropy/actual['factors'],rtol=0,atol=2e-15)
            for name,term in reference['conditionals'].items():
                if name!='unit':self.assertTrue(torch.equal(term['log_probabilities'],actual['conditionals'][name]['log_probabilities']),name)
            wrong=torch.logaddexp(raw[:,:,18].detach().double(),raw[:,:,0].detach().double())/temperature
            right=torch.logaddexp(logits[:,:,18],logits[:,:,0])
            if temperature!=1.:self.assertGreater(float((wrong-right).abs().max()),.1)

    def test_bias_is_in_effective_units_and_float64_survives_small_temperature(self):
        for temperature in [.01,.2]:
            model=self.model(temperature=temperature);d,h,a=prepared(model)
            reference,raw,_=capture(model,d,h,a)
            model.change_member_scoring(I);actual=model(d,h,a,return_conditionals=True)
            before=reference['conditionals']['unit']['log_probabilities']
            after=actual['conditionals']['unit']['log_probabilities']
            self.assertAlmostEqual(float(((after[:,:,18]-after[:,:,16])-(before[:,:,18]-before[:,:,16])).detach()),I['bias'],places=12)
        model=self.model(temperature=1e-4);d,h,a=prepared(model)
        reference,raw,_=capture(model,d,h,a);keep=raw[0,0,18].detach()
        ulp=torch.nextafter(keep,torch.tensor(float('inf')))-keep
        bias=float(ulp)/(64*model.temperature)
        adjusted=(keep.double()/model.temperature+bias)*model.temperature
        self.assertTrue(torch.equal(adjusted.float(),keep))
        model.change_member_scoring({'mode':'keep-bias-v1','bias':bias})
        actual=model(d,h,a,return_conditionals=True)
        before=reference['conditionals']['unit'];after=actual['conditionals']['unit']
        self.assertFalse(torch.equal(before['log_probabilities'],after['log_probabilities']))
        self.assertTrue(torch.isfinite(after['log_probabilities'][after['mask']]).all())

    def test_retyping_release_special_incompatible_and_padded_rows_stay_unchanged(self):
        cases=[member_fixture(before=3,after=4),member_fixture(before=3,after=1),
               member_fixture(previous=16),member_fixture(previous=17),member_fixture(previous=19),
               member_fixture(before=7,after=7),member_fixture(before=8,after=8),member_fixture(units=0)]
        building_world,building_action=member_fixture();building_world['unitCapabilities'][0]['building']=True
        building_action['units']=[19];cases.append((building_world,building_action))
        model=self.model();d,h,a=prepared(model,[x[0] for x in cases],[x[1] for x in cases])
        reference=model(d,h,a,return_conditionals=True)
        actual_kind=torch.where(a['kinds']==0,d['previousKind'],a['kinds'])
        self.assertFalse(member_keep_eligible(d,actual_kind,reference['conditionals']['unit']['mask']).any())
        for mode in [M,I]:
            model.change_member_scoring(mode)
            actual=model(d,h,a,return_conditionals=True)
            self.assert_prediction_equal(reference,actual)
        for before in [3,10]:
            world,action=member_fixture(before=before,after=before)
            d,h,a=prepared(model,[world],[action]);prediction=model(d,h,a,return_conditionals=True)
            actual_kind=torch.where(a['kinds']==0,d['previousKind'],a['kinds'])
            mask=prediction['conditionals']['unit']['mask']
            self.assertTrue(bool(member_keep_eligible(d,actual_kind,mask)[0,0]))
            no_keep=mask.clone();no_keep[:,:,18]=False
            self.assertFalse(member_keep_eligible(d,actual_kind,no_keep).any())
            unmasked_current=mask.clone();unmasked_current[:,:,0]=True
            self.assertFalse(member_keep_eligible(d,actual_kind,unmasked_current).any())

    def test_same_kind_new_goal_changes_only_dynamic_keep_member_distribution(self):
        model=self.model();world,first=member_fixture();second=copy.deepcopy(first);second['goals'][0]=2
        d,h,a=prepared(model,[world],[first]);_,_,changed=prepared(model,[world],[second])
        for mode in [R,I,M]:
            model.change_member_scoring(mode)
            before=model(d,h,a,return_conditionals=True)['conditionals']['unit']
            after=model(d,h,changed,return_conditionals=True)['conditionals']['unit']
            self.assertTrue(torch.equal(before['mask'],after['mask']))
            if mode==M:self.assertGreater(float((before['probabilities']-after['probabilities']).abs().max().detach()),1e-7)
            else:self.assertTrue(torch.equal(before['log_probabilities'],after['log_probabilities']))

    def test_advantage_gradients_reach_current_and_generic_keep_with_correct_sign(self):
        for selected in [18,1]:
            for advantage in [1.,-1.]:
                model=self.model(M);d,h,a=prepared(model);a['units'][0,0]=selected
                result,_,values=capture(model,d,h,a)
                loss=-advantage*result['conditionals']['unit']['log_probabilities'][0,0,selected]
                loss.backward()
                query=torch.tanh(values['unit'].detach())[0,0]/8
                current_direction=query*(1-torch.tanh(values['task'].detach())[0,0].square())
                current_derivative=float((values['task'].grad[0,0]*current_direction).sum()/current_direction.square().sum())
                keep_derivative=float((model.roleSpecialKeys.grad[2]*query).sum()/query.square().sum())
                expected_sign=(-1 if selected==18 else 1)*advantage
                self.assertGreater(current_derivative*expected_sign,0.)
                self.assertGreater(keep_derivative*expected_sign,0.)
        for mode in [R,I]:
            model=self.model(mode);d,h,a=prepared(model);result,_,values=capture(model,d,h,a)
            (-result['conditionals']['unit']['log_probabilities'][0,0,18]).backward()
            self.assertTrue((values['task'].grad[0,0]==0).all())

    def test_free_chain_and_forced_chain_match_without_input_or_parameter_mutation(self):
        for mode in [R,M,I]:
            for temperature in [.01,.2]:
                model=self.model(mode,temperature)
                worlds=[member_fixture(units=0)[0],member_fixture(units=3)[0]]
                d=pack(worlds,model.vocabulary);hidden=torch.zeros(2,HIDDEN)
                data_before={k:v.clone() for k,v in d.items()};weights=copy.deepcopy(model.state_dict())
                sampled=model(d,hidden,return_conditionals=True,generator=torch.Generator().manual_seed(83))
                actions=sampled['actions'];action_before={k:v.clone() for k,v in actions.items()}
                forced=model(d,hidden,actions,return_conditionals=True)
                self.assert_prediction_equal(sampled,forced)
                self.assertTrue((hidden==0).all())
                for name,value in data_before.items():self.assertTrue(torch.equal(d[name],value),name)
                for name,value in action_before.items():self.assertTrue(torch.equal(actions[name],value),name)
                for name,value in weights.items():self.assertTrue(torch.equal(model.state_dict()[name],value),name)


if __name__=='__main__':unittest.main()
