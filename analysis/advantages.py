"""Episode-local GAE for the existing finite-horizon win objective (gamma=1).

Only the final transition receives W=1 or L/U=0. Stored pre-update values include
forced KEEP states. Actor masking and normalization happen after this recursion;
the critic continues to regress to the terminal Monte Carlo return.
"""
import math


def terminal_advantages(episodes, lam):
    if not math.isfinite(lam) or not 0 <= lam <= 1:
        raise ValueError('GAE lambda must be between zero and one')
    flattened = []
    for episode in episodes:
        rows = episode['rows']; period = episode['period']
        if not rows or not isinstance(period, int) or period <= 0:
            raise ValueError('Need a nonempty episode and its decision period')
        if any(b['tick'] - a['tick'] != period for a, b in zip(rows, rows[1:])):
            raise ValueError('Missing or reordered decisions inside an episode')
        if not 0 <= episode['terminalTick'] - rows[-1]['tick'] <= period:
            raise ValueError('Unexplained gap before the recorded terminal boundary')
        reward = episode['reward']; values = [row['value'] for row in rows]
        if reward not in [0., 1.] or not all(math.isfinite(v) for v in values):
            raise ValueError('Invalid terminal utility or stored value')
        result = [0.] * len(rows)
        following_value = following_advantage = 0.
        for i in range(len(rows)-1, -1, -1):
            immediate = reward if i == len(rows)-1 else 0.
            delta = immediate + following_value - values[i]
            result[i] = delta + lam * following_advantage
            following_value, following_advantage = values[i], result[i]
        flattened.extend(result)
    return flattened
