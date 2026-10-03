"""Bounded event-window BC probe with real current-weight episode prefixes.

This standalone script imports the frozen runtime read-only and writes only its
new output directory. It is a sampling experiment, not a deployed opening rule.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import random
import sys
import time
from types import SimpleNamespace


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--product', default='GAREFN')
    ap.add_argument('--chain', action='store_true', help='Concentrate the first deployment and complete necessary production/placement chain together')
    ap.add_argument('--updates', type=int, default=160)
    ap.add_argument('--seconds', type=float, default=180.)
    ap.add_argument('--sequence', type=int, default=3)
    ap.add_argument('--seed', type=int, default=83)
    args = ap.parse_args()
    if not 1 <= args.updates <= 160 or not 0 < args.seconds <= 180 or not 1 <= args.sequence <= 5:
        raise ValueError('This probe is bounded to 160 updates/180 seconds/5-frame windows')
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    import torch
    from commander_train import batch_steps, read_episode, load_model
    from commander_model import HIDDEN, export, pack, pack_actions
    from commander_sequence import canonical_action, training_action
    from commander_retention import current_hidden_for_batch
    torch.set_num_threads(1)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    paths = json.loads(Path(args.episodes).read_text())
    cells = defaultdict(list)
    for path in sorted(paths):
        cells[Path(path).parent.parent.name].append(path)
    train_paths = []
    check_paths = []
    for i, values in enumerate(cells.values()):
        opponents = sorted({Path(p).parent.name for p in values})
        train_paths.append(next(p for p in values if Path(p).parent.name == opponents[i % len(opponents)]))
        check_paths.append(next(p for p in values if Path(p).parent.name == opponents[(i + 1) % len(opponents)]))
    if len(train_paths) != 4 or len(check_paths) != 4 or set(train_paths) & set(check_paths):
        raise ValueError('This probe requires four maps and distinct source episodes')
    train = [read_episode(p) for p in train_paths]
    check = [read_episode(p) for p in check_paths]
    model = load_model(json.loads(Path(args.input).read_text()))
    positive = []
    negative = {}
    intervals = {}
    chain_products = {'GAPOWR', 'GAREFN', 'GAPILE', 'GAWEAP', 'E1', 'MTNK'} if args.chain else {args.product}
    for e in [*train, *check]:
        events = []
        seen = set()
        for index, row in enumerate(e['rows']):
            if row['tick'] > 5000:
                break
            label = training_action(row, 'bc')
            wanted = []
            for q, selected in enumerate(label['queues']):
                product = row['world']['productNames'][selected - 4] if selected >= 4 else None
                if product in chain_products and ('SET', q, product) not in seen:
                    wanted.append(('SET', q, product))
            for q, place in enumerate(label['placements']):
                placed = row['world']['placementObjects'][place - 1]['name'] if place else None
                if placed in chain_products and ('PLACE', q, placed) not in seen:
                    wanted.append(('PLACE', q, placed))
            if args.chain and 17 in label['units'] and ('DEPLOY',) not in seen:
                wanted.append(('DEPLOY',))
            if wanted:
                seen.update(wanted)
                events.append(index)
        if len(events) < 2:
            raise ValueError('Missing actual SET -> PLACE chain: ' + e['path'])
        if not args.chain:
            events = events[:2]
        intervals[e['path']] = (e['rows'][events[0]]['tick'], e['rows'][events[-1]]['tick'])
        negative[e['path']] = [start for start in range(max(0, events[0] - args.sequence), events[-1] + 1)
                              if start + args.sequence <= len(e['rows']) and all((all(q == 0 for q in training_action(r, 'bc')['queues']) if args.chain else training_action(r, 'bc')['queues'][0] == 0) and not any(training_action(r, 'bc')['placements']) and 17 not in training_action(r, 'bc')['units'] for r in e['rows'][start:start + args.sequence])]
        if not negative[e['path']]:
            raise ValueError('Missing same-stage KEEP windows')
        if e['path'] in train_paths:
            positive.extend((e, max(0, index - args.sequence + 1), index + 1) for index in events)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    plan = {'scope': 'Four complete development source episodes; four other already-seen sources used for the bounded recorded-state check, not final holdout',
            'input': args.input, 'inputSha256': hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
            'trainerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'runtime': args.runtime,
            'trainingEpisodes': train_paths, 'checkEpisodes': check_paths, 'product': args.product, 'completeChain': args.chain, 'chainProducts': sorted(chain_products),
            'eventWindows': [{'source': e['path'], 'startTick': e['rows'][start]['tick'], 'ticks': [r['tick'] for r in e['rows'][start:end]]} for e, start, end in positive],
            'sameStageKEEPWindows': {path: len(starts) for path, starts in negative.items()},
            'sequence': args.sequence, 'maxUpdates': args.updates, 'maxTrainingSeconds': args.seconds,
            'sampling': 'One event window and one same-source/stage all-KEEP window per update; cycle each actual event equally',
            'history': 'Rebuild every actual world from episode start with current weights before each selected window, detach only prefix; contiguous BPTT inside window',
            'loss': 'Unchanged full-plan factor BC, SET importance32, critic weight0.5; cold Adam3e-4 and clip0.5'}
    out.with_suffix('.plan.json').write_text(json.dumps(plan, indent=2) + '\n')

    @torch.no_grad()
    def measure(episodes):
        counts = Counter()
        samples = []
        for e in episodes:
            h = torch.zeros(1, HIDDEN)
            seen = set()
            low, high = intervals[e['path']]
            for r in e['rows']:
                if r['tick'] > 5000:
                    break
                d = pack([r['world']], model.vocabulary)
                label = canonical_action(training_action(r, 'bc'), r['world'], model.encoding)
                a = pack_actions([label], d)
                p = model(d, h, a, return_conditionals=True)
                h = p['hidden']
                for head, target in [*[(f'queue{q}', target) for q, target in enumerate(label['queues'])], ('place0', label['placements'][0])]:
                    probability = p['conditionals'][head]['probabilities'][0]
                    chosen = int(probability.argmax())
                    product = r['world']['productNames'][target - 4] if head.startswith('queue') and target >= 4 else r['world']['placementObjects'][target - 1]['name'] if head == 'place0' and target else None
                    if product:
                        group = head + '/' + product
                        counts[group + '/labels'] += 1
                        counts[group + '/correct'] += chosen == target
                        if head == 'place0':
                            counts[group + '/anyPLACE'] += chosen > 0
                        if group not in seen:
                            seen.add(group)
                            counts[group + '/firstLabels'] += 1
                            counts[group + '/firstCorrect'] += chosen == target
                        if product == args.product:
                            samples.append({'source': e['path'], 'tick': r['tick'], 'head': head, 'targetProbability': float(probability[target]), 'keepProbability': float(probability[0]), 'correct': chosen == target})
                    elif target == 0 and bool(p['conditionals'][head]['active'][0]) and low - 150 <= r['tick'] <= high + 150:
                        counts[head + '/stageKEEP/labels'] += 1
                        counts[head + '/stageKEEP/correct'] += chosen == 0
        return {'counts': dict(counts), 'targetEvents': samples}

    before = {'train': measure(train), 'check': measure(check)}
    optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
    objective_args = SimpleNamespace(method='bc', burn=0, sequence=args.sequence,
                                     bc_loss='factor', bc_event_weight=32., bc_queue_set_weight=32.)
    started = time.monotonic()
    prefix_frames = 0
    active_frames = 0
    exposures = Counter()
    losses = []
    schedule = positive[:]
    updates = 0
    for update in range(args.updates):
        if update % len(schedule) == 0:
            rng.shuffle(schedule)
        e, start, end = schedule[update % len(schedule)]
        keep_start = rng.choice(negative[e['path']])
        batch = [(e, [], e['rows'][start:end]), (e, [], e['rows'][keep_start:keep_start + args.sequence])]
        h, cost = current_hidden_for_batch(model, batch)
        batch = [(*item, h[i].tolist()) for i, item in enumerate(batch)]
        optimizer.zero_grad()
        loss, _, frames, _ = batch_steps(batch, model, objective_args, True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), .5)
        optimizer.step()
        updates += 1
        prefix_frames += cost
        active_frames += frames
        exposures[(e['path'], e['rows'][end - 1]['tick'])] += 1
        losses.append(float(loss.detach()))
        if time.monotonic() - started >= args.seconds:
            break
    seconds = time.monotonic() - started
    after = {'train': measure(train), 'check': measure(check)}
    metadata = {**plan, 'method': 'event-bc-probe', 'updates': updates, 'trainingSeconds': seconds,
                'prefixFrames': prefix_frames, 'activeFrames': active_frames,
                'eventUses': [{'source': path, 'tick': tick, 'uses': uses} for (path, tick), uses in sorted(exposures.items())],
                'before': before, 'after': after, 'meanLoss': sum(losses) / len(losses)}
    sha = export(model, out, metadata)
    metadata['sha256'] = sha
    out.with_suffix('.training.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata), flush=True)


if __name__ == '__main__':
    main()
