#!/usr/bin/env bash
#
# apply-dsh-patch.sh — 将 dsh 本体 role patch 应用到目标 dsh 源码树。
#
# 背景：dsh-llm-fallbacks 需要 subagent 的显式角色来源。dsh 本体最小改动：
#   - @deepseek-ai/dsh-agent:        AgentOptions 追加可选 role?: string
#   - @deepseek-ai/dsh-tool-subagent: Config.agentOptions schema 追加 role: z.string()
# 本脚本把这些改动以 git patch 形式应用到 dsh 源码树（本仓库不携带 dsh 源码）。
# 设置命名空间（fallbacks）的读写不再需要任何 dsh 本体 patch——settings 读写经插件
# 自有 gateway 通道（/api/fallbacks/get|set|reset），与宿主暴露机制解耦。
#
# 目标解析（运行时，脚本本身不含本地绝对路径）：
#   $DSH_SOURCE_DIR（若设置）→ 缺省 ${DSH_HOME}/source/current
#
# 流程（对每个 patch）：
#   git apply --check 通过 → 尚未应用 → git apply 应用；
#   git apply --reverse --check 通过 → 已应用 → 跳过（幂等）；
#   两者都失败 → 冲突/损坏 → 报错退出。
# 应用完成后重建受影响包（tsc -b 增量 + tsdown host 打包）。
#
# 选项：
#   --check        仅检查每个 patch 是否可应用，不修改任何文件、不构建。
#   --skip-build   应用 patch 后跳过构建步骤（exit 0；供无 pnpm 环境的场景手动构建）。
#   -d|--target DIR  指定目标 dsh 源码树（覆盖 env 解析）。
#   -h|--help      显示本帮助。
#
# 退出码：
#   0  全部 patch 已应用（或已应用跳过）/ --check 全部就绪
#   1  任一 patch 冲突、目标目录不可用、或构建失败 / 因缺 pnpm 环境而跳过构建
#
# 安全说明：构建步骤会在目标树执行安装时代码（tsc/tsdown），仅应对可信的 dsh
# 源码树运行；目标树由 $DSH_SOURCE_DIR / $DSH_HOME 显式指定。
set -euo pipefail

# 定位本脚本与仓库根（运行时推导，无硬编码绝对路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"

# 本仓库交付的 pnpm 格式 patch（文件名即 pnpm 惯例 @scope+pkg@version.patch）。
# 仅剩 role 组两项（Plan B 清空整组）；设置命名空间读写走插件 gateway 通道，
# 不再需要 dsh-settings / dsh-host-apiproxy 暴露 patch。
PATCH_FILES=(
  "@deepseek-ai+dsh-agent@0.0.1.patch"
  "@deepseek-ai+dsh-tool-subagent@0.0.1.patch"
)

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
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
# gitfile 感知的 git 仓库判定（W3）：`-d "$TARGET/.git"` 会拒绝 gitfile worktree
# （真实 $DSH_SOURCE_DIR 布局：.git 是文件，指向主仓库的 worktree 元数据）。
# `git rev-parse --git-dir` 对目录式与 gitfile 式仓库都成立。
if ! git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: 目标目录不是 git 仓库（.git 目录或 gitfile worktree 均可）: $TARGET" >&2
  echo "       请设置 DSH_SOURCE_DIR（或 DSH_HOME），或使用 --target。" >&2
  exit 1
fi
echo "== 目标 dsh 源码树: $TARGET"

# 返回单个 patch 的状态：needs-apply / applied / conflict
patch_status() {
  local patch="$1"
  if git -C "$TARGET" apply --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "needs-apply"
  elif git -C "$TARGET" apply --reverse --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "applied"
  else
    echo "conflict"
  fi
}

# 重建受影响包：tsc -b 增量（全部被 patch 的包及其引用）→ tsdown host 打包（产出 lib/ 运行产物）。
# dsh monorepo 无每包 build 脚本，这是与仓库一致的增量构建入口。
build_affected() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "WARN: PATH 中找不到 pnpm；patch 已应用但构建已跳过。" >&2
    echo "      请手动重建: cd \"\$DSH_SOURCE_DIR\" && pnpm install && pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent && pnpm exec tsdown --env.DSH_BUILD_FACE host" >&2
    return 1
  fi
  if [[ ! -d "$TARGET/node_modules" ]]; then
    echo "WARN: 目标树缺少 node_modules（非 pnpm 工作区安装）；patch 已应用但构建已跳过。" >&2
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
APPLIED_ANY=0

for patch in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${PATCHES_DIR}/${patch}" ]]; then
    echo "ERROR: 找不到 patch 文件: ${PATCHES_DIR}/${patch}" >&2
    exit 1
  fi
  status="$(patch_status "$patch")"
  case "$status" in
    needs-apply)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        echo "  [check] ${patch}: 可应用（目标尚未应用）"
      else
        echo "== 应用 ${patch}"
        git -C "$TARGET" apply "${PATCHES_DIR}/${patch}"
        APPLIED_ANY=1
      fi
      ;;
    applied)
      echo "  [skip]  ${patch}: 已应用（幂等跳过）"
      ;;
    conflict)
      echo "ERROR: ${patch}: 既不能正向应用也不能反向撤销 —— 目标树与该 patch 冲突（可能已手工改动）。" >&2
      HAD_CONFLICT=1
      ;;
  esac
done

if [[ "$HAD_CONFLICT" -eq 1 ]]; then
  echo "ERROR: 存在冲突 patch，未完成全部应用。" >&2
  exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "== 检查完成（未修改任何文件）"
  exit 0
fi

if [[ "$APPLIED_ANY" -eq 1 && "$SKIP_BUILD" -eq 0 ]]; then
  build_affected || exit 1
elif [[ "$APPLIED_ANY" -eq 0 ]]; then
  echo "== 全部 patch 已应用，无需构建"
fi

echo "== 完成"
