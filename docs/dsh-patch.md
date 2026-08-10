# dsh 本体 patch 指南

本仓库在 `patches/` 交付 dsh 本体的**最小改动 git patch** + 配套脚本（`scripts/apply-dsh-patch.sh` / `revert-dsh-patch.sh` / `verify-dsh-patch.sh` / `autopatch-install.sh`），把改动应用到**本机的 dsh 源码树**（本仓库不携带 dsh 源码）。两组 patch：

1. **subagent 显式角色**（`dsh-agent` + `dsh-tool-subagent`）：角色解析以 `agent.options.role`（显式角色）为最高优先级来源（`options.role` → `roles.rules` → `roles.default`，见 [docs/configuration.md](docs/configuration.md)）。dsh 本体目前没有该字段。
2. **设置命名空间 web 暴露机制**（`dsh-settings` + `dsh-host-apiproxy`）：`fallbacks` 命名空间进入 web 设置 RPC（describe/update/replace）暴露集合的**通用 opt-in 机制**——注册选项 `exposeToWebClients`（默认 false）+ apiproxy 查询注册表；本插件声明 `exposeToWebClients: true`。

`autopatch-install.sh` 在插件安装生命周期自动应用**全部四个 patch**（role 组 + 暴露组，顺序与 `apply-dsh-patch.sh` 一致，见下文「自动应用」）；`apply` / `revert` / `verify` 三脚本供手动应用 / 回滚 / 验证。目标快照：patch 以 dsh 快照 commit **`20da39e`**（`staging-20260810T165245Z`）为基线生成。

## 动机：subagent 显式角色

- 未 patch 时，subagent 由 tool-subagent 派生，继承/覆盖父模型路由，无法精确归属到独立 fallback 链。
- patch 后，`agentOptions.role` 经 `resolveChildAgentOptions` 的 `{...parent, ...requested, subagentDepth}` spread 直达 child `agent.options.role`——**无需修改任何子代理逻辑**，配置即贯通（已核实源码）。
- 显式 role 让 subagent 可精确归属独立链（如「代码审查」子代理只降级到审查专用低成本模型），不被父模型的链牵制；不设置 `role` 时行为与 patch 前完全一致。

## 动机：设置命名空间 web 暴露

- 未 patch 时，apiproxy 的 `exposedNamespaces()` 只暴露 configurable model providers + 硬编码白名单（Web 偏好 + 产品自有），本插件的 `fallbacks` 命名空间无法被 web 设置客户端读写——设置页显示「未注册」。
- patch 后，注册表级 opt-in 生效：注册者（插件 `installSettingsSection` 调用）声明 `exposeToWebClients: true`，apiproxy 经 `settings.describe({ redactSecrets: true })` 并入 `descriptor.exposed === true` 的命名空间，`fallbacks` 进入 describe/update/replace 暴露集合。
- **通用机制而非白名单硬编码**：上游新快照（`20da39e`）已把 `'advisor'` 移出 apiproxy 硬编码暴露白名单，web profile 同装 dsh-advisor 同病（无法被 web 设置客户端读写）——逐个补白名单是坏味道且追不上上游；注册表 opt-in 是正解（每个 owner 自行声明）。**本迭代不修 dsh-advisor**（其 opt-in 声明属上游/其它迭代范围）。
- 向后兼容：`exposeToWebClients` 缺省 false，未声明暴露的命名空间 web describe 过滤与 update/replace/mutate 拒绝行为与 patch 前**逐位一致**；apiproxy 仅改 `exposedNamespaces()` 一处，`settingsWrite` 与 describe RPC 过滤零改动（spec §2.5 D-2）。保存后立即生效的进程内语义由既有「settings live re-read」机制承载（无需重启会话，证据链见 [docs/verification.md](docs/verification.md) §6）。

## 四个 patch 的改动面

