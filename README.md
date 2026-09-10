# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/dt/dsh-llm-fallbacks)](https://www.npmjs.com/package/dsh-llm-fallbacks)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh tui](https://img.shields.io/badge/dsh%20tui-compatible-4B32C3.svg)
![dsh](https://img.shields.io/badge/DSH-0.1.5--rc.1-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-llm-fallbacks?lang=en)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-llm-fallbacks?ref=badge)

Automatic provider/model fallback chains for dsh (DeepSeek Harness): when an agent's LLM requests keep failing — retries exhausted, auth errors, quota exceeded, rate limiting (429) — the plugin switches provider/model along the fallback chain for the current role, and the current step/turn continues on the target model: tasks are not interrupted by model problems.

Works in both dsh front ends: the **web** profile (Settings → Plugins → Fallbacks card) and the **dsh-tui** terminal profile (`/fallbacks` session diagnostics, `/fallbacks config` readback, and the `/settings` fallbacks section for editing).

## Time slots

Time slots rotate the **effective root chain** by wall-clock windows: each slot row carries its own fallback chain, and the first row whose window contains the current moment replaces the all-day chain for the next root request — the all-day chain stays as the last resort when no slot matches. Peak and valley windows can therefore use different chains while the failure walk (fallback switch) remains untouched.

![Time slots](docs/assets/screenshot-1-en.png)

Four frozen UTC+8 presets (windows are code constants; preset rows lock `tz` to Asia/Shanghai):

| Preset | Window |
|---|---|
| `liang-peak` | Monday–Friday 09:00–12:00 and 14:00–18:00 |
| `liang-valley` | every other UTC+8 time (complement of Liang Peak) |
| `glm-peak` | Monday–Friday 14:00–18:00 |
| `glm-valley` | every other time (complement of GLM Peak) |

GLM Peak and GLM Valley are offered in the card picker only when `zai-coding-cn` is configured.

The first extra row whose window contains the current moment (in `fallbacks.tz`, default Asia/Shanghai) wins; no match → the all-day `rootChain`, whose tail (Default model) must be exactly one official model — `deepseek-official/deepseek-flash` or `deepseek-official/deepseek-pro` (XOR). Slot rotation is a routing seed, not a failure decision: it applies on the next root request, consumes no cooldown, and is logged as a time-slot switch — failure walks keep fallback switch. Full semantics → [Time-slot presets](#time-slot-presets) and [docs/configuration.md](docs/configuration.md).

## Quick start

### Install

```sh
dsh plugin --profile web add dsh-llm-fallbacks      # web profile (Settings → Fallbacks card)
dsh plugin --profile dsh-tui add dsh-llm-fallbacks  # dsh-tui terminal profile
```

Same plugin, either front end — the only difference is the `--profile` flag. Pin a version with `@<version>`. A registry install fetches the **built package** (`dist/`), nothing builds on the target machine. Registry / git / local-directory variants, uninstall, and `--dump-config` verification → [docs/install.md](docs/install.md).

### Repair existing sessions (versions before 0.2.2)

Versions before 0.2.2 wrote durable `fallbacks/switch` session events that newer dsh releases refuse to load (issue #52 — the apply()-time event-type registration is ineffective because plugin and host resolve different module instances). If existing sessions fail to open after an upgrade, clone this repository and run the detector:

```sh
git clone https://github.com/omdsh-dev/dsh-llm-fallbacks.git
cd dsh-llm-fallbacks
pnpm install
pnpm repair:fallbacks-switch-logs -- --dry-run
```

The script scans `~/.dsh/sessions` by default (override with `--root <dir>`). **It cannot repair these logs**: the released session-format migration chain (v0→v1) refuses unknown event types even when marked `ignorable: true`, so a "repaired" log would still be rejected on load. The script therefore fails closed — it only reports which sessions contain `fallbacks/switch` events, never writes or backs up any file, and exits non-zero when it finds any (the legacy `--apply` / `--backup` flags are accepted as no-ops). The durable fix belongs upstream at the migration edges. From 0.2.2 on, the plugin stops writing durable switch events, so no new sessions need attention.

### Configuration surfaces

The plugin's settings live in a shared `fallbacks:` namespace, editable from three surfaces:

| Surface | What it is | Notes |
|---|---|---|
| **Web settings card** | Settings → Plugins → Fallbacks | Full GUI editor for the `fallbacks:` namespace; writes the shared settings document |
| **`$DSH_HOME/settings.yaml`** | `fallbacks:` section in the dsh settings document | The shared source of truth — the same file the web card writes; readable and editable everywhere, including scripted setups |
| **TUI `/settings`** | fallbacks section in the dsh-tui settings screen | dsh-tui ≥ v0.8.5; native fields for simple keys, JSON text fields for complex structures (see [dsh-tui profile (terminal)](#dsh-tui-profile-terminal)) |

Pick the surface that matches your front end: web users get the card, terminal users get `/settings`, and the YAML file works everywhere. (`/fallbacks` and `/fallbacks config` are diagnostics — read-only views, not edit surfaces.)

### Minimal configuration

Add a `fallbacks:` section to the shared settings document (`$DSH_HOME/settings.yaml` — see [Configuration surfaces](#configuration-surfaces)):

```yaml
fallbacks:
  enabled: true            # feature switch — defaults to off (plugin is a no-op otherwise)
  rootChain:               # all-day chain: leading entries = fallback walk, last = Default model (official)
    - anthropic/claude-3-5-sonnet          # walked first
    - deepseek-official/deepseek-flash  # last resort (Flash or Pro)
  timeSlots:               # optional: rotate the effective root chain by wall-clock windows
    - kind: preset         # frozen UTC+8 window; only the chain is editable
      preset: liang-peak   # Monday–Friday 09:00–12:00 and 14:00–18:00
      chain:
        - anthropic/claude-3-5-sonnet
    - kind: custom         # custom window (may wrap midnight)
      name: evening        # optional display name
      start: '22:00'
      end: '02:00'
      days: [1, 5]         # optional; omitted/empty = every day (0=Sunday…6=Saturday)
      chain:
        - openai/gpt-4o
  roles:                   # optional: declare role entities, then reference them from rules
    list:
      - id: reviewer       # unique id; "inherit" is reserved
        persona: Code-review subagents
        chain:
          - openai/gpt-4o-mini
        fallback: inherit-root   # role chain first, then the inherited rootChain
    rules:                 # subagent-only: rules never match root requests
      - role: reviewer     # all subagents → the reviewer role
```

Build the section up in four steps:

**1. Enable the plugin.** `enabled: true` turns the fallback engine on. It defaults to **off** — with no chains configured the plugin is a complete no-op.

**2. Set the all-day `rootChain`.** Leading entries are the fallback chain, walked first when a request fails; the **last** entry is the Default model.

> **Conformance**: the last entry must be exactly one official model — `deepseek-official/deepseek-flash` or `deepseek-official/deepseek-pro` (XOR). The settings card and gateway reject any other tail on save; a legacy non-official tail warns at startup and keeps working as a fallback-only walk, but cannot be saved as-is. The retired `deepseek-v4-flash` / `deepseek-v4-pro` ids are no longer legal tails — a saved V4 tail now warns, goes inert (slot rows + virtual picker), and blocks save until a legal tail is picked. `deepseek-pro` is a legal selector whose model is not yet served by the catalog: the card shows it disabled ("not yet available"), and requests to it fail at the provider until the gateway enables the id. The plugin does not probe catalog availability — a chain containing `deepseek-pro` dispatches to it like any other exact entry, and the override resolves the first exact head of the effective chain, so a chain with a working entry before Pro still routes to that earlier entry.

**3. Add `timeSlots` (optional).** Rows rotate the effective root chain by wall-clock windows. Preset rows use frozen UTC+8 windows (only their chain is editable; while a preset row exists, `tz` locks to `Asia/Shanghai`); custom rows take `start`/`end` (may wrap midnight) and an optional `days` list. The first row whose window contains the current moment wins; no match → the all-day `rootChain`. Rotation is a routing seed — it applies on the next root request and consumes no cooldown (see [Time slots](#time-slots)).

**4. Add `roles` (optional).** Declare role entities in `roles.list` (id, persona, chain, optional `fallback` policy), then map subagents to them with `roles.rules`. Rules never match root requests — with no rule match (or on a root request) the built-in `inherit` role applies and appends the `rootChain`.

Full reference (role entities, fallback strategies, rules, selectors, preset roles, time-slot presets) → [docs/configuration.md](docs/configuration.md).

> **Upgrade note (behavior change)**: an existing `fallbacks:` section **without an explicit `enabled` key** resolves to `false` after upgrading — add `enabled: true` to keep the plugin active.

### Verify

Save the config and restart the session, then type `/fallbacks` — the read-only in-session diagnostics (origin, resolved role, chain, recent fallback switches, cooldown status). In a dsh-tui profile, `/fallbacks config` reads back the composed configuration; see [dsh-tui profile (terminal)](#dsh-tui-profile-terminal).

## Features

- **Automatic fallback for root and subagents**: any agent switches down the chain to the next available provider/model on model failure — no manual model switching.
- **Two-block config**: `rootChain` for the root agent; declared role entities (`roles.list`) referenced by `roles.rules` (or the built-in `inherit`).
- **Chain as root primary from the picker**: when `enabled` is on, the host model picker (web and TUI alike) shows a virtual `FallbacksChain` / `Auto` row — selecting it uses the configured chain as the root primary (a conforming all-day head is required for the delegation to succeed); selecting a real model keeps fallback-only (see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)).
- **Time slots**: optional `fallbacks.timeSlots` rows rotate the effective root chain by wall-clock windows in the config-level `tz` timezone (default `Asia/Shanghai`) — four frozen UTC+8 presets (`liang-peak` / `liang-valley` / `glm-peak` / `glm-valley`, windows are code constants, models-only edits) or custom `start`/`end`/`days` windows. The first matching row wins; the all-day row is always last. A slot change applies on the **next** root request and is logged as a **time-slot switch** — a routing seed, never a failure decision: it consumes no cooldown and does not count against `maxSwitchesPerStep`. Failure walks keep the **fallback switch** copy (see [Time-slot presets](#time-slot-presets)).
- **Dispatch-time role resolution**: on a subagent's first request its role is resolved in three stages — explicit (`agentPreset` matches a declared role id) → deterministic rules (matching either the recorded pair or the served head — see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)) → LLM auto-match from the declared role taxonomy (`fallbacks.roleAutoMatch`, default `true`). The resolved role's chain-head model is injected into the first request and recorded via an explicit `role → model` log line (no durable `fallbacks/switch` event is written — issue #52 stop-write); set `roleAutoMatch: false` to disable the LLM auto-match stage (the explicit `agentPreset` stage still applies — with no explicit role this reproduces the previous rules-only behavior). The settings card always renders an **Enable role auto-match** switch (default `true`) to toggle it — the schema default applies even to legacy configs that never declared the key.
- **Subagent role badge**: when a subagent's dispatch resolves a non-`inherit` role (policy on or off), its session shows a compact role badge next to the session title in the web session header — hover shows `role → provider/model`, the effective route after any override/inject. `inherit`/unresolved sessions render no badge; records are in-process only (a host restart clears them — the `role → model` info log stays the durable record).
- **Context-window-aware fallback**: `triggerCodes` accepts any dsh failure code, including `CONTEXT_WINDOW_EXCEEDED` — a request too big for the current model fails over to a candidate with a **larger** context window (candidates that cannot fit either are skipped), and because the route itself is healthy the switch is request-scoped: no cooldown, no half-open probe burned (see [Fallback triggers](#fallback-triggers-triggercodes)).
- **Cooldown and revert**: failed / switched-away models are not re-selected during cooldown; `revertPolicy: cooldown-expiry` returns to the primary model automatically.
- **Host subagent model policy (dsh 0.1.2)**: when the host `subagent-model-selection` policy is enabled, its allowlist is a hard constraint on every plugin-originated subagent route — an explicit authorized spawn route stays the chain head (role-inject skipped), inheritance inject heads and failure-switch targets are intersected with the effective allowlist, and an empty intersection skips the inject/switch (warn log + read-only card warning; no out-of-allowlist request is ever sent). A present-but-unreadable policy fails closed. Policy off/absent → inject and failure-switch selection exactly as 0.3.5. Override `reasoningEffort` follows the upstream routeChanged rule on every path (same route → keep; route change → drop unless explicit). See [Host subagent model policy](#host-subagent-model-policy-dsh-012).
- **Half-open recovery (opt-in)**: `recovery: half-open` makes recovery evidence-driven — an expired cooldown leaves the route half-open for one logged probe instead of restoring the preference; consecutive failures escalate the suppression duration (×2 per failure, capped at 1 h); an observed completion closes the circuit and fully restores the preference. `revertPolicy: 'never'` keeps the mechanism inert; state is session-scoped in-memory (a restart resets). YAML-only — the default `timer` keeps every existing behavior byte-identical (see [docs/configuration.md](docs/configuration.md#recovery-mode-recovery-key)).
- **Visible behavior**: every switch is recorded in an info-level log line (from/to/role/reason) — no silent model switching. The plugin deliberately writes **no** durable `fallbacks/switch` session events (issue #52: the apply()-time event-type registration was proven ineffective, and a session containing the event refused to load after a dsh restart). Sessions written by older plugin versions that contain such events **cannot** be repaired by an `ignorable` flag — the released session-format migration chain (v0→v1) refuses unknown event types even when marked ignorable — so `scripts/repair-fallbacks-switch-logs.ts` now fails closed and only reports such logs (the durable fix belongs upstream at the migration edges).
- **Safety valves**: `maxSwitchesPerStep` caps switches per step and `alwaysModeRetryCap` caps always-mode retries — chain loops cannot amplify latency.
- **No-config no-op**: with no chains configured the plugin behaves exactly like not being installed (`enabled` is off by default — see [Minimal configuration](#minimal-configuration)).

## dsh-tui profile (terminal)

In a dsh-tui profile the plugin has three operator surfaces, with a strict duty split:

- **`/fallbacks`** — what happened this session: origin, resolved role, effective chain, recent fallback switches, cooldown status (half-open marker rows when `recovery: half-open` is active). Read-only.
- **`/fallbacks config`** — what is configured: composed-config readback (trigger codes, root chain, time slots, timezone, roles, role rules, cooldown, revert policy, safety valves, presets, role auto-match). Read-only apart from the one action command **`/fallbacks config revert-seed <role-id>`**, which restores a seeded role's persona to its declared seed default — the web settings card presents seeded personas read-only (no revert affordance), so the command is that action's only surface.
- **`/settings`** — the edit surface. The plugin registers a **fallbacks** section with full parity to the web settings card: booleans (`enabled`, `roleAutoMatch`) render as toggles, selects (`presets`, `revertPolicy`) as pickers, and numbers (`cooldownMs`, `maxSwitchesPerStep`, `alwaysModeRetryCap`) as numeric inputs; complex structures (`rootChain`, `timeSlots`, `roles.list`, `roles.rules`) are JSON text fields and `triggerCodes` a comma-separated text field. Invalid drafts (bad JSON, non-conforming chains, malformed time-slot rows) block the save — the section never corrupts the config.

**Requirements**: the `/settings` fallbacks section needs **dsh-tui ≥ v0.8.5** (commit `c51661f` or later on `main`; the settings seam shipped in v0.8.0, the groups shape + validation in v0.8.5). On an older dsh-tui the section is absent, and file editing remains the only TUI edit surface.

File editing still works everywhere: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings, or the profile patch `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (`config:` overrides on the plugin row) for dsh-tui-specific values. A patch row **replaces** the targeted row's whole `config` — restate every field you want to keep (schema defaults fill the rest).

## FallbacksChain in the model picker

When `enabled: true`, the plugin registers a virtual provider, **FallbacksChain**, with a single catalog row: **Auto**. The web profile and dsh-tui both see the row: they share the same adapter catalog, so the row needs no settings-page wiring or host patch (it is independent of the `/settings` fallbacks section, which edits configuration rather than the picker catalog). The row is visible whenever the plugin is enabled — a legacy or empty all-day chain does NOT hide it (the delegate just refuses to serve it).

Selecting **FallbacksChain / Auto** uses the configured chain as the root **primary**: the request stays on the virtual pair and the adapter's thin delegate dispatches the effective chain's first exact `provider/model` at request time, so the fallback engine degrades from that head as usual. Serving the selection unchanged (instead of rewriting the route to the head) is also what keeps the host's model-change notice quiet: the recorded route equals the session selection, so the notice appears once on a genuine selection change rather than being re-armed on every step. Selecting any real catalog model keeps the v0.2.2 fallback-only behavior — the session model is primary and the chain engages only after it fails.

There is **no `rootMode` switch** — no config key, YAML field, settings toggle, or gateway flag. The mode is the session's `{provider, model}` selection itself: `FallbacksChain` = chain primary; any real model = fallback-only.

Notes:

- **Picker label**: the row's catalog `name` (what the composer trigger shows) is live — `Auto: DeepSeek Flash[Liang Peak]` / `Auto: DeepSeek Flash[all-day]` (catalog display name, not the model id); the id stays `Auto`. Bare `Auto` if the all-day tail is not conforming. Refresh by reopening the picker.
- **Thin delegate on every origin**: the row is served by the same `stream()` delegate for the root agent and for a subagent session that inherits the selection — subagent role resolution and injection keep their semantics apart from one deliberate widening: dispatch-time rule matching accepts **either** the recorded pair or the served head (a superset of the previous matching, so a rule keyed on the real head keeps matching), and the virtual row is never a second routing engine. A subagent that inherits the selection still routes through the chain head.
- **Conformance gate on the tail**: a successful delegation requires the all-day chain to be **tail-conforming** — its last entry must be exactly one official model (`deepseek-official/deepseek-flash` or `deepseek-official/deepseek-pro`, the card's Default model panel); leading entries (Default fallback chain) are walked first. Disabling the plugin hides the row again (slot-row/chain edits never churn registration).
- **Stale selection**: if the row disappears (plugin disabled) while `FallbacksChain / Auto` is selected, the session keeps showing it as the current model with `routable: false` — pick a real model from the catalog to continue (host-native catalog semantics).
- **Capabilities and retry policy follow the head**: the row's model metadata (context window, modalities, reasoning) mirrors the current effective head, and `providerRetryPolicy` returns **that head's** policy — so a user's `llm-deepseek.retryPolicy` applies on this route too, not the permissive default. The host captures the policy once at registration, so a later policy edit or a slot-driven head-provider rotation shows up only after the plugin re-registers. Retry events are keyed by the virtual provider — the route the runtime actually sees. Full semantics → [docs/configuration.md](docs/configuration.md).

## Time-slot presets

Time slots are introduced in the [featured overview](#time-slots) above; this section is the reference. Time-slot rows rotate the **effective root chain** by wall-clock windows — useful for peak/valley pricing without confusing wall-clock rotation with failure fallback. The copy split is strict: slot rotation logs and UI say **time-slot switch**; the failure walk keeps **fallback switch**; the conversation notice Model downgraded stays on the failure path only.

- **Match order**: at every root request, the first extra row whose window contains the current moment (in `fallbacks.tz`, default `Asia/Shanghai` / UTC+8) wins — that row's chain **replaces** the all-day chain. No row matches → the all-day `rootChain` is used. The all-day row is always last and **required**: its last entry must be exactly one official model (Flash / Pro XOR; leading Default fallback chain entries are walked first).
- **Presets** (frozen, not user-editable): `liang-peak` = Monday–Friday 09:00–12:00 **and** 14:00–18:00; `liang-valley` = every other UTC+8 time; `glm-peak` = Monday–Friday 14:00–18:00; `glm-valley` = every other time. One preset id = one row; the card picker never offers a duplicate.
- **Custom rows**: `start` / `end` (`HH:mm`, may wrap midnight) + optional `days` (0=Sunday…6=Saturday; omitted/empty = every day) + models.
- **Next-request apply**: a slot boundary crossing never preempts an in-flight step — the new row takes effect on the next root request. Rotation is mount-only: info log + card/`/fallbacks` status line, no durable switch event.
- **Settings card**: the Main agent section groups Time slots (extra rows — add preset / add custom / remove / reorder by buttons or **drag**; preset rows show a read-only window summary and edit models only; custom rows carry an editable name; the **timezone picker** lives here and **locks to Asia/Shanghai while any preset row exists**, since preset windows are frozen UTC+8 constants), Default fallback chain (walked first when no slot matches) and Default model (the official Flash | Pro last-resort fallback). Rows are collapsible to name + first model. There is no `timeSlots.enabled` master switch (adding a row is the opt-in) and no `rootMode` control.

## Preset roles

The plugin ships **5 bundled generic subagent roles** out of the box — `reviewer` / `scout` / `security-reviewer` / `sonic` / `task` — declared automatically on `apply` as seeded `roles.list` rows (`{ id, persona }`): idempotent, and never overwriting an operator persona. They appear in the Settings card as read-only rows (a source badge on every row; the id and persona cannot be edited there) and in the `/fallbacks config` role summary, ready for `roles.rules` to reference. (`designer` and `librarian` are no longer bundled: rows saved by earlier versions keep their persona but now show source `user`, even though the operator never wrote them.)

- **Switch**: `fallbacks.presets` — `'bundled'` (default) declares the preset roles on apply; `'none'` disables the automatic declaration (already-materialized rows stay).
- Full semantics (upgrade behavior, conflict handling, library reuse of `presetRoles`) → [docs/configuration.md](docs/configuration.md).

## Fallback triggers (`triggerCodes`)

`fallbacks.triggerCodes` is a plain list of dsh failure codes, and **any** code the harness can report is accepted — not only the three defaults (`AUTH` / `QUOTA` / `RATE_LIMIT`). A failure whose code is not listed passes straight through to llm-retry or to the original error, exactly as if the plugin were not installed. Retryable failures (5xx / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE`) need no extra entries: llm-retry backs them off first and the failure enters the chain decision the same way once that budget is exhausted.

### Context-window rejections

A request larger than the model's context window is reported as `CONTEXT_WINDOW_EXCEEDED` — dsh core's canonical code for a provider 400 "maximum context length". It is not a retryable code, so list it explicitly to fail over to a larger-context model:

```yaml
fallbacks:
  enabled: true
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

## Host subagent model policy (dsh 0.1.2)

dsh 0.1.2 adds host-side child-model selection for subagents: a `subagent-model-selection` settings allowlist, a per-session `subagent/model-selection-policy` event, and spawn-time `provider/model/reasoning_effort` routing. The plugin reconciles with it under one runtime arbiter — plugin roles/chains remain the failure-recovery layer the host does not provide.

**Policy read (per session)**: the session `subagent/model-selection-policy` event wins; otherwise the `subagent-model-selection` settings service when `enabled`. Missing service / `enabled: false` / no event → policy off.

When the policy is **enabled**:

- **Authorized head preserved (skip inject)**: a subagent spawned with an explicit `provider`+`model` (spawn options, durable `request/header`, or a `model/selection` selection) keeps that route as its chain head — role-inject is skipped and the authorized route is never overwritten at the first request; the plugin chain applies only from failure time onward. Pure inheritance (no explicit selection fields) is **not** an authorized route.
- **Allowlist-constrained inject**: pure inheritance still resolves a role in the three stages above, but the injected chain head is plugin-originated and must be on the effective allowlist — the first resolved in-allowlist candidate wins. Empty intersection → inject is skipped and the host seed stands (warn log).
- **Allowlist-constrained failure switching**: after a triggering failure, the resolved candidates (wildcards already expanded; cooldown / step-failed / same-as-current filters already applied) are intersected with the allowlist in walk order. Empty intersection → **no switch**, no out-of-allowlist request, a warn log plus an in-memory blocked-attempt record (no durable session write — issue #52 stands).
- **Fail-closed**: a present-but-malformed policy event, or enabled settings with an unreadable route list, disables plugin-originated injects and switches for that session (warn log); the host seed and non-switch behavior are untouched.
- **Card status area (read-only)**: the Fallbacks card Subagents section shows the effective allowlist, the effective chain head with its source (`authorized` / `injected`), and an empty-intersection warning when a switch was blocked — the same numbers the runtime uses, never a second write-face.
- **Virtual-route carve-out**: a subagent explicitly spawned on the plugin's virtual provider (`FallbacksChain` / `Auto`) is user-authorized for that route (spec D2 — explicit selection). The virtual adapter's internal delegation of its requests to the configured effective chain head is that route's documented purpose and is outside D1's selection semantics — D1 governs provider/model selection the plugin makes, not delegation inside an explicitly chosen virtual route — so the delegated head is not allowlist-filtered.

When the policy is **disabled or absent**, inject and failure-switch **selection** are unchanged from 0.3.5 (no allowlist filter, no authorized-route skip).

**Effort rule (policy-independent)**: `reasoningEffort` on every override path (role-inject, failure switch, always-cap switch) follows the upstream 0.1.2 `routeChanged` rule — an unchanged provider+model route keeps the seed effort; a route change drops it unless an effort is explicitly named for the override (explicit always survives). A stale effort is never carried into a different provider.

Full semantics → [docs/configuration.md](docs/configuration.md#host-subagent-model-selection-dsh-012).

## Mount-only (no dsh modification)

The plugin installs as a **pure mount**: bundle insert + client inject + its own gateway channel (`/api/fallbacks/get|set|reset`) — no dsh patches, no postinstall step, and dsh upgrades never require re-patching. Stale leftover patches from an older patched install are harmless.

## Documentation

| Doc | Content |
|---|---|
| [docs/install.md](docs/install.md) | profile install (web + dsh-tui) / registry / git / local variants / uninstall / `--dump-config` verification |
| [docs/configuration.md](docs/configuration.md) | full `fallbacks` namespace reference, selector syntax, example YAML, plugin-config card usage, TUI readback, behavior notes, preset roles |
| [docs/consumer-api.md](docs/consumer-api.md) | developer consumption contract: library API + named `llm-fallbacks` service + role seeds, export inventory, lifecycle, typing |
| [docs/release.md](docs/release.md) | release process: Trusted Publishing setup, Release prep SOP, fragment format, rollback |
| [docs/verification.md](docs/verification.md) | verification records (test matrix, bundle layer order, runtime contracts, QA gate script) |

## License

Released under the **MIT** License — see [LICENSE](LICENSE). The LICENSE file is authoritative for copyright and license terms.
