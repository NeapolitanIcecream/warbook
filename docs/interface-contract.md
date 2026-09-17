# 首条实现路径的接口约定

编制日期：2026-09-15。目标是开始最小完整对局，不是建立通用训练框架。沿用 [环境审计](environment-audit.md) 的 `game-api@0.79.0`，文件身份与哈希复用 [api-provenance.json](references/api-provenance.json)。本文件中的接口、字段取舍和调度均为**拟定方案**；源码结论另行标注。本接口审计执行了下文的 `orderUnits` 方法 + mock；独立的 [文件解析探针](replay-data-probe.md) 另行记录。**没有初始化真实引擎、读取 MIX、执行对局或训练**。

第一条路径采用两个外部 Bot 的 offline 对局、一个 driver、同步策略和 JSON 可表示的纯数据边界。策略只需实现“观察和本地记忆 → 一批意图”；Bot 桥接对象保存 API 能力，driver 负责推进与发送，裁判负责独立记录。开始时不需要模型服务、任意状态恢复或多进程平台。

## 1. 最小信息协议与字段白名单

### 1.1 暂定信息条件

首轮暂用 `api-shroud-v0`：允许公开游戏规则、地图边界与全部候选出生点；己方状态使用结构化 API；敌方/中立接触由 `getVisibleUnits` 的 shroud 条件决定，允许其当前真实类型和 HP。**这是明确的 API 信息条件，不宣称与人类界面等价。** 当前 `getVisibleUnits` 对 cloak/disguise 的边界未满足人类等价证明，首轮也不伪造一个未经验证的探测模型。若以后改成不同的侦测、伪装、精度或地图知识条件，修改 `observation_protocol_id`，并按新条件重跑对照。

这里允许敌方已接触单位的精确 HP，是一项实验选择，不是认定此精度在所有比赛中合法；实际敌方出生位、当前资金、电力、队列、隐藏单位、隐藏动态矿量仍不允许。两种出生位信息不能混淆：`getStartingLocations()` 是候选点；`getPlayerData(enemy).startLocation` 是该玩家实际起点。[D 445–469、852–853、1169–1184；S1/S2]

本 profile 只用于工程试跑与明确标注信息条件的对战诊断，不能默认成为项目最终的合法玩家信息协议，也不能将结果晋升为人类公平竞赛成绩。正式目标涉及探测、伪装等机制时，先验证并实现所需观察条件，再按对应协议重测；不能将受限试跑或出现特殊机制的对局静默删掉。

### 1.2 Observation 的最小内容

白名单只复制所列标量、枚举和普通数组。不得把 `GameApi`、`PlayerApi`、`Tile`、`Rules`、getter、函数、Promise、日志句柄或引擎对象引用交给策略。API 返回的外层 data 对象不保证嵌套字段是独立快照；例如 `getGameObjectData` 直接带回 `tile` 和 `rules`，只对部分向量做 clone。[S1]

| 组 | 首轮允许字段 | 提取与未知处理 |
| --- | --- | --- |
| 决策边界 | `observation_seq`、`tick`、`self_seat` | tick 来自本次边界；不传墙钟、机器负载、模型延迟、运行文件名或实际随机种子 |
| 固定规则目录 | 单位/建筑类型名、对象类型、公开造价、建筑 footprint、基础角色/能力标签 | 从当前固定规则复制所需字段；不传整棵 `TechnoRules`。目录和规则哈希由 run 记录，actor 只读普通数据 |
| 地图先验 | 地图有效坐标域、候选出生点 | 候选点不带玩家对应关系；不得把全图当前 `landType`、矿量、桥梁状态或路径连通性冒充静态地图先验 |
| 己方经济 | `credits`、`power.total/drain/isLowPower` | 只查己方；actor 自己的预算预留是计划，不是引擎扣款结果 |
| 己方生产 | 各使用中的 queue 的类型、状态、size/maxSize、按序的类型名与数量；当前可生产类型名 | `ProductionApi` 限定在己方。公开 `QueueData` **没有进度百分比、剩余秒数、已花费资金**；这些字段保持 unknown，估计值只能另存 belief。[D 1306–1336；S3] |
| 当前己方对象 | 本地 `entity_ref`、类型、位置标量、HP/maxHP、朝向、桥面/zone、buildStatus、isIdle、canMove；适用时的 factory.status、载矿/宝石量 | 属性不适用与不可得分开；`isIdle` 只表示 API 的任务状态，不能推导战略任务完成。首轮不读取武器 cooldown 或隐藏目标任务链 |
| 当前接触 | 本地 `entity_ref`、所属阵营类别、类型、位置标量、HP/maxHP、`observed_tick` | 仅在此次 shroud 接触集合内提取；不附带敌方载量、资金、队列、rallyPoint、精确武器计时 |
| 已探索地块当前观察 | 可见地块的基础地形、坡道/高度、当前 bridge/land 信息及矿量 | 逐地块按本协议的 shroud 资格取值，复制坐标与标量；没有看见的动态矿量不是 0。首轮不将全局 `findPath`/连通图输入 actor |
| 上次己方意图反馈 | 意图本地状态、实际发送记录、由合法新观察支持的效果 | 不附带裁判从隐藏世界推导的失败原因；原始异常只进 runner 日志，actor 收到固定的本地失败类别 |

