"""A changed membership distribution cannot silently reuse legacy PPO records."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
import torch

from commander_model import CommanderModel,export,artifact_encoding
from commander_train import load_model,validate_ppo_behavior
from test_commander_temperature import fixture

class MemberContractTests(unittest.TestCase):
    def model(self,config=None):
        return CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.01,
            production_temperatures={'amount':1,'cash':1},
            **({'member_scoring':config} if config is not None else {}))

    def episode(self,model,explicit=True):
        config={'encoding':model.encoding,'temperature':model.temperature,
            'productionTemperatures':model.effective_production_temperatures()}
        if explicit:config['memberScoring']=dict(model.member_scoring)
        return {'deterministic':False,'modelSha':'sha','behavior':copy.deepcopy(config),
            'rows':[{**copy.deepcopy(config),'executionSource':'policy','action':fixture()[1]}]}

    def test_missing_legacy_configuration_is_only_the_original_distribution(self):
        original=self.model();old=self.episode(original,False)
        validate_ppo_behavior([old],original,'sha')
        for config in [{'mode':'current-task-keep-v1'},{'mode':'keep-bias-v1','bias':3.}]:
            changed=self.model(config)
            with self.subTest(config=config),self.assertRaisesRegex(ValueError,'member scoring'):
                validate_ppo_behavior([old],changed,'sha')

    def test_manifest_and_every_policy_row_must_match_even_with_same_claimed_sha(self):
        for config in [{'mode':'current-task-keep-v1'},{'mode':'keep-bias-v1','bias':3.}]:
            model=self.model(config);episode=self.episode(model)
            validate_ppo_behavior([episode],model,'sha')
            for location in ['manifest','row']:
                for mutation in ['missing','original','bias']:
                    modified=copy.deepcopy(episode)
                    target=modified['behavior'] if location=='manifest' else modified['rows'][0]
                    if mutation=='missing':target.pop('memberScoring')
                    elif mutation=='original':target['memberScoring']={'mode':'separate-v1'}
                    else:target['memberScoring']={'mode':'keep-bias-v1','bias':4.}
                    with self.subTest(config=config,location=location,mutation=mutation),self.assertRaisesRegex(ValueError,'member scoring'):
                        validate_ppo_behavior([modified],model,'sha')

    def test_load_export_preserve_semantics_without_tensor_changes(self):
        for config in [{'mode':'separate-v1'},{'mode':'current-task-keep-v1'},{'mode':'keep-bias-v1','bias':17.25}]:
            model=self.model(config)
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'model.json';export(model,path,{})
                artifact=json.loads(path.read_text());loaded=load_model(artifact)
                self.assertEqual(artifact_encoding(artifact),'graph-plan-v4')
                if config['mode']=='separate-v1':self.assertEqual(artifact['format'],'warbook-commander-model-v1')
                else:
                    self.assertEqual(artifact['format'],'warbook-commander-model-v2')
                    self.assertNotIn('encoding',artifact)
                    self.assertEqual(artifact['actionEncoding'],'graph-plan-v4')
                self.assertEqual(artifact['memberScoring'],config)
                self.assertEqual(loaded.member_scoring,config)
                self.assertEqual(model.state_dict().keys(),loaded.state_dict().keys())
                for name,value in model.state_dict().items():self.assertTrue(torch.equal(value,loaded.state_dict()[name]),name)

    def test_ambiguous_or_legacy_headers_cannot_claim_new_scoring(self):
        good={'format':'warbook-commander-model-v2','actionEncoding':'graph-plan-v4',
            'memberScoring':{'mode':'current-task-keep-v1'}}
        self.assertEqual(artifact_encoding(good),'graph-plan-v4')
        for changed in [{**good,'encoding':'graph-plan-v4'},
                        {**good,'memberScoring':{'mode':'separate-v1'}},
                        {**good,'format':'warbook-commander-model-v1'},
                        {k:v for k,v in good.items() if k!='memberScoring'}]:
            with self.subTest(changed=changed),self.assertRaises(ValueError):artifact_encoding(changed)

if __name__=='__main__':unittest.main()
