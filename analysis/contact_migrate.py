"""Extend an operation checkpoint with zero-weight current-contact inputs.

The actor's candidate columns must move past the five new global columns.
Adam moments receive exactly the same mapping; its step counters are retained.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import torch

OLD_G, NEW_G, C = 212, 217, 48


def extend_weight(weight, actor):
    expected = OLD_G + (C if actor else 0)
    if weight.ndim != 2 or weight.shape[1] != expected:
        raise ValueError('Unexpected first-layer input layout')
    result = weight.new_zeros((weight.shape[0], NEW_G + (C if actor else 0)))
    result[:, :OLD_G] = weight[:, :OLD_G]
    if actor:
        result[:, NEW_G:] = weight[:, OLD_G:]
    return result


def extend_artifact(original, mode):
    if original['schema'] != 'operation-v2' or original.get('controlScope') != 'operation':
        raise ValueError('Contact experiment starts from persistent operation-v2')
    if mode not in ['local', 'zero']:
        raise ValueError('Need a local/zero arm')
    artifact = copy.deepcopy(original)
    for name in ['actor', 'critic']:
        layer = artifact[name][0]
        weights = torch.tensor(layer['weights'], dtype=torch.float64).reshape(layer['input'], layer['output']).T
        lifted = extend_weight(weights, name == 'actor')
        layer['input'] = lifted.shape[1]
        layer['weights'] = lifted.T.reshape(-1).tolist()
    artifact.update(schema='operation-contact-v1', contactInput=mode,
                    policyVersion=original['policyVersion'] + '-contact-' + mode)
    if 'training' in artifact:
        artifact['training']['architecture'] = 'shared candidate scorer; global=217, candidate=48, maximum actions=75'
        artifact['training']['inputExtension'] = 'five zero-initialized contact inputs; no new training at migration'
    return artifact


def extend_optimizer(original):
    result = copy.deepcopy(original)
    # launch_train.Policy has separate three-layer actor and critic, weight/bias
    # in module order. Refuse an unknown optimizer layout rather than reset it.
    ids = [p for group in result['param_groups'] for p in group['params']]
    if len(ids) != 12:
        raise ValueError('Unexpected optimizer parameter layout')
    for index, actor in [(0, True), (6, False)]:
        state = result['state'][ids[index]]
        for key in ['exp_avg', 'exp_avg_sq', 'max_exp_avg_sq']:
            if key in state:
                state[key] = extend_weight(state[key], actor)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--contact-input', required=True, choices=['local', 'zero'])
    args = parser.parse_args()
    original = json.loads(args.input.read_text())
    if original.get('training', {}).get('method') != 'ppo':
        raise ValueError('This experiment continues a PPO checkpoint with Adam state')
    optimizer_path = args.input.with_suffix('.optimizer.pt')
    optimizer = torch.load(optimizer_path, map_location='cpu', weights_only=True)
    artifact = extend_artifact(original, args.contact_input)
    optimizer = extend_optimizer(optimizer)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        raise ValueError('Migration output already exists')
    args.out.write_text(json.dumps(artifact, separators=(',', ':')) + '\n')
    torch.save(optimizer, args.out.with_suffix('.optimizer.pt'))
    receipt = dict(inputSha256=hashlib.sha256(args.input.read_bytes()).hexdigest(),
                   inputOptimizerSha256=hashlib.sha256(optimizer_path.read_bytes()).hexdigest(),
                   outputSha256=hashlib.sha256(args.out.read_bytes()).hexdigest(),
                   globalBefore=OLD_G, globalAfter=NEW_G, candidateSize=C,
                   contactInput=args.contact_input, newInputWeightsAndMoments='zero',
                   preserved='old weights, Adam moments and step counts', trained=False)
    args.out.with_suffix('.migration.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