| patch 文件 | 目标包 | 改动面 |
|---|---|---|
| `@deepseek-ai+dsh-agent@0.0.1.patch` | `@deepseek-ai/dsh-agent` | `AgentOptions`（merge-extensible 创建选项接口，`packages/core/agent/src/runtime-types.ts`）追加可选 `role?: string` + JSDoc，与既有 `provider`/`model`/`maxTokens` 同形。纯类型追加，无运行期行为变化 |
| `@deepseek-ai+dsh-tool-subagent@0.0.1.patch` | `@deepseek-ai/dsh-tool-subagent` | `Config.agentOptions` schema（`packages/subagent/tool-subagent/src/index.ts`，`z.object({provider, model, maxTokens}).default(undefined)`）追加 `role: z.string()`，并将 `.default(undefined as unknown as {...})` 的 cast 类型同步补 `role: string`（与 schema 输出全等，避免 `default(value: T)` 的 TS2345） |
| `@deepseek-ai+dsh-settings@0.0.1.patch` | `@deepseek-ai/dsh-settings` | `SettingsRegisterOptions.exposeToWebClients?: boolean`（默认 false）+ 内部 `SettingsRegistration.exposed` + `SettingsDescriptor.exposed` + `SettingsSectionHooks`/`installSettingsSection` 透传（`packages/settings/settings/src/index.ts` 一个文件，7 处 hunk）。纯类型/数据面追加，缺省 false 时 `describe()` 输出与 patch 前逐位一致 |
| `@deepseek-ai+dsh-host-apiproxy@0.0.1.patch` | `@deepseek-ai/dsh-host-apiproxy` | `exposedNamespaces()`（`packages/host/apiproxy/src/api-proxy.ts`）在 `modelProviderNamespaces() ∪ WEB_SETTINGS_NAMESPACES ∪ PRODUCT_SETTINGS_NAMESPACES` 并集之上，追加 `settings.describe({ redactSecrets: true })` 中 `descriptor.exposed === true` 的命名空间（`ctx.get('settings')` 缺失时跳过）；`settingsWrite` 与 describe RPC 过滤零改动 |

patch 分两组、各自必须成对：**role 组**（`dsh-agent` + `dsh-tool-subagent`）——patch 1 提供 `AgentOptions.role` 类型面，patch 2 让 schema 接受 role；**暴露组**（`dsh-settings` + `dsh-host-apiproxy`）——apiproxy 读取 `SettingsDescriptor.exposed`（由 settings patch 提供），**应用顺序 settings 先、apiproxy 后**（`apply-dsh-patch.sh` 的 PATCH_FILES 已按此排序），**回滚顺序相反**（`revert-dsh-patch.sh` 按 apiproxy → settings → tool-subagent → agent 逆序，先撤销依赖方再撤销被依赖方）。均为最小改动，不触碰重试/路由逻辑，不改变任何既有默认行为。patch 内容细节见 [patches/README.md](../patches/README.md)。

## 应用 / 回滚 / 验证

所有脚本在**插件仓库目录**下执行；目标 dsh 源码树在运行时解析：

- `$DSH_SOURCE_DIR` 优先，缺省 `${DSH_HOME}/source/current`（即正在运行的 dsh staging 树）；
- 也可用 `-d/--target DIR` 显式指定。

```sh
# 1) 先检查（只读，不修改任何文件、不构建）
scripts/apply-dsh-patch.sh --check

# 2) 应用（git apply --check → apply → 增量构建受影响包）
scripts/apply-dsh-patch.sh

# 3) 验证（断言 role + 暴露组标记出现在源码与构建产物中）
scripts/verify-dsh-patch.sh

# 4) 回滚（先 --check，再执行；回滚后重建）
scripts/revert-dsh-patch.sh --check
scripts/revert-dsh-patch.sh

# 5) 回滚后验证（断言 role + 暴露组标记已消失）
scripts/verify-dsh-patch.sh --absent
```

要点：

