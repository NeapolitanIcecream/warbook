"""Small real-journal check for the queue SET loss intervention; no updates."""
import argparse
import copy
import json
from pathlib import Path
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runtime', required=True)
    ap.add_argument('--episode', required=True)
    ap.add_argument('--model', required=True)
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.runtime) / 'analysis'))
    import torch
    from commander_train import load_model, read_episode
    from commander_model import HIDDEN, pack, pack_actions
    from commander_sequence import training_action, canonical_action
    from sprint_bc_events import queue_set_factor_loss
    from sprint_bc_audit import factor_labels, original_coefficients
    torch.set_num_threads(1)
    model = load_model(json.loads(Path(args.model).read_text()))
    episode = read_episode(args.episode)
    selected = [r for r in episode['rows'] if r['tick'] in [0, 75, 600, 675, 1950, 2400]]
    worlds = pack([r['world'] for r in selected], model.vocabulary)
    labels = pack_actions([canonical_action(training_action(r, 'bc'), r['world'], model.encoding) for r in selected], worlds)
    before = copy.deepcopy([r['action'] for r in selected])
    with torch.no_grad():
        p = model(worlds, torch.zeros(len(selected), HIDDEN), labels, bc_factor_boost=32., return_conditionals=True)
        reference = queue_set_factor_loss(p['conditionals'], labels, 32., 4.)
        changed = queue_set_factor_loss(p['conditionals'], labels, 32., 32.)
        coefficient = original_coefficients(p['conditionals'], factor_labels(labels), 32.)
        expected = torch.zeros(len(selected))
        for name, conditional in p['conditionals'].items():
            if not name.startswith('queue'):
                continue
            target = labels['queues'][:, int(name[5:])]
            nll = -conditional['log_probabilities'].gather(-1, target[:, None]).squeeze(-1).float()
            active = conditional['active'] & (target >= 4)
            expected += torch.where(active, 7 * coefficient[name] * nll, torch.zeros_like(nll))
    original_error = float((reference - p['bcLoss']).abs().max())
    override_error = float((changed - reference - expected).abs().max())
    assert original_error < 2e-6, original_error
    assert override_error < 2e-6, override_error
    assert before == [r['action'] for r in selected]
    print(json.dumps({'scope': 'Real recorded worlds, fixed teacher action chain, no training or games',
                      'frames': len(selected), 'ticks': [r['tick'] for r in selected],
                      'originalFactorFormulaMaxAbsError': original_error,
                      'onlyQueueSETDeltaMaxAbsError': override_error,
                      'originalLoss': p['bcLoss'].tolist(), 'queueWeight32Loss': changed.tolist()}, indent=2))


if __name__ == '__main__':
    main()
