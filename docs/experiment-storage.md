# 实验数据保存

2026-09-21盘点发现，实验任务目录约108 GiB，决策日志约102 GiB，是主要增长来源。本次持续控制批次约57 GiB；单局日志中位6.2 MiB、95分位22.5 MiB、最大52.1 MiB。压缩直接解决已测量的空间问题，不删历史策略的失败证据，也不改采样或胜负规则。

## 当前做法

- 新`analysis/launch_batch.py`在每个子进程已结束、单局完成标记写入后立即压缩日志，其他工人继续比赛；整批结束再补齐旧收据。完整/未决/错误结果分别保存。模型、优化器状态、划分清单、版本、结果和回放保持原样。
- 只处理有`batch.json`、完整`summary.json`及逐局`batch-row.json`的记录。未完成/中止批次不自动整理。不要对仍在写入的实验手动归档。
- 新源码默认使用Zstandard level 6，并逐字节解压重算SHA-256与大小；确认原文件未变后，写入压缩文件及`decisions.ndjson.archive.json`，再去掉冗余的明文。没有抽样、丢列或删除对局。历史gzip仍可读；转码也必须与原收据的SHA和大小一致。
- 当前训练器、生产分析和`encounter.ts`可直接读取`.ndjson.zst`与`.ndjson.gz`。冻结历史源码保持不变，需要原文件时用下面的`restore`命令；恢复会校验原始SHA，保留压缩副本。**不要转码仍被旧训练器读取的数据，先完成该任务；新任务冻结包含新读取器的源码。**
- 开跑前预估活跃原文及全部待生成压缩包，并额外保留50 GiB。完整战略计划使用192 MiB/活跃原文与16 MiB/未来压缩包；这仍是容量预估，不是任意未来策略的数据上限。旧的整批归档方式继续按全部剩余原文估算。每批重新检查空间，不按磁盘百分比单独放行。

```sh
# 在训练Python环境中安装固定依赖；Node 26使用内置解码器。
uv pip install --python /path/to/training/python -r analysis/storage-requirements.txt
python3 analysis/experiment_storage.py compact /path/to/completed-jobs --workers 8
python3 analysis/experiment_storage.py restore /path/to/one-needed-batch --workers 4
# 必须供旧读取器直接使用时，可明确输出gzip。
python3 analysis/experiment_storage.py compact /path/to/completed-jobs --codec gzip --level 3
```

`storage-report.json`记录文件数、原始/压缩字节数和时间。任务路径、原始数据、检查点和回放留在私有工作目录，不进入Git。暂不做按年龄永久删除；待有长期数据增长证据，再决定是否需要更强的保留策略。

## 验证

四条路线各一份真实教师局，压缩前后训练器读出的完整episode逐项一致。压缩日志的选定完整回放重放匹配96/96原单位快照、终局和资金。测试覆盖无损恢复、损坏拒绝、跳过未完成批次及整批容量预估；不把磁盘压缩比例当作采样性能收益。


## 本次整理结果

归档已完成：19,458份已完成对局日志从101.49 GiB降至9.45 GiB，减少92.04 GiB（90.7%）。服务器剩余空间由约325 GiB增至417 GiB。逐文件无损校验通过；未完整批次继续保留明文。

## 2026-09-24：完整战略日志的压缩比较

新压力策略192局原始日志9.31 GiB、gzip后1.64 GiB，平均约8.8 MiB/局。持续多日采样会明显消耗剩余磁盘，因此用其中按文件大小0/25/50/75/95/100分位选择的六局做同字节比较：

| 编码 | 六局压缩大小 | 压缩CPU秒 | 解压并校验CPU秒 |
|---|---:|---:|---:|
| gzip level 3 | 79.64 MiB | 4.40 | 1.36 |
| zstd level 3 | 21.37 MiB | 0.83 | 0.52 |
| zstd level 6 | 16.12 MiB | 1.84 | 0.47 |

相同原文455.56 MiB，全部解压SHA/大小匹配。选择level 6：在这组六局中比原gzip少占79.8%空间，压缩CPU耗时也较低；不是游戏采样吞吐或所有工作负载的普遍倍速声明。运行时有其他训练负载，因此记录进程CPU时间，原始表保存在私有`work/commander-coordination-20260924/storage-benchmark.json`。

Python依赖固定`zstandard==0.25.0`，[流式接口](https://python-zstandard.readthedocs.io/en/latest/compressor.html)；Node沿[内置zstd接口](https://nodejs.org/api/zlib.html#class-zlibzstdcompress)。机制检查覆盖两种格式读取、旧gzip转码、损坏拒绝、恢复、跳过未完整批次和空间预算。现有冻结训练仍按原格式运行，没有热改在用文件。
