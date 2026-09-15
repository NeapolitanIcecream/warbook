#!/usr/bin/env python3
"""Recompute frozen-run ledgers without changing scoring or inferring causality."""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from statistical_budget import wilson


class DataError(ValueError):
    pass


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise DataError(f"Cannot read {path}: {error}") from error


def identity(participant, mode):
    release = participant.get('release')
    if release:
        return f"{release['mode']}@{release['sha256']}", release
    if participant.get('controller') == 'native-opponent':
        return mode, {'mode': mode, 'source': 'native opponent; distinct information condition'}
    raise DataError('Comparison requires frozen actor identities; a mode alone is insufficient')


def load_runs(root):
    root = Path(root).resolve()
    ledgers = [root / 'summary.json'] if (root / 'summary.json').exists() else sorted(root.glob('*/summary.json'))
    if not ledgers:
        raise DataError(f'No run ledger found under {root}')
    runs, seen_ids, seen_dirs = [], set(), set()
    for ledger in ledgers:
        rows = read_json(ledger)['rows']
        plan = read_json(ledger.with_name('plan.json'))
        subjects = plan.get('subjects', plan.get('modes'))
        maps = plan.get('maps', [plan.get('map')])
        opponent_count = len(plan.get('opponents', {})) or 1
        expected = plan['rounds'] * len(subjects) * len(maps) * opponent_count
        if len(rows) != expected:
            raise DataError(f'Incomplete ledger {ledger}: expected {expected} starts, found {len(rows)}')
        for row in rows:
            directory = Path(row['dir']).resolve()
            if root not in directory.parents or directory in seen_dirs:
                raise DataError(f'Duplicate or out-of-batch run directory: {directory}')
            seen_dirs.add(directory)
            manifest = read_json(directory / 'manifest.json')
            initial = read_json(directory / 'initial.json')
            result = read_json(directory / 'result.json')
            if manifest['runId'] in seen_ids or result.get('runId') != manifest['runId']:
                raise DataError(f'Duplicate or inconsistent run ID: {directory}')
            seen_ids.add(manifest['runId'])
            participants = manifest.get('participants', [])
            if len(participants) != 2 or sorted(p.get('role', '') for p in participants) != ['opponent', 'subject']:
                raise DataError(f'Missing unambiguous participant roles: {directory}')
            subject_index = next(i for i, p in enumerate(participants) if p['role'] == 'subject')
            subject, opponent = participants[subject_index], participants[1 - subject_index]
            sid, subject_info = identity(subject, manifest['modes'][subject_index])
            oid, opponent_info = identity(opponent, manifest['modes'][1 - subject_index])
            stats = result.get('stats', [])
            if stats and set(p['name'] for p in stats) != set(p['name'] for p in participants):
                raise DataError(f'Result roster differs from participants: {directory}')
            survivors = [p['name'] for p in stats if not p['defeated']]
            clean = (result.get('stopState', {}).get('status') == 'Ended'
                     and result.get('stopState', {}).get('turnManagerError') is False
                     and not result.get('error') and len(stats) == 2
                     and len(survivors) == 1)
            if clean != result.get('cleanCompletionVerified'):
                raise DataError(f'Inconsistent completion evidence: {directory}')
            winner = result.get('outcome', {}).get('survivor')
            if clean and (winner != survivors[0] or result['stopReason'] != 'engine_ended'):
                raise DataError(f'Winner differs from engine-end evidence: {directory}')
            starts = {p['name']: p['startLocation'] for p in initial['players']}
            if set(starts) != {p['name'] for p in participants}:
                raise DataError(f'Initial roster differs from participants: {directory}')
            options = {k: v for k, v in initial['options'].items() if k not in ('agents', 'mapName')}
            protocol = {
                'api': manifest['api'], 'engine': manifest['bundledEngineSourceVersion'],
                'observation': subject_info.get('observationProtocol', manifest['observationProtocol']),
                'interval': manifest['decisionInterval'],
                'limits': manifest['limits'], 'rules': initial['rulesHash'], 'options': options,
            }
            runs.append({
                'id': manifest['runId'], 'dir': str(directory),
                'subject': sid, 'opponent': oid, 'subjectInfo': subject_info, 'opponentInfo': opponent_info,
                'map': initial['options']['mapName'], 'protocol': protocol,
                'subjectSlot': subject_index, 'start': starts[subject['name']], 'opponentStart': starts[opponent['name']],
                'clean': clean, 'win': clean and winner == subject['name'], 'stop': result['stopReason'],
                'replaySha256': result.get('replay', {}).get('sha256'),
            })
    # Different maps may legitimately carry different rules. Within a map the comparison must agree.
    by_map = defaultdict(set)
    for run in runs:
        by_map[run['map']].add(json.dumps(run['protocol'], sort_keys=True))
    if any(len(protocols) != 1 for protocols in by_map.values()):
        raise DataError('Mixed comparison protocols within a map; separate reports and rerun both sides')
    return runs


def cell(rows):
    return {
        'starts': len(rows), 'cleanWins': sum(r['win'] for r in rows),
        'cleanLosses': sum(r['clean'] and not r['win'] for r in rows),
        'stops': dict(Counter(r['stop'] for r in rows)),
        'normalWinFractionOfStarts': sum(r['win'] for r in rows) / len(rows),
    }


