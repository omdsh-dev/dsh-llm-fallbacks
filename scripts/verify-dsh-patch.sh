#!/usr/bin/env bash
#
# verify-dsh-patch.sh — 校验目标 dsh 源码树中 role + 暴露组 patch 的效果（出现 / 消失）。
#
# 检查两组（role 组 + 暴露组，共四个 patch）探针（文件存在即检查，缺失记为
# SKIP；不会把缺失误判为通过或失败）：
#   @deepseek-ai/dsh-agent          src/runtime-types.ts          → 期望 `role?: string`
#                                   lib/types/runtime-types.d.ts  → 期望 `role?: string`
#                                   （构建产物；注意 AgentOptions 编译到
#                                     runtime-types.d.ts，而非 index.d.ts）
#                                   src/model-selection.ts        → 期望 `markFallbackRouted`
#                                   lib/types/model-selection.js  → 期望 `markFallbackRouted`
#                                   （标记导出 + 外层监听器让位；构建产物在 .js）
#   @deepseek-ai/dsh-tool-subagent  src/index.ts                  → 期望 `role: z.string()`
#                                   lib/types/index.js            → 期望 `role: z.string()`
#                                   （构建产物；类型只引用 AgentOptions，
#                                     role 的文本标记在编译后的 schema JS 中）
#   @deepseek-ai/dsh-settings       src/index.ts                  → 期望 `exposeToWebClients?: boolean`
#                                   lib/types/index.d.ts          → 期望 `exposeToWebClients?: boolean`
#                                   （构建产物；注册选项的声明面在 .d.ts）
#   @deepseek-ai/dsh-host-apiproxy  src/api-proxy.ts              → 期望 `descriptor.exposed === true`
#                                   lib/types/api-proxy.js        → 期望 `descriptor.exposed === true`
#                                   （构建产物；注册表查询逻辑在编译后 JS 中）
#
# 默认断言 marker 出现（patch 已应用并已构建）；--absent 反转断言（revert 后）。
# 判定：任一存在的探针不符合断言 → exit 1；所有探针文件均缺失 → 视为非 dsh 树 → exit 1。
#
# 目标解析（运行时，脚本本身不含本地绝对路径）：
#   $DSH_SOURCE_DIR（若设置）→ 缺省 ${DSH_HOME}/source/current
#
# 选项：
#   --absent        断言 marker 不存在（用于 revert 后验证）。
#   -d|--target DIR  指定目标 dsh 源码树（覆盖 env 解析）。
#   -q|--quiet      只输出最终结论。
#   -h|--help       显示本帮助。
#
# 退出码：0 = 校验通过；1 = 校验失败 / 目标不可用。
set -euo pipefail

usage() {
  sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

ABSENT=0
QUIET=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --absent) ABSENT=1; shift ;;
    -q|--quiet) QUIET=1; shift ;;
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
if [[ ! -d "$TARGET" ]]; then
  echo "ERROR: 目标目录不存在: $TARGET" >&2
  echo "       请设置 DSH_SOURCE_DIR（或 DSH_HOME），或使用 --target。" >&2
  exit 1
fi

# 探针：(相对路径|固定字符串|说明)
PROBES=(
  "packages/core/agent/src/runtime-types.ts|role?: string|agent source (runtime-types.ts)"
  "packages/core/agent/lib/types/runtime-types.d.ts|role?: string|agent build (lib/types/runtime-types.d.ts)"
  "packages/core/agent/src/model-selection.ts|markFallbackRouted|agent source (model-selection.ts)"
  "packages/core/agent/lib/types/model-selection.js|markFallbackRouted|agent build (lib/types/model-selection.js)"
  "packages/subagent/tool-subagent/src/index.ts|role: z.string()|tool-subagent source (index.ts)"
  "packages/subagent/tool-subagent/lib/types/index.js|role: z.string()|tool-subagent build (lib/types/index.js)"
  "packages/settings/settings/src/index.ts|exposeToWebClients?: boolean|settings source (index.ts)"
  "packages/settings/settings/lib/types/index.d.ts|exposeToWebClients?: boolean|settings build (lib/types/index.d.ts)"
  "packages/host/apiproxy/src/api-proxy.ts|descriptor.exposed === true|apiproxy source (api-proxy.ts)"
  "packages/host/apiproxy/lib/types/api-proxy.js|descriptor.exposed === true|apiproxy build (lib/types/api-proxy.js)"
)

EXPECT_LABEL="出现"
[[ "$ABSENT" -eq 1 ]] && EXPECT_LABEL="不出现"

FAIL=0
CHECKED=0

for probe in "${PROBES[@]}"; do
  IFS='|' read -r rel marker label <<< "$probe"
  file="${TARGET}/${rel}"
  if [[ ! -f "$file" ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [SKIP] %-52s 文件缺失\n' "$label"
    continue
  fi
  CHECKED=1
  if grep -qF -- "$marker" "$file"; then
    present=1
  else
    present=0
  fi
  if [[ "$ABSENT" -eq 1 ]]; then
    # 期望 marker 不出现：出现即失败
    if [[ "$present" -eq 1 ]]; then
      FAIL=1
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] %-52s 意外出现 %s\n' "$label" "'$marker'"
    else
      [[ "$QUIET" -eq 0 ]] && printf '  [PASS] %-52s 未出现 %s\n' "$label" "'$marker'"
    fi
  else
    # 期望 marker 出现：缺失即失败
    if [[ "$present" -eq 1 ]]; then
      [[ "$QUIET" -eq 0 ]] && printf '  [PASS] %-52s 命中 %s\n' "$label" "'$marker'"
    else
      FAIL=1
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] %-52s 未命中 %s\n' "$label" "'$marker'"
    fi
  fi
done

if [[ "$CHECKED" -eq 0 ]]; then
  echo "ERROR: 目标目录中未找到任何探针文件，不像是 dsh 源码树: $TARGET" >&2
  exit 1
fi

if [[ "$FAIL" -eq 1 ]]; then
  echo "== 校验失败：patch 标记（role + 暴露组，期望${EXPECT_LABEL}）未满足" >&2
  exit 1
fi

echo "== 校验通过：patch 标记（role + 暴露组，期望${EXPECT_LABEL}）满足"
