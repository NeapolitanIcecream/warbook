"""Read-only audit of actual BC label exposure and factor-loss coefficients.

Run in the pinned training runtime. The optional probability audit replays each
selected model's real-world history; it never executes a game or updates weights.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import random
import sys


def factor_labels(actions):
    import torch
    result = {name: actions[field] for name, field in
              [('kind', 'kinds'), ('goal', 'goals'), ('engagement', 'engagement'),
               ('unit', 'units'), ('building', 'buildings')]}
    for prefix, field, size in [('queue', 'queues', 6), ('amount', 'amounts', 6),
                                ('cash', 'cash', 6), ('place', 'placements', 2)]:
        result.update({prefix + str(i): actions[field][:, i] for i in range(size)})
    return result


def factor_domain(name):
    return ('production' if name.startswith(('queue', 'amount', 'cash')) else
            'tasks' if name in ('kind', 'goal', 'engagement') else
            'units' if name == 'unit' else 'buildings' if name == 'building' else
            'placement')


def factor_keep(name):
    return 18 if name == 'unit' else 0 if name.startswith(('queue', 'place')) or name in ('kind', 'building') else None


def factor_importance(name, labels, boost):
    import torch
    if name == 'unit':
        return torch.where(labels == 17, float(boost), min(float(boost), 4.))
    return min(float(boost), 8.) if name.startswith('place') else min(float(boost), 4.) if name.startswith('queue') or name in ('kind', 'building') else 1.


def original_coefficients(conditionals, labels, boost):
    """Reproduce the per-frame coefficient of -log(p) in model.factor BC."""
    import torch
    domains = defaultdict(lambda: [None, None])
    masks = {}
    for name, value in conditionals.items():
        active = value['active']
        keep = factor_keep(name)
        negative = active & (labels[name] == keep) if keep is not None else torch.zeros_like(active)
        changed = active & ~negative
        masks[name] = (changed, negative)
        axes = tuple(range(1, active.ndim))
        for i, x in enumerate((changed, negative)):
            total = x.sum(axes) if axes else x.long()
            old = domains[factor_domain(name)][i]
            domains[factor_domain(name)][i] = total if old is None else old + total
    domain_counts = {name: changed + (negative > 0) for name, (changed, negative) in domains.items()}
    active_domains = sum((count > 0).long() for count in domain_counts.values()).clamp_min(1)
    out = {}
    for name, (changed, negative) in masks.items():
        count = domain_counts[factor_domain(name)].clamp_min(1)
        n = domains[factor_domain(name)][1].clamp_min(1)
        denominator = count * active_domains
        while denominator.ndim < changed.ndim:
            denominator = denominator[:, None]
            n = n[:, None]
        out[name] = (changed * factor_importance(name, labels[name], boost) + negative / n) / denominator
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--receipt', required=True)
    ap.add_argument('--batch', type=int, default=32)
    ap.add_argument('--model', action='append', default=[])
    ap.add_argument('--probability-sources', type=int, default=4)
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    import torch
    from commander_train import read_episode, load_model
    from commander_model import CommanderModel, HIDDEN, pack, pack_actions
    from commander_sequence import canonical_action, training_action
    torch.set_num_threads(1)
    receipt = json.loads(Path(args.receipt).read_text())
    paths = json.loads(Path(args.episodes).read_text())
    names = set()
    episodes = []
    for path in paths:
        e = read_episode(path)
        if e:
            episodes.append(e)
            names.update(n for r in e['rows'] for f in ['entityNames', 'productNames', 'goalNames'] for n in r['world'][f] if n)
    model = CommanderModel(sorted(names), 'graph-plan-v4')
    counter = defaultdict(Counter)
    sources = defaultdict(set)
    frame_counter = Counter()
    first_power = []
    for episode in episodes:
        selected = episode['rows']
        for start in range(0, len(selected), args.batch):
            rows = selected[start:start + args.batch]
            data = pack([r['world'] for r in rows], model.vocabulary)
            actions = [canonical_action(training_action(r, 'bc'), r['world'], model.encoding) for r in rows]
            packed_actions = pack_actions(actions, data)
            labels = factor_labels(packed_actions)
            with torch.no_grad():
                prediction = model(data, torch.zeros(len(rows), HIDDEN), packed_actions, return_conditionals=True)
            coefficients = original_coefficients(prediction['conditionals'], labels, receipt['bcEventWeight'])
            for name, conditional in prediction['conditionals'].items():
                active = conditional['active']
                keep = factor_keep(name)
                for j, row in enumerate(rows):
                    values = labels[name][j].reshape(-1)
                    enabled = active[j].reshape(-1)
                    weights = coefficients[name][j].reshape(-1)
                    for k in range(len(values)):
                        if not enabled[k]:
                            continue
                        value = int(values[k])
                        event = 'KEEP' if keep is not None and value == keep else 'change'
                        bucket = name + '/' + event
                        if name == 'unit' and value == 17:
                            bucket = 'unit/DEPLOY'
                        elif name.startswith('queue') and value >= 4:
                            bucket = name + '/SET'
                        elif name == 'kind' and value:
                            old = row['world']['previousKinds'][k]
                            bucket = 'kind/' + ('same-kind-edit' if old == value else 'new-kind')
                        counter[bucket]['factors'] += 1
                        counter[bucket]['coefficientMass'] += float(weights[k])
                        sources[bucket].add(episode['path'])
                        if name == 'queue0' and value >= 4 and row['world']['productNames'][value - 4] == 'GAPOWR':
                            first_power.append({'path': episode['path'], 'tick': row['tick'], 'coefficient': float(weights[k])})
            frame_counter['frames'] += len(rows)
            frame_counter['framesWithQueueSet'] += sum(any(x >= 4 for x in a['queues']) for a in actions)
            frame_counter['framesWithTaskEdit'] += sum(any(a['kinds']) for a in actions)
            frame_counter['taskKeepLabels'] += sum(a['kinds'].count(0) for a in actions)
            frame_counter['taskSlotLabels'] += len(actions) * 16
            frame_counter['teacherActionFrames'] += sum('teacherAction' in r for r in rows)
    result = {'schema': 1, 'scope': 'Actual complete training source decisions; coefficient mass is the exact coefficient of each -log(p) before the outer frame mean. It is not a gradient or a playing-strength measure.',
              'sourceGames': len(episodes), 'receiptUpdates': receipt['updates'], 'receiptFrameUses': receipt['trainingUsage']['activeFrames'],
              'frameCounts': dict(frame_counter),
              'factorExposure': {name: dict(value, sourceGames=len(sources[name])) for name, value in sorted(counter.items())},
              'powerSETs': first_power,
              'receiptSha256': hashlib.sha256(Path(args.receipt).read_bytes()).hexdigest(),
              'episodesSha256': hashlib.sha256(Path(args.episodes).read_bytes()).hexdigest()}
    result['openingPredictions'] = []
    for model_path in args.model:
        current = load_model(json.loads(Path(model_path).read_text()))
        current.eval()
        for episode in sorted(episodes, key=lambda e: e['path'])[:args.probability_sources]:
            hidden = torch.zeros(1, HIDDEN)
            with torch.no_grad():
                for row in episode['rows'][:65]:
                    data = pack([row['world']], current.vocabulary)
                    action = canonical_action(training_action(row, 'bc'), row['world'], current.encoding)
                    labels = pack_actions([action], data)
                    prediction = current(data, hidden, labels, return_conditionals=True)
                    hidden = prediction['hidden']
                    if row['tick'] == 75:
                        probability = prediction['conditionals']['queue0']['probabilities'][0]
                        power = row['world']['productNames'].index('GAPOWR') + 4
                        result['openingPredictions'].append({'model': model_path, 'source': episode['path'], 'tick': 75, 'keepProbability': float(probability[0]), 'powerProbability': float(probability[power]), 'argmax': int(probability.argmax())})
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
