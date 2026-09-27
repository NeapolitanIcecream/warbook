"""Measure SET order persistence and observed stock, not causal production gain.

Only the subject's legal observations and commander records are read. A SET lasts
until the next non-KEEP in its queue. The closing observation precedes that edit
and can contain the old order's effects; the closing decision does not extend it.
First-owned appearances are a birth proxy, excluding returning known references.
Grants, prior commitments, losses and temporary absence limit attribution.
"""
import argparse
import collections
import concurrent.futures
import json
import math
import statistics
from pathlib import Path

from experiment_storage import open_text
from launch_outcome import classify

AMOUNTS = [1, 2, 4, 8, -1]
CASH_FLOORS = [0, 250, 500, 1000, 2000, 4000]
DEFAULT_GRANTS = {'GAREFN': 'CMIN', 'NAREFN': 'HARV'}


def committed_stock(observation, name):
    catalogue = {p['name']: p for p in observation.get('catalogue', [])}
    def grants(product):
        value = catalogue.get(product, {}).get('grants')
        return DEFAULT_GRANTS.get(product) if value is None else value
    return (sum(u['name'] == name for u in observation['own'])
            + sum(item['quantity'] for q in observation['queues'] for item in q['items']
                  if item['name'] == name or grants(item['name']) == name)
            + sum(u.get('buildStatus') == 0 and grants(u['name']) == name
                  for u in observation['own']))


def decoded_count(value):
    count = math.expm1(value * 5)
    if not math.isfinite(count) or abs(count - round(count)) > 1e-3:
        raise ValueError('Invalid encoded stock count')
    return round(count)


def world_snapshot(world):
    # world.ts puts own entities first; references are equality keys, not features.
    refs = collections.defaultdict(set)
    for ref, name in zip(world['ownRefs'], world['entityNames']):
        refs[name].add(ref)
    stock = {}
    for name, row in zip(world['productNames'], world['products']):
        owned = decoded_count(row[18])
        if owned != len(refs[name]):
            raise ValueError('Own stock/name mapping mismatch: ' + name)
        stock[name] = {'own': owned, 'committed': decoded_count(row[19]), 'available': bool(row[17])}
    return {'tick': world['tick'], 'refs': refs, 'stock': stock,
            'credits': round(math.expm1(world['global'][1] * 10), 6),
            'status': [q[0] for q in world['queues']]}


def analyze_records(records, directory, end_tick):
    active = {}; events = []; seen = set(); catalogue = {}; raw = None
    last_tick = None; stock_checks = 0

    def observe(event, snap, newly_owned):
        state = snap['stock'][event['product']]
        event['lastObservedTick'] = snap['tick']
        event['endOwned'] = state['own']; event['endCommitted'] = state['committed']
        event['peakOwned'] = max(event['peakOwned'], state['own'])
        event['peakCommitted'] = max(event['peakCommitted'], state['committed'])
        event['stockDropObserved'] |= state['own'] < event['startOwned'] or state['committed'] < event['startCommitted']
        event['firstOwnedAppearances'] += len(snap['refs'][event['product']] & newly_owned)
        status = snap['status'][event['queue']]
        if snap['tick'] > event['tick'] and status == 2:
            event['pausedQueueObservedAfterSet'] = True
        if event['_status'] == 1 and status == 2 and (event['_below'] or snap['credits'] < event['reserve']):
            event['pauseTransitionsNearCashFloor'] += 1
        event['_status'] = status

    def close(event, tick, reason):
        event.update(endTick=tick, endReason=reason, durationTicks=tick-event['tick'],
                     rightCensored=reason == 'terminal')
        event['netCommittedChange'] = event['endCommitted']-event['startCommitted']
        event['netOwnedChange'] = event['endOwned']-event['startOwned']
        event.pop('_status'); event.pop('_below')
        events.append(event)

    for item in records:
        if item['kind'] == 'observation':
            raw = item['observation']
            catalogue.update({p['name']: p for p in raw.get('catalogue', [])})
            continue
        if item['kind'] != 'commander_decision':
            continue
        record = item['record']; world = record['world']; action = record['action']
        snap = world_snapshot(world); tick = snap['tick']
        if last_tick is not None and tick-last_tick != 75:
            raise ValueError('Missing or out-of-order commander decision')
        last_tick = tick
        if raw and raw['tick'] == tick:
            for name, state in snap['stock'].items():
                if committed_stock(raw, name) != state['committed']:
                    raise ValueError(f'Raw/encoded committed stock mismatch at {tick}: {name}')
                stock_checks += 1
        present = set().union(*snap['refs'].values()) if snap['refs'] else set()
        newly_owned = present-seen; seen.update(present)
        for event in active.values():
            observe(event, snap, newly_owned)
        for queue, choice in enumerate(action['queues']):
            if choice == 0:
                continue
            if queue in active:
                close(active.pop(queue), tick, {1: 'clear', 2: 'pause', 3: 'cancel'}.get(choice, 'set'))
            if choice < 4:
                continue
            index = choice-4; product = world['productNames'][index]
            if world['productQueues'][index] != queue:
                raise ValueError('SET product/queue mismatch')
            amount = AMOUNTS[action['amounts'][queue]]; reserve = CASH_FLOORS[action['cash'][queue]]
            state = snap['stock'][product]
            active[queue] = {
                'eventId': {'directory': directory, 'tick': tick, 'queue': queue},
                'tick': tick, 'queue': queue, 'product': product, 'amount': amount, 'reserve': reserve,
                'executionSource': record.get('executionSource'),
                'target': -1 if amount < 0 else state['committed']+amount,
                'startOwned': state['own'], 'startCommitted': state['committed'],
                'priorCommitmentPresent': state['committed'] > state['own'],
                'peakOwned': state['own'], 'peakCommitted': state['committed'],
                'endOwned': state['own'], 'endCommitted': state['committed'], 'lastObservedTick': tick,
                'firstOwnedAppearances': 0, 'stockDropObserved': False, 'activeDecisionCount': 0,
                'belowReserveDecisionCount': 0, 'belowReserveWhileProducingCount': 0,
                'belowReserveWithPausedQueueCount': 0, 'pausedQueueObservedAfterSet': False,
                'pauseTransitionsNearCashFloor': 0, 'unavailableDecisionCount': 0,
                '_status': snap['status'][queue], '_below': False,
            }
        # Only the post-choice live run-mode orders count at this decision.
        for queue, event in active.items():
            below = snap['credits'] < event['reserve']; status = snap['status'][queue]
            event['activeDecisionCount'] += 1
            event['belowReserveDecisionCount'] += int(below)
            event['belowReserveWhileProducingCount'] += int(below and status == 1)
            event['belowReserveWithPausedQueueCount'] += int(below and status == 2)
            event['unavailableDecisionCount'] += int(not snap['stock'][event['product']]['available'])
            event['_below'] = below
    if last_tick is None:
        raise ValueError('No subject commander decisions')
    if not 0 <= end_tick-last_tick <= 75:
        raise ValueError('Invalid terminal observation boundary')
    for event in active.values():
        close(event, end_tick, 'terminal')
    grants = {name: {'grants': target, 'queue': 0} for name, target in DEFAULT_GRANTS.items()}
    grants.update(catalogue)
    for event in events:
        sources = sorted(name for name, rule in grants.items()
                         if (DEFAULT_GRANTS.get(name) if rule.get('grants') is None else rule['grants']) == event['product']
                         and rule.get('queue') != event['queue'])
        event['crossQueueGrantSources'] = sources
        # A descriptive threshold; no claim that the SET caused extra production.
        event['peakCommittedExceedsStartPlusOne'] = None if sources else event['peakCommitted'] > event['startCommitted']+1
    return {'events': sorted(events, key=lambda e: (e['tick'], e['queue'])),
            'rawEncodedStockChecks': stock_checks, 'lastDecisionTick': last_tick}


