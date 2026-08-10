#!/usr/bin/env bash
#
# autopatch-install.sh — 插件安装期自动应用 dsh 本体 patch（role + 暴露，幂等、失败仅 warn）。
#
# 背景：dsh-llm-fallbacks 需要 subagent 的显式角色来源 + 设置命名空间 web 暴露
# 机制（同 apply-dsh-patch.sh）。
# 本脚本在插件安装生命周期（postinstall / prepare）自动检测目标 dsh 源码树并
# 幂等应用全部四个 patch（role 组 + 暴露组，顺序与 apply-dsh-patch.sh 一致），
# 随后 best-effort 重建受影响包；任何失败只 warn、绝不导致插件安装失败
# （全局约束：不破坏安装）。
#
# 开关：DSH_LLM_FALLBACKS_AUTOPATCH（默认 1；设为 "0" 完全跳过，exit 0）。
#
# 目标解析（运行时，脚本本身不含本地绝对路径）：
#   $DSH_SOURCE_DIR（若设置）→ 缺省 ${DSH_HOME}/source/current
#   目标缺失或非 git 树 → info 跳过（exit 0）。
#
# 流程（对每个 patch，与 apply-dsh-patch.sh 同构的三态判定）：
#   git apply --check 通过       → 尚未应用 → git apply 应用；
#   git apply --reverse --check 通过 → 已应用 → 跳过（幂等）；
#   两者都失败 → 记为冲突；全部 patch 处理完后统一判定：verify 探针通过（patch 标记
#   已就位，即 dsh 已原生支持/已等价应用）→ info 跳过；否则 → warn 提示手动处理
#   （不中断安装）。
# 应用后 best-effort 重建：tsc -b packages/core/agent packages/subagent/tool-subagent
#   packages/settings/settings packages/host/apiproxy
#   + tsdown --env.DSH_BUILD_FACE host（缺 pnpm / 缺 node_modules / 失败 → warn 不中断）。
# 最后运行 verify 探针并提示结果（失败附手动命令）。
#
# 选项：
#   --check        仅报告每个 patch 的状态，不修改任何文件、不构建、不验证。
#   -h|--help      显示本帮助。
#
# 退出码：
#   0  正常完成（含全部跳过 / 冲突 warn / 构建失败 warn —— 安装期绝不因本脚本失败）
#   1  用法错误（未知选项）
set -euo pipefail

# 定位本脚本与仓库根（运行时推导，无硬编码绝对路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"

# 与 apply-dsh-patch.sh 相同的四个 pnpm 格式 patch
PATCH_FILES=(
  "@deepseek-ai+dsh-agent@0.0.1.patch"
  "@deepseek-ai+dsh-tool-subagent@0.0.1.patch"
  "@deepseek-ai+dsh-settings@0.0.1.patch"
  "@deepseek-ai+dsh-host-apiproxy@0.0.1.patch"
)

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "ERROR: 未知选项: $1" >&2; usage 1 ;;
  esac
done

# 输出统一带插件前缀，便于在 pnpm 安装日志中辨识
log()  { printf '[dsh-llm-fallbacks:autopatch] %s\n' "$*"; }
warn() { printf '[dsh-llm-fallbacks:autopatch] WARN: %s\n' "$*" >&2; }

# 1) 环境开关：DSH_LLM_FALLBACKS_AUTOPATCH=0 → 完全跳过（含 prepare 链的 autopatch 段）
if [[ "${DSH_LLM_FALLBACKS_AUTOPATCH:-1}" == "0" ]]; then
  log "DSH_LLM_FALLBACKS_AUTOPATCH=0 — 跳过自动 patch 应用"
  exit 0
fi

# 2) 目标解析：$DSH_SOURCE_DIR 优先，缺省 ${DSH_HOME}/source/current
TARGET="${DSH_SOURCE_DIR:-${DSH_HOME:-}/source/current}"
if [[ ! -d "$TARGET/.git" ]]; then
  log "未找到 dsh 源码树（$TARGET 缺失或非 git 树），跳过自动 patch 应用（安装后可用 scripts/apply-dsh-patch.sh 手动应用）"
  exit 0
fi
log "目标 dsh 源码树: $TARGET"

# 返回单个 patch 的状态：needs-apply / applied / conflict（与 apply-dsh-patch.sh 同构）
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

