---
module: dsh-llm-fallbacks
date: 2026-08-10
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: llm-fallbacks-plugin
applies_when:
  - 在 dsh 中实现模型/请求级自动恢复或路由切换功能
  - 需要理解 omp llm-fallbacks 语义如何落到 dsh 事件面
  - 需要扩展或维护 dsh-llm-fallbacks 插件
tags:
  - dsh
  - llm-fallbacks
  - agent
  - fallback-chains
  - request-error
---

# dsh LLM fallback 架构：双 waterfall 恢复模式

将 omp 的 retry.modelFallback / retry.fallbackChains 语义移植到 dsh 时的已验证架构（iter-20260810-llm-fallbacks 产物，随实现验证）。

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

### 已知限制（open residual）

- 活跃 model-selection（installModelSelection 先注册且 selection 活跃）会在 fallback 覆写之上再次应用外层 selection，路由最终指向用户所选模型（切换仍决策/事件化）；协调 seam 需 dsh 核心决策。
  > **注（iter-20260810-fallbacks-settings-ux 规划）**：本条限制由该迭代 R2 关闭（A1 标记让位机制，见该迭代 spec §2.5 D-1 / plan T2）处理；落地后本条应从「已知限制」移除或改写（iteration-close compound-refresh 时执行）。
- 失败码默认 ['AUTH','QUOTA','RATE_LIMIT']；5xx/TRANSPORT 等由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策，无需额外配置。

## Why This Matters

恢复语义归属（request-error 拥有恢复 vs request 路由覆写）分离使插件完全自包含、零侵入 dsh 核心；llm-retry 共存顺序与 always-cap 边界是移植中最易出错的两处，均有测试固化（双插件共存矩阵、mutation-red 验证）。

## When to Apply

- dsh 内任何「失败后换模型/换路由继续」类功能（retry、fallback、模型降级、按负载分流）。
- 需要理解 fallbacks/switch 事件、fallbacks settings 命名空间或 selector 语法时。

## Examples

- 链配置示例见本插件 docs/configuration.md（仓库内）。
- 集成测试矩阵：tests/coexist-llm-retry.spec.ts、tests/always-mode.spec.ts、tests/plugin.spec.ts。

*Source: iteration iter-20260810-llm-fallbacks，由 specs/llm-fallbacks-spec.md 提升。*
