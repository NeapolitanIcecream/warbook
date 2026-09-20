"""Bounded continuation of the existing MLP experiment, with alternating routes.

Uses the existing full-game runner/trainer; no player promotion or new policy schema.
Checkpoints and complete-game evidence stay on the experiment host.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

from launch_batch import atomic


class BoundaryReached(Exception):
    pass


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def neural(path, mode='bastion', deterministic=True):
    return dict(policy='model', model=str(path), mode=mode, deterministic=deterministic)


def select(counts, names):
    # First entry is the incumbent; equal win counts preserve it.
    return max(names, key=lambda name: counts[name]['W'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--expanded', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--train-until', required=True, help='ISO-8601 time with timezone')
    ap.add_argument('--cycles', type=int, default=8)
    ap.add_argument('--game-budget', type=int, default=60000)
    ap.add_argument('--smoke', action='store_true')
    a = ap.parse_args()
    deadline = dt.datetime.fromisoformat(a.train_until)
    if deadline.tzinfo is None:
        raise ValueError('Use an explicit timezone for the training deadline')
    if not 1 <= a.cycles <= 8 or not 100 <= a.game_budget <= 60000:
        raise ValueError('Bound this job to 1..8 cycles and 100..60000 games')
    base, expanded, root = map(lambda p: Path(p).resolve(), (a.base, a.expanded, a.out))
    if any(read(p/'status.json')['phase'] != 'complete' for p in [base, expanded]):
        raise ValueError('Both preceding experiments must be complete')
    root.mkdir(parents=True, exist_ok=True)
    models = root/'models'
    models.mkdir(exist_ok=True)
    node = os.environ.get('WARBOOK_NODE', 'node')
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    identity = dict(git=source, base=str(base), expanded=str(expanded),
                    expansionSha256=digest(expanded/'expansion.json'),
                    trainUntil=a.train_until, cycles=a.cycles, gameBudget=a.game_budget,
                    smoke=a.smoke)
    if (root/'experiment.json').exists() and read(root/'experiment.json') != identity:
        raise ValueError('Source, inputs, or experiment budget changed')
    atomic(root/'experiment.json', identity)
    maps = ['mp06t2.map'] if a.smoke else ['mp29u2.map', 'mp06t2.map', 'mp08t2.map', 'mp03t4.map']
    fixed_pool = {'main-016': {'ref': 'v0.1.16'},
                  'pressure-016': {'ref': 'v0.1.16', 'mode': 'pressure'},
                  'old-defense': {'ref': 'b3a1f7c'}, 'supalosa': {'native': 'supalosa'}}
    if a.smoke:
        fixed_pool = {'supalosa': {'native': 'supalosa'}}
    workers = 4 if a.smoke else 96
    final_reserve = 64 if a.smoke else 4096

    def completed_games():
        total = 0
        for path in [*root.glob('*/batch.json'), *root.glob('scale/*/batch.json')]:
            summary = path.parent/'summary.json'
            if summary.exists():
                total += read(summary)['completed']
        return total

    def status(phase, **data):
        atomic(root/'status.json', dict(phase=phase, updatedAt=time.time(), workers=workers,
                                      completedGames=completed_games(), **data))
        print(json.dumps(dict(phase=phase, **data)), flush=True)

    def boundary(games=0):
        if time.time() >= deadline.timestamp():
            raise BoundaryReached('training time budget reached')
        if completed_games() + games + final_reserve > a.game_budget:
            raise BoundaryReached('game budget reserved for final comparisons')
        if shutil.disk_usage(root).free < 50*2**30:
            raise BoundaryReached('less than 50 GiB free; preserve results and finish')

    def command(name, cmd, final=False):
        marker = root/(name+'.done.json')
        if marker.exists():
            return
        if not final:
            boundary()
        status(name)
        with (root/(name+'.log')).open('w') as log:
            subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, check=True)
        atomic(marker, {'completedAt': time.time()})

    def batch(name, subjects, rounds, pool=None, seed=301, final=False):
        pool = pool or fixed_pool
        plan = dict(subjects=subjects, opponents=pool, maps=maps, rounds=rounds,
                    workers=workers, trace='launch', orderSeed=seed, policySeed=seed, seconds=900)
        path = root/(name+'.plan.json')
        if path.exists() and read(path) != plan:
            raise ValueError(f'{name}: plan changed on resume')
        atomic(path, plan)
        if not (root/(name+'.done.json')).exists():
            planned = len(subjects)*len(pool)*len(maps)*rounds
            partial = root/name/'summary.json'
            remaining = planned - (read(partial)['completed'] if partial.exists() else 0)
            if not final:
                boundary(remaining)
            elif completed_games() + remaining > a.game_budget:
                raise ValueError('Final comparison exceeds the explicit game budget')
        command(name, [sys.executable, 'analysis/launch_batch.py', str(path),
                       '--out', str(root/name), '--resume'], final=final)
        return read(root/name/'summary.json')

    def train(name, episodes, seed, previous=None):
        model = models/(name+'.json')
        cmd = [sys.executable, 'analysis/launch_train.py', 'ppo' if previous else 'bc',
               '--episodes', str(episodes), '--out', str(model), '--seed', str(seed), '--threads', '4']
        if previous:
            cmd += ['--input', str(previous)]
        command(name, cmd)
        command(name+'-parity', [node, '--import', 'tsx', 'scripts/check-launch-model.ts',
                               str(model), str(model.with_suffix('.golden.json'))])
        return model

    def freeze(name, spec):
        marker = root/(name+'.release.json')
        if not marker.exists():
            status(name)
            output = subprocess.check_output([node, '--import', 'tsx', 'scripts/build-bot.ts',
                       '--ref', 'HEAD', '--mode', spec.get('mode', 'bastion'),
                       '--launch-model', spec['model']], text=True)
            atomic(marker, json.loads(output.splitlines()[-1]))
        return {'release': read(marker)['path']}

    main_bc = {str(seed): neural(expanded/f'models/bc-seed-{seed}.json') for seed in [47, 83]}
    main_lanes = {str(seed): neural(expanded/f'models/ppo-seed-{seed}-3.json') for seed in [47, 83]}
    pressure_bc = neural(expanded/'models/pressure-bc.json', 'pressure')
    pressure_start = neural(expanded/'models/pressure-ppo-3.json', 'pressure')
    old_comparison = read(expanded/'main-comparison.plan.json')
    linear = old_comparison['subjects']['linear']
    original_bc = neural(base/'models/bc.json')
    main_incumbent = main_lanes['83']
    pressure_incumbent = pressure_start
    cycles_finished = 0
    stalled = 0
    stopped = 'cycle budget completed'
    try:
        if not a.smoke:
            boundary(1024)
            command('scale', [sys.executable, 'analysis/launch_scale.py', '--model', main_incumbent['model'],
                             '--out', str(root/'scale'), '--workers', '96,128', '--rounds', '32'])
            measures = [m for m in read(root/'scale/summary.json') if m['measurementComplete']]
            if not measures:
                raise ValueError('No complete sampling measurement')
            workers = max(measures, key=lambda m: m['engineTicksPerSecond'])['workers']
            atomic(root/'workers.json', {'workers': workers, 'measurements': measures})

        matched = {**{f'ppo-{s}': v for s, v in main_lanes.items()},
                   **{f'bc-{s}': v for s, v in main_bc.items()},
                   'bc-original': original_bc, 'linear': linear,
                   'teacher': {'policy': 'teacher'}, 'baseline': {'ref': 'v0.1.16'}}
        initial = batch('matched-initialization', matched, 2 if a.smoke else 16, seed=307)
        for seed in main_lanes:
            winner = select(initial['counts'], [f'bc-{seed}', f'ppo-{seed}'])
            main_lanes[seed] = matched[winner]
        # Preserve exact winner identity (the per-seed starting choice can differ).
        main_incumbent = matched[select(initial['counts'], ['ppo-83', 'bc-83', 'ppo-47', 'bc-47'])]
        frozen_main = freeze('initial-main', main_incumbent)
        pressure_pool = {'main-016': {'ref': 'v0.1.16'}, 'new-main': frozen_main,
                         'old-defense': {'ref': 'b3a1f7c'}, 'pressure-016': {'ref': 'v0.1.16', 'mode': 'pressure'}}
        if a.smoke:
            pressure_pool = {'new-main': frozen_main}
        pressure_initial = batch('pressure-initialization',
            {'bc': pressure_bc, 'ppo': pressure_start, 'teacher': {'policy': 'teacher', 'mode': 'pressure'},
             'baseline': {'ref': 'v0.1.16', 'mode': 'pressure'}}, 2 if a.smoke else 8,
            pressure_pool, seed=311)
        pressure_incumbent = {'bc': pressure_bc, 'ppo': pressure_start}[select(pressure_initial['counts'], ['bc', 'ppo'])]
        second_bc = neural(train('pressure-bc-211', expanded/'pressure-teacher/teacher-episodes.json', 211), 'pressure')
        pressure_lanes = {'101': pressure_incumbent, '211': second_bc}
        pressure_reference = freeze('initial-pressure', pressure_incumbent)

        # Expand the cheap alternative once; retain its original incumbent too.
        rng = random.Random(313)
        linear_candidates = {'incumbent': linear}
        for i in range(2 if a.smoke else 64):
            path = models/f'linear-{i:03d}.json'
            params = dict(bias=rng.uniform(-8, -1), power=rng.uniform(.5, 1.5), threat=rng.uniform(.7, 2),
                          distance=rng.uniform(.01, .06), objective=rng.uniform(0, 3),
                          retained=rng.uniform(-.2, .2), spread=rng.uniform(0, .8), fog=rng.uniform(0, 3))
            atomic(path, dict(format='warbook-launch-linear-v1', schema='launch-v1', params=params))
            linear_candidates[f'candidate-{i:03d}'] = dict(policy='linear', model=str(path), deterministic=True)
        search = batch('linear-search', linear_candidates, 2 if a.smoke else 1, seed=313)
        names = sorted(linear_candidates, key=lambda n: -search['counts'][n]['W'])[:4]
        finalists = {n: linear_candidates[n] for n in dict.fromkeys(['incumbent', *names])}
        recheck = batch('linear-recheck', finalists, 2 if a.smoke else 8, seed=317)
        linear = finalists[select(recheck['counts'], list(finalists))]

        for cycle in range(1 if a.smoke else a.cycles):
            boundary()
            prefix = f'cycle-{cycle:02d}'
            changed = False
            main_pool = {k: v for k, v in fixed_pool.items() if k != 'supalosa'}
            main_pool['adaptive-pressure'] = pressure_reference
            for route, lanes, pool in [('main', main_lanes, main_pool), ('pressure', pressure_lanes, None)]:
                if route == 'pressure':
                    pool = dict(pressure_pool, **{'new-main': frozen_main})
                for lane, spec in list(lanes.items()):
                    previous = Path(spec['model'])
                    for update in range(1 if a.smoke else 2):
                        name = f'{prefix}-{route}-{lane}-rollout-{update}'
                        seed = 10000 + cycle*1000 + int(lane)*3 + update
                        batch(name, {'policy': neural(previous, spec['mode'], False)},
                              2 if a.smoke else 32, pool, seed=seed)
                        previous = train(name+'-update', root/name/'policy-episodes.json', seed, previous)
                    lanes[lane] = neural(previous, spec['mode'])
                if route == 'main':
                    subjects = {'incumbent': main_incumbent, **{f'new-{k}': v for k, v in lanes.items()},
                                'linear': linear, 'bc-47': main_bc['47'], 'bc-83': main_bc['83'],
                                'baseline': {'ref': 'v0.1.16'}}
                    evaluation_pool = dict(fixed_pool, **{'adaptive-pressure': pressure_reference})
                else:
                    subjects = {'incumbent': pressure_incumbent, **{f'new-{k}': v for k, v in lanes.items()},
                                'bc': pressure_bc, 'bc-211': second_bc,
                                'baseline': {'ref': 'v0.1.16', 'mode': 'pressure'}}
                    evaluation_pool = pool
                evaluation = batch(f'{prefix}-{route}-comparison', subjects, 2 if a.smoke else 8,
                                   evaluation_pool, seed=20000+cycle*2+(route == 'pressure'))
                winner = select(evaluation['counts'], ['incumbent', *[f'new-{k}' for k in lanes]])
                changed |= winner != 'incumbent'
                if route == 'main':
                    main_incumbent = subjects[winner]
                    frozen_main = freeze(prefix+'-main', main_incumbent)
                else:
                    pressure_incumbent = subjects[winner]
                    pressure_reference = freeze(prefix+'-pressure', pressure_incumbent)
                atomic(root/(f'{prefix}-{route}-selection.json'), dict(winner=winner, subject=subjects[winner],
                       counts=evaluation['counts'], note='Development opponent selection only; final fresh games follow.'))
            cycles_finished = cycle+1
            stalled = 0 if changed else stalled+1
            atomic(root/(prefix+'.checkpoint.json'), dict(main=main_incumbent, pressure=pressure_incumbent,
                   mainLanes=main_lanes, pressureLanes=pressure_lanes, stalledCycles=stalled))
            if stalled >= 2:
                stopped = 'two complete alternating cycles retained neither new route; final comparison'
                break
    except BoundaryReached as exc:
        stopped = str(exc)

    # These fresh games are not used for another policy update or automatic promotion.
    final_main = batch('final-main', {'candidate': main_incumbent, 'linear': linear,
        'ppo-47-start': neural(expanded/'models/ppo-seed-47-3.json'),
        'ppo-83-start': neural(expanded/'models/ppo-seed-83-3.json'),
        'bc-47': main_bc['47'], 'bc-83': main_bc['83'], 'baseline': {'ref': 'v0.1.16'}},
        2 if a.smoke else 16, seed=30001, final=True)
    final_main_release = freeze('final-main-opponent', main_incumbent)
    final_pressure = batch('final-pressure', {'candidate': pressure_incumbent, 'bc': pressure_bc,
        'ppo-start': pressure_start, 'baseline': {'ref': 'v0.1.16', 'mode': 'pressure'}},
        2 if a.smoke else 16,
        {'main-016': {'ref': 'v0.1.16'}, 'new-main': final_main_release}, seed=30003, final=True)
    status('complete', stopped=stopped, cyclesCompleted=cycles_finished,
           main=main_incumbent, pressure=pressure_incumbent,
           mainCounts=final_main['counts'], pressureCounts=final_pressure['counts'],
           note='Seen development maps; no paired starts, unseen-generalization claim or player promotion.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if '--out' in sys.argv:
            root = Path(sys.argv[sys.argv.index('--out')+1])
            root.mkdir(parents=True, exist_ok=True)
            atomic(root/'status.json', dict(phase='failed', error=f'{type(error).__name__}: {error}', updatedAt=time.time()))
        raise
