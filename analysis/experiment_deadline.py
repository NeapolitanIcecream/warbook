"""Shorten an already running, frozen experiment without hot-editing its driver.

The resource lease owns one dedicated worktree, including detached descendants.
It interrupts learning, evaluates durable checkpoints, then releases that scope.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import psutil

from launch_batch import atomic


def timestamp(value):
    return datetime.datetime.fromisoformat(value).timestamp()


def live(process):
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def scope_processes(directory):
    """Exact dedicated cwd plus descendants; never match a shared user/job prefix."""
    directory = str(Path(directory).resolve())
    excluded = {os.getpid(), *(p.pid for p in psutil.Process().parents())}
    found = {}
    for process in psutil.process_iter():
        try:
            if process.pid not in excluded and process.cwd() == directory and live(process):
                found[process.pid] = process
                for child in process.children(recursive=True):
                    if child.pid not in excluded and live(child):
                        found[child.pid] = child
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return list(found.values())


def stop_scope(directory):
    # Freeze spawners before terminating the captured tree, including children
    # that created their own session. psutil checks process identity on signals.
    known = {}
    for _ in range(5):
        discovered = [p for p in scope_processes(directory) if p.pid not in known]
        if not discovered:
            break
        for process in discovered:
            known[process.pid] = process
            try:
                process.suspend()
            except psutil.NoSuchProcess:
                pass
    for process in known.values():
        try:
            process.terminate()
            process.resume()
        except psutil.NoSuchProcess:
            pass
    _, remaining = psutil.wait_procs(list(known.values()), timeout=10)
    for process in remaining:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(remaining, timeout=5)
    survivors = [p.pid for p in scope_processes(directory)]
    if survivors:
        raise RuntimeError(f'Experiment scope still occupied: {survivors}')
    return sorted(known)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('plan')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    plan = json.loads(Path(args.plan).read_text())
    root = Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if (root / 'state.json').exists():
        raise ValueError('Use a fresh resource-lease directory')
    run = Path(plan['run']).resolve()
    cwd = Path(plan['cwd']).resolve()
    if root.is_relative_to(cwd) or Path.cwd().resolve() == cwd:
        raise ValueError('Supervisor must run outside the dedicated experiment scope')
    driver = psutil.Process(plan['pid'])
    command = driver.cmdline()
    if '--out' not in command or Path(command[command.index('--out') + 1]).resolve() != run:
        raise ValueError('Registered PID is not this experiment driver')
    if not any(x.endswith('commander_night.py') for x in command) or Path(driver.cwd()).resolve() != cwd:
        raise ValueError('Wrong experiment process/worktree')
    cutoff, training_end, evaluation_end, release = [timestamp(plan[k]) for k in
        ['trainingCutoff', 'trainingPhaseDeadline', 'evaluationDeadline', 'releaseAt']]
    if not time.time() < cutoff <= training_end < evaluation_end < release:
        raise ValueError('Expected future ordered cutoffs with a cleanup reserve')
    original = json.loads((run / 'plan.json').read_text())
    final_plan = {**original, 'trainingCutoff': plan['trainingCutoff'],
                  'trainingPhaseDeadline': plan['trainingPhaseDeadline'], 'hardDeadline': plan['evaluationDeadline']}
    atomic(root / 'final-plan.json', final_plan)
    atomic(root / 'plan.json', plan)
    state = {'phase': 'watching', 'pid': driver.pid, 'pidCreatedAt': driver.create_time(),
             'startedAt': time.time(), 'originalPlanSha256': hashlib.sha256((run / 'plan.json').read_bytes()).hexdigest(),
             'releaseAt': plan['releaseAt']}
    def save():
        atomic(root / 'state.json', state)
    def phase():
        return json.loads((run / 'state.json').read_text())['phase']
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'Supervisor received signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    child = None
    log = None
    try:
        save()
        while live(driver):
            now = time.time()
            if now >= release:
                state['stopReason'] = 'Resource deadline reached'
                break
            current = phase()
            evaluating = current in ['final-evaluation', 'cross-evaluation', 'complete', 'complete_with_failures']
            if now >= cutoff and not evaluating and 'interruptAt' not in state:
                driver.send_signal(signal.SIGINT)
                state.update(phase='draining-training', interruptAt=now)
                save()
            if now >= training_end and not evaluating:
                break
            time.sleep(2)
        state['stoppedProcesses'] = stop_scope(cwd)
        completed = phase() in ['complete', 'complete_with_failures']
        if not completed and time.time() + 60 < evaluation_end:
            atomic(run / 'operator-stop.json', {'reason': 'Shortened server resource budget',
                   'lease': str(root), 'stoppedAt': time.time(), 'originalPhase': phase()})
            state.update(phase='final-evaluation', finalization=str(root / 'finalization'))
            save()
            log = (root / 'finalization.log').open('w')
            child = subprocess.Popen([sys.executable, plan['finalizer'], str(root / 'final-plan.json'),
                '--out', str(root / 'finalization'), '--finalize-from', str(run)],
                cwd=cwd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            state['finalizerPid'] = child.pid
            save()
            # Its own deadline first closes batches and persists partial results.
            # Keep this short grace inside the external resource deadline.
            while child.poll() is None and time.time() < min(evaluation_end + 30, release - 30):
                time.sleep(2)
            state['finalizerExit'] = child.poll()
        else:
            state['originalFinalPhase'] = phase()
    except BaseException as error:
        state['error'] = repr(error)
        raise
    finally:
        state['cleanupProcesses'] = stop_scope(cwd)
        if child is not None:
            child.wait(timeout=10)
            state['finalizerExit'] = child.returncode
        if log is not None:
            log.close()
        state.update(phase='released', releasedAt=time.time(), remainingPids=[p.pid for p in scope_processes(cwd)])
        save()
    return 1 if state.get('error') or state.get('finalizerExit') not in (None, 0) else 0


if __name__ == '__main__':
    sys.exit(main())
