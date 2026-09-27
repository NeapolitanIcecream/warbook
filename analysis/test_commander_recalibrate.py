"""Recalibration mechanism tests; synthetic journals are not complete-game evidence."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch

from commander_model import CommanderModel,export
from commander_recalibrate import (TARGET_PARAMETERS,assert_frozen,check_other_heads,distribution_report,
    file_sha,fit_parameter_head,gradient_contract,parent_targets,reset_head_adam,select_set_ticks,select_sources)
from commander_train import load_model
from test_commander_temperature import fixture


def saturated_model():
    torch.manual_seed(17)
    model=CommanderModel(['GAPOWR','MTNK','GAREFN'],'graph-plan-v2',.01)
    with torch.no_grad():
        model.queueParameter.weight.zero_();model.queueParameter.bias.fill_(-20.)
        model.queueParameter.bias[0]=20.;model.queueParameter.bias[5]=20.
    return model


def warm_adam(model):
    optimizer=torch.optim.Adam(model.parameters(),lr=5e-6)
    for i,parameter in enumerate(model.parameters()):parameter.grad=torch.full_like(parameter,(i+1)*1e-4)
    optimizer.step();optimizer.zero_grad()
    return optimizer.state_dict()


class RecalibrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def test_predeclared_whole_game_splits_cover_every_cell(self):
        paths=[f'/sources/map{m}.map/opponent{o}/{r}-actor' for m in range(4) for o in range(4) for r in range(3)]
        result=select_sources(paths)
        self.assertEqual(len(result['fit']),16);self.assertEqual(len(result['holdout']),16)
        self.assertTrue(all(g['repeat']==0 for g in result['fit']))
        self.assertTrue(all(g['repeat']==1 for g in result['holdout']))
        self.assertFalse({g['path'] for g in result['fit']}&{g['path'] for g in result['holdout']})
        with self.assertRaisesRegex(ValueError,'Missing'):select_sources([p for p in paths if not p.endswith('/1-actor')])
        with self.assertRaisesRegex(ValueError,'must differ'):select_sources(paths,0,0)

    def test_set_selection_keeps_startup_without_exceeding_eight_moments(self):
        events=[(i*75,['E1']) for i in range(30)]
        events[1]=(75,['GAPOWR']);events[7]=(525,['GAREFN']);events[18]=(1350,['GAWEAP'])
        ticks=select_set_ticks(events)
        self.assertEqual(len(ticks),8);self.assertTrue({75,525,1350}<=ticks)
        self.assertEqual(ticks,select_set_ticks(events))

    def test_soft_targets_cover_all_values_even_when_parent_underflows(self):
        z=torch.full((4,11),-1000.,requires_grad=True)
        with torch.no_grad():z[:,0]=1000.;z[:,5]=1000.
        parent,targets=parent_targets(z,{'amount':.01,'cash':.2})
        self.assertEqual(float(parent['amount'][:,1:].sum()),0.)
        for family,size in [('amount',5),('cash',6)]:
            self.assertFalse(targets[family].requires_grad)
            torch.testing.assert_close(targets[family].sum(-1),torch.ones(4,dtype=torch.float64))
            self.assertTrue(torch.all(targets[family]>=.1/size))
            self.assertTrue(torch.equal(parent[family].argmax(-1),targets[family].argmax(-1)))

    def test_fit_changes_only_output_tensors_and_generalizes_soft_coverage(self):
        parent=saturated_model();torch.manual_seed(11)
        x=torch.randn(64,128);heldout=torch.randn(24,128)
        old,targets=parent_targets(parent.queueParameter(x),parent.effective_production_temperatures())
        fitted,info=fit_parameter_head(parent.queueParameter,x,targets,max_iterations=100)
        explorer=copy.deepcopy(parent);explorer.change_encoding('graph-plan-v4')
        explorer.change_production_temperatures({'amount':1,'cash':1});explorer.queueParameter.load_state_dict(fitted)
        self.assertEqual(set(assert_frozen(parent,explorer)),set(TARGET_PARAMETERS))
        hp,hq=parent_targets(parent.queueParameter(heldout),parent.effective_production_temperatures())
        report=distribution_report(explorer.queueParameter,{'x':heldout,'parentProbabilities':hp,'targets':hq})
        self.assertLess(info['finalLoss'],info['initialLoss'])
        for family in ['amount','cash']:
            self.assertEqual(report[family]['parentArgmaxPreservation'],1.)
            self.assertTrue(report[family]['meanWithinDevelopmentRange'])
            self.assertTrue(all(v['minimumProbability']>.005 for v in report[family]['values']))
        before=copy.deepcopy(explorer.state_dict());contract=gradient_contract(explorer.queueParameter,heldout[0])
        self.assertEqual(set(contract),{'amount','cash'})
        for name,tensor in before.items():self.assertTrue(torch.equal(tensor,explorer.state_dict()[name]))

    def test_optimizer_reset_is_matched_and_preserves_every_other_state(self):
        model=saturated_model();state=warm_adam(model);snapshot=copy.deepcopy(state)
        reset,info=reset_head_adam(model,state)
        target_ids={entry['stateId'] for entry in info['reset']}
        self.assertEqual({entry['name'] for entry in info['reset']},set(TARGET_PARAMETERS))
        self.assertTrue(target_ids<=set(state['state']));self.assertFalse(target_ids&set(reset['state']))
        self.assertEqual(state['param_groups'],reset['param_groups'])
        for key,entry in state['state'].items():
            for field,value in entry.items():
                self.assertTrue(torch.equal(value,snapshot['state'][key][field]))
                if key not in target_ids:self.assertTrue(torch.equal(value,reset['state'][key][field]))

    def test_other_heads_are_identical_only_under_the_same_forced_prefix(self):
        parent=saturated_model();baseline=copy.deepcopy(parent);baseline.change_encoding('graph-plan-v4')
        explorer=copy.deepcopy(baseline);explorer.change_production_temperatures({'amount':1.,'cash':1.})
        with torch.no_grad():explorer.queueParameter.weight.mul_(.25);explorer.queueParameter.bias.mul_(.25)
        world,action=fixture();row={'world':world,'action':action,'hidden':[0.]*128}
        report=check_other_heads(parent,baseline,explorer,[row])
        self.assertEqual(report['maximumNonTargetProbabilityDifference'],0.)
        self.assertTrue(report['baselineJointLogpEqual'])

    def test_cli_exports_matched_pair_and_outcomes_cannot_change_the_fit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);parent=saturated_model();state=warm_adam(parent)
            source=root/'parent.json';sha=export(parent,source,{})
            torch.save(state,source.with_suffix('.optimizer.pt'))
            world,action=fixture()
            world['productNames'].append('GAREFN');world['productQueues'].append(0)
            world['products'].append([0.]*24)
            paths=[]
            for m in range(4):
                for o in range(4):
                    for repeat in range(2):
                        path=root/f'map{m}.map'/f'opp{o}'/f'{repeat}-actor';path.mkdir(parents=True);paths.append(str(path))
                        manifest={'git':'fixture','runId':f'fixture-{m}-{o}-{repeat}',
                            'participants':[{'role':'subject','name':'A'},{'role':'opponent','name':'B'}],
                            'commanderExperiment':{'encoding':'graph-plan-v2','temperature':.01,'modelSha256':sha,'deterministic':False},
                            'sourceHashes':{'src/commander/world.ts':'fixture-encoder'},'limits':{'ticks':1000}}
                        result={'tick':225,'cleanCompletionVerified':True,'stopState':{'status':'Ended','turnManagerError':False},
                            'outcome':{'survivor':'A'},'stats':[{'name':'A','defeated':False},{'name':'B','defeated':True}]}
                        (path/'manifest.json').write_text(json.dumps(manifest));(path/'result.json').write_text(json.dumps(result))
                        records=[]
                        for tick in [0,75,150]:
                            row={'schema':'commander-v1','encoding':'graph-plan-v2','temperature':.01,'executionSource':'policy',
                                'tick':tick,'world':copy.deepcopy(world),'action':copy.deepcopy(action),'hidden':[0.]*128,
                                'logp':0.,'value':.5,'teacherAction':{'unused':'must not be a target'}}
                            row['world']['tick']=tick;records.append({'kind':'commander_decision','actor':'A','record':row})
                        (path/'decisions.ndjson').write_text(''.join(json.dumps(row)+'\n' for row in records))
            episodes=root/'episodes.json';episodes.write_text(json.dumps(paths))
            artifacts=[]
            for run in range(2):
                if run:
                    for path in paths:
                        result_path=Path(path)/'result.json';result=json.loads(result_path.read_text())
                        result['outcome']['survivor']='B'
                        for player in result['stats']:player['defeated']=player['name']=='A'
                        result_path.write_text(json.dumps(result))
                out=root/f'output-{run}'
                process=subprocess.run([sys.executable,str(Path(__file__).with_name('commander_recalibrate.py')),
                    '--input',str(source),'--episodes',str(episodes),'--out',str(out),'--max-iterations','60'],capture_output=True,text=True)
                self.assertEqual(process.returncode,0,process.stderr)
                baseline=load_model(json.loads((out/'B0.json').read_text()));explorer=json.loads((out/'E0.json').read_text())
                self.assertEqual(assert_frozen(parent,baseline,()),[])
                self.assertEqual(file_sha(out/'B0.optimizer.pt'),file_sha(out/'E0.optimizer.pt'))
                self.assertEqual(explorer['productionTemperatures'],{'amount':1.,'cash':1.})
                self.assertTrue((out/'B0.golden.json').is_file());self.assertTrue((out/'E0.golden.json').is_file())
                report=json.loads((out/'calibration.json').read_text())
                self.assertFalse(report['gameOutcomesOrTeacherActionsUsedAsTargets']);self.assertFalse(report['calibrationOptimizerTransferred'])
                self.assertEqual(len(report['data']['fit']['sources']),16);self.assertEqual(len(report['data']['holdout']['sources']),16)
                self.assertTrue(any(c['counterfactual'] for c in report['data']['fit']['conditions']))
                self.assertLess(report['actualSetCoverage']['holdout']['amount']['conditions'],report['coverage']['holdout']['amount']['conditions'])
                self.assertTrue(report['allNonTargetTensorsIdentical']);self.assertTrue(report['requiresFreshOnPolicyRollouts'])
                artifacts.append(explorer['tensors'])
            self.assertEqual(artifacts[0],artifacts[1])


if __name__=='__main__':unittest.main()