- **幂等**：已应用的 patch 自动跳过（`apply` 输出 `[skip] 已应用`），已回滚的自动跳过（`revert` 同理），可重复执行。
- **`--check` 优先**：应用/回滚前先用 `--check` 确认目标树状态，零副作用。
- **构建步骤**：`apply`/`revert` 会重建受影响包（`pnpm exec tsc -b packages/core/agent packages/subagent/tool-subagent packages/settings/settings packages/host/apiproxy` + `pnpm exec tsdown --env.DSH_BUILD_FACE host`）。目标树无 pnpm 环境时脚本明确提示并跳过构建、退出非 0（此时可 `--skip-build` 应用后手动构建）。
- **验证探针**：agent 检查 `src/runtime-types.ts` 与构建产物 `lib/types/runtime-types.d.ts` 含 `role?: string`；tool-subagent 检查 `src/index.ts` 与构建产物 `lib/types/index.js` 含 `role: z.string()`；settings 检查 `src/index.ts` 与构建产物 `lib/types/index.d.ts` 含 `exposeToWebClients?: boolean`；apiproxy 检查 `src/api-proxy.ts` 与构建产物 `lib/types/api-proxy.js` 含 `descriptor.exposed === true`（探针布局与真实构建产物一致，缺失记为 SKIP）。

## 自动应用（安装期）

插件在安装生命周期自动检测目标 dsh 源码树并**幂等应用全部四个 patch**（脚本 `scripts/autopatch-install.sh`，PATCH_FILES 与 `apply-dsh-patch.sh` 一致：agent → tool-subagent → settings → apiproxy；三态判定同构：可应用 → apply；已应用 → skip；冲突 → warn），无需手动执行 `apply-dsh-patch.sh`：

- **触发时机**：
  - `postinstall`：插件作为依赖被安装时（git / tarball 安装）。pnpm ≥ 10 默认不执行依赖的构建脚本，需放行后才触发（见 [docs/install.md](docs/install.md) 的 allowBuilds 说明）；
  - `prepare`：git 安装（pnpm 在克隆后构建）以及在本仓库目录执行 `pnpm install` 时；
  - **本地 link 安装（`dsh plugin --profile <name> add .`）不触发生命周期脚本**（pnpm 对 `link:` 依赖不运行 prepare/postinstall，已实证）——此类安装后请手动执行一次 `bash scripts/autopatch-install.sh`（幂等，已应用则跳过）。
- **开关**：环境变量 `DSH_LLM_FALLBACKS_AUTOPATCH`，默认开启（`1`）；`DSH_LLM_FALLBACKS_AUTOPATCH=0` 完全跳过（含 prepare 链的 autopatch 段）。
- **目标解析**：`$DSH_SOURCE_DIR` 优先，缺省 `${DSH_HOME}/source/current`；目标缺失或非 git 树 → info 跳过（退出 0）。
- **失败语义**：任何失败只 warn、**绝不导致安装失败**（退出 0）：patch 冲突 → warn 并提示手动处理（`apply-dsh-patch.sh`）；重建失败 / 缺 pnpm / 缺 node_modules → warn 并附手动重建命令；verify 探针未通过 → warn 附手动应用命令。幂等：已应用 / 已原生支持（verify 探针全部通过，即 dsh 已等价具备 role + 暴露能力）→ 跳过。
- **升级后重跑仍靠 `apply-dsh-patch.sh`**：自动应用只在插件安装时触发一次，dsh 升级重置本体改动后**不会**自动重打——升级后仍需按下文「dsh 升级后需重跑」手动执行 `apply-dsh-patch.sh` 并 `verify-dsh-patch.sh` 确认。

## dsh 升级后需重跑