def summarize(events):
    lengths = [e['durationTicks'] for e in events]
    return {'sets': len(events), 'byAmount': dict(collections.Counter(str(e['amount']) for e in events)),
            'byReserve': dict(collections.Counter(str(e['reserve']) for e in events)),
            'ends': dict(collections.Counter(e['endReason'] for e in events)),
            'durationTicks': {'min': min(lengths, default=0), 'median': statistics.median(lengths) if lengths else 0, 'max': max(lengths, default=0)},
            'oneStepSetClear': sum(e['endReason'] == 'clear' and e['durationTicks'] == 75 for e in events),
            'amount1OneStepSetClear': sum(e['amount'] == 1 and e['endReason'] == 'clear' and e['durationTicks'] == 75 for e in events),
            'nonzeroReserveSets': sum(e['reserve'] > 0 for e in events),
            'cashBelowReserveObserved': sum(e['belowReserveDecisionCount'] > 0 for e in events),
            'pausedQueueAfterSetObserved': sum(e['pausedQueueObservedAfterSet'] for e in events),
            'peakCommittedExceedsStartPlusOne': sum(e['peakCommittedExceedsStartPlusOne'] is True for e in events),
            'crossQueueGrantExcluded': sum(bool(e['crossQueueGrantSources']) for e in events),
            'firstOwnedAppearances': sum(e['firstOwnedAppearances'] for e in events),
            'stockDropObserved': sum(e['stockDropObserved'] for e in events)}


def analyze_episode(directory):
    directory = Path(directory).resolve()
    manifest = json.loads((directory/'manifest.json').read_text()); result = json.loads((directory/'result.json').read_text())
    actor = next(p['name'] for p in manifest['participants'] if p['role'] == 'subject')
    with open_text(directory/'decisions.ndjson') as stream:
        records = (json.loads(line) for line in stream if '"commander_decision"' in line or '"observation"' in line)
        analyzed = analyze_records((e for e in records if e.get('actor') == actor), str(directory), result['tick'])
    outcome = classify(result, manifest)
    return {'directory': str(directory), 'actor': actor, 'outcome': outcome.outcome, 'reason': outcome.reason,
            'modelSha256': manifest.get('commanderExperiment', {}).get('modelSha256'),
            'summary': summarize(analyzed['events']), **analyzed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directories', nargs='*'); parser.add_argument('--episodes', type=Path)
    parser.add_argument('--out', type=Path, required=True); parser.add_argument('--workers', type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.workers <= 3:
        parser.error('--workers must be 1..3 (plus one coordinator)')
    directories = list(dict.fromkeys(args.directories + (json.loads(args.episodes.read_text()) if args.episodes else [])))
    if not directories:
        parser.error('Provide game directories or --episodes containing their JSON list')
    if args.workers == 1:
        games = [analyze_episode(path) for path in directories]
    else:
        with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as executor:
            games = list(executor.map(analyze_episode, directories))
    events = [event for game in games for event in game['events']]
    report = {'scope': '75-tick choices, persistent run-mode orders, and legal observed stock; not causal extra-output estimates',
              'summary': summarize(events), 'games': games}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'games': len(games), **report['summary']}))


if __name__ == '__main__':
    main()
