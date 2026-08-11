# dsh 本体 patch 指南

本仓库在 `patches/` 交付 dsh 本体的**最小改动 git patch** + 配套脚本（`scripts/apply-dsh-patch.sh` / `revert-dsh-patch.sh` / `verify-dsh-patch.sh` / `autopatch-install.sh`），把改动应用到**本机的 dsh 源码树**（本仓库不携带 dsh 源码）。当前只有一组 patch：

1. **subagent 显式角色**（`dsh-agent` + `dsh-tool-subagent`）：角色解析以 `agent.options.role`（显式角色）为最高优先级来源（`options.role` → `roles.rules` → `roles.default`，见 [docs/configuration.md](docs/configuration.md)）。dsh 本体目前没有该字段。

> **设置读写不再需要任何 patch**：`fallbacks` 设置命名空间的读/写/重置现在走**插件自有 gateway 通道**（`/api/fallbacks/get` / `/api/fallbacks/set` / `/api/fallbacks/reset`），不再依赖 dsh 本体的设置暴露机制（注册表 opt-in + apiproxy 查询）。`dsh-settings` 与 `dsh-host-apiproxy` 两个暴露 patch 已随 gateway 上线移除；安装插件不再需要「先打设置暴露补丁」。剩余两个 patch 只负责**运行时**的 subagent 显式角色（role / model-selection），与设置页读写无关。

`autopatch-install.sh` 在插件安装生命周期自动应用**两个 patch**（role 组，顺序与 `apply-dsh-patch.sh` 一致，见下文「自动应用」）；`apply` / `revert` / `verify` 三脚本供手动应用 / 回滚 / 验证。目标快照：patch 以 dsh 快照 commit **`20da39e`**（`staging-20260810T165245Z`）为基线生成。

## 动机：subagent 显式角色

- 未 patch 时，subagent 由 tool-subagent 派生，继承/覆盖父模型路由，无法精确归属到独立 fallback 链。
- patch 后，`agentOptions.role` 经 `resolveChildAgentOptions` 的 `{...parent, ...requested, subagentDepth}` spread 直达 child `agent.options.role`——**无需修改任何子代理逻辑**，配置即贯通（已核实源码）。
- 显式 role 让 subagent 可精确归属独立链（如「代码审查」子代理只降级到审查专用低成本模型），不被父模型的链牵制；不设置 `role` 时行为与 patch 前完全一致。

## 两个 patch 的改动面

| patch 文件 | 目标包 | 改动面 |
|---|---|---|
| `@deepseek-ai+dsh-agent@0.0.1.patch` | `@deepseek-ai/dsh-agent` | `AgentOptions`（merge-extensible 创建选项接口，`packages/core/agent/src/runtime-types.ts`）追加可选 `role?: string` + JSDoc，与既有 `provider`/`model`/`maxTokens` 同形。纯类型追加，无运行期行为变化 |
| `@deepseek-ai+dsh-tool-subagent@0.0.1.patch` | `@deepseek-ai/dsh-tool-subagent` | `Config.agentOptions` schema（`packages/subagent/tool-subagent/src/index.ts`，`z.object({provider, model, maxTokens}).default(undefined)`）追加 `role: z.string()`，并将 `.default(undefined as unknown as {...})` 的 cast 类型同步补 `role: string`（与 schema 输出全等，避免 `default(value: T)` 的 TS2345） |

两个 patch 必须成对：**role 组**（`dsh-agent` + `dsh-tool-subagent`）——patch 1 提供 `AgentOptions.role` 类型面，patch 2 让 schema 接受 role；**应用顺序 agent 先、tool-subagent 后**（`apply-dsh-patch.sh` 的 PATCH_FILES 已按此排序），**回滚顺序相反**（`revert-dsh-patch.sh` 按 tool-subagent → agent 逆序）。均为最小改动，不触碰重试/路由逻辑，不改变任何既有默认行为。patch 内容细节见 [patches/README.md](../patches/README.md)。

## 未打补丁宿主降级（运行期，W1）

插件对 `markFallbackRouted`（agent patch 的导出）做**可选调用守卫**（namespace import + `?.()` + `??`），因此**未打补丁宿主**（`DSH_LLM_FALLBACKS_AUTOPATCH=0`、link 安装、或 dsh 升级后未重跑 apply）不会导致插件整包加载失败或切换点抛错，而是**降级为分支前语义**：

