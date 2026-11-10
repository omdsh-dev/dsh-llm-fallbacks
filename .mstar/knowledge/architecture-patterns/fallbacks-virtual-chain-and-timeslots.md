---
module: dsh-llm-fallbacks virtual chain + time slots
date: 2026-09-24
last_updated: 2026-11-08
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

# Named virtual chains: one picker row per chain + per-chain time slots (mount-only)

Catalog membership follows `ctx.llm.registerAdapter`. The config holds N NAMED
chains (`chains[]`), and the virtual adapter advertises ONE row PER chain whose
`id` IS the chain id — selecting `FallbacksChain/<chain id>` is a routing seed, and
that row's `stream()` is the fallback engine: it runs the chain walk
(`src/chain-walk.ts`) over the chain named by `options.model` — cooldown /
per-walk failed set / switch cap / recovery bookkeeping included. A chain's time
slots are lazy first-match at the next request on that chain. Slot rotation is
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

- Register the virtual adapter on content presence (`isFallbackActive`:
  `chains.length > 0`) — row visibility is conformance-independent, and
  conformance gates a successful delegate instead. Slot/chain edits must not
  churn registration; an edit that flips content presence intentionally does.
  One `registerAdapter` call serves every row, and `listModels` returns one row
  per chain (`id = chain.id`, `name = <label>: <head>[<slot>]`, bare label when
  the chain is non-dispatchable).
- `stream()` runs the walk (`src/chain-walk.ts`) for the chain named by
  `options.model`. The walk owns the pre-attempt guards (`UNKNOWN_CHAIN` for a
  deleted/renamed id, `EMPTY_EFFECTIVE_CHAIN`, `UNDISPATCHABLE_EFFECTIVE_HEAD`,
  `LLM_UNAVAILABLE`), THAT chain's tail-conformance gate (no origin split), and
  one nested `llm.stream()` per attempt. The adapter keeps the catalog +
  metadata half — `listModels`, and `resolveModel` / `imageRequestPricing`
  resolve the chain FROM the `model` argument and follow its effective head;
  those methods never throw. `providerRetryPolicy` returns `undefined`: the host
  captures the policy once per provider at registration, so one provider cannot
  mirror N heads' policies (documented degradation — the host default applies).
- **Committed rule**: the first yielded chunk commits the attempt. A
  trigger-code failure before that chunk is swallowed and walked past; any
  failure after it is booked (cooldown / recovery) and forwarded verbatim,
  because yielded chunks cannot be unsent. `llm-retry` or the terminal error
  takes over, and a retry re-enters the walk past the cooled head.
- Only a session on a virtual row walks: selecting a real provider/model leaves
  the plugin out of the request entirely (`llm-retry` alone recovers it). No
  `rootMode` key.
- A local subagent reaches a named chain through the dispatch seam stamping
  `SubagentStartRequest.agentOptions = { provider: 'FallbacksChain', model:
  <role.chain> }` at creation, when a declared role resolved, its `chain` pointer
  is non-empty AND declared, the request carries no explicit route, and the
  backend is local. An explicit request route is authorized and untouched; an
  external (acp) backend keeps pure inheritance — no chain; an unspecified role
  is the plugin not intervening. No host-policy gating (no allowlist
  intersection, no `unprovable` branch). Creation-time only, so a resumed
  child's own durable selection wins; a chain that is declared but non-conforming
  is still stamped and the walk's own gate refuses it (one gate, in the walk).
- The retired paths do not come back: the `agent/request` /
  `agent/request-error` listeners, `alwaysModeRetryCap` (no successor — the cap
  is per walk and a retry is a fresh walk), and the model-selection clobber
  workaround (`markFallbackRouted`, later a documented degradation line) are all
  gone by construction, because no listener ever rewrites the session route.
- Time slots are scoped to ONE chain (`chains[].timeSlots`): the first matching
  row is the PRIORITY segment — its entries are walked before the chain's
  `entries` (default fallback chain + official tail), which always follow and
  are de-duplicated so the official tail stays last; other chains are
  unaffected, and the rotation log is keyed per (agent, chain id). Preset rows
  freeze windows in code constants; user edits models only; preset rows lock
  `tz` to Asia/Shanghai. Valleys complement peaks. A chain's **tail** (the last
  `entries` element) is exactly one of `deepseek-official/deepseek-flash` or
  `deepseek-official/deepseek-v4-pro` (PR #125: the default catalog re-added
  `deepseek-v4-pro`, so it is the official Pro tail and the card's Pro radio is
  selectable — the old `proCaveat` always-disabled mechanism was removed;
  `deepseek-v4-flash` stays retired and illegal). Legacy hand-set
  `deepseek-official/deepseek-pro` tails read back **nonconforming** through the
  same tail gate (no migration — the id was never catalog-served nor
  selectable). The plugin still does not probe catalog availability.
- Gate every slot observation surface on the same conforming helper
  (`isAllDayConforming`, tail-based, per chain).

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
`src/index.ts`; invariants pinned by `tests/chain-walk.spec.ts`,
`tests/virtual-adapter.spec.ts` and `tests/time-slots.spec.ts` (per-chain
isolation, `UNKNOWN_CHAIN`, per-(agent, chain) rotation markers).
