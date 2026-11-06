---
module: dsh-llm-fallbacks virtual chain + time slots
date: 2026-09-24
last_updated: 2026-11-06
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: dsh-022-rc1-upgrade
applies_when:
  - A plugin needs a row in the dsh model picker without patching the host
  - A fallback engine needs a seam the host cannot reject at request time
  - Root routing should follow wall-clock windows without a host scheduler
  - Failure-walk copy must stay distinct from scheduled rotation
tags:
  - dsh
  - llm-fallbacks
  - virtual-adapter
  - chain-walk
  - time-slots
  - mount-only
---

# Virtual FallbacksChain row + time-slot seed (mount-only)

Issue #58 / PR #62 feedback: catalog membership follows `ctx.llm.registerAdapter`.
Selecting `FallbacksChain` / `自动选择` is a routing seed, and the virtual adapter's
`stream()` is the fallback engine: it runs the chain walk (`src/chain-walk.ts`) —
cooldown / per-walk failed set / switch cap / recovery bookkeeping included.
Time slots are lazy first-match at the next root request. Slot rotation is
**分时切换**; failure walk is **降级切换**. No durable `fallbacks/switch` events.

## Context

rc.7 `buildModelCatalog` iterates registered providers only. There is no picker
inject API. `dsh-schedule` is reminder traffic, not a plugin HH:mm callback.

The walk cannot live on the request waterfalls: dsh 0.2.2-rc.1 rejects a request
whose provider/model/effort differs from the step's captured selection
(`{HOST}/packages/core/agent-loop/src/agent.ts`), and `agent/request-error`'s
retry continues with that captured selection — so a listener can neither rewrite
the route nor route a retried attempt. The adapter the request already routes to is
the only seam the host cannot refuse.

## Guidance

- Register the virtual adapter on content presence (`isFallbackActive`: a
  `rootChain`, a `timeSlots` row, or a declared role) — row visibility is
  conformance-independent, and conformance gates a successful delegate instead
  (PR #62 feedback). Slot/chain edits must not churn registration; an edit that
  flips content presence intentionally does.
- `stream()` runs the walk (`src/chain-walk.ts`). The walk owns the pre-attempt
  guards (`EMPTY_EFFECTIVE_CHAIN` / `UNDISPATCHABLE_EFFECTIVE_HEAD` /
  `LLM_UNAVAILABLE`), the ROOT-only all-day conformance gate, and one nested
  `llm.stream()` per attempt. The adapter keeps the catalog + metadata half
  (`listModels`, `resolveModel`, `providerRetryPolicy`, `imageRequestPricing`
  proxy the current effective head) — those methods never throw.
- **Committed rule**: the first yielded chunk commits the attempt. A
  trigger-code failure before that chunk is swallowed and walked past; any
  failure after it is booked (cooldown / recovery) and forwarded verbatim,
  because yielded chunks cannot be unsent. `llm-retry` or the terminal error
  takes over, and a retry re-enters the walk past the cooled head.
- Only a session on the virtual pair walks: selecting a real provider/model
  leaves the plugin out of the request entirely (`llm-retry` alone recovers
  it). No `rootMode` key.
- An inheriting local subagent reaches the same row through the dispatch seam
  stamping `SubagentStartRequest.agentOptions` at creation; an explicit request
  route is authorized and untouched, and an external (acp) backend keeps pure
  inheritance — no chain. Creation-time only, so a resumed child's own durable
  selection wins.
- The retired paths do not come back: the `agent/request` /
  `agent/request-error` listeners, `alwaysModeRetryCap` (no successor — the cap
  is per walk and a retry is a fresh walk), and the model-selection clobber
  workaround (`markFallbackRouted`, later a documented degradation line) are all
  gone by construction, because no listener ever rewrites the session route.
- Preset rows freeze windows in code constants; user edits models only; preset
  rows lock `tz` to Asia/Shanghai. Valleys complement peaks. The all-day chain
  **tail** is exactly one of `deepseek-official/deepseek-flash` or
  `deepseek-official/deepseek-v4-pro` (PR #125: the default catalog re-added
  `deepseek-v4-pro`, so it is the official Pro tail and the card's Pro radio is
  selectable — the old `proCaveat` always-disabled mechanism was removed;
  `deepseek-v4-flash` stays retired and illegal). Legacy hand-set
  `deepseek-official/deepseek-pro` tails read back **nonconforming** through the
  same tail gate (no migration — the id was never catalog-served nor
  selectable). The plugin still does not probe catalog availability.
- Gate every slot observation surface on the same conforming helper (P6,
  tail-based).

## Why This Matters

A refusing `stream()` would turn `installModelSelection` outer-composition into a
hard outage. A single-frame session rewrite already burned us once (#52); durable
custom events stay retired. Putting the walk inside the adapter also means an
active model selection cannot be re-applied over a switch: the attempts are
internal to one virtual request.

## When to Apply

Next time a plugin wants a selector row, wall-clock routing, or a host-accepted
routing seam without host patches.

## Examples

See `src/virtual-adapter.ts`, `src/chain-walk.ts`, `src/time-slots.ts`,
`src/index.ts` select-is-primary + 分时 log; invariants pinned by
`tests/chain-walk.spec.ts`, `tests/virtual-adapter.spec.ts` and
`tests/time-slots.spec.ts`.
