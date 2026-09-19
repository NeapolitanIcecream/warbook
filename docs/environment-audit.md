# Chrono Divide 环境能力审计

## 2026-09-19：地图知识、通行层和可见中立目标

0.1.15 使用 `api-shroud-v1-pregame-map-prior`。最终地图实现与早期原型不同：普通 MCV 开局的第 0 tick，通过锁定引擎的只读 `MapApi.isPassableTile` 分别建立车辆、步兵通行图，桥上和桥下是不同节点；后续仅对本方已探索区域更新。`Terrain.getPassableSpeed/isBlockerObject` 源码确认，该查询忽略可移动单位占位，不维护引擎路径图。静态地图先验不包含战斗方真实出生分配、资金或部署；自带战斗方预置建筑的自定义场景不在这次普通开局验证范围。

边界检查 `work/iteration-015/mobile-passability.json`：正常开局中用原生命令把 MCV 从 (52,97) 移至 (53,97)，90 tick 后车辆/步兵通行查询哈希仍为 `8da49267…`。四图各两次初始化的通行图也相同，但这些重复恰好得到相同出生位置，不能据此宣称验证了受控换位或种子接口。

具体导航缺陷与修正：早期原型漏掉墙体，并混用了步兵可达点和车辆搜索点；一局大军搜索了车辆无法进入、且不与主力连通的 (36,28)。最终分别限制可达区域，桥面标记保留到原生命令。单位完整行军交给引擎 Move/AttackMove；独立 ngraph 仅用于选位、侦察绕行、备选入口及合法性，不调用 `findPath` 或 `getReachabilityMap`，不修改引擎路径缓存。

工程师目标来自 `getVisibleUnits("hostile", capturable && produceCashAmount > 0)`，只对当前可见、非己方/盟友目标提交 Capture。实际城市局已占领 CAOILD；一次所有权变化可能确认多条待处理命令，反馈条数不等于占领次数。

普通步兵/坦克接触消失时，若上一观察在三 tick 内、保守三格移动邻域全部已探索，就将旧位置标记为 `vacatedContacts`。不查询消失对象，不读取全局死亡事件，也不报告为确认击杀；矿车传送、基地车和特殊单位不适用。

科技链验证：美国当前可生产的雷达建筑是 AMRADR。策略使用生产 API 的 `radar` 属性和已拥有建筑，避免误排其他盟军使用的 GAAIRC。GATECH 成本 2000、SREF 成本 1200，Comet 射程 10；SREF 使用 Weapon1，SDK 在运行时将它提供为 primaryWeapon。真实对局已完成科技链、生产 SREF，并在原始回放中记录到 Comet 冷却重启信号。完整验证和限制见 [本轮记录](iteration-015.md)。

这些是信息条件的显式扩展；与 0.1.14 比较是完整软件包比较，不是只改战略的消融。原生回放兼容性另行检查。

## 2026-09-18 运行补充：规划寻路查询并非无副作用

当前锁定包实际嵌入引擎为 **0.83.3**，回放标识 0.83；以下初期 0.84 映射和未运行条目保留为历史记录。

`closure-integrated-recheck/mp08t2.map/old-defense/0-closure-candidate` 的原生回放从 tick 6600 的矿车位置开始分歧，最终未复现原局终局。补做原 Bot 的 observe/decide、但不提交任何动作时，前 7000 tick 的 94 份快照恢复一致；只屏蔽 `MapApi.findPath` 查询后，分歧又回到 6600。源实现 `Terrain.computePath / computePassabilityGraph / updatePassability` 会维护共享图缓存；不能把此 API 调用视为与模拟完全隔离。

`a507f15` 将运行中规划移到独立的 ngraph 图，只读取本方已探索格子的可通行性和高度，局部规划不跨桥；真实完整移动仍由引擎原生动作负责。新规划器对旧问题录像做查询/不做查询，384 个双边快照（单位位置/HP、资金、败北状态）生成相同指纹 `0f6cd5b9…`。这证明所检查重放上的查询隔离，不修复旧录像已经缺失的查询历史。新生成完整局及其原始回放另外验证，结果见 [闭环记录](closure-019.md)。

