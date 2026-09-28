"""Bounded real-history checks for PPO depth and one retention coefficient.

Inputs are predeclared whole-game panels. This script never changes weights,
selects a winning checkpoint, or feeds diagnostics back into game observations.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import time
from types import SimpleNamespace

import torch

from commander_model import pack, pack_actions
from commander_retention import build_teacher_cache, conditional_kl, reconstruct_hidden, retention_batch
from commander_train import batch_steps, load_model, read_episode, validate_ppo_behavior
from launch_batch import atomic


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def gradient_vector(loss, model):
    gradients = torch.autograd.grad(loss, tuple(model.parameters()), allow_unused=True)
    return torch.cat([torch.zeros_like(p).reshape(-1) if g is None else g.detach().reshape(-1)
                      for p, g in zip(model.parameters(), gradients)])


def load_panel(path):
    sources = json.loads(Path(path).read_text())
    if not sources or len(sources) != len(set(sources)):
        raise ValueError('Use a nonempty predeclared panel without duplicate sources')
    episodes = [read_episode(source) for source in sources]
    if any(e is None for e in episodes):
        raise ValueError('Panel contains an ineligible game; report it instead of silently replacing it')
    return episodes


def choose_windows(episodes, count, seed, length=16):
    rng = random.Random(seed)
    order = list(episodes)
    rng.shuffle(order)
    selected = []
    # Visit whole sources evenly, then choose a real window without looking at outcomes.
    for i in range(count):
        episode = order[i % len(order)]
        start = rng.randrange(math.ceil(len(episode['rows']) / length)) * length
        selected.append((episode, start, min(start + length, len(episode['rows']))))
    return selected


@torch.no_grad()
def recurrent_drift(model, windows, burn=8):
    rows = []
    for episode, start, _ in windows:
        records = episode['rows']
        beginning = max(0, start - burn)
        short = torch.tensor([records[beginning]['hidden']], dtype=torch.float32)
        for record in records[beginning:start]:
            short = model.advance_hidden(pack([record['world']], model.vocabulary), short)
        full = reconstruct_hidden(model, episode, start)
        record = records[start]
        data = pack([record['world']], model.vocabulary)
        action = pack_actions([record['action']], data)
        a = model(data, full, action, return_conditionals=True)
        b = model(data, short, action, return_conditionals=True)
        rows.append({'path': episode['path'], 'tick': record['tick'],
                     'hiddenL2': float((full - short).norm()),
                     'absoluteLogpDifference': float((a['logp'] - b['logp']).abs()),
                     'absoluteValueDifference': float((a['value'] - b['value']).abs()),
                     'conditionalKL': float(conditional_kl(a['conditionals'], b['conditionals']))})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='P-minus update8 checkpoint (or deeper diagnostic endpoint)')
    parser.add_argument('--reference', required=True)
    parser.add_argument('--episodes', required=True, help='Predeclared current-source game panel')
    parser.add_argument('--reference-episodes')
    parser.add_argument('--drift-only', action='store_true', help='Inspect deeper recurrent state without recalibrating lambda')
    parser.add_argument('--out', required=True)
    parser.add_argument('--target-ratio', type=float, default=.1)
    parser.add_argument('--seed', type=int, default=47)
    parser.add_argument('--panels', type=int, default=4)
    parser.add_argument('--threads', type=int, default=1)
    args = parser.parse_args()
    if not 0 < args.target_ratio <= 1 or args.panels < 1:
        raise ValueError('Expected a bounded positive gradient ratio and panel count')
    torch.set_num_threads(args.threads)
    started = time.monotonic()
    cpu = time.process_time()
    artifact = json.loads(Path(args.input).read_text())
    normalization = artifact['training']['advantageNormalization']
    model = load_model(artifact)
    teacher = load_model(json.loads(Path(args.reference).read_text())).eval()
    teacher.requires_grad_(False)
    current = load_panel(args.episodes)
    validate_ppo_behavior(current, teacher, digest(args.reference))
    if args.drift_only:
        rows = recurrent_drift(model, choose_windows(current, 16, args.seed))
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        atomic(out, {'input': args.input, 'inputSha256': digest(args.input),
                     'reference': args.reference, 'referenceSha256': digest(args.reference),
                     'episodesSha256': digest(args.episodes), 'recurrentDrift': rows,
                     'seconds': time.monotonic() - started, 'cpuSeconds': time.process_time() - cpu,
                     'scope': 'Full-current-weight history versus recorded hidden plus burn8; no parameter or lambda changes'})
        print(json.dumps({'out': str(out), 'maxConditionalKL': max(row['conditionalKL'] for row in rows)}), flush=True)
        return
    if not args.reference_episodes:
        raise ValueError('Gradient calibration requires predeclared reference episodes')
    fixed = load_panel(args.reference_episodes)
    validate_ppo_behavior(fixed, teacher, digest(args.reference))
    for episode in current:
        episode['ppo'] = True
        for row in episode['rows']:
            row['_advantage'] = ((episode['reward'] - row['value'] - normalization['mean'])
                                 / normalization['std'])
    cache = build_teacher_cache(teacher, [*fixed, *current], seed=args.seed + 15485863)
    history_mode = artifact['training'].get('ppoHistory', {}).get('mode', 'recorded')
    settings = SimpleNamespace(method='ppo', sequence=16, burn=8, entropy=.001, ppo_history=history_mode)
    results, drift_windows = [], []
    for index in range(args.panels):
        actor = choose_windows(current, 32, args.seed + index * 1009)
        anchors = [*choose_windows(fixed, 4, args.seed + index * 2003),
                   *choose_windows(current, 4, args.seed + index * 3001)]
        batches = [(e, e['rows'][max(0, start - settings.burn):start], e['rows'][start:end])
                   for e, start, end in actor]
        loss, kl, frames, _ = batch_steps(batches, model, settings, True, actor_only=True)
        actor_gradient = gradient_vector(loss, model)
        retained, anchor_frames, costs = retention_batch(model, teacher, cache, anchors)
        retention_gradient = gradient_vector(retained, model)
        an, rn = float(actor_gradient.norm()), float(retention_gradient.norm())
        usable = math.isfinite(an) and math.isfinite(rn) and an > 1e-6 and rn > 1e-6
        results.append({'panel': index, 'actorFrames': frames, 'anchorFrames': anchor_frames,
                        'actorLoss': float(loss.detach()), 'ppoApproxKL': kl,
                        'retentionKL': float(retained.detach()), 'actorGradientNorm': an,
                        'retentionGradientNorm': rn, 'usable': usable,
                        'suggestedWeight': args.target_ratio * an / rn if usable else None,
                        'gradientCosine': float(torch.dot(actor_gradient, retention_gradient) / (an * rn)) if usable else None,
                        'actorSources': [{'path': e['path'], 'start': start, 'end': end} for e, start, end in actor],
                        'anchorSources': [{'path': e['path'], 'start': start, 'end': end} for e, start, end in anchors],
                        'cost': costs})
        drift_windows.extend(actor[:2])
    weights = [row['suggestedWeight'] for row in results if row['usable']]
    weight = statistics.median(weights) if len(weights) == args.panels else None
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    atomic(out, {'input': args.input, 'inputSha256': digest(args.input),
                 'reference': args.reference, 'referenceSha256': digest(args.reference),
                 'episodesSha256': digest(args.episodes), 'referenceEpisodesSha256': digest(args.reference_episodes),
                 'advantageNormalization': normalization, 'targetRatio': args.target_ratio,
                 'ppoHistory': history_mode,
                 'suggestedWeight': weight, 'panels': results,
                 'recurrentDrift': recurrent_drift(model, drift_windows),
                 'seconds': time.monotonic() - started, 'cpuSeconds': time.process_time() - cpu,
                 'scope': 'Local gradient calibration and recurrent-history diagnostic; no weight updates or playing-strength claim'})
    print(json.dumps({'out': str(out), 'suggestedWeight': weight, 'seconds': time.monotonic() - started}), flush=True)


if __name__ == '__main__':
    main()