def summarize(runs):
    subjects = sorted({r['subject'] for r in runs})
    groups = defaultdict(list)
    for run in runs:
        groups[(run['subject'], run['map'], run['opponent'])].append(run)
    coverage = {subject: {(r['map'], r['opponent']) for r in runs if r['subject'] == subject} for subject in subjects}
    balanced_cells = len({frozenset(value) for value in coverage.values()}) == 1
    totals = []
    for subject in subjects:
        selected = [r for r in runs if r['subject'] == subject]
        values = [cell(rows)['normalWinFractionOfStarts'] for key, rows in groups.items() if key[0] == subject]
        totals.append({'subject': subject, **cell(selected),
                       'equalCellRate': sum(values) / len(values) if balanced_cells else None})
    pair_groups, mirrors = defaultdict(list), []
    for run in runs:
        if run['subject'] == run['opponent']:
            mirrors.append(run)
        else:
            pair_groups[tuple(sorted([run['subject'], run['opponent']]))].append(run)
    duels = []
    for (a, b), rows in sorted(pair_groups.items()):
        clean = [r for r in rows if r['clean']]
        wins = sum(r['win'] if r['subject'] == a else not r['win'] for r in clean)
        duels.append({'a': a, 'b': b, 'starts': len(rows), 'aWins': wins, 'bWins': len(clean) - wins,
                      'nonClean': len(rows) - len(clean),
                      'conditionalWilson95': wilson(wins, len(clean)) if len(clean) == len(rows) and clean else None})
    starts = defaultdict(Counter)
    slots = defaultdict(Counter)
    replay_groups = defaultdict(list)
    for run in runs:
        starts[(run['subject'], run['map'])][f"{run['start']}->{run['opponentStart']}"] += 1
        slots[(run['subject'], run['map'])][str(run['subjectSlot'])] += 1
        if run['replaySha256']:
            replay_groups[run['replaySha256']].append(run['id'])
    return {
        'scope': 'descriptive development analysis; no automatic promotion or causal attribution',
        'intervalAssumptions': 'Wilson intervals only illustrate independent binary sampling uncertainty; independence, source generalization and multiple-selection adjustment are not established. These are not opponent-pool gain intervals.',
        'starts': len(runs), 'totals': totals,
        'cells': [{'subject': key[0], 'map': key[1], 'opponent': key[2], **cell(rows)} for key, rows in sorted(groups.items())],
        'sameCellCoverage': balanced_cells,
        'duels': duels,
        'mirrors': [{'subject': subject, **cell(selected)} for subject in subjects
                    if (selected := [r for r in mirrors if r['subject'] == subject])],
        'startCoverage': [{'subject': key[0], 'map': key[1], 'starts': dict(value), 'slots': dict(slots[key])}
                          for key, value in sorted(starts.items())],
        'repeatedReplays': [ids for ids in replay_groups.values() if len(ids) > 1],
        'sources': [{'runId': r['id'], 'dir': r['dir'], 'subject': r['subject'], 'opponent': r['opponent']} for r in runs],
    }


def short(identity):
    return identity.split('@')[0] + ('@' + identity.split('@')[1][:10] if '@' in identity else '')


def render(report):
    lines = ['# 冻结对局批次分析', '',
             '开发诊断报告；保持原始正常获胜/启动口径，不自动调整起点、不判定因果或晋升。', '',
             '| 策略 | 正常胜/启动 | 各地图×对手格等权 |', '| --- | ---: | ---: |']
    for row in report['totals']:
        score = f"{row['equalCellRate']:.1%}" if row['equalCellRate'] is not None else '覆盖不同，停止比较'
        lines.append(f"| {short(row['subject'])} | {row['cleanWins']}/{row['starts']} | {score} |")
    lines += ['', '## 分图、分对手', '', '| 策略 | 地图 | 对手 | 胜/启动 | 停止类别 |', '| --- | --- | --- | ---: | --- |']
    for row in report['cells']:
        lines.append(f"| {short(row['subject'])} | {row['map']} | {short(row['opponent'])} | {row['cleanWins']}/{row['starts']} | {row['stops']} |")
    lines += ['', '## 直接对战与镜像', '',
              '下列区间仅表示独立二项抽样假设下的量级；未验证独立性，未作多重选择调整，不是固定池增益的置信区间。', '']
    for row in report['duels']:
        interval = row['conditionalWilson95']
        ci = f"；条件 Wilson 95% 区间 {interval[0]:.1%}–{interval[1]:.1%}" if interval else '；存在未正常结束局，不计算二项区间'
        lines.append(f"- {short(row['a'])} 对 {short(row['b'])}：{row['aWins']}:{row['bWins']}，共 {row['starts']} 次启动{ci}。")
    for row in report['mirrors']:
        lines.append(f"- 镜像 {short(row['subject'])}：被评估槽位胜 {row['cleanWins']}/{row['starts']}，单列作初始化/槽位诊断。")
    lines += ['', '## 出生位置与槽位覆盖', '', '交换创建槽位不等于平衡出生位置；这些计数不会被自动重加权。', '']
    for row in report['startCoverage']:
        lines.append(f"- {short(row['subject'])} / {row['map']}：起点对 {row['starts']}；创建槽位 {row['slots']}。")
    if report['repeatedReplays']:
        lines += ['', '**发现相同回放内容的来源组；不能将其直接当作独立样本。**']
    lines += ['', '每局版本、目录及完整数值见同名 JSON。', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    try:
        report = summarize(load_runs(args.root))
    except (DataError, KeyError, TypeError) as error:
        parser.exit(2, f'Cannot compare this ledger: {error}\n')
    (args.root / 'analysis.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (args.root / 'analysis.md').write_text(render(report))
    print(json.dumps({'starts': report['starts'], 'totals': report['totals'], 'report': str(args.root / 'analysis.md')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
