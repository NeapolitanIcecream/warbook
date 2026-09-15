# 公开对手、回放与地图输入调查

> **当前补充（2026-09-15）：** 固定 Supalosa npm 包与官方 bot 构建现已完成真实对局，见 [执行进展](progress.md)。两者同源，不计为两个独立策略家族；固定 API 0.79.0 实际内嵌的引擎源码版本为 0.83.3。下一轮按 [小型对手池与共同演化方案](opponent-pool.md) 构造和验证不同打法。以下是首次运行前的调查快照，保留其当时的证据边界。

调查日期：2026-09-15；目标版本为 `@chronodivide/game-api@0.79.0` / 引擎 `0.84`。完整来源、固定 commit、包信息与文件哈希见 [ecosystem-sources.json](references/ecosystem-sources.json)。公开资料调查之后，另做了纯模块加载与受守卫保护的构造探针；没有访问旧项目、执行 bot 生命周期、初始化游戏资源或训练。

**可以开始：固定 Supalosa `next` 的深路径模块已在单份 API `0.79.0` 上完成加载与构造；也取得了两份标记 `0.84` 且通过官方 `Replay.parse` 的公开真人回放。但还没有外部对手通过完整生命周期/对局验证，也没有回放数据通过完整模拟验证。** 加载探针使用了明确的 peer 检查绕过，不能称为上游支持。回放可辅助起步，不应阻塞正常开局产生自己的轨迹。

## 1. 查到哪些对手，分别能做什么

