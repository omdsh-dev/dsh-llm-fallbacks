#!/usr/bin/env bash
#
# revert-dsh-patch.sh — 回滚 apply-dsh-patch.sh 应用到目标 dsh 源码树的 role 组
# 两个 patch（dsh-agent + dsh-tool-subagent）。
#
# 对每个 patch 执行 git apply --reverse（先 --reverse --check 确认已应用）；
# 已回滚的 patch 幂等跳过；随后重建受影响包（与 apply 相同的构建步骤）。
# 回滚顺序与 apply 相反（tool-subagent → agent）。
#
# 目标解析（运行时，脚本本身不含本地绝对路径）：
#   $DSH_SOURCE_DIR（若设置）→ 缺省 ${DSH_HOME}/source/current
#
# 选项：
#   --check        仅检查每个 patch 是否处于已应用态（可回滚），不修改任何文件。
#   --skip-build   回滚后跳过构建步骤（exit 0）。
#   -d|--target DIR  指定目标 dsh 源码树（覆盖 env 解析）。
#   -h|--help      显示本帮助。
#
# 退出码：
#   0  全部 patch 已回滚（或已回滚跳过）/ --check 全部可回滚
#   1  任一 patch 无法回滚、目标目录不可用、或构建失败 / 因缺 pnpm 环境而跳过构建
set -euo pipefail

# 定位本脚本与仓库根（运行时推导，无硬编码绝对路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"

# 与 apply-dsh-patch.sh 相同的 pnpm 格式 patch（仅 role 组两项）；回滚顺序与 apply 相反
# （先撤销 tool-subagent、再撤销 agent）
PATCH_FILES=(
  "@deepseek-ai+dsh-tool-subagent@0.0.1.patch"
  "@deepseek-ai+dsh-agent@0.0.1.patch"
)

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

CHECK_ONLY=0
SKIP_BUILD=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -d|--target)
      if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
        echo "ERROR: $1 需要一个目标目录参数" >&2
        usage 1
      fi
      TARGET="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "未知选项: $1" >&2; usage 1 ;;
  esac
done

# 解析目标目录
if [[ -z "$TARGET" ]]; then
  TARGET="${DSH_SOURCE_DIR:-${DSH_HOME:-}/source/current}"
fi
# gitfile 感知的 git 仓库判定（W3）：同 apply-dsh-patch.sh —— `.git` 为文件的
# gitfile worktree（真实 $DSH_SOURCE_DIR 布局）同样接受。
if ! git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: 目标目录不是 git 仓库（.git 目录或 gitfile worktree 均可）: $TARGET" >&2
  echo "       请设置 DSH_SOURCE_DIR（或 DSH_HOME），或使用 --target。" >&2
  exit 1
fi
echo "== 目标 dsh 源码树: $TARGET"

# 返回单个 patch 的已应用态：applied / reverted / conflict
patch_status() {
  local patch="$1"
  if git -C "$TARGET" apply --reverse --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "applied"
  elif git -C "$TARGET" apply --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "reverted"
  else
    echo "conflict"
  fi
}

# 与 apply-dsh-patch.sh 相同的重建步骤（tsc -b 增量 + tsdown host 打包）
build_affected() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "WARN: PATH 中找不到 pnpm；patch 已回滚但构建已跳过。" >&2
    echo "      请手动重建: cd \"\$DSH_SOURCE_DIR\" && pnpm install && pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent && pnpm exec tsdown --env.DSH_BUILD_FACE host" >&2
    return 1
  fi
  if [[ ! -d "$TARGET/node_modules" ]]; then
    echo "WARN: 目标树缺少 node_modules（非 pnpm 工作区安装）；patch 已回滚但构建已跳过。" >&2
    echo "      请手动重建: cd \"\$DSH_SOURCE_DIR\" && pnpm install && pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent && pnpm exec tsdown --env.DSH_BUILD_FACE host" >&2
    return 1
  fi
  echo "== 重建受影响包（tsc -b 增量 + tsdown host 打包）"
  if ! ( cd "$TARGET" && pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent ); then
    echo "ERROR: tsc 增量构建失败（见上方输出）。" >&2
    return 1
  fi
  if ! ( cd "$TARGET" && pnpm exec tsdown --env.DSH_BUILD_FACE host ); then
    echo "ERROR: tsdown 打包失败（见上方输出）。" >&2
    return 1
  fi
  echo "== 构建完成"
}

HAD_CONFLICT=0
REVERTED_ANY=0

for patch in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${PATCHES_DIR}/${patch}" ]]; then
    echo "ERROR: 找不到 patch 文件: ${PATCHES_DIR}/${patch}" >&2
    exit 1
  fi
  status="$(patch_status "$patch")"
  case "$status" in
    applied)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        echo "  [check] ${patch}: 已应用（可回滚）"
      else
        echo "== 回滚 ${patch}"
        git -C "$TARGET" apply --reverse "${PATCHES_DIR}/${patch}"
        REVERTED_ANY=1
      fi
      ;;
    reverted)
      echo "  [skip]  ${patch}: 已回滚（幂等跳过）"
      ;;
    conflict)
      echo "ERROR: ${patch}: 既不能反向撤销也不能正向应用 —— 目标树与该 patch 冲突（可能已手工改动）。" >&2
      HAD_CONFLICT=1
      ;;
  esac
done

if [[ "$HAD_CONFLICT" -eq 1 ]]; then
  echo "ERROR: 存在冲突 patch，未完成全部回滚。" >&2
  exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "== 检查完成（未修改任何文件）"
  exit 0
fi

if [[ "$REVERTED_ANY" -eq 1 && "$SKIP_BUILD" -eq 0 ]]; then
  build_affected || exit 1
elif [[ "$REVERTED_ANY" -eq 0 ]]; then
  echo "== 全部 patch 已回滚，无需构建"
fi

echo "== 完成"
