"""Two actual closed-loop cases: assets, miner roles/cargo and production choices."""
import argparse
from collections import Counter
import json
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
    kinds = ['keep', 'release', 'assemble', 'advance', 'defend', 'withdraw', 'scout', 'capture', 'harvest', 'screen', 'hold']
    results = []
    probe_frames = []
    for path in json.loads(Path(args.cases).read_text()):
        directory = Path(path)
        manifest = json.loads((directory / 'manifest.json').read_text())
        actor = next(p['name'] for p in manifest['participants'] if p['role'] == 'subject')
        snapshots = []
        miner_roles = []
        orders = []
        first = {}
        peak = Counter()
        with open_text(directory / 'decisions.ndjson') as stream:
            for line in stream:
                item = json.loads(line)
                if item.get('actor') != actor:
                    continue
                if item.get('kind') == 'observation':
                    o = item['observation']
                    counts = Counter(u['name'] for u in o['own'])
                    for name, count in counts.items():
                        first.setdefault(name, o['tick'])
                        peak[name] = max(peak[name], count)
                    if o['tick'] <= 13500:
                        snapshots.append({'tick': o['tick'], 'credits': o['credits'], 'own': counts,
                                          'miners': [{k: u.get(k) for k in ['ref', 'x', 'y', 'cargo', 'idle', 'hp']} for u in o['own'] if u['name'] == 'CMIN']})
                if item.get('kind') != 'commander_decision':
                    continue
                r = item['record']
                w, a, expert = r['world'], r['action'], r['teacherAction']
                def role_kind(choice, i, action):
                    role = w['previousRoles'][i] if choice == 18 else choice
                    if role >= 16:
                        return ['reserve', 'deploy', 'unassigned', 'unassigned'][min(role - 16, 3)]
                    kind = action['kinds'][role] or w['previousKinds'][role]
                    return kinds[kind]
                for i, entity in enumerate(w['unitIndices']):
                    if w['entityNames'][entity] != 'CMIN':
                        continue
                    if r['tick'] <= 13500 and r['tick'] % 450 == 0:
                        miner_roles.append({'tick': r['tick'], 'ref': w['unitRefs'][i],
                                            'actualRole': role_kind(a['units'][i], i, a),
                                            'expertRole': role_kind(expert['units'][i], i, expert),
                                            'cargo': round(w['entities'][entity][32] * 40, 3)})
                if r['tick'] <= 8000:
                    for q in [0, 2, 3]:
                        choice = a['queues'][q]
                        if choice >= 4:
                            orders.append({'tick': r['tick'], 'queue': q, 'product': w['productNames'][choice - 4],
                                           'amount': [1, 2, 4, 8, -1][a['amounts'][q]], 'cash': [0, 250, 500, 1000, 2000, 4000][a['cash'][q]]})
                # One non-initial miner state from each real game checks the shared context.
                if not any(f['source'] == path for f in probe_frames) and r['tick'] >= 4500 and any(w['entityNames'][e] == 'CMIN' for e in w['unitIndices']):
                    probe_frames.append({'source': path, 'tick': r['tick'], 'world': w, 'hidden': r['hidden'], 'action': a, 'teacherAction': expert})
        results.append({'source': path, 'firstObserved': first, 'peakObserved': peak,
                        'snapshots': snapshots, 'minerRoles': miner_roles, 'ordersBefore8000': orders})
    print(json.dumps({'scope': 'Two real completed games; legal sampled assets/cargo and actually decoded unit assignments, not inferred win causes', 'cases': results, 'probeFrames': probe_frames}, indent=2))


if __name__ == '__main__':
    main()
