import unittest
from commander_night import next_learning_state

class NightSelectionTests(unittest.TestCase):
    def test_incumbent_qualifying_does_not_graduate_a_failed_candidate(self):
        self.assertEqual(next_learning_state('bc','good','bad',4,0,4),('good','good','ppo'))
    def test_bootstrap_tie_continues_the_new_learner_and_keeps_its_baseline(self):
        self.assertEqual(next_learning_state('bc','old','new',0,0,4),('new','old','bc'))
    def test_rl_regression_returns_to_the_compared_incumbent(self):
        self.assertEqual(next_learning_state('ppo','good','bad',6,1,4),('good','good','ppo'))

if __name__=='__main__':unittest.main()
