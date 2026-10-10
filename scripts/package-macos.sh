#!/usr/bin/env bash
#
# 把构建好的 .app 打成**可直接安装的 DMG**，并生成 SHA-256。
#
# 「可直接安装」的判定标准（脚本会逐条验证，不是建出来就算）：
#   1. 能挂载；
#   2. 里面有 转音.app；
#   3. 里面有一个指向 /Applications 的快捷方式 —— 用户拖一下就能装，不用自己去访达里找。
#
# 为什么不直接用 Tauri 的 DMG：那一步会调 bundle_dmg.sh，它要靠 Finder 会话摆窗口布局，
# 在非图形会话里必失败（本机实测 `pnpm tauri build --bundles dmg` 报
# `error running bundle_dmg.sh`）。这里绕开它 —— 自己搭一个 staging 目录再建映像。
#
# 磁盘映像仍可能被环境限制（沙箱里就是如此），所以保留 zip 兜底，发版不会空手而归。
#
# 关于 hdiutil 与 diskutil：新版 macOS 已把 hdiutil 标为废弃并提示改用
# `diskutil image create from` / `attach`。但 `diskutil image` 子命令在较老的系统上
# 还不存在（例如 CI 用的 macos-14），所以这里新命令优先、老命令兜底。
# 想强制走兜底路径可以在本地验证：ZHUANYIN_FORCE_HDIUTIL=1 scripts/package-macos.sh
#
# 用法：scripts/package-macos.sh [debug|release]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-release}"
APP="$ROOT/src-tauri/target/$PROFILE/bundle/macos/转音.app"
OUT_DIR="$ROOT/dist-release"
APP_NAME="转音.app"
VOLUME_NAME="转音"

FORCE_HDIUTIL="${ZHUANYIN_FORCE_HDIUTIL:-0}"

if [ ! -d "$APP" ]; then
  echo "找不到已构建的应用：$APP" >&2
  echo "先跑 pnpm tauri:build（或 pnpm dist）再打包。" >&2
  exit 1
fi

# 当前发布产物是 arm64：宁可在这里失败，也别发出架构不符的包
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  echo "需要在 Apple Silicon 上打包，当前架构：$ARCH" >&2
  exit 1
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"
# 文件名必须是 ASCII：GitHub 的 Release 资产 API 会丢掉非 ASCII 字符，
# 上传后「转音_0.1.2_arm64.dmg」会变成「_0.1.2_arm64.dmg」，
# 于是 SHA256SUMS.txt 里记的名字与用户实际下到的对不上、
# `shasum -a 256 -c SHA256SUMS.txt` 必然失败。（实测：上传 测试_1.txt 落成 _1.txt）
# 应用本体与卷标仍然是「转音」，只有文件名走 ASCII。
BASE="zhuanyin_${VERSION}_${ARCH}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# 映像操作：新命令优先，老命令兜底
# ---------------------------------------------------------------------------

create_image() {
  local destination="$1"
  if [ "$FORCE_HDIUTIL" -eq 0 ] && diskutil image create from \
    --volumeName "$VOLUME_NAME" --format UDZO "$STAGE" "$destination" >/dev/null 2>&1; then
    echo "diskutil"
    return 0
  fi
  hdiutil create -volname "$VOLUME_NAME" -srcfolder "$STAGE" -ov -format UDZO "$destination" >/dev/null
  echo "hdiutil"
}

attach_image() {
  local source="$1"
  local output
  if [ "$FORCE_HDIUTIL" -eq 0 ] && output="$(diskutil image attach --mountOptions nobrowse --readOnly "$source" 2>/dev/null)"; then
    # diskutil 不打印挂载点，按卷名推断（重名时系统会加 " 1"）
    if [ -d "/Volumes/$VOLUME_NAME" ]; then
      echo "/Volumes/$VOLUME_NAME"
    else
      echo "/Volumes/$VOLUME_NAME 1"
    fi
    return 0
  fi
  hdiutil attach -nobrowse -readonly "$source" 2>/dev/null | tail -1 | awk -F'\t' '{print $NF}'
}

detach_image() {
  local mount_point="$1"
  diskutil eject "$mount_point" >/dev/null 2>&1 ||
    hdiutil detach "$mount_point" >/dev/null 2>&1 ||
    true
}

# ---------------------------------------------------------------------------
# 打包
# ---------------------------------------------------------------------------

# 搭 staging：应用本体 + 一个 /Applications 快捷方式。
# 快捷方式就是「拖进来即可安装」的那一半，缺了它用户还得自己打开访达找应用程序文件夹。
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
echo "== 准备安装包内容 =="
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
echo "   $APP_NAME + Applications → /Applications"

made_dmg=0
echo "== 尝试 DMG =="
if TOOL="$(create_image "$OUT_DIR/$BASE.dmg")"; then
  echo "   用 $TOOL 创建"
  MOUNT_POINT="$(attach_image "$OUT_DIR/$BASE.dmg")"

  ok=1
  [ -d "$MOUNT_POINT/$APP_NAME" ] || {
    echo "  ✗ DMG 里找不到 $APP_NAME" >&2
    ok=0
  }
  [ -L "$MOUNT_POINT/Applications" ] || {
    echo "  ✗ DMG 里缺少 Applications 快捷方式" >&2
    ok=0
  }
  [ "$(readlink "$MOUNT_POINT/Applications" 2>/dev/null)" = "/Applications" ] || {
    echo "  ✗ Applications 快捷方式没指向 /Applications" >&2
    ok=0
  }

  if [ "$ok" -eq 1 ]; then
    echo "  ✓ 挂载校验通过：$APP_NAME + Applications 快捷方式都在"
    made_dmg=1
  fi

  detach_image "$MOUNT_POINT"
  if [ "$made_dmg" -eq 0 ]; then
    rm -f "$OUT_DIR/$BASE.dmg"
  fi
else
  echo "  ✗ DMG 创建失败（创建磁盘映像被环境限制），回落 zip" >&2
  rm -f "$OUT_DIR/$BASE.dmg"
fi

if [ "$made_dmg" -eq 0 ]; then
  echo "== 回落 zip（解压后把 $APP_NAME 拖进「应用程序」）=="
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT_DIR/$BASE.zip"
fi

(cd "$OUT_DIR" && shasum -a 256 -- * > SHA256SUMS.txt)

echo
echo "产物："
ls -la "$OUT_DIR"
echo
echo "校验和："
cat "$OUT_DIR/SHA256SUMS.txt"
echo
if [ "$made_dmg" -eq 1 ]; then
  echo "✓ 安装包就绪：双击 $BASE.dmg，把「转音」拖进 Applications 即可"
else
  echo "✓ 安装包就绪（zip 兜底）：解压 $BASE.zip，把「转音」拖进 Applications"
fi
