"""Frozen commander journals retain their actual behavior configuration."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from commander_train import read_episode, validate_ppo_behavior


class CommanderReleaseEpisodeTests(unittest.TestCase):
    def write_episode(self, directory, experiment=None, include_experiment=False, release=True, frozen_encoder=None):
        path = Path(directory)
        subject = {'name': 'frozen-teacher', 'role': 'subject'}
        if release:
            subject['release'] = {
                'commanderExecutionMode': 'native-finite-batches-v1',
                'deterministicLaunch': True,
                'launchModelSha256': 'frozen-teacher-weights',
            }
        if release and frozen_encoder is not None:
            subject['release']['sourceHashes'] = {'src/commander/world.ts': frozen_encoder}
        manifest = {
            'git': 'fixed-runner',
            'participants': [subject, {'name': 'opponent', 'role': 'opponent'}],
            'sourceHashes': {'src/commander/world.ts': 'encoder-sha'},
        }
        if include_experiment:
            manifest['commanderExperiment'] = experiment
        result = {
            'tick': 150,
            'stopState': {'status': 'Ended', 'turnManagerError': False},
            'cleanCompletionVerified': True,
            'outcome': {'survivor': 'frozen-teacher'},
            'stats': [{'name': 'frozen-teacher', 'defeated': False},
                      {'name': 'opponent', 'defeated': True}],
        }
        records = [{
            'schema': 'commander-v1', 'encoding': 'graph-plan-v4',
            'temperature': 1.,
            'productionTemperatures': {'queue': 1., 'amount': 1., 'cash': 1.},
            'memberScoring': {'mode': 'separate-v1'},
            'tick': tick, 'world': {}, 'action': {},
            'executionSource': 'policy', 'hidden': [0.] * 128,
            'logp': 0., 'value': 0., 'entropy': 0.,
        } for tick in (0, 75)]
        (path / 'manifest.json').write_text(json.dumps(manifest))
        (path / 'result.json').write_text(json.dumps(result))
        (path / 'decisions.ndjson').write_text(''.join(
            json.dumps({'actor': 'frozen-teacher', 'kind': 'commander_decision', 'record': row}) + '\n'
            for row in records))
        return path

    def test_frozen_release_and_records_restore_behavior_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            episode = read_episode(self.write_episode(directory), compact=False)
        self.assertEqual(episode['modelSha'], 'frozen-teacher-weights')
        self.assertIs(episode['deterministic'], True)
        self.assertEqual(episode['behavior']['executionMode'], 'native-finite-batches-v1')
        for field in ('encoding', 'temperature', 'productionTemperatures', 'memberScoring'):
            self.assertEqual(episode['behavior'][field], episode['rows'][0][field])

    def test_explicit_experiment_retains_priority_over_release_and_records(self):
        experiment = {
            'encoding': 'graph-plan-v2', 'temperature': .01,
            'executionMode': 'single-item-v1', 'deterministic': False,
            'modelSha256': 'explicit-weights',
        }
        with tempfile.TemporaryDirectory() as directory:
            episode = read_episode(self.write_episode(directory, experiment, True), compact=False)
        self.assertEqual(episode['behavior'], experiment)
        self.assertEqual(episode['modelSha'], 'explicit-weights')
        self.assertIs(episode['deterministic'], False)

    def test_missing_experiment_and_release_keep_existing_legacy_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            episode = read_episode(self.write_episode(directory, release=False), compact=False)
        self.assertEqual(episode['behavior'], {})
        self.assertIsNone(episode['modelSha'])
        self.assertIs(episode['deterministic'], False)
        self.assertEqual(episode['encoderSha'], 'encoder-sha')

    def test_frozen_encoder_identity_uses_bundle_hash_with_runtime_fallback(self):
        for frozen_encoder, expected in [('bundled-encoder-sha', 'bundled-encoder-sha'), (None, 'encoder-sha')]:
            with self.subTest(frozen_encoder=frozen_encoder), tempfile.TemporaryDirectory() as directory:
                episode = read_episode(self.write_episode(directory, frozen_encoder=frozen_encoder), compact=False)
            self.assertEqual(episode['encoderSha'], expected)

    def test_frozen_greedy_teacher_remains_ineligible_for_ppo(self):
        with tempfile.TemporaryDirectory() as directory:
            episode = read_episode(self.write_episode(directory), compact=False)
        model = SimpleNamespace(
            encoding='graph-plan-v4', temperature=1.,
            effective_production_temperatures=lambda: {'queue': 1., 'amount': 1., 'cash': 1.},
            member_scoring={'mode': 'separate-v1'})
        with self.assertRaisesRegex(ValueError, 'Greedy behavior'):
            validate_ppo_behavior([episode], model, 'frozen-teacher-weights')


if __name__ == '__main__':
    unittest.main()
