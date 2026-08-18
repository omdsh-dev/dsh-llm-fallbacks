---
module: dsh-llm-fallbacks virtual chain + time slots
date: 2026-08-18
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: fallbacks-virtual-chain
applies_when:
  - A plugin needs a row in the dsh model picker without patching the host
  - Root routing should follow wall-clock windows without a host scheduler
  - Failure-walk copy must stay distinct from scheduled rotation
tags:
  - dsh
  - llm-fallbacks
  - virtual-adapter
  - time-slots
  - mount-only
---

# Virtual FallbacksChain row + time-slot seed (mount-only)

Issue #58 / iter-20260818 (PR #62 feedback round 2026-08-18): catalog membership follows `ctx.llm.registerAdapter`. Selecting `FallbacksChain` / `自动选择` is a routing seed; `agent/request` remains the only fallback engine. Time slots are lazy first-match at the next root request. Slot rotation is **分时切换**; failure walk is **降级切换**. No durable `fallbacks/switch` events.

## Context

rc.7 `buildModelCatalog` iterates registered providers only. There is no picker inject API. `dsh-schedule` is reminder traffic, not a plugin HH:mm callback.

## Guidance

- Register a virtual adapter whenever `enabled` (PR #62 feedback: row visibility is conformance-independent). Slot/chain edits must not churn registration.
- `stream()` is a thin delegate to `firstDispatchableExactHead(resolveEffectiveChain(...))` — gated on a conforming all-day TAIL (last entry an official V4; leading 默认降级链 entries walked first). Do not walk cooldown / maxSwitches inside the adapter.
- Selecting the virtual pair = primary. Selecting a real pair = v0.2.2 fallback-only. No `rootMode` key.
- Preset rows freeze windows in code constants; user edits models only; preset rows lock `tz` to Asia/Shanghai. Valleys complement peaks. The all-day chain **tail** is exactly one of `deepseek-official/deepseek-v4-flash` or `deepseek-official/deepseek-v4-pro`.
- Gate every slot observation surface on the same conforming helper (P6, tail-based).

## Why This Matters

A refusing `stream()` would turn `installModelSelection` outer-composition into a hard outage. A single-frame session rewrite already burned us once (#52); durable custom events stay retired.

## When to Apply

Next time a plugin wants a selector row or wall-clock routing without host patches.

## Examples

See `src/virtual-adapter.ts`, `src/time-slots.ts`, `src/index.ts` select-is-primary + 分时 log.
