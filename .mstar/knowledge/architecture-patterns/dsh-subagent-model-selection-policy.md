---
module: dsh-llm-fallbacks / subagent routing
date: 2026-08-28
last_updated: 2026-08-28
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
tags: [subagent, model-selection, allowlist, fallback-chain, dsh-0.1.2, policy]
plan_id: dsh-012-subagent-routing
related_components: [src/subagent-policy.ts, src/route-allowlist.ts, src/authorized-route.ts, src/override.ts, src/index.ts]
applies_when:
  - dsh host exposes a subagent child-model selection policy (0.1.2+ `subagent-model-selection`)
  - a plugin injects or switches LLM routes for subagent requests
  - reconciling host authorization with plugin-side route behavior
---

# dsh subagent model-selection policy reconciliation (0.1.2)

## Context

dsh 0.1.2 gives hosts an optional child-model selection policy: a
`subagent-model-selection` settings allowlist, a per-session
`subagent/model-selection-policy` event (payload `{ allowedModels: {provider,
model}[] }`), and spawn-time routing (`agentOptions` → `resolveChildAgentOptions`
→ durable `request/header`). A fallbacks plugin that also rewrites subagent
routes will fight this policy unless reconciled.

## Guidance (locked design, shipped 2026-08-28)

- **Allowlist = hard constraint, not a hint.** When the policy is enabled, a
  plugin-originated route (inject head or failure-switch target) must be the
  exact `provider+model` intersection of the plugin's resolved candidates with
  `allowedModels`. Empty intersection ⇒ **no inject / no switch** (host seed
  stands, warn + in-memory blocked-attempt record). Policy `disabled/absent` ⇒
  legacy behavior byte-identical. Unknown/unreadable policy (`unprovable`) ⇒
  fail-closed: no plugin selection at all.
- **Authorized route beats injection.** If the child carries an explicit
  spawn-selected `provider/model` (durable `request/header` config /
  `model/selection` event newest-match; `agent.options` as pre-first-request
  fallback), that route is the chain head and role-inject is **skipped**. Only
  pure inheritance (child options equal the provable parent baseline) goes
  through role resolution. Known limit: an explicit spawn of the parent's
  current route is indistinguishable from inheritance (no child-side spawn
  marker in 0.1.2) — same-route inject is a no-op, so D1 holds.
- **Internal delegation of an explicitly chosen virtual route is not selection.**
  A subagent spawned on the plugin's own `FallbacksChain/Auto` provider is
  user-authorized for that route; the adapter's internal head delegation is the
  route's documented purpose and sits outside the allowlist's selection
  semantics. (Documented carve-out — do not "fix" by gating the adapter.)
- **Effort rule is policy-independent** (upstream `resolveChildAgentOptions`):
  same route → keep `reasoningEffort`; route change without explicit effort →
  drop; explicit → keep. Apply on every override path via one pure rule; never
  unconditionally strip.
- **Read order:** session `subagent/model-selection-policy` event first, host
  settings service second. `subagentModelSelectionPolicy(session)` is NOT
  published from `@deepseek-ai/dsh-tool-subagent` (and it throws on malformed
  payloads) — read the event structurally and declare a type-only
  `SessionEventMap` augmentation mirroring the payload exactly; type the
  settings service via the published
  `@deepseek-ai/dsh-tool-subagent/model-selection-settings` subpath (type-only
  peer import). Never import unpublished symbols.
- **Hardening:** keep the last known policy snapshot per agent (wiring-level
  state, pruned on agent dispose) so a settings-service disappearance
  mid-session fails to the last known allowlist instead of fail-open.
- **Pure cores + thin wiring:** policy reader / allowlist intersection /
  authorized-route detection / effort rule live in host-free modules (plain
  data in, results out, never throw); `src/index.ts` only feeds data and applies
  results. Card/UI reads policy state only through the plugin gateway payload.

## Why This Matters

Without this reconciliation the plugin overwrites host-authorized child routes
on first request, switches to disallowed models on failure, strips
`reasoningEffort` across routes, and renders a second, conflicting policy in
the settings card — every one of which dsh 0.1.2's authorization model treats
as a violation.

## When to Apply

Any mount-only plugin that rewrites LLM routes for subagents on dsh ≥ 0.1.2,
and any future dsh version that evolves `subagent-model-selection` (re-verify
the payload shape and spawn-marker availability first — a future explicit
spawn marker retires the known inheritance-discrimination limit).

## Examples

Shipped in dsh-llm-fallbacks `plan/dsh-012-subagent-routing` (modules above);
card display under `#fallbacks-subagents`; failure-switch intersection in
`decide()`. Promoted from the iteration spec
`iterations/iter-20260828-dsh-012-adoption/specs/subagent-routing-policy.md`.
