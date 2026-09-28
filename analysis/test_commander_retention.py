"""Mechanism tests for teacher-prefix KL; these make no gameplay claim."""
import copy
import math
import unittest

import torch

from commander_model import CommanderModel,HIDDEN,pack,pack_actions
from commander_retention import build_teacher_cache,conditional_kl,reconstruct_hidden,retention_batch


def fixture(step=0,units=1,buildings=0,products=True,placements=False):
    count=units+buildings
    world={'tick':step*75,'global':[step/7.]+[0.]*31,
      'entities':[[1.,index/10.,step/13.]+[0.]*61 for index in range(count)],
      'entityEdges':[[index,index+1] for index in range(count-1)],
      'regions':[[0.]*16],'regionEdges':[],
      'products':[[0.]*24,[0.]*24] if products else [],'productEdges':[],
      'goals':[[0.]*32,[0.]*32],'tasks':[[step/19.]+[0.]*31 for _ in range(16)],
      'placements':[[0.]*32] if placements else [],
      'queues':[[0.]*16 for _ in range(6)],'queueNames':['']*6,
      'entityNames':['MTNK']*units+['GAPOWR']*buildings,
      'goalEntities':[-1,-1],'goalNames':['',''],
      'unitIndices':list(range(units)),'buildingIndices':list(range(units,count)),
      'ownRefs':[str(index) for index in range(count)],'unitRefs':[str(index) for index in range(units)],
      'buildingRefs':[str(index) for index in range(units,count)],
      'productNames':['GAPOWR','MTNK'] if products else [],'productQueues':[0,3] if products else [],
      'goalObjects':[{'x':0,'y':0,'kind':'native'},{'x':8,'y':8,'kind':'start'}],
      'placementObjects':[{'queue':0}] if placements else [],
      'previousRoles':[19]*units,'previousKinds':[1]*16,'previousGoals':[0]*16,
      'unitCapabilities':[{'miner':False,'engineer':False,'deploy':index==0,'building':False} for index in range(units)],
      'buildingCapabilities':[{'repair':True,'sell':True} for _ in range(buildings)]}
    action={'queues':[0]*6,'amounts':[0]*6,'cash':[0]*6,'kinds':[0]*16,
      'goals':[0]*16,'engagement':[0]*16,'units':[18]*units,'buildings':[0]*buildings,'placements':[0,0]}
    return world,action


def episode(name='actual',length=6):
    return {'path':name,'rows':[{'world':fixture(i,units=i%3,buildings=i%2,products=i%2==0,placements=i%2==1)[0],
             'hidden':[99.]*HIDDEN,'executionSource':'teacher' if i%2 else 'policy'} for i in range(length)]}


def factor(probabilities,active=None):
    probabilities=torch.tensor(probabilities,dtype=torch.float64)
    return {'probabilities':probabilities,'log_probabilities':probabilities.log(),
            'mask':probabilities>0,'active':torch.ones(probabilities.shape[:-1],dtype=torch.bool) if active is None else torch.tensor(active)}


class RetentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def model(self,encoding='graph-plan-v4',temperature=.2):
        torch.manual_seed(47)
        kwargs={'production_temperatures':{'amount':2.,'cash':3.}} if encoding=='graph-plan-v4' else {}
        return CommanderModel(['GAPOWR','MTNK'],encoding,temperature,**kwargs)

    def test_sampled_complete_chain_matches_forced_scoring_without_mutating_actions(self):
        for encoding in ['graph-plan-v1','graph-plan-v2','graph-plan-v3','graph-plan-v4']:
            with self.subTest(encoding=encoding):
                model=self.model(encoding);worlds=[fixture(i,i,1,placements=True)[0] for i in range(3)]
                data=pack(worlds,model.vocabulary);hidden=torch.zeros(3,HIDDEN)
                sampled=model(data,hidden,return_probabilities=True,return_conditionals=True,
                              generator=torch.Generator().manual_seed(3))
                actions=sampled['actions'];before={name:value.clone() for name,value in actions.items()}
                forced=model(data,hidden,actions,return_probabilities=True)
                self.assertEqual(set(forced),{'logp','entropy','value','hidden','bcLoss','factors','probabilities'})
                for name in ['logp','entropy','value','hidden','bcLoss','factors']:
                    self.assertTrue(torch.equal(sampled[name],forced[name]),name)
                for name in forced['probabilities']:
                    self.assertTrue(torch.equal(sampled['probabilities'][name],forced['probabilities'][name]),name)
                for name,value in before.items():self.assertTrue(torch.equal(actions[name],value),name)
                self.assertEqual(set(actions)-{'edits'}, {'queues','amounts','cash','kinds','goals','engagement','units','buildings','placements'})

    def test_low_temperature_and_variable_masks_are_finite_on_their_support(self):
        model=self.model(temperature=.001)
        with torch.no_grad():model.queueSpecial.bias.mul_(10000)
        data=pack([fixture(0,0,0,False)[0],fixture(1,4,2,True,True)[0]],model.vocabulary)
        prediction=model(data,torch.zeros(2,HIDDEN),return_conditionals=True,generator=torch.Generator().manual_seed(5))
        for name,term in prediction['conditionals'].items():
            self.assertTrue(torch.isfinite(term['log_probabilities'][term['mask']]).all(),name)
            self.assertTrue(torch.isfinite(term['probabilities']).all(),name)
            self.assertTrue((term['probabilities'][~term['mask']]==0).all(),name)
            self.assertTrue((~term['active'] | (term['mask'].sum(-1)>1)).all(),name)
        for name in ['logp','entropy','bcLoss']:self.assertTrue(torch.isfinite(prediction[name]).all(),name)
        self.assertFalse(prediction['conditionals']['unit']['active'][0].any())
        self.assertFalse(prediction['conditionals']['building']['active'][0].any())
        self.assertFalse(prediction['conditionals']['place0']['active'][0])

    def test_teacher_prefix_sum_matches_hand_computed_joint_forward_kl(self):
        teacher={'first':factor([[.75,.25],[.75,.25]]),'second':factor([[.9,.1],[.2,.8]])}
        student={'first':factor([[.5,.5],[.5,.5]]),'second':factor([[.6,.4],[.7,.3]])}
        terms=conditional_kl(teacher,student)
        decomposed=float(terms@torch.tensor([.75,.25],dtype=torch.float64))
        joint_teacher=[.675,.075,.05,.2];joint_student=[.3,.2,.35,.15]
        direct=sum(p*math.log(p/q) for p,q in zip(joint_teacher,joint_student))
        self.assertAlmostEqual(decomposed,direct,places=14)
        # An unweighted average over prefixes is a different objective.
        self.assertGreater(abs(float(terms.mean())-direct),.01)

    def test_singleton_and_inactive_factors_are_zero_and_teacher_is_detached(self):
        teacher={'active':factor([[.8,.2]]),'forced':factor([[1.,0.]],active=[False]),
                 'absent':factor([[[.8,.2]]],active=[[False]])}
        student={'active':factor([[.4,.6]]),'forced':factor([[1.,0.]],active=[False]),
                 'absent':factor([[[.1,.9]]],active=[[False]])}
        for side in [teacher,student]:
            for term in side.values():term['log_probabilities'].requires_grad_()
        loss=conditional_kl(teacher,student).sum();loss.backward()
        self.assertAlmostEqual(float(loss.detach()),.8*math.log(2)+.2*math.log(1/3),places=14)
        for term in teacher.values():self.assertIsNone(term['log_probabilities'].grad)
        for name in ['forced','absent']:
            self.assertTrue((student[name]['log_probabilities'].grad==0).all())
        mismatched=copy.deepcopy(student);mismatched['forced']['mask'][0,1]=True
        with self.assertRaisesRegex(ValueError,'mask mismatch'):conditional_kl(teacher,mismatched)

    def test_cloned_policy_has_near_zero_kl_and_gradient(self):
        teacher=self.model();student=copy.deepcopy(teacher)
        sources=[episode('first',7),episode('second',4)]
        cache=build_teacher_cache(teacher,sources,seed=7,chunk_size=3)
        loss,count,stats=retention_batch(student,teacher,cache,[(sources[0],3,7),(sources[1],1,3)],chunk_size=2)
        self.assertEqual(count,6);self.assertEqual(stats['prefix_frames'],4);self.assertEqual(stats['anchor_frames'],6)
        self.assertLess(abs(float(loss.detach())),1e-10)
        loss.backward()
        self.assertTrue(all(parameter.grad is not None for parameter in student.parameters()))
        self.assertLess(max(float(parameter.grad.abs().max()) for parameter in student.parameters()),2e-5)
        self.assertTrue(all(parameter.grad is None for parameter in teacher.parameters()))

    def test_perturbed_policy_has_positive_loss_and_gradient(self):
        teacher=self.model();student=copy.deepcopy(teacher);source=episode()
        cache=build_teacher_cache(teacher,[source],seed=17)
        with torch.no_grad():student.queueSpecial.bias[1].add_(.2)
        loss,count,_=retention_batch(student,teacher,cache,[(source,2,6)])
        self.assertEqual(count,4);self.assertGreater(float(loss.detach()),.01)
        loss.backward();self.assertGreater(float(student.queueSpecial.bias.grad.abs().max()),.01)
        self.assertTrue(torch.isfinite(student.queueSpecial.bias.grad).all())
        self.assertTrue((student.value0.weight.grad==0).all())

    def test_cache_is_fixed_uses_private_rng_and_keeps_worlds_by_reference(self):
        teacher=self.model();source=episode();before=copy.deepcopy(source)
        torch.manual_seed(321);rng=torch.random.get_rng_state().clone()
        first=build_teacher_cache(teacher,[source],seed=47,chunk_size=2)
        self.assertTrue(torch.equal(torch.random.get_rng_state(),rng))
        second=build_teacher_cache(teacher,[source],seed=47,chunk_size=2)
        self.assertEqual(first['episodes']['actual']['actions'],second['episodes']['actual']['actions'])
        self.assertEqual(source,before)
        self.assertIs(first['episodes']['actual']['rows'],source['rows'])
        self.assertEqual(first['preparation_frames'],6)
        hidden=first['episodes']['actual']['hidden'].clone()
        retention_batch(copy.deepcopy(teacher),teacher,first,[(source,1,3)])
        self.assertTrue(torch.equal(hidden,first['episodes']['actual']['hidden']))
        self.assertEqual(first['episodes']['actual']['actions'],second['episodes']['actual']['actions'])

    def test_current_weight_prefix_matches_actual_history_including_interventions(self):
        model=self.model();source=episode();stop=4
        actual=reconstruct_hidden(model,source,stop,chunk_size=2)
        expected=torch.zeros(1,HIDDEN)
        with torch.no_grad():
            for row in source['rows'][:stop]:
                data=pack([row['world']],model.vocabulary)
                expected=model(data,expected,generator=torch.Generator().manual_seed(1))['hidden']
        torch.testing.assert_close(actual,expected,rtol=1e-5,atol=1e-7)
        self.assertFalse(actual.requires_grad)
        with torch.no_grad():model.memory.bias_ih.add_(.15)
        changed=reconstruct_hidden(model,source,stop,chunk_size=2)
        self.assertGreater(float((actual-changed).abs().max()),.01)

    def test_student_rebuilds_own_prefix_without_gradient_before_selected_window(self):
        teacher=self.model();student=copy.deepcopy(teacher);source=episode()
        cache=build_teacher_cache(teacher,[source],seed=37)
        with torch.no_grad():student.memory.bias_ih.add_(.15)
        expected=reconstruct_hidden(student,source,3);seen=[];modes=[]
        handle=student.register_forward_pre_hook(lambda module,args:seen.append(args[1].detach().clone()))
        memory_handle=student.memory.register_forward_hook(lambda module,args,result:modes.append(torch.is_grad_enabled()))
        try:loss,count,_=retention_batch(student,teacher,cache,[(source,3,6)])
        finally:handle.remove();memory_handle.remove()
        torch.testing.assert_close(seen[0],expected)
        self.assertGreater(float((seen[0]-cache['episodes']['actual']['hidden'][3:4]).abs().max()),.01)
        self.assertEqual(modes,[False]*3+[True]*3)
        self.assertEqual(count,3);loss.backward()
        self.assertGreater(float(student.memory.bias_ih.grad.abs().max()),0.)

    def test_keep_uses_retyped_slot_in_actual_world_and_kind_change_disables_keep_unit(self):
        teacher=self.model();before,action=fixture(units=1)
        before['previousKinds'][3]=8
        after=copy.deepcopy(before);after['previousKinds'][3]=9
        with torch.no_grad():
            teacher.kind.weight.zero_();teacher.kind.bias.fill_(-100);teacher.kind.bias[0]=100
        data=pack([before,after],teacher.vocabulary);packed=pack_actions([action,action],data)
        reference=teacher(data,torch.zeros(2,HIDDEN),packed,return_conditionals=True)
        self.assertFalse(reference['conditionals']['unit']['mask'][0,0,3])
        self.assertTrue(reference['conditionals']['unit']['mask'][1,0,3])
        source={'path':'retyped','rows':[{'world':before},{'world':after}]}
        cache=build_teacher_cache(teacher,[source],seed=3)
        self.assertTrue(all(a['kinds']==[0]*16 for a in cache['episodes']['retyped']['actions']))
        changed=copy.deepcopy(before);changed['previousRoles'][0]=3
        changed_action=copy.deepcopy(action);changed_action['kinds'][3]=9;changed_action['goals'][3]=1;changed_action['units'][0]=3
        data=pack([changed],teacher.vocabulary)
        prediction=teacher(data,torch.zeros(1,HIDDEN),pack_actions([changed_action],data),return_conditionals=True)
        self.assertFalse(prediction['conditionals']['unit']['mask'][0,0,18])
        self.assertTrue(prediction['conditionals']['unit']['mask'][0,0,3])

    def test_empty_rank_touches_all_parameters_and_configuration_changes_reject(self):
        teacher=self.model();student=copy.deepcopy(teacher);cache=build_teacher_cache(teacher,[])
        loss,count,stats=retention_batch(student,teacher,cache,[]);loss.backward()
        self.assertEqual(count,0);self.assertEqual(stats['prefix_frames'],0)
        self.assertTrue(all(p.grad is not None and (p.grad==0).all() for p in student.parameters()))
        student.change_production_temperatures({'amount':1.})
        with self.assertRaisesRegex(ValueError,'configuration mismatch'):retention_batch(student,teacher,cache,[])
        student=copy.deepcopy(teacher)
        with torch.no_grad():teacher.queueSpecial.bias.add_(.01)
        with self.assertRaisesRegex(ValueError,'teacher changed'):retention_batch(student,teacher,cache,[])


if __name__=='__main__':unittest.main()
