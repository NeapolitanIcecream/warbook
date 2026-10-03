"""A small source/record comparison of production commitments and actual assets."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--cases', required=True)
    args = ap.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    from experiment_storage import open_text
    results = []
    for directory in json.loads(Path(args.cases).read_text()):
        path = Path(directory)
        manifest = json.loads((path / 'manifest.json').read_text())
        result = json.loads((path / 'result.json').read_text())
        actor = next(p['name'] for p in manifest['participants'] if p['role'] == 'subject')
        observations = {}
        events = []
        labels = Counter()
        with open_text(path / 'decisions.ndjson') as stream:
            for line in stream:
                item = json.loads(line)
                if item.get('actor') != actor:
                    continue
                if item.get('kind') == 'observation':
                    observations[item['tick']] = item['observation']
                    continue
                if item.get('kind') != 'commander_decision':
                    continue
                row = item['record']
                labels[row.get('executionSource', row.get('policy', 'program-reference'))] += 1
                if row.get('observation'):
                    observations[row['tick']] = row['observation']
                if row.get('world'):
                    w = row['world']
                    for q, choice in enumerate(row['action']['queues']):
                        if choice == 0:
                            continue
                        product = w['productNames'][choice - 4] if choice >= 4 else ['KEEP', 'CLEAR', 'PAUSE', 'CANCEL'][choice]
                        expert = row.get('teacherAction', {}).get('queues', [0] * 6)[q]
                        expert_product = w['productNames'][expert - 4] if expert >= 4 else ['KEEP', 'CLEAR', 'PAUSE', 'CANCEL'][expert]
                        events.append({'tick': row['tick'], 'queue': q, 'product': product,
                                       'amount': [1, 2, 4, 8, -1][row['action']['amounts'][q]] if choice >= 4 else None,
                                       'cash': [0, 250, 500, 1000, 2000, 4000][row['action']['cash'][q]] if choice >= 4 else None,
                                       'expertProduct': expert_product,
                                       'credits': round(math.expm1(w['global'][1] * 10)),
                                       'previousProduct': w['queueNames'][q]})
                elif row.get('plan', {}).get('production', {}).get('program'):
                    for order in row['plan']['production']['program']['queues']:
                        if order.get('target', 0) or order.get('mode', 'run') != 'run':
                            events.append({'tick': row['tick'], 'queue': order['queue'], 'product': order.get('product'),
                                           'target': order['target'], 'cash': order.get('reserve'),
                                           'credits': row['observation']['credits']})
        first = {}
        peak = Counter()
        snapshots = []
        for tick, o in sorted(observations.items()):
            own = Counter(u['name'] for u in o['own'])
            for name, count in own.items():
                first.setdefault(name, tick)
                peak[name] = max(peak[name], count)
            if tick % 1500 == 0 or not snapshots:
                snapshots.append({'tick': tick, 'credits': o['credits'], 'own': own,
                                  'enemies': Counter(u['name'] for u in o['enemies']),
                                  'queues': o['queues']})
        # Last legal observation survives separately even if it misses the grid.
        tick, o = max(observations.items())
        snapshots.append({'tick': tick, 'credits': o['credits'], 'own': Counter(u['name'] for u in o['own']), 'enemies': Counter(u['name'] for u in o['enemies']), 'queues': o['queues']})
        results.append({'directory': directory, 'actor': actor, 'terminalTick': result['tick'],
                        'result': result.get('outcome'), 'executionSources': labels,
                        'firstObserved': first, 'peakObserved': peak, 'snapshots': snapshots,
                        'queueEvents': events})
    print(json.dumps({'scope': 'Real complete development attempts; first/peak are legal observation samples, not exact birth ticks; uncontrolled actual starts are not paired', 'cases': results}, indent=2))


if __name__ == '__main__':
    main()
