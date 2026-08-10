---
module: dsh-llm-fallbacks
date: 2026-08-11
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: llm-fallbacks-settings-runtime
applies_when:
  - 在 dsh 中实现模型/请求级自动恢复或路由切换功能
  - 需要理解 omp llm-fallbacks 语义如何落到 dsh 事件面
  - 需要扩展或维护 dsh-llm-fallbacks 插件
  - 插件需要把自有 settings 命名空间暴露给 web 设置客户端（dsh 暴露机制）
  - 需要与 dsh 的 model-selection（installModelSelection）协调路由
tags:
  - dsh
  - llm-fallbacks
  - agent
  - fallback-chains
  - request-error
  - settings-exposure
  - model-selection
---

# dsh LLM fallback 架构：双 waterfall 恢复模式 + 设置面/路由协调

将 omp 的 retry.modelFallback / retry.fallbackChains 语义移植到 dsh 时的已验证架构（iter-20260810-llm-fallbacks 产物，随实现验证），以及后续迭代（iter-20260810-fallbacks-settings-ux）验证的设置页暴露、model-selection 协调、目录驱动选择与状态块真实化。

## Context

dsh 的 agent loop 在模型请求失败时派发 agent/request-error waterfall；llm-retry 插件（dsh-base 内置）按 provider 的 retryPolicy 做同模型退避重试，预算耗尽或不可重试码（AUTH/QUOTA）时 next() 委托下游；mode:'always' 时 llm-retry 先委托下游再退避。模型选择经 agent/request waterfall 返回的 LlmCallConfig 决定（seed → waterfall → prepareCall）。失败码 taxonomy：AUTH(401/403)、QUOTA（QUOTA_EXCEEDED_CODE）、RATE_LIMIT(429)、CONTEXT_WINDOW_EXCEEDED 等。

## Guidance

### 核心模式：决策在 request-error、应用在 request（ADR-1/ADR-4）