dsh 升级会重置本体改动：`$DSH_HOME/source/current` 指向新的 staging 树后，重新执行 `scripts/apply-dsh-patch.sh`（幂等，已应用则跳过）并 `scripts/verify-dsh-patch.sh` 确认。若升级导致源码上下文偏移、patch 无法应用，脚本会报冲突并提示——此时可能需要按新源码行号重新生成 patch（本仓库交付的 diff 以 dsh 快照 commit `20da39e` 为基准）。

## 安全说明

- `apply` / `revert` 会在目标树执行**构建**（`pnpm exec tsc` / `tsdown`），即运行该树安装时代码——**仅应对可信的 dsh 源码树运行**；目标树由 `$DSH_SOURCE_DIR` / `$DSH_HOME` 显式指定，请确认其来源可信。
- patch 内容仅追加可选字段，不改变既有默认行为；`revert` 一键回滚，构建产物随重建还原。

## 在真实 dsh 安装上的应用

**对真实 dsh 安装的 patch 应用需由用户在自身环境执行**：本仓库的验证环境受沙箱约束，无法对运行中的 `$DSH_HOME` 安装写入（包括 apply → build 全流程）。如实说明本仓库已完成、未完成的验证：

- **已验证**：四个 patch 对真实 dsh 源码树 `git apply --check` 通过（只读校验，树保持 untouched；暴露组两 patch 在真实树 `apply --check --verbose` 全绿）；`scripts/apply-dsh-patch.sh --check` 四 patch 状态判定正确（零写入）；role 组类型正确性经真实 `tsc` 编译验证（cast 修正后 red→green，见 autopatch 计划任务 6 修复轮）；四个 patch 在沙箱拷贝的 dsh 树镜像上完整跑通 apply（顺序 agent → tool-subagent → settings → apiproxy）→ `verify-dsh-patch.sh`（role + 暴露组 src 探针全 PASS）→ revert（逆序 apiproxy → settings → tool-subagent → agent）→ `verify-dsh-patch.sh --absent` 全流程与幂等性（T6 扩展 verify 探针至暴露组后的复验；构建产物探针在真实树上的布局已核实，沙箱中缺失记为 SKIP）。
- **未验证**：在真实安装上执行 apply → build（QA gate 阶段按 [docs/verification.md](docs/verification.md) §6 全量执行并记录证据）；暴露组 patch 应用后的类型面（`SettingsDescriptor.exposed` 等）尚未在本仓开发环境编译验证——本仓链接的 `@deepseek-ai/dsh-settings` / `dsh-host-apiproxy` 类型是未打补丁的 `20da39e` 快照（T1 禁写 dsh 源树），插件侧 `exposeToWebClients: true` 的 tsc 校验留待真实宿主（patch 应用 + 重建后）验证。

**暴露组验证步骤（真实宿主，QA gate 阶段执行；role 组探针同法，见上）**：

```sh
cd <插件仓库目录>
scripts/apply-dsh-patch.sh --check    # 只读：四 patch 状态判定
scripts/apply-dsh-patch.sh            # 应用四 patch → 增量构建（tsc -b 含 settings/apiproxy + tsdown host）
scripts/verify-dsh-patch.sh           # 断言 role + 暴露组标记出现在源码与构建产物
# 应用并重建后重启 dsh（web profile）一次，使重建后的 host 包（apiproxy）加载；
# 之后打开设置页确认 Fallbacks 不再显示「未注册」，读写闭环见 docs/verification.md §6
scripts/revert-dsh-patch.sh --check   # 只读：可回滚状态判定
scripts/revert-dsh-patch.sh           # 逆序回滚（apiproxy → settings → tool-subagent → agent）→ 重建
scripts/verify-dsh-patch.sh --absent  # 断言全部标记已消失
```

应用完成后重启 dsh 会话使 `agent.options.role` 生效；暴露机制 patch 应用并重建后，若 host 进程仍加载旧构建产物，重启 dsh 使 apiproxy 暴露生效——之后设置写入经 settings 实时重读生效（无需重启会话，「保存即生效」证据链见 [docs/verification.md](docs/verification.md) §6）。
