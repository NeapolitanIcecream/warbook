"""Bounded scalar arithmetic, source weighting and zero-update artifact checks."""
import copy
import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path

import torch

from commander_member_adapter import fit_keep_bias,initialize,keep_log_odds,mean_keep,weighted_panel
from commander_model import CommanderModel,HIDDEN,export,pack,pack_actions
from commander_train import golden,load_model
from test_commander_temperature import fixture


def odds(probability):return math.log(probability)-math.log1p(-probability)


def frame(source,r,m):
    return {'source':source,'rLogOdds':torch.tensor(r,dtype=torch.float64),'mLogOdds':torch.tensor(m,dtype=torch.float64)}


class KeepCalibrationArithmeticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def test_log_odds_keeps_underflowed_legal_tail(self):
        logs=torch.tensor([[-1200.,0.,-torch.inf],[0.,-900.,-901.]],dtype=torch.float64)
        result=keep_log_odds(logs,keep_index=0)
        self.assertEqual(float(result[0]),-1200.)
        self.assertAlmostEqual(float(result[1]),900.-math.log1p(math.exp(-1.)),places=12)
        self.assertEqual(float(logs[0,0].exp()),0.)
        fitted=fit_keep_bias([frame('source',[-1200.],[1.])])
        self.assertAlmostEqual(fitted['bias'],1201.,places=7)
        self.assertLessEqual(fitted['bisectionSteps'],80)
        self.assertLessEqual(fitted['absoluteMeanError'],1e-10)

    def test_equal_sources_then_frames_then_eligible_units(self):
        frames=[frame('a',[odds(.1)]*100,[odds(.2)]*100),
                frame('a',[odds(.3)],[odds(.4)]),frame('a',[],[]),
                frame('b',[odds(.8)],[odds(.9)]),frame('empty',[],[])]
        r,m,weights,counts=weighted_panel(frames)
        self.assertAlmostEqual(float(weights.sum()),1.,places=14)
        self.assertAlmostEqual(mean_keep(r,weights),.5,places=14)
        self.assertAlmostEqual(mean_keep(m,weights),.6,places=14)
        self.assertEqual(counts['eligibleSources'],2)
        self.assertEqual(counts['zeroEligibleSources'],['empty'])
        self.assertEqual((counts['frames'],counts['eligibleFrames'],counts['zeroEligibleFrames']),(5,3,2))
        self.assertEqual(counts['eligibleUnits'],102)
        fitted=fit_keep_bias(frames)
        self.assertAlmostEqual(fitted['mergedMeanIncrement'],.1,places=14)
        self.assertAlmostEqual(fitted['inertiaMeanIncrement'],.1,places=9)

    def test_one_fixed_offset_is_recovered_without_outcome_labels(self):
        frames=[frame('a',[-5.,0.,2.],[-3.,2.,4.]),frame('b',[1.],[3.])]
        result=fit_keep_bias(frames)
        self.assertAlmostEqual(result['bias'],2.,places=8)
        changed=[{**row,'outcome':'arbitrary outcome metadata','reward':-1000.} for row in frames]
        self.assertEqual(result,fit_keep_bias(changed))

    def test_zero_increment_uses_zero_bias(self):
        result=fit_keep_bias([frame('a',[-900.,0.,900.],[-900.,0.,900.])])
        self.assertEqual(result['bias'],0.)
        self.assertEqual(result['bisectionSteps'],0)
        self.assertEqual(result['absoluteMeanError'],0.)

    def test_empty_or_invalid_calibration_is_rejected(self):
        for value in [[],[frame('a',[],[])]]:
            with self.assertRaisesRegex(ValueError,'no eligible'):fit_keep_bias(value)
        with self.assertRaisesRegex(ValueError,'reduced KEEP'):fit_keep_bias([frame('a',[1.],[0.])])
        with self.assertRaisesRegex(ValueError,'Invalid paired'):fit_keep_bias([frame('a',[float('nan')],[1.])])
        with self.assertRaisesRegex(ValueError,'Nonfinite'):keep_log_odds(torch.tensor([0.,-torch.inf]),keep_index=0)
        with self.assertRaisesRegex(ValueError,'nonnegative'):mean_keep(torch.zeros(1),torch.ones(1),-.1)


def synthetic_episode(model,path,index):
    rows=[];hidden=torch.zeros(1,HIDDEN)
    with torch.no_grad():
        for tick_index in range(16):
            world,action=fixture();world['tick']=tick_index*75;world['global'][0]=tick_index*.02+index*.001
            if tick_index:
                world['previousRoles']=[0];world['previousKinds'][0]=4;world['previousGoals'][0]=1
                action['kinds'][0]=0;action['units']=[18]
            if tick_index==15:
                # Existing member must explicitly confirm the retyped slot.
                action['kinds'][0]=6;action['units']=[0]
            data=pack([world],model.vocabulary);prediction=model(data,hidden,pack_actions([action],data))
            rows.append({'schema':'commander-v1','encoding':model.encoding,'temperature':model.temperature,
                         'productionTemperatures':model.effective_production_temperatures(),'executionSource':'policy',
                         'tick':world['tick'],'world':world,'action':action,'hidden':[5.]*HIDDEN,
                         'logp':float(prediction['logp'][0]),'value':float(prediction['value'][0])})
            hidden=prediction['hidden']
    return {'path':str(path),'rows':rows,'reward':float(index%2)}


