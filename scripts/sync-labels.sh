#!/usr/bin/env bash
#
# 标签即代码：把仓库标签同步成下面这份清单。
#
# 为什么需要一个脚本而不是手点：
# 标签是「仓库状态」而不是「代码」，换一个新仓、或者把规范铺到另一个仓时，
# 手点十几个标签既慢又会漏。`gh label create --force` 是幂等的 ——
# 已存在就更新颜色与描述，不存在就新建，所以这个脚本可以反复跑。
#
# 用法：
#   ./scripts/sync-labels.sh                                  # 默认同步到本仓库
#   ./scripts/sync-labels.sh --repo FizzLabs/agentic-gym      # 同步到别的仓
#   ./scripts/sync-labels.sh --dry-run                        # 只看会做什么
#
set -euo pipefail

REPO=""
DRY_RUN="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

# 清单格式：名称|颜色|描述
#
# 命名约定（取舍见用户全局指令的「Git 与 GitHub 协作规范 → 标签约定」）：
# - 通用词沿用 GitHub 原生名称与默认色，方便 `gh issue list --label bug` 这类命令与搜索命中
# - 领域标签统一 `area:` 前缀，形成命名空间，避免和通用词混淆
# - 不用 emoji：命令行里难打，也不便于脚本处理
LABELS=$(cat <<'EOF'
bug|d73a4a|功能与预期不符
enhancement|a2eeef|新增或改进功能
documentation|0075ca|文档、注释、README
chore|cfd3d7|依赖、构建、CI 等非功能改动
needs-repro|f9d0c4|缺最小复现，补齐前不排查
blocked|9103b0|依赖外部：上游缺陷、等接口、等决策
invalid|e4e669|不是有效问题：信息不足或理解偏差
duplicate|cfd3d7|已有同类 issue 或 PR
question|d876e3|需要进一步澄清
wontfix|ffffff|明确不做，关闭时必须写明理由
good first issue|7057ff|适合第一次参与
help wanted|008672|欢迎外部贡献
area:engine|1d76db|引擎编排层与 worker 协议
area:ui|5319e7|前端界面与交互
area:build|0e8a16|构建、打包、图标与发布
area:docs|0075ca|文档与笔记
EOF
)

CREATED=0
UPDATED=0

while IFS='|' read -r name color description; do
  [ -n "$name" ] || continue
  if [ "$DRY_RUN" = "true" ]; then
    echo "  [dry-run] ${name}  #${color}  ${description}"
    continue
  fi
  if gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null 2>&1; then
    UPDATED=$((UPDATED + 1))
  else
    echo "  ✗ 失败：${name}" >&2
    exit 1
  fi
done <<< "$LABELS"

if [ "$DRY_RUN" = "true" ]; then
  echo "（dry-run，未改动任何标签）"
  exit 0
fi

echo "✓ ${REPO} 标签已同步：${UPDATED} 个（create --force 幂等，新建与更新合并计数）"
echo "  当前标签总数：$(gh label list --repo "$REPO" --limit 100 --json name --jq 'length')"