# 重建受影响包（tsc -b 增量 → tsdown host 打包）。best-effort：任何失败仅 warn 并返回 0。
build_affected() {
  local manual="cd \"$TARGET\" && pnpm install && pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent packages/settings/settings packages/host/apiproxy && pnpm exec tsdown --env.DSH_BUILD_FACE host"
  if ! command -v pnpm >/dev/null 2>&1; then
    warn "PATH 中找不到 pnpm；patch 已应用但构建已跳过。请手动重建: ${manual}"
    return 0
  fi
  if [[ ! -d "$TARGET/node_modules" ]]; then
    warn "目标树缺少 node_modules（非 pnpm 工作区安装）；patch 已应用但构建已跳过。请手动重建: ${manual}"
    return 0
  fi
  log "重建受影响包（tsc -b 增量 + tsdown host 打包）"
  if ! ( cd "$TARGET" && pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent packages/settings/settings packages/host/apiproxy ); then
    warn "tsc 增量构建失败（见上方输出），构建已跳过。请手动重建: ${manual}"
    return 0
  fi
  if ! ( cd "$TARGET" && pnpm exec tsdown --env.DSH_BUILD_FACE host ); then
    warn "tsdown 打包失败（见上方输出），构建已跳过。请手动重建: ${manual}"
    return 0
  fi
  log "构建完成"
}

# verify 探针结果提示（探针已在冲突判定前运行一次，此处仅按 VERIFY_OK 输出，不重复探测）
run_verify() {
  if [[ "$VERIFY_OK" -eq 1 ]]; then
    log "verify 探针通过：patch 标记已就位（role + 暴露组，源码/构建产物）"
  else
    warn "verify 探针未通过：patch 标记未就位（role + 暴露组）。请手动应用并验证: bash \"${SCRIPT_DIR}/apply-dsh-patch.sh\" && bash \"${SCRIPT_DIR}/verify-dsh-patch.sh\""
  fi
}

HAD_CONFLICT=0
APPLIED_ANY=0
CONFLICTED_PATCHES=()

for patch in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${PATCHES_DIR}/${patch}" ]]; then
    warn "找不到 patch 文件: ${PATCHES_DIR}/${patch}（插件包可能不完整）— 跳过该 patch"
    continue
  fi
  status="$(patch_status "$patch")"
  case "$status" in
    needs-apply)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "[check] ${patch}: 可应用（目标尚未应用）"
      else
        log "应用 ${patch}"
        if ! git -C "$TARGET" apply "${PATCHES_DIR}/${patch}"; then
          warn "${patch}: git apply 失败（见上方输出），已跳过（安装继续）"
          continue
        fi
        APPLIED_ANY=1
      fi
      ;;
    applied)
      log "[skip]  ${patch}: 已应用（幂等跳过）"
      ;;
    conflict)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "[check] ${patch}: 冲突（无法正向应用或反向撤销）"
      else
        CONFLICTED_PATCHES+=("$patch")
        HAD_CONFLICT=1
      fi
      ;;
  esac
done

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  log "检查完成（未修改任何文件）"
  exit 0
fi

if [[ "$APPLIED_ANY" -eq 1 ]]; then
  build_affected
fi

# verify 探针（只读、幂等）：只运行一次，结果存 VERIFY_OK，冲突降级判定与最终提示共用
VERIFY_OK=0
if "${SCRIPT_DIR}/verify-dsh-patch.sh" -d "$TARGET" -q >/dev/null 2>&1; then
  VERIFY_OK=1
fi

# 冲突统一判定：verify 探针通过 → dsh 已原生支持（或已等价应用）→ 降级为 info
if [[ "$HAD_CONFLICT" -eq 1 ]] && [[ "$VERIFY_OK" -eq 1 ]]; then
  log "存在冲突 patch，但 verify 探针通过（dsh 已原生支持/已等价应用），视为完成"
  HAD_CONFLICT=0
fi

if [[ "$HAD_CONFLICT" -eq 1 ]]; then
  warn "以下 patch 与目标树冲突（可能已手工改动或 dsh 升级偏移）: ${CONFLICTED_PATCHES[*]}"
  warn "请手动处理: bash \"${SCRIPT_DIR}/apply-dsh-patch.sh\""
  log "存在冲突 patch，跳过 verify 探针（请手动处理冲突后运行 scripts/apply-dsh-patch.sh）"
else
  run_verify
fi

log "完成（安装不受影响）"
exit 0