基础角色标签是从允许公开的规则定义生成的，例如基地车、建造场、矿车、经济/生产建筑等；不得由当前隐藏敌军或“裁判认为最佳用途”生成。逐单位位置只复制 `rx/ry/z`、必要的 `tileElevation/onBridge` 或 `worldPosition.x/y/z`，不用 `Tile.id` 作为实体 ID，不把其 `tag/occluded` 等额外字段顺带传入。[D 536–556、2090–2105、2130–2182]

### 1.3 未知、历史与标识

一个可缺失值使用 `observed(value, tick)`、`stale(last_value, last_observed_tick)`、`unknown(reason)` 或 `not_applicable`。不允许以 0、false、空数组或当前 tick 表示未知。完整枚举本次可见接触后，空接触集合表示“本次资格范围内无接触”，不表示敌方总兵力为零。API 异常时整份快照标为无效，不能替换成空军队继续决策。

敌方离开接触集合后，只保留历史位置，不能凭旧 ID 再查 `getUnitData` 刷新坐标、验证存活或发起新的对象目标攻击；可以向最后已知地点下合法的坐标命令。先前合法发出的命令是否继续追踪，由引擎默认语义决定，另做机制验证。

己方对象消失也不能自动计为死亡：源码 `getOwnedObjects()` 默认排除 limbo 对象，`getVisibleUnits(self)` 使用这个列表。进入运输/其他非活动状态、失去所有权和被毁需区分；首版统一记“当前不可用/原因未确认”，并撤销该对象当前控制权，不编造 kill/loss 标签。[S4]

原生对象 ID 只在桥接层保存，用于命令解析。本地 `entity_ref` 只在对象首次合法进入观察时分配，不为全图隐藏实体预先占号；先按允许的可见属性稳定排序，再分配，避免原生全局 ID 的间隙、大小和世界枚举顺序泄漏生产历史。本地 ref 仍是引用而非有序数值特征；一致重映射 ref、队列引用与命令目标应保持语义。即使使用原生 ID 作为内部连续性键，也不能输出该数字或以它打破有战术意义的候选排序。

## 2. 真值隔离与查询规则

### 0.1.9 已验证扩展

己方 DTO 增加主武器及部署武器射程，当前合法接触增加已知武器最大射程，不附带敌方目标或冷却状态。守备任务可声明保护对象和已知来袭方向；桥接层通过 `defense-route.ts` 提供一个预备位置。

该辅助只选本方已探索且可通行的端点，调用固定 SDK `findPath` 时关闭 `bestEffort`、排除未探索节点，并逐点复查返回路径。源码核对表明 `connectTiles` 的连边条件取决于边两端的通行、高度与桥状态；全图缓存、区域编号和全图连通结果不透传给策略。路径只用于本地预备位置，真正的行军继续提交完整目标，由原生命令寻路。每 150 tick 最多六次受限查询；没有为策略扫描隐藏资源或枚举全图敌军。

这保留现有 shroud 资格边界，属于可选字段和允许查询的扩展，不宣称与人类隐形/伪装观察完全等价。原主线在相同新观察下的 4,274 次决策与冻结 0.1.7 一致；相关路由和排除未探索节点的检查见 [实施记录](active-defense-cycle.md)。

