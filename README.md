<p align="center">
  <img src="assets/icon.svg" width="112" alt="转音 图标">
</p>

<h1 align="center">转音（zhuanyin）</h1>

<p align="center">把录音拖进来，就得到带时间轴的中文逐字稿 —— <strong>音频不出本机</strong>。</p>

<p align="center">
  <a href="https://github.com/FizzLabs/zhuanyin-desktop/actions/workflows/ci.yml"><img src="https://github.com/FizzLabs/zhuanyin-desktop/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

## 它能做什么

- **装上就能用**：引擎与音频解码都编译进了应用，不需要装 Python、不需要装 ffmpeg。第一次打开跟着三步引导下载一个模型即可
- **拖拽即转**：m4a / mp3 / wav / aiff / flac / ogg 等格式直接拖进窗口，解码与重采样在进程内完成
- **批量排队**：一次丢多个文件，串行执行（模型占内存与显存，并行只会互相拖慢）
- **逐字稿与时间轴联动**：点某一段跳到对应播放位置，播放时当前段自动高亮并滚进视野；支持 1× / 1.25× / 1.5× / 2× 倍速
- **一个任务一个文件夹**：产物收进与音频同名的文件夹（`txt` 逐字稿、`srt` / `vtt` 字幕、`json` 结构化段落），也可以自选输出位置
- **边转边出字**：识别出的段落实时推送，不用等整个文件转完
- **历史留存**：转写结果（含分段与时间轴）落进本地数据库，关掉应用再打开仍然能点段落跳播放
- **语言可选**：默认自动检测，也可以指定中文 / 粤语 / English 等，或填一段初始提示词

## 快速开始

### 装上并打开