- 切换**仍然发生**：触发码 / always-cap 决策照常记录并应用，请求路由到链目标（`provider/model` override 不变）；
- 唯一的差异是**标记缺席**：切换步的 config 未标 fallback-routed，因此**存在活跃 model-selection 时，该步的路由由外层 selection 决定**（同分支前行为——selection 重新覆盖）；无活跃 selection 时路由到链目标，与 patch 后一致；
- 该降级路径由 `tests/unpatched-host.spec.ts` 专项测试钉住（模拟不含 `markFallbackRouted` 的宿主模块，断言不抛、路由到链目标）；真实宿主复验归 QA gate [docs/verification.md](docs/verification.md) §6。

补丁应用的完整效果（标记生效、活跃 selection 下切换步让位链目标）依赖 agent patch 已应用并重建。

## 应用 / 回滚 / 验证

所有脚本在**插件仓库目录**下执行；目标 dsh 源码树在运行时解析：

- `$DSH_SOURCE_DIR` 优先，缺省 `${DSH_HOME}/source/current`（即正在运行的 dsh staging 树）；
- 也可用 `-d/--target DIR` 显式指定。

```sh
# 1) 先检查（只读，不修改任何文件、不构建）
scripts/apply-dsh-patch.sh --check

# 2) 应用（git apply --check → apply → 增量构建受影响包）
scripts/apply-dsh-patch.sh

# 3) 验证（断言 role 组标记出现在源码与构建产物中）
scripts/verify-dsh-patch.sh

# 4) 回滚（先 --check，再执行；回滚后重建）
scripts/revert-dsh-patch.sh --check
scripts/revert-dsh-patch.sh

# 5) 回滚后验证（断言 role 组标记已消失）
scripts/verify-dsh-patch.sh --absent
```

要点：

- **幂等**：已应用的 patch 自动跳过（`apply` 输出 `[skip] 已应用`），已回滚的自动跳过（`revert` 同理），可重复执行。
- **`--check` 优先**：应用/回滚前先用 `--check` 确认目标树状态，零副作用。
- **构建步骤**：`apply`/`revert` 会重建受影响包（`pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent` + `pnpm exec tsdown --env.DSH_BUILD_FACE host`）。目标树无 pnpm 环境时脚本明确提示并跳过构建、退出非 0（此时可 `--skip-build` 应用后手动构建）。
- **验证探针**：agent 检查 `src/runtime-types.ts` 与构建产物 `lib/types/runtime-types.d.ts` 含 `role?: string`、`src/model-selection.ts` 与 `lib/types/model-selection.js` 含 `markFallbackRouted`；tool-subagent 检查 `src/index.ts` 与构建产物 `lib/types/index.js` 含 `role: z.string()`（探针布局与真实构建产物一致，缺失记为 SKIP）。

## 自动应用（安装期）

插件在安装生命周期自动检测目标 dsh 源码树并**幂等应用两个 patch**（脚本 `scripts/autopatch-install.sh`，PATCH_FILES 与 `apply-dsh-patch.sh` 一致：agent → tool-subagent；三态判定同构：可应用 → apply；已应用 → skip；冲突 → warn），无需手动执行 `apply-dsh-patch.sh`：

- **触发时机**：
  - `postinstall`：插件作为依赖被安装时（git / tarball 安装）。pnpm ≥ 10 默认不执行依赖的构建脚本，需放行后才触发（见 [docs/install.md](docs/install.md) 的 allowBuilds 说明）；
  - `prepare`：git 安装（pnpm 在克隆后构建）以及在本仓库目录执行 `pnpm install` 时；
  - **本地 link 安装（`dsh plugin --profile <name> add .`）不触发生命周期脚本**（pnpm 对 `link:` 依赖不运行 prepare/postinstall，已实证）——此类安装后请手动执行一次 `bash scripts/autopatch-install.sh`（幂等，已应用则跳过）。
- **开关**：环境变量 `DSH_LLM_FALLBACKS_AUTOPATCH`，默认开启（`1`）；`DSH_LLM_FALLBACKS_AUTOPATCH=0` 完全跳过（含 prepare 链的 autopatch 段）。
- **目标解析**：`$DSH_SOURCE_DIR` 优先，缺省 `${DSH_HOME}/source/current`；目标缺失或非 git 树 → info 跳过（退出 0）。
- **失败语义**：任何失败只 warn、**绝不导致安装失败**（退出 0）：patch 冲突 → warn 并提示手动处理（`apply-dsh-patch.sh`）；重建失败 / 缺 pnpm / 缺 node_modules → warn 并附手动重建命令；verify 探针未通过 → warn 附手动应用命令。幂等：已应用 / 已原生支持（verify 探针全部通过，即 dsh 已等价具备 role 能力）→ 跳过。
- **升级后重跑仍靠 `apply-dsh-patch.sh`**：自动应用只在插件安装时触发一次，dsh 升级重置本体改动后**不会**自动重打——升级后仍需按下文「dsh 升级后需重跑」手动执行 `apply-dsh-patch.sh` 并 `verify-dsh-patch.sh` 确认。

