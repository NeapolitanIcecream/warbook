# Warbook / Chrono Divide AI

**当前默认：0.1.9；新增候选：0.1.10 持续交战与分路守备。** 候选让大兵保持近处有效交战，按可见威胁组织最多两组守备，兵力不足时集中处理一路。最新四图同池候选 22/24、0.1.9 为 18/24，48 局全部正常结束。仍有步兵损耗、装甲接敌与反击时机问题，先保留为试验版。详见 [本轮结果与限制](docs/defense-commitment-cycle.md)。

## 试玩

打开 **[本地玩家入口](http://127.0.0.1:8642/)**，选择「本地对战」→「开始游戏」。默认美国、美国小镇、10000 资金、零起始军队。

试用新版请选择 **[0.1.10 候选 AI](http://127.0.0.1:8642/challenge/)**。游戏页下方显示所选 AI 的版本。旧 0.1.7、0.1.8 阵地路线和 counter 继续保留为冻结研究对手。

- 鼠标选择基地车，按 **D** 展开；在右侧建造栏生产和放置建筑。
- **Esc → 放弃任务 → 退出** 可以结束当前局；结算后点「继续」再次开局。
- 服务未启动时，双击 [Play Warbook.command](scripts/Play%20Warbook.command)。Agent 负责环境、版本、日志与运行维护。

只想看 AI 对战，可以打开 **[0.1.10 对 Supalosa 的完整回放](http://127.0.0.1:8642/watch)**：短图，17:38，WarbookRed 获胜。约 4:30–6:00 可看早期防守，11:03 后可看六车反击。这局出生方向与之前 0.1.9 的展示局不同；先前方向的候选记录及损失也保留在研发文档中。也保留 **[历史移动原型的失败记录](http://127.0.0.1:8642/game/#/replay/http%3A%2F%2F127.0.0.1%3A8642%2Fwarbook%2Freplay-check.rpl)**：60:00 达到运行上限，双方未败北，WarbookRed 仍有 53 辆坦克；不计正常败局。可用底部按钮加速，或 Esc → 全屏展开画面。

这是基础地面作战研发版。当前重点是建设、采矿、出兵、坦克对步兵作战和寻找迁移的基地；不宣称已经覆盖所有兵种、地图或真人竞技水平。

## 本地开发与复现

需要 Node.js ≥22.15（本机验证版本 26.5.0）和合法取得的 `ra2.mix`、`language.mix`、`multi.mix`。

```sh
npm ci
# 将 MIX 放在 assets/ra2，或在 .env 中设置 MIX_DIR。
npm run play
```

首次启动缓存官方客户端，浏览器自动从本机导入资源；对局不需要账户或 Bot API key。准备完成后，`OFFLINE=1 npm run play` 禁止缓存缺失时联网。入口仅监听 `127.0.0.1`。

Agent 在本地 `.env` 中用 `WATCH_MATCH=runs/<run-directory>/result.json` 选择首页回放，重启入口生效。服务检查正常结束记录、回放版本与文件 SHA-256；对局文件仍仅保存在忽略目录。未配置时首页不显示回放按钮。

`PLAYER_RELEASE` 固定默认图形包，`PLAYER_CHALLENGER` 可固定同一客户端下的实验对手图形包，二者均为 `dist/player/<sha256>` 的内容哈希。这样重启服务或构建其他候选时，也不会悄悄替换已维护的默认策略。

```sh
npm test
npm run typecheck
npm run match -- --units 0
npm run match -- --mode baseline --opponent supalosa --units 0
npm run batch -- --rounds 12 --modes baseline,combined --map mp03t4.map
npm run replay -- runs/<run-directory>
npm run bot:build -- --ref v0.1.7 --mode factory-exit
npm run bot:build -- --ref v0.1.8 --mode bastion
npm run bot:build -- --ref v0.1.9 --mode bastion
# 旧主线仍可用 --ref v0.1.4 --mode combined 冻结构建。
# 将构建返回的 release.json 路径交给 --actor-release / --opponent-release。
# --swap 交换创建/执行槽位，不控制地图出生位置。
```

`bastion` 是当前默认策略：按可见威胁保护建筑和矿车，调动步兵及车辆，通常组织六车反击；出现观察到的反击窗口时可由四车发起，后续援军先积累四车。`factory-exit` 是保留的 0.1.7 路线，`combined` 是更早主线，`counter` 是实验对手。模式名称本身不冻结代码，跨版本比较必须使用冻结包。全部实验和固定试玩版本见 [执行进展](docs/progress.md)。

`bastion` 使用分别归属的主力、守备、预备与汇合任务。`cohort-local` 是未晋升的主线编组研究模式。移动射击原型出现过三次上限，已从当前运行代码移除，冻结历史和失败记录见 [阵地与编组实验](docs/defense-cycle.md)。当前尚未实现成熟的 T 优、残血轮换、军犬屏护或完整中后期发展。

## 固定版本与证据范围

- 0.1.9 对固定旧阵地 / counter / Supalosa 为 9/16、16/16、14/16；同池 0.1.7 为 6/16、6/16、13/16。四图全部正常结束，短图新版 12/12，城市图 7/12。保留实际出生覆盖和失败，不声称未见地图泛化。发布标签检查两局共 10,131 次指令一致；新增观察字段下的旧主线兼容检查 4,274 次一致。详见 [主动防守实施与发布](docs/active-defense-cycle.md)。
- 历史 0.1.8 在另一对手池为 28/48、当批 0.1.7 为 38/48；不与本轮不同对手池直接相减。其部署/工事消融受到起点覆盖影响，独立收益未确认。见 [上一轮记录](docs/defense-cycle.md)。
- **SDK：`@chronodivide/game-api@0.79.0`。实际嵌入的引擎源码版本是 `0.83.3`，回放兼容标识是 `0.83`。** 这由发布包中的版本常量和真实回放确认；早期文档根据 changelog 写作「引擎 0.84」的映射已被实际结果修正。
- 玩家客户端来自官方 [0.83.3 归档](https://game.chronodivide.com/old/v0.83.3/)，配合同一 SDK 的规则资源包；客户端代码、SDK 资源和 AI 包均校验哈希。最初的 0.84 客户端试玩记录保留为单独证据。
- 0.1.7 生产修正的四图开发池：对冻结 0.1.6、counter、npm Supalosa，每格 6 次，两版合计 144 局全部正常结束，53/72 对 52/72。小镇补兵更早，其他地图没有一致收益；矿场被毁后重建仍可能附带第五辆矿车。城市切片的另 24 次复查、旧版上限局及保留决定见 [生产记账与实战](docs/production-cycle.md)。
- 0.1.5 三图开发池：`mp03t4.map`、`mp06t2.map`、`mp29u2.map`，对固定旧主线、counter、npm Supalosa 每格 6 场；0.1.5 为 **44/54 胜**，旧主线为 **30/54 胜**。新增地图 `mp08t2.map` 的另一批次两者均为 **12/24 胜**，全部正常结束。**收益随地图和对手变化，不代表所有条件更强，也不是正式目标分布或真人水平认证。** 过程中的退化、修正和版本分开记录在 [集结策略续进](docs/assembly-cycle.md)。
- 策略使用 `api-shroud-v0-visible-placement-frontier`：仅当前己方状态、按本方 shroud 过滤的敌方接触、己方探索信息；建筑预检局限于已探索的基地周边。该工程条件尚不宣称与人类界面的隐形、伪装等观察完全等价。
- 正常结束需要引擎 `Ended`、turn-manager 无错误及单方败北证据。超时、错误、主动中止分别保留；不把 `isFinished()` 单独当胜利。

## 实现结构

- [policy.ts](src/policy.ts)：当前主线的控制器入口，历史 mode 经 [legacy-policy.ts](src/legacy-policy.ts) 保留。
- [strategy.ts](src/control/strategy.ts)：战略阶段、目标、兵力就绪需求和生产目标。
- [bastion-strategy.ts](src/control/bastion-strategy.ts)、[position-tactics.ts](src/control/position-tactics.ts)：守备、反击、增援批次及有限近距自卫。
- [defense-assignments.ts](src/control/defense-assignments.ts)：按可见来向分配步兵，保持当前交战，并处理有限分兵与急危增援。
- [tactics.ts](src/control/tactics.ts)、[production.ts](src/control/production.ts)：分别落实作战与生产任务。
- [coordinator.ts](src/control/coordinator.ts)：任务修订、单位归属、结果反馈和过期命令检查。
- [bridge.ts](src/bridge.ts)：观察白名单、局部引用、动作仲裁与提交。
- [defense-route.ts](src/defense-route.ts)：桥接层调用的已探索区域寻路辅助，不向策略透传全图路径或区域编号。
- [effects.ts](src/effects.ts)：区分「已经请求」和实际观察到的效果。
- [runner.ts](src/runner.ts)、[referee.ts](src/referee.ts)：对局驱动与独立裁判记录。
- [player](src/player/)：本地入口、官方客户端接入与固定版本服务。

[分层实现与验证](docs/layered-control.md) 记录逐步影子比较、真实完整对局及独立战术试验。当前保持同步 API 控制；大模型战略、RPA 和完整多小队调度仍属于后续适配。

## 实用分析工具

[分析工具与验收记录](docs/analysis-tools.md) 说明每项改进对应的问题、实际反例和成本。`npm run analyze -- <批次目录>` 复算版本、直接对战、镜像和起点覆盖；`npm run analyze:encounter -- <单局目录>` 输出一页进攻计划、实际位移、行军停滞、建筑受损与步兵参战摘要。异常先直接看相关回放，需要逐帧数据时才加 `--window 起始tick:结束tick`。`npm run experiment:matrix -- <计划文件> --out <新目录>` 执行冻结版本矩阵。分析依赖见 [requirements.txt](analysis/requirements.txt)，本机已具备。报告不自动判定因果、实力提升或晋升。

所有原版资源、客户端缓存、回放、浏览器数据、密钥及运行产物均被 Git 忽略。没有复用被放弃的本机项目代码。第三方软件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 项目约定与交接

研发依据：[小型对手池与共同演化方案](docs/opponent-pool.md)。首轮已完成双方版本冻结、挑战路线试跑与固定池比较；实际保留决定及后续工作以 [执行进展](docs/progress.md) 为准。

先读 [AGENTS.md](AGENTS.md)、[HANDOFF.md](HANDOFF.md) 和 [当前进展](docs/progress.md)。实现依据包括 [接口契约](docs/interface-contract.md)、[环境审计](docs/environment-audit.md)、[策略与责任](docs/strategy.md)、[评估协议](docs/evaluation.md)；历史规划、来源记录和无资源探针保留用于追溯。
