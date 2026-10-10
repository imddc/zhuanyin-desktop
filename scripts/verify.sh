#!/usr/bin/env bash
#
# 端到端验收（提交前门槛）。
#
# 分两层，刻意不重复实现：
#   scripts/verify-engine.sh  —— 引擎链路：音频 → 解码 → 识别 → 四种产物
#                                （走可执行文件的无头模式，与界面同一条路径）
#   本脚本                    —— 引擎链路 + 前端单测 + Rust 单测
#
# 引擎链路不需要 Python / mlx-whisper / ffmpeg，只需要一个模型文件。
# 因此它在本地是可跑的；CI 之所以不覆盖，是因为 runner 上没有模型权重（约 574 MB）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== 引擎链路 =="
bash "$ROOT/scripts/verify-engine.sh"

echo
echo "== 代码检查 =="
(cd "$ROOT" && pnpm lint)
(cd "$ROOT" && pnpm format:check)
# 类型检查必须在这里跑：pnpm build（以及 tauri build 的 beforeBuildCommand）是
# `tsc --noEmit && vite build`，只跑 lint + 测试的话类型错误会一路漏到构建才炸
(cd "$ROOT" && pnpm typecheck)
echo "== 前端测试 =="
(cd "$ROOT" && pnpm test --silent)

echo "== Rust 格式与静态检查 =="
(cd "$ROOT/src-tauri" && cargo fmt --all --check)
(cd "$ROOT/src-tauri" && cargo clippy --all-targets --quiet -- -D warnings)
echo "== Rust 测试 =="
(cd "$ROOT/src-tauri" && cargo test --quiet 2>&1 | grep -E "test result: ok" | head -1)

echo
echo "✓ 端到端验收通过：引擎链路（真实模型）、四种产物、代码检查、前端测试、Rust 格式/Clippy/测试全部正常"
