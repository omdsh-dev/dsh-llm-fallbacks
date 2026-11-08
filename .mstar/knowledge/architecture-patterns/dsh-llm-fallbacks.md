---
module: dsh-llm-fallbacks
date: 2026-08-11
last_updated: 2026-11-08
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: named-virtual-chains
applies_when:
  - Implementing model- or request-level automatic recovery or route switching in dsh
  - Mapping omp retry.modelFallback / retry.fallbackChains semantics onto the dsh stream seam
  - Extending or maintaining the dsh-llm-fallbacks plugin
  - Exposing plugin configuration to web settings clients (own gateway channel /api/fallbacks/get|set|reset)
  - Mounting subagents on a virtual route, or coordinating with dsh model selection
  - Understanding the named-chain config model (chains[] + a role chain POINTER) or migrating the v1 two-block keys
  - Understanding the role-seeds capability (companion-declared roles, seed default + override + revert)
tags:
  - dsh
  - llm-fallbacks
  - chain-walk
  - fallback-chains
  - virtual-adapter
  - settings-exposure
  - model-selection
  - mount-only
---

# dsh LLM fallback architecture: the chain walk inside the virtual adapter

How omp's `retry.modelFallback` / `retry.fallbackChains` semantics land on dsh: the
config holds N **named virtual chains**, the virtual adapter advertises one
`FallbacksChain/<chain id>` picker row per chain, and the fallback decision runs
inside that row's `stream()` (`src/chain-walk.ts`) — plus the configuration,
settings, seed and routing surfaces around it. Only a session routed to one of those
rows has a chain.

## Context

dsh reports a failed model request as a terminal `finish` chunk on the `llm/stream`
waterfall. llm-retry (dsh-base, composed before this plugin) backs off same-model
retries per the provider `retryPolicy`, and delegates downstream once its budget is
spent or the code is non-retryable (AUTH / QUOTA). Failure-code taxonomy: AUTH
(401/403), QUOTA, RATE_LIMIT (429), CONTEXT_WINDOW_EXCEEDED.

