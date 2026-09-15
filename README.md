# Warbook / Chrono Divide AI

**当前版本：0.1.4。** 本地可玩的红色警戒 2 AI。新实现已经完成真实经济、生产、交战与胜负流程，并以完整对局和回放验证改进。

## 试玩

打开 **[本地玩家入口](http://127.0.0.1:8642/)**，选择「本地对战」→「开始游戏」。默认美国、美国小镇、10000 资金、零起始军队。

- 鼠标选择基地车，按 **D** 展开；在右侧建造栏生产和放置建筑。
- **Esc → 放弃任务 → 退出** 可以结束当前局；结算后点「继续」再次开局。
- 服务未启动时，双击 [Play Warbook.command](scripts/Play%20Warbook.command)。Agent 负责环境、版本、日志与运行维护。

只想看 AI 对战，可以点击首页的「观看 AI 对局回放」，或打开 **[完整对局回放](http://127.0.0.1:8642/watch)**。当前本机提供 Warbook 0.1.4 对 Supalosa 的美国小镇对局，约 12 分钟。回放无需操作军队；窗口较窄时可用 Esc → 全屏展开画面。

这是基础地面作战研发版。当前重点是建设、采矿、出兵、坦克对步兵作战和寻找迁移的基地；不宣称已经覆盖所有兵种、地图或真人竞技水平。

## 本地开发与复现

需要 Node.js ≥22.15（本机验证版本 26.5.0）和合法取得的 `ra2.mix`、`language.mix`、`multi.mix`。

```sh
npm ci
# 将 MIX 放在 assets/ra2，或在 .env 中设置 MIX_DIR。
npm run play
```

首次启动缓存官方客户端，浏览器自动从本机导入资源；对局不需要账户或 Bot API key。准备完成后，`OFFLINE=1 npm run play` 禁止缓存缺失时联网。入口仅监听 `127.0.0.1`。

Agent 在本地 `.env` 中用 `WATCH_MATCH=runs/<run-directory>/result.json` 选择首页回放，重启入口生效。服务检查正常结束记录、回放版本与文件 SHA-256；对局文件仍仅保存在忽略目录。未配置时首页只显示对战入口。

```sh
npm test
npm run typecheck
npm run match -- --units 0
npm run match -- --mode baseline --opponent supalosa --units 0
npm run batch -- --rounds 12 --modes baseline,combined --map mp03t4.map
npm run replay -- runs/<run-directory>
```

`combined` 是当前发布策略：先形成早期坦克，再扩张经济；对可见地面步兵使用原生碾压指令，遇到空中威胁则生产防空车；清查出生点后继续侦察未探索区域。`baseline` 保留作为初始工程对照。全部实验与当前固定试玩版本见 [执行进展](docs/progress.md)。

## 固定版本与证据范围

- **SDK：`@chronodivide/game-api@0.79.0`。实际嵌入的引擎源码版本是 `0.83.3`，回放兼容标识是 `0.83`。** 这由发布包中的版本常量和真实回放确认；早期文档根据 changelog 写作「引擎 0.84」的映射已被实际结果修正。
- 玩家客户端来自官方 [0.83.3 归档](https://game.chronodivide.com/old/v0.83.3/)，配合同一 SDK 的规则资源包；客户端代码、SDK 资源和 AI 包均校验哈希。最初的 0.84 客户端试玩记录保留为单独证据。
- 最新三图开发批次：`mp03t4.map`、`mp06t2.map`、`mp29u2.map`，每图每策略 12 场；候选 36 胜，初始对照 6 胜、28 负、2 场未决。对手为固定 Supalosa npm 构建。**这些是开发集成绩，不能代替正式目标分布或真人水平认证。**
- 策略使用 `api-shroud-v0-visible-placement-frontier`：仅当前己方状态、按本方 shroud 过滤的敌方接触、己方探索信息；建筑预检局限于已探索的基地周边。该工程条件尚不宣称与人类界面的隐形、伪装等观察完全等价。
- 正常结束需要引擎 `Ended`、turn-manager 无错误及单方败北证据。超时、错误、主动中止分别保留；不把 `isFinished()` 单独当胜利。

## 实现结构

- [policy.ts](src/policy.ts)：纯数据、同步决策，没有引擎句柄。
- [bridge.ts](src/bridge.ts)：观察白名单、局部引用、动作仲裁与提交。
- [effects.ts](src/effects.ts)：区分「已经请求」和实际观察到的效果。
- [runner.ts](src/runner.ts)、[referee.ts](src/referee.ts)：对局驱动与独立裁判记录。
- [player](src/player/)：本地入口、官方客户端接入与固定版本服务。

所有原版资源、客户端缓存、回放、浏览器数据、密钥及运行产物均被 Git 忽略。没有复用被放弃的本机项目代码。第三方软件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 项目约定与交接

下一轮研发依据：[小型对手池与共同演化方案](docs/opponent-pool.md)。已记录对手来源边界、双方版本冻结、挑战路线、完整一轮推演和主线晋升规则；方案尚未进入执行。

先读 [AGENTS.md](AGENTS.md)、[HANDOFF.md](HANDOFF.md) 和 [当前进展](docs/progress.md)。实现依据包括 [接口契约](docs/interface-contract.md)、[环境审计](docs/environment-audit.md)、[策略与责任](docs/strategy.md)、[评估协议](docs/evaluation.md)；历史规划、来源记录和无资源探针保留用于追溯。
