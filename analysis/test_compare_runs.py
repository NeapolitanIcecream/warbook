"""Synthetic report-input tests, not game evidence."""
import json
import tempfile
import unittest
from pathlib import Path

from compare_runs import DataError, binomial_interval, load_runs, summarize


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.releases = {
            'old': {'mode': 'combined', 'sha256': 'a' * 64, 'observationProtocol': 'legal-v1'},
            'new': {'mode': 'combined', 'sha256': 'b' * 64, 'observationProtocol': 'legal-v1'},
        }
        rows = []
        for subject in ['old', 'new']:
            for opponent in ['old', 'new']:
                for round in range(2):
                    directory = self.root / f'{subject}-{opponent}-{round}'
                    directory.mkdir()
                    players = [{'name': 'red', 'startLocation': round}, {'name': 'blue', 'startLocation': 1 - round}]
                    participants = [
                        {'name': 'red', 'role': 'subject', 'release': self.releases[subject]},
                        {'name': 'blue', 'role': 'opponent', 'release': self.releases[opponent]},
                    ]
                    if round:
                        participants.reverse()
                    manifest = {'runId': directory.name, 'participants': participants,
                                'modes': ['combined', 'combined'], 'api': 'fixed', 'bundledEngineSourceVersion': 'fixed',
                                'observationProtocol': 'legal-v1', 'decisionInterval': 3, 'limits': {'ticks': 100}}
                    initial = {'players': players, 'rulesHash': 'rules', 'options': {'mapName': 'map', 'credits': 10000}}
                    win = subject == 'new' or round == 0
                    result = {'runId': directory.name, 'stopState': {'status': 'Ended', 'turnManagerError': False},
                              'cleanCompletionVerified': True, 'stopReason': 'engine_ended',
                              'outcome': {'survivor': 'red' if win else 'blue'},
                              'stats': [{'name': 'red', 'defeated': not win}, {'name': 'blue', 'defeated': win}]}
                    for name, value in [('manifest', manifest), ('initial', initial), ('result', result)]:
                        self.write(directory / f'{name}.json', value)
                    rows.append({'dir': str(directory), 'subject': subject, 'opponent': opponent, 'map': 'map'})
        self.write(self.root / 'summary.json', {'rows': rows})
        self.write(self.root / 'plan.json', {'subjects': self.releases, 'maps': ['map'],
                                          'opponents': self.releases, 'rounds': 2})

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))

    def test_roles_and_frozen_identity_survive_slot_changes_and_same_mode_names(self):
        report = summarize(load_runs(self.root))
        self.assertEqual(report['starts'], 8)
        self.assertEqual(len(report['totals']), 2)
        self.assertEqual([r['cleanWins'] for r in report['totals']], [2, 4])
        self.assertEqual(len(report['mirrors']), 2)
        self.assertEqual(report['duels'][0]['starts'], 4)

    def test_missing_result_stops_comparison(self):
        (self.root / 'old-old-0/result.json').unlink()
        with self.assertRaisesRegex(DataError, 'Cannot read'):
            load_runs(self.root)

    def test_duplicate_ledger_entry_is_not_an_extra_sample(self):
        path = self.root / 'summary.json'
        data = json.loads(path.read_text())
        data['rows'][-1] = data['rows'][0]
        self.write(path, data)
        with self.assertRaisesRegex(DataError, 'Duplicate'):
            load_runs(self.root)

    def test_an_error_cannot_be_relabelled_as_a_clean_win(self):
        path = self.root / 'old-old-0/result.json'
        data = json.loads(path.read_text())
        data['stopState']['turnManagerError'] = True
        self.write(path, data)
        with self.assertRaisesRegex(DataError, 'completion evidence'):
            load_runs(self.root)

    def test_changed_rules_stop_comparison(self):
        path = self.root / 'old-old-0/initial.json'
        data = json.loads(path.read_text())
        data['options']['credits'] = 50000
        self.write(path, data)
        with self.assertRaisesRegex(DataError, 'Mixed comparison protocols'):
            load_runs(self.root)

    def test_tiny_perfect_samples_do_not_exclude_even_odds(self):
        self.assertLess(binomial_interval(4, 4)[0], 0.5)
        self.assertGreater(binomial_interval(0, 4)[1], 0.5)

    def test_correct_total_does_not_hide_a_missing_treatment_cell(self):
        path = self.root / 'summary.json'
        data = json.loads(path.read_text())
        data['rows'][-1]['opponent'] = 'old'
        self.write(path, data)
        with self.assertRaisesRegex(DataError, 'per-cell coverage'):
            load_runs(self.root)

    def test_mid_batch_actor_changes_cannot_hide_under_one_label(self):
        path = self.root / 'new-old-0/manifest.json'
        data = json.loads(path.read_text())
        data['participants'][0]['release']['sha256'] = 'c' * 64
        self.write(path, data)
        with self.assertRaisesRegex(DataError, 'multiple actor versions'):
            load_runs(self.root)


if __name__ == '__main__':
    unittest.main()
