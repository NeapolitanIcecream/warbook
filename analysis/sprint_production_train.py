"""Production-only BC on explicitly identified diagnostic-state expert labels.

No mixed mission action is supervised. Frozen encoders/GRU make the rebuilt
actual-world hidden-before cache exact across decoder updates.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import random
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--episodes', required=True)
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--updates', type=int, default=512)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--seed', type=int, default=47)
    ap.add_argument('--seconds', type=float, default=540.)
    args = ap.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    import torch
    import torch.distributed as dist
    from torch.nn.parallel import DistributedDataParallel
    from commander_train import load_model, read_episode, episode_shards, plain_world
    from commander_model import HIDDEN, pack, pack_actions, export
    from commander_sequence import canonical_action
    torch.set_num_threads(1)
    torch.manual_seed(args.seed)
    world_size = int(os.environ.get('WORLD_SIZE', '1'))
    rank = int(os.environ.get('RANK', '0'))
    if world_size > 1:
        dist.init_process_group('gloo')
    started = time.monotonic()
    paths = json.loads(Path(args.episodes).read_text())
    model = load_model(json.loads(Path(args.input).read_text()))
    prefixes = ('queue0.', 'queueSpecial.', 'queueParameter.', 'queueContext.')
    parameters = [name for name, p in model.named_parameters() if name.startswith(prefixes) or name == 'queueSpecialKeys']
    frozen = {name: p.detach().clone() for name, p in model.named_parameters() if name not in parameters}
    for name, p in model.named_parameters():
        p.requires_grad_(name in parameters)
    episodes = []
    pools = [[], [], []]
    prefix_frames = 0
    source_counts = Counter()
    for path in episode_shards(paths, world_size)[rank]:
        episode = read_episode(path)
        if episode is None:
            continue
        if any(r.get('executionSource') != 'diagnostic-teacher-mission' or 'teacherAction' not in r for r in episode['rows']):
            raise ValueError('Expected explicitly labeled diagnostic-state sources')
        episodes.append(episode)
        h = torch.zeros(1, HIDDEN)
        with torch.no_grad():
            for start in range(0, len(episode['rows']), 64):
                selected = episode['rows'][start:start + 64]
                data = pack([r['world'] for r in selected], model.vocabulary)
                encoded = model.encode_world(data)
                for i, row in enumerate(selected):
                    row['_productionHiddenBefore'] = h[0].clone()
                    h = model.advance_hidden(None, h, encoded=tuple(v[i:i+1] for v in encoded))
                    target = {**row['action']}
                    for key in ['queues', 'amounts', 'cash']:
                        target[key] = list(row['teacherAction'][key])
                    # Mission fields only condition unused legality checks; their
                    # losses are excluded and all their tensors remain frozen.
                    row['_productionTarget'] = canonical_action(target, row['world'], model.encoding)
                    key = (episode, row)
                    if row['tick'] <= 8000 and row['action']['queues'] != target['queues']:
                        pools[0].append(key)
                    if row['tick'] <= 3750:
                        pools[1].append(key)
                    pools[2].append(key)
                    prefix_frames += 1
                    source_counts[row['executionSource']] += 1
    if not all(pools):
        raise ValueError('Each rank needs disagreements, opening anchors and complete-source frames')

    class Objective(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model
        def forward(self, items):
            data = pack([r['world'] for _, r in items], self.model.vocabulary)
            actions = pack_actions([r['_productionTarget'] for _, r in items], data)
            h = torch.stack([r['_productionHiddenBefore'] for _, r in items])
            p = self.model(data, h, actions, return_conditionals=True)
            queue_loss = torch.zeros(len(items))
            parameter_loss = torch.zeros(len(items))
            parameter_count = torch.zeros(len(items))
            for q in range(6):
                for name, target, destination in [('queue', actions['queues'][:, q], 'queue'),
                                                   ('amount', actions['amounts'][:, q], 'parameter'),
                                                   ('cash', actions['cash'][:, q], 'parameter')]:
                    conditional = p['conditionals'][name + str(q)]
                    active = conditional['active']
                    logp = conditional['log_probabilities'].gather(-1, target[:, None]).squeeze(-1)
                    nll = torch.where(active, -logp.float(), torch.zeros_like(logp, dtype=torch.float32))
                    if destination == 'queue':
                        queue_loss += nll / 6
                    else:
                        parameter_loss += nll
                        parameter_count += active.float()
            return (queue_loss + .25 * parameter_loss / parameter_count.clamp_min(1)).mean()

    objective = Objective(model)
    if world_size > 1:
        objective = DistributedDataParallel(objective, broadcast_buffers=False)
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=3e-4)
    rng = random.Random(args.seed + rank)
    out = Path(args.out)
    usage = Counter()
    checkpoints = []
    def save(suffix, updates, loss):
        for name, original in frozen.items():
            if not torch.equal(model.state_dict()[name], original):
                raise ValueError('Non-production tensor changed: ' + name)
        details = {'sourcePaths': [e['path'] for e in episodes], 'prefixFrames': prefix_frames,
                   'sourceCounts': dict(source_counts), 'uses': dict(usage), 'poolSizes': list(map(len, pools)),
                   'encoderHashes': sorted({e['encoderSha'] for e in episodes})}
        if world_size > 1:
            all_details = [None] * world_size
            dist.all_gather_object(all_details, details)
        else:
            all_details = [details]
        if rank == 0:
            path = out.with_name(out.stem + suffix + '.json')
            path.parent.mkdir(parents=True, exist_ok=True)
            metadata = {'method': 'production-only-bc', 'diagnosticStateSources': True,
                        'sourceEligibility': 'Research supervised production labels only; no policy-only or on-policy claim',
                        'labelFields': ['teacherAction.queues', 'teacherAction.amounts', 'teacherAction.cash'],
                        'excludedLossFields': ['kind', 'goal', 'engagement', 'unit', 'building', 'placement', 'value'],
                        'sourceDetails': all_details, 'trainableParameters': parameters,
                        'frozenParametersVerifiedBitwise': True, 'updates': updates, 'loss': loss,
                        'input': args.input, 'inputSha256': hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
                        'trainerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                        'runtime': args.runtime, 'worldSize': world_size, 'batchPerRank': args.batch,
                        'sampling': 'Half early production disagreement, one quarter whole opening, one quarter uniform complete-source frames',
                        'history': 'Current exact frozen encoder/GRU hidden-before reconstructed from actual complete source worlds; cache invariant under decoder-only updates',
                        'objective': 'Mean 6 queue cross-entropies +0.25 active amount/cash cross-entropy; no task/critic loss',
                        'seconds': time.monotonic() - started}
            sha = export(model, path, metadata)
            path.with_suffix('.training.json').write_text(json.dumps({**metadata, 'sha256': sha}, indent=2) + '\n')
            checkpoints.append({'path': str(path), 'sha256': sha, 'updates': updates})
            print(json.dumps(checkpoints[-1]), flush=True)
        if world_size > 1:
            dist.barrier()
    updates = 0
    last_loss = 0.
    for step in range(args.updates):
        items = []
        for i in range(args.batch):
            pool = 0 if i % 4 < 2 else 1 if i % 4 == 2 else 2
            items.append(rng.choice(pools[pool]))
            usage[['disagreement', 'opening', 'wholeSource'][pool]] += 1
        optimizer.zero_grad()
        loss = objective(items)
        loss.backward()
        torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], .5)
        optimizer.step()
        updates += 1
        last_loss = float(loss.detach())
        if updates in [128, 512]:
            save('-update-' + str(updates), updates, last_loss)
        expired = torch.tensor(int(time.monotonic() - started >= args.seconds))
        if world_size > 1:
            dist.all_reduce(expired, op=dist.ReduceOp.MAX)
        if expired.item():
            break
    save('', updates, last_loss)
    if world_size > 1:
        dist.destroy_process_group()


if __name__ == '__main__':
    main()