探针均在忽略目录 `work/closure-019/replay-query-probe.mjs`，原始失败、首次差异、查询/无查询结果分别保存；不要用带补充查询的播放冒充普通原生回放通过，也不要将旧的真实正常终局改写为录像验证通过。

审计资料窗口：2026-09-14 至 2026-09-15。对象：`@chronodivide/game-api@0.79.0`，其 CHANGELOG 对应游戏引擎 `0.84`。本文件记录公开资料和该发布包的静态检查，不代表仓库已安装依赖、加载资源、打过对局或完成运行验证。

后续前期工作另有 [接口与提取方法 mock 探针](interface-contract.md) 和 [真实公开 replay 解析](replay-data-probe.md)。它们已执行各自有限的测试，但未初始化引擎，不将本静态审计表中的运行项目改记为通过。

**下一步是用锁定版本跑通一场有记录的正常开局 1v1。** 观测规则和最小动作适配需要明确；完整状态恢复、任意回放分叉、训练平台不应阻塞首局。与方法论的关系见 [原始方案中的环境契约与回放讨论](references/gpt-6-pro-original.md)。

## 证据等级与资料定位

- **资料事实**：发布包文档、类型定义、元数据明确声明的内容。
- **源码结论**：已检查该发布包实现，可描述其代码路径；仍未证明本机运行结果、跨版本行为或边缘情况。
- **源码推断**：根据若干实现路径推导的预期结果，需要针对性运行确认。
- **待实测 / 拟定方案**：尚未运行的验证或项目选择，不能记录为通过。

`source_verified` 不等于 `runtime_verified`。本审计的所有运行验证状态都是 `not_run`。API 文档与实现有出入时保留差异，并用运行证据解决，不静默挑选方便的一项。

