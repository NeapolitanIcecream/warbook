"""Comparable full-game sampling blocks, with measured process-tree memory.

The resulting on-policy episodes can feed a later update. This is a throughput
calibration on seen maps, not an evaluation or a seeded paired experiment.
"""
import argparse, json, os, resource, subprocess, sys, time
from pathlib import Path
from launch_batch import atomic

def tree_rss(pid):
    rows = [tuple(map(int, row.split())) for row in subprocess.check_output(
        ['ps', '-e', '-o', 'pid=,ppid=,rss='], text=True).splitlines() if row.strip()]
    descendants = {pid}
    while True:
        added = {p for p, parent, _ in rows if parent in descendants} - descendants
        if not added: break
        descendants.update(added)
    return sum(rss for p, _, rss in rows if p in descendants)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', required=True); p.add_argument('--out', required=True)
    p.add_argument('--workers', default='16,32,64,96'); p.add_argument('--rounds', type=int, default=8)
    a = p.parse_args(); root = Path(a.out).resolve(); root.mkdir(parents=True, exist_ok=True)
    model = str(Path(a.model).resolve()); results = []
    for workers in map(int, a.workers.split(',')):
        name = f'workers-{workers}'; done = root/(name+'.done.json')
        if done.exists(): results.append(json.loads(done.read_text())); continue
        plan = {'subjects': {'policy': {'policy': 'model', 'model': model}},
                'opponents': {'main-016': {'ref': 'v0.1.16'},
                              'pressure-016': {'ref': 'v0.1.16', 'mode': 'pressure'},
                              'old-defense': {'ref': 'b3a1f7c'}, 'supalosa': {'native': 'supalosa'}},
                'maps': ['mp29u2.map', 'mp06t2.map', 'mp08t2.map', 'mp03t4.map'],
                'rounds': a.rounds, 'workers': workers, 'trace': 'launch',
                'orderSeed': 29, 'policySeed': workers, 'seconds': 900}
        path = root/(name+'.plan.json'); atomic(path, plan)
        atomic(root/'status.json', {'phase': name, 'updatedAt': time.time()})
        resumed = (root/name/'summary.json').exists()
        cpu0 = resource.getrusage(resource.RUSAGE_CHILDREN); started = time.monotonic(); peak = 0
        with (root/(name+'.log')).open('w') as log:
            child = subprocess.Popen([sys.executable, 'analysis/launch_batch.py', str(path), '--out', str(root/name), '--resume'], stdout=log, stderr=subprocess.STDOUT)
            while child.poll() is None:
                peak = max(peak, tree_rss(child.pid)); time.sleep(2)
            if child.returncode: raise RuntimeError(f'{name} exited {child.returncode}; inspect its log')
        elapsed = time.monotonic()-started; cpu1 = resource.getrusage(resource.RUSAGE_CHILDREN)
        summary = json.loads((root/name/'summary.json').read_text())
        cpu = cpu1.ru_utime+cpu1.ru_stime-cpu0.ru_utime-cpu0.ru_stime
        result = {'workers': workers, 'completed': summary['completed'], 'wallSeconds': elapsed,
                  'measurementComplete': not resumed,
                  'gamesPerHour': None if resumed else summary['completed']*3600/elapsed,
                  'engineTicksPerSecond': None if resumed else sum(r['tick'] or 0 for r in summary['rows'])/elapsed,
                  'cpuSeconds': cpu, 'meanCores': cpu/elapsed, 'sampledPeakTreeRssKiB': peak,
                  'counts': summary['counts'], 'note': 'Independent starts; whole block includes setup/tail and 2s monitor sampling. No other Warbook batch should overlap.'}
        atomic(done, result); results.append(result); atomic(root/'summary.json', results)
        print(json.dumps(result), flush=True)
    episodes = [episode for row in results for episode in json.loads((root/f"workers-{row['workers']}"/'policy-episodes.json').read_text())]
    atomic(root/'policy-episodes.json', episodes)
    atomic(root/'status.json', {'phase': 'complete', 'updatedAt': time.time(), 'episodes': len(episodes)})

if __name__ == '__main__':
    try: main()
    except Exception as error:
        if '--out' in sys.argv:
            root = Path(sys.argv[sys.argv.index('--out')+1]); root.mkdir(parents=True, exist_ok=True)
            atomic(root/'status.json', {'phase': 'failed', 'error': str(error), 'updatedAt': time.time()})
        raise
