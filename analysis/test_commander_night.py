import unittest,tempfile,json,hashlib
from pathlib import Path
from commander_night import next_learning_state,verified_candidate_receipts,completed_games

class NightSelectionTests(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