| 代号 | 固定版本资料 | 用途 |
| --- | --- | --- |
| R | [README.md](https://unpkg.com/@chronodivide/game-api@0.79.0/README.md) | 启动、回放、确定性说明 |
| D | [dist/index.d.ts](https://unpkg.com/@chronodivide/game-api@0.79.0/dist/index.d.ts) | 公开 API 与数据字段 |
| J | [dist/index.js](https://unpkg.com/@chronodivide/game-api@0.79.0/dist/index.js) | 当前发布实现 |
| C | [CHANGELOG.md](https://unpkg.com/@chronodivide/game-api@0.79.0/CHANGELOG.md) | 引擎对应版本和接口变更 |
| P | [package.json](https://unpkg.com/@chronodivide/game-api@0.79.0/package.json) | 包版本、Node 要求与依赖 |

这些文件的 SHA-256、字节长度、声明定位和源码搜索标记见 [api-provenance.json](references/api-provenance.json)。源码 J 是压缩文件，定位使用搜索标记和从 0 开始的字符偏移，不把长行号当作足够精确的定位。仓库只保存审计与溯源信息，不复制发布 bundle 或 MIX 资源。

## 运行、控制和部署边界

| 能力 | 已确认内容 | 证据 | 运行状态 / 含义 |
| --- | --- | --- | --- |
| 版本 | API `0.79.0` 对应引擎 `0.84`；前轮 registry 元数据的发布日期为 2026-09-03 | P；C 3–6 行 | 版本号不是同一套编号；尚未运行本机版本 |
| Node 与资源 | P 要求 Node ≥20，官方 Playground 也要求 Node 20+ 和原版 RA2 MIX 文件；R 的 Node14 前提已与当前包不一致 | P `engines`；C 107 行；[Playground](https://github.com/chronodivide/game-api-playground) | 先检查实际版本和用户提供的资源路径；不把资源提交仓库 |
| 无界面对局 | 可创建多个外部 Bot 的 offline 游戏，循环调用 `game.update()`，保存回放 | R 19–63 行；D 497–517、1273–1295 行 | 资料事实；未执行 |
| 时间推进 | D 将 offline `update()` 定义为推进一 turn，online 则等待下一 turn；`getTickRate()` 与 `getBaseTickRate()` 不同 | D 485–505 行 | 一次调用前后 tick 差、下令生效时刻与变速情况待测；不预先把 turn、tick、游戏秒、墙钟秒混为一谈 |
| 动作 | 有生产队列、建筑放置/出售/修理、超级武器和单位命令；单位命令包括 Move、Attack、AttackMove、Deploy、Gather 等 | D 18–69、1049–1069 行 | 方法通常返回 void；必须用后续状态检查实际效果 |
| 回调与推理 | `Bot.onGameTick` 声明返回 void；当前 `GameInstanceApi.update()` 用同步 `forEach` 调用 Bot，不 await 回调返回值 | D 170–197 行；J `class GameInstanceApi` | 源码结论；把回调写成 async 并不会自动暂停引擎等模型。首次基线可用同步逻辑；需要异步推理时在 driver 显式调度 |
| Online | 当前需要 XWOL API key；online agents 仅第一项可为 Bot；自动传送自定义地图已移除 | R 116 行起；D 337–350、1286–1292 行；C 8–12 行 | 首局可 offline，不因 online 配置推迟验证 |
| 吞吐 | 文档称 offline 按尽可能快的速度运行，但未给出本项目实测吞吐；`findPath` 有明显开销，仅查连通性可考虑 `getReachabilityMap` | D 864–876、1282–1284 行 | 不据此承诺 RL 样本产率或并发扩展能力 |

拟测案例（均未运行）：比较从未下令的单位、已有命令后不发新命令的单位，以及收到显式 `Stop` 的单位，核对已有任务是否继续和自主行为是否发生。三者不能统一编码成同一种“无操作”。另一个案例是区分建筑放置合法与放置后工厂出口、矿车往返路线可用；首局先记录真实阻塞，出现相应故障后再扩展针对性的建造测试。

外部 sandbox Bot 与嵌入游戏循环的内部 AI 是不同部署方式。R 183 行起要求参与同步游戏模拟的代码满足确定性；跨客户端浮点计算、随机数和执行顺序会影响 lockstep。外部控制器可把推理结果转成玩家输入，但仍需自己的实验可复现性与延迟协议。训练好一个模型后能否直接集成进同步循环，尚未验证。

## 初始化、随机性与状态分叉

| 问题 | 证据与结论 | 当前可采用的路径 |
| --- | --- | --- |
| 固定种子与起点 | D 313–335 的公开 `CreateOpts` 没有 seed、startPos 或按玩家资金字段。J `_PublicApi_createOfflineGame=` 使用 gameId `0` 与秒级 `Date.now()` 时间戳；`_PublicApi_generateGameOpts=` 给玩家设置 `RANDOM_START_POS` | 记录实际起点与初始化元数据；未控制时使用重复对局和分层比较，不称为同种子配对实验。只有近期实验需要时才添加并验证控制适配 |
| 引擎随机性 | J `class Prng{` 根据 gameId/时间戳生成内部 PRNG | 源码结论，不等于公开 reset(seed) 已存在 |
| Bot 随机性 | D/R 描述 `generateRandom` 使用内部 PRNG，但 J `GameInstanceApi` 构造 `new GameApi(..., false)`，该分支的 `generateRandom()` 返回 `Math.random()` | 记录这个文档/实现差异。需要复现随机策略时，显式管理策略随机源；不要假定 API helper 在 sandbox 已被固定种子控制 |
| 回放读取 | R 65–114 提供解析与逐 turn 模拟；解析事件不需要游戏资源。回放输入是命令尝试，不保证成功 | 可用于动作审计、观察重建、失败分析；行为标签需检查执行结果 |
| 回放兼容 | R 112–114 要求引擎版本、mod hash、map digest 匹配；初版不支持 single-player、internal AI、custom-map lookup、seeking。J `loadReplay` 检查至少两个 humanPlayers 及无 internal AI slots | 首先验证自己产生的兼容回放；历史回放和自定义地图逐项确认，不默认通用可读 |
| 外部 Bot 回放 | J `_PublicApi_generateGameOpts=` 把外部 agents 放进 humanPlayers，并将 aiPlayers 留空 | **源码推断**：至少两个 external Bot 的录像不会仅因 internal-AI 限制被排除；还需兼容性与实际回放验证 |
| 接管与 fork | D 1496–1506 的 `ReplayInstanceApi.getPlayer()` 返回 `ReadonlyPlayerApi`，无 actions；J 回放由原录制动作的 ReplayTurnManager 驱动 | 已检查的公开 API 没有 takeover/fork。可以正常开局推进后继续交给控制器；不能把回放观察写成已能反事实接管 |
| 快照恢复 | D 的 PublicApi、GameInstanceApi、ReplayInstanceApi 没有 save/load state 或 restore 接口；`getDebugStateDump()` 仅用于开启诊断的 online 游戏 | dump 不是已验证的可恢复快照。完整恢复工程只在明确实验收益足够时开展 |
| 场景编辑 | 已检查的公开 API 没有 spawnUnit/setMoney/setPosition；支持地图/INI 扩展和部分触发器 | 自定义地图是可调查的入口，不是完整状态恢复。首局直接用普通地图和开局 |

[Mod SDK](https://github.com/chronodivide/mod-sdk/blob/master/README.md) 说明 INI、地图扩展和不兼容项；[MAPS.md](https://github.com/chronodivide/mod-sdk/blob/master/MAPS.md) 的已阅支持表仍标记引擎 0.70。它不能单独证明 0.84 的每项场景构造行为。地图可加载，也不意味着正常可达、目标有效或与某帧真实对局状态等价。

没有分叉时，先用完整对局比较、真实开局脚本前缀及经过核查的相近局面。能重放相同前缀还须验证初态和随机源；不能称为精确反事实。以后若接管真实录像，需恢复控制器观察历史/记忆，并让对手响应新局面；机械播放原对手后半段命令只能支持开环结论。

## 引擎真值不是 actor 观测

以下是可读数据的源码与类型事实，**不是对其竞技合法性的自动判定**。项目需先明确观测协议，再执行白名单转换。

| 入口 | 额外可读信息 | 证据 |
| --- | --- | --- |
| `getAllUnits` / `getUnitsInArea` | 全图单位，不以当前玩家观测资格为边界 | D 445–468；J 同名方法 |
| `getPlayerData(name)` | 指定玩家的精确 credits、power、实际起点 startLocation | D 1169–1184；J `getPlayerData(e)` |
| `getUnitData(id)` | 不执行玩家可见性授权；返回真实类型、HP、武器冷却、矿车载量、rallyPoint 等 | D 2130 行起、2316 行起；J `getUnitData(t)` |
| `getAllTilesResourceData` | 全图当前矿量；与地图静态矿区先验不同 | D 879–881；J 同名方法 |
| 全局事件 | Spawn、Unspawn、OwnerChange、Destroy 未按观察玩家过滤；Destroy 还带攻击者 ID、武器名 | D 126–141、984 行起；J `class EventsApi` 和 `class GameInstanceApi` |
| `getVisibleUnits` | 敌方查询检查 shroud 和敌我归属；当前实现未在此处检查 cloak/disguise | D 454–466；J `getVisibleUnits(e,r` |

实际敌方起点和地图上所有候选出生点是不同信息；前者是否允许预先获知需要写进协议。即使先调用 `getVisibleUnits`，也不能宣称得到人类等价观察；身份、特殊隐藏机制和返回字段仍需过滤/实测。精确 HP、冷却等字段是否允许，由选择的任务与信息协议决定，不能仅凭“很精确”就断言非法，也不能因 API 返回而自动允许。

actor 只接收按协议生成的 observation；引擎真值可留给独立裁判、诊断或明确声明的训练辅助目标；belief 是由合法历史推导的估计。事件、对象 ID、排序、动作掩码、路径查询和运行时规划输出也应检查间接泄漏。若规划器读取真实隐藏对手状态，其候选动作评分就已把真值传给 actor，即使网络输入表没有该字段。

首版可从字段白名单和日志比对开始。之后用适配器固定记录差分、可达对局对照等方式测试：只改变协议规定的不可见内容时，actor 的输入是否保持不变。不要为这项检查假定已有任意引擎状态修改接口。

## Shroud 语义需要按本引擎验证

J `class MapShroud{` 的探索更新将区域设为 `Explored`，单位离开不会普遍重新覆盖；`class GapGeneratorTrait` 等机制可主动 unreveal，临时揭示也有独立计时。这个源码结论意味着不能把 SC2 式每 tick 当前 sight 圆裁剪直接套在 Chrono Divide 上。

待实测的例子包括：侦察单位离开已探索区、Gap Generator 覆盖/断电、从黑幕中开火的临时揭示、特殊伪装/隐形单位和高地/桥梁。普通首局只需采用已明确的受限协议，并把尚未覆盖的机制列为限制；专门依赖这些机制的实验在验证后开展。[客户端补丁记录](https://chronodivide.com/patch-notes.html) 可帮助定位变动，不能替代锁定版本的运行检查。

## 首场完整对局的最小验证清单

下列项目全部为 **待实测**；此文件没有勾选任何通过项。首局前完成 1–3，4–7 随首局及其回放收集，不要求先搭好完整研究平台。

1. [ ] 锁定 `game-api@0.79.0` 及依赖安装结果，记录 Node、包/引擎版本、地图与规则选项；确认 MIX 资源来自仓库外的配置路径。
2. [ ] 使用普通已安装地图创建两个外部 Bot 的 offline 游戏。优先采用能正常开局、生产、侦察、交战的最小实现或明确版本的现有对手；记录实际阵营与起点。[Supalosa Bot](https://github.com/Supalosa/supalosa-chronodivide-bot) 可作为待验证对照，本项目尚未测量其可运行性、战力或性能。先不增加 seed/fork 工程。
3. [ ] 明确此次试跑的观测协议与动作频率；通过最小 observation adapter 喂给 Bot，裁判读取的全局数据独立保存。对未审计的特殊机制和字段明确限制，不声称人类等价。
4. [ ] 记录至少一次 `update()` 前后的 tick、观察时刻、请求命令和后续效果。用展开、生产完成、建筑放置、移动/交战等后置条件检查动作执行；重复命令的影响作为有实际问题时的后续机制实验。
5. [ ] 推进到引擎真实终局，记录胜负或错误。设置可诊断的超时/最大 tick 上限；达到上限标为截断，不能记为自然终局或胜利。首局失败也保存日志用于定位。
6. [ ] 保存回放并重新加载，检查兼容性、终局和少量关键状态检查点。只把已比较的字段称为一致，不把有限观察哈希称为完整状态恢复证明。
7. [ ] 保存一份简短 run manifest：代码版本/未提交差异、配置、实际起点、tick 数、结束原因、回放路径、日志路径、墙钟耗时与观测/推理/推进的粗略开销。资源仅通过配置路径引用；录像和运行产物保存在仓库忽略目录（例如 `runs/`）或仓库外，不提交版本库。

首局后根据观察到的失败选择下一项验证。异步服务、跨平台 lockstep、精确随机控制、特殊可见性、自定义场景、完整 fork 分别由需要它们的近期实验驱动。未经运行的结论继续保留为待实测；不要用更多文档替代下一场有信息量的完整对局。
