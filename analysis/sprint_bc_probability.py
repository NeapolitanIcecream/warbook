"""Replay short actual source histories to diagnose queue/task BC predictions."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sys


def select_sources(paths, limit):
    # Round robin across map/opponent cells, independent of model predictions.
    cells = defaultdict(list)
    for path in sorted(paths):
        cells[str(Path(path).parent)].append(path)
    selected = []
    while any(cells.values()) and len(selected) < limit:
        for key in sorted(cells):
            if cells[key] and len(selected) < limit:
                selected.append(cells[key].pop(0))
    return selected


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--model', action='append', required=True)
    ap.add_argument('--sources', type=int, default=8)
    ap.add_argument('--until-tick', type=int, default=5000)
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    import torch
    from commander_train import load_model, compact_world
    from commander_model import HIDDEN, pack, pack_actions
    from commander_sequence import training_action, canonical_action
    from experiment_storage import open_text
    torch.set_num_threads(1)
    sources = select_sources(json.loads(Path(args.episodes).read_text()), args.sources)
    histories = []
    for path in sources:
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
        histories.append((path, rows))
    result = {'scope': 'Recorded source-world histories from zero current-model hidden; teacher-forced conditional chain. These sources may be training data, and these predictions are not playing-strength evidence.',
              'sources': sources, 'untilTick': args.until_tick, 'models': []}
    for model_path in args.model:
        model = load_model(json.loads(Path(model_path).read_text()))
        model.eval()
        counts = Counter()
        first_power = []
        for path, rows in histories:
            hidden = torch.zeros(1, HIDDEN)
            with torch.no_grad():
                for row in rows:
                    data = pack([row['world']], model.vocabulary)
                    label = canonical_action(training_action(row, 'bc'), row['world'], model.encoding)
                    actions = pack_actions([label], data)
                    p = model(data, hidden, actions, return_conditionals=True)
                    hidden = p['hidden']
                    counts['frames'] += 1
                    for q, target in enumerate(label['queues']):
                        probability = p['conditionals']['queue' + str(q)]['probabilities'][0]
                        chosen = int(probability.argmax())
                        group = 'queue' + str(q) + ('SET' if target >= 4 else 'KEEP' if target == 0 else 'special')
                        counts[group + 'Labels'] += 1
                        counts[group + 'Correct'] += chosen == target
                        if row['tick'] == 75 and q == 0 and target >= 4:
                            first_power.append({'source': path, 'product': row['world']['productNames'][target - 4],
                                                'correct': chosen == target, 'argmax': chosen,
                                                'targetProbability': float(probability[target]), 'keepProbability': float(probability[0])})
                    chosen = p['conditionals']['kind']['probabilities'][0].argmax(-1).tolist()
                    for i, target in enumerate(label['kinds']):
                        group = ('taskKEEPactive' if row['world']['previousKinds'][i] >= 2 else 'taskKEEPempty') if target == 0 else 'taskEdit'
                        counts[group + 'Labels'] += 1
                        counts[group + 'Correct'] += chosen[i] == target
                        if group == 'taskKEEPactive' and chosen[i] != 0:
                            counts['taskKEEPactiveFalseSameKind' if chosen[i] == row['world']['previousKinds'][i] else 'taskKEEPactiveFalseNewKind'] += 1
                    chosen = p['conditionals']['unit']['probabilities'][0].argmax(-1).tolist()
                    for i, target in enumerate(label['units']):
                        group = 'memberKEEP' if target == 18 else 'memberDEPLOY' if target == 17 else 'memberChange'
                        counts[group + 'Labels'] += 1
                        counts[group + 'Correct'] += chosen[i] == target
        result['models'].append({'path': model_path, 'counts': dict(counts), 'firstPower': first_power})
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
