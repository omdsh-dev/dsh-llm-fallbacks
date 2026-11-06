# Feature reference

Capability reference for `dsh-llm-fallbacks` — what the plugin does at runtime,
when it intervenes, and how each surface behaves. The landing-page overview is
[README.md](../README.md); every configuration key, field and selector is in
[docs/configuration.md](configuration.md).

## Automatic model failover

Only a session whose model selection routes to the plugin's virtual
`FallbacksChain / Auto` row has a chain: the root agent when that row is
selected, or an inheriting subagent the dispatch seam mounted there. Such a
session that keeps failing on a listed failure code walks down its chain to the
next available provider/model, and the failing request is retried on the target
model so the current step/turn continues. **A real provider/model selection —
root or subagent — gets no plugin fallback**: nothing in this plugin touches it,
and `llm-retry` alone handles its failures. The configuration is two blocks:
`rootChain` for the root agent, and declared role entities (`roles.list`)
referenced by `roles.rules` (or the built-in `inherit`) for subagents.

**Neither block is configured by default** — there is no `rootChain` and there
are no `timeSlots` rows until you write them. The one thing `apply` declares on
its own is the five bundled preset roles (`presets: 'bundled'`, the default —
see [Preset roles](#preset-roles)): those rows seed a `persona` and nothing
else, never a chain. With no root chain, no slot rows and no role chain matched,
requests pass through unchanged and the `fallbacks/switch` path writes nothing
(see [No configuration, no behavior](#no-configuration-no-behavior) and
[docs/configuration.md](configuration.md#no-op-invariant)). A seeded role
becomes routing-relevant only once a dispatch header or a rule selects a role
that does carry a chain.

### Fallback triggers (`triggerCodes`)

`fallbacks.triggerCodes` is a plain list of dsh failure codes, and **any** code the harness can report is accepted — not only the three defaults (`AUTH` / `QUOTA` / `RATE_LIMIT`). A failure whose code is not listed is forwarded verbatim to llm-retry or to the original error, exactly as if the plugin were not installed. Retryable failures (5xx / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE`) need no extra entries: llm-retry backs them off first, and every retry re-enters the walk as a fresh request — which starts past the head that failed, because that head is already on cooldown. The walk therefore never pins a failing route, and no separate always-mode cap is needed.

### Partial output (committed rule)

A walk cannot replay an attempt that already emitted output: yielded chunks cannot be unsent, and concatenating a second model's output behind a partial one would corrupt the assistant message. So a trigger-code failure is switched **only while the attempt has produced no chunk yet**. Once a chunk has been yielded, the attempt is committed and any later failure is forwarded verbatim: the loop settles the partial attempt and llm-retry or the terminal error takes over. That differs from the pre-upgrade path, which decided a switch at the next step's request after a mid-output failure; here the switch still happens, but only if llm-retry retries.

### Cooldown and revert

Failed / switched-away models are not re-selected during cooldown; `revertPolicy: cooldown-expiry` returns to the primary model automatically. The cooldown/recovery store is the walk's only cross-call memory (keyed per agent) — the route cooldown plus the half-open escalation counters — which is what lets an llm-retry re-entry resume past a failed head.

### Half-open recovery (opt-in)

`recovery: half-open` makes recovery evidence-driven — an expired cooldown leaves the route half-open for one logged probe instead of restoring the preference; consecutive failures escalate the suppression duration (×2 per failure, capped at 1 h); a completed attempt closes the circuit and fully restores the preference. `revertPolicy: 'never'` keeps the mechanism inert; state is session-scoped in-memory (a restart resets). YAML-only — the default `timer` keeps every existing behavior byte-identical (see [docs/configuration.md](configuration.md#recovery-mode-recovery-key)).

### Safety valves

`maxSwitchesPerStep` caps switches **per request walk** (attempts ≤ cap + 1); beyond it the walk stops advancing and re-emits the last attempt's terminal error verbatim — chain loops cannot amplify latency. The per-call failed set and the cap live only for that walk; the retired `alwaysModeRetryCap` has no successor (see [docs/configuration.md](configuration.md#field-overview)).

### Switch visibility

Every switch is recorded in an info-level log line (from/to/role/reason) — no silent model switching. The plugin deliberately writes **no** durable `fallbacks/switch` session events (issue #52: the apply()-time event-type registration was proven ineffective, and a session containing the event refused to load after a dsh restart). Sessions written by older plugin versions that contain such events **cannot** be repaired by an `ignorable` flag — the released session-format migration chain (v0→v1) refuses unknown event types even when marked ignorable — so `pnpm repair:session-logs` reports them (and recovers them only with the opt-in lossy `--drop-legacy-events` — see [Repair existing sessions](repair.md#repair-existing-sessions)).

### No configuration, no behavior

With nothing configured the plugin behaves exactly like not being installed — content presence is the gate (see [Minimal configuration](../README.md#configure)).

Cooldown bookkeeping, recovery escalation, the safety-valve counters and the
plugin's position relative to llm-retry in detail → [docs/configuration.md](configuration.md#behavior-notes).

## Context-window-aware fallback

A request larger than the model's context window is reported as `CONTEXT_WINDOW_EXCEEDED` — dsh core's canonical code for a provider 400 "maximum context length". It is not a retryable code, so list it explicitly to fail over to a larger-context model:

```yaml
fallbacks:
  triggerCodes:
    - AUTH
    - QUOTA
    - RATE_LIMIT
    - CONTEXT_WINDOW_EXCEEDED  # fail over when the request does not fit
  rootChain:
    - anthropic/claude-3-5-sonnet          # walked first
    - deepseek-official/deepseek-flash  # last resort (Flash or Pro)
```

**Ordering — on a virtual-route session the fallback runs before compaction.** With `CONTEXT_WINDOW_EXCEEDED` in `triggerCodes`, a `FallbacksChain / Auto` request that overflows is handled inside the walk while the attempt has emitted nothing, so the conversation moves to a larger-context candidate and the context is not compacted. The failure only reaches the harness's compaction plugin when the walk itself cannot continue (no larger candidate, or the switch cap is reached) — then the last terminal failure is re-emitted verbatim and the host's normal error path, compaction included, runs. This applies **only** to sessions on the virtual route; a session on a real provider/model has no chain, so its overflow goes straight to compaction as before. Leave the code out of `triggerCodes` to have compaction tried first on virtual-route sessions too.

**Request-scoped switching.** A context-window rejection says the *request* was too big, not that the route is unhealthy. Such a switch is **request-scoped**: the from-route is recorded as failed for the current walk (so the walk does not bounce straight back to it) and still counts against `maxSwitchesPerStep`, but it is **not** put on cooldown for `cooldownMs` and does not feed the half-open recovery counter — the next, shorter prompt goes to the primary model as usual, and no half-open probe is spent on a route that never failed. Every other trigger code stays **route-scoped** (cooldown + recovery bookkeeping) exactly as before.

Note what a request-scoped failure deliberately does **not** buy: because no cooldown is written, an llm-retry re-entry starts from the same head again. Only route-scoped failures push the walk past a head across calls.

**Candidates that cannot fit are skipped.** On a context-window walk the chain skips any candidate whose advertised context window is not larger than the failing model's — falling over from a 128k model to an 8k one would only fail again. Windows come from the host model catalog: the catalog row's `contextWindow` when it carries one, otherwise `llm.resolveModelInfo(provider, model)`'s `context.contextWindow`. A model that discloses no window either way is kept as a candidate, so a provider without capacity metadata never empties a chain. Skipped candidates are named in the switch log line as `skipped: context-window`.

## Time slots

Time slots rotate the **effective root chain** by wall-clock windows, so peak
and valley hours can run different chains while the failure walk stays
untouched (see [Automatic model failover](#automatic-model-failover)). Each row
carries its own fallback chain: the first row whose window contains the current
moment replaces the all-day chain for the next root request, and the all-day
chain remains the last resort when no row matches. The copy split is strict:
slot rotation logs and UI say **time-slot switch**; the failure walk keeps
**fallback switch**; the conversation notice Model downgraded stays on the
failure path only.

- **Match order**: at every root request, the first extra row whose window contains the current moment (in `fallbacks.tz`, default `Asia/Shanghai` / UTC+8) wins — that row's chain **replaces** the all-day chain. No row matches → the all-day `rootChain` is used. The all-day row is always last and **required**: its last entry must be exactly one official model (Flash / Pro XOR; leading Default fallback chain entries are walked first).
- **Presets** (frozen, not user-editable): `liang-peak` = Monday–Friday 09:00–12:00 **and** 14:00–18:00; `liang-valley` = every other UTC+8 time; `glm-peak` = Monday–Friday 14:00–18:00; `glm-valley` = every other time. One preset id = one row; the card picker never offers a duplicate.
- **Custom rows**: `start` / `end` (`HH:mm`, may wrap midnight) + optional `days` (0=Sunday…6=Saturday; omitted/empty = every day) + models.
- **Next-request apply**: a slot boundary crossing never preempts an in-flight step — the new row takes effect on the next root request. Rotation is mount-only: info log + card/`/fallbacks` status line, no durable switch event.
- **Flat settings card** (the official Plugins-page form language): the card is always open — no collapsible chrome and no feature switch — and one footer **Save/Discard** pair writes the whole validated draft. The Main agent section groups Time slots (extra rows — add preset / add custom / remove / reorder by buttons or **drag**; preset rows show a read-only window summary and edit models only; custom rows carry an editable name; the **timezone picker** lives here and **locks to Asia/Shanghai while any preset row exists**, since preset windows are frozen UTC+8 constants), Default fallback chain (walked first when no slot matches) and Default model (the official Flash | Pro last-resort fallback). Rows are collapsible to name + first model (content disclosure). There is no `timeSlots.enabled` master switch (adding a row is the opt-in) and no `rootMode` control.

Row shape, save rules and the frozen-window table → [docs/configuration.md](configuration.md) → Time slots.

## Role-based subagents

A subagent's role is declared in its dispatch prompt, not in configuration: the
`**Execute as**: <id>` Assignment header is the role source (dsh role binding is
prompt-only), and it is matched against the declared `roles.list` ids. Two
mechanisms share that header, and they are not the same thing:

- **Identity delivery** is header-only. That declared header, and nothing else,
  makes the child a role child: the role's `persona` is installed on it, its own
  session shows one `[role: <id>]` notice row, and the web session header shows
  a role badge.
- **Routing resolution** runs inside the chain walk, in the three ordered
  stages below, where the same header is stage 2. Routing and identity are
  independent: a child that declares `**Execute as**: <id>` keeps that role's
  delivered persona, notice row and badge **regardless of which routing stage
  wins** — an earlier explicit `agentPreset` can route it as another role while
  the carriers remain the declared role's. A child with **no declared dispatch
  header** gets no persona, no notice row and no role half of the badge (the
  model half still renders when the child has a recorded route), even when a
  rule resolves a role for routing; no carrier reports a role inferred after
  the fact.

Chain mounting is conditional too, and it happens at **dispatch**, not at the
first request: the seam stamps `FallbacksChain / Auto` into an inheriting
child's creation options, so the child's route is the virtual row and the walk
serves it. A spawn request that already carries an explicit `provider`/`model`
route is **authorized** and never touched, and the host allowlist bounds a
mounted child's candidates (see
[Host subagent model selection policy](#host-subagent-model-selection-policy-dsh-012)).
A child that is neither mounted nor explicitly on the virtual row has no chain
at all — external (acp) backends always land here, because they cannot resolve
the virtual provider out of process.

The same seam serves an ordinary subagent dispatch and an Agent Team teammate
(`spawn_teammate`): both are children dispatched with the same Assignment
header, so nothing Agent-Team-specific is required.

### Role resolution in the walk

An agent's role is resolved inside every walk, in **three ordered stages** (first hit wins) — explicit (`agentPreset` matches a declared role id) → **dispatch-declared role** (the role the dispatch seam resolved from the child's prompt header `**Execute as**: <id>` — a normally delegated Assignment or an Agent Team teammate's initial prompt — trimmed and looked up in the live declared-role set, so an absent header, the reserved `inherit` and a since-removed id all fall through silently) → deterministic rules (matching either the recorded pair or the served head — see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)). The resolved role then only decides **which chain the walk uses**: the role's own chain concatenated with the root tail (`fallback: inherit-root`) or alone (`none`), with `inherit` walking the effective root chain. Resolution is a pure in-memory read — no LLM call, no request override, no bookkeeping: the walk is already inside the request whose chain it picks. There is no LLM auto-match stage and no `roleAutoMatch` key any more (see the migration note in [docs/configuration.md](configuration.md#field-overview)).

### Role persona on the child

When a subagent's dispatch declares a role this plugin knows (the `**Execute as**: <id>` field of its Assignment), that role's `persona` is installed on the child as a scoped system-prompt section at the `deployment:persona-prefix` slot — the same slot the deployment persona uses, so the role persona **replaces** the deployment prefix for that child instead of stacking under it. The role is the child's identity, not only a routing decision, and delivery does not depend on routing: a role with an empty `chain` gets its persona exactly like a chained one (the chain only picks the model). That section lives on the child's own context, so the persona is **not durable**: a role child resumed after a host restart runs without its role persona (the resumed descriptor cannot carry one). A same-named section the child's scope already holds (a persisted descriptor) counts as delivered; any other registration failure is contained — the child runs unchanged and its notice row carries the ` (persona not applied)` suffix. Role resolution and the catalog record still apply, but two accepted boundaries get no persona delivery at all: an external (acp) child creates no local agent, so it gets **no persona, no notice row and no badge**, and a host that never mounts the `systemPrompt` service runs the child with no persona and **no** ` (persona not applied)` suffix (issue `I-000059`).

### Role notice in the child's session

A child dispatched with a declared role gets exactly one plugin notice row in its own session, naming the role it was dispatched as — `[role: <id>]`, with ` (persona not applied)` when the role declares a persona that was skipped — written once at the child's first non-empty pre-step, never for a root session and never for `inherit`/unresolved dispatches. The row is a durable transcript row, so the role stays readable in the child's session after it settles.

### Role badge

A subagent **session** shows a compact badge next to the session's agent-preset (mode) chip in the web session header, reading `role · provider/model`; hover shows `role → provider/model (request route)`. The two halves are independent facts and each is omitted when its own source is absent:

- **Role**: shown only for a child **dispatched with a declared role** — the `**Execute as**: <id>` field of its Assignment, the same declaration that carries the persona, and the badge's ONLY role source (policy on or off). Only the DECLARED header is read, so a child whose role came from another stage (`agentPreset` match, or a role rule) but which declares no Assignment header is still routed as that role yet shows **no role** — the badge never reports a role inferred after the fact. An `inherit`/unresolved dispatch omits the role half; it does not hide the badge.
- **Model**: the host's own `modelSelection` projection, read as `next ?? lastUsed` — the route the child's next request will use, falling back to the route its latest recorded request ran on. It renders for any subagent session that has a recorded route, declared role or not.

A **root** session never shows the badge (its composer owns the model control). The badge is durable: both halves are read from the child's own session record, so it is still shown for a **settled** subagent session and **after a host restart**.

### Agent Team teammates

With the experimental Agent Team bundle enabled, ordinary delegation is replaced
by `spawn_teammate` / `send_message`, and role declaration rides the **dispatch
prompt** — which the model writes, including the `**Execute as**: <id>` header,
because the spawn request carries no role or persona field. `roster.spawn`
creates the member through `ctx.subagents.startActivation`, the same seam the
plugin already wraps, so the teammate flows through the resolution above
unchanged: an ordinary dispatching agent and a teammate spawned with the same
header get the same persona installation, the same routing-role resolution, the
same `[role: <id>]` notice row and the same badge, and the role still has to be
declared in `roles.list` to resolve. No per-mechanism configuration exists.

- **The header is the only role carrier.** A teammate whose prompt omits it, or
  names an id that is not currently declared, falls through to rules →
  `inherit`, exactly like a normally delegated child without one.
- **Names stay arbitrary (but unique inside one Team).** Any number of
  differently named teammates can carry the same role; there is **no
  name→role mapping**.
- **Non-local provider — two outcomes.** An external (acp) provider creates no
  local agent: a normally delegated external child resolves its role but gets
  **no persona, no notice row and no badge**, while a teammate cannot use one at
  all — `roster.spawn` always reserves a child id and the runtime rejects a
  reserved id for a non-local provider (`UNSUPPORTED_CAPABILITY`), so member
  creation fails and no role is delivered.

Full resolution reference (stages, chain composition) → [docs/configuration.md](configuration.md#subagent-role-resolution-and-chain-mounting).

## FallbacksChain in the model picker

Whenever the plugin has content configured (a non-empty `rootChain`, at least one `timeSlots` row, or one declared role), it registers a virtual provider, **FallbacksChain**, with a single catalog row: **Auto**. The web profile and dsh-tui both see the row: they share the same adapter catalog, so the row needs no settings-page wiring or host patch (it is independent of the `/settings` fallbacks section, which edits configuration rather than the picker catalog). A legacy or empty all-day chain does NOT hide the row as long as other content is configured (the walk just refuses to serve it); with nothing configured there is no row.

Selecting **FallbacksChain / Auto** makes the configured chain the session route: the request stays on the virtual pair, and the adapter's `stream()` **walks** the chain — the first attempt is the effective chain's first dispatchable exact `provider/model`, and a pre-output trigger-code failure advances to the next candidate inside the same request. For a subagent mounted at the dispatch seam, that first attempt must also be on the host model allowlist: an `unprovable` model-selection policy, or a head the allowlist no longer admits when the walk rechecks it after the catalog query, refuses the attempt with no dispatch instead. Serving the selection unchanged (instead of rewriting the route to the head) is also what keeps the host's model-change notice quiet: the recorded route equals the session selection, so the notice appears once on a genuine selection change rather than being re-armed on every step. Selecting any real catalog model instead gives the session **no plugin fallback at all**: the session model is primary and only `llm-retry` retries it.

There is **no `rootMode` switch** — no config key, YAML field, settings toggle, or gateway flag. The mode is the session's `{provider, model}` selection itself: `FallbacksChain` = chain walked; any real model = no plugin fallback.

Notes:

- **Picker label**: the row's catalog `name` (what the composer trigger shows) is live — `Auto: DeepSeek Flash[Liang Peak]` / `Auto: DeepSeek Flash[all-day]` (catalog display name, not the model id); the id stays `Auto`. Bare `Auto` if the all-day tail is not conforming. Refresh by reopening the picker.
- **One walk for every origin**: the same `stream()` walk serves the root agent and a subagent session mounted on (or inheriting) the selection — the only difference is which chain tail it uses (slot-effective all-day for root, role chain + raw `rootChain` for a subagent). Rule matching is widened deliberately: the rules stage accepts **either** the recorded pair or the served head (a superset of the previous matching, so a rule keyed on the real head keeps matching), and the virtual row is never a second routing engine.
- **Conformance gate on the tail**: a successful virtual-route request requires the all-day chain to be **tail-conforming** — its last entry must be exactly one official model (`deepseek-official/deepseek-flash` or `deepseek-official/deepseek-v4-pro`, the card's Default model panel); leading entries (Default fallback chain) are walked first. Deactivating the plugin (the Plugins-page row switch, or clearing all configured content) hides the row again (slot-row/chain edits never churn registration).
- **Stale selection**: if the row disappears (plugin deactivated) while `FallbacksChain / Auto` is selected, the session keeps showing it as the current model with `routable: false` — pick a real model from the catalog to continue (host-native catalog semantics).
- **Capabilities and retry policy follow the head**: the row's model metadata (context window, modalities, reasoning) mirrors the current effective head, and `providerRetryPolicy` returns **that head's** policy — so a user's `llm-deepseek.retryPolicy` applies on this route too, not the permissive default. The host captures the policy once at registration, so a later policy edit or a slot-driven head-provider rotation shows up only after the plugin re-registers. Retry events are keyed by the virtual provider — the route the runtime actually sees. Full semantics → [docs/configuration.md](configuration.md).

## Host subagent model selection policy (dsh 0.1.2)

dsh 0.1.2 adds host-side child-model selection for subagents: a `subagent-model-selection` settings allowlist, a per-session `subagent/model-selection-policy` event, and spawn-time `provider/model/reasoning_effort` routing. The plugin reconciles with it under one runtime arbiter — plugin roles/chains remain the failure-recovery layer the host does not provide.

**Policy read (per session)**: the session `subagent/model-selection-policy` event wins; otherwise the `subagent-model-selection` settings service when `enabled`. Missing service / `enabled: false` / no event → policy off.

When the policy is **enabled**:

- **Authorized route preserved (no mount)**: a spawn request that carries an explicit `provider`+`model` in `agentOptions` keeps that route — the seam never overwrites it and labels it `authorized`; the child then has no chain at all (its route is an explicit real provider/model). Pure inheritance (no explicit route) is **not** authorized.
- **Allowlist-constrained mount**: an inheriting child whose role resolves is mounted on `FallbacksChain / Auto` at dispatch only while the policy is not unprovable **and** the role chain has a dispatchable exact head on the allowlist — plugin-originated, so a role chain with no allowlisted dispatchable route declines the mount and the child keeps pure inheritance. A mounted child's first attempt is allowlist-admitted like every switch (the walk starts on the first dispatchable route on the allowlist and refuses before any attempt when none remains); its later switches intersect the resolved candidates with the allowlist in candidate order, and a switch with no allowlisted candidate is blocked (warn log + in-memory blocked-attempt record, no durable session write — issue #52 stands).
- **Fail-closed**: a present-but-malformed policy event, or enabled settings with an unreadable route list, disables plugin-originated mounts and switches for that session (warn log), and a mounted child's walk refuses before its first attempt (`UNDISPATCHABLE_EFFECTIVE_HEAD`; no request is sent) rather than dispatching a route it cannot prove; pure inheritance and every non-switch behavior are untouched.
- **Card status area (read-only status + one explicit sync action)**: while enabled, the Fallbacks card Subagents section shows the effective allowlist, the effective chain head with its source (`authorized` / `injected`), and an empty-intersection warning when a switch was blocked — the same numbers the runtime uses. The card also explains what the allowlist cuts: role-card chain titles hide exact entries the policy cannot use (wildcards stay — their resolved routes are unknown client-side) and the same filtered string is used for the visible summary and its tooltip; a hint line counts the selected role-chain exact entries outside the allowlist; and `FallbacksChain/Auto` is recommended whenever the allowlist lacks that exact route. A **sync to host allowlist** button (disabled in a read-only store, user click only, never silent) merges the current allowlist with every exact `provider/model` route in the configured role chains and `rootChain` plus `FallbacksChain/Auto`, de-duplicated by exact provider+model (the current allowlist first), and writes **only** `allowedModels` — never `enabled` — through the host settings service. Wildcard entries are not expanded and never synced; the card then shows the refreshed snapshot. The sync merges the **saved** configuration only: unsaved role-chain or root-chain edits disable the button (with a "save first" hint), since the gateway reads the persisted config rather than the card draft.
- **Virtual-route carve-out (injected vs authorized)**: a subagent a *user or model* put on the plugin's virtual provider (`FallbacksChain` / `Auto` — an explicit spawn route, or a parent-inherited virtual selection) is user-authorized for that route, so its walk is **not** allowlist-filtered. A **seam-mounted** child is plugin-originated — the plugin is the one that chose the route — so it keeps D1 continuity and its candidates are allowlist-filtered. The card carries both labels: `authorized` for the explicit route, `injected` for the mount.

When the policy is **disabled or absent** there is no allowlist filter and no authorized-route check beyond the explicit-route skip above, so a walk takes the first surviving resolved candidate.

**Effort rule**: the walk never rewrites a seed config — `reasoningEffort` is passed through verbatim on every attempt. An effort carried by the session's virtual selection therefore rides every attempt; when the selection names none, none is sent (the virtual pair owns no real route for an effort to belong to).

Full semantics → [docs/configuration.md](configuration.md#host-subagent-model-selection-dsh-012).

## Preset roles

The plugin ships **5 bundled generic subagent roles** out of the box — `reviewer` / `scout` / `security-reviewer` / `sonic` / `task` — declared automatically on `apply` as seeded `roles.list` rows (`{ id, persona }`): idempotent, and never overwriting an operator persona. They appear in the Settings card as read-only rows (a source badge on every row; the id and persona cannot be edited there) and in the `/fallbacks config` role summary, ready for `roles.rules` to reference. (`designer` and `librarian` are no longer bundled: rows saved by earlier versions keep their persona and now show source `user` as ordinary editable rows only when no live producer still declares the id, even though the operator never wrote them; a companion's live declaration keeps them seeded and read-only with source `external` when unnamed or its registered set name otherwise.)

- **Switch**: `fallbacks.presets` — `'bundled'` (default) declares the preset roles on apply; `'none'` disables the automatic declaration (already-materialized rows stay).
- Full semantics (upgrade behavior, conflict handling, library reuse of `presetRoles`) → [docs/configuration.md](configuration.md).

## Agent presets (plugin composition)

Agent **presets** are a dsh feature for composing plugins — they are declarative child-plugin lists a user can apply as a set, and they carry **no** model fields of their own. The fallbacks plugin needs no preset-specific configuration: because a preset composes plugins, the plugin exists **wherever its row is mounted** — a preset that includes the `dsh-llm-fallbacks` row gives that preset's sessions the same chains and roles, and its sessions get a chain when they select `FallbacksChain / Auto`.

Two composition caveats:

- **A user preset override replaces the entire child list** (no merge): a preset that omits the fallbacks row silently unmounts the plugin for sessions using that preset. Restate every plugin row you want to keep.
- **Preset-scoped chain configs are possible by mounting the row inside a preset**: the plugin row's `config:` overrides in a preset composition produce a chain configuration that applies to that preset's sessions only (patch rows replace the whole `config`, so restate every field).

## dsh-tui surfaces

In a dsh-tui profile the plugin has three operator surfaces, with a strict duty split:

- **`/fallbacks`** — what happened this session: origin, resolved role, effective chain, recent fallback switches, cooldown status (half-open marker rows when `recovery: half-open` is active). Read-only.
- **`/fallbacks config`** — what is configured: composed-config readback (trigger codes, root chain, time slots, timezone, roles, role rules, cooldown, revert policy, max switches per request walk — printed as `Max switches per request walk` / `单次请求行走最大切换` — and presets). Read-only apart from the one action command **`/fallbacks config revert-seed <role-id>`**, which restores a seeded role's persona to its declared seed default — the web settings card presents seeded personas read-only (no revert affordance), so the command is that action's only surface.
- **`/settings`** — the edit surface. The plugin registers a **fallbacks** section with full parity to the web settings card: selects (`presets`, `revertPolicy`) render as pickers and numbers (`cooldownMs`, `maxSwitchesPerStep`) as numeric inputs; complex structures (`rootChain`, `timeSlots`, `roles.list`, `roles.rules`) are JSON text fields, `triggerCodes` a comma-separated text field and `tz` a plain text field. Invalid drafts (bad JSON, non-conforming chains, malformed time-slot rows) block the save — the section never corrupts the config.

**Requirements**: the `/settings` fallbacks section needs **dsh-tui ≥ v0.8.5** (commit `c51661f` or later on `main`; the settings seam shipped in v0.8.0, the groups shape + validation in v0.8.5). On an older dsh-tui the section is absent, and file editing remains the only TUI edit surface.

File editing still works everywhere: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings, or the profile patch `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (`config:` overrides on the plugin row) for dsh-tui-specific values. A patch row **replaces** the targeted row's whole `config` — restate every field you want to keep (schema defaults fill the rest).

## Mount-only

The plugin mounts as a **pure mount** — no dsh source modification — so every
capability above works without patches; the mount contract is stated in
[README.md](../README.md#mount-only).
