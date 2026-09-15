#!/usr/bin/env python3
"""Reproduce planning calculations; no game data, simulation, or dependencies.

Run from any directory. Writes only the two documented analysis artifacts.
All binomial examples assume independent, identically distributed win/loss
observations, no draws, a fixed sample size, and a fixed policy/opponent setup.
"""

import json
import math
from pathlib import Path
from statistics import NormalDist


ROOT = Path(__file__).resolve().parents[1]


def binomial_pmf(n, p):
    if n < 1 or not 0 < p < 1:
        raise ValueError("Require n >= 1 and 0 < p < 1")
    return [
        math.exp(
            math.lgamma(n + 1) - math.lgamma(k + 1)
            - math.lgamma(n - k + 1)
            + k * math.log(p) + (n - k) * math.log1p(-p)
        )
        for k in range(n + 1)
    ]


def upper_tail(pmf, k):
    return math.fsum(pmf[k:])


def wilson(wins, n, confidence=0.95):
    z = NormalDist().inv_cdf((1 + confidence) / 2)
    estimate = wins / n
    denominator = 1 + z * z / n
    center = (estimate + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(estimate * (1 - estimate) / n + z * z / (4 * n * n)) / denominator
    return [center - radius, center + radius]


def approximate_one_sample_n(p1, p0=0.5, alpha=0.05, power=0.8):
    # One-sided normal approximation, fixed-n superiority test H0: p <= p0.
    za = NormalDist().inv_cdf(1 - alpha)
    zb = NormalDist().inv_cdf(power)
    return math.ceil(
        ((za * math.sqrt(p0 * (1 - p0)) + zb * math.sqrt(p1 * (1 - p1))) / (p1 - p0)) ** 2
    )


def approximate_two_arm_n(p1, p0=0.5, alpha=0.05, power=0.8):
    # Equal allocation, two-sided normal approximation, no continuity correction.
    za = NormalDist().inv_cdf(1 - alpha / 2)
    zb = NormalDist().inv_cdf(power)
    pooled = (p0 + p1) / 2
    numerator = za * math.sqrt(2 * pooled * (1 - pooled))
    numerator += zb * math.sqrt(p0 * (1 - p0) + p1 * (1 - p1))
    return math.ceil((numerator / (p1 - p0)) ** 2)


def selection_example(n, candidates):
    null = binomial_pmf(n, 0.5)
    cdf_before = 0.0
    expected_max_wins = 0.0
    for k in range(1, n + 1):
        cdf_before += null[k - 1]
        expected_max_wins += 1 - min(1.0, cdf_before) ** candidates
    single_tail = upper_tail(null, math.ceil(0.6 * n))
    return {
        "candidates": candidates,
        "games_per_candidate": n,
        "true_win_probability_for_every_candidate": 0.5,
        "expected_reported_best_win_rate": expected_max_wins / n,
        "probability_reported_best_at_least_60_percent": -math.expm1(candidates * math.log1p(-single_tail)),
        "assumption": "Independent binomial evaluations across candidates; analytical illustration only",
    }


def check_calculations():
    known = binomial_pmf(4, 0.5)
    assert all(math.isclose(a, b, abs_tol=1e-12) for a, b in zip(known, [1/16, 4/16, 6/16, 4/16, 1/16]))
    pmf = binomial_pmf(100, 0.5)
    assert math.isclose(math.fsum(pmf), 1, abs_tol=1e-12)
    assert all(math.isclose(pmf[k], pmf[-k-1], abs_tol=1e-12) for k in range(101))
    single = selection_example(100, 1)
    assert math.isclose(single['expected_reported_best_win_rate'], 0.5, abs_tol=1e-11)
    interval = wilson(50, 100)
    assert math.isclose(sum(interval), 1, abs_tol=1e-12)
    assert approximate_one_sample_n(0.55) > approximate_one_sample_n(0.6)
    assert approximate_two_arm_n(0.55) > approximate_two_arm_n(0.6)


def calculate():
    n = 100
    null = binomial_pmf(n, 0.5)
    critical = next(k for k in range(n + 1) if upper_tail(null, k) <= 0.05)
    return {
        "artifact_kind": "analytical_planning_not_game_results",
        "assumptions": [
            "Independent identically distributed binary win/loss outcomes; no draws or censored games",
            "Fixed sample size and fixed candidate; no optional stopping",
            "One-sample comparison is direct candidate-versus-baseline win probability, not improvement against an opponent pool",
            "Two-arm approximation compares two separately estimated win probabilities against the same fixed opponent distribution",
            "No inference about Chrono Divide throughput, actual win rates, training variability, or required production budget",
        ],
        "fixed_100_direct_duel": {
            "null_win_probability": 0.5,
            "one_sided_alpha": 0.05,
            "reject_at_least_wins": critical,
            "actual_type_one_error": upper_tail(null, critical),
            "power_by_true_probability": {
                str(p): upper_tail(binomial_pmf(n, p), critical)
                for p in [0.55, 0.6, 0.65]
            },
            "wilson_95_percent_interval_for_55_wins": wilson(55, n),
        },
        "normal_approximation_80_percent_power": [
            {
                "baseline_probability": 0.5,
                "alternative_probability": p,
                "direct_duel_one_sided_total_games": approximate_one_sample_n(p),
                "two_arm_two_sided_games_per_arm": approximate_two_arm_n(p),
                "two_arm_two_sided_total_games": 2 * approximate_two_arm_n(p),
            }
            for p in [0.55, 0.6, 0.65]
        ],
        "selection_bias_examples": [selection_example(n, m) for m in [1, 5, 20, 100]],
        "opponent_mix_counterexample": {
            "kind": "constructed_probability_example_not_observed_games",
            "both_policies_win_probabilities": {"strong": 0.3, "weak": 0.7},
            "baseline_evaluation_weights": {"strong": 0.5, "weak": 0.5},
            "candidate_evaluation_weights": {"strong": 0.2, "weak": 0.8},
            "baseline_reported_score": 0.5 * 0.3 + 0.5 * 0.7,
            "candidate_reported_score": 0.2 * 0.3 + 0.8 * 0.7,
            "score_for_both_under_frozen_equal_weights": 0.5,
        },
    }


def percent(x):
    return f"{100*x:.1f}%"


def render(report):
    duel = report['fixed_100_direct_duel']
    lines = [
        '# 评测样本与选择偏差：可复算的前期分析',
        '',
        '**这些数字是概率模型计算，不是 Chrono Divide 对局结果。** 没有测量引擎吞吐、训练效果或 bot 胜率。执行 `python3 analysis/statistical_budget.py` 可重建本文件和 [JSON 数据](references/statistical-budget.json)，只依赖 Python 标准库。',
        '',
        '## 1. 先分清两种问题',
        '',
        '- **直接对战**：候选面对基线的胜率是否超过 50%？这可能仅是克制关系，不代表对整个对手池变强。',
        '- **对同一对手池比较**：基线与候选分别对固定分布的对手打局，比较两个需要估计的概率。它不是一次二项检验，通常需要更多比赛。',
        '',
        '以下均假设独立同分布的二元胜负、无平局、固定样本量和固定候选。真实比赛含地图/起点分层、相关性、平局、截断或多次训练时，需要相应的分层或配对分析。游戏故障不能为了符合模型而静默删除。',
        '',
        '## 2. 一百场能回答什么',
        '',
        f"直接对战的固定 100 局、单侧 α=0.05 精确二项检验，至少 {duel['reject_at_least_wins']} 胜才拒绝 H0: p≤0.5；实际零假设误报率为 {percent(duel['actual_type_one_error'])}。",
        '',
        '| 真实直接对战胜率（假设） | 100 局检测到优势的概率 |',
        '| --- | --- |',
    ]
    for p, power in duel['power_by_true_probability'].items():
        lines.append(f'| {percent(float(p))} | {percent(power)} |')
    lo, hi = duel['wilson_95_percent_interval_for_55_wins']
    lines.extend([
        '',
        f'55/100 胜的双侧 95% Wilson 区间约为 [{percent(lo)}, {percent(hi)}]。诊断小批量可以暴露严重故障，但无法可靠裁决小幅优势。',
        '',
        '## 3. 样本量的量级，不能当作统一门槛',
        '',
        '下表是 80% power 的正态近似，未做连续性修正。直接对战用单侧 α=0.05、H0: p≤0.5；两组比较用双侧 α=0.05、两组各打同样多的独立比赛。两列研究设计与检验方向不同，不能只按数字择便使用。实施正式检验前应按实际协议复算，而非直接采用表中最小数字。',
        '',
        '| 假设概率从 50% 到 | 直接对战总局数 | 两组各自局数 | 两组合计 |',
        '| --- | ---: | ---: | ---: |',
    ])
    for item in report['normal_approximation_80_percent_power']:
        lines.append(f"| {percent(item['alternative_probability'])} | {item['direct_duel_one_sided_total_games']} | {item['two_arm_two_sided_games_per_arm']} | {item['two_arm_two_sided_total_games']} |")
    lines.extend([
        '',
        '这些是“区别于零提升”的量级，不是“证明至少提高某个 δ”的设计；后者需要不同假设和更大的预期效果。估计一个固定模型的比赛表现，也没有覆盖训练随机性。',
        '',
        '计算式：直接对战 n≈[z(1−α)√(p0(1−p0))+z(power)√(p1(1−p1))]²/(p1−p0)²；等分两组每组 n≈[z(1−α/2)√(2p̄(1−p̄))+z(power)√(p0(1−p0)+p1(1−p1))]²/(p1−p0)²，其中 p̄=(p0+p1)/2。',
        '',
        '## 4. 挑最好 checkpoint 会制造多大假象',
        '',
        '假设每个候选真实胜率都恰好为 50%，每个各评估 100 场，候选间评估独立，然后只汇报最高分。下表按二项分布直接计算，无游戏数据，也不是随机 Monte Carlo。现实 checkpoint 往往相关，因此这些数值是有明确假设的示例，而非实际项目误报概率。',
        '',
        '| 从多少候选中选最好 | 被选最高分的期望 | 至少出现一个 ≥60% 的概率 |',
        '| ---: | ---: | ---: |',
    ])
    for item in report['selection_bias_examples']:
        lines.append(f"| {item['candidates']} | {percent(item['expected_reported_best_win_rate'])} | {percent(item['probability_reported_best_at_least_60_percent'])} |")
    lines.extend([
        '',
        '因此，开发/晋升集负责选候选，冻结后用独立数据评价选中的候选。记录所有尝试、挑选规则和查看节点，不能只保存最好运行。这个要求同样适用于规则参数搜索和从带噪声分叉结果里挑最优动作。',
        '',
        '## 5. 更换对手比例能产生完全虚假的 12 个百分点提升',
        '',
        '构造例子：两版本对强对手都赢 30%，对弱对手都赢 70%。旧版各打一半，汇总为 50%；新版仅 20% 比赛打强对手、80% 打弱对手，汇总变为 62%。能力完全没变。按固定的各半权重重算，两者仍都是 50%。',
        '',
        '对应设计决定：固定主要对手权重、报告各家族分项；挑战池新增对手单独报告，直到明确更新目标分布。不能拿方便获取的比赛比例充当预定目标分布。',
        '',
        '## 6. 对首轮研究的实际影响',
        '',
        '- 首批少量完整局用于执行/机制诊断，不承担 5 个百分点的实力声明。正确性修复按直接证据与适当回归判断，无需一律达到上表样本数。',
        '- 先测每局墙钟成本，再决定正式胜率比较可负担的最小效应；把评估成本计入规则搜索、模型选择和 RL 的总预算。',
        '- 没有 seed/固定起点时，在相同配置分布下随机或交错分配候选与基线、记录实际起点并分层。不能把未控制的两局当作同初态配对。',
        '- 同一 replay 的相邻片段和分支用来源组处理，不能靠重复切片增加名义样本量。',
        '- 当前不实现通用统计服务。第一次真实报告具备实际数据后，再采用与目标和采样方式相符的区间与检验。',
        '',
        '实现内的核对包括小 n 已知二项分布、概率和与对称性、单候选选优期望、Wilson 对称性和样本量随效应缩小而增加。它们校验这里的分析计算，不校验游戏评估器。',
    ])
    return '\n'.join(lines) + '\n'


def main():
    check_calculations()
    report = calculate()
    (ROOT / 'docs/references/statistical-budget.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (ROOT / 'docs/statistical-budget.md').write_text(render(report))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
