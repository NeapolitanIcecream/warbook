import copy
import unittest
from launch_outcome import classify


class LaunchOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'participants': [{'name': 'subject', 'role': 'subject'},
            {'name': 'opponent', 'role': 'opponent'}], 'limits': {'ticks': 54000}}
        # Minimal evidence from the observed 49084-tick overnight interruption.
        self.terminal = {'stopReason': 'api_finished_unspecified', 'tick': 49084,
            'cleanCompletionVerified': False, 'outcome': {'type': 'outcome_unresolved'},
            'stopState': {'status': 'Ended', 'turnManagerError': False},
            'stats': [{'name': 'opponent', 'defeated': True}, {'name': 'subject', 'defeated': True}]}

    def test_mutual_defeat_is_an_unresolved_terminal_nonwin(self):
        self.assertEqual(classify(self.terminal, self.manifest), ('U', 'engine_mutual_defeat', True))

    def test_execution_error_is_not_hidden_by_terminal_flags(self):
        for field in ['exception', 'turn_manager']:
            r = copy.deepcopy(self.terminal)
            if field == 'exception': r['error'] = 'actual engine exception'
            else: r['stopState']['turnManagerError'] = True
            self.assertEqual(classify(r, self.manifest).outcome, 'E')

    def test_only_predefined_tick_cap_is_a_training_zero(self):
        r = copy.deepcopy(self.terminal)
        r.update(stopReason='runner_limit', tick=54000)
        r['stopState']['status'] = 'Started'
        for p in r['stats']: p['defeated'] = False
        self.assertEqual(classify(r, self.manifest), ('U', 'tick_cap', True))
        r['tick'] -= 1
        self.assertEqual(classify(r, self.manifest).outcome, 'E')

    def test_win_and_loss_follow_manifest_roles_not_order(self):
        for winner, expected in [('subject', 'W'), ('opponent', 'L')]:
            r = copy.deepcopy(self.terminal)
            r['cleanCompletionVerified'] = True
            r['outcome'] = {'survivor': winner}
            for p in r['stats']: p['defeated'] = p['name'] != winner
            self.assertEqual(classify(r, self.manifest), (expected, 'verified_terminal', True))

    def test_inconsistent_winner_and_missing_participant_are_errors(self):
        r = copy.deepcopy(self.terminal)
        r['cleanCompletionVerified'] = True
        r['outcome'] = {'survivor': 'subject'}
        self.assertEqual(classify(r, self.manifest).outcome, 'E')
        r = copy.deepcopy(self.terminal)
        r['stats'].pop()
        self.assertEqual(classify(r, self.manifest).outcome, 'E')


if __name__ == '__main__':
    unittest.main()
