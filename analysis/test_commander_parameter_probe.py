"""Bounded parameter probe mechanisms, independent of full-game evaluation."""
import copy
import json
import math
import tempfile
import unittest
from pathlib import Path

import torch

from commander_model import CommanderModel,HIDDEN,pack,pack_actions,export
from commander_parameter_probe import (DIRECTIONS,apply_direction,calibrate_center,gate,goal_semantics,
    group_logs,log_odds,make_direction,make_rows,measure,opening,phase_indices,prepare_panel,
    required_scale,score_case,semantic_groups,validate_free_chains,write_golden)
from commander_train import load_model
from test_commander_retention import fixture


def cases_for(model):
    result=[]
    for i in range(2):
        world,action=fixture(i,units=2,buildings=1,placements=True)
        world['previousKinds'][0]=3;world['previousRoles']=[0,0];world['previousGoals'][0]=1
        world['goals'].append([0.]*32);world['goalEntities'].append(-1);world['goalNames'].append('')
        world['goalObjects'].append({'kind':'region','x':3,'y':4})
        action['kinds'][0]=3;action['goals'][0]=1
        data=pack([world],model.vocabulary);packed=pack_actions([action],data);hidden=torch.zeros(1,HIDDEN)
        with torch.no_grad():
            encoded=model.encode_world(data);baseline=model(data,hidden,packed,encoded=encoded,return_conditionals=True)
        case={'source':'source'+str(i),'map':'map'+str(i),'tick':i*75,'world':world,'action':action,
              'data':data,'packedAction':packed,'hidden':hidden,'encoded':encoded,'baseline':baseline}
        case['rows']=make_rows(case,baseline);result.append(case)
    return result


class ParameterProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def model(self):
        torch.manual_seed(83)
        return CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.2,{'amount':1.,'cash':1.})

    def test_predeclared_phase_pairs_are_even_adjacent_and_distinct(self):
        for length in (16,17,80,463,960):
            selected=phase_indices(length)
            self.assertEqual(len(selected),16);self.assertEqual(len({i for i,_,_ in selected}),16)
            self.assertEqual(selected[0][0],0);self.assertEqual(selected[-1][0],length-1)
            for a,b in zip(selected[::2],selected[1::2]):
                self.assertEqual(b[0],a[0]+1);self.assertEqual(b[1],a[1]);self.assertEqual((a[2],b[2]),(0,1))
        with self.assertRaises(ValueError):phase_indices(15)

    def test_failure_source_is_rejected_before_loading_any_episode(self):
        paths=[f'/games/map{m}/opponent{o}/original' for m in range(4) for o in range(4)]
        with self.assertRaisesRegex(ValueError,'Excluded failure'):
            prepare_panel(self.model(),paths,'unused',[paths[3]])

    def test_goal_identity_keeps_native_references_and_fallback_locations(self):
        native={'kind':'native','x':2,'y':3};start={'kind':'start','x':2,'y':3}
        region={'kind':'region','x':2,'y':3,'onBridge':False}
        reference={'kind':'enemy','ref':'a','x':2,'y':3}
        self.assertNotEqual(goal_semantics(native),goal_semantics(start))
        self.assertEqual(goal_semantics(start),goal_semantics(region))
        self.assertNotEqual(goal_semantics(reference),goal_semantics(start))
        self.assertEqual(goal_semantics(reference),goal_semantics({**reference,'kind':'previous'}))
        self.assertNotEqual(goal_semantics(reference),goal_semantics({**reference,'x':4}))
        self.assertNotEqual(goal_semantics(reference),goal_semantics({**reference,'ref':'b'}))
        self.assertNotEqual(goal_semantics(start),goal_semantics({**start,'onBridge':True}))

    def test_alias_probability_transfer_is_not_new_goal_behavior(self):
        world={'goalObjects':[{'kind':'native','x':0,'y':0},{'kind':'start','x':0,'y':0},
          {'kind':'previous','x':0,'y':0},{'kind':'enemy','ref':'x','x':0,'y':0}]}
        groups=semantic_groups(world,torch.ones(4,dtype=torch.bool),'goal')
        self.assertEqual(groups,((0,),(1,2),(3,)))
        before=group_logs(torch.tensor([.1,.7,.1,.1],dtype=torch.float64).log(),groups)
        after=group_logs(torch.tensor([.1,.1,.7,.1],dtype=torch.float64).log(),groups)
        torch.testing.assert_close(before,after,rtol=0,atol=1e-15)

    def test_underflowing_rare_alternative_uses_finite_effective_log_odds(self):
        logits=torch.tensor([0.,-1000.,-2.],dtype=torch.float64);base=logits.log_softmax(0)
        step=.001;trial=(logits+torch.tensor([0.,10*step,0.])).log_softmax(0)
        self.assertEqual(float(base.exp()[1]),0.)
        estimate=required_scale(base,trial,step)
        self.assertEqual(estimate['alternativeGroup'],1)
        self.assertAlmostEqual(estimate['slope'],10.,places=5)
        self.assertAlmostEqual(estimate['scale'],(-math.log(9)-float(log_odds(base,1)))/10.,places=5)

    def test_multimodal_row_can_open_a_rare_goal_without_row_saturation(self):
        base=torch.tensor([.55,.4499,.0001],dtype=torch.float64).log()
        current=torch.tensor([.5,.35,.15],dtype=torch.float64).log()
        self.assertEqual(opening(base,current),(False,False,True,True))
        saturated=torch.tensor([.999999,.000001],dtype=torch.float64).log()
        self.assertEqual(opening(saturated,torch.tensor([.89,.11],dtype=torch.float64).log()),(True,True,True,True))
        self.assertFalse(gate(5,100,{'one'},{'map1','map2'}))
        self.assertFalse(gate(4,100,{'one','two'},{'map1','map2'}))
        self.assertTrue(gate(5,100,{'one','two'},{'map1','map2'}))

    def test_direction_is_seeded_rank_one_augmented_and_exactly_targeted(self):
        model=self.model();rng=torch.random.get_rng_state().clone()
        for name,modules in DIRECTIONS.items():
            direction=make_direction(model,name);again=make_direction(model,name)
            for key in direction['deltas']:self.assertTrue(torch.equal(direction['deltas'][key],again['deltas'][key]))
            plus,bounds=apply_direction(model,direction,1,.2);minus,_=apply_direction(model,direction,-1,.2)
            for module in modules:
                matrix=direction['deltas'][module] if module=='roleSpecialKeys' else torch.cat((direction['deltas'][module+'.weight'],direction['deltas'][module+'.bias'][:,None]),1)
                singular=torch.linalg.svdvals(matrix.double())
                self.assertLess(float(singular[1]/singular[0]),1e-6)
            for key,value in model.state_dict().items():
                if key not in direction['deltas']:
                    self.assertTrue(torch.equal(value,plus.state_dict()[key]),key)
                    self.assertTrue(torch.equal(value,minus.state_dict()[key]),key)
                else:torch.testing.assert_close(plus.state_dict()[key]+minus.state_dict()[key],2*value,rtol=1e-6,atol=1e-7)
            self.assertTrue(all(abs(row['relativeFrobenius']-.2)<1e-6 for row in bounds))
        self.assertTrue(torch.equal(torch.random.get_rng_state(),rng))
        with self.assertRaisesRegex(ValueError,'hard relative'):apply_direction(model,make_direction(model,'D1'),1,2.01)

    def test_measure_excludes_unused_task_slots_and_keeps_production_exact(self):
        model=self.model();cases=cases_for(model)
        for case in cases:
            self.assertEqual([row['position'] for row in case['rows'] if row['family']=='task'],[0])
            self.assertEqual([row['position'] for row in case['rows'] if row['family']=='goal'],[0])
            self.assertEqual(len([row for row in case['rows'] if row['family']=='member']),2)
        clone=measure(copy.deepcopy(model),cases,('task','goal','member'))
        self.assertFalse(clone['usefulOpening'])
        self.assertTrue(all(value['tv']['maximum'] in (None,0.) for value in clone['families'].values()))
        candidate,_=apply_direction(model,make_direction(model,'D4'),1,.5)
        changed=measure(candidate,cases,('task','goal','member'))
        self.assertEqual(changed['families']['queue']['tv']['maximum'],0.)
        self.assertTrue(changed['productionProbabilitiesBitwiseEqual'])
        broken=copy.deepcopy(model)
        with torch.no_grad():broken.queueSpecial.bias[1].add_(.1)
        with self.assertRaisesRegex(ValueError,'production'):score_case(broken,cases[0])

    def test_free_chain_is_not_forced_to_the_baseline_prefix(self):
        model=self.model();cases=cases_for(model);before=copy.deepcopy([case['action'] for case in cases])
        same=validate_free_chains(model,copy.deepcopy(model),cases,19)
        self.assertTrue(all(row['memberAssignmentChanges']==row['taskKindChanges']==row['taskGoalSemanticChanges']==0 for row in same['worlds']))
        candidate,_=apply_direction(model,make_direction(model,'D1'),1,1.)
        checked=validate_free_chains(model,candidate,cases,19)
        self.assertTrue(checked['completeLegalChains']);self.assertTrue(checked['coupledProductionSamplesEqual'])
        self.assertEqual(before,[case['action'] for case in cases])

    def test_export_and_golden_preserve_frozen_state_and_real_history_inputs(self):
        model=self.model();cases=cases_for(model);candidate,_=apply_direction(model,make_direction(model,'D2'),-1,.1)
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'candidate.json';export(candidate,target,{'scope':'unit-test'})
            loaded=load_model(json.loads(target.read_text()))
            for name,value in candidate.state_dict().items():self.assertTrue(torch.equal(value,loaded.state_dict()[name]))
            golden=target.with_suffix('.golden.json');write_golden(candidate,cases,golden)
            samples=json.loads(golden.read_text());self.assertEqual(len(samples),2)
            for sample,case in zip(samples,cases):
                self.assertEqual(sample['hidden'],case['hidden'][0].tolist())
                d=pack([sample['world']],loaded.vocabulary)
                with torch.no_grad():prediction=loaded(d,torch.tensor([sample['hidden']]),pack_actions([sample['action']],d))
                self.assertEqual(float(prediction['logp'][0]),sample['expected']['logp'])


if __name__=='__main__':unittest.main()
