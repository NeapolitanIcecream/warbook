"""Bounded same-checkpoint contact-information experiment; all work stays on host.

Reuses full-game batch, PPO, frozen bots and storage tools. No per-update ranking:
both observation arms and both random repeats continue to the planned endpoint.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from launch_batch import atomic

ROUTES = {'main': 'bastion', 'pressure': 'pressure'}
class TrainingBoundary(Exception):
    pass


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def neural(path, route, deterministic=True, seed=None):
    result = dict(policy='model', model=str(path), mode=ROUTES[route],
                  scope=read(path)['controlScope'], deterministic=deterministic)
    if seed is not None:
        result['policySeed'] = seed
    return result


def completed_candidates(state, route, root, checkpoints):
    subjects={};seen=set()
    def add(label,path,expected=None):
        sha=digest(path)
        if expected and sha!=expected:raise ValueError('Validated checkpoint changed')
        if sha not in seen:subjects[label]=neural(path,route);seen.add(sha)
    for key,path in state['current'].items():
        if key.startswith(route+'-'):add(key,path)
    for key,record in state.get('pending',{}).items():
        if key.startswith(route+'-'):add(key+'-pending',record['model'],record['sha256'])
    for cycle in checkpoints:
        for key in sorted(k for k in state['initial'] if k.startswith(route+'-')):
            path=root/'models'/f'cycle-{cycle-1:02d}-{key}-ppo.json'
            if path.exists():
                if not (root/(path.stem+'-parity.done.json')).exists():
                    raise ValueError('Checkpoint has no completed probability validation')
                add(f'{key}-after-{cycle}',path)
    return subjects


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sources', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--train-until', required=True)
    parser.add_argument('--finish-by', required=True)
    parser.add_argument('--workers', type=int, default=192)
    parser.add_argument('--experiment', choices=['contact', 'maneuver', 'credit'], default='contact')
    parser.add_argument('--cycles', type=int, default=3)
    parser.add_argument('--checkpoints', type=int, nargs='*', default=[])
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    sources = read(args.sources)
    root = args.out.resolve(); root.mkdir(parents=True, exist_ok=True)
    models = root / 'models'; models.mkdir(exist_ok=True)
    node = os.environ.get('WARBOOK_NODE', 'node')
    deadlines = [dt.datetime.fromisoformat(v) for v in [args.train_until, args.finish_by]]
    if any(d.tzinfo is None for d in deadlines):
        raise ValueError('Use explicit timezones')
    train_until, finish_by = [d.timestamp() for d in deadlines]
    if train_until >= finish_by or not 1 <= args.workers <= 192 or not 1 <= args.cycles <= 40 or any(c < 1 or c > args.cycles for c in args.checkpoints):
        raise ValueError('Invalid resource bounds')
    seeds = [47] if args.smoke else [47, 83]
    arms = {'contact':['zero','local'], 'maneuver':['base','local'], 'credit':['mc','gae99']}[args.experiment]
    maps = ['mp06t2.map'] if args.smoke else ['mp29u2.map', 'mp06t2.map', 'mp08t2.map', 'mp03t4.map']
    cycles = 1 if args.smoke else args.cycles
    for route in ROUTES:
        for kind in ['operation', 'launch']:
            spec = sources[route][kind]
            if digest(spec['model']) != spec['sha256']:
                raise ValueError('Source checkpoint changed')
    identity = dict(source=source, sources=sources, trainUntil=args.train_until,
                    finishBy=args.finish_by, workers=args.workers, smoke=args.smoke,
                    cycles=cycles, seeds=seeds, maps=maps, experiment=args.experiment, checkpoints=args.checkpoints)
    if (root / 'experiment.json').exists() and read(root / 'experiment.json') != identity:
        raise ValueError('Experiment identity changed')
    atomic(root / 'experiment.json', identity)
    state = read(root / 'state.json') if (root / 'state.json').exists() else dict(
        phase='initializing', current={}, initial={}, cycle=0, routeIndex=0, pools={})
    if state['phase'] == 'complete':
        return

    def save():
        atomic(root / 'state.json', state)

    def status(phase, **extra):
        record = dict(phase=phase, at=time.time(), cycle=state['cycle'],
                      routeIndex=state['routeIndex'], **extra)
        atomic(root / 'status.json', record)
        print(json.dumps(record), flush=True)

    def command(name, cmd, final=False):
        marker = root / (name + '.done.json')
        if marker.exists():
            return
        remaining = (finish_by if final else train_until) - time.time()
        if remaining <= 0:
            if final:raise TimeoutError('Final evaluation deadline reached')
            raise TrainingBoundary('Training deadline reached')
        with (root / (name + '.log')).open('w') as log:
            child = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = child.wait(timeout=remaining)
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait()
                if isinstance(error,subprocess.TimeoutExpired) and not final:
                    raise TrainingBoundary('Interrupted training stage at its deadline')
                raise
        if code:
            raise RuntimeError(f'{name} failed ({code}); read its preserved log')
        atomic(marker, dict(completedAt=time.time()))

    def batch(name, subjects, opponents, rounds, seed, final=False):
        plan = dict(subjects=subjects, opponents=opponents, maps=maps, rounds=rounds,
                    workers=min(4, args.workers) if args.smoke else args.workers,
                    trace='launch', orderSeed=seed, policySeed=seed, seconds=900)
        path = root / (name + '.plan.json')
        if path.exists() and read(path) != plan:
            raise ValueError('Frozen batch plan changed')
        atomic(path, plan)
        status(name)
        command(name, [sys.executable, 'analysis/launch_batch.py', str(path), '--out', str(root/name), '--resume'], final)
        summary = read(root / name / 'summary.json')
        if not summary['complete'] or any(c['E'] for c in summary['counts'].values()):
            raise ValueError('Incomplete or erroneous batch')
        return summary

    def freeze(path, route):
        name = f'freeze-{route}-{digest(path)[:16]}'
        command(name, [node, '--import', 'tsx', 'scripts/build-bot.ts', '--ref', source,
                       '--mode', ROUTES[route], '--launch-model', str(path)], final=True)
        return {'release': json.loads((root/(name+'.log')).read_text().splitlines()[-1])['path']}

    def pool(route, cycle, final=False):
        other = 'pressure' if route == 'main' else 'main'
        repeat = seeds[cycle % len(seeds)]
        if args.smoke:
            return {'supalosa': {'native': 'supalosa'},
                    'adaptive-other-'+arms[-1]: freeze(state['current'][f'{other}-{arms[-1]}-{repeat}'], other)}
        opponents = {'main-016': {'ref': 'v0.1.16'},
                     'pressure-016': {'ref': 'v0.1.16', 'mode': 'pressure'},
                     'strong-other-launch': freeze(sources[other]['launch']['model'], other)}
        if args.experiment in ['maneuver','credit']:
            opponents['strong-other-start'] = freeze(sources[other]['operation']['model'], other)
        if args.experiment == 'contact' or final:
            opponents['supalosa'] = {'native': 'supalosa'}
        for arm in arms:
            opponents[f'adaptive-other-{arm}'] = freeze(state['current'][f'{other}-{arm}-{repeat}'], other)
        return opponents

    def train(key, cycle, route):
        name = f'cycle-{cycle:02d}-{key}-ppo'
        path = models / (name + '.json')
        seed = int(key.rsplit('-', 1)[1])
        cmd = [sys.executable, 'analysis/launch_train.py', 'ppo', '--input', state['current'][key],
               '--episodes', str(root/f'cycle-{cycle:02d}-{route}-rollout'/((key.replace('-gae99-','-mc-') if args.experiment=='credit' and cycle==0 else key)+'-episodes.json')),
               '--out', str(path), '--seed', str(73000+cycle*100+seed), '--threads', '4']
        if args.experiment == 'credit':
            cmd += ['--gae-lambda', '0.99' if '-gae99-' in key else '1']
        if args.smoke:
            cmd += ['--epochs', '1']
        command(name, cmd)
        command(name+'-parity', [node, '--import', 'tsx', 'scripts/check-launch-model.ts',
                                str(path), str(path.with_suffix('.golden.json'))])
        return str(path)

    try:
        if state['phase'] == 'initializing':
            for route in ROUTES:
                old = Path(sources[route]['operation']['model'])
                for arm in arms:
                    if args.experiment == 'credit':
                        artifact = read(old)
                        if artifact['schema'] != 'operation-maneuver-v1' or artifact['controlScope'] != 'operation':
                            raise ValueError('Credit experiment fixes one validated maneuver schema/menu per route')
                        if not old.with_suffix('.optimizer.pt').exists():
                            raise ValueError('Credit fork requires the same Adam state')
                        for seed in seeds:
                            key = f'{route}-{arm}-{seed}'
                            state['initial'][key] = str(old)
                            state['current'].setdefault(key, str(old))
                        continue
                    name = f'initial-{route}-{arm}'; path = models / (name+'.json')
                    migration = ['analysis/contact_migrate.py', '--contact-input', arm] if args.experiment == 'contact' else ['analysis/maneuver_migrate.py', '--scope', arm]
                    command(name, [sys.executable, *migration, '--input', str(old), '--out', str(path)])
                    samples = read(old.with_suffix('.golden.json'))
                    if args.experiment == 'contact':
                        for i, sample in enumerate(samples):
                            sample['global'] += ([i/8, .5, 1, .25, .75] if arm == 'local' else [0]*5)
                    else:
                        samples = read(path.with_suffix('.golden.json'))
                    golden = path.with_suffix('.golden.json'); atomic(golden, samples)
                    command(name+'-parity', [node, '--import', 'tsx', 'scripts/check-launch-model.ts', str(path), str(golden)])
                    for seed in seeds:
                        key = f'{route}-{arm}-{seed}'
                        state['initial'][key] = str(path)
                        state['current'].setdefault(key, str(path))
                save()
            state['phase'] = 'learning'; save()
        try:
            while state['phase'] == 'learning' and state['cycle'] < cycles:
                if (root/'STOP_TRAINING').exists() or time.time()+1800 >= train_until:
                    state['stopReason'] = 'training boundary'; break
                cycle = state['cycle']; route = list(ROUTES)[state['routeIndex']]
                name = f'cycle-{cycle:02d}-{route}'
                if name not in state['pools']:
                    state['pools'][name] = pool(route, cycle); save()
                keys = [k for k in state['current'] if k.startswith(route+'-')]
                subjects = {k: neural(state['current'][k], route, False,
                                     seed=(61000+cycle*10+state['routeIndex'])*100+int(k.rsplit('-', 1)[1])) for k in keys}
                if args.experiment == 'credit' and cycle == 0:
                    for seed in seeds:
                        if digest(state['current'][f'{route}-mc-{seed}']) != digest(state['current'][f'{route}-gae99-{seed}']):
                            raise ValueError('Shared first rollout requires identical behavior checkpoints')
                    subjects = {k:v for k,v in subjects.items() if '-mc-' in k}
                rollout_pool = {'supalosa': {'native': 'supalosa'}} if args.smoke else state['pools'][name]
                batch(name+'-rollout', subjects, rollout_pool, 2 if args.smoke else 8, 61000+cycle*10+state['routeIndex'])
                status(name+'-training')
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                    futures = {executor.submit(train, key, cycle, route): key for key in keys}
                    errors=[]
                    for future in concurrent.futures.as_completed(futures):
                        key=futures[future]
                        try:
                            path=future.result()
                            state.setdefault('pending', {})[key] = dict(model=path, sha256=digest(path)); save()
                        except Exception as error:errors.append(error)
                    if errors:raise next((e for e in errors if not isinstance(e,TrainingBoundary)),errors[0])
                for key in keys:
                    record = state['pending'].pop(key)
                    if digest(record['model']) != record['sha256']:
                        raise ValueError('Validated checkpoint changed')
                    state['current'][key] = record['model']
                state['routeIndex'] += 1
                if state['routeIndex'] == 2:
                    state['cycle'] += 1; state['routeIndex'] = 0
                save()
        except TrainingBoundary as error:
            state['stopReason']=str(error); save()
        if state['phase'] != 'final':
            state['phase'] = 'final'
            state['finalPools'] = {route: pool(route, state['cycle'], final=True) for route in ROUTES}; save()
        for route in ROUTES:
            subjects = completed_candidates(state,route,root,args.checkpoints)
            subjects['unchanged-operation'] = neural(sources[route]['operation']['model'], route)
            if args.experiment == 'maneuver':
                subjects['untrained-local-menu'] = neural(state['initial'][f'{route}-local-{seeds[0]}'], route)
            subjects['strong-launch'] = neural(sources[route]['launch']['model'], route)
            subjects['rule-016'] = dict(ref='v0.1.16', mode=ROUTES[route])
            check = batch('final-'+route, subjects, state['finalPools'][route], 1 if args.smoke else 8, 91001, final=True)
            state.setdefault('final', {})[route] = check['counts']; save()
        state['phase'] = 'complete'; save(); status('complete', final=state['final'])
    except BaseException as error:
        state['failure'] = f'{type(error).__name__}: {error}'; save()
        status('failed', error=state['failure'])
        raise


if __name__ == '__main__':
    main()