从 [Releases](https://github.com/FizzLabs/zhuanyin-desktop/releases) 下载 DMG，把「转音」拖进「应用程序」。

```bash
pnpm install
pnpm tauri:dev        # 开发态直接起

pnpm dist             # 一步产出可安装的 DMG：dist-release/转音_<版本>_arm64.dmg
```

`pnpm dist` 会先构建、再打成 DMG 并**挂载校验**：确认里面有 `转音.app`，也有一个指向 `/Applications` 的快捷方式 —— 用户双击 DMG、把「转音」拖进去就装好了。只想要 `.app` 的话用 `pnpm tauri:build`。

### 第一次使用：跟着引导走三步

打开应用会自动进入引导页（欢迎 → 选择模型 → 完成），**不需要开终端**。第二步就是下载模型：

> 引导只在「一个模型都没有」时出现；已经装过模型的用户直接进主界面。想再看一遍可以从「设置 → 关于 → 重新打开引导」。

下面是完整清单，可以按体积和用途挑：

| 模型 | 体积 | 说明 |
|---|---|---|
| **Large v3 Turbo · Q5_0** | 574 MB | 推荐。速度与准确率最平衡，中英文混说表现稳定 |
| Large v3 Turbo · Q8_0 | 874 MB | 在 turbo 上再提一档精度 |
| Large v3 · Q5_0 | 1.03 GB | 非蒸馏版，长录音与口音较重时更稳 |
| Large v3 Turbo · F16 | 1.55 GB | 未量化原始权重，精度最高 |
| Medium · Q5_0 | 514 MB | 上一代中档，准确率低于 large |
| Small · Q8_0 | 252 MB | 轻量选择，可接受精度下降时用 |
| Base · Q5_1 / Tiny · Q5_1 | 57 MB / 31 MB | 只用来快速验证链路 |

模型来自 [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) 的官方 ggml 权重：

- **sha256 是唯一信任锚**：每个模型的哈希编译在应用里（取自上游 Hugging Face 的 LFS oid），下载后逐字节校验，对不上就删掉重下
- **镜像优先**：默认走 `hf-mirror.com`，失败再回退 `huggingface.co`。国内直连上游会静默停滞，所以镜像排在前面
- **断点续传**：中途断网会保留已下载的部分，下次接着下；30 秒收不到字节判定为该源不可用，自动换源重试
- **已经有模型也不浪费**：模型目录里已有的 `ggml-*.bin` 会被直接识别为「已下载」，也可以用「导入已有模型」选一个文件（同卷走硬链接，不复制几百 MB）

模型默认放在 `~/Library/Application Support/com.imddc.zhuanyin/models`，界面上「模型目录」按钮可以直接打开。

### 用起来

把音频文件拖进窗口 → 在队列里看进度（可以随时取消）→ 转完点逐字稿任意一段就能跳到那个时间点听 → 产物收在同名文件夹里，用编辑器或播放器直接打开。

## 常见问题

**模型下载失败或很慢怎么办？**
默认已经走国内镜像。失败会自动重试并换源。也可以自己用浏览器下好 `ggml-*.bin`，再用「导入已有模型」选进来。

**产物在哪？**
每个任务输出**一个与音频同名的文件夹**，里面是同名的四份：`.txt`、`.srt`、`.vtt`、`.json`。默认放在音频所在目录，界面「设置」里可以选择别的目录（选择结果会记住）。点「在访达中显示」会直接带你过去。

**支持什么格式？**
m4a / aac / mp3 / wav / aiff / flac / caf / alac / ogg(vorbis) 等，由内置的纯 Rust 解码器处理。opus 与 wma 暂不支持。

**要等多久？**
本机实测（M1 Pro，Large v3 Turbo Q5_0，Metal）：39.5 秒音频推理 3.3 秒，约 **12 倍实时**，整个进程 4.1 秒（含模型加载 0.27 秒），1 小时录音大约 5 分钟。

**装好之后第一次转写明显更慢？**
正常。Metal 着色器在首次运行时编译并缓存，那一次会多花约 10 秒；此后的每次转写都回到 4 秒上下（同样的音频实测 13.9 秒 → 4.1 秒）。

**能换模型吗？**
能，随时在「模型」页切换；再次转写时会自动重新加载。切换模型不需要重启应用。

**关掉应用后逐字稿还在吗？**
在。完成的任务会写进本地 SQLite（文本 + 分段 + 时间轴 + 产物路径），「历史」页里点开即可恢复逐字稿与播放联动。

**中英混说时英文术语偶尔识别不准？**
模型对非母语术语本来就弱。**不要在提示词里堆术语表** —— 实测那样会让模型复读提示词并在结尾打转。要偏向专有名词时，只写一句自然语言短句。「设置」里可以直接填这段提示词。

**必须 Apple Silicon 吗？**
当前的发布产物是 macOS arm64。换成 Rust 原生 whisper.cpp 之后，引擎层面已经不再有 Apple 芯片的硬性约束（Intel Mac 与其它平台在引擎侧是可行的），但发布链路目前只构建 arm64；要扩平台需要改 `release.yml` 的矩阵并各自验证。

## 已知边界

- **不做说话人分离**：whisper 只出文字与时间轴，分不清谁在说。面试复盘通常够用（两人音色差异明显）
- **不做实时听写**：这是文件级转写
- **不做静音裁剪**：whisper.cpp 自带 VAD 能力，但目前没有启用；长录音里的静音段仍会参与识别（既费时间，也是幻觉高发区）
- **只发 macOS arm64**：见上一条
- **必须下载模型**：模型不随包分发（最小的 Tiny 也要 31 MB）。这是体积与合法性上的取舍，不是遗漏

---

## 开发

技术栈：Tauri 2（Rust 外壳）+ React 19 + TypeScript + Vite；识别引擎是 **Rust 原生 whisper.cpp**（`whisper-rs`，Metal 加速）。

| 依赖 | 说明 |
|---|---|
| Rust | 1.77+，构建期需要 `cmake`（`whisper-rs-sys` 用它编译 whisper.cpp） |
| Node | 20+，pnpm 12 |
| 运行环境 | macOS 11+；发布产物为 arm64 |

**没有运行期外部依赖** —— 不需要 Python、mlx-whisper、ffmpeg 或任何命令行工具。构建期唯一新增的是 `cmake`（GitHub 的 macOS runner 自带）。

### 常用命令

```bash
pnpm install          # 装前端依赖
pnpm test             # 前端单测（68 个）
pnpm typecheck        # 类型检查
pnpm build            # 前端构建
pnpm lint             # Oxlint
pnpm format:check     # Oxfmt 只读检查

pnpm tauri:dev        # 开发态启动桌面应用
pnpm tauri:build      # 打包 转音.app（产物在 src-tauri/target/<profile>/bundle/macos/）
pnpm package:macos    # 把已构建的 .app 打成可安装的 DMG（含 Applications 快捷方式）
pnpm dist             # = tauri:build + package:macos，一步拿到安装包

./scripts/verify-engine.sh   # 只验引擎链路：音频 → 解码 → 识别 → 四种产物
./scripts/verify.sh          # 端到端验收：引擎链路 + 前端单测 + Rust 单测 + fmt/clippy
```

### 无头模式（脚本化批量转写）

同一个可执行文件带一个无头入口，走的是**与界面完全相同的引擎路径**：

```bash
# 下载模型（与界面里的下载是同一条实现，含续传、换源与 sha256 校验）
./src-tauri/target/release/zhuanyin --download-model large-v3-turbo-q5_0

# 用模型 id（在模型目录里找）
./src-tauri/target/release/zhuanyin --transcribe 会议.m4a --model large-v3-turbo-q5_0 --language zh

# 用模型文件路径，且输出 JSON 供脚本消费
./src-tauri/target/release/zhuanyin --transcribe 会议.m4a --model /path/to/ggml-large-v3-turbo-q5_0.bin --json
```

它同时是验收脚本的支点：`scripts/verify-engine.sh` 用它跑真实的 aiff（PCM）与 m4a（AAC）用例，断言四种产物、srt 时间轴格式、vtt 头与 json 结构。**验收的就是界面里那条路**，不是另写一套近似逻辑。模型下载也一样：`--download-model` 调的就是界面那个下载器。

### CI 与发布

**CI 只跑前端**：推 PR 或合进 `main` 时，`ci.yml` 在 `ubuntu-latest` 上跑 `pnpm lint` / `format:check` / `typecheck` / `test`。

**Rust 检查只在本地跑**（`cargo fmt --all --check` / `cargo clippy --all-targets -D warnings` / `cargo test`）。它原本也挂在 CI 上，但那是唯一需要 macOS runner 的 job（whisper.cpp 的 Metal 后端得在 macOS 上编译），一次约 1 分钟，而 macOS runner 的计费约为 Linux 的十倍 —— 权衡下来不值得，改为本机把关。

所以 **`./scripts/verify.sh` 是唯一的验收入口**，提交前必须跑：

```
$ ./scripts/verify.sh
✓ 引擎链路通过：无 Python、无 ffmpeg，aiff 与 m4a 均产出四种格式且结构正确
Found 0 warnings and 0 errors.          # oxlint
      Tests  86 passed (86)             # vitest
test result: ok. 46 passed; ...          # cargo test
✓ 端到端验收通过
```

它同时覆盖引擎链路验收（需要一个已下载的模型，最小 31 MB，实测用的 574 MB）—— 这部分从来不在 CI 里，因为 runner 上不该为它拉几百 MB。

代价说明：Rust 改动不再有服务端兜底，一旦本地漏跑就是坏代码进 `main`。`release.yml` 在打标签时会完整构建一次，能兜住「编译不过」，但兜不住 clippy 与单测。

发布：打 `v*` 标签即触发 `release.yml` —— 在 arm64 runner 上构建、用 `scripts/package-macos.sh` 打包成 **DMG**（附 `SHA256SUMS.txt`；DMG 建不出来时回落 zip）并发布 Release；也可以手动触发（需 workflow 已在默认分支），只产出 artifact 不发版。

> **关于 DMG**：默认打包目标只有 `app`。Tauri 的 `--bundles dmg` 会调 `bundle_dmg.sh`，它要靠 Finder 会话摆窗口布局，在非 GUI 会话里会失败（本机实测报 `error running bundle_dmg.sh`）。发布改用 `scripts/package-macos.sh`：绕开那一步，用 `hdiutil` 直接建普通 DMG 并**挂载校验**，建不出来（例如沙箱限制）才回落到 zip。

## 架构

```
转音.app
├── Rust 侧（src-tauri/src/）
│   ├── audio.rs    纯 Rust 解码（symphonia）+ 重采样到 16k 单声道（rubato）
│   ├── engine.rs   whisper.cpp 常驻上下文 + 转写编排 + 无头模式
│   ├── models.rs   模型清单与下载器（续传 / sha256 / 停滞看门狗 / 换源）
│   ├── windows.rs  两个窗口的创建与切换（引导窗口 / 工作区窗口）
│   ├── history.rs  SQLite 历史（文本 + 分段 + 时间轴 + 产物路径）
│   ├── output.rs   txt / srt / vtt / json 写出
│   └── catalog.json 模型清单（编译进二进制，sha256 取自上游官方值）
├── React 前端（src/）
│   ├── App.tsx                      外壳：跨页面共享状态（队列/模型/历史/播放）
│   ├── OnboardingWindow.tsx         引导窗口的根组件（按窗口 label 分派）
│   ├── components/Sidebar.tsx       左侧导航（转写 / 模型 / 历史 / 设置）
│   ├── components/Onboarding.tsx    首次使用的三步引导
│   ├── pages/                       四个页面，各自只负责摆放与转调
│   ├── hooks/useTranscribeQueue.ts  队列驱动 + 事件订阅（串行、本地生成任务号）
│   ├── hooks/useModels.ts           模型清单、下载进度与校验状态
│   ├── hooks/useHistory.ts          历史列表与恢复
│   └── lib/queue.ts                 纯状态迁移（可单测）
└── 无头入口          同一二进制：--transcribe / --download-model（验收与脚本化共用）
```

### 界面结构

四个页面用左侧导航切换，转写页再分成「队列」与「逐字稿 + 播放条」两栏：

- **转写**：拖入音频、看队列与实时逐字稿，点段落跳播放
- **模型**：下载 / 切换 / 删除 / 导入模型；下载中显示进度，校验时显示「校验中」
- **历史**：每次转写的结果（含分段与时间轴），点开即可恢复逐字稿与播放联动
- **设置**：输出位置、语言与提示词、关于（含「重新打开引导」）

**首次使用是一个独立窗口**：没有可用模型时，应用只打开引导窗口（欢迎 → 选择模型 → 完成），
主窗口此时**根本不存在**；模型就绪、用户点「开始使用」之后才创建主窗口并关掉引导窗口。

两者是不同性质的东西：一个是「设置向导」（窗口小、可关闭、关掉就意味着放弃），
一个是「工作区」（窗口大、要长期开着）。用一个窗口靠覆盖层切换，会让主窗口在引导阶段
白白存在并跑着一整套界面逻辑。设置页里的「重新打开引导」会把这个窗口再开出来。

**顶部没有常驻状态条** —— 引擎状态压缩成侧边栏底部的一行，那块纵向空间留给内容。

### 视觉与主题

配色集中在 `src/styles.css` 顶部的 `:root`，**token 块之外不允许出现硬编码颜色**（语义色的柔和底与描边也各有一个 token，例如 `--accent-soft` / `--accent-border`）。

改颜色前请先拿对比度验一遍，两条硬约束：

- **最低一级文本（`--text-3`）在最亮的表面（`--surface-3`）上也要 ≥ 4.5:1**（WCAG AA）。它用在大量提示与次要信息上，最容易在调色时被牺牲掉
- **整体亮度不能退回**：当前背景与面板的相对亮度为 1.39% / 2.22%–5.04%。早先那版是 0.55% / 1.00%–2.44%，在白天几乎看不清

背景另有一层模糊光晕（`body::before` 的几块柔光），给平涂的深色底一点空气感。

**为什么是「Rust 原生 whisper.cpp」而不是复用本机引擎**：之前那版是薄壳 —— 复用本机已装的 mlx-whisper，代价是用户必须自己装 uv、引擎、1.5 GB 模型与 ffmpeg，缺一项就不能用。「开箱即用」要求把引擎与解码都放进应用：`whisper.cpp` 的 Metal 内核是**内嵌进二进制**的，所以换掉 MLX 之后整个可执行文件只有约 20 MB（MLX 光 `mlx.metallib` 就 187 MB，不可剥离）。

顺带解决的三件事：进度与取消不再靠正则解析子进程的 stdout，而是 whisper.cpp 的原生回调；模型上下文常驻内存，连续转写不会反复付加载成本；解码在进程内完成，`ffmpeg` 不再是前置条件。

### 事件契约

前端只认事件与命令，Rust 侧负责推送：

```
asr://meta       { jobId, name, source, duration, modelId, modelName, language, sourceRate, sourceChannels }
asr://segment    { jobId, start, end, text, ratio }        ← 边转边出字
asr://progress   { jobId, ratio }                          ← 分段之间的细粒度进度
asr://done       { jobId, name, duration, language, segments, files, text, historyId }
asr://error      { jobId, message }
asr://finished   { jobId }                                 ← 成功、失败、取消都会发

model://download         { id, downloadedBytes, totalBytes, ratio, source }
model://download-done    { id, path }
model://download-error   { id, message }
model://verifying        { id }
```

### 引擎核心与界面解耦

`engine::transcribe()` 不依赖 Tauri：它接收一个 `TranscribeObserver`，界面实现一份把事件翻译成 `asr://`，无头 CLI 实现一份把进度打到 stderr。所以「验收脚本测的就是界面那条路」是结构性保证，而不是靠两处代码保持同步。

### 一个上游坑（已绕过）

`whisper-rs` 0.16.0 的 `FullParams::set_abort_callback_safe` 有个真 bug：它把**双重装箱**的闭包按具体类型解引用（`trampoline::<F>`），而同一文件里 progress / segment 的包装用的都是 `trampoline::<Box<dyn ...>>`。类型对不上就是踩内存，实测**直接段错误**。

所以取消功能绕过了安全包装，改用原始 `set_abort_callback` + 一个只读 `AtomicBool` 的 C 回调（见 `engine.rs` 里 `abort_trampoline` 的注释）。升级 `whisper-rs` 时应当先确认这条，或回归到安全包装。

## 已验证

| 项 | 结果 |
|---|---|
| 前端单测 | 78 通过（8 个文件：状态机、格式化、设置、模型挑选、逐字稿面板、输出设置、应用外壳、引导窗口） |
| Rust 单测 | 46 通过（解码/重采样、产物格式、历史库、模型清单、下载校验、CLI 解析、路径安全） |
| 静态检查 | `oxlint` 0 警告 · `oxfmt --check` 通过 · `tsc --noEmit` 通过 · `cargo clippy -D warnings` 通过 |
| 应用内下载 | 用应用自己的下载器实下 Tiny 模型：进度、sha256 校验、落盘文件名与体积均正确；重复下载幂等 |
| 信任锚 | 注入「长度正确但内容错误」的 payload，校验失败后被拒绝并删除，重试自愈为正确文件（有单测锁定） |
| 闭环 | 应用下载的模型能被应用自己用于转写，四种产物齐全 |
| 端到端 | 通过：aiff（PCM）与 m4a（AAC）各产出 txt/srt/vtt/json，字幕时间轴与 json 结构经断言校验 |
| 打包产物 | `.app` 约 20 MB，包内无任何外部引擎资源；用**打包后的应用本体**实跑中文 m4a 通过 |
| 安装包 | `pnpm dist` 产出 DMG（约 7.5 MB），挂载后含 `转音.app` 与 `Applications → /Applications` 快捷方式；模拟安装后运行装好的那份，转写正常 |
| 打包兼容性 | 新老两条创建路径都实测：`diskutil image`（macOS 26）与 `hdiutil` 兜底（CI 的 macos-14） |
| 窗口分工 | 有模型时只开 `main`、没有模型时只开 `onboarding`，两条路径都实机验证过（看窗口创建日志） |
| 无外部依赖 | 全链路不调用 ffmpeg、不调用 Python；本机未装 ffmpeg 也通过 |
| 速度 | 39.5 秒音频推理 3.3 秒（**11.9× 实时**），整进程 4.1 秒（含模型加载 0.27 秒） |
| 体积 | `.app` 约 20 MB；模型单独下载（推荐档 574 MB） |

## 开发记录

踩过的几个坑都写在**它们发生的地方**，改到相关代码前值得先读一眼：

- **whisper-rs 0.16 的 abort 回调有缺陷**：它把双重装箱的闭包按具体类型解引用，实测直接段错误 → `src-tauri/src/engine.rs` 里 `abort_trampoline` 的注释
- **直连上游会静默停滞**：下了 0 字节也不报错，看起来像卡死 → `src-tauri/src/models.rs` 里的停滞看门狗与镜像注释
- **术语提示词会反噬**：把一长串术语当 `initial-prompt` 会让模型复读提示词并在结尾打转 → `src-tauri/src/engine.rs` 里 `set_no_context` 的注释
- **shell 里全角标点会断开变量名**：`$label）` 会被解析成变量名的一部分 → `scripts/verify-engine.sh` 里用 `${label}` 的注释
