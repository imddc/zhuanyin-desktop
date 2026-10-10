<p align="center">
  <img src="assets/icon.svg" width="112" height="112" alt="转音：声波转成文字">
</p>

<h1 align="center">转音 · Zhuanyin</h1>

<p align="center"><strong>把录音变成可回听的逐字稿。</strong><br>本机识别 · 批量转写 · 时间轴联动</p>

<p align="center">
  <a href="https://github.com/FizzLabs/zhuanyin-desktop/releases">下载安装</a> ·
  <a href="#开始使用">使用说明</a> ·
  <a href="#开发">参与开发</a>
</p>

转音是一款离线音频转写桌面应用。拖入录音，得到带时间轴的文字；点击一段逐字稿，就能跳回原音频核对。适合整理访谈、会议与课程录音。

**音频在本机处理。** 应用内置识别引擎和音频解码器，不需要额外安装 Python 或 ffmpeg。首次使用需要联网下载模型，下载完成后可离线转写。

## 从录音到文字

| 能力 | 使用方式 |
| --- | --- |
| 批量转写 | 一次拖入多个文件，队列串行处理，支持取消任务 |
| 边转边看 | 识别段落实时显示，无需等待整个录音处理完 |
| 回听核对 | 点击段落跳转播放；播放时高亮当前段落，支持倍速 |
| 多格式导出 | 每个任务生成 TXT、SRT、VTT 和 JSON |
| 历史记录 | 本地保存逐字稿、分段与时间轴，下次打开可继续查看 |
| 模型管理 | 应用内下载、切换、删除或导入已有模型 |

## 开始使用

### 安装

