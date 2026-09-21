"""One terminal classification for launch sampling and training.

An error-free engine end with both participants defeated has no verified winner.
Keep it as unresolved evidence and a terminal non-win, not an execution error.
"""
from typing import NamedTuple


class LaunchOutcome(NamedTuple):
    outcome: str
    reason: str
    trainable: bool


def classify(result, manifest):
    stop = result.get('stopState', {})
    if result.get('error') or stop.get('turnManagerError') is not False:
        return LaunchOutcome('E', 'execution_error', False)
    players = manifest.get('participants', [])
    stats = result.get('stats', [])
    if (sorted(p.get('role', '') for p in players) != ['opponent', 'subject']
            or len(stats) != 2
            or {p['name'] for p in players} != {p['name'] for p in stats}):
        return LaunchOutcome('E', 'invalid_participants', False)
    subject = next(p['name'] for p in players if p['role'] == 'subject')
    survivors = [p['name'] for p in stats if p.get('defeated') is False]
    if result.get('cleanCompletionVerified'):
        if (stop.get('status') != 'Ended' or len(survivors) != 1
                or result.get('outcome', {}).get('survivor') != survivors[0]):
            return LaunchOutcome('E', 'inconsistent_terminal_evidence', False)
        return LaunchOutcome('W' if survivors[0] == subject else 'L', 'verified_terminal', True)
    if (stop.get('status') == 'Ended'
            and all(p.get('defeated') is True for p in stats)):
        return LaunchOutcome('U', 'engine_mutual_defeat', True)
    if (result.get('stopReason') == 'runner_limit'
            and result.get('tick', -1) >= manifest.get('limits', {}).get('ticks', float('inf'))):
        return LaunchOutcome('U', 'tick_cap', True)
    return LaunchOutcome('E', 'unverified_stop', False)
