# 无需客户端的对局短片

2026-09-18 按用户同意制作第一版样片，并持续推进到公开分享。精选素材现已上线：[观看页](https://neapolitanicecream.github.io/warbook/0.1.11/) · [Release 素材包](https://github.com/NeapolitanIcecream/warbook/releases/tag/v0.1.11)。

## 当前展示约定

用户看过首版后要求至少 4×，并取消所有添加的文字说明。当前默认 `playbackRate: 4`；从原回放重新录制完整游戏画面，移除标题条、字幕和自制时钟，原生游戏界面保留。录制源仍按每秒 15 tick 运行，FFmpeg 用 `setpts` 做 4× 输出，不改变对局指令；每段 50 秒游戏时间对应约 12.5 秒视频。编码器拒绝旧的带字录制，也拒绝低于 4× 的展示配置。

新版文件为 `defense-4x.mp4`、`counterattack-4x.mp4`、`preview-4x.gif`。短片页只保留版本、片段名称、速度、时长和下载控件。新文件名使浏览器不会继续显示上一次的带字素材。原来的 MP4/GIF 下载路径也已同步为新版。两段均实测 12.5 秒、1280×720、30 fps，文件分别为 2,251,818 / 2,244,744 字节；GIF 为 8 秒、2,610,411 字节。已检查成片无添加文字、无黑帧，并核对 HTTP 文件哈希；浏览器中两段均正常播完 12.5 秒。

## 公开入口已上线

- 固定版本观看页：<https://neapolitanicecream.github.io/warbook/0.1.11/>；项目入口 <https://neapolitanicecream.github.io/warbook/> 指向当前版本。页面无需登录，也不加载游戏客户端。
- 首次发布来源 `88dc03b`，[Actions 运行 35325563166](https://github.com/NeapolitanIcecream/warbook/actions/runs/35325563166) 成功。Pages 强制 HTTPS。公开 Release 包的 GitHub SHA-256 与本地发布包一致。
- 未附带认证信息的 HTTP 检查：入口与七份精选文件均返回 200、哈希一致；两份 MP4 的 Range 请求均返回 206 与正确字节范围。原始回放和 GIF 的下载内容也一致。
- 公开页中两段视频均实际播放至 12.5 秒结束，无媒体错误；防守视频跳转到 8.41 秒并暂停成功。390×844 的浏览器视口下，页面宽度为 390，没有横向溢出；这属于窄屏浏览器检查，不冒充各种真实手机或地区网络的覆盖。
- 发布清单在 [publications.json](../showcase/publications.json)，[构建脚本](../scripts/build-showcase-site.py) 从公开 Release 下载并检查哈希，仅提取清单内文件；[Pages 工作流](../.github/workflows/showcase-pages.yml) 发布独立 `_site` artifact。官方 Actions 固定到已核对的提交。没有把素材提交到源码 Git 历史，也没有上传本地配置、MIX、原始 WebM 或运行日志。
- 后续先验证并上传新的精选 Release 包，再更新发布清单及 `latest`，旧版本目录保留。修改发布清单或发布脚本会重新部署，也支持手动运行工作流；普通 AI 代码或文档提交不会触发。机器验收记录在 `work/showcase-publish/publication-check.json`。

## 远端呈现准备（历史）

以下为公开部署前的准备记录。按用户“研究如何在远端呈现”的要求，选择 **GitHub Pages 展示 + Release 素材归档**。当时通过仓库 API 核对：`NeapolitanIcecream/warbook` 为公开仓库，Actions 可用，Pages 尚未启用，也尚无 GitHub Release；已有 Git 标签不等同于已创建 Release。

- 本地页面及其引用一共七份精选文件：HTML、两份 MP4、两张封面、GIF、完整 `.rpl`，合计 **8,062,633 字节**。全部引用为相对路径，不依赖 localhost、游戏客户端、Node 服务或游戏素材。
- 已在忽略目录准备 `work/showcase-publish/warbook-showcase-0.1.11-4x.zip`，**7,978,534 字节**，SHA-256 `5df7f58f88dc836675a97728b3f7a61fa8d476c3223cfb49eccca7256150469e`。包内为版本目录、入口、`.nojekyll` 和校验清单；逐项校验解压内容与原文件哈希一致。未纳入原始 WebM、运行日志、capture.json、本地配置和游戏资源；MP4 标签中也没有本地路径。
- 拟将这个精选包作为对应 Release 的附件，Actions 下载并核对哈希后，把包内的静态内容作为 Pages artifact 发布。媒体不进入源码 Git 历史。保留版本路径，README 链接到公开短片页；页面继续使用 4×、无添加文字的素材。
- GitHub 官方当前提供公开仓库的 Pages；站点上限 1 GB，月带宽软上限 100 GB，当前材料规模适合阶段展示。来源：[Pages 限额](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)、[Actions 发布流程](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

本次只检查条件、准备发布包和确定方案，没有创建远端站点、Release 或部署工作流。公开 HTTPS 下的视频播放、Range 拖动和外部网络可达性需在实际部署后验证，不能将本地播放验收当作远端验收。

## 首版样片（历史，已替换）

来源：`runs/closure-release-pool/mp06t2.map/supalosa/0-closure-candidate`，0.1.11 对 Supalosa 的 16:54 胜局；原回放 SHA-256 `714f627444033ca32dcc1a47ffaca4eadb65560692a724162a18f0187b07a6a8`。该原回放已有 102 份快照和终局核对。

| 短片 | 游戏时间 | 视频时长 | 大小 | 看点 |
| --- | --- | --- | --- | --- |
| defense.mp4 | 6:15–7:05 | 49.93 秒 | 6.2 MB | 步兵接敌、坦克支援，以及没能保住电厂 |
| counterattack.mp4 | 8:35–9:25 | 49.97 秒 | 8.3 MB | 四车接战、损失一车、攻击建筑 |
| preview.gif | 防守片段中八秒 | 8 秒 | 1.4 MB | 640 像素宽的循环预览 |

输出目录 `runs/showcase/0.1.11/`，包含 MP4、封面、动图、完整 `.rpl`、无脚本 HTML 页面和媒体哈希。浏览器原始 WebM 与 capture.json 也保存在该目录；分享时只需选 MP4，或 HTML 页面及其引用的 MP4/封面/动图/回放。录像和游戏资源没有纳入 Git。

本地入口：[观看短片](http://127.0.0.1:8642/showcase/0.1.11/)。MP4 为 H.264 / yuv420p、1280×720、30 fps、无声，两个文件均低于 10 MB。不是自动选择精彩片段的系统：第一版通过 [机位脚本](../showcase/0.1.11.json) 指定时间和地图位置，镜头在控制点之间平滑移动；首版字幕曾按实际事件切换，现已按用户要求完全移除。

## 首版制作与检查

- 使用固定客户端的 `MapPanningHelper` 与 `cameraPan.setPan`，只移动渲染镜头；从真实游戏画布经标准 `captureStream` / `MediaRecorder` 录制，不捕获桌面或麦克风。录制速度是每秒 15 个模拟 tick，与画面游戏时钟一致。
- 在 renderer 完成绘制后复制画布，避免 WebGL 缓冲清空造成黑帧。录制页要求固定 1280×720，尺寸改变则拒绝完成；摄制完成后暂停，关闭页面时释放摄制轨道和监听器。
- 实际开始/结束 tick 分别为 5625/6375、7725/8475；墙钟 50.000 / 50.027 秒，记录期间最大绘制间隔 20.23 / 14.34 毫秒。转码后格式、时长、大小与全片无黑屏检查通过。取帧核对取景、字幕与坦克/电厂损失，浏览器播放器已通过进入、播放、跳转与暂停检查，反击片段完整播放至结束。
- 内置浏览器首次通过无名称的原生控件 AX 动作启动播放时页面崩溃；同一 MP4 在新页面使用可见鼠标控件正常播放，视频元素无错误，防守段可跳到 33.65 秒并暂停，反击段完整播到 49.97 秒。未据此误判文件编码损坏或增加无依据的格式兼容层。
- 第一份防守草稿在 6:30 就写“步兵部署开火”；原观察显示该时刻己方 GI 尚未部署，6:40 才有部署记录。已改为“正在靠拢”并重新录制。编码工具检查机位脚本与实际摄制记录相同，避免修改文字后误用旧视频。
- `scripts/encode-showcase.ts` 用本机 FFmpeg 转 H.264 并生成封面/动图；没有新增 npm 依赖、策略变化或新对局。原 `.rpl` 哈希保持一致。首版验收摘要保留在 `work/share-replay/media-validation.json`，旧带字成片移存 `work/share-replay/with-text/`。`runs/showcase/0.1.11/*.capture.json` 和 `media.json` 随重录更新，当前四倍速验证在 `work/share-replay/plain-4x-validation.json`。

## 再次制作

1. `npm run player:build`，取返回的 GUI 包哈希。
2. 用该哈希设置 `PLAYER_RELEASE`，用机位脚本设置 `REPLAY_CLIP_PLAN`，用上述原局 `result.json` 设置 `WATCH_MATCH`，在临时端口启动玩家服务。服务会拒绝与所选回放哈希不符的脚本。
3. 打开临时服务的 `/watch`，固定录制视口，点击对应“录制”按钮。录制控件只在明确配置 `REPLAY_CLIP_PLAN` 的服务出现。
4. 执行 `npm run showcase:encode -- showcase/0.1.11.json`，检查视频和页面。保存端点限定本机同源与脚本内的片段 ID；普通维护入口不启用录像上传。
5. 关闭临时游戏页面、恢复测试视口、停止临时服务。维护入口提供静态短片页面，观看短片不启动游戏实例。

后续若要减少挑片和机位工作，再从已有交火/损失摘要生成镜头脚本；当前两段已经能用于检验画面是否讲清楚战斗，无需先构建全自动热点评分系统。