### 共用约束

driver 在每个边界先冻结双方 observation，再调用双方策略。actor 看不到对手的策略名、对方请求命令、耗时、文件路径、run ID 或随机种子；相同的合法历史不应因这些元数据变化而改变输出。相同进程内先以模块能力隔离和普通数据复制实现；这不是对恶意代码的安全沙箱承诺。

裁判可查询全图真值与统计，但不在策略请求时回答“哪里有敌军”“为何放置失败”“这个目标实际死没死”。裁判产生的标签写入独立记录。原始 Spawn/Destroy/OwnerChange 事件也只交给裁判；首轮 actor 的出现、缺失和血量变化来自相邻合法快照。需要更细事件时再加入明确的玩家过滤，不能因事件带了己方 target 就连同不可见攻击者 ID/武器一起透传。

动作掩码分为两个概念：**本地请求格式/已知能力检查**与**引擎当前真实可执行性**。前者可从 observation 生成；后者可能依赖隐藏状态，不是可任意查询的 actor oracle。`canPlaceBuilding` 的源码会检查真实地块占用，`Tile.landType` 也会受地图对象改变。[S5；D 2090–2105]

首轮建筑候选来自已观察的基地周边、己方 footprint 与公开建造邻接规则；生产状态需已 Ready。可先直接提交局部检查后的放置请求，由实际放置和己方队列变化反馈结果，避免先搭完整布局 oracle。若采用原生 `canPlaceBuilding` 预检，须将其限制在协议覆盖的候选区域并记录为明确允许的查询；不能扫描隐藏区域后只返回一个“合法候选”而声称未泄漏。真实阻塞出现后，再验证工厂出口、矿车路线和该预检的观察边界。

## 3. 任务、意图与命令效果

首个实现只需一张任务表和一张未完成意图表，不需要独立调度服务。

- `Task`：本地 ID、目标/目标区域、分配对象、优先级、预算承诺、开始 tick、继续/退出条件。状态为 `proposed → active → fulfilled | abandoned | interrupted`；暂停可以保留在 active 的显式标记中。
- `Intent`：本地 ID、task_id、基于的 observation_seq/tick、动作种类、对象 refs、目标、预期后置条件、检查时限、可覆盖关系。
- 首轮动作集合：单次生产一项、放置已完成建筑、单对象展开、移动、攻击当前接触、AttackMove、显式 Stop；“保留当前行为”是**不提交新命令**。出售、维修、运输和特殊技能按近期失败再扩展。

意图经历 `proposed → locally_validated → submitted → effect_observed | superseded | unresolved_timeout`；提交异常另记 `submission_error`。`submitted` 仅表示调用经过了桥接层，不表示引擎已执行，更不表示任务完成。`effect_observed` 必须附带具体效果类别与观察证据；未看到效果不是“引擎拒绝”的同义词。

每个决策边界，同一己方对象只接受一个任务的单位命令，同一生产队列最多一次变更；冲突按优先级及已声明的稳定规则裁决。紧急接管使旧意图 `superseded` 并关联新意图。不要让战略模块、微操模块和异步回调分别绕过这张表下令。

预算预留只用于阻止己方规划重复承诺，不直接更改观察到的 credits。生产请求不是幂等操作：队列加一项可能被限量、拒绝，或在下一次观察前已经产出。超时不能盲目重发；先对照队列、己方新对象和已有提交记录。取消、暂停和放置的语义也不是从当前余额差可以完整还原的。[S3/S6]

| 请求 | 可支持的第一阶段效果证据 | 不能据此声称 |
| --- | --- | --- |
| QueueOne | 己方队列指定项数量/状态变化；或与请求相符的新己方对象出现 | 队列项出现等于完整造价已扣、单位已经形成战力 |
| PlaceReadyBuilding | 目标附近出现己方同类型建筑，队列 Ready 项变化；单独记录 buildStatus | `canPlaceBuilding=true` 等于实际已放置，或放置后出口/矿路畅通 |
| Deploy | 原己方对象状态变化，或对应建造场等后继对象出现 | 原对象消失必为展开成功；后继对象一定沿用相同 ID |
| Move / AttackMove | 位置随时间变化、接近目标或进入交战阶段，保留窗口与目标容差 | 一动就到达、直线距离变小就有完整可达路径 |
| AttackVisible | 接敌/伤害/己方攻击状态的可见变化，附时间窗口 | 单位移动就是 Attack 已执行；同一窗口敌方掉血必由该意图造成 |
| Stop / 不发新命令 | 原任务和位置的后续变化 | Stop、初始未下令、已有命令后不发新命令三者等价 |

