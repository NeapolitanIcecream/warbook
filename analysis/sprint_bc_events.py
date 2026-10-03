"""A bounded BC intervention: override queue SET importance, not frame weight.

The existing factor objective caps queue importance at four even when
bcEventWeight=32. All masks, labels, domain denominators and non-SET weights
below retain that objective. This helper is used only for the explicit override.
"""
import torch


def factor_label(name, actions):
    if name in ('kind', 'goal', 'engagement', 'unit', 'building'):
        return actions[{'kind': 'kinds', 'goal': 'goals', 'engagement': 'engagement',
                        'unit': 'units', 'building': 'buildings'}[name]]
    for prefix, field in [('queue', 'queues'), ('amount', 'amounts'), ('cash', 'cash'),
                          ('place', 'placements'), ('edit', 'edits')]:
        if name.startswith(prefix):
            return actions[field][:, int(name[len(prefix):])]
    raise ValueError('Unknown conditional factor: ' + name)


def queue_set_factor_loss(conditionals, actions, boost, queue_set_weight):
    """Exact old factor formula with one change: SET queue leaves use this weight."""
    domains = {}
    for name, conditional in conditionals.items():
        selected = factor_label(name, actions)
        active = conditional['active']
        lp = conditional['log_probabilities'].gather(-1, selected.unsqueeze(-1)).squeeze(-1)
        nll = torch.where(active, -lp.float(), torch.zeros_like(lp, dtype=torch.float32))
        domain = (['production', 'tasks', 'units', 'buildings', 'placement'][int(name[4:])]
                  if name.startswith('edit') else 'production' if name.startswith(('queue', 'amount', 'cash'))
                  else 'tasks' if name in ('kind', 'goal', 'engagement') else 'units'
                  if name == 'unit' else 'buildings' if name == 'building' else 'placement')
        keep = 18 if name == 'unit' else 0 if name.startswith(('queue', 'place', 'edit')) or name in ('kind', 'building') else None
        negative = active & (selected == keep) if keep is not None else torch.zeros_like(active)
        changed = active & ~negative
        if name == 'unit':
            importance = torch.where(selected == 17, float(boost), min(float(boost), 4.))
        elif name.startswith('place'):
            importance = min(float(boost), 8.)
        elif name.startswith('queue'):
            importance = torch.where(selected >= 4, float(queue_set_weight), min(float(boost), 4.))
        elif name in ('kind', 'building') or name.startswith('edit'):
            importance = min(float(boost), 4.)
        else:
            importance = 1.
        axes = tuple(range(1, selected.ndim))
        def summed(value):
            return value.sum(axes) if axes else value
        terms = (summed(nll * changed * importance), summed(nll * negative),
                 summed(changed.float()), summed(negative.float()))
        old = domains.get(domain)
        domains[domain] = terms if old is None else tuple(x + y for x, y in zip(old, terms))
    first = next(iter(domains.values()))[0]
    loss = torch.zeros_like(first)
    count = torch.zeros_like(first)
    for changed_loss, keep_loss, changed_count, keep_count in domains.values():
        size = changed_count + (keep_count > 0)
        loss = loss + (changed_loss + keep_loss / keep_count.clamp_min(1)) / size.clamp_min(1)
        count = count + (size > 0)
    return loss / count.clamp_min(1)
