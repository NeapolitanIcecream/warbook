"""Read a few real economic events: product rank, KEEP competition and history."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--sources', type=int, default=8)
    ap.add_argument('--until-tick', type=int, default=5000)
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    import torch
    from commander_train import compact_world, load_model
    from commander_model import HIDDEN, pack, pack_actions
    from commander_sequence import canonical_action, training_action
    from experiment_storage import open_text
    # The helper is shipped as part of this standalone probe, not the live tree.
    cells = defaultdict(list)
    for path in sorted(json.loads(Path(args.episodes).read_text())):
        cells[str(Path(path).parent)].append(path)
    paths = []
    for cell in sorted(cells):
        if len(paths) < args.sources:
            paths.append(cells[cell][0])
    torch.set_num_threads(1)
    model = load_model(json.loads(Path(args.model).read_text()))
    model.eval()
    results = []
    for path in paths:
        manifest = json.loads((Path(path) / 'manifest.json').read_text())
        actor = next(p['name'] for p in manifest['participants'] if p['role'] == 'subject')
        rows = []
        with open_text(Path(path) / 'decisions.ndjson') as stream:
            for line in stream:
                item = json.loads(line)
                if item.get('actor') != actor or item.get('kind') != 'commander_decision':
                    continue
                row = item['record']
                if row['tick'] > args.until_tick:
                    break
                compact_world(row['world'])
                rows.append(row)
        h = torch.zeros(1, HIDDEN)
        with torch.no_grad():
            for index, row in enumerate(rows):
                d = pack([row['world']], model.vocabulary)
                label = canonical_action(training_action(row, 'bc'), row['world'], model.encoding)
                a = pack_actions([label], d)
                p = model(d, h, a, return_conditionals=True)
                if label['queues'][0] >= 4 or label['placements'][0] > 0:
                    variants = {'full': p, 'zero': model(d, torch.zeros_like(h), a, return_conditionals=True)}
                    short = torch.zeros_like(h)
                    for preceding in rows[max(0, index - 16):index]:
                        short = model.advance_hidden(pack([preceding['world']], model.vocabulary), short)
                    variants['last16'] = model(d, short, a, return_conditionals=True)
                    event = {'source': path, 'tick': row['tick'], 'target': row['world']['productNames'][label['queues'][0] - 4] if label['queues'][0] >= 4 else 'PLACE_' + row['world']['placementObjects'][label['placements'][0] - 1]['name'], 'variants': {}}
                    for name, variant in variants.items():
                        key = 'queue0' if label['queues'][0] >= 4 else 'place0'
                        probabilities = variant['conditionals'][key]['probabilities'][0]
                        target = label['queues'][0] if key == 'queue0' else label['placements'][0]
                        chosen = int(probabilities.argmax())
                        measure = {'targetProbability': float(probabilities[target]), 'keepProbability': float(probabilities[0]), 'argmax': chosen, 'correct': chosen == target}
                        if key == 'queue0':
                            products = probabilities[4:]
                            measure.update({'setMass': float(products.sum()), 'targetProductRank': 1 + int((products > products[target - 4]).sum()), 'bestProduct': row['world']['productNames'][int(products.argmax())], 'argmaxLabel': row['world']['productNames'][chosen - 4] if chosen >= 4 else ['KEEP', 'CLEAR', 'PAUSE', 'CANCEL'][chosen]})
                        event['variants'][name] = measure
                    results.append(event)
                h = p['hidden']
    print(json.dumps({'scope': 'Actual recorded source histories; full, zero and last16 hidden interventions are offline diagnostics, not games', 'model': args.model, 'events': results}, indent=2))


if __name__ == '__main__':
    main()
