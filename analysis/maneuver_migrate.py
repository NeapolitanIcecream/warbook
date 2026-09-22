"""Copy a contact checkpoint and Adam state into matched menu-capability arms.

Weights and observation features are identical. The local arm can offer up to two
extra witnessed destinations; its initial full-menu probabilities can therefore
differ. Keep this expanded but untrained model as a separate comparison.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path


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
    artifact['maneuverScope'] = args.scope
    artifact['policyVersion'] += '-maneuver-' + args.scope
    artifact['training']['architecture'] = 'shared candidate scorer; global=217, candidate=48, maximum actions=77'
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, separators=(',', ':')) + '\n')
    shutil.copyfile(optimizer, args.out.with_suffix('.optimizer.pt'))
    if args.input.with_suffix('.golden.json').exists():
        shutil.copyfile(args.input.with_suffix('.golden.json'), args.out.with_suffix('.golden.json'))
    receipt = dict(inputSha256=hashlib.sha256(args.input.read_bytes()).hexdigest(),
                   inputOptimizerSha256=hashlib.sha256(optimizer.read_bytes()).hexdigest(),
                   outputSha256=hashlib.sha256(args.out.read_bytes()).hexdigest(),
                   scope=args.scope, trained=False, weights='unchanged', optimizer='byte-identical',
                   note='Local menu expansion may change choices before any further learning')
    args.out.with_suffix('.migration.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
