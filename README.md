# Warbook / Chrono Divide AI

**当前版本：0.1.6。** 本地可玩的红色警戒 2 AI。本轮将战略、战术和生产控制分离，加入任务归属与效果反馈，保持 0.1.5 的决策行为。可以分别调整策略并验证相互影响；本次不宣称棋力提升。

## 试玩

打开 **[本地玩家入口](http://127.0.0.1:8642/)**，选择「本地对战」→「开始游戏」。默认美国、美国小镇、10000 资金、零起始军队。

也可以选择 **[集结反击 AI（实验对手）](http://127.0.0.1:8642/challenge/)**：它更注重基地附近的早期防守。默认主线使用新的集结进攻策略；旧主线和 counter 均保留为冻结对手。

- 鼠标选择基地车，按 **D** 展开；在右侧建造栏生产和放置建筑。
- **Esc → 放弃任务 → 退出** 可以结束当前局；结算后点「继续」再次开局。
- 服务未启动时，双击 [Play Warbook.command](scripts/Play%20Warbook.command)。Agent 负责环境、版本、日志与运行维护。

只想看 AI 对战，可以点击首页的「观看 AI 对局回放」，或打开 **[完整对局回放](http://127.0.0.1:8642/watch)**。当前本机提供 0.1.5 对旧主线的美国小镇对局，约 16 分钟。回放无需操作军队；窗口较窄时可用 Esc → 全屏展开画面。

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
npm run bot:build -- --ref v0.1.6 --mode factory-exit
# 旧主线仍可用 --ref v0.1.4 --mode combined 冻结构建。
# 将构建返回的 release.json 路径交给 --actor-release / --opponent-release。
# --swap 交换创建/执行槽位，不控制地图出生位置。
```

`factory-exit` 是当前发布策略：观察到首批四辆坦克后，等待存活坦克完成出厂，再继续进攻；出厂期间的伤亡不会让已完成的生产进度倒退。附近接战仍可提前发生。经济、碾压、防空和探索沿用原策略。`combined` 是旧主线，`counter` 是保留的实验对手；`formed`、`raid`、`coordinated` 等保留作研究对照。模式名称本身不冻结代码，跨版本比较必须使用冻结包。全部实验和固定试玩版本见 [执行进展](docs/progress.md)。

## 固定版本与证据范围

- **SDK：`@chronodivide/game-api@0.79.0`。实际嵌入的引擎源码版本是 `0.83.3`，回放兼容标识是 `0.83`。** 这由发布包中的版本常量和真实回放确认；早期文档根据 changelog 写作「引擎 0.84」的映射已被实际结果修正。
- 玩家客户端来自官方 [0.83.3 归档](https://game.chronodivide.com/old/v0.83.3/)，配合同一 SDK 的规则资源包；客户端代码、SDK 资源和 AI 包均校验哈希。最初的 0.84 客户端试玩记录保留为单独证据。
- 最新三图开发池：`mp03t4.map`、`mp06t2.map`、`mp29u2.map`，对固定旧主线、counter、npm Supalosa 每格 6 场；0.1.5 为 **44/54 胜**，旧主线为 **30/54 胜**。新增地图 `mp08t2.map` 的另一批次两者均为 **12/24 胜**，全部正常结束。**收益随地图和对手变化，不代表所有条件更强，也不是正式目标分布或真人水平认证。** 过程中的退化、修正和版本分开记录在 [集结策略续进](docs/assembly-cycle.md)。
- 策略使用 `api-shroud-v0-visible-placement-frontier`：仅当前己方状态、按本方 shroud 过滤的敌方接触、己方探索信息；建筑预检局限于已探索的基地周边。该工程条件尚不宣称与人类界面的隐形、伪装等观察完全等价。
- 正常结束需要引擎 `Ended`、turn-manager 无错误及单方败北证据。超时、错误、主动中止分别保留；不把 `isFinished()` 单独当胜利。

## 实现结构

- [policy.ts](src/policy.ts)：当前主线的控制器入口，历史 mode 经 [legacy-policy.ts](src/legacy-policy.ts) 保留。
- [strategy.ts](src/control/strategy.ts)：战略阶段、目标、兵力就绪需求和生产目标。
- [tactics.ts](src/control/tactics.ts)、[production.ts](src/control/production.ts)：分别落实作战与生产任务。
- [coordinator.ts](src/control/coordinator.ts)：任务修订、单位归属、结果反馈和过期命令检查。
- [bridge.ts](src/bridge.ts)：观察白名单、局部引用、动作仲裁与提交。
- [effects.ts](src/effects.ts)：区分「已经请求」和实际观察到的效果。
- [runner.ts](src/runner.ts)、[referee.ts](src/referee.ts)：对局驱动与独立裁判记录。
- [player](src/player/)：本地入口、官方客户端接入与固定版本服务。

[分层实现与验证](docs/layered-control.md) 记录逐步影子比较、真实完整对局及独立战术试验。当前保持同步 API 控制；大模型战略、RPA 和完整多小队调度仍属于后续适配。

## 实用分析工具

[分析工具与验收记录](docs/analysis-tools.md) 说明每项改进对应的问题、实际反例和成本。`npm run analyze -- <批次目录>` 复算版本、直接对战、镜像和起点覆盖；`npm run analyze:encounter -- <单局目录>` 从原回放重建密集装甲时间线；`npm run experiment:matrix -- <计划文件> --out <新目录>` 执行冻结版本矩阵。分析依赖见 [requirements.txt](analysis/requirements.txt)，本机已具备。报告不自动判定因果、实力提升或晋升。

所有原版资源、客户端缓存、回放、浏览器数据、密钥及运行产物均被 Git 忽略。没有复用被放弃的本机项目代码。第三方软件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 项目约定与交接

研发依据：[小型对手池与共同演化方案](docs/opponent-pool.md)。首轮已完成双方版本冻结、挑战路线试跑与固定池比较；实际保留决定及后续工作以 [执行进展](docs/progress.md) 为准。

先读 [AGENTS.md](AGENTS.md)、[HANDOFF.md](HANDOFF.md) 和 [当前进展](docs/progress.md)。实现依据包括 [接口契约](docs/interface-contract.md)、[环境审计](docs/environment-audit.md)、[策略与责任](docs/strategy.md)、[评估协议](docs/evaluation.md)；历史规划、来源记录和无资源探针保留用于追溯。