| 来源与固定版本 | 已检查的事实 | 当前用途与边界 |
| --- | --- | --- |
| [官方 Playground](https://github.com/chronodivide/game-api-playground/tree/f1474df82d81cc61512c8fc8fca6788b801d8105)，commit `f1474df82d81cc61512c8fc8fca6788b801d8105` | `package.json` 声明 API `^0.58.0`，锁文件为 `0.58.0`；示例展开基地、使用起始军队 attack-move、退出并保存录像 | 启动与指令探针的参考；没有经济/生产循环，不是本项目要求的完整战略基线 |
| [Supalosa 作者仓库](https://github.com/Supalosa/supalosa-chronodivide-bot/tree/165b77a71d0cf5ebd27c65b19d0486bcbae78d0f)，commit `165b77a71d0cf5ebd27c65b19d0486bcbae78d0f` | 源码版本 `0.6.8-beta.3`，bot 与 driver 声明 API `^0.75.0`，锁文件为 `0.75.0`；有生产、建筑、任务、侦察和攻防代码 | 首个完整外部对手的优先接入候选；是否在 `0.79.0` 正常工作、遵守选定信息协议及其强度均未测 |
| [Supalosa npm `latest`](https://registry.npmjs.org/@supalosa%2fchronodivide-bot/0.6.8-beta.1)，`0.6.8-beta.1` | 发布于 2025-12-25；`gitHead=ce039830a134c16752a6a7872cbecb2e64cdb662`，peer API `^0.73.0` | 是较旧的发布入口；不能因标签为 latest 就认为比当前源码更适合本项目 |
| [Supalosa npm `next`](https://registry.npmjs.org/@supalosa%2fchronodivide-bot/0.6.8-beta.3-165b77a)，`0.6.8-beta.3-165b77a` | 发布于 2026-03-16；gitHead 与上述作者源码一致，peer API `^0.75.0` | 可固定为接入起点；这是可定位的构建产物，不是兼容认证 |
| [RA2WEB bot](https://github.com/ra2web/ra2web-chronodivide-bot/tree/f6c3ea58de8fcd09b8ddd160a51f5ef980987bb7)，commit `f6c3ea58de8fcd09b8ddd160a51f5ef980987bb7` | 作者页面标记为 Supalosa fork；包仍名为 `@supalosa/chronodivide-bot`，版本 `0.6.0`，peer API `^0.51.2` | 可追溯的同源变体；不优先做跨多版本适配，也不能把它和上游计作两个独立策略家族 |
| [RedAlert2-Mac-iOS-iPad](https://github.com/ammaarreshi/RedAlert2-Mac-iOS-iPad/tree/991945d60a7139d3c4c438326abb6d3c093b2497)，commit `991945d60a7139d3c4c438326abb6d3c093b2497` | 本次只查 README 与 `redalert2/package.json`；作者说明 AI 从 Supalosa 衍生，并嵌入修改过的引擎树；manifest 不是一个依赖官方 Game API 的 bot 包 | 作为远期实现线索；没有核实其 AI 到官方 `0.79.0` 的适配，不能作为可直接加入首批比赛的对手或状态恢复能力证明 |

上述为有限范围的公开发现，不是“世界上只有这些 bot”的穷尽结论。已查询官方组织、Playground 的作者链接、GitHub/网页索引和同源项目。GitHub 部分 REST 请求触发公共速率限制，commit 改由 `git ls-remote` 固定。没有根据仓库名、难度名、星标或作者的效果叙述推断实际实力。

Supalosa 自述面向新玩家；这只能说明作者定位。对手池的价值仍取决于它在我们冻结的引擎、规则与观察条件下实际做了什么，而非作者如何命名它。

## 2. 首次接入的具体风险

### 2.1 版本范围确实不匹配

`^0.58.0`、`^0.73.0`、`^0.75.0` 都不包含 `0.79.0`。不能把旧锁文件安装成功，或用忽略 peer 冲突的安装参数，解释为目标版本兼容。

纯加载检查现已完成，见下一节；没有编译或修改 bot。下一步记录实际生命周期中使用的接口和必要适配差异，再进行有资源的对局验证。不要静默降级目标引擎来让对手“跑通”，也不要把 API 适配与策略优化混在同一个候选中。

### 2.2 发布包入口与作者实际导入方式不同

检查两个 npm tarball 得到：它们都声明 `main: dist/main.js`，但归档中没有该文件；`dist/bot/bot.js` 则存在。作者 [driver](https://github.com/Supalosa/supalosa-chronodivide-bot/blob/165b77a71d0cf5ebd27c65b19d0486bcbae78d0f/packages/chronodivide-bot-driver/src/index.ts) 使用深路径导入 `@supalosa/chronodivide-bot/dist/bot/bot.js`。

随后已对固定 `next=0.6.8-beta.3-165b77a` 做实际加载探针，结果保存在 [opponent-load-probe.json](references/opponent-load-probe.json)。测试运行时为 Node `v26.5.0`，不是对全部 Node 版本的声明。

| 探针 | 运行结果 | 结论范围 |
| --- | --- | --- |
| 默认依赖解析安装 | `ERESOLVE`：peer `^0.75.0` 不接受目标 `0.79.0` | 上游声明不匹配，不能掩盖 |
| 专用目录安装 | 显式使用 `--legacy-peer-deps --ignore-scripts`；实际目录中仅一份 API `0.79.0` | 仅允许检查这个固定组合；绕过 peer 不构成兼容支持 |
| 原生 ESM 裸包导入 | `ERR_MODULE_NOT_FOUND`，缺少 `dist/main.js` | 默认入口失败已实测 |
| 作者深路径 ESM 导入 | 成功，导出 `SupalosaBot` | 模块及其静态依赖可以加载 |
| 类身份与构造 | bot 与 driver 解析到同一真实 API 路径；继承和 `instanceof api.Bot` 均成立；空结盟名单、关闭日志时构造成功，context 未设置 | 没有调用 `setContext` 或任何生命周期，也没有验证国家规则、动作与策略 |

脚本对 `cdapi.init/createGame/loadReplay` 和 bot 生命周期入口设置了抛错守卫，记录到的守卫调用为空。探针没有创建游戏、执行 tick、做类型检查或重编译。**首轮 runner 可从已验证的深路径导入继续，剩下的问题是 context/生命周期和真实游戏行为，而不是继续猜入口。** 也没有必要继承作者的可视化 driver 及其 `canvas` 依赖，先接 bot 本体即可。

从仓库根目录复跑（依赖仅安装到忽略目录）：

```sh
mkdir -p work/opponent-loader
cp analysis/opponent-loader/package.json analysis/opponent-loader/package-lock.json work/opponent-loader/
npm ci --prefix work/opponent-loader --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node analysis/probe_opponent_load.cjs work/opponent-loader
```

[探针脚本](../analysis/probe_opponent_load.cjs) 会核对锁文件、已审计 API 文件哈希、对手包完整性记录，并将裸包失败与深路径加载结果分别写入报告。默认安装失败记录来自原始命令日志；脚本本身不安装依赖，也不会将未重复的安装实验写成重新通过。依赖定义与锁文件保存在 [analysis/opponent-loader](../analysis/opponent-loader/package.json)。

### 2.3 名为 1v1 的示例会请求双方结盟

上述固定 driver 的 `offlineSettings1v1` 给两位 bot 分别传入 `[botName2]` 与 `[botName1]`。而 [bot 构造器](https://github.com/Supalosa/supalosa-chronodivide-bot/blob/165b77a71d0cf5ebd27c65b19d0486bcbae78d0f/packages/chronodivide-bot/src/bot/bot.ts) 第三个参数是 `tryAllyWith`，`onGameStart` 会据此调用 `toggleAlliance(..., true)`。

这是源码确认的行为路径，尚未运行。**不能直接复制这个配置来检验敌对 1v1。** 我们自己的 runner 应传入空结盟名单，并检查开局关系和后续是否变化。同一 driver 达到最大时长会跳出循环再保存回放；因此“文件已经保存”也不证明自然终局发生。

### 2.4 现成对手有需要披露的信息优势

已定位的例子：

- [Playground `exampleBot.ts`](https://github.com/chronodivide/game-api-playground/blob/f1474df82d81cc61512c8fc8fca6788b801d8105/src/exampleBot.ts) 读取敌方 `getPlayerData(...).startLocation`，再派军队前往。
- [Supalosa `awareness.ts`](https://github.com/Supalosa/supalosa-chronodivide-bot/blob/165b77a71d0cf5ebd27c65b19d0486bcbae78d0f/packages/chronodivide-bot/src/bot/logic/awareness.ts) 使用敌方实际起点计算集结方向；[attackMission.ts](https://github.com/Supalosa/supalosa-chronodivide-bot/blob/165b77a71d0cf5ebd27c65b19d0486bcbae78d0f/packages/chronodivide-bot/src/bot/logic/mission/missions/attackMission.ts) 的一个目标生成分支会读取尚未探索的敌方实际起点。

这与读取地图所有候选出生点不同。上述代码大部分其他目标查询使用 `getVisibleUnits`，但这不构成人类等价观察的证明；它在目标 API 版本中的 shroud、伪装、字段权限仍受 [环境审计](environment-audit.md) 的限制。这里也不是已经查完对手所有信息路径的声明。

初次对照可将未修改 Supalosa 标为“原样、信息条件未对齐的外部挑战者”，只声明相对于该对手的结果。要用于同信息预算的正式比较或作为合法示范老师，须另建有记录的观察适配版本并验证行为；不能让原样对手的特权输入流入我们的 actor。

### 2.5 最低接入工作单

1. 保留本次固定发布包、目标 API、锁文件与深路径加载结果；需要源码适配时单独记录构建与类型检查，不把纯加载当成源码兼容证明。
2. 新建最小 offline runner：两位不同名字的 external Bot、明确敌对关系、记录国家/规则/实际起点，避免照搬旧 online 登录字段。
3. 若仅试 Playground，保留它依赖起始军队的前提并标记为机制探针；它没有生产代码，不用其结果代表正常经济局基线。
4. 将发送意图、实际动作效果、退出原因、超时与回放路径区分记录；Supalosa 自身也有认输条件，runner 记录这一来源。
5. 在实际对局运行成功后测行为覆盖、响应时序、异常和信息来源，再决定它是工程对照、挑战对手还是同条件晋升对手。当前仅第 1 项中的发布包加载/构造探针已完成，其余游戏运行步骤未完成。

## 3. 真实公开回放已经取得，验证分层记录

来源链条是 [官方天梯](https://ladder.chronodivide.com/) → 页面使用的公开比赛元数据 → 元数据中的 `replayUrl`。本次取得的 [官方地区配置](https://gateway.chronodivide.com/legacy/realms/servers.ini) 标记游戏版本为 `0.84.0`，但回放自身仍逐个检查。

| 样本 | 下载与结构事实 | 仍不能据此宣称什么 |
| --- | --- | --- |
| [`0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0`](https://wol-eu.chronodivide.com/api/v1/games/0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0) | 51,437 字节；header `RA2TSREPL_v6` / `ENGINE 0.84 4146105410`；地图 `4_jungle_of_vietnam_le.map`，digest `cde0988d` | 未初始化资源，未验证对应地图/模组可用、逐 tick 重放或动作成功 |
| [`639963f0-7654-4a85-a02d-b5f8d6aa20d3`](https://wol-eu.chronodivide.com/api/v1/games/639963f0-7654-4a85-a02d-b5f8d6aa20d3) | 34,679 字节；相同格式与引擎/模组标记；地图 `mp01t4.map`，digest `bc957ed8` | 同上；文件可解析不等于完整模拟兼容 |

两份 raw 文件只存于忽略目录 `work/ecosystem/ladder/`，不进入版本库。精确 CDN URL 与 SHA-256 保存在 [来源清单](references/ecosystem-sources.json)。调查先完成下载与文本 header 检查；随后根任务使用固定 `0.79.0` 的官方 `Replay.parse` 完成无 `cdapi.init` 的解析，详见 [解析探针结果](references/replay-parse-probe.json) 和 [回放数据探针](replay-data-probe.md)。这两个证据阶段不可合并成“引擎运行通过”。

官方解析共读到 3,721 条 attempted actions，包含 `NoAction`、选择、队列、建筑和单位命令等，**不是 3,721 个可靠训练标签**。回放中的 `aiPlayers` 还可能有空槽占位，判断内部 AI 是否存在应看非空条目，而非数组长度。

这两份文件来自同一公开玩家历史，只用于验证来源与格式，不是代表性数据集或保留集。查询 `ranked=true` 的比赛列表会同时出现 1v1 与 2v2；后续采集必须依据参与者、队伍与 `ladderType` 再筛选。解析还显示两局都开启超级武器；若首轮研究关闭该选项，不能把这些轨迹未经区分地当成同一任务分布。

### 可复用的发现路径

本次在官方页面脚本中观察并实际调用了以下只读数据入口；其来源脚本的 URL 与哈希已记录，不承诺将来长期稳定：

- `GET /ladder/16640/1v1`、`GET /ladder/16640/current`：赛季信息。
- `POST /ladder/16640/1v1/current/rungsearch`：公开排行榜查询；这个 POST 是只读查询，不会创建比赛。
- `GET /api/v1/games?gameSku=16640&player=<公开昵称>&ranked=true&limit=50`：分页比赛元数据。
- `GET /api/v1/games/<game-id>`：一局的地图、规则、参与者与回放 URL。

当前只取了少量可得性探针，没有进行批量抓取。以后采集应记录选择规则、对局 ID、时间、地图 digest、引擎/模组、规则和来源组，并按原始对局去重；不需要把聊天或玩家姓名复制进本仓库的分析报告。

## 4. 地图选择：已有可核查 ID，没有未经测量的地形结论

| 可核查候选 | ID 的实际来源 | 首轮如何使用 |
| --- | --- | --- |
| `mp03t4.map` | 固定 Playground `exampleBot.ts` 的实际 `mapName` | 作为官方启动示例候选；先检查本机枚举与加载，不由名称推断人数、地形或公平性 |
| `mp06t2.map` | 固定 Supalosa driver 的实际 `mapName` | 作为作者 headless 示例候选；其注释不是我们实测的通行性或规模保证 |
| `tn04t2.map` | 同一 driver 的候选地图注释表 | 后备候选，需要本机列表确认；不把旧注释当当前 ladder 地图池 |
| `mp01t4.map` / `bc957ed8` | 本次真实回放与官方比赛元数据；标题为 `South Pacific (2-4)` | 优先用于这份已取得回放的资源匹配调查；不因标题认定适合首轮陆战范围 |
| `4_jungle_of_vietnam_le.map` / `cde0988d` | 另一份真实回放与官方比赛元数据；标题为 `Jungle of Vietnam LE (2-4)` | 同上；不能从同名文件推断字节/摘要一致 |

[固定 API 类型](https://unpkg.com/@chronodivide/game-api@0.79.0/dist/index.d.ts) 提供 `cdapi.getAvailableMaps()` 和 `getAvailableGameModes(mapName)`。后续初始化用户已有资源后，先枚举实际列表再选地图，记录内容/摘要、模式与起点；不要直接将 `getAvailableGameModes(...)[0]` 的索引当成稳定的游戏模式名称。

首轮地图验收只覆盖当前实验需要的条件：能够正常开局、产生合法起点、基本资源/生产可用、双方能通过相应路径接触、能观察终局。想声称“陆战”“对称”“不同地形”时，再检查实际地图与运行，不从文件名补出属性。

[Mod SDK 固定版本](https://github.com/chronodivide/mod-sdk/tree/5943c4ae6c19897929d348a417d6d2f1481b75fd) 提供地图/INI 扩展说明，本身不是通用训练场景数据集。Supalosa 仓库还包含 `simple-1v1-no-preview.map` 与 `water-1v1-no-preview.map` 两个测试文件；本次仅记录路径与大小，没有复制或加载地图，不认可它们已有代表性。普通资源和公开地图来源的存在不替代本机加载验证，也不要求先下载资产或搭建自定义地图工程。

## 5. 数据起步策略：先用途，再规模

| 阶段 | 具体动作 | 可以得到什么 |
| --- | --- | --- |
| 现在 | 保留两个公开原文件的来源/hash与解析报告 | 证明公开回放可取得且目标 parser 接受；能够设计实际字段契约 |
| 首次有资源运行 | 在目标版本产生自己的正常 external-bot 对局，保存请求、执行后置状态、任务和录像；再回放核对 | 与实际 runner、地图、规则匹配的调试轨迹；减少外部历史版本依赖 |
| 公开回放试用 | 先用这两份探针检查 mod/map 匹配、事件重放、合法观察和结果核对，再扩展不同来源组 | 在已验证部分上进行行为分析与示范数据构建；不假定所有公开文件都可用 |
| 首个学习问题出现 | 按具体决策抽样，区分实际执行结果、受控干预结果、专家判断和模型预测 | 对应瓶颈的数据，不凭完整录像给所有未执行候选配标签 |

数据处理保留以下边界：玩家输入可能无效或冗余；命令尝试与实际行动分开；解析元数据不提供合法观察历史；一帧或一条命令不说明战略任务；后续胜利不证明某次选择的因果收益。同一回放的相邻片段、不同视角及扰动全部保持同一来源组。用于手工调试过的两个探针归开发资料，不能重新命名为未见测试。

首个数据集无需等待大量人类示范。先从自己能解释的完整对局获取失败案例和普通时刻；公开真人轨迹用于补盲点，可靠示范不足时暂不推进模仿训练。

## 6. 推荐初始对手池与尚未验证项

初始工程池建议包括：**本项目最小完整基线、固定版本并完成适配的 Supalosa、少量任务明确的简单规则对照**。Playground 示例用于启动/命令探针，单独列账。随后冻结自己的历史版本与行为确实不同的策略变体；同源 fork、不同难度名或国家变化不能自动计作独立对手家族。

Supalosa 先按本次固定 `next`/同 gitHead 接入，明确空结盟名单、目标 API、观察条件、退出原因；不要追随 npm 标签移动。它可以先作为原样挑战者，再决定是否值得做同信息条件的适配。RA2WEB 旧 fork 与修改引擎的衍生项目暂不进入首轮接入清单，除非其独有行为能回答一个已出现的问题。

当前仍待验证的事项是：

- Supalosa 在 `0.79.0` 的源码构建/类型兼容、context/生命周期、正常敌对对局、动作时序、行为覆盖和信息协议；固定发布包的深路径加载及无 context 构造已经完成，但不能替代这些检查。
- 用户本机实际资源中的地图 ID、模式、摘要、路径和正常终局；没有宣称上述候选都是可用的陆战验收地图。
- 两份公开回放所需 mod/map 是否匹配、`loadReplay` 是否接受、推进是否一致、结果和动作后置状态是否可核对。
- 合法观察与任务标签重建、相邻样本相关性、来源偏差，以及数据扩展后的覆盖范围。
- 任何外部对手的实战强度、运行吞吐、训练成本或学习增益。

这些未知项各有下一步，不构成“等公开数据齐全再开始”的前提。第一项实质运行仍是目标引擎上的正常敌对完整对局；即使某个公开回放或对手适配失败，也可以继续用最小基线产生可追溯的新证据。