The pre-upgrade plugin decided at the `agent/request-error` waterfall and applied a
provider/model override at the next `agent/request`. dsh 0.2.2-rc.1 closes that path
on both ends: the agent loop throws when a request carries a provider/model/effort
different from the step's captured selection
(`{HOST}/packages/core/agent-loop/src/agent.ts`), and an `agent/request-error` retry
continues with the captured selection, so a listener cannot route the retried attempt
either. `agent/request` is deprecated upstream ("do not add `agent/request`
listeners"). The plugin therefore switches at the one seam the host cannot reject:
the adapter the request already resolves to.

## Guidance

### The walk is the fallback engine (decision and application at one seam)

1. **One walk per virtual call.** `FallbacksChainAdapter.stream()` returns
   `walkChain` (`src/chain-walk.ts`). Start takes the chain id from `options.model`
   (the row id IS the chain id) and throws synchronously before the first chunk when
   no attempt can start: `UNKNOWN_CHAIN` (a chain deleted or renamed while a session
   still selects it), `EMPTY_EFFECTIVE_CHAIN`, `UNDISPATCHABLE_EFFECTIVE_HEAD`
   (non-conforming tail, wildcard, malformed or self-route head — the recursion
   guard), or `LLM_UNAVAILABLE`. Every walk requires ITS chain's tail to conform;
   there is no root/child split.
2. **Per attempt**: a nested `llm.stream({ ...options, provider, model })`, every
   chunk yielded as it arrives. The first yielded chunk **commits** the attempt.
3. **Uncommitted trigger-code failure**: the finish is swallowed, the route is booked
   and the chain is expanded from it; the next surviving candidate becomes attempt
   N+1. Expansion filters keep their meaning: same-as-current (the route that just
   failed), cooldown (cross-call memory), this walk's failed set, the `provider/*`
   existence probe (wildcard entries only — exact entries are never probe-filtered),
   and the context-window fit (only for a CONTEXT_WINDOW_EXCEEDED trigger).
   `provider/*` keeps the request's model id and swaps only the provider.
4. **The committed rule.** After the first chunk a failure can no longer be replayed:
   yielded chunks cannot be unsent, so a second provider's output cannot be
   concatenated behind a partial one. Such a failure is still **booked** (cooldown /
   recovery) before it is forwarded verbatim — the attempt boundary is where both
   transactions happen. llm-retry (or the terminal error) settles the partial
   attempt, and a retry re-enters the walk, which resumes past the cooled head on its
   own.
5. **Exhaustion or cap.** `maxSwitchesPerStep` counts switches per walk (attempts ≤
   cap + 1). At exhaustion the last attempt's terminal finish is re-emitted verbatim,
   so the original error semantics survive and a chain loop cannot amplify latency.
6. **Invariants**: exactly one terminal `finish` per walk; no attempt's provider is
   ever `FallbacksChain`; no durable `fallbacks/switch` event is written (issue #52 —
   the switch is an info log line carrying from/to/role/reason/candidates).
7. **Request-scoped codes.** `CONTEXT_WINDOW_EXCEEDED` records the failed key for the
   walk but writes no cooldown and no recovery counter — the route is healthy and the
   request was too big, so cooling it would send the next short prompt to the
   fallback. Every other trigger code is route-scoped. A request-scoped failure also
   does not push a later walk past the head.

### Scope: only the virtual row walks

A session has plugin fallback **iff** its model selection routes to one of the
`FallbacksChain/<chain id>` rows — the root agent by selection, a subagent whose role
points at that chain by seam stamp. A real provider/model selection, root or
subagent, gets `llm-retry` only;
nothing in this plugin rewrites its route. This is the locked product decision, not a
degradation: the alternative (a listener rewriting `agent/request`) is rejected at
runtime.

The rows are visible whenever a chain is configured (`isFallbackActive` =
`chains.length > 0`) — conformance gates the delegate, not the row.
No **model-selection coordination** is needed, and the former registration-order
clobber is gone by construction: the walk dispatches each attempt itself inside the
virtual request, so an active session selection can never be re-applied over a
switch. That retired three things at once — the `markFallbackRouted` host patch, the
documented degradation, and the card's `status.selectionNote` line.

### Subagent mount at the dispatch seam

A local child reaches a named chain through `SubagentStartRequest.agentOptions`: the
seam stamps `{ provider: 'FallbacksChain', model: <role.chain> }`, which the host
merges over the parent's route when the child is created. Four conditions must hold:

1. a role resolved at dispatch (the explicit `agentPreset` header, or the child
   prompt's `**Execute as**: <id>` header — two stages, no rules stage);
2. that role's `chain` POINTER is non-empty **and** names a declared `chains[].id` —
   an absent pointer, an empty string or an undeclared id all mean NOT SPECIFIED, and
   the plugin does not intervene;
3. the request carries **no** explicit `agentOptions.provider` / `.model` — an
   explicit pair is **authorized** and never touched;
4. the backend is local.

There is **no host-policy consultation**: the mapping is the operator's static config,
not the plugin choosing a route — no allowlist intersection, no `unprovable`
fail-closed branch, no blocked-switch record, no `virtualRouteInjected` marker. The
accepted degradation that follows: a switch INSIDE a stamped child's chain is not
filtered by the host allowlist (the chain is hand-written config, every entry an
explicit choice).

The seam does **not** double-gate conformance: a declared but non-conforming chain is
stamped and the walk's own gate refuses it (one gate, in the walk). Mounting is
creation-time only, so a resumed child's own durable selection always wins and is never
re-stamped. External (acp) backends create no local agent and cannot resolve the
virtual provider out of process — they keep pure inheritance, i.e. no chain.
### Config model and chain resolution (named chains)

**The chain list — `chains[]`**: each entry is `{ id, label, entries, timeSlots? }`.
`id` is the picker model id (`FallbacksChain/<id>`), case-sensitive and unique,
constrained by `/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/`; `label` is display-only (tab title
and picker prefix) so renaming it can never orphan a saved selection; `entries` is the
默认降级链 followed by the 默认模型 tail (exactly one official model, Flash XOR Pro);
`timeSlots` are scoped to that chain. Empty `chains` is the ONLY first-run state — no
chain is pre-created and no picker row appears until one is configured.

**Role entities — `roles.list[] = { id, persona, chain? }`**: identity plus ONE manual
pointer. `chain` names a `chains[].id`; it is never a chain definition and never an
auto mode. Absent/empty = NOT SPECIFIED (the plugin does not intervene, the child
inherits the delegating agent's route); an undeclared id warns once at startup and
behaves as NOT SPECIFIED. `prompt` / `permissions` stay schema-reserved with no
consumer, and `'inherit'` stays a reserved id. The v1 `fallback` append policy,
per-role inline chains and the whole `roles.rules` matcher are deleted, so the
namespace holds plain ids only.

**Role resolution is two ordered stages, first hit wins** (`resolveDeclaredRole` in
`src/role-resolution.ts`): the explicit `agentPreset` session header → the
dispatch-declared role the seam resolved from the child prompt (`**Execute as**: <id>`,
header region only, ambiguity ⇒ no role). An absent, empty, `'inherit'`, undeclared or
since-removed reference falls through silently — a stale reference is not an error.
Ids are normalized by trim, so a padded YAML id and its trimmed header resolve to the
same role. There is **no LLM auto-match stage** (its only host point was the deleted
`agent/request` inject, and a nested completion inside the walk would be one extra
request per failure) and no rules stage. Resolution is pure and synchronous — the walk
must throw its pre-attempt errors before the first chunk.

**Chain resolution is per chain, replace-not-append**: `resolveChain(entries, provider,
model)` walks the SELECTED chain's own `entries` — there is nothing to concatenate.
Slot rotation is scoped to that chain: the first matching `timeSlots` row's chain
REPLACES the chain's `entries` at request time (`resolveEffectiveChain` in
`src/time-slots.ts`), no match falls back to the chain's own entries, and two chains
never share slot state (the rotation log is keyed per `(agent, chain)`). Chain-key
specificity (exact provider/model keys → `provider/*` keys → role chain → default key)
and `roles.default` are deleted; `provider/*` stays a valid chain entry (changed
provider, request model kept) even though the settings GUI no longer offers a wildcard
checkbox.

**Decision hot path (single pass)**: `resolveChainViews` produces `all` plus wildcard
provenance in one traversal; `hasWildcardEntry` uses the same source as resolution;
catalog existence probes are built only when a wildcard entry is reachable (a
pure-exact chain probes nothing); `selectCandidates` filters in place. Defensive warns
go through the injected logger.
### Removed mechanisms

| Removed | Why, and what replaced it |
|---|---|
| `agent/request` / `agent/request-error` listeners, `pendingSwitch`, `stepFailures`, `appliedTurnStep` | rc.1 rejects the override and reuses the captured selection; the walk owns the switch and forgets per-call bookkeeping with the walk |
| `alwaysModeRetryCap` | No successor: the cap is per walk, and an llm-retry re-entry is a fresh walk that starts past the cooled head |
| `roleAutoMatch` and its automatch module | No auto-match stage; resolution stays pure and synchronous |
| `roles.rules`, per-role inline chain arrays, the `fallback` (`inherit-root` / `none`) append policy | Named chains + one manual pointer per role: a child's chain is decided by config the operator can read off, not by a match |
| The override / authorized-route modules and the subagent-policy allowlist module | Native chains make the indirection pointless — a switch inside a chain is not allowlist-filtered (documented degradation) |
| Config-level `enabled` switch | Content presence (`isFallbackActive` = `chains.length > 0`) is the gate |
| The read-only status surfaces — the card's 运行状态 block and its switch-history read, the General-page status row, the host-policy status area with its sync button, the `subagentPolicy` wire field | One settings surface: the card. Switch history renders in the transcript row, the config summary in `/fallbacks config` |
| Half-open success closure via a plugin-scope `session/event` subscription | The walk observes success itself: a normal, non-aborted finish at the attempt boundary |
### Legacy configuration: detection only, never rewriting

Legacy keys are banner-reported, not migrated: the migration is **warn-only** and the
plugin never rewrites the user's file. `detectLegacyKeys` recognizes the v1 two-block
surface — `rootChain`, the top-level `timeSlots` array, `roles.rules`,
`roles.list[].fallback`, and the ARRAY form of `roles.list[].chain` — plus the older
`enabled`, `chains`, `alwaysModeRetryCap`, `roleAutoMatch`, `roles.default` and the
`label` / `description` role fields. Three channels react:

1. **Startup warn** — one `llm-fallbacks: legacy config keys detected …` line that
   points at the migration table in `docs/configuration.md`.
2. **Gateway + UI banner** — `get()` carries `legacyKeys: string[]`; a non-empty list
   renders the migration banner (zh/en), the form stays editable, and a save writes the
   new shape. Save is merge-only, so it cannot remove a user-layer legacy key.
3. **Migration table** in `docs/configuration.md` — per-key before/after, including the
   conventional migrated chain `{ id: 'Auto', label: '默认链', entries: <old rootChain>,
   timeSlots: <old rows> }`.

schemastery retains unknown keys in the composed object (top level, nested objects and
list items all pass through), so reading the composed object is an accurate legacy
probe. `validateConfigPatch` rejects unknown keys by own-key membership regardless of
that retention, and the v1 keys are stripped from every snapshot and every write — a
save can never re-persist them.
### Validation (warn-not-crash, two surfaces)

- **Host `validateFallbacksConfig`** — pure, never throws, never mutates: per chain the
  id pattern, case-sensitive uniqueness, a non-empty `label`, the 默认模型 tail
  conformance (only when `entries` is non-empty) and the per-chain slot guards (no
  repeated preset, a frozen preset carries no windows, `HH:mm` custom bounds, 0–6
  integer days, a non-empty row chain); per role the id format
  `/^[a-z0-9-]{1,32}$/`, uniqueness and the `'inherit'` reservation, plus one warn for
  a `chain` pointer naming no declared chain. `persona` is free text and unchecked. One
  warn per violation; the offending item is inert but the plugin stays usable, and a
  half-open escalation that cannot bite (cooldown at or above the 1-hour cap) warns
  once. It runs once at startup (with `detectLegacyKeys`); live settings patches are
  covered by the settings schema, and runtime resolution tolerates bad values
  defensively rather than re-validating on every change.
- **Gateway `validateChainsPatch`** — rejects on save exactly what the startup
  validator warns about, with one asymmetry worth remembering: an EMPTY `entries` array
  is **accepted** (the picker row still registers, the walk refuses with
  `EMPTY_EFFECTIVE_CHAIN`), while a non-empty one must end with an official model.
- **Client `validateDraft`** — the same rules plus selector legality, per-row inline
  errors under their owning block, and a per-tab save that never touches the gateway
  while its chain is invalid. The card is stricter than the gateway in one respect
  only: its own Save also requires a 默认模型 tail.
### Cooldown, safety valves and half-open recovery

`cooldownMs` keeps a switched-away or failed route out of candidacy;
`revertPolicy: 'cooldown-expiry'` returns to primary after expiry, `'never'` uses an
infinite TTL for the session. The cooldown/recovery store is the walk's **only
cross-call memory** (keyed per agent, surviving idle — a cross-turn return needs it,
cleared on `agent/disposed` and on plugin dispose). The per-call failed set and the
switch cap die with the walk.

**Half-open (opt-in `recovery: 'half-open'`, default `'timer'`)** — `'timer'` is
byte-identical to the previous behavior. Under `'half-open'` (cooldown-expiry only) an
expired route is not restored as the preferred candidate but goes half-open: a pure
`RecoveryStore` keeps `{consecutiveFailures, halfOpen, probeLogged, expiredUntil}` per
route. A half-open route is **not suppressed** — every real request routed to it is
admitted; the episode's one logged probe is the `probeLogged` marker, not an admission
limit. A failure books `escalatedCooldownMs(ms, n) = max(ms, min(1h, ms·2^(n-1)))`
(the null-decision path — a failed probe with no surviving target — books through the
same escalation), and a success closes the circuit only **from** the half-open state: a
late success during an active suppression is a no-op, because failure is the newer
evidence. An aborted finish is neither success nor failure. Closure is observed by the
walk at the attempt boundary; nothing subscribes to session events for it. If
`cooldownMs` is at or above the 1-hour escalation cap, escalation is inert and
validation warns once at startup.

### Settings namespace over the plugin's own gateway channel

dsh's web settings RPC keeps a hardcoded namespace whitelist, so a plugin namespace is
not readable or writable over the wire by default — and patching that list is out
(mount-only). The plugin ships its own channel (`src/gateway.ts`):

- **Endpoints**: `/api/fallbacks/get` + `/set` + `/reset`, registered explicitly with
  `ctx.typert.register(fallbacksTypertContribution())`. Explicit registration replaced
  `@Remote` SRC declarations, whose module-private marker table claims zero endpoints
  when a linked plugin and the dlx host are physically separate. The host's `/api`
  intercept slot is a single global, so the plugin never intercepts it.
- **Read**: `get` reads the same live composed config the runtime reads (schema
  defaults → plugin-row base → settings user layer).
- **Write**: `set` validates the patch against the schema (unknown keys rejected), then
  writes the user layer through `ctx.settings.update`; `reset` clears the user layer
  with `ctx.settings.replace(ns, {})`, because `set` is merge-only and cannot express
  "back to composed defaults".
- **Optional settings service**: without it `get` still works from the bridge source,
  while `set` / `reset` return an explicit error (KD-G5).
- **No revision guard (KD-G3)**: the channel is plain RPC merge/replace; there is no
  `expectedRevision` / `settings-conflict` UX, and any failure enters the existing error
  banner with the draft still editable.
- **Draft seeding invariant**: a draft is always seeded from the resolved config
  (`accept(config, writable)`). A failed `get` may render the skeleton with defaults but
  must never seed the draft from them — after a transient failure that would diff into
  an all-defaults patch and erase a real configuration.

The generic pattern (wire contract, optional-settings injection, unknown-key rejection,
no-revision principle, `present` flag) → `.mstar/knowledge/architecture-patterns/dsh-gateway-settings-channel.md`.

**Entry surfaces**: the official plugin-config card (`settings.plugin.item`, the only
settings surface — chain tabs with a per-tab Save, role cards with the 指定降级链
pointer, the advanced group), the session-scoped `/fallbacks` diagnostic command
(origin, resolved dispatch role + its chain pointer, every declared chain with tail and
current slot label and the calling agent's selection marked, recent switches,
cooldowns), and the transcript switch row (`conversationEvents` +
`conversation.chat.node`, pure render). Card = the single edit surface, command =
in-session diagnosis, transcript row = recovery visibility. Mount table →
`.mstar/knowledge/architecture-patterns/dsh-mount-point-map.md`; transcript pattern →
`.mstar/knowledge/architecture-patterns/dsh-conversation-surface-mounting.md`.

The card carries **no status block and no policy area**: the 运行状态（只读） panel and
its switch-history read are gone, as is the General-page status row — a read-only
duplicate of an editable form was maintenance without an audience. Switch history is
visible where it happens (the transcript row); the config readback is `/fallbacks
config`; the topology readback is the card's own chain tabs.

### Catalog-driven provider/model selection

- **Sources**: `llm.providers({})` (configurable provider directory) and
  `llm.models({})` (`{ groups, failures }`); `llm/adapters-updated` refreshes them (the
  older `models/changed` client event is gone).
- **Store**: an independent `loadCatalog()` with its own generation guard;
  `llm/adapters-updated` refreshes the catalog only, `connection`/`reset` refresh
  everything; `failures` degrade to diagnostics without dragging `groups` down; a
  catalog failure never blocks the form or touches settings state.
- **Mixed dropdown**: cascading provider + model selects, `provider/*` wildcard
  (catalog-independent), and synthesized out-of-catalog options carrying the raw value
  (round-trip lossless; only NEW entries are catalog-limited). Row edit state is
  `{ kind: 'catalog', id } | { kind: 'outside', raw } | null`; serialization still
  writes plain strings.

### Consumer surface: library re-exports + named service

- **Library API**: `src/index.ts` re-exports the runtime surface —
  `resolveChain`, `resolveChainViews`, `resolveCandidate`, `selectCandidates`,
  `annotateCandidates`, `createCandidateFilter`, `hasWildcardEntry`, `parseSelector`,
  `validateFallbacksConfig`, `detectLegacyKeys` plus `INHERIT_ROLE_ID` /
  `ROLE_ID_PATTERN` / `CHAIN_ID_PATTERN` / `defaultFallbacksConfig` / `SelectorError`
  and the types (`NamedChain`, the chain-pointer `FallbacksRole`, …) — so a consumer
  writes `import { resolveChain } from 'dsh-llm-fallbacks'`. Role resolution is a
  seam-internal step, not a library function. `tests/export-surface.spec.ts` pins the
  list (`LIBRARY_EXPORT_KEYS` SSOT + `expectTypeOf` pins).
- **Named service `llm-fallbacks`**: `ctx.get('llm-fallbacks') !== undefined` is the
  reactive capability probe (cordis lifecycle handles readiness and withdrawal). Six
  members: `name`, `version`, `resolveChain`, `validateFallbacksConfig`,
  `detectLegacyKeys`, plus the three seed methods (`declareSeeds` /
  `getEffectiveRoles` / `revertSeededPersona`) and `getAgentRole`.
  No state-bearing fields — seed methods close over the per-apply seed manager and
  `getAgentRole` over the fiber's own seam, so state dies with the fiber. Multi-fiber
  dedupe guard (mirrors the gateway/typert pattern) and `createRequire` for the runtime
  version. Registration details →
  `.mstar/knowledge/best-practices/dsh-cordis-plugin-authoring.md`.
- **Boundary**: this package's contract holding does not mean a neighbouring repo wired
  it up; `docs/consumer-api.md` is the SSOT for the contract.

### Role seeds: companion-declared roles

A companion plugin declares `[{ id, persona }]` and the plugin materializes roles with
zero operator edits and zero patch layer (a folded bundle row was disproved: a
duplicate loader-entry id crashes at startup, and a second id gives two instances with
split state — so the capability belongs here).

- **Dual storage**: persistent side = ordinary `roles.list` rows carrying exactly
  `{ id, persona }` in the settings user layer; memory side = a per-apply
  `FallbacksSeedManager` registry (`declare` is replace semantics). `seeded` /
  `personaOverridden` are derived on readback, never stored, so a config round-trip
  cannot manufacture an orphan override; a row at its default follows a new default,
  and across a restart it is conservatively treated as an override.
- **Idempotence**: no delta, no write (per-member comparison; schemastery-retained
  legacy nested keys must not cause revision churn). compute → write → commit registry,
  so a failed write retries safely.
- **Immutable ids**: a seed id is checked as declared against
  `/^[a-z0-9-]{1,32}$/` — padding, case, underscores, over-length and `inherit` are
  skipped with a warn, zero coercion. Conflicts (same id, different persona source, or
  duplicates inside a batch) are loud on three channels (log prefix, structured
  `SeedDeclareOutcome`, `seeds` wire badge) and never silently merged. Removing a
  declaration drops the seed-default/revert affordance only — no row or chain is
  deleted.
- **Chain belongs to the operator**: every seed write path preserves or omits the
  `chain` POINTER byte-for-byte (an array-form pointer from a v1 file is stripped, never
  coerced), and a newly materialized row carries no pointer at all — a seeded role is
  NOT SPECIFIED until the operator points it at one of their chains.
- **Service surface**: strictly additive (see above), gateway wire adds
  `seeds: Array<{id, overridden}>` plus the `fallbacks/revert-seed` endpoint (business
  failures are values; only an unavailable settings service throws). A defensive
  `roleRows()` containment guard on both read and write paths keeps a malformed
  composed config from crashing.
- **Known limit**: the settings user layer has no cross-writer revision guard
  (last-writer-wins, same channel limit as `set`/`reset`) — bounded and recoverable,
  see the gateway doc.

### Preset roles: 5 bundled roles

The plugin ships five generic subagent roles — `reviewer` / `scout` /
`security-reviewer` / `sonic` / `task` — declared on `apply` through the same seed
surface (the plugin is its own seeds caller; no new io seam). The `presets` key selects
`'bundled'` (the default) or `'none'`, synced in four places: `src/config.ts`,
`src/schema.ts`, the gateway `CONFIG_KEYS` set, and the tests; `presetRoles` is also
re-exported from the package root.

- **Timing is the constraint.** An async `apply` would let a rejection mark the whole
  fiber FAILED, and a synchronous fire at the end of `apply` hits the
  settings-unavailable stub (the injected child activates one tick later). The
  declaration therefore fires in a **new** `ctx.inject(['settings'])` child registered
  last in `apply`, with a terminal `.catch` (log, registry not committed, apply not
  blocked, no in-process retry).
- **Never reuse the earlier `writeRoles` child**: it fires before
  `installSettingsSection` settles, so `source()` is base-only and materializing from
  that baseline would overwrite operator user-layer rows wholesale.
- **Multi-fiber**: only the fiber that successfully registered the service fires; a
  second fiber stays inert. Declare idempotence and the serialized settings write queue
  are the double floor.
- **`presets: 'none'`** short-circuits on the live composed source (zero declarations,
  zero writes). Nothing else gates the declaration — a content-less install still
  materializes the rows, because taxonomy materialization is not a no-op.
- **Client chain**: a new default value ripples out — `parseFallbacksConfig` mirrors it
  (keeping `parseFallbacksConfig({})` equal to `defaultFallbacksConfig`),
  `assembleConfig` carries the key (or the card is permanently dirty), and the export
  surface test follows.
- **Test isolation**: suites asserting an exact `roles.list` shape pin
  `presets: 'none'`; `tests/support/harness.ts` `cfg()` pins it by default.

### Known limitations (open residual)

- Default `triggerCodes` are `AUTH` / `QUOTA` / `RATE_LIMIT`; 5xx and TRANSPORT are
  backed off by llm-retry first and re-enter as fresh walks, so no extra configuration
  is needed.
- Real-model sessions have no plugin fallback, and external-backend subagents have no
  chain — both are the locked scope, not bugs.
- **`providerRetryPolicy` returns `undefined`**: the host captures a provider's retry
  policy ONCE at registration, so one virtual provider cannot mirror N heads' policies.
  A head provider's custom `retryPolicy` therefore stops applying on the virtual route
  and the host default takes over. The one-provider-per-chain alternative was rejected
  (picker UX plus per-chain register/unregister churn).
- A switch INSIDE a stamped child's chain is not host-allowlist-filtered — the chain is
  hand-written config, not a route the plugin chose.
- The migration is warn-only: v1 keys are reported and stripped from writes, but the
  plugin never rewrites the user's file, so nothing is migrated until the operator edits
  it (there is no auto-created default chain).
- One virtual call registers one outer `llm/stream` plus one inner stream per attempt,
  so N attempts appear as N+1 nested streams; a pre-output failed attempt is unmetered.
- Half-open flags and escalation counters are session-scoped in memory: a restart resets
  every route to a flat first cooldown.

## Why This Matters

The split is now structural rather than an accident of listener registration: the
fallback decision sits on the one seam the host cannot reject, so the plugin stays
mount-only with zero source-tree diff and survives a dsh upgrade unchanged. Both
integration seams close without patches — settings through the plugin's own gateway
channel, routing through the virtual row plus the dispatch seam. The two places the
port historically went wrong, coexistence with llm-retry and the switch bound, are
pinned by tests: llm-retry's retries are fresh walks that start past a cooled head, and
the cap is per walk.

## When to Apply

- Any dsh feature of the form "after a failure, continue on another model or route"
  (retry, fallback, degradation, load-based routing).
- Reasoning about the virtual row, the chain walk, the switch log or selector syntax.
- Adding a web settings surface over the plugin's own gateway channel.
- Changing the named-chain config model (`chains[]`, the role `chain` pointer, per-chain
  slots) or migrating the v1 two-block keys.
- Extending the mount-only install story (zero dsh source diff, no patch/autopatch,
  upgrade without re-patching).

## Examples

- Configuration examples → `docs/configuration.md`.
- Walk and adapter: `tests/chain-walk.spec.ts` (candidate order and filters, committed
  rule, exactly-one-finish, pre-attempt throws, abort, recursion guard),
  `tests/virtual-adapter.spec.ts`, `tests/coexist-llm-retry.spec.ts`,
  `tests/runtime-recovery.spec.ts`, `tests/recovery.spec.ts`, `tests/cooldown.spec.ts`.
- Subagent routing: `tests/seam-inject.spec.ts` (the four conditions),
  `tests/subagents-seam.spec.ts`, `tests/role-resolution.spec.ts`,
  `tests/dispatch-injection.spec.ts`, `tests/agent-team-roles.spec.ts`.
- Configuration and surfaces: `tests/config.spec.ts`, `tests/time-slots.spec.ts`,
  `tests/gateway.spec.ts`, `tests/command.spec.ts`, `tests/tui-settings.spec.ts`,
  `tests/fallbacks-card.spec.tsx`, `tests/fallbacks-store.spec.ts`,
  `tests/enabled-read-sweep.spec.ts`.
- Seeds and presets: `tests/seeds.spec.ts`, `tests/seeds-integration.spec.ts`,
  `tests/presets.spec.ts`, `tests/service.spec.ts`, `tests/export-surface.spec.ts`.
- Real-host end-to-end script: `docs/verification.md` §4.

*Source: plans `llm-fallbacks-settings-runtime`, `fallbacks-virtual-chain`,
`fallbacks-role-seeds`, `fallbacks-preset-roles`, `dsh-012-subagent-routing`,
`dsh-022-rc1-upgrade` (direction C), `named-virtual-chains` — verified against the
implementation.*

**2026-11-08 refresh (plan named-virtual-chains)**: the two-block config model is
replaced by N named virtual chains (one `FallbacksChain/<chain id>` picker row each,
per-chain time slots), roles keep identity plus a manual chain POINTER, and the rule
matcher, per-role chains, the `fallback` append policy, the host subagent-policy
gating, and the two read-only status surfaces are deleted. v1 keys survive only as
`detectLegacyKeys` history and as rows in the docs migration table.*
