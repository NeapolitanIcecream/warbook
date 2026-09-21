"""Bounded comparison of launch-only and persistent-operation permissions.

Both receive operation-v2 facts and their own BC/PPO initialization. Main and
pressure learn alternately against the same frozen rivals within each comparison.
Uses the existing real-game batch, trainer, exporter and throughput calibration.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from launch_batch import atomic


def read(path):
    return json.loads(Path(path).read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--workers', type=int, default=64)
    ap.add_argument('--updates', type=int, default=2)
    ap.add_argument('--seeds', default='47,83')
    ap.add_argument('--calibrate', action='store_true')
    args = ap.parse_args()
    if not 1 <= args.updates <= 3 or not 1 <= args.workers <= 128:
        raise ValueError('Bound updates to 1..3 and workers to 1..128')
    seeds = [47] if args.smoke else list(map(int, args.seeds.split(',')))
    if not 1 <= len(seeds) <= 3 or len(set(seeds)) != len(seeds):
        raise ValueError('Use 1..3 distinct repeat seeds')
    root = Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=True)
    models = root/'models'
    models.mkdir(exist_ok=True)
    node = os.environ.get('WARBOOK_NODE', 'node')
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    identity = dict(git=source, smoke=args.smoke, seeds=seeds, updates=args.updates,
                    initialWorkers=args.workers, calibrate=args.calibrate,
                    evaluation='seen development maps; independent uncontrolled starts; U=0; E excluded and reported')
    if (root/'experiment.json').exists() and read(root/'experiment.json') != identity:
        raise ValueError('Source or experiment configuration changed on resume')
    atomic(root/'experiment.json', identity)
    maps = ['mp06t2.map'] if args.smoke else ['mp29u2.map', 'mp06t2.map', 'mp08t2.map', 'mp03t4.map']
    fixed = {'supalosa': {'native': 'supalosa'}} if args.smoke else {
        'main-016': {'ref': 'v0.1.16'}, 'pressure-016': {'ref': 'v0.1.16', 'mode': 'pressure'},
        'old-defense': {'ref': 'b3a1f7c'}, 'supalosa': {'native': 'supalosa'}}
    workers = min(4, args.workers) if args.smoke else args.workers
    routes = {'main': 'bastion', 'pressure': 'pressure'}
    scopes = ['launch', 'operation']
    groups = {f'{route}-{scope}': dict(mode=mode, scope=scope)
              for route, mode in routes.items() for scope in scopes}

    def status(phase, **kw):
        atomic(root/'status.json', dict(phase=phase, updatedAt=time.time(), workers=workers, **kw))
        print(json.dumps(dict(phase=phase, **kw)), flush=True)

    def command(name, cmd):
        marker = root/(name+'.done.json')
        if marker.exists():
            return
        if shutil.disk_usage(root).free < 50*2**30:
            raise RuntimeError('Less than 50 GiB free; preserve artifacts before another stage')
        status(name)
        with (root/(name+'.log')).open('w') as log:
            subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, check=True)
        atomic(marker, {'completedAt': time.time()})

    def batch(name, subjects, rounds, pool=None, seed=47):
        plan = dict(subjects=subjects, opponents=pool or fixed, maps=maps, rounds=rounds,
                    workers=workers, trace='launch', orderSeed=seed, policySeed=seed, seconds=900)
        path = root/(name+'.plan.json')
        if path.exists() and read(path) != plan:
            raise ValueError(f'{name}: plan changed on resume')
        atomic(path, plan)
        command(name, [sys.executable, 'analysis/launch_batch.py', str(path), '--out', str(root/name), '--resume'])
        return read(root/name/'summary.json')

    def train(name, method, episodes, seed, previous=None):
        path = models/(name+'.json')
        cmd = [sys.executable, 'analysis/launch_train.py', method, '--episodes', str(episodes),
               '--out', str(path), '--seed', str(seed), '--threads', '4']
        if previous:
            cmd += ['--input', str(previous)]
        if args.smoke:
            cmd += ['--epochs', '1']
        command(name, cmd)
        command(name+'-parity', [node, '--import', 'tsx', 'scripts/check-launch-model.ts',
                                str(path), str(path.with_suffix('.golden.json'))])
        return path

    def subject(path, group, deterministic=True):
        return dict(policy='model', model=str(path), deterministic=deterministic, **groups[group])

    def freeze(path, route):
        name = f'freeze-{route}-{path.stem}'
        command(name, [node, '--import', 'tsx', 'scripts/build-bot.ts', '--ref', source,
                       '--mode', routes[route], '--launch-model', str(path)])
        return read_last_line(root/(name+'.log'))['path']

    # Each scope/route gets its own actual teacher trajectories and complete-game split.
    batch('teacher', {group: dict(policy='teacher', **cfg) for group, cfg in groups.items()},
          2 if args.smoke else 8)
    initial, current = {}, {}
    for group in groups:
        for seed in seeds:
            key = f'{group}-{seed}'
            initial[key] = train(f'{key}-bc', 'bc', root/'teacher'/f'{group}-episodes.json', seed)
            current[key] = initial[key]
    bc_rank = batch('bc-development', {key: subject(path, key.rsplit('-', 1)[0]) for key, path in initial.items()}, 1)
    retained = {}
    for group in groups:
        best = max([f'{group}-{seed}' for seed in seeds], key=lambda k: bc_rank['counts'][k]['W'])
        retained[group] = initial[best]

    if args.calibrate and not args.smoke:
        command('calibration', [sys.executable, 'analysis/launch_scale.py', '--model',
                               str(initial[f'main-operation-{seeds[0]}']), '--out', str(root/'calibration'),
                               '--workers', '96,128', '--rounds', '32'])
        measurements = [m for m in read(root/'calibration/summary.json') if m['measurementComplete']
                        and m['sampledPeakTreeRssKiB'] < 180*2**20]
        if not measurements:
            raise RuntimeError('No complete calibration fits the measured memory allowance')
        workers = max(measurements, key=lambda m: m['engineTicksPerSecond'])['workers']
        atomic(root/'workers.json', dict(workers=workers, measurements=measurements))

    def opponents_for(route):
        other = 'pressure' if route == 'main' else 'main'
        return {**fixed, **{f'adaptive-{other}-{scope}': {'release': freeze(retained[f'{other}-{scope}'], other)}
                           for scope in scopes}}

    for step in range(1 if args.smoke else args.updates):
        for route in routes:
            pool = opponents_for(route)  # frozen once for both scopes and all repeat seeds
            keys = [key for key in current if key.startswith(route+'-')]
            name = f'update-{step}-{route}'
            batch(name+'-rollout', {key: subject(current[key], key.rsplit('-', 1)[0], False) for key in keys},
                  1 if args.smoke else 8, pool, seed=1000+step*10+list(routes).index(route))
            candidates = {}
            for scope in scopes:
                group = f'{route}-{scope}'
                candidates[f'{group}-incumbent'] = subject(retained[group], group)
            for key in keys:
                current[key] = train(f'{key}-ppo-{step}', 'ppo', root/(name+'-rollout')/f'{key}-episodes.json',
                                     2000+step*100+int(key.rsplit('-', 1)[1]), current[key])
                candidates[key] = subject(current[key], key.rsplit('-', 1)[0])
            check = batch(name+'-development', candidates, 1, fixed, seed=3000+step)
            for scope in scopes:
                group = f'{route}-{scope}'
                names = [f'{group}-incumbent', *[key for key in keys if key.startswith(group+'-')]]
                best = max(names, key=lambda key: check['counts'][key]['W'])
                retained[group] = Path(candidates[best]['model'])
            atomic(root/(name+'-selection.json'), dict(retained={k:str(v) for k,v in retained.items()}, counts=check['counts'],
                                                       note='Development opponent selection, ties keep incumbent; not promotion or unseen evidence'))
    final = {}
    for route in routes:
        subjects = {}
        for key in current:
            if key.startswith(route+'-'):
                group = key.rsplit('-', 1)[0]
                subjects[key+'-bc'] = subject(initial[key], group)
                subjects[key+'-ppo'] = subject(current[key], group)
        subjects['rule-016'] = {'ref': 'v0.1.16', 'mode': routes[route]}
        final[route] = batch('final-'+route, subjects, 1 if args.smoke else 4,
                             opponents_for(route), seed=4001)['counts']
    completed = sum(read(p)['completed'] for p in root.glob('*/summary.json') if isinstance(read(p), dict) and 'completed' in read(p))
    status('complete', final=final, retained={k:str(v) for k,v in retained.items()}, completedDirectGames=completed)


def read_last_line(path):
    return json.loads(Path(path).read_text().splitlines()[-1])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if '--out' in sys.argv:
            root = Path(sys.argv[sys.argv.index('--out')+1]); root.mkdir(parents=True, exist_ok=True)
            atomic(root/'status.json', dict(phase='failed', error=f'{type(error).__name__}: {error}', updatedAt=time.time()))
        raise