def write_source(episode,sha):
    path=Path(episode['path']);path.mkdir(parents=True)
    row=episode['rows'][0];configuration={key:row[key] for key in ['encoding','temperature','productionTemperatures']}
    manifest={'git':'synthetic-mechanism-fixture','participants':[{'role':'subject','name':'a'},{'role':'opponent','name':'b'}],
              'commanderExperiment':{**configuration,'modelSha256':sha,'deterministic':False,'executionMode':'native-finite-batches-v1'},
              'sourceHashes':{'src/commander/world.ts':'fixture-encoder'}}
    winner='a' if episode['reward'] else 'b'
    result={'tick':1200,'cleanCompletionVerified':True,'stopState':{'status':'Ended','turnManagerError':False},
            'outcome':{'survivor':winner},'stats':[{'name':name,'defeated':name!=winner} for name in ['a','b']]}
    (path/'manifest.json').write_text(json.dumps(manifest));(path/'result.json').write_text(json.dumps(result))
    (path/'decisions.ndjson').write_text(''.join(json.dumps({'actor':'a','kind':'commander_decision','record':record})+'\n' for record in episode['rows']))


class MemberInitializerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):torch.set_num_threads(1)

    def test_original_c0_and_warm_adam_are_preserved_in_all_three_arms(self):
        torch.manual_seed(17);model=CommanderModel(['GAPOWR','MTNK'],'graph-plan-v4',.2)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'C0.json';export(model,source,{})
            # Real legacy C0 artifacts omit the new field; R must remain byte-identical.
            artifact=json.loads(source.read_text());artifact.pop('memberScoring');source.write_text(json.dumps(artifact)+'\n')
            model_sha=hashlib.sha256(source.read_bytes()).hexdigest()
            optimizer=torch.optim.Adam(model.parameters(),lr=.003)
            for parameter in model.parameters():
                optimizer.state[parameter]={'step':torch.tensor(17.),'exp_avg':torch.full_like(parameter,.002),'exp_avg_sq':torch.full_like(parameter,.01)}
            optimizer_path=source.with_suffix('.optimizer.pt');torch.save(optimizer.state_dict(),optimizer_path)
            original_model=source.read_bytes();original_adam=optimizer_path.read_bytes();sources=[];episodes=[]
            for index in range(16):
                path=root/'sources'/f'map{index//4}.map'/f'opponent{index%4}'/'0-C0'
                episode=synthetic_episode(model,path,index);write_source(episode,model_sha);sources.append(str(path));episodes.append(episode)
            golden(model,episodes,source.with_suffix('.golden.json'));original_golden=source.with_suffix('.golden.json').read_bytes()
            panel=root/'anchors.json';panel.write_text(json.dumps(sources));out=root/'initialized'
            report=initialize(source,panel,out,exclude_sources=[root/'excluded-source'])
            self.assertEqual((out/'R.json').read_bytes(),original_model)
            self.assertEqual((out/'R.golden.json').read_bytes(),original_golden)
            self.assertEqual(source.read_bytes(),original_model);self.assertEqual(optimizer_path.read_bytes(),original_adam)
            self.assertEqual(report['calibration']['counts']['sources'],16)
            self.assertEqual(report['calibration']['counts']['eligibleSources'],16)
            self.assertEqual(report['calibration']['counts']['frames'],256)
            self.assertEqual(report['calibration']['counts']['eligibleFrames'],224)
            self.assertEqual(report['calibration']['counts']['zeroEligibleFrames'],32)
            self.assertLessEqual(report['calibration']['actualForwardAbsoluteMeanError'],2e-10)
            self.assertTrue(any(row['retypedUnits'] for row in report['goldenSelection']))
            self.assertTrue(any(row['eligibleUnits'] for row in report['goldenSelection']))
            self.assertTrue(all(row['maximumReconstructedVsRecordedHiddenCoordinateDifference']>4 for row in report['panelSources']))
            for label in ['R','M','I']:
                exported=json.loads((out/(label+'.json')).read_text());loaded=load_model(exported)
                self.assertEqual(exported['format'],'warbook-commander-model-v1' if label=='R' else 'warbook-commander-model-v2')
                if label=='R':self.assertEqual(exported['encoding'],'graph-plan-v4')
                else:
                    self.assertNotIn('encoding',exported)
                    self.assertEqual(exported['actionEncoding'],'graph-plan-v4')
                self.assertEqual(exported['tensors'],artifact['tensors'])
                self.assertEqual((out/(label+'.optimizer.pt')).read_bytes(),original_adam)
                self.assertEqual(loaded.member_scoring,report['arms'][label]['effectiveMemberScoring'])
                if label!='R':
                    cases=json.loads((out/(label+'.golden.json')).read_text())
                    self.assertTrue(all(abs(value)<=1 for case in cases for value in case['hidden']))
                    for case in cases:
                        data=pack([case['world']],loaded.vocabulary)
                        with torch.no_grad():prediction=loaded(data,torch.tensor([case['hidden']]),pack_actions([case['action']],data))
                        self.assertAlmostEqual(float(prediction['logp'][0]),case['expected']['logp'],places=11)
            self.assertEqual(json.loads((out/'M.json').read_text())['memberScoring'],{'mode':'current-task-keep-v1'})
            self.assertEqual(json.loads((out/'I.json').read_text())['memberScoring']['bias'],report['calibration']['bias'])
            with self.assertRaisesRegex(ValueError,'fresh output'):initialize(source,panel,out)
            with self.assertRaisesRegex(ValueError,'Excluded failure'):
                initialize(source,panel,root/'rejected',exclude_sources=[sources[0]])
            self.assertFalse((root/'rejected').exists())

    def test_missing_paired_adam_rejects_before_panel_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,'paired Adam'):
                initialize(Path(directory)/'missing.json','missing-panel',Path(directory)/'out')


if __name__=='__main__':unittest.main()