当前 `OrderUnitsAction.validateOrders()` 在请求无效/不允许时会尝试其它命令，最后可能回退 Move；单位控制包也受 128 对象上限约束。`getUnitData().isIdle` 的实现只查询内部是否有 tasks。二者都要求效果记录避免“请求名 = 实际行为”的标签捷径。[S7/S8]

`ActionsApi.orderUnits` 会先入队 SelectUnits，再构造目标并入队 OrderUnits；一条逻辑命令往往有两个底层动作。公开方法没有追加 waypoint queue 参数，不能因回放 payload 中有 `queue` 字段就假定公开控制器可使用它。桥接层统一发送，保留两个底层动作的连续性，不让模块直接插入 SelectUnits。超过 128 对象显式拆组并记为多条命令，不能默许截断。[D 37–39、1071–1075；S7/S9]

目标坐标须在桥接层以显式 tagged union 区分 `none | tile | visible_entity`，不能用 truthiness 判断。提交前验证坐标域、目标当前观察资格、控制权与参数范围；此检查只用本次合法观察和固定地图域。不能用原生目标存在性查询探测旧敌方 ref。在已知底层方法有部分入队可能时，捕获异常并记录“可能部分提交”，不把失败当作对 API 队列的原子回滚。

## 4. 第一版 driver 的时间顺序

拟定首轮决策间隔为 3 个 simulation tick，作为可修改、需记录的起步值；不是最佳微操频率结论。两侧各自的频率、逻辑命令数、底层动作数和单位覆盖数都记录，不能用选择动作数量冒充玩家的有效操作数。

一个边界按以下顺序执行：

1. `createGame` 返回后取得初始快照；以后每次 `await game.update()` 返回后，先检查 runner 活跃状态、异常、`isFinished()`、tick 与预算。
2. 到决策边界时，从同一个游戏状态分别复制双方 observation，冻结字段；边界内没有 `update()` 与其它写世界操作。
3. 同步调用双方策略并仲裁意图；再按固定且记录的玩家批次顺序提交命令。此时世界状态尚未推进，但命令已进入队列；不让后一侧策略读取前一侧意图或提交记录。
4. 下次 `update()` 消费待执行命令并推进模拟；收集新的合法观察与裁判状态，再核验效果。通过实际 tick 前后值确认“下次”究竟对应的执行边界。

当前源码的 offline turn manager 先按玩家整理和处理动作，再调用 `game.update()`；`GameInstanceApi.update()` 在此后同步调用各 Bot 的 `onGameTick`。所以桥接回调在本方案中只登记边界/保存受控 API 句柄，不同时启动另一套自主决策循环；开始回调也不偷发首批命令。[S10/S11]

首次实现保持同步策略。以后需要异步推理时，driver 明确 await 结果并控制推进；不能把 `onGameTick` 改成 async 后指望 API 等待。推理任务只接收快照并返回意图，**没有 API 句柄**，完成 Promise 时不能自行下令或重新开启回调链。

每批结果携带 `run_epoch`、`observation_seq`、`based_on_tick`；应用前重新检查运行未结束、epoch 相同、当前 tick 与决策依据仍满足本轮协议、对象控制权和目标资格未失效。第一版规则是 tick 不匹配则丢弃整批并记录 stale，不默默改用最新隐藏状态修补。结果到达时若已超时、结束、发生错误或进入下一局，只丢弃，不发送动作；即使 Promise 无法真正取消，晚到结果也没有写游戏的路径。

若以后采用一边推进一边推理或 online 实时控制，需另写并验证延迟协议、过期动作处理和两侧公平预算。暂停 offline 模拟等待推理的运行吞吐不能冒充实时可部署性能。

## 5. run 记录与结束语义

