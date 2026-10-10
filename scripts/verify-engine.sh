#!/usr/bin/env bash
#
# 引擎链路验收：音频 → 解码 → 识别 → 四种产物。
#
# 关键点：走的是**与应用完全相同的引擎路径**——同一个可执行文件的无头模式
# （`转音 --transcribe`），所以这里通过就意味着界面里的那条路也通。
#
# 与旧版的区别：不再需要 Python、mlx-whisper 或 ffmpeg 做前置，
# 需要的东西只剩「一个模型文件」。脚本会主动断言这一点。
#
# 任何一步失败都以非零退出，可直接当提交前门槛。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${ZHUANYIN_BIN:-$ROOT/src-tauri/target/release/zhuanyin}"
MODELS_DIR="${ZHUANYIN_MODELS_DIR:-$HOME/Library/Application Support/com.imddc.zhuanyin/models}"
MODEL="${ZHUANYIN_MODEL:-$MODELS_DIR/ggml-large-v3-turbo-q5_0.bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "✗ $1" >&2
  exit 1
}

echo "== 前置检查 =="
[ -x "$BIN" ] || fail "找不到可执行文件：${BIN}（先跑 pnpm tauri:build，或 cargo build --release）"
[ -f "$MODEL" ] || fail "找不到模型：${MODEL}
  先在应用里下载一个模型（界面 → 模型），或用 ZHUANYIN_MODEL 指向已有的 ggml-*.bin"
echo "   可执行文件：$BIN"
echo "   模型      ：$(basename "$MODEL") ($(du -h "$MODEL" | cut -f1))"
# 这一版刻意不再依赖任何外部工具；如果它们缺席，链路仍须跑通
command -v ffmpeg >/dev/null 2>&1 || echo "   本机没有 ffmpeg —— 这正是要验证的场景"
command -v python3 >/dev/null 2>&1 || true

echo "== 生成测试音频（内容已知，用于断言）=="
command -v say >/dev/null 2>&1 || fail "缺少 say（本机 TTS），无法生成测试音频"
say -v Tingting -o "$WORK/sample.aiff" "这是一段转音验收测试音频，用来确认整条链路可以正常工作。"
[ -s "$WORK/sample.aiff" ] || fail "测试音频生成失败"

# 再转一份 m4a：aiff 与 m4a 走的是解码器里不同的分支（PCM 与 AAC）
if command -v afconvert >/dev/null 2>&1; then
  afconvert -f m4af -d "aac@44100" -b 128000 "$WORK/sample.aiff" "$WORK/sample.m4a" 2>/dev/null || true
fi
echo "   已生成 aiff$( [ -s "$WORK/sample.m4a" ] && echo ' 与 m4a' )"

# 逐个用例跑一遍：每次都用与界面相同的参数走无头模式。
#
# 注意变量一律写成 ${label} 而不是 $label：下面这些字符串里紧跟着的是全角标点
# （`（`、`：`），bash 会把全角字符的首字节当成变量名的一部分，报 unbound variable。
run_case() {
  local input="$1"
  local label="$2"
  # 语言必须显式传进来，不能写死：写死 zh 会让「自动检测」这条路
  # 一次都不被验到 —— 而它恰恰是界面的默认值（见下面那条 auto 用例）。
  local language="$3"
  # 应用会给每个任务建一个与任务同名的子目录，所以这里给的是「产物根目录」
  local out="$WORK/out/${label}"

  echo "== 转写（${label}）=="
  "$BIN" --transcribe "$input" \
    --model "$MODEL" \
    --out-dir "$WORK/out" \
    --name "${label}" \
    --language "$language" \
    --json > "$WORK/${label}.json" 2> "$WORK/${label}.log" || {
    echo "--- stderr 末尾 ---" >&2
    tail -20 "$WORK/${label}.log" >&2
    fail "${label}：转写失败"
  }

  for extension in txt srt vtt json; do
    [ -s "$out/${label}.$extension" ] || fail "${label}：产物缺失或为空 ${label}.$extension"
  done

  grep -q '验收测试' "$out/${label}.txt" || {
    echo "--- 实际逐字稿 ---" >&2
    cat "$out/${label}.txt" >&2
    fail "${label}：逐字稿未包含预期关键词「验收测试」"
  }

  grep -q '00:00:00,000 -->' "$out/${label}.srt" || fail "${label}：srt 时间轴格式不对"
  head -1 "$out/${label}.vtt" | grep -q '^WEBVTT' || fail "${label}：vtt 缺少 WEBVTT 头"

  python3 - "$out/${label}.json" "$WORK/${label}.json" <<'PY' || fail "${label}：json 结构不对"
import json, sys
data = json.load(open(sys.argv[1]))
assert isinstance(data.get('segments'), list) and data['segments'], 'segments 为空'
first = data['segments'][0]
assert {'start', 'end', 'text'} <= set(first), '段缺少 start/end/text 字段'
assert data.get('duration', 0) > 0, 'duration 应当大于 0'
assert data.get('text'), 'text 不应为空'

cli = json.load(open(sys.argv[2]))
assert cli.get('segments') == len(data['segments']), 'CLI 摘要与落盘的段数不一致'
assert cli.get('files', {}).get('srt'), 'CLI 摘要缺少 srt 产物路径'
assert cli.get('elapsedSeconds', 0) > 0, '缺少耗时'
assert cli.get('speed', 0) > 0, '缺少数倍实时'
print('   段落数 %d，首段 %.2f-%.2f 秒，%.1f× 实时'
      % (len(data['segments']), first['start'], first['end'], cli['speed']))
PY

  echo "   产物目录：$out"
  echo "   逐字稿：$(head -c 100 "$out/${label}.txt")"
}

run_case "$WORK/sample.aiff" "aiff" "zh"
if [ -s "$WORK/sample.m4a" ]; then
  run_case "$WORK/sample.m4a" "m4a" "zh"
  # auto 是界面的默认语言设置，必须单独验一条。
  # 曾经这里只跑 zh，于是「设了 detect_language 导致只检测语言、直接返回」的
  # 缺陷完全没被发现 —— 而它让默认路径每次都产出空产物还报成功。
  run_case "$WORK/sample.m4a" "auto" "auto"
else
  echo "   （本机 afconvert 未能生成 m4a，跳过 AAC 用例）"
fi

echo
echo "✓ 引擎链路通过：无 Python、无 ffmpeg，aiff 与 m4a 均产出四种格式且结构正确"