从 [Releases](https://github.com/FizzLabs/zhuanyin-desktop/releases) 下载 macOS arm64 安装包，打开 DMG，将「转音」拖入「应用程序」。若发布附件为 ZIP，解压后安装其中的应用。

当前发布目标是 **Apple Silicon Mac，macOS 11 或更高版本**。发布构建未做代码签名与公证；首次打开可能需要在访达中右键选择「打开」，并根据系统提示允许运行。

### 下载模型

没有可用模型时，应用打开独立引导窗口：欢迎 → 选择模型 → 开始使用。已有模型则直接进入工作区，也可从「设置」重新打开引导。

默认推荐 **Large v3 Turbo · Q5_0（约 574 MB）**。希望减少占用时，可选择 Small、Base 或 Tiny；更小的模型通常需要接受识别质量下降。具体型号、体积与下载状态见「模型」页。

下载优先使用 `hf-mirror.com`，失败后尝试上游；支持断点续传、停滞检测和 SHA-256 校验。也可通过「导入已有模型」选择受支持的 `ggml-*.bin` 文件。「模型目录」按钮可以打开存放位置。

### 转写与回听

- 将音频拖进工作区，查看队列进度与实时逐字稿。
- 点击逐字稿段落回听原音频，可调整播放速度。
- 在「设置」选择识别语言、初始提示词和输出位置；默认自动检测语言。
- 在「历史」打开已完成任务，恢复逐字稿与播放联动。原音频需保留在可访问的位置。

默认在音频所在目录创建一个同名文件夹，也可以指定输出根目录：

```text
会议录音/
├── 会议录音.txt     纯文本逐字稿
├── 会议录音.srt     SRT 字幕
├── 会议录音.vtt     WebVTT 字幕
└── 会议录音.json    文本、分段与时间信息
```

通过「在访达中显示」可定位导出文件。

## 使用边界

- **文件转写**：暂不提供实时听写、说话人分离或静音裁剪。
- **格式支持**：支持 M4A / AAC / MP3 / WAV / AIFF / FLAC / CAF / ALAC / OGG（Vorbis）等；暂不支持 Opus 与 WMA。
- **平台支持**：当前只发布 macOS arm64，其他平台尚未完成构建与验证。
- **识别质量**：结果受模型、录音清晰度、口音和静音段影响，重要内容需要回听核对。
- **本地文件**：历史记录不会替代原音频备份；移动或删除音频可能影响回听。

## 常见问题

**下载失败怎么办？** 应用会尝试续传与换源。也可以自行下载清单对应的模型，再通过「导入已有模型」导入。

**转写有多快？** 耗时取决于硬件、模型与录音长度。首次运行可能需要编译 Metal 着色器；连续转写会复用模型上下文，减少重复加载。

**专业词汇识别不准怎么办？** 可以在初始提示词中写一句包含相关词汇的自然语言。避免堆积长术语表，它可能导致模型复读或产生无关内容。

**离线时能用吗？** 已下载模型后，识别、解码、历史记录与导出都在本机完成。模型下载需要网络。

---

## 开发

技术栈是 **Tauri 2 + React 19 + TypeScript + Vite**。Rust 侧使用 `whisper-rs` 调用 whisper.cpp，通过 Metal 加速；Symphonia 解码音频，Rubato 重采样，SQLite 保存历史。

开发需要 Node.js 20.19+（20.x）或 22.12+、pnpm 12、Rust 工具链、CMake 和 macOS 的 Xcode Command Line Tools。Rust manifest 声明最低版本为 1.77；实际依赖兼容性应以锁文件和构建结果为准。

```bash
pnpm install --frozen-lockfile
pnpm tauri:dev
```

`pnpm dev` 只启动前端开发服务；完整桌面交互需要 `pnpm tauri:dev` 提供原生命令与事件。

### 检查与打包

| 命令 | 用途 |
| --- | --- |
| `pnpm lint` / `pnpm lint:fix` | Oxlint 检查 / 自动修复 |
| `pnpm format:check` / `pnpm format` | Oxfmt 检查 / 格式化 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | Vitest 前端测试 |
| `pnpm build` | 类型检查与前端构建 |
| `pnpm tauri:build` | 构建桌面应用 |
| `pnpm package:macos` | 将已有应用打包为 DMG，失败时回落 ZIP |
| `pnpm dist` | 构建应用并生成安装包 |

**提交前运行完整验收入口：**

```bash
./scripts/verify.sh
```

它覆盖真实模型的音频转写与产物断言、前端检查和测试、Rust 格式检查、Clippy 与单测。引擎验收需要已构建的 release 可执行文件与已下载的模型；可通过 `ZHUANYIN_BIN`、`ZHUANYIN_MODEL` 和 `ZHUANYIN_MODELS_DIR` 指定资源。测试结果以当次执行输出为准。

### 代码结构

```text
src/
├── App.tsx                 工作区外壳与跨页面状态
├── OnboardingWindow.tsx    独立引导窗口
├── pages/                  转写、模型、历史、设置
├── components/             界面组件
├── hooks/                  队列驱动、模型与历史订阅
└── lib/                    状态迁移、设置与格式化
src-tauri/src/
├── engine.rs               识别核心、任务编排与取消
├── audio.rs                解码与 16 kHz 单声道重采样
├── models.rs               模型管理与下载校验
├── catalog.json            模型清单与哈希
├── history.rs              SQLite 历史记录
├── output.rs               TXT / SRT / VTT / JSON 导出
├── windows.rs              引导与工作区窗口管理
└── lib.rs                  应用装配与 CLI 参数解析
```

前端通过 Tauri 命令发起任务，通过 `asr://*` 与 `model://*` 事件接收进度和结果。队列串行驱动识别，Rust 侧复用模型上下文。识别核心通过 `TranscribeObserver` 输出结果，GUI 与无头 CLI 共用同一条转写路径。

### 无头模式

同一个可执行文件可用于脚本转写和引擎验收：

```bash
# 下载模型，使用与界面相同的下载器
./src-tauri/target/release/zhuanyin --download-model large-v3-turbo-q5_0

# 指定模型 ID；也可以传入模型文件路径
./src-tauri/target/release/zhuanyin \
  --transcribe recording.m4a \
  --model large-v3-turbo-q5_0 \
  --language zh \
  --json
```

完整选项通过 `--help` 查看。`--json` 输出结果摘要，完整分段保存在导出的 JSON 文件中。

### CI 与发布

- `ci.yml` 在 PR 与 `main` 推送时运行前端 Lint、格式、类型和测试检查。
- Rust 检查与真实模型验收在本地运行，不能由前端 CI 通过替代。
- `release.yml` 在推送 `v*` 标签时构建 macOS arm64 应用，发布安装包和 `SHA256SUMS.txt`。
- 手动触发发布工作流只上传构建产物，不创建 Release。
- 打包脚本生成并挂载校验 DMG；失败时回落 ZIP。当前未配置签名与公证。

### 维护约束

- 颜色统一放在 `src/styles.css` 的 token 块中。调整主题时保持次要文本对比度至少 4.5:1，避免降低现有表面亮度。
- `whisper-rs` 0.16 的取消回调已有绕过实现，见 `engine.rs` 的 `abort_trampoline` 注释；升级绑定时需要复核并验证取消路径。
- 开发构建启用了 Rust 优化级别，涉及音频性能时先阅读 `Cargo.toml` 的 profile 注释。
- `assets/icon.svg` 是图标设计源，README 与 `src-tauri/icons/` 的桌面资源保持一致，`icon-source.png` 为 1024px 导出。
- 变更按 Issue → 开发分支 → 验收 → PR 流程进行。

### 生产版 WebView 交互与验收

v0.1.4 曾暴露系统 WebView 的右键 `Reload` 菜单（[问题 #9](https://github.com/FizzLabs/zhuanyin-desktop/issues/9)）。Release 构建不会自动移除浏览器默认菜单；刷新会重建前端状态，不能作为工作区操作提供。

- `src/main.tsx` 在 React 渲染前为主窗口与引导窗口安装统一生产策略：阻止默认右键菜单，输入框提供系统剪切、复制、粘贴、全选，选中的逐字稿提供复制。开发模式不限制。
- `windows.rs` 两个窗口均显式设置 `.devtools(cfg!(debug_assertions))`；不要给发布依赖启用 `tauri/devtools` feature，也不要增加生产环境的 `open_devtools` 调用。关闭 Inspector 与移除 Reload 是两件事，必须分别处理。
- 生产策略拦截 `Cmd/Ctrl+R`、`F5`、`F12`、常见 Inspector / Console / 查看源代码快捷键，保留常规复制、粘贴、剪切、全选与撤销。
- 发布验收必须使用打包后的 release `.app`，分别检查主窗口与引导窗口：空白区域无 Reload/Inspect；编辑菜单和复制粘贴正常；刷新及调试快捷键无效；选中文字仍可复制；转写中操作不会重置界面。另用 Safari 的 Develop 菜单核对生产 WebView 不可检查。单元测试不能替代这些原生交互检查。
- 这些措施防止误操作与普通调试入口暴露，**不是安全边界**：本机所有者仍可分析或修改应用。机密与授权校验不能依赖“禁用控制台”，也不应放入前端产物。
