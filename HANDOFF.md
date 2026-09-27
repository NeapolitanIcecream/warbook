# 当前研发交接

2026-09-27 13:54，北京时间。先读AGENTS、README、本页和[当前研究记录](docs/commander-followup.md)。用户负责试玩反馈，Agent负责设计、实现、实验、集成及资源维护；不要复用废弃本机项目。

## 正在运行：八线生产探索对照

用户重新授权服务器到**28日08:00**，09:00收结果。**09:00不允许继续计算**。

- 冻结源码：`746f2677dc8d77e8239a782737edde763f0c5a27`，开发版0.1.18-dev.5。文档HEAD可以更晚，不热改冻结源、计划、权重或在途数据。
- 远端作业：`jobs/commander-native-overnight-20260927`；专用源码`jobs/commander-native-overnight-20260927-src`；tmux `warbook-native-overnight-27`。准确主机/路径/PID见私有`work/server-feasibility/active-job.json.commanderFollowup`。
- 27日13:53独立启动，八初始化均通过，已进入首轮真实采样；独立资源监督器`jobs/commander-native-deadline-20260927`处于watching，已核对驱动PID、创建时间、专用cwd和计划SHA。
- B为原生产分布，E为只再校准数量/现金输出的探索分布；两者使用相同的新原生有限批量执行器及匹配的末层Adam重置。每种方法均有main/pressure、父系47/83，共八线。四个父模型预先锁定，不按今天胜率挑选。
- PPO每轮8次Adam，accum1；main学习率5e-6、pressure1e-4。每轮main128新局、pressure192新局。首轮同四固定对手，之后同方法内两路线共同演化，保留Supalosa、对方0.1.16规则与旧强MC83。主体采样，冻结对手贪心。
- 最多8轮、20,000次新尝试（含失败/检查/最终/交叉）；112游戏并发，训练最多4组×16 ranks、NUMA交错。三轮一次固定池复核，连续两段未达到规定增益则停止该线分配，**不等于收敛**。final每个不同模型64局，另交叉对战。
- **28日05:45停止新轮，06:00训练宽限结束，07:25原任务评测截止；监督接管评测最迟07:30，07:50前清理并释放，08:00用户取回服务器。** 提前完成即提前释放。作业不依赖笔记本、聊天在线或SSH连接。

## 明早收取顺序

1. 先看监督器state：`released`、`releasedAt`、空`remainingPids`；核对`*.exit.json`。若有监督目录`finalization/`，以其补充最终结果，不能把操作员截止直接当训练故障。不在交还期限后自动续跑。
2. 读原作业state/history/segments/final/cross及所有失败。按唯一游戏目录、attempt-started、manifest模型SHA和训练父权重/Adam核验；八线不能只挑最好seed。共享/重复读取不算新比赛。
3. 分开比较B0→B训练、E0→E训练，以及同阶段B/E。E初始化有代价：本次512局零更新比较各64局，main47 **20→18**、main83 **23→18**、pressure47 **14→9**、pressure83 **15→8**；合计72→53/256，0E。不能把恢复探索算成RL收益。
4. 训练的`*.production-events.json`记录真正进入目标函数的非默认SET；可与`analysis/commander_transactions.py`按目录/tick/queue关联。概率变化不等于正确归因或更强。异常移动/经济先看必要回放，再读最小日志；关闭临时实例。

## 本轮已确认的机制与限制

- 假期28,096局和84次权重/Adam接续已核验。512局采样/贪心对照、768局累积对照均0E，没有一致改善；accum8没有推广。三个历史PPO转移316,920参数精确复现。无需重做这些收取。
- 原数量/现金输出几乎只选1/0；少量升温后18个非默认SET全在75 tick后CLEAR，未形成超过+1的承诺。接口虽表达大数量，旧执行器只排一个。当前显式`--commander-native-batches`按有限目标缺口和原生容量提交；CLEAR停止补量、CANCEL撤尾项；无限目标仍逐件，建筑容量仍1。
- 真实固定引擎确认Add/Cancel在下一离线game.update结算，包括部分/零接受；同tick待结算记录避免重复，费用逐步扣。**只验证离线同步时序，不是在线认证。** 新旧执行器记录不同executionMode，不混入同一PPO。
- 原生执行器64局0E：新路径6个非建筑多件请求全部形成额外承诺，另1个矿场受容量1限制；旧路径2次只落实1个。2,000次真实决策与冻结包同步比较无差异。216项Node、类型检查及相关Python检查通过。
- 四份真实B0/E0初始化及八份Node导出检查通过；E只改数量/现金末层两个张量，替代总质量约8%/8.35%。16局拟合、另16局检查，原众数保留，其他条件输出一致；自由运行可改变，故另做完整局。
- 66局完整训练流程预检0E，含两次16-rank八步PPO及固定/交叉复赛。17个main、16个pressure有队列/暂停效果的决定进入训练目标，38个相关非默认因子的条件概率均改变。三笔pressure现金底线订单持续到终局。证明“执行→进入目标→策略移动”，**不证明正确信用分配、持续提升或已发现有效新战略**。
- consult-pro第5、6次均已完成，无待答请求；位置`work/consult-pro/strategy-discovery/`。私有证据`work/commander-followup-20260927/`。不要重复发送。

## 固定约束和玩家入口

完整战略由模型控制，末端战术与原生命令解释器执行；不加矿车禁战、强制进攻等规则救援。经典法国冰天打法仅为人类侧能力审计，不进入示范、奖励、专门课程或模板。消费级MacBook流畅推理仍是设计基础。

稳定玩家 **0.1.16**：http://127.0.0.1:8642/ ，未晋升研究候选。临时8643/回放/Pro标签均已关闭；只保留玩家入口和本轮独立实验。不要干扰无关`loreley-embed-warmup`。

分支`codex/full-strategy`，远端`NeapolitanIcecream/warbook`。游戏资产、凭据、模型、Adam、回放、数据和生成脚本留在忽略目录，不入Git。其他历史结果见[进展](docs/progress.md)、[假期实验](docs/commander-holiday.md)、[战略发现审查](docs/strategic-discovery-review.md)、[存储](docs/experiment-storage.md)。
