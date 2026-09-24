import unittest,tempfile,json,hashlib,datetime,sys
from pathlib import Path
from unittest.mock import patch
import commander_night
from commander_night import next_learning_state,verified_candidate_receipts,completed_games,active_profiles,peer_model,quarantine_profile,comparison_score,choose_peer

class NightSelectionTests(unittest.TestCase):
    def test_weak_peer_wins_do_not_outvote_control_wins(self):
        rows=[{'subject':'peer-specialist','opponent':'current-peer','outcome':'W'} for _ in range(4)]
        rows+=[{'subject':'control-winner','opponent':'strong-history','outcome':'W'}]
        self.assertGreater(comparison_score({'rows':rows},'control-winner'),comparison_score({'rows':rows},'peer-specialist'))

    def test_main_alternates_both_learning_opponents_in_its_group(self):
        profiles={'main':{'route':'main','peerGroup':'47'},'short':{'route':'pressure','peerGroup':'47'},'small':{'route':'pressure','peerGroup':'47'},'other':{'route':'pressure','peerGroup':'83'}}
        self.assertEqual({choose_peer(profiles,'main',0),choose_peer(profiles,'main',1)},{'short','small'})
        self.assertEqual(choose_peer(profiles,'short',0),'main')

    def test_incumbent_qualifying_does_not_graduate_a_failed_candidate(self):
        self.assertEqual(next_learning_state('bc','good','bad',4,0,4),('good','good','ppo'))
    def test_bootstrap_tie_continues_the_new_learner_and_keeps_its_baseline(self):
        self.assertEqual(next_learning_state('bc','old','new',0,0,4),('new','old','bc'))
    def test_rl_regression_returns_to_the_compared_incumbent(self):
        self.assertEqual(next_learning_state('ppo','good','bad',6,1,4),('good','good','ppo'))
    def test_one_profile_survives_another_profiles_unfinished_phase(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=root/'a';b=root/'b';a.mkdir();b.mkdir()
            model=a/'model.json';model.write_text('verified weights')
            (a/'candidate-verified.json').write_text(json.dumps({'name':'a','cycle':2,'model':str(model),'sha256':hashlib.sha256(model.read_bytes()).hexdigest()}))
            (a/'batch-complete.json').write_text(json.dumps({'completed':4}))
            (b/'summary.json').write_text(json.dumps({'complete':False,'completed':2}))
            self.assertEqual(verified_candidate_receipts(root)['a']['model'],str(model))
            self.assertEqual(completed_games(root),4)
            model.write_text('changed')
            with self.assertRaises(ValueError):verified_candidate_receipts(root)

    def test_quarantined_route_is_not_sampled_and_exposes_only_its_retained_peer(self):
        state={'profiles':{'broken':{'current':'unretained','retained':'verified'},'healthy':{'current':'learning','retained':'anchor'}}}
        quarantine_profile(state,'broken',0,'non-finite observation')
        self.assertEqual(list(active_profiles(state['profiles'])),['healthy'])
        self.assertEqual(peer_model(state['profiles']['broken']),'verified')
        self.assertEqual(peer_model(state['profiles']['healthy']),'learning')

    def test_driver_continues_healthy_rounds_and_final_evaluation_after_a_peer_fails(self):
        # Exercise the actual scheduler; subprocesses stand in for games/training.
        with tempfile.TemporaryDirectory() as tmp:
            root=(Path(tmp)/'run').resolve();plan_path=Path(tmp)/'plan.json';calls=[]
            end=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).isoformat()
            plan={'trainingCutoff':end,'hardDeadline':end,'maps':['map'],'rounds':1,'maxCycles':2,
                  'strongReference':'reference','anchors':{'main':[],'pressure':[]},
                  'profiles':[{'name':route,'route':route,'arm':'test','encoding':'graph-plan-v2','seed':1,'input':'old'} for route in ['pressure','main']]}
            plan_path.write_text(json.dumps(plan))
            class Process:
                def __init__(self,cmd,stdout,**kwargs):
                    self.pid=123;self.code=0
                    if 'scripts/build-bot.ts' in cmd:
                        stdout.write(json.dumps({'path':'frozen-release'})+'\n')
                    elif 'analysis/commander_migrate.py' in cmd:
                        out=Path(cmd[cmd.index('--out')+1]);out.write_text('initial-'+out.parent.name)
                    elif 'analysis/commander_train.py' in cmd:
                        out=Path(cmd[cmd.index('--out')+1]);out.write_text(str(out))
                    elif 'analysis/launch_batch.py' in cmd:
                        p=Path(cmd[cmd.index('analysis/launch_batch.py')+1]);spec=json.loads(p.read_text())
                        out=Path(cmd[cmd.index('--out')+1]);out.mkdir()
                        phase=str(p.relative_to(root));calls.append(phase)
                        n=len(spec['maps'])*len(spec['opponents'])*spec['rounds']
                        counts={s:{'W':0,'L':n,'U':0,'E':0} for s in spec['subjects']}
                        failing='/pressure/check/' in '/'+phase or phase.startswith('final/pressure/')
                        if failing:
                            subject=next(iter(counts));counts[subject]['L']-=1;counts[subject]['E']=1;self.code=1
                        summary={'complete':True,'completed':n*len(counts),'counts':counts}
                        (out/'summary.json').write_text(json.dumps(summary))
                        (out/'learner-episodes.json').write_text('[]')
                def wait(self,timeout=None):return self.code
            with patch.object(sys,'argv',['commander_night.py',str(plan_path),'--out',str(root)]), \
                 patch.object(commander_night.subprocess,'Popen',Process), \
                 patch.object(commander_night.subprocess,'check_output',return_value='fixed-source\n'), \
                 patch.object(commander_night,'require_batch_space',return_value={}):
                code=commander_night.main()
            state=json.loads((root/'state.json').read_text())
            self.assertEqual(code,1)
            self.assertEqual(state['phase'],'complete_with_failures')
            self.assertEqual(len(state['failures']),1,state['failures'])
            self.assertEqual(len(state['finalFailures']),1)
            self.assertEqual([x['name'] for x in state['history']],['main','main'])
            self.assertTrue(any(x.startswith('main-') for x in state['final']))
            self.assertIn('cycle-01/main/sample/plan.json',calls)
            self.assertNotIn('cycle-01/pressure/sample/plan.json',calls)

if __name__=='__main__':unittest.main()