最小持久化产物是一份 manifest、一条按 tick 可定位的决策/效果日志和回放；可在忽略目录 `runs/` 或仓库外。裁判日志与 actor 数据分开，run 标识只用于关联，不作为 actor 特征。

| 层 | 必要字段 |
| --- | --- |
| Manifest | run_id、代码版本/未提交差异、API/引擎/Node、依赖锁与资源/地图/规则标识；请求配置、录像记录配置、实际初始阵营/起点；观察/动作/终止协议版本；双方控制器版本；决策频率、批次顺序、模拟 tick/墙钟上限；随机源控制状态；回放和日志路径/哈希 |
| Decision | actor、observation_seq/tick、观察快照或可还原引用、局部记忆摘要/状态版本、task/intent ID、候选被仲裁的结果、策略耗时、逻辑命令及生成的底层动作计数 |
| Submission / Effect | 意图依据 tick、发送 tick、目标的观察时间、已发送/可能部分提交/未发送、异常类别、下一观察 tick、具体后置条件值、superseded/stale/timeout、证据仅来自合法观察还是裁判真值 |
| Stop record | 最后 tick、runner 停止原因、`isFinished` 信号、逐原始参赛者的 defeated 观察及来源、原始统计行、异常/日志证据、结果判定规则版本、`clean_completion_verified` 与其依据 |

请求参数可能被引擎规范化，例如资金、速度和初始单位数会 clamp；因此请求配置、回放中记录的配置和实际初始化状态分开记录。`PlayerStats.startLocation` 是位置索引，`PlayerData.startLocation` 是坐标；`credits` 是余额，不是总收入/净资产/分数；`PlayerStats.ai` 会把 external Bot 算作 AI，而 `PlayerData.isAi` 表示 integrated AI，不能互换。[D 1169–1200；S11/S12]

**`isFinished() === true` 不是正常完局证明。** 当前实现返回 `GameStatus.Ended OR turnManager.getErrorState()`；公开 `GameInstanceApi` 没有对应 endReason/error getter。`getPlayerStats()` 也没有 winner/result 字段，并会过滤 observer 行，所以保存初始 roster，不把统计行缺失解释成死亡或失败。[S11]

停止原因与观察结果分别记录：

- runner 上限 → `runner_limit`；策略异常 → `bot_error`；API 抛错 → `api_exception`，附出错边界。
- 仅收到 `isFinished` → `api_finished_unspecified`，不能改名为 `clean_end`。捕获明确错误日志可增加错误证据；没有错误日志不证明不存在 turn-manager error。
- 通过公开 `isPlayerDefeated(name)`/`getPlayerStats().defeated` 记录 `self_defeat_observed`、`opponent_defeat_observed`、`both_defeated_observed` 或 `outcome_unresolved`；这与停止原因是两个维度。
- 即使仅一侧 defeated，也不单独推出“干净正常结束且另一侧胜利”。当前公开证据不足时 `clean_completion_verified=false`；保存可观看录像供复核，复核或以后经过验证的结束遥测另记证据来源。

引擎胜负受 shortGame、基地车、运输中的对象、投降、盟友关系和内部结束检测影响；剩余单位数、余额或画面优势不能替代终局语义。[S13] 第一场技术试跑可以交付 `api_finished_unspecified + opponent_defeat_observed + replay`，并明确保留结束原因歧义；不要为此先扩建整套 fork 工程。要统计严格“正常完局胜率”时，再完成可靠的结束原因观察/复核路径，并由评估协议决定异常与未决项如何进入汇总；所有原始局都保留。

## 6. 无 MIX 探针与第一轮验证边界

### 已执行：仅参数方法 + mock

[probe_order_units.cjs](../analysis/probe_order_units.cjs) 接收发布 bundle 路径，首先核对现有 provenance 的 SHA-256 与长度，再在 VM 中执行从原文提取的 `orderUnits` 方法。mock 与 helper 在 VM 内创建，不暴露 host 对象、fs、require 或网络；关闭动态字符串/wasm 代码生成，设置 1 秒 timeout。没有导入完整发布包或复制 bundle。

运行方式：`node analysis/probe_order_units.cjs /path/to/game-api/dist/index.js`。JSON 输出可保存到 [order-units-probe.json](references/order-units-probe.json)。已保存记录为 `scope=mock-only`、`evidence_level=source-method-tested`，5 个案例预期与实际匹配：

