# 公开真人回放：已完成的无资源解析探针

日期：2026-09-15。**已实际下载两份公开 replay，并由固定 API 0.79.0 的 `Replay.parse` 成功解析；没有调用 `cdapi.init`、`loadReplay` 或运行游戏。** 这是可用数据的第一项实物证据，不是回放仿真兼容通过，也不是已获得训练集。

## 来源与选择

通过官方天梯页面的公开历史与 CDN 取得两个样本，访问路径及来源固定信息见 [生态调查](opponents-and-data.md)。两者来自同一历史，是方便取得的可用性探针，不能代表整体水平、打法或地图分布；已经审阅，不能算最终未知测试。实际响应可混合 1v1 与团队赛，后续采集要检查参与者、ladderType、观察者和规则。

原始文件只保留在忽略目录 `work/ecosystem/ladder/`；Git 记录公开 URL、字节数、哈希及不含玩家姓名/聊天正文的聚合解析结果。

| 样本 | 字节 | 地图标识 / digest | 事件数 | 尝试动作数 |
| --- | ---: | --- | ---: | ---: |
| [0c82f0d5…](https://replays-eu.chronodivide.com/0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0.rpl) | 51,437 | `4_jungle_of_vietnam_le.map` / `cde0988d` | 992 | 2,107 |
| [639963f0…](https://replays-eu.chronodivide.com/639963f0-7654-4a85-a02d-b5f8d6aa20d3.rpl) | 34,679 | `mp01t4.map` / `bc957ed8` | 768 | 1,614 |

两份 `engineVersion` 均为 `0.84`、`modHash` 均为 `4146105410`，各有两个 humanPlayers、零个非空 internal-AI 项。第二份含 7 个聊天事件，只记录数量。详细 JSON 见 [replay-parse-probe.json](references/replay-parse-probe.json)。这些标记仍需与实际本地资源/地图匹配；文件可解码不证明可仿真。

## 解析直接暴露的三个数据陷阱

1. `aiPlayers.length` 为 7，但都是空占位，不能据此说有 7 个 AI。已阅 `loadReplay` 实现检查的是非空项，本探针分开记录槽记录数与非空项数。
2. 3,721 条动作中包含 1,477 条 `NoAction` 与 926 条 `SelectUnits`。总事件/动作数不等于有效策略决策数、有效命令数或 APM。选择动作与后续指令有关，不能将所有条目当作独立战术样本。
3. 两份真实录像均为 gameSpeed=6、unitCount=0、superWeapons=true；它们与首场工程试跑参考的官方示例选项不同。不能在没有规则标记与分层的情况下混入同一评估分布。这里仅证明这些选项出现在样本中，不推断其为统一天梯规范。

`ResignGame` 等动作仍是记录输入；观察、命令合法性、实际效果与终局裁决要由仿真或其他可信证据重建。`endTick` 是记录字段，也不是 wall-clock 吞吐或独立赢家证明。

## 已验证与未验证

| 状态 | 内容 |
| --- | --- |
| 已执行 | 公开文件取得及 SHA-256；发布包五项文件与既有审计哈希一致；官方 parser 接受两份真实输入；事件/动作聚合计数自洽 |
| 已记录 | Node v26.5.0、解析依赖锁文件、回放 engine/mod/map 标记与初始选项 |
| 未执行 | 初始化 MIX、地图加载、`loadReplay`、逐 turn 重模拟、观察重建、指令效果、回放一致性、任何 bot 对局或训练 |

下一项数据验证应是：运行本地完整对局并重播自己的录像；随后在资源匹配时逐步仿真这里的公开样本。精确匹配失败时记录哪一层失败，不通过改写 header 强行“兼容”。尚无兼容示范也不阻塞自有基线产生正常对局数据。

## 复现

解析依赖只属于分析探针，在忽略目录安装；主项目没有 bot 的依赖配置。已保存 [分析 package.json](../analysis/replay-parser/package.json) 和 [完整锁文件](../analysis/replay-parser/package-lock.json)。锁文件中的依赖可用性仍受外部 registry 影响。

在仓库根目录依次执行：

```sh
mkdir -p work/replay-parser work/ecosystem/ladder
cp analysis/replay-parser/package.json analysis/replay-parser/package-lock.json work/replay-parser/
npm ci --prefix work/replay-parser --ignore-scripts --no-audit --no-fund
curl --fail --location --output work/ecosystem/ladder/0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0.rpl https://replays-eu.chronodivide.com/0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0.rpl
curl --fail --location --output work/ecosystem/ladder/639963f0-7654-4a85-a02d-b5f8d6aa20d3.rpl https://replays-eu.chronodivide.com/639963f0-7654-4a85-a02d-b5f8d6aa20d3.rpl
node analysis/probe_replays.cjs work/replay-parser/node_modules/@chronodivide/game-api work/ecosystem/ladder/0c82f0d5-cd5b-4f90-b3db-3d2c4aa93aa0.rpl work/ecosystem/ladder/639963f0-7654-4a85-a02d-b5f8d6aa20d3.rpl
```

[脚本](../analysis/probe_replays.cjs) 会核对 API 发布文件及安装锁文件，并校验上述两个已知公开样本的固定哈希，然后解析本地输入并重写聚合报告。已知样本内容改变时会拒绝；其他本地输入的来源标为 caller-supplied，不自动生成公开来源声明。脚本不会下载文件、初始化资源或提取聊天正文。
