---
module: dsh host subagent model-selection policy (as it meets dsh-llm-fallbacks)
date: 2026-08-28
last_updated: 2026-11-08
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
tags: [subagent, model-selection, allowlist, fallback-chain, dsh-0.1.2, policy]
plan_id: named-virtual-chains
related_components: [src/subagents-seam.ts, src/chain-walk.ts, src/index.ts]
applies_when:
  - dsh host exposes a subagent child-model selection policy (0.1.2+ subagent-model-selection-settings)
  - deciding whether a plugin that routes subagent LLM calls must consult that policy
  - a user assigns a fallback chain to a role or a dispatch and expects it to apply
---

# dsh subagent model-selection policy: host-enforced, not plugin-reconciled

dsh 0.1.2 gives a host an **opt-in child-model selection policy**. It is enforced
entirely inside the host's subagent tool, at the operation that creates the child; a
plugin that routes child LLM calls does not read it. This document records what the
policy actually is (so a user assigning a chain to a role knows what constrains the
dispatch), and why dsh-llm-fallbacks stopped consulting it.

## Context

A host composes the tool-subagent plugin; the user enables a settings preference that
lists the exact `provider/model` routes a child may be explicitly put on. The policy is
recorded per Session and enforced on every delegation. Two things it does **not** do:
it does not constrain a child that inherits the parent's route (no model-facing choice
happened), and it does not reach into a provider's own internals — a virtual route is a
single provider as far as the policy is concerned.

## Guidance

### What the host owns (durable facts)

- **Settings namespace `subagent-model-selection-settings`** (`{ enabled, allowedModels }`,
  shipped default `enabled: false`). `allowedModels` is an exact-route list
  `{ provider, model }[]`; `enabled` is the opt-in. Both are volatile deployment bases
  the user document may override.
- **Recording point is Session creation, not request time.** The host samples the
  preference when a NEW top-level Session is created and writes it into a durable
  session projection (`subagentModelSelectionPolicy`, stateVersion 1). A later settings
  change does not retroactively authorize an existing session.
- **Per-session event payload**: the projection initializes to `null` and accepts one
  `subagent/model-selection-policy` event whose data is `{ allowedModels: { provider,
  model }[] }` — at least one route (`assertAllowedModelRoutes` rejects malformed or
  duplicate entries, an empty list throws). The reader
  (`subagentModelSelectionPolicy(handle, session)`) returns a detached route list, or
  `undefined` when the session recorded none.
- **`undefined` has a meaning, and it is not "allow everything"**: without a recorded
  policy, an EXPLICIT selection — including a bare `reasoning_effort`, which counts as a
  selection — is limited to the parent route.

### The one enforcement point

`assertAllowedModelSelection(policy, parentOptions, requested, request)` runs in the
tool's delegation path, before the child is created. Its branches, in order:

1. no model-facing field in the request (`provider` / `model` / `reasoning_effort` all
   absent) ⇒ return: pure inheritance sits outside the policy entirely;
2. resolve the effective pair (`requested` first, then `parentOptions`) — a missing
   provider or model throws (`cannot select child LLM values without an effective
   provider and model`);
3. `policy === undefined` ⇒ the pair must equal the parent's route, else throw with
   `… explicit selection (including reasoning_effort) is limited to the parent route`;
4. otherwise the pair must be a member of `policy.routes`, else
   `child LLM route "<provider>/<model>" is not allowed for this Session`.

Two neighbours complete the picture and are worth knowing before debugging a dispatch:

- `requestedAgentOptions(parentOptions, configured, request, enabled)` merges the
  model-facing fields. `enabled === false` throws `child model selection is disabled for
  this tool instance`; `provider` and `model` must be supplied **together**; a route
  change without an explicit `reasoning_effort` drops the configured route-owned effort
  (the effort never rides across a route change it was not given for).
- `preflightChildLlmRoute(...)` resolves the effective route through the live adapter
  (`llm.resolveCallConfig`) before creation — unregistered provider, unknown model and
  invalid effort all fail there, independently of the allowlist.

### dsh-llm-fallbacks does not read or consult the policy

The plugin used to reconcile with it (`src/subagent-policy.ts`, `src/route-allowlist.ts`,
a per-session policy read, an allowlist intersection over candidate order, an
`unprovable` fail-closed branch, an in-memory blocked-attempt record, a card status area
with a manual sync button, and a `subagentPolicy` wire field). All of that is **deleted**
and has no successor. Why:

- The plugin's only routing act is the dispatch-time stamp
  `{ provider: 'FallbacksChain', model: <role.chain> }` onto a child's creation options.
  That is the **operator's static config** — the value comes from `roles.list[].chain`,
  a pointer the user typed — not a model-authored route chosen on the child's behalf.
  Intersecting a user's own configuration with a host allowlist answered a question
  nobody asked.
- The allowlist's own escape hatch pointed the same way: the parent is already on the
  virtual route, so a stamped child inherits a route the user selected for the session.
- One reader, one enforcement point. A second policy implementation inside the plugin
  could only disagree with the host's, and its `unprovable` branch turned a settings
  read failure into a routing outage.

### Consequence (accepted and documented)

- **In-chain switches are not allowlist-filtered.** Once a child is on
  `FallbacksChain/<chain id>`, the walk moves between that chain's entries on a failure
  code; the host policy is not consulted per attempt (and cannot be — it has no view
  inside a provider). Every entry is an operator-authored choice, so the filtered set and
  the authored set are the same list by construction: the chain IS the allowlist for
  that route.
- **A dispatch that carries an explicit route is still the host's business.** When the
  spawn request already names `provider` / `model`, the seam does nothing (explicit is
  authorized), and the host's `assertAllowedModelSelection` decides whether that
  explicit choice is legal — exactly as it would for a plugin-free dispatch.
- **A pure-inheritance child is outside the policy** and, with the plugin, outside any
  chain: it keeps the parent's real route and `llm-retry` alone recovers it.
- There is no `unprovable` state any more: the plugin reads no policy, so no settings
  read can fail into a routing decision.

### What a user still hits

| Situation | Who decides | Result |
|---|---|---|
| Role has a chain pointer, dispatch has no explicit route | plugin seam (local backend only) | child runs `FallbacksChain/<chain id>`; in-chain switches unfiltered |
| Role has no pointer / undeclared pointer | nobody — NOT SPECIFIED | child inherits the delegating agent's route; no chain |
| Dispatch carries explicit `provider`/`model` | host `assertAllowedModelSelection` (+ preflight) | plugin leaves the route untouched; the host accepts or throws |
| Session never recorded a policy | host, branch 3 | explicit selection limited to the parent route |

## Why This Matters

Two plugins that both decide a child's model is one too many. Keeping the allowlist in
the host and the chain in the config removes the possibility of the two disagreeing, and
it makes the failure modes legible: a rejected explicit route is a host diagnostic with
the host's wording, and an in-chain switch is a log line about a list the user wrote.
The deleted reconciliation also removed a whole class of "settings read failed, so
routing went fail-closed" incidents.

## When to Apply

- Reconciling any host-side authorization with a plugin-side routing decision: check
  whether the plugin is choosing a route on someone's behalf (then ask the host first) or
  applying the operator's own static config (then do not).
- Debugging a delegation whose explicit `provider`/`model` was rejected, or whose
  `reasoning_effort` did not survive a route change — both are host-side rules above.
- Re-verifying the payload shape after a host upgrade: the projection accepts a single
  `subagent/model-selection-policy` event and requires at least one route.

## Examples

Host enforcement, condensed (the tool's own function, not plugin code):

```ts
function assertAllowedModelSelection(policy, parentOptions, requested, request) {
  if (!hasDelegationModelRequest(request)) return                 // pure inheritance
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) throw new Error('…effective provider and model')
  if (policy === undefined ? provider === parentOptions.provider && model === parentOptions.model
                           : policy.routes.some(r => r.provider === provider && r.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session` + …)
}
```

The plugin's whole contribution (four conditions, no policy read):

```ts
if (role.chain === undefined || role.chain === '') return undefined            // NOT SPECIFIED
if (!config.chains.some(chain => chain.id === role.chain)) return undefined    // undeclared pointer
if (agentOptions?.provider !== undefined || agentOptions?.model !== undefined) return undefined // authorized
return { request: { ...spec.request,
  agentOptions: { ...agentOptions, provider: 'FallbacksChain', model: role.chain } } }
```

*Source: iteration `iter-20260828-dsh-012-adoption/specs/subagent-routing-policy.md` for
the host facts (verified against `@deepseek-ai/dsh-tool-subagent`'s
`model-selection.d.ts` / `model-selection-settings.d.ts` at dsh 0.2.2-rc.1); plan
`named-virtual-chains` for the reconciliation's removal (2026-11-08).*