1. agent/request-error 监听（注册在 llm-retry 之后）：未启用 / code 不在 triggerCodes → next()（always 模式同样透传）；命中候选 → 写每-agent pendingSwitch + cooldown 抑制 + stepFailures 记账 + append fallbacks/switch 事件 → 返回 {kind:'retry'}（拥有恢复，不调 next）。无候选 / 安全阀超限 → next()（原错误语义不变）。
2. agent/request 监听：await next() 后应用 pendingSwitch（provider/model 覆写、丢弃继承的 reasoningEffort——installModelSelection 的 withoutInheritedEffort 模式）并清除；appliedTurnStep 防重放。
3. 候选过滤：当前模型 / 冷却中 / 本步已失败 / provider/* 条目目标 provider 无此模型 id（存在性探针，仅 wildcard 条目受探针约束；exact 条目永不探针过滤）。

### 链解析（omp fallbackChains 语义）

specificity：exact provider/model 键 → provider/* 键 → 角色链 → default 链。条目 provider/* = 保留失败模型 id 仅换 provider。角色源顺序：agent.options.role（dsh role patch 后）→ roles.rules 顺序匹配（origin/provider/model）→ roles.default。

### 冷却与安全阀

cooldownMs 内被切离/失败模型不入选；revertPolicy: 'cooldown-expiry' 到期回主、'never' 用 Infinity TTL 会话内不回。每 step 失败模型集合 + maxSwitchesPerStep 双重防护；链耗尽保持原 LlmError 语义。

### mode:'always' 的 cap（ADR-2）

llm-retry always 模式先 next() 委托下游——若在 request-error 直接切换会抢占退避。故 cap 在 agent/request 边界生效：按 (turn, step, provider) 计数已持久化 llm/retry 事件（只计 mode === 'always' 条目）≥ alwaysModeRetryCap 才切换。

### 状态机（每-agent）

Map<agent.id, AgentFallbackState>：pendingSwitch（产生→应用→清除；同 (turn,step) 链式切换靠 writePending 清 appliedTurnStep）、stepFailures（step 推进重置）、cooldown（跨 idle 保留——US-4 跨 turn 回主需要）、agent/disposed 清理、插件 dispose 整体清空（无残留）。

### model-selection 协调：A1 标记让位（R2 关闭，iter-20260810-fallbacks-settings-ux）

真实组合下 `installModelSelection`（web 前端门 per-agent 注册、先于插件）在 `agent/request` 的 `await next()` 之后重新套用会话选择，会把 fallback 切换覆写回去。修复（spec §2.5 D-1）：
- **标记载体**：被 patch 的 `@deepseek-ai/dsh-agent` `model-selection.ts` 内模块级 `WeakSet<LlmCallConfig>` + 导出 `markFallbackRouted(config): LlmCallConfig` / `isFallbackRouted(config): boolean`（`markAgentLoopRequest` 同款进程内标记模式）。
- **传递路径**：插件 `agent/request` 两处 overrideConfig 返回点（trigger-code / always-cap）打标记——**只标记自建 spread 新对象，绝不 mutate LOOP 深冻结 seed**；外层 model-selection listener `await next()` 收到同一对象 → `isFallbackRouted(resolved)` 命中即 `return resolved`（跳过覆写，`selection` 引用不动）。
- **语义边界**：标记仅存活于当步请求对象（WeakSet 弱引用 + 每请求新建对象）→ 仅当步让位、下步骤恢复用户选择。
- **注册表同一性**：`markFallbackRouted` value import + peerDependency + 构建 external（tsdown `neverBundle`）保证单进程单一模块实例共享 WeakSet；构建内联/双实例会导致注册表分裂、协调静默失效——QA gate 真实宿主验证模块实例。
- **未打补丁宿主降级（关键交付纪律）**：插件用 **namespace import + 可选调用守卫**（`agentNs.markFallbackRouted?.(routed) ?? routed`）——静态具名 import 在未打补丁 dsh-agent（ESM 无该导出）下会 link 期失败或切换点 TypeError；守卫使缺 patch 宿主退回分支前语义（不标记 → selection 复选）。配套：`tests/unpatched-host.spec.ts` 模拟无导出模块钉住降级；ambient 类型 shim（`src/dsh-patch-ambient.d.ts`，`export {}` 使其成为 module augmentation 而非遮蔽）使 dev 构建 tsc 转绿。

### 设置命名空间 web 暴露：通用 opt-in 机制（iter-20260810-fallbacks-settings-ux）

dsh 的 web 设置 RPC（`dsh-host-apiproxy`）对命名空间有**硬编码暴露白名单**（model-provider ns + `permission`/`locale`/`ui-conversation`/`ui-theme` + `ui-onboarding`/agent-presets），插件命名空间默认不可读写（describe 过滤 + `settings-not-exposed` 拒绝）。修复（spec §2.5 D-2，patch 交付）：
- **dsh-settings patch**（仅 `settings/src/index.ts`，6 触点）：`SettingsRegisterOptions.exposeToWebClients?: boolean`（默认 false）+ 内部 `SettingsRegistration.exposed` + `SettingsDescriptor.exposed`（describe 输出新增可选字段，**行为兼容非逐位一致**——wire 增量字段客户端容忍）+ `SettingsSectionHooks`/`installSettingsSection` 透传。
- **apiproxy patch**（仅 `api-proxy.ts`，`exposedNamespaces()` 单点）：并集之上追加 `settings.describe({ redactSecrets: true })` 中 `descriptor.exposed === true` 的命名空间；`settingsWrite` 与 describe RPC 过滤零改动（统一经 `exposedNamespaces()` 判定）。循环需 `typeof descriptor.ns === 'string'` 防御 + try/catch（单注册 describe 抛错仅跳过）。
- **插件声明**：`installSettingsSection(ctx, ns, schema, entry, { exposeToWebClients: true, ... })`。
- 佐证：上游把 `'advisor'` 移出硬编码白名单——web profile 同装 dsh-advisor 同病，通用 opt-in 是正解。

### 目录驱动 provider/model 选择（iter-20260810-fallbacks-settings-ux，spec §2.5 D-3/D-4）

- **数据源**：`llm.providers({})`（可配置 provider 目录）+ `llm.models({})`（`{ groups, failures }` 模型目录）；`models/changed` 客户端事件刷新。
- **store catalog 快照**：独立 `loadCatalog()` + 独立 generation guard；`models/changed` **只**刷 catalog、`connection/reset` 全刷；failures 降级诊断不拖垮 groups；catalog 失败不阻塞表单（settings 状态零触碰）。
- **混合下拉**：provider select + model select 级联 + `provider/*` 通配（不依赖 models）+ 目录外合成选项（原值 + 「（目录外）」标注，value 携带原始字符串、读回默认选中）——**目录外值 round-trip 无损**，仅新增条目受限目录；行编辑态判别联合 `{kind:'catalog',id}|{kind:'outside',raw}|null`；序列化仍写原始字符串（`provider/model`、`provider/*`、链 key 自由文本语义不变）。

### 设置页只读状态块真实化（R1 关闭，spec §2.5 D-5/D-6）

- **读取面**：`connection.api.sessions.history({ sessionId, maxMessages })` 原始事件面（`HistoryEntry.event` 含 `fallbacks/switch`）——**不用** `ctx.sessionHistory`（公开快照只含投影会话对话，无原始自定义事件）；当前会话 `ctx.sessions.list` current（注意 host/client Context merge 冲突——`ctx.get('sessions') as unknown as ISessions`，且 client fiber 的 `sessions` 注入应可选降级）；单页 50、seq 倒序取 N=5、会话切换重载、错误隔离不碰 settings 状态。
- **展示值推导**（非实时路由探测，恒附注）：未启用/空链 → 空态；有最近切换 → 最新 `to`；无切换 → 配置摘要链首项。

### patch 交付纪律（本仓库惯例）

- **只读创作**：patch 由 dsh 源树（`$DSH_SOURCE_DIR`）只读提取 + /tmp 副本精确替换 + `diff -u` + blob hash（`git ls-files -s` pre / `git hash-object` post）+ `git apply --check`（只读）验证；**不写 dsh 源树**（沙箱外）。
- **脚本**：apply 正序（agent → tool-subagent → settings → apiproxy）/ revert 逆序；git 判定需 **gitfile 感知**（`git -C "$TARGET" rev-parse --git-dir`——真实 `$DSH_SOURCE_DIR` 是 gitfile worktree，`.git` 为文件）；verify 探针覆盖 src + 构建产物；幂等（forward/reverse check）。
- **安装期**：autopatch 失败仅 warn 不破坏安装；跳过消息如实区分「缺失」与「非 git 树」。

### 已知限制（open residual）

- 失败码默认 ['AUTH','QUOTA','RATE_LIMIT']；5xx/TRANSPORT 等由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策，无需额外配置。

## Why This Matters

恢复语义归属（request-error 拥有恢复 vs request 路由覆写）分离使插件完全自包含、零侵入 dsh 核心；llm-retry 共存顺序与 always-cap 边界是移植中最易出错的两处，均有测试固化（双插件共存矩阵、mutation-red 验证）。后续迭代验证的两条 dsh 集成 seam（设置暴露 opt-in、model-selection 标记让位）都是「核心单点 + 插件声明」的最小侵入形态；未打补丁宿主降级与 ambient shim 是「patch 交付 + 本地开发」双态共存的必要纪律。

## When to Apply

- dsh 内任何「失败后换模型/换路由继续」类功能（retry、fallback、模型降级、按负载分流）。
- 需要理解 fallbacks/switch 事件、fallbacks settings 命名空间或 selector 语法时。
- 插件需要 web 设置读写（dsh 暴露机制）或与 model-selection 协调路由时。
- 需要为 dsh 交付 git patch（只读创作 + gitfile 感知脚本 + 未打补丁降级）时。

## Examples

- 链配置示例见本插件 docs/configuration.md（仓库内）。
- 集成测试矩阵：tests/coexist-llm-retry.spec.ts、tests/always-mode.spec.ts、tests/plugin.spec.ts、tests/unpatched-host.spec.ts。
- 设置页/目录/状态块：tests/fallbacks-store.spec.ts（61 用例）。
- 真实宿主端到端剧本：docs/verification.md §6（QA gate）。

*Source: iteration iter-20260810-llm-fallbacks（specs/llm-fallbacks-spec.md）+ iter-20260810-fallbacks-settings-ux（specs/fallbacks-settings-runtime-spec.md，D-1..D-6 提升），随实现验证。*
