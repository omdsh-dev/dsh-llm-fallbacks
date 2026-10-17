# Feature reference

Capability reference for `dsh-llm-fallbacks` — what the plugin does at runtime,
when it intervenes, and how each surface behaves. The landing-page overview is
[README.md](../README.md); every configuration key, field and selector is in
[docs/configuration.md](configuration.md).

## Automatic model failover

Any agent — root or subagent — that keeps failing on a listed failure code
switches down its chain to the next available provider/model, and the failing
request is retried on the target model so the current step/turn continues. The
configuration is two blocks: `rootChain` for the root agent, and declared role
entities (`roles.list`) referenced by `roles.rules` (or the built-in `inherit`)
for subagents.

**Neither block is configured by default** — there is no `rootChain` and there
are no `timeSlots` rows until you write them. The one thing `apply` declares on
its own is the five bundled preset roles (`presets: 'bundled'`, the default —
see [Preset roles](#preset-roles)): those rows seed a `persona` and nothing
else, never a chain. With no root chain, no slot rows and no role chain matched,
requests pass through unchanged and the `fallbacks/switch` path writes nothing
(see [No configuration, no behavior](#no-configuration-no-behavior) and
[docs/configuration.md](configuration.md#no-op-invariant)). A seeded role
becomes routing-relevant only once a dispatch header, a rule or the LLM
auto-match selects a role that does carry a chain.

### Fallback triggers (`triggerCodes`)

`fallbacks.triggerCodes` is a plain list of dsh failure codes, and **any** code the harness can report is accepted — not only the three defaults (`AUTH` / `QUOTA` / `RATE_LIMIT`). A failure whose code is not listed passes straight through to llm-retry or to the original error, exactly as if the plugin were not installed. Retryable failures (5xx / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE`) need no extra entries: llm-retry backs them off first and the failure enters the chain decision the same way once that budget is exhausted.

### Cooldown and revert

Failed / switched-away models are not re-selected during cooldown; `revertPolicy: cooldown-expiry` returns to the primary model automatically.

### Half-open recovery (opt-in)

`recovery: half-open` makes recovery evidence-driven — an expired cooldown leaves the route half-open for one logged probe instead of restoring the preference; consecutive failures escalate the suppression duration (×2 per failure, capped at 1 h); an observed completion closes the circuit and fully restores the preference. `revertPolicy: 'never'` keeps the mechanism inert; state is session-scoped in-memory (a restart resets). YAML-only — the default `timer` keeps every existing behavior byte-identical (see [docs/configuration.md](configuration.md#recovery-mode-recovery-key)).

### Safety valves

`maxSwitchesPerStep` caps switches per step and `alwaysModeRetryCap` caps always-mode retries — chain loops cannot amplify latency.

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

**Ordering — the fallback runs before compaction.** With `CONTEXT_WINDOW_EXCEEDED` in `triggerCodes`, this plugin's `agent/request-error` listener handles the rejection **before** the harness's compaction plugin gets to compact: the conversation moves to the fallback model on the first overflow, and the context is never compacted. Leave the code out of `triggerCodes` if you would rather have compaction tried first.

**Request-scoped switching.** A context-window rejection says the *request* was too big, not that the route is unhealthy. Such a switch is **request-scoped**: the from-route is recorded as failed for the current step (so the step does not bounce straight back to it) and still counts against `maxSwitchesPerStep`, but it is **not** put on cooldown for `cooldownMs` and does not feed the half-open recovery counter — the next, shorter prompt goes to the primary model as usual, and no half-open probe is spent on a route that never failed. Every other trigger code stays **route-scoped** (cooldown + recovery bookkeeping) exactly as before.

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
- **Routing resolution** runs on the child's first request in the four ordered
  stages below, where the same header is stage 2. Routing and identity are
  independent: a child that declares `**Execute as**: <id>` keeps that role's
  delivered persona, notice row and badge **regardless of which routing stage
  wins** — an earlier explicit `agentPreset` can route it as another role while
  the carriers remain the declared role's. A child with **no declared dispatch
  header** gets none of the three, even when a rule or auto-match resolves a
  role for routing; no carrier reports a role inferred after the fact.

Injection is conditional too: the resolved role's chain head replaces the
child's model only when it is plugin-originated *and* the host lets it through —
an authorized route is preserved and the allowlist bounds the head (see
[Host subagent model selection policy](#host-subagent-model-selection-policy-dsh-012)).

The same seam serves an ordinary subagent dispatch and an Agent Team teammate
(`spawn_teammate`): both are children dispatched with the same Assignment
header, so nothing Agent-Team-specific is required.

### Dispatch-time role resolution

On a subagent's first request its role is resolved in **four ordered stages** (first hit wins) — explicit (`agentPreset` matches a declared role id) → **dispatch-declared role** (the role the dispatch seam resolved from the child's prompt header `**Execute as**: <id>` — a normally delegated Assignment or an Agent Team teammate's initial prompt — trimmed and looked up in the live declared-role set, so an absent header, the reserved `inherit` and a since-removed id all fall through silently) → deterministic rules (matching either the recorded pair or the served head — see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)) → LLM auto-match from the declared role taxonomy (`fallbacks.roleAutoMatch`, default `true`). The resolved role's chain-head model is then injected into the first request — as far as the host policy lets it through: an explicit authorized route skips the inject, an injected head must be on the effective allowlist, and an empty intersection injects nothing (see [Host subagent model selection policy](#host-subagent-model-selection-policy-dsh-012)) — and recorded via an explicit `role → model` log line (no durable `fallbacks/switch` event is written — issue #52 stop-write); `inherit` never injects. Set `roleAutoMatch: false` to disable the LLM auto-match stage (the explicit `agentPreset` and dispatch-declared stages still resolve and inject under `false`; with neither declared this reproduces the previous rules-only behavior). The settings card always renders an **Enable role auto-match** switch (default `true`) to toggle it — the schema default applies even to legacy configs that never declared the key.

### Role persona on the child

When a subagent's dispatch declares a role this plugin knows (the `**Execute as**: <id>` field of its Assignment), that role's `persona` is installed on the child as a scoped system-prompt section at the `deployment:persona-prefix` slot — the same slot the deployment persona uses, so the role persona **replaces** the deployment prefix for that child instead of stacking under it. The role is the child's identity, not only a routing decision, and delivery does not depend on routing: a role with an empty `chain` gets its persona exactly like a chained one (the chain only picks the model). That section lives on the child's own context, so the persona is **not durable**: a role child resumed after a host restart runs without its role persona (the resumed descriptor cannot carry one). A same-named section the child's scope already holds (a persisted descriptor) counts as delivered; any other registration failure is contained — the child runs unchanged and its notice row carries the ` (persona not applied)` suffix. Role resolution and the catalog record still apply, but two accepted boundaries get no persona delivery at all: an external (acp) child creates no local agent, so it gets **no persona, no notice row and no badge**, and a host that never mounts the `systemPrompt` service runs the child with no persona and **no** ` (persona not applied)` suffix (issue `I-000059`).

### Role notice in the child's session

A child dispatched with a declared role gets exactly one plugin notice row in its own session, naming the role it was dispatched as — `[role: <id>]`, with ` (persona not applied)` when the role declares a persona that was skipped — written once at the child's first non-empty pre-step, never for a root session and never for `inherit`/unresolved dispatches. The row is a durable transcript row, so the role stays readable in the child's session after it settles.

### Role badge

When a subagent is **dispatched with a declared role** — the `**Execute as**: <id>` field of its Assignment, the same declaration that carries the persona, and the badge's ONLY source (policy on or off) — its session shows a compact role badge next to the session's agent-preset (mode) chip in the web session header; hover shows `role → latest request route` (the route of the newest recorded request, not the dispatch-time route). Only the DECLARED header is read, so a child whose role came from another stage (`agentPreset` match, a role rule, or the LLM auto-match) but which declares no Assignment header is still routed as that role yet shows **no** badge — the badge never reports a role inferred after the fact. `inherit`/unresolved sessions render no badge. The badge is durable: it is read from the child's own session record, so it is still shown for a **settled** subagent session and **after a host restart**.

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
  auto-match → `inherit`, exactly like a normally delegated child without one.
- **Names stay arbitrary (but unique inside one Team).** Any number of
  differently named teammates can carry the same role; there is **no
  name→role mapping**.
- **Non-local provider — two outcomes.** An external (acp) provider creates no
  local agent: a normally delegated external child resolves its role but gets
  **no persona, no notice row and no badge**, while a teammate cannot use one at
  all — `roster.spawn` always reserves a child id and the runtime rejects a
  reserved id for a non-local provider (`UNSUPPORTED_CAPABILITY`), so member
  creation fails and no role is delivered.

Full resolution/injection reference (stages, bounds, no-commit semantics) → [docs/configuration.md](configuration.md#dispatch-time-role-resolution-and-injection-roleautomatch).

## FallbacksChain in the model picker

Whenever the plugin has content configured (a non-empty `rootChain`, at least one `timeSlots` row, or one declared role), it registers a virtual provider, **FallbacksChain**, with a single catalog row: **Auto**. The web profile and dsh-tui both see the row: they share the same adapter catalog, so the row needs no settings-page wiring or host patch (it is independent of the `/settings` fallbacks section, which edits configuration rather than the picker catalog). A legacy or empty all-day chain does NOT hide the row as long as other content is configured (the delegate just refuses to serve it); with nothing configured there is no row.

Selecting **FallbacksChain / Auto** uses the configured chain as the root **primary**: the request stays on the virtual pair and the adapter's thin delegate dispatches the effective chain's first exact `provider/model` at request time, so the fallback engine degrades from that head as usual. Serving the selection unchanged (instead of rewriting the route to the head) is also what keeps the host's model-change notice quiet: the recorded route equals the session selection, so the notice appears once on a genuine selection change rather than being re-armed on every step. Selecting any real catalog model keeps the v0.2.2 fallback-only behavior — the session model is primary and the chain engages only after it fails.

There is **no `rootMode` switch** — no config key, YAML field, settings toggle, or gateway flag. The mode is the session's `{provider, model}` selection itself: `FallbacksChain` = chain primary; any real model = fallback-only.

Notes:

- **Picker label**: the row's catalog `name` (what the composer trigger shows) is live — `Auto: DeepSeek Flash[Liang Peak]` / `Auto: DeepSeek Flash[all-day]` (catalog display name, not the model id); the id stays `Auto`. Bare `Auto` if the all-day tail is not conforming. Refresh by reopening the picker.
- **Thin delegate on every origin**: the row is served by the same `stream()` delegate for the root agent and for a subagent session that inherits the selection — subagent role resolution and injection keep their semantics apart from one deliberate widening: dispatch-time rule matching accepts **either** the recorded pair or the served head (a superset of the previous matching, so a rule keyed on the real head keeps matching), and the virtual row is never a second routing engine. A subagent that inherits the selection still routes through the chain head.
- **Conformance gate on the tail**: a successful delegation requires the all-day chain to be **tail-conforming** — its last entry must be exactly one official model (`deepseek-official/deepseek-flash` or `deepseek-official/deepseek-v4-pro`, the card's Default model panel); leading entries (Default fallback chain) are walked first. Deactivating the plugin (the Plugins-page row switch, or clearing all configured content) hides the row again (slot-row/chain edits never churn registration).
- **Stale selection**: if the row disappears (plugin deactivated) while `FallbacksChain / Auto` is selected, the session keeps showing it as the current model with `routable: false` — pick a real model from the catalog to continue (host-native catalog semantics).
- **Capabilities and retry policy follow the head**: the row's model metadata (context window, modalities, reasoning) mirrors the current effective head, and `providerRetryPolicy` returns **that head's** policy — so a user's `llm-deepseek.retryPolicy` applies on this route too, not the permissive default. The host captures the policy once at registration, so a later policy edit or a slot-driven head-provider rotation shows up only after the plugin re-registers. Retry events are keyed by the virtual provider — the route the runtime actually sees. Full semantics → [docs/configuration.md](configuration.md).

## Host subagent model selection policy (dsh 0.1.2)

dsh 0.1.2 adds host-side child-model selection for subagents: a `subagent-model-selection` settings allowlist, a per-session `subagent/model-selection-policy` event, and spawn-time `provider/model/reasoning_effort` routing. The plugin reconciles with it under one runtime arbiter — plugin roles/chains remain the failure-recovery layer the host does not provide.

**Policy read (per session)**: the session `subagent/model-selection-policy` event wins; otherwise the `subagent-model-selection` settings service when `enabled`. Missing service / `enabled: false` / no event → policy off.

When the policy is **enabled**:

- **Authorized head preserved (skip inject)**: a subagent spawned with an explicit `provider`+`model` (spawn options, durable `request/header`, or a `model/selection` selection) keeps that route as its chain head — role-inject is skipped and the authorized route is never overwritten at the first request; the plugin chain applies only from failure time onward. Pure inheritance (no explicit selection fields) is **not** an authorized route.
- **Allowlist-constrained inject**: pure inheritance still resolves a role in the four stages above, but the injected chain head is plugin-originated and must be on the effective allowlist — the first resolved in-allowlist candidate wins. Empty intersection → inject is skipped and the host seed stands (warn log).
- **Allowlist-constrained failure switching**: after a triggering failure, the resolved candidates (wildcards already expanded; cooldown / step-failed / same-as-current filters already applied) are intersected with the allowlist in walk order. Empty intersection → **no switch**, no out-of-allowlist request, a warn log plus an in-memory blocked-attempt record (no durable session write — issue #52 stands).
- **Fail-closed**: a present-but-malformed policy event, or enabled settings with an unreadable route list, disables plugin-originated injects and switches for that session (warn log); the host seed and non-switch behavior are untouched.
- **Card status area (read-only)**: the Fallbacks card Subagents section shows the effective allowlist, the effective chain head with its source (`authorized` / `injected`), and an empty-intersection warning when a switch was blocked — the same numbers the runtime uses, never a second write-face.
- **Virtual-route carve-out**: a subagent explicitly spawned on the plugin's virtual provider (`FallbacksChain` / `Auto`) is user-authorized for that route (spec D2 — explicit selection). The virtual adapter's internal delegation of its requests to the configured effective chain head is that route's documented purpose and is outside D1's selection semantics — D1 governs provider/model selection the plugin makes, not delegation inside an explicitly chosen virtual route — so the delegated head is not allowlist-filtered.

When the policy is **disabled or absent**, inject and failure-switch **selection** are unchanged from 0.3.5 (no allowlist filter, no authorized-route skip).

**Effort rule (policy-independent)**: `reasoningEffort` on every override path (role-inject, failure switch, always-cap switch) follows the upstream 0.1.2 `routeChanged` rule — an unchanged provider+model route keeps the seed effort; a route change drops it unless an effort is explicitly named for the override (explicit always survives). A stale effort is never carried into a different provider.

Full semantics → [docs/configuration.md](configuration.md#host-subagent-model-selection-dsh-012).

## Preset roles

The plugin ships **5 bundled generic subagent roles** out of the box — `reviewer` / `scout` / `security-reviewer` / `sonic` / `task` — declared automatically on `apply` as seeded `roles.list` rows (`{ id, persona }`): idempotent, and never overwriting an operator persona. They appear in the Settings card as read-only rows (a source badge on every row; the id and persona cannot be edited there) and in the `/fallbacks config` role summary, ready for `roles.rules` to reference. (`designer` and `librarian` are no longer bundled: rows saved by earlier versions keep their persona and now show source `user` as ordinary editable rows only when no live producer still declares the id, even though the operator never wrote them; a companion's live declaration keeps them seeded and read-only with source `external` when unnamed or its registered set name otherwise.)

- **Switch**: `fallbacks.presets` — `'bundled'` (default) declares the preset roles on apply; `'none'` disables the automatic declaration (already-materialized rows stay).
- Full semantics (upgrade behavior, conflict handling, library reuse of `presetRoles`) → [docs/configuration.md](configuration.md).

## Agent presets (plugin composition)

Agent **presets** are a dsh feature for composing plugins — they are declarative child-plugin lists a user can apply as a set, and they carry **no** model fields of their own. The fallbacks plugin needs no preset-specific configuration: because a preset composes plugins, the fallback applies **wherever the plugin's row is mounted** — a preset that includes the `dsh-llm-fallbacks` row gives that preset's sessions the same chains and roles configured for the plugin.

Two composition caveats:

- **A user preset override replaces the entire child list** (no merge): a preset that omits the fallbacks row silently unmounts the plugin for sessions using that preset. Restate every plugin row you want to keep.
- **Preset-scoped chain configs are possible by mounting the row inside a preset**: the plugin row's `config:` overrides in a preset composition produce a chain configuration that applies to that preset's sessions only (patch rows replace the whole `config`, so restate every field).

## dsh-tui surfaces

In a dsh-tui profile the plugin has three operator surfaces, with a strict duty split:

- **`/fallbacks`** — what happened this session: origin, resolved role, effective chain, recent fallback switches, cooldown status (half-open marker rows when `recovery: half-open` is active). Read-only.
- **`/fallbacks config`** — what is configured: composed-config readback (trigger codes, root chain, time slots, timezone, roles, role rules, cooldown, revert policy, safety valves, presets, role auto-match). Read-only apart from the one action command **`/fallbacks config revert-seed <role-id>`**, which restores a seeded role's persona to its declared seed default — the web settings card presents seeded personas read-only (no revert affordance), so the command is that action's only surface.
- **`/settings`** — the edit surface. The plugin registers a **fallbacks** section with full parity to the web settings card: booleans (`roleAutoMatch`) render as toggles, selects (`presets`, `revertPolicy`) as pickers, and numbers (`cooldownMs`, `maxSwitchesPerStep`, `alwaysModeRetryCap`) as numeric inputs; complex structures (`rootChain`, `timeSlots`, `roles.list`, `roles.rules`) are JSON text fields and `triggerCodes` a comma-separated text field. Invalid drafts (bad JSON, non-conforming chains, malformed time-slot rows) block the save — the section never corrupts the config.

**Requirements**: the `/settings` fallbacks section needs **dsh-tui ≥ v0.8.5** (commit `c51661f` or later on `main`; the settings seam shipped in v0.8.0, the groups shape + validation in v0.8.5). On an older dsh-tui the section is absent, and file editing remains the only TUI edit surface.

File editing still works everywhere: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings, or the profile patch `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (`config:` overrides on the plugin row) for dsh-tui-specific values. A patch row **replaces** the targeted row's whole `config` — restate every field you want to keep (schema defaults fill the rest).

## Mount-only

The plugin mounts as a **pure mount** — no dsh source modification — so every
capability above works without patches; the mount contract is stated in
[README.md](../README.md#mount-only).
