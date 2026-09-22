"""Copy a contact checkpoint and Adam state into matched menu-capability arms.

Both arms append the same two destination facts with zero actor weights/moments.
The local arm can offer up to two extra witnessed destinations; its initial
full-menu probabilities can therefore differ. Keep this expanded but untrained
model as a separate comparison.
"""
import argparse
import hashlib
import json
from pathlib import Path
import torch


def extend_actor_input(weight):
    if weight.ndim != 2 or weight.shape[1] != 265:
        raise ValueError('Expected actor input global217 + candidate48')
    return torch.nn.functional.pad(weight, (0, 2))


def extend_artifact(artifact, scope):
    import copy
    artifact = copy.deepcopy(artifact)
    actor = artifact['actor'][0]
    if actor['input'] != 265:
        raise ValueError('Unexpected actor input layout')
    actor['weights'] += [0.] * (2 * actor['output'])
    actor['input'] = 267
    artifact['schema'] = 'operation-maneuver-v1'
    artifact['maneuverScope'] = scope
    artifact['policyVersion'] += '-maneuver-' + scope
    artifact['training']['architecture'] = 'shared candidate scorer; global=217, candidate=50, maximum actions=77'
    artifact['training']['inputExtension'] = 'two zero-initialized destination inputs; no new training at migration'
    return artifact


def extend_optimizer(original):
    import copy
    result = copy.deepcopy(original)
    ids = [p for group in result['param_groups'] for p in group['params']]
    if len(ids) != 12:
        raise ValueError('Unexpected optimizer parameter layout')
    state = result['state'][ids[0]]
    for key in ['exp_avg', 'exp_avg_sq', 'max_exp_avg_sq']:
        if key in state:
            state[key] = extend_actor_input(state[key])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--scope', required=True, choices=['base', 'local'])
    args = parser.parse_args()
    artifact = json.loads(args.input.read_text())
    if (artifact['schema'] != 'operation-contact-v1' or artifact['controlScope'] != 'operation'
            or artifact.get('contactInput') not in ['local', 'zero'] or artifact.get('maneuverScope')):
        raise ValueError('Expected a contact-only operation checkpoint')
    if artifact.get('training', {}).get('method') != 'ppo':
        raise ValueError('Continue PPO with its optimizer history')
    optimizer = args.input.with_suffix('.optimizer.pt')
    if not optimizer.exists() or args.out.exists():
        raise ValueError('Missing optimizer or existing destination')
    artifact = extend_artifact(artifact, args.scope)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, separators=(',', ':')) + '\n')
    state = extend_optimizer(torch.load(optimizer, map_location='cpu', weights_only=True))
    torch.save(state, args.out.with_suffix('.optimizer.pt'))
    if args.input.with_suffix('.golden.json').exists():
        samples = json.loads(args.input.with_suffix('.golden.json').read_text())
        for sample in samples:
            for i, candidate in enumerate(sample['candidates']):
                candidate += [min(1, i/10), .5]
        args.out.with_suffix('.golden.json').write_text(json.dumps(samples)+'\n')
    receipt = dict(inputSha256=hashlib.sha256(args.input.read_bytes()).hexdigest(),
                   inputOptimizerSha256=hashlib.sha256(optimizer.read_bytes()).hexdigest(),
                   outputSha256=hashlib.sha256(args.out.read_bytes()).hexdigest(),
                   scope=args.scope, trained=False, weights='old weights retained, two new actor columns zero',
                   optimizer='old moments and steps retained, new columns zero', candidateBefore=48, candidateAfter=50,
                   note='Local menu expansion may change choices before any further learning')
    args.out.with_suffix('.migration.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