| 输入 | 在声明 mock 下的实际分支 |
| --- | --- |
| tile `(3,4)` | SelectUnits + 有坐标目标的 OrderUnits |
| tile `(0,4)` | SelectUnits + 无目标的 OrderUnits |
| tile `(3,0)`，mock 对象 3 存在 | 被当作对象 ID 分支，目标是对象 3 的位置 `(8,9)` |
| 不存在的对象 999 | 只留下 SelectUnits，无 OrderUnits |
| mock 不存在的 tile `(3,999)` | SelectUnits 已排入后抛异常 |

这证明所提取方法在这些 mock 条件下的分支与部分入队现象；**不证明任何真实地图有有效的 0 坐标，也没有复现一场游戏中的控制 bug**。它没有执行 OrderUnitsAction、路径规划、战斗或终局。源码 hash 不匹配时探针拒绝执行，不自动适配未知版本。

### 接下来可做，尚未执行

不需要 MIX：从人工合法快照测试白名单复制/未知值、原生 ID/隐藏世界字段变化不进入 actor、实体引用一致重映射、同单位命令仲裁、生产去重、过期 Promise 的 epoch/tick 丢弃、可能部分提交的记录以及终止类别归并。这些只验证适配器与记录逻辑，不能验证游戏规则；只为即将实现的接口写必要案例，不先做庞大校验服务。

必须用真实引擎：单位/生产指令的处理和 fallback；同一 tick 玩家批次顺序的实际影响；无新命令/初始未下令/Stop；shroud 与特殊可见性；limbo 与己方 roster；建造后出口/采矿路线；实际 delay、回放一致性、结束原因与吞吐。首局选实际使用的少量动作验证，遇到明确失败再增加机制案例。

开始实施所需的文件可以很少：Bot/driver 桥接、纯数据观察适配、一个简单策略和日志出口。当前三个设计对象 Observation、Task/Intent、RunRecord 足够；暂不引入服务层、通用 schema 注册中心或训练运行器。

## 精确源码依据

D 指 [0.79.0 类型定义](https://unpkg.com/@chronodivide/game-api@0.79.0/dist/index.d.ts)，J 指 [0.79.0 发布 bundle](https://unpkg.com/@chronodivide/game-api@0.79.0/dist/index.js)。下表为 J 的从 0 开始字符偏移；固定字节身份以现有 provenance 为准。官方 [Playground](https://github.com/chronodivide/game-api-playground) 支持 headless 创建/推进/保存回放这条起步路径，不替代这些接口语义的验证。

| 标记 | J 搜索串与字符偏移 | 本文引用的内容 |
| --- | --- | --- |
| S1 | `getGameObjectData(t)`；879331 | 数据对象含嵌套引擎引用；全局/单位字段查询 |
| S2 | `getVisibleUnits(e,r`；878347 | shroud/归属过滤，而非完整人类观测语义 |
| S3 | `class ProductionApi`；886929 | queue 仅导出状态、数量和规则引用，没有完整进度 |
| S4 | `getOwnedObjects(e`；680899 | 默认排除 limbo；不能按对象消失计死亡 |
| S5 | `isTileBuildable(e`；706813 | 真正的地块占用与 shroud 建造检查 |
| S6 | `class UpdateQueueAction`；833442 | 生产请求条件、限量与取消；不同于纯记账 |
| S7 | `class OrderUnitsAction`；791380；`ORDER_UNIT_LIMIT=`；791359 | 无效指令 fallback 与 128 上限 |
| S8 | `isIdle:!e.unitOrderTrait`；881510 | isIdle 只检查有无内部 tasks |
| S9 | `orderUnits(t,i,r,s,a){`；863049 | Select + Order、目标分支与部分入队 |
| S10 | `class AiPlayTurnManager`；893914 | 消费动作后推进模拟 |
| S11 | `class GameInstanceApi`；933462 | 回调同步、结束信号合并、统计行与导出 |
| S12 | `class GameOptSanitizer`；853207 | 初始化选项规范化 |
| S13 | `checkGameEndConditions(){`；764280 | 胜负/shortGame/运输与清理逻辑 |

本表中的最终定位由编制时的本地固定 bundle 校对；不是另一个引擎版本的行号。
