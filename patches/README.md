# dsh 本体 role patch（`patches/`）

`dsh-llm-fallbacks` 需要 subagent 的**显式角色来源**：`agent.options.role` 作为
fallback 链角色解析的最高优先级来源（spec §3：`options.role` → `roles.rules` →
`roles.default`）。dsh 本体目前没有该字段，本目录提供最小改动的 git patch + 配套
脚本（`scripts/apply-dsh-patch.sh` / `revert-dsh-patch.sh` / `verify-dsh-patch.sh`），
把改动应用到**本机的 dsh 源码树**（本仓库不携带 dsh 源码）。

## Patch 清单

| 文件 | 目标包 | 改动 |
|------|--------|------|
| `@deepseek-ai+dsh-agent@0.0.1.patch` | `@deepseek-ai/dsh-agent` | `AgentOptions`（merge-extensible 创建选项接口，`packages/core/agent/src/runtime-types.ts`）追加可选 `role?: string` + JSDoc，与既有 `provider`/`model`/`maxTokens` 同形 |
| `@deepseek-ai+dsh-tool-subagent@0.0.1.patch` | `@deepseek-ai/dsh-tool-subagent` | `Config.agentOptions` schema（`packages/subagent/tool-subagent/src/index.ts`，`z.object({provider, model, maxTokens}).default(undefined)`）追加 `role: z.string()`（可选字段） |

> 文件名为 pnpm `patchedDependencies` 惯例 `@scope+pkg@version.patch`（版本 0.0.1
> 与两个包 `package.json` 一致）。本仓库通过 `scripts/*.sh` 直接对 dsh 源码树应用
> 这些 patch（diff 路径为仓库根相对路径，`git -C "$DSH_SOURCE_DIR" apply` 可直接
> 使用）；若改用 pnpm `patchedDependencies` 机制，需将 diff 路径前缀调整为包目录
> 相对路径，本仓库不依赖该机制。

## 为什么需要这两个 patch（diff 内容说明）

1. **`dsh-agent`**：`AgentOptions` 是 dsh 的 merge-extensible agent 创建选项接口
   （`provider`/`model`/`maxTokens` 同形）。追加 `role?: string` 后，任意 agent
   均可携带显式角色标签，供角色感知的消费者（如本插件的 fallback 链选择）读取。
   纯类型追加，无运行期行为变化。
2. **`dsh-tool-subagent`**：其 `Config.agentOptions` 的 schemastery schema 必须
   与 `AgentOptions` 类型保持一致——`Config: z<Config>` 的 schema 输出类型需可赋
   值给 `agentOptions?: AgentOptions`；仅 patch dsh-agent 而不 patch 此 schema 会
   使 `z<Config>` 类型检查失败。运行时：`resolveChildAgentOptions`
   （`packages/subagent/subagent/src/child-agent.ts`）的 `{...parent, ...requested,
   subagentDepth}` spread 会把 `requested` 中的未知字段（含 `role`）透传到 child
   `agent.options`，因此**无需修改任何子代理逻辑**——patch 应用后
   `tool-subagent` 设置的 `agentOptions.role` 直达 subagent 的 `agent.options.role`。

两处都是**最小改动**：不触碰重试/路由逻辑，不改变任何既有默认行为；未设置 `role`
时与 patch 前完全一致。

## 用法

所有脚本的目标目录在**运行时**解析，脚本文件本身不含本地绝对路径：

```sh
# 目标解析：$DSH_SOURCE_DIR 优先，缺省 ${DSH_HOME}/source/current
export DSH_SOURCE_DIR=/path/to/dsh-source   # 或仅设置 DSH_HOME
```

### 应用

```sh
scripts/apply-dsh-patch.sh            # git apply --check → apply → 增量构建
scripts/apply-dsh-patch.sh --check    # 只检查是否可应用（不修改任何文件）
scripts/apply-dsh-patch.sh --skip-build  # 应用但不构建（无 pnpm 环境的场景）
```

幂等：已应用的 patch 自动跳过。构建步骤 = `tsc -b packages/core/agent
packages/subagent/tool-subagent`（增量） + `tsdown --env.DSH_BUILD_FACE host`
（dsh monorepo 无每包 `build` 脚本，这是与仓库一致的构建入口）；若目标树无
pnpm 环境，脚本打印明确提示、跳过构建并退出非 0。

### 回滚

```sh
scripts/revert-dsh-patch.sh           # git apply --reverse 两个 patch → 重建
scripts/revert-dsh-patch.sh --check
```

### 验证

```sh
scripts/verify-dsh-patch.sh           # 断言 role 标记已出现（源文件 + 构建产物）
scripts/verify-dsh-patch.sh --absent  # 断言 role 标记不出现（revert 后）
```

验证探针（存在即检查，缺失记 SKIP）：

- agent：`src/runtime-types.ts` 与构建产物 `lib/types/runtime-types.d.ts` 含 `role?: string`
- tool-subagent：`src/index.ts` 与构建产物 `lib/types/index.js` 含 `role: z.string()`

> 说明：`AgentOptions` 编译到 `lib/types/runtime-types.d.ts`（而非 `index.d.ts`，
> 后者仅 re-export）；tool-subagent 的 d.ts 只以类型引用 `AgentOptions`，`role` 的
> 文本标记出现在编译后的 schema JS（`lib/types/index.js`）中。探针按此实际布局选取。

## dsh 升级后需重跑

dsh 升级（`$DSH_HOME/source/current` 指向新 staging）会**重置**本体改动：升级后
重新执行 `scripts/apply-dsh-patch.sh`（脚本幂等，已应用则跳过）并
`scripts/verify-dsh-patch.sh` 确认；升级导致上下文偏移、patch 无法应用时，脚本会
报冲突并提示（可能需按新源码行号重新生成 patch，见 `docs/dsh-patch.md`）。

## 安全说明

- `apply`/`revert` 会在目标树执行**构建**（`pnpm exec tsc` / `tsdown`），即运行该
  树的安装时代码——仅应对可信的 dsh 源码树运行；目标树由 `$DSH_SOURCE_DIR` /
  `$DSH_HOME` 显式指定，请确认其来源可信。
- patch 内容仅追加可选字段，不改变既有默认行为；`revert` 一键回滚，构建产物随
  重建还原。
