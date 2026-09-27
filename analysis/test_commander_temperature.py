"""v4 production exploration keeps v2 grammar and explicit on-policy provenance."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch

from commander_model import CommanderModel,export,pack,pack_actions,recorded_temperature_config
from commander_sequence import canonical_action
from commander_train import configure_bc_temperature,load_model,validate_ppo_behavior


def fixture():
    world={'tick':0,'global':[0.]*32,'entities':[[1.]+[0.]*63],'entityEdges':[],
      'regions':[[0.]*16],'regionEdges':[],'products':[[0.]*24,[0.]*24],'productEdges':[],
      'goals':[[0.]*32,[0.]*32],'tasks':[[0.]*32 for _ in range(16)],'placements':[],
      'queues':[[0.]*16 for _ in range(6)],'queueNames':['']*6,'entityNames':['MTNK'],
      'goalEntities':[-1,-1],'goalNames':['',''],'unitIndices':[0],'buildingIndices':[],
      'ownRefs':['tank'],'unitRefs':['tank'],'buildingRefs':[],'productNames':['GAPOWR','MTNK'],
      'productQueues':[0,3],'goalObjects':[{'x':0,'y':0,'kind':'native'},{'x':8,'y':8,'kind':'start'}],
      'placementObjects':[],'previousRoles':[19],'previousKinds':[1]*16,'previousGoals':[0]*16,
      'unitCapabilities':[{'miner':False,'engineer':False,'deploy':False,'building':False}],
      'buildingCapabilities':[]}
    action={'queues':[4,0,0,5,0,0],'amounts':[0]*6,'cash':[0]*6,'kinds':[4]+[0]*15,
      'goals':[1]+[0]*15,'engagement':[0]*16,'units':[0],'buildings':[],'placements':[0,0]}
    return world,action


class TemperatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def model(self,encoding='graph-plan-v4',overrides=None):
        torch.manual_seed(47)
        kwargs={} if overrides is None else {'production_temperatures':overrides}
        model=CommanderModel(['GAPOWR','MTNK'],encoding,.01,**kwargs)
        with torch.no_grad():model.queueParameter.bias.copy_(torch.arange(11)/10.)
        return model

    def predict(self,model):
        world,action=fixture();data=pack([world],model.vocabulary)
        with torch.no_grad():return model(data,torch.zeros(1,128),pack_actions([action],data),True)

    def test_missing_overrides_fall_back_and_invalid_values_reject(self):
        model=self.model();self.assertEqual(model.effective_production_temperatures(),dict.fromkeys(['queue','amount','cash'],.01))
        model.change_production_temperatures({'amount':2})
        self.assertEqual(model.effective_production_temperatures(),{'queue':.01,'amount':2.,'cash':.01})
        for value in [0,-1,float('nan'),float('inf'),True,'2',None]:
            with self.subTest(value=value),self.assertRaises(ValueError):model.change_production_temperatures({'amount':value})
        for config in [None,[],{'unknown':1}]:
            with self.subTest(config=config),self.assertRaises(ValueError):model.change_production_temperatures(config)
        for encoding in ['graph-plan-v1','graph-plan-v2','graph-plan-v3']:
            with self.subTest(encoding=encoding),self.assertRaisesRegex(ValueError,'require graph-plan-v4'):CommanderModel([],encoding,1.,{})

    def test_v4_control_is_exact_v2_without_tensor_changes_or_gates(self):
        model=self.model('graph-plan-v2');before=copy.deepcopy(model.state_dict());reference=self.predict(model)
        model.change_encoding('graph-plan-v4');actual=self.predict(model)
        self.assertIsNone(model.editGate);self.assertEqual(before.keys(),model.state_dict().keys())
        for key,value in before.items():self.assertTrue(torch.equal(value,model.state_dict()[key]),key)
        for key in ['hidden','value','logp','entropy','bcLoss','factors']:self.assertTrue(torch.equal(reference[key],actual[key]),key)
        for key,value in reference['probabilities'].items():
            self.assertTrue(torch.equal(value,actual['probabilities'][key]),key)
            self.assertTrue(torch.equal(value.argmax(-1),actual['probabilities'][key].argmax(-1)),key)

    def test_only_selected_factor_family_changes_under_fixed_action_context(self):
        model=self.model();reference=self.predict(model)
        for family in ['queue','amount','cash']:
            model.change_production_temperatures({family:2});actual=self.predict(model)
            self.assertFalse(torch.equal(reference['probabilities'][family+'0'],actual['probabilities'][family+'0']))
            for key,value in reference['probabilities'].items():
                if not key.startswith(family):self.assertTrue(torch.equal(value,actual['probabilities'][key]),(family,key))
            self.assertTrue(torch.equal(reference['hidden'],actual['hidden']))
            self.assertTrue(torch.equal(reference['value'],actual['value']))

    def test_export_load_preserve_sparse_overrides_and_tensors(self):
        model=self.model(overrides={'cash':3})
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.json';export(model,path,{})
            artifact=json.loads(path.read_text());self.assertEqual(artifact['productionTemperatures'],{'cash':3.})
            loaded=load_model(artifact)
            for name,value in model.state_dict().items():self.assertTrue(torch.equal(value,loaded.state_dict()[name]))
            self.assertEqual(loaded.effective_production_temperatures(),{'queue':.01,'amount':.01,'cash':3.})
            artifact['productionTemperatures']=None
            with self.assertRaises(ValueError):load_model(artifact)

    def test_ppo_checks_record_manifest_checkpoint_and_missing_explicit_configuration(self):
        model=self.model(overrides={'amount':2,'cash':3})
        config={'encoding':'graph-plan-v4','temperature':.01,'productionTemperatures':model.effective_production_temperatures()}
        episode={'deterministic':False,'modelSha':'sha','behavior':copy.deepcopy(config),'rows':[{**copy.deepcopy(config),'executionSource':'policy','action':fixture()[1]}]}
        validate_ppo_behavior([episode],model,'sha')
        for place in ['behavior','row']:
            for mutation in ['missing','partial','different','nonfinite','base']:
                changed=copy.deepcopy(episode);target=changed['behavior'] if place=='behavior' else changed['rows'][0]
                if mutation=='missing':target.pop('productionTemperatures')
                elif mutation=='partial':target['productionTemperatures'].pop('queue')
                elif mutation=='different':target['productionTemperatures']['amount']=4.
                elif mutation=='nonfinite':target['productionTemperatures']['cash']=float('nan')
                else:target['temperature']=.2
                with self.subTest(place=place,mutation=mutation),self.assertRaises(ValueError):validate_ppo_behavior([changed],model,'sha')
        with self.assertRaisesRegex(ValueError,'checkpoints'):validate_ppo_behavior([episode],model,'other-sha')
        changed=copy.deepcopy(episode);changed['rows'][0]['encoding']='graph-plan-v2'
        with self.assertRaisesRegex(ValueError,'encoding'):validate_ppo_behavior([changed],model,'sha')
        native=copy.deepcopy(episode);native['behavior']['executionMode']='native-finite-batches-v1'
        validate_ppo_behavior([native],model,'sha')
        with self.assertRaisesRegex(ValueError,'executor'):validate_ppo_behavior([episode,native],model,'sha')
        native['behavior']['executionMode']='unknown'
        with self.assertRaisesRegex(ValueError,'executor'):validate_ppo_behavior([native],model,'sha')
        self.assertEqual(recorded_temperature_config({'encoding':'graph-plan-v2'}),('graph-plan-v2',1.,dict.fromkeys(['queue','amount','cash'],1.)))

    def test_bc_requires_explicit_normalization_of_production_overrides(self):
        model=self.model(overrides={'amount':2})
        with self.assertRaisesRegex(ValueError,'explicit --bc-temperature'):configure_bc_temperature(model,None)
        configure_bc_temperature(model,1.)
        self.assertEqual(model.temperature,1.);self.assertEqual(model.effective_production_temperatures(),dict.fromkeys(['queue','amount','cash'],1.))
        self.assertEqual(model.production_temperatures,{})

    def test_v4_canonical_action_has_v2_membership_and_no_latent_gates(self):
        world,action=fixture();action['edits']=[1]*5
        result=canonical_action(action,world,'graph-plan-v4')
        self.assertNotIn('edits',result);self.assertIn('edits',action)
        self.assertEqual(result['units'],canonical_action(action,world,'graph-plan-v2')['units'])

    def test_migration_flags_keep_tensors_and_record_changed_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            directory=Path(directory);source=directory/'source.json';model=self.model('graph-plan-v2');export(model,source,{})
            world,action=fixture();source.with_suffix('.golden.json').write_text(json.dumps([{'world':world,'action':action,'hidden':[0.]*128}]))
            original=json.loads(source.read_text())
            for suffix,flags,changed in [('control',[],False),('production',['--amount-temperature','2','--cash-temperature','3'],True)]:
                target=directory/(suffix+'.json')
                result=subprocess.run([sys.executable,str(Path(__file__).with_name('commander_migrate.py')),'--input',str(source),'--out',str(target),'--encoding','graph-plan-v4',*flags],capture_output=True,text=True,check=True)
                summary=json.loads(result.stdout);artifact=json.loads(target.read_text())
                self.assertEqual(artifact['tensors'],original['tensors']);self.assertEqual(summary['parametersAdded'],0);self.assertEqual(summary['policyChanged'],changed)
                self.assertEqual(artifact['productionTemperatures'],{} if not changed else {'amount':2.,'cash':3.})
                self.assertTrue(target.with_suffix('.golden.json').is_file())
            rejected=subprocess.run([sys.executable,str(Path(__file__).with_name('commander_migrate.py')),'--input',str(source),'--out',str(directory/'bad.json'),'--encoding','graph-plan-v2','--amount-temperature','2'],capture_output=True,text=True)
            self.assertNotEqual(rejected.returncode,0);self.assertIn('require graph-plan-v4',rejected.stderr)
            self.assertFalse((directory/'bad.json').exists())


if __name__=='__main__':unittest.main()
