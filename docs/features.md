# Feature reference

Capability reference for `dsh-llm-fallbacks` — what the plugin does at runtime,
when it intervenes, and how each surface behaves. The landing-page overview is
[README.md](../README.md); every configuration key, field and selector is in
[docs/configuration.md](configuration.md).

## Automatic model failover

Only a session whose model selection routes to one of the plugin's virtual
`FallbacksChain / <chain id>` rows has a chain: the root agent when it selects
that row, or a subagent whose role points at that chain (「指定降级链」) and
was stamped there at dispatch. Such a session that keeps failing on a listed
failure code walks down its chain to the next available provider/model, and the
failing request is retried on the target model so the current step/turn
continues. **A real provider/model selection — root or subagent — gets no
plugin fallback**: nothing in this plugin touches it, and `llm-retry` alone
handles its failures. The configuration is the named-chain model: `chains`
(one object per picker row, each with its own 默认降级链, 默认模型 tail and
per-chain 分时 rows) plus optional role entities (`roles.list`) whose `chain`
is a manual pointer into `chains[].id`.

**Nothing is configured by default** — empty `chains` is the ONLY first-run
state (no chain is pre-created and no picker row appears until you create
one). The one thing `apply` declares on
its own is the five bundled preset roles (`presets: 'bundled'`, the default —
see [Preset roles](#preset-roles)): those rows seed a `persona` and nothing
else, never a chain. With no chains configured,
requests pass through unchanged and the `fallbacks/switch` path writes nothing
(see [No configuration, no behavior](#no-configuration-no-behavior) and
[docs/configuration.md](configuration.md#no-op-invariant)). A seeded role
becomes routing-relevant only once a dispatch header selects a role whose
`chain` pointer names a declared chain.

### Fallback triggers (`triggerCodes`)

`fallbacks.triggerCodes` is a plain list of dsh failure codes, and **any** code the harness can report is accepted — not only the three defaults (`AUTH` / `QUOTA` / `RATE_LIMIT`). A failure whose code is not listed does **not** switch chains inside that request: its terminal `finish` is forwarded verbatim to llm-retry or to the original error. The attempt is still **booked** at the walk's attempt boundary — the per-walk failed set plus the route cooldown, unless the code is request-scoped — before that finish is delivered, so the next llm-retry re-entry is a fresh walk that starts past the head that just failed. Retryable failures (5xx / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE`) therefore need no extra entries: llm-retry backs them off first, and each re-entry resumes on the next candidate instead of re-dispatching the same route. The walk therefore never pins a failing route, and no separate always-mode cap is needed.

### Partial output (committed rule)

A walk cannot replay an attempt that already emitted output: yielded chunks cannot be unsent, and concatenating a second model's output behind a partial one would corrupt the assistant message. So a trigger-code failure is switched **only while the attempt has produced no output yet**. A `usage` chunk is passthrough metadata, not output: adapters emit it before their terminal `finish`, so it never commits the attempt. Once an output chunk has been yielded, the attempt is committed and any later failure is forwarded verbatim: the loop settles the partial attempt and llm-retry or the terminal error takes over. A block **start** counts as output and commits too — including a `tool-call` opening — because a switch after an opened block would pour the next candidate's deltas into this attempt's partial block and lose the answer; the cost is that a failure right after a block start is forwarded instead of switched. That differs from the pre-upgrade path, which decided a switch at the next step's request after a mid-output failure; here the switch still happens, but only if llm-retry retries — and it moves on because the forwarded failure was booked (cooldown) at the attempt boundary, exactly like a swallowed one.

### Cooldown and revert

Failed / switched-away models are not re-selected during cooldown; `revertPolicy: cooldown-expiry` returns to the primary model automatically. The cooldown/recovery store is the walk's only cross-call memory (keyed per agent) — the route cooldown plus the half-open escalation counters — which is what lets an llm-retry re-entry resume past a failed head. Every FAILED attempt is booked there at the attempt boundary — a swallowed trigger-code failure and a forwarded one alike (the request-scoped exclusions are path-specific; see [Request-scoped switching](#context-window-aware-fallback)).

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
  chains:
    - id: Auto                             # picker model id: FallbacksChain/Auto
      label: Default chain                 # tab title + picker display prefix
      entries:
        - anthropic/claude-3-5-sonnet      # Default fallback chain, walked first
        - deepseek-official/deepseek-flash # LAST = Default model (Flash XOR Pro)
```

**Ordering — on a virtual-route session the fallback runs before compaction.** With `CONTEXT_WINDOW_EXCEEDED` in `triggerCodes`, a `FallbacksChain / <chain id>` request that overflows is handled inside the walk while the attempt has emitted nothing, so the conversation moves to a larger-context candidate and the context is not compacted. The failure only reaches the harness's compaction plugin when the walk itself cannot continue (no larger candidate, or the switch cap is reached) — then the last terminal failure is re-emitted verbatim and the host's normal error path, compaction included, runs. This applies **only** to sessions on the virtual route; a session on a real provider/model has no chain, so its overflow goes straight to compaction as before. Leave the code out of `triggerCodes` to have compaction tried first on virtual-route sessions too.

**Request-scoped switching.** A context-window rejection says the *request* was too big, not that the route is unhealthy. Such a switch is **request-scoped**: the from-route is recorded as failed for the current walk (so the walk does not bounce straight back to it) and still counts against `maxSwitchesPerStep`, but it is **not** put on cooldown for `cooldownMs` and does not feed the half-open recovery counter — the next, shorter prompt goes to the primary model as usual, and no half-open probe is spent on a route that never failed. The two adapter-side parameter rejections — `UNSUPPORTED_REASONING_EFFORT` and `INVALID_REQUEST` — are request-scoped for the same reason: the repair path has already tried to drop the offending control, so the request was the problem. That exclusion is scoped to the **forwarding** path and applies only to a code the operator has NOT listed (see [Fallback triggers](#fallback-triggers-triggercodes)): once either code is in `triggerCodes`, it keeps the pre-existing trigger booking on both paths — switch + cooldown/recovery when the failure is swallowed, and the same cooldown when a committed failure is forwarded after output. Every other code stays **route-scoped**.

Note what a request-scoped failure deliberately does **not** buy: because no cooldown is written, an llm-retry re-entry starts from the same head again. Only route-scoped failures push the walk past a head across calls — every route-scoped failure is booked at the attempt boundary, whether the walk switched on it or forwarded it.

**Candidates that cannot fit are skipped.** On a context-window walk the chain skips any candidate whose advertised context window is not larger than the failing model's — falling over from a 128k model to an 8k one would only fail again. Windows come from the host model catalog: the catalog row's `contextWindow` when it carries one, otherwise `llm.resolveModelInfo(provider, model)`'s `context.contextWindow`. A model that discloses no window either way is kept as a candidate, so a provider without capacity metadata never empties a chain. Skipped candidates are named in the switch log line as `skipped: context-window`.

## Time slots

Time slots are configured PER CHAIN (`chains[].timeSlots`) and rotate that
chain's own effective entries by wall-clock windows, so peak and valley hours
can run different entries while the failure walk stays untouched (see
[Automatic model failover](#automatic-model-failover)). Each row carries its
own priority segment: the first row whose window contains the current moment
is walked before the chain's `entries` on the next request, and the chain's
default fallback chain and official tail always follow it. No row matches →
the chain's own `entries` alone. Two chains never share slot state. The copy split is strict:
slot rotation logs and UI say **time-slot switch**; the failure walk keeps
**fallback switch**; the conversation notice Model downgraded stays on the
failure path only.

- **Match order**: at every request on that chain, the first row whose window contains the current moment (in `fallbacks.tz`, default `Asia/Shanghai` / UTC+8) wins — that row's chain is the **priority segment** walked before the chain's `entries` (default fallback chain + official tail), which always follow it; an entry already present in `entries` is not repeated, so the official tail stays last. No row matches → the chain's own entries are used alone. A NON-EMPTY `entries` tail must be exactly one official model (Flash / Pro XOR; leading Default fallback chain (默认降级链) entries are walked first). The gateway accepts an EMPTY `entries` — the row registers and the walk refuses it with `EMPTY_EFFECTIVE_CHAIN` — and the card additionally requires a tail before its Save arms.
- **Presets** (frozen, not user-editable): `liang-peak` = Monday–Friday 09:00–12:00 **and** 14:00–18:00; `liang-valley` = every other UTC+8 time; `glm-peak` = Monday–Friday 14:00–18:00; `glm-valley` = every other time. One preset id = one row; the card picker never offers a duplicate.
- **Custom rows**: `start` / `end` (`HH:mm`, may wrap midnight) + optional `days` (0=Sunday…6=Saturday; omitted/empty = every day) + models.
- **Next-request apply**: a slot boundary crossing never preempts an in-flight step — the new row takes effect on the next root request. Rotation is mount-only: info log + card/`/fallbacks` status line, no durable switch event.
- **Settings card — tab per chain**: the Virtual chains (虚拟链) section is a chain tab strip (a dirty tab carries a pip, an invalid one a red `!`; `＋` adds a chain, `⋯` renames the label or deletes the chain and at least one remains), and the selected tab opens a Chain name (链名称) field (display-only; the id is the immutable picker route) plus the shipped block order **Time slots (分时槽设置) → Default fallback chain (默认降级链) → Default model (默认模型)**. Time slots rows are per chain (add preset / add custom / remove / reorder by buttons or **drag**; a preset row shows a read-only window summary and edits its selector list only; a custom row carries an editable name, `start`/`end`/`days` and a read-only timezone display), and the tab's own Discard/Save pair writes ONLY that chain (hint: "Saves this chain only: selectors · tail · time slots · name"). The Subagents (子代理) section holds one collapsed role card per role (id + its specified chain route) with its own save pair, and Advanced options (高级选项) is a collapsible disclosure. There is no Main agent section, no feature switch, no timezone picker, no `timeSlots.enabled` master switch and no `rootMode` control.

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
- **Chain stamping** runs at the same dispatch over the same resolved role. A
  role whose `chain` pointer names a declared chain stamps the child onto
  `FallbacksChain / <role.chain>` — local backends only, and only when the
  spawn request carries no explicit `provider`/`model` route (an explicit route
  is **authorized** and never touched). An external-backend child keeps pure
  inheritance. A pointer naming no declared chain behaves as NOT SPECIFIED:
  one startup warn, and the child inherits the delegating agent's route. There
  is no rule matching and no host-policy consultation — the mapping is the
  user's static config.

A child that is neither stamped nor explicitly on a virtual row has no chain
at all — external (acp) backends always land here, because they cannot resolve
the virtual provider out of process.

The same seam serves an ordinary subagent dispatch and an Agent Team teammate
(`spawn_teammate`): both are children dispatched with the same Assignment
header, so nothing Agent-Team-specific is required.

### Role resolution in the walk

An agent's role is resolved at DISPATCH from one source: the child prompt header `**Execute as**: <id>` — a normally delegated Assignment or an Agent Team teammate's initial prompt — trimmed and looked up in the live declared-role set, so an absent header, the reserved `inherit` and a since-removed id all resolve to NOT SPECIFIED. The resolved role's `chain` POINTER decides the chain the child mounts — never a chain definition, and never picked by the plugin. There is no rule matching, no LLM auto-match stage and no `roleAutoMatch` key any more.

### Role persona on the child

When a subagent's dispatch declares a role this plugin knows (the `**Execute as**: <id>` field of its Assignment), that role's `persona` is installed on the child as a scoped system-prompt section at the `deployment:persona-prefix` slot — the same slot the deployment persona uses, so the role persona **replaces** the deployment prefix for that child instead of stacking under it. The role is the child's identity, not only a routing decision, and delivery does not depend on routing: a role with an empty `chain` gets its persona exactly like a chained one (the chain only picks the model). That section lives on the child's own context, so the persona is **not durable**: a role child resumed after a host restart runs without its role persona (the resumed descriptor cannot carry one). A same-named section the child's scope already holds (a persisted descriptor) counts as delivered; any other registration failure is contained — the child runs unchanged and its notice row carries the ` (persona not applied)` suffix. Role resolution and the catalog record still apply, but two accepted boundaries get no persona delivery at all: an external (acp) child creates no local agent, so it gets **no persona, no notice row and no badge**, and a host that never mounts the `systemPrompt` service runs the child with no persona and **no** ` (persona not applied)` suffix (issue `I-000059`).

### Role notice in the child's session

A child dispatched with a declared role gets exactly one plugin notice row in its own session, naming the role it was dispatched as — `[role: <id>]`, with ` (persona not applied)` when the role declares a persona that was skipped — written once at the child's first non-empty pre-step, never for a root session and never for `inherit`/unresolved dispatches. The row is a durable transcript row, so the role stays readable in the child's session after it settles.

### Role badge

A subagent **session** shows a compact badge next to the session's agent-preset (mode) chip in the web session header, reading `role · provider/model`; hover shows `role → provider/model (request route)`. The two halves are independent facts and each is omitted when its own source is absent:

- **Role**: shown only for a child **dispatched with a declared role** — the `**Execute as**: <id>` field of its Assignment, the same declaration that carries the persona, and the badge's ONLY role source. Only the DECLARED header is read, so a child with no Assignment header shows **no role** even when it inherits a route from its parent — the badge never reports a role inferred after the fact. An `inherit`/unresolved dispatch omits the role half; it does not hide the badge.
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

- **The header is the only role carrier.** Resolution reads that declared
  header only, and a teammate whose prompt omits the declaration, or names an id
  that is not currently declared, resolves to NOT SPECIFIED, exactly like a
  normally delegated child without one. There is no rule matching: what the role
  then contributes is its optional `chain` POINTER (「指定降级链」), which mounts the
  child on `FallbacksChain/<chain id>`.
- **Names stay arbitrary (but unique inside one Team).** Any number of
  differently named teammates can carry the same role; there is **no
  name→role mapping**.
- **Non-local provider — two outcomes.** An external (acp) provider creates no
  local agent: a normally delegated external child resolves its role but gets
  **no persona, no notice row and no badge**, while a teammate cannot use one at
  all — `roster.spawn` always reserves a child id and the runtime rejects a
  reserved id for a non-local provider (`UNSUPPORTED_CAPABILITY`), so member
  creation fails and no role is delivered.

Full resolution reference (dispatch source, chain composition) → [docs/configuration.md](configuration.md#role-resolution-and-chain-composition).

## FallbacksChain in the model picker

Whenever a chain is configured (`chains` non-empty), the plugin registers a virtual provider, **FallbacksChain**, with **one catalog row per named chain** — the row id IS the chain id. The web profile and dsh-tui both see the rows: they share the same adapter catalog. A chain with empty or non-conforming entries still shows its row (the walk refuses to serve it); with no chains there are no rows.

Selecting **FallbacksChain / <chain id>** makes that chain the session route: the request stays on the virtual pair, and the adapter's `stream()` **walks** the chain — the first attempt is the chain's first dispatchable exact `provider/model` (slot-effective), and a pre-output trigger-code failure advances to the next candidate inside the same request. Serving the selection unchanged keeps the host's model-change notice quiet: the recorded route equals the session selection, so the notice appears once on a genuine selection change. Selecting any real catalog model instead gives the session **no plugin fallback at all**: the session model is primary and only `llm-retry` retries it.

There is **no `rootMode` switch** — no config key, YAML field, settings toggle, or gateway flag. The mode is the session's `{provider, model}` selection itself: `FallbacksChain` = chain walked; any real model = no plugin fallback.

Notes:

- **Picker label**: the row's catalog `name` (what the composer trigger shows) is live — `` `${chain.label}: <head>[<slot>]` ``, e.g. `默认链: DeepSeek Flash[all-day]` (the chain's label, not its id; catalog display name rather than the model id). Bare `<chain label>` when that chain's tail is non-conforming or its head is unresolvable. Refresh by reopening the picker.
- **One walk for every origin**: the same `stream()` walk serves the root agent and a stamped subagent session on the selection — the walk uses THAT chain's slot-effective entries; there is no origin split.
- **Conformance gate on the tail**: a successful virtual-route request requires the SELECTED chain to be **tail-conforming** — a non-empty `entries` tail must be exactly one official model (`deepseek-official/deepseek-flash` or `deepseek-official/deepseek-v4-pro`, the card's Default model (默认模型) panel), while an empty `entries` fails the walk with `EMPTY_EFFECTIVE_CHAIN`; leading entries (the Default fallback chain, 默认降级链) are walked first. Deactivating the plugin (the Plugins-page row switch, or clearing all configured content) hides the rows again (slot-row/chain edits never churn registration).
- **Stale selection**: if the row disappears (plugin deactivated) while `FallbacksChain / <chain id>` is selected, the session keeps showing it as the current model with `routable: false` — pick a real model from the catalog to continue (host-native catalog semantics).
- **Capabilities follow the head; retry policy does not**: the row's model metadata (context window, modalities, reasoning) mirrors the current effective head, but `providerRetryPolicy` returns `undefined` (documented degradation) — the host captures the policy once per provider at registration, so the virtual route cannot mirror a per-chain head's policy and the host's own default applies; a head provider's custom `retryPolicy` (including `mode: 'always'`) does not apply on this route. Retry events are keyed by the virtual provider — the route the runtime actually sees. Full semantics → [docs/configuration.md](configuration.md).

### Preset roles

The plugin ships **5 bundled generic subagent roles** out of the box — `reviewer` / `scout` / `security-reviewer` / `sonic` / `task` — declared automatically on `apply` as seeded `roles.list` rows (`{ id, persona }`): idempotent, and never overwriting an operator persona. They appear in the Settings card as read-only rows (a source badge on every row; the id and persona cannot be edited there) and in the `/fallbacks config` role summary, ready for a role card's 「指定降级链」 pointer. (`designer` and `librarian` are no longer bundled: rows saved by earlier versions keep their persona and now show source `user` as ordinary editable rows only when no live producer still declares the id, even though the operator never wrote them; a companion's live declaration keeps them seeded and read-only with source `external` when unnamed or its registered set name otherwise.)

- **Switch**: `fallbacks.presets` — `'bundled'` (default) declares the preset roles on apply; `'none'` disables the automatic declaration (already-materialized rows stay).
- Full semantics (upgrade behavior, conflict handling, library reuse of `presetRoles`) → [docs/configuration.md](configuration.md).

## Agent presets (plugin composition)

Agent **presets** are a dsh feature for composing plugins — they are declarative child-plugin lists a user can apply as a set, and they carry **no** model fields of their own. The fallbacks plugin needs no preset-specific configuration: because a preset composes plugins, the plugin exists **wherever its row is mounted** — a preset that includes the `dsh-llm-fallbacks` row gives that preset's sessions the same chains and roles, and its sessions get a chain when they select `FallbacksChain / <chain id>`.

Two composition caveats:

- **A user preset override replaces the entire child list** (no merge): a preset that omits the fallbacks row silently unmounts the plugin for sessions using that preset. Restate every plugin row you want to keep.
- **Preset-scoped chain configs are possible by mounting the row inside a preset**: the plugin row's `config:` overrides in a preset composition produce a chain configuration that applies to that preset's sessions only (patch rows replace the whole `config`, so restate every field).

## dsh-tui surfaces

In a dsh-tui profile the plugin has three operator surfaces, with a strict duty split:

- **`/fallbacks`** — what happened this session: origin, the resolved dispatch role and the chain it points at, every configured chain with its tail and current slot label (the calling agent's selection marked `●`), recent fallback switches, cooldown status (half-open marker rows when `recovery: half-open` is active). Read-only.
- **`/fallbacks config`** — what is configured: composed-config readback (trigger codes, every named chain with its label, entries and time-slot rows, timezone, roles as `{ id, chain }` pointers, cooldown, revert policy, max switches per request walk — printed as `Max switches per request walk` / `单次请求行走最大切换` — and presets). Read-only apart from the one action command **`/fallbacks config revert-seed <role-id>`**, which restores a seeded role's persona to its declared seed default — the web settings card presents seeded personas read-only (no revert affordance), so the command is that action's only surface.
- **`/settings`** — the edit surface. The plugin registers a **fallbacks** section with full parity to the web settings card: selects (`presets`, `revertPolicy`) render as pickers and numbers (`cooldownMs`, `maxSwitchesPerStep`) as numeric inputs; complex structures (`chains` — one JSON field per the named-chain list — and `roles.list` with the chain pointer) are JSON text fields, `triggerCodes` a comma-separated text field and `tz` a plain text field. Invalid drafts (bad JSON, non-conforming chains, malformed time-slot rows) block the save — the section never corrupts the config.

**Requirements**: the `/settings` fallbacks section needs **dsh-tui ≥ v0.8.5** (commit `c51661f` or later on `main`; the settings seam shipped in v0.8.0, the groups shape + validation in v0.8.5). On an older dsh-tui the section is absent, and file editing remains the only TUI edit surface.

File editing still works everywhere: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings, or the profile patch `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (`config:` overrides on the plugin row) for dsh-tui-specific values. A patch row **replaces** the targeted row's whole `config` — restate every field you want to keep (schema defaults fill the rest).

## Mount-only

The plugin mounts as a **pure mount** — no dsh source modification — so every
capability above works without patches; the mount contract is stated in
[README.md](../README.md#mount-only).