## dsh 升级后需重跑

dsh 升级会重置本体改动：`$DSH_HOME/source/current` 指向新的 staging 树后，重新执行 `scripts/apply-dsh-patch.sh`（幂等，已应用则跳过）并 `scripts/verify-dsh-patch.sh` 确认。若升级导致源码上下文偏移、patch 无法应用，脚本会报冲突并提示——此时可能需要按新源码行号重新生成 patch（本仓库交付的 diff 以 dsh 快照 commit `20da39e` 为基准）。

## 安全说明

- `apply` / `revert` 会在目标树执行**构建**（`pnpm exec tsc` / `tsdown`），即运行该树安装时代码——**仅应对可信的 dsh 源码树运行**；目标树由 `$DSH_SOURCE_DIR` / `$DSH_HOME` 显式指定，请确认其来源可信。
- patch 内容仅追加可选字段，不改变既有默认行为；`revert` 一键回滚，构建产物随重建还原。

## 在真实 dsh 安装上的应用

**对真实 dsh 安装的 patch 应用需由用户在自身环境执行**：本仓库的验证环境受沙箱约束，无法对运行中的 `$DSH_HOME` 安装写入（包括 apply → build 全流程）。如实说明本仓库已完成、未完成的验证：

- **已验证**：两个 patch 对真实 dsh 源码树 `git apply --check` 通过（只读校验，树保持 untouched）；`scripts/apply-dsh-patch.sh --check` 两 patch 状态判定正确（零写入）；role 组类型正确性经真实 `tsc` 编译验证（cast 修正后 red→green，见 autopatch 计划任务 6 修复轮）；两个 patch 在沙箱拷贝的 dsh 树镜像上完整跑通 apply（顺序 agent → tool-subagent）→ `verify-dsh-patch.sh`（role 组 src 探针全 PASS）→ revert（逆序 tool-subagent → agent）→ `verify-dsh-patch.sh --absent` 全流程与幂等性。
- **未验证**：在真实安装上执行 apply → build（QA gate 阶段按 [docs/verification.md](docs/verification.md) §6 全量执行并记录证据）。

> 历史说明：早期迭代曾交付 `dsh-settings` + `dsh-host-apiproxy` 两个**设置暴露** patch（注册表 opt-in 暴露注册选项），使 `fallbacks` 命名空间进入宿主 web 设置 RPC 暴露集合。gateway 通道（`/api/fallbacks/get|set|reset`）上线后该机制不再需要，两个暴露 patch 已随本 plan 移除；`src/dsh-patch-ambient.d.ts` 中的设置暴露声明为预期死代码（TS augmentation 叠加，无害），留待 Plan B 整文件删除。**已应用过这两个暴露 patch 的存量安装无需处理**：patch 在宿主树中保持已应用但完全惰性（无任何 `exposed` 注册残留、`exposeToWebClients` 不再传入），新脚本（`patches/` 仅剩两 patch）无法将其回滚，下次 dsh 升级重置宿主树时自然清除。

**role 组验证步骤（真实宿主，QA gate 阶段执行）**：

```sh
cd <插件仓库目录>
scripts/apply-dsh-patch.sh --check    # 只读：两 patch 状态判定
scripts/apply-dsh-patch.sh            # 应用两 patch → 增量构建（tsc -b 含 agent/tool-subagent + tsdown host）
scripts/verify-dsh-patch.sh           # 断言 role 组标记出现在源码与构建产物
scripts/revert-dsh-patch.sh --check   # 只读：可回滚状态判定
scripts/revert-dsh-patch.sh           # 逆序回滚（tool-subagent → agent）→ 重建
scripts/verify-dsh-patch.sh --absent  # 断言全部标记已消失
```

应用完成后重启 dsh 会话使 `agent.options.role` 生效；设置页读写走插件 gateway 通道，与这些 patch 无关（无需为设置页应用任何 patch）。
