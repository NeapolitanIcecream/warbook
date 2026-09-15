# RA2 AI / Chrono Divide

从零开发一个能在正常完整对局中持续进步的 Chrono Divide AI。研究以真实行为和独立对局为证据，按瓶颈选择启发式、搜索、监督学习或 RL。

**当前状态：方法论、实施前设计及无游戏资源的分析探针。** 已完成两份公开真人 replay 的官方 parser 解析、5 个提取方法的 mock 案例、Supalosa 模块加载/构造探针和可复算统计分析；尚未实现自己的 bot、初始化游戏引擎或启动训练。2026-09-15 初始化本地仓库。这里记录本次 Codex 讨论，并整合用户提供的 GPT 6 Pro 分析；不是对旧项目代码的诊断报告。

## 从这里开始

| 文档 | 用途 |
| --- | --- |
| [前期分析收束](docs/preimplementation-decisions.md) | 新发现、首局默认选择、待实证问题与停止扩写分析的条件 |
| [接口契约](docs/interface-contract.md) | 最小观察/动作/调度/结束记录，映射到真实 API |
| [对手与数据](docs/opponents-and-data.md) | 固定公开版本、对手接入风险、地图与 replay 来源 |
| [首批判别实验](docs/first-experiments.md) | 失败预演、10 张按需实验卡和 12 个伪改进反例 |
| [真人 replay 解析探针](docs/replay-data-probe.md) | 两份真实公开文件的无资源解析结果及复现方法 |
| [统计预算](docs/statistical-budget.md) | 样本量、选优偏差和对手比例偏差的已执行计算 |
| [方法论](docs/methodology.md) | 目标、架构、算法选择、数据与学习、研究循环 |
| [环境审计](docs/environment-audit.md) | API 0.79.0 的已查事实、限制、源码推断和待实测问题 |
| [评估协议](docs/evaluation.md) | 场景有效性、对照、信息边界、整局评测与统计 |
| [实施路线](docs/roadmap.md) | 当前进度、首阶段工作、依赖与证据要求 |
| [Pro 回复审阅](docs/reference-review.md) | 值得吸收的补充，以及需要限定的建议 |
| [实验模板](templates/experiment.md) | 一次可证伪、可复验的研究任务 |
| [Pro 原稿](docs/references/gpt-6-pro-original.md) | 用户提供的 `/Users/chenmohan/Downloads/ra2ai.md` 的原样副本 |
| [API 来源清单](docs/references/api-provenance.json) | 固定版本来源、哈希与检查范围 |

## 已接受的方向

- 真实对局提供问题，局部实验解释机制，独立整局评价决定是否保留改动。
- 分开软件正确性、局部能力和整局竞争力；合成场景的用途取决于它实际能证明什么。
- 引擎真值、合法玩家观测和玩家估计分别处理。API 可访问性不等于评测允许使用。
- 尽早形成能打完整局的简单基线，每轮只围绕一个具体瓶颈做有判别力的修改。
- 比较认真调优的简单方案；小模型和 RL 都是候选实现，不是成功条件。
- 用反例、故障注入、不同对手和保留数据检验评估器。多个模型赞同不构成独立证据。
- 基础设施随实验需要增长，避免为尚不存在的需求搭建平台。

## 工作默认值与未决事项

从固定引擎版本、一个国家、少量地图的正常开局 1v1 起步，保留经济、生产、侦察和完整胜负条件。首场工程试跑选用官方示例中已有的 Americans 与 `mp03t4.map` 作为候选，具体默认选项和限制见 [前期分析收束](docs/preimplementation-decisions.md)。它不是已验证的公平地图或最终赛制；最终地图池、目标对手水平和计算预算仍需真实运行后确定。

源码审计参考 `@chronodivide/game-api@0.79.0`（对应引擎 0.84）。replay 解析与对手加载探针分别在忽略目录安装依赖，分析锁文件保存在 `analysis/replay-parser/` 和 `analysis/opponent-loader/`；后者显式绕过不匹配的 peer 约束，仅用于兼容检查。**自己的 bot 项目尚无依赖配置、游戏资源初始化或对局记录**。公开接口没有现成 seeded reset、固定出生位、快照恢复或 replay 接管接口；这些能力不应成为首场正常整局的前置条件。

下一项实施目标：建立版本与资源记录、最小 headless 对局、合法观测边界、动作效果与终局记录，并能观看和解释一次完整运行。详见 [实施路线](docs/roadmap.md)。

## 记录边界

原稿保留用于追溯，不是所有陈述均已独立核实；采用的方案以方法论、评估协议和环境审计为准。文献结果仅提供方法依据，不构成 Chrono Divide 上已经有效的证据。

游戏 MIX 文件、密钥、大型 replay、训练数据与模型权重不进入 Git。后续运行产物放在被忽略的目录或独立存储中，以版本、配置、哈希和路径关联实验。开发约定见 [AGENTS.md](AGENTS.md)。
