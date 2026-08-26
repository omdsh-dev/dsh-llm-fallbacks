# Configuration Guide (`fallbacks` Namespace)

Plugin configuration lives in the `fallbacks` settings namespace. It can be edited in the dsh settings document (default `$DSH_HOME/settings.yaml`) or in the web settings GUI via **插件配置 (Plugin Settings) → Fallbacks card** — both read and write the same namespace. The card's reads/writes go through the **plugin's own gateway channel** (`/api/fallbacks/get` / `/api/fallbacks/set` / `/api/fallbacks/reset`) and do not depend on any settings-exposure mechanism of the dsh host; the `fallbacks` namespace not appearing in the host's describe exposure is by design. The plugin makes **zero local modifications** to the dsh source tree (pure mount: bundle row insert + client inject + its own gateway), so dsh upgrades never require re-patching.

## Two-block model

Since iter-20260813 the configuration follows a **two-block model** — you only need to remember two blocks:

| Block | In one sentence | Config location |
|----|--------|----------|
| Block 1 | The root agent's failures follow this one chain only; empty = no fallback | `rootChain` |
| Block 2 | Declare roles first, then let rules reference them; no match inherits root | `roles.list` + `roles.rules` |

**Do not mix them up:**

- `'inherit'` = the built-in **role id** (rule target / no-match default; **forbidden** in `roles.list[].id`);
- `'inherit-root'` = the **chain-append policy** on a role entity (default; runs the role chain, then **appends** `rootChain`);
- the old "role-resolution fallback field" **has been removed** and is no longer valid configuration (see the migration mapping table below for how to rewrite it).

## Field overview

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Feature-level master switch. Defaults to off (`false`): when `false` the plugin never intervenes and the card hides the configuration form body; when `true` but with no chains configured, the behavior is identical to an uninstalled plugin (no-op) |
| `triggerCodes` | string[] | `['AUTH', 'QUOTA', 'RATE_LIMIT']` | Failures with these codes enter chain decision. Retryable failures (5xx / `RATE_LIMIT` etc.) are first retried with backoff by llm-retry and enter the decision the same way once its budget is exhausted — **no extra `triggerCodes` entries are needed for 5xx** |
| `rootChain` | string[] | `[]` | **主代理 — the all-day chain**. Must END with exactly one official V4 model (`deepseek-official/deepseek-v4-flash` **or** `deepseek-official/deepseek-v4-pro` — the card's 默认模型 panel); leading entries (the card's 默认降级链 block) are walked first, then the tail is the last-resort fallback. An empty chain or a chain whose last entry is not an official V4 model warns at startup, keeps the v0.2.2 fallback-only walk, and refuses the virtual picker override/delegate, but cannot be saved as-is through the card/gateway. Used whenever no `timeSlots` row matches |
| `roles.list` | Array | `[]` | **Block 2**. Declarative role-entity collection (id/persona + optional chain/fallback; entry fields in the table below). The id must match `/^[a-z0-9-]{1,32}$/` and be unique within the collection; `'inherit'` is a reserved word and **must not** be used as an id |
| `roles.rules` | Array | `[]` | **子代理 — role rules (SUBAGENT-ONLY)**: match to a role in order by `provider`, `model` patterns (omitted fields are unconstrained; first match wins; root requests NEVER match rules and resolve to `inherit`); `role` may only reference `roles.list[].id` or the built-in `'inherit'`. The legacy per-rule `origin` field is accepted for config compatibility and IGNORED at match time |
| `cooldownMs` | number | `300000` | Cooldown duration (milliseconds). Switched-away / failed models are not re-selected during the cooldown period |
| `revertPolicy` | `'cooldown-expiry'` \| `'never'` | `'cooldown-expiry'` | Primary-return policy after cooldown expiry: return to the primary model on expiry / keep the fallback model for the session |
| `recovery` | `'timer'` \| `'half-open'` | `'timer'` | Cooldown-expiry recovery mode: `'timer'` restores the preferred candidate when the cooldown expires (today's behavior, byte-identical); `'half-open'` leaves the route half-open for one logged probe instead (see [Recovery mode](#recovery-mode-recovery-key)). Optional key — unset configs resolve to the default via the schema; YAML-only (no card / TUI control) |
| `maxSwitchesPerStep` | number | `8` | Per-step safety valve: the switch-count cap per step; beyond it switching stops and the original error semantics are kept, preventing chain loops from amplifying latency |
| `alwaysModeRetryCap` | number | `5` | Always-mode retry cap: providers with `retryPolicy.mode === 'always'` switch after this many retries within the same request; `0` disables |
| `presets` | `'bundled'` \| `'none'` | `'bundled'` | Preset-role switch: `'bundled'` declares the 7 bundled preset roles as seeded `roles.list` rows on apply; `'none'` disables declaration (zero declarations, zero writes from this switch). Optional key — unset configs resolve to the default via the schema. See [Preset roles](#preset-roles-presets-key) |
| `roleAutoMatch` | boolean | `true` | Dispatch-time LLM role auto-match switch: when `true` (default), a subagent-origin request whose role is not resolved by an explicit `agentPreset` or a rule may have the best-fit declared role picked by the LLM (three-stage resolution — see [Dispatch-time role resolution and injection](#dispatch-time-role-resolution-and-injection-roleautomatch)); `false` disables ONLY the LLM auto-match stage — with no explicit role it reproduces the previous rules-only behavior (the explicit `agentPreset` stage is independent new behavior, not gated by the toggle). Optional key — unset configs resolve to the default via the schema |
| `timeSlots` | Array | `[]` | Extra time-slot rows (see [Time slots (分时切换)](#time-slots-分时切换)): the FIRST row whose window contains the current moment wins and its chain **replaces** the all-day chain; no match → `rootChain`. Rows are `{ kind: 'preset' \| 'custom', preset?, start?, end?, days?, chain }` — preset windows are frozen code constants, custom windows may wrap midnight. There is NO `timeSlots.enabled` master switch — adding rows IS the opt-in. The gateway rejects malformed rows on save (unknown preset ids, duplicate presets, preset rows carrying windows, non-`HH:mm` custom bounds, out-of-range days, empty chains) |
| `tz` | string | `'Asia/Shanghai'` | Config-level timezone for slot matching (standard `Intl` timezone rules, DST-safe). Not per-slot; no settings-card picker this iteration (YAML only) |

> The defaults are defined by `defaultFallbacksConfig` in `src/config.ts`; the card shows the default value next to numeric fields (`cooldownMs` / `maxSwitchesPerStep` / `alwaysModeRetryCap`) and the currently effective value for all other fields (which equals the default when unset).

### `roles.list` entry fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Role id: `/^[a-z0-9-]{1,32}$/`, unique within the collection; `'inherit'` is reserved and forbidden |
| `persona` | string | Recommended | Personality hint (free text, not validated); schema default is the empty string, absence does not block saving |
| `chain` | string[] | No (enforced by the settings card on save) | The role's own ordered fallback chain (entry syntax same as `rootChain`). **Required semantics**: a role without model config is meaningless — the settings card enforces at least one entry on save (an empty chain blocks the save + inline hint); a hand-written YAML with a missing/empty chain warns at startup (no crash); at runtime a missing chain still falls back to `rootChain` defensively |
| `fallback` | `'inherit-root'` \| `'none'` | No (default `'inherit-root'`) | Chain-append policy: `inherit-root` = append `rootChain` after the role chain; `none` = the role's own chain only |
| `prompt` / `permissions` | string / object | No | **Reserved fields** (see next section) |

**Seeded rows**: a companion plugin may also auto-provision role rows through the service seeding API — a seeded role is a plain `roles.list` row (`{ id, persona }`, two keys only): seeds never write `chain` / `fallback` (a new seeded role keeps an empty chain until you fill it), its persona can be reverted to the currently declared seed default from the card or via the service, and the card shows a seed badge. The card renders a seeded role's id as a disabled (immutable) field — the id of any seed/preset role cannot be changed from the card (R2); persona, chain and fallback stay editable. See [docs/consumer-api.md](consumer-api.md) → Role seeds. The plugin itself also auto-provisions 7 bundled preset roles on apply by default (see [Preset roles](#preset-roles-presets-key)) — same seed semantics, same badge / revert affordance.

### `roles.rules` entry fields

| Field | Type | Description |
|---|---|---|
| `origin` | `'root'` \| `'subagent'` | **Legacy field (ignored at match time)** — rules are subagent-only; kept so pre-feedback configs parse and save unchanged |
| `provider` | string | Provider constraint; omitted = unconstrained |
| `model` | string | Model constraint; omitted = unconstrained |
| `role` | string | Rule target: **must** reference `roles.list[].id` or the built-in `'inherit'`; an undeclared reference → warning + `legacyKeys`, the entry does not take effect |

### `prompt` / `permissions` (reserved fields)

`prompt` and `permissions` (`allow` / `deny`) on `roles.list` entries are **schema-reserved fields**:

- **Writing them in YAML does not change this round's fallback behavior** — there is no runtime consumer this round;
- **The UI does not show them this round** — the Fallbacks card does not render these two fields;
- **next iteration: consumed by the plugin's subagent tool** — landing as persona injection and tool filtering (the planned `fallbacks-explicit-role-tool`).

## Preset roles (`presets` key)

The plugin ships **7 bundled omp-style preset roles** — generic subagent roles available out of the box: `designer` / `librarian` / `reviewer` / `scout` / `security-reviewer` / `sonic` / `task`. Each persona is a concise instruction set distilled from the omp bundled agent prompts (`packages/coding-agent/src/prompts/agents/`, snapshot 2026-08-16) — a distillation, not a verbatim copy of a full prompt.

| `presets` value | Effect |
|---|---|
| `'bundled'` (default) | On `apply`, the plugin automatically declares the 7 preset roles through the role-seeds surface: they materialize as plain `roles.list` rows (`{ id, persona }`, two keys only) |
| `'none'` | No declarations, no writes — this apply round makes **zero** settings writes on account of this switch |

- **Idempotent**: re-declaring the same preset payload is a no-op — repeated `apply` / HMR / fiber swaps never duplicate rows and never drop an override.
- **Not gated by `enabled`**: the self-declaration fires on apply regardless of the feature switch — even a default install (`enabled: false`) materializes the 7 preset rows. The only zero-declaration path is `presets: 'none'`.
- **Upgrade behavior**: with the default configuration, the first `apply` after upgrading materializes the 7 rows into `roles.list`; each row shows the **seeded badge + revert** from the settings card (existing capability — no extra configuration). Setting `presets: 'none'` stops further declarations but does **not** retract already-materialized rows — delete them by hand if you want them gone. **Honest limitation**: a hand-deleted row is re-materialized by the next `apply` (the plugin cannot distinguish "operator deleted" from "never existed").
- **Same-name operator rows are never overwritten**: a row the operator already defined keeps its persona — the declaration is flagged with a loud `logger.warn` (`'persona-source'` conflict, seed semantics unchanged) and the row still derives `seeded=true`, so the badge / revert affordance is available. The preset persona is only ever applied to a brand-new row.
- The `presets` key is an **optional, YAML-only** switch — the settings card does not render a control for it this round. Unset configs resolve to the default through the schema; an invalid value (anything other than `'bundled'` / `'none'`) fails at config resolve, like `revertPolicy`.

## Entry syntax

**Chain entries** (the values of `roles.list[].chain` / `timeSlots[].chain`, ordered; the all-day `rootChain` is a single-entry list — exactly one official V4 model):

- `provider/model` — exact switch: switch to the specified model; the model id may itself contain `/` (e.g. NVIDIA NIM `nvidia/minimaxai/minimax-m3` or Hugging Face `org/repo`-style names);
- `provider/*` — keep the failed model id and switch the provider only; when the target provider lacks this model id the candidate is skipped (fuzzy near-match resolution is out of scope for this iteration).

> **The chain-key namespace is removed**: the three key semantics of the old `chains` key (`provider/model` exact, `provider/*` wildcard, role-name keys) no longer exist — model-specific routing on failure is now approximated by `roles.rules` (matching to a role by provider/model pattern), and role membership is expressed by declared entities. The entry-side `provider/*` wildcard stays a valid YAML entry everywhere (role chains and `timeSlots[].chain`); the settings GUI no longer offers a wildcard checkbox in any chain editor (role and time-slot chains alike) — chains are edited as provider/model lines, a hand-written `provider/*` entry reads back with a conversion hint and becomes an exact entry once a model is picked, and provider-any matching is expressed through…

Whitespace padding: whitespace padding in a selector (e.g. `other/ gpt-4o`) is **preserved as-is** on save (the GUI does not rewrite user input); runtime parsing normalizes it (`parseSelector` tolerates whitespace), so the semantics are identical to the unpadded form.

Invalid/unknown entries (missing separator, empty segment, wildcard inside a model id, etc.) warn at save validation and **block the save** (card) or warn at startup (validation function); they never crash and never take effect. `*` is only valid as the entire model segment (the `provider/*` wildcard) and is rejected inside a model id. In a running dsh environment (with a model-catalog service) `*/*` never matches — the target provider has no `*` model catalog, so the existence probe skips that candidate.

## Role resolution and chain composition

**Role resolution** (PR #62 feedback: rules are SUBAGENT-ONLY — root requests never match rules and always resolve to `inherit`; ordered matching for subagents, first match wins):

1. `roles.rules` matches by `provider` / `model` pattern (omitted fields are unconstrained; the legacy per-rule `origin` field is ignored) → the target role of the matched rule;
2. no rule matches (or the agent is root-origin) → the built-in `'inherit'` role (no own chain → `rootChain`).

`inherit` is a **reserved role id**: it serves only as a rule target / no-match default and **must not** be written to `roles.list[].id`. A matched rule whose target role is not declared in `roles.list` → defensive fallback to `'inherit'` with a warning.

**Chain composition** (append-not-replace): the actual candidate chain for a matched role is

```text
[...role.chain, ...(role.fallback === 'none' ? [] : rootChain)]
```

- `fallback: inherit-root` (default): the role's own chain first, `rootChain` as the trailing fallback;
- `fallback: none`: the role's own chain only; an empty own chain with `none` → no-op pass-through;
- no rule matched (`inherit`) or role undeclared: candidate chain = `rootChain`.

> **Root tail is slot-effective (分时切换)**: for ROOT-origin agents the trailing `rootChain` in the composition above is replaced by the **effective chain** at request time — `resolveEffectiveChain(config, now, tz)`: the first matching `timeSlots` row's chain, else the all-day `rootChain` (see [Time slots](#time-slots-分时切换)). Subagent walks keep the raw `rootChain` (role-inject unchanged).

Candidate filtering (skipped on hit): same as the current model, in cooldown, already failed this step, or the `provider/*` entry's target provider lacks this model id.

> **Roles require model config**: a declared role without model config is meaningless — either give the role at least one `chain` entry or have rules reference the built-in `inherit` directly. The settings card enforces this on save (an empty chain blocks the save + inline hint); a hand-written YAML with a missing/empty chain triggers a `logger.warn` at startup (no crash); at runtime a missing chain still falls back to `rootChain` defensively (the existing "no chain → rootChain" behavior is unchanged).

> **Runtime landing note**: the new role-resolution / chain-composition semantics above are consumed by the runtime (`src/roles.ts` / `src/chains.ts` / `src/index.ts`, fallbacks-role-runtime Plan 2); old-shape fields (`chains` / `roles.default` / undeclared role references) are flagged for migration at startup via `detectLegacyKeys` (see the migration mapping table below), and decision behavior follows the new model.

## Dispatch-time role resolution and injection (`roleAutoMatch`)

**Dispatch-time resolution** runs at a **subagent-origin** agent's **first request** only (a per-agent once-marker; a later request never re-evaluates). The role is resolved in **three ordered stages** (first hit wins):

1. **Explicit** — the subagent's `agentPreset` session-header value, trimmed, matches a declared role id → that role. The reserved `'inherit'` and any undeclared preset are **never** dispatchable explicit roles and fall through to rules.
2. **Rules** — the same deterministic `roles.rules` matching as failure-time, subagent-only (a declared role wins; no rule match → the built-in `'inherit'`).
3. **LLM auto-match** — only when stage 2 resolved to `'inherit'` **and** `roleAutoMatch: true` (the default): the model picks the best-fit declared role from the taxonomy (id + persona). The call is **bounded** — one completion per decision, a small `maxTokens`, a 5s timeout that abandons the stream; `none`, an unknown/garbage id, a timeout, any throw, an empty taxonomy, or an absent `llm` service all resolve to `'inherit'` and never block the request.

When a **specific** role resolves (anything but `'inherit'`), its **chain head** — the first exact (non-wildcard) candidate of the role's concatenated chain — is **injected** into the agent's first request when it differs from the request's current model: the request is overridden to the head (`overrideConfig`), and an explicit `role → model` log line is written (no durable `fallbacks/switch` event is appended — issue #52 stop-write; the `role-inject` reason survives only in the event vocabulary for legacy events). Injection is **idempotent** (first request only) and **not a failure decision** — it writes no pending switch, no cooldown, and no failure bookkeeping (no `commit()`).

Key semantics:

- **`roleAutoMatch: false`** disables stage 3 (the LLM auto-match) only — the explicit (`agentPreset`) and rules stages still resolve and inject under `false`. "Reproduces the previous rules-only behavior" applies precisely when there is **no explicit role** and no rule match; the explicit stage is independent new behavior, not gated by the toggle. The key is **toggleable in the settings card**: the Fallbacks card always renders an "Enable role auto-match" switch (default `true`, read/write via the same draft → `set` save path). The schema default applies whenever the key is unset — a legacy config that never declared the key still shows the toggle on, and its first save pins `roleAutoMatch: true` (semantically identical to the default).
- **Judgment-call route**: the auto-match LLM call routes via the roles' declared chain selectors first (the first exact `provider/model` across the declared chains in declaration order), then the agent's own provider/model, else it is skipped (`inherit`). A session whose active provider is outside the declared taxonomy therefore never auto-matches — it fails safe to `'inherit'`, it never errors.
- **First-request failure is permanent (anti-hotloop)**: the dispatch-injection once-marker is set **before** the resolution try, so a transient first-request failure (e.g. an auto-match timeout) permanently forgoes dispatch injection for that agent — the deliberate anti-hotloop choice; the agent keeps its `'inherit'` (no specific role) routing for its lifetime.
- **Role id `none` edge**: a declared role id `none` collides with the auto-match `none` decline token — such a role can be selected via the explicit/rules stages but can never be picked by auto-match.
- **`'inherit'` never injects**: the "no specific role" outcome always leaves the request's model untouched.
- **Root agents are untouched**: the dispatch-time path applies to `session.header.origin === 'subagent'` only; a root agent's model follows the normal selection/fallback path.
- **`role-inject` is an additive event reason (vocabulary only)**: the `fallbacks/switch` payload stays a superset of the failure-time shape; for legacy events (the plugin writes no new durable events — issue #52), renderers show a localized `role-inject` label and an explicit `role → model` line (conversation badge card / recent-switch lines), with any unknown reason still rendered raw.
- **Documented degradation (honesty)**: dispatch injection reuses the same `agent/request` override path as the failure-time fallback, so whether it survives a **manual web model selection** depends on waterfall listener order — the same documented degradation as the failure-time switch (see the model-selection coordination note in the card-usage section and [docs/verification.md](docs/verification.md) §4.3).

## FallbacksChain in the model picker (root primary)

When `enabled` is true (PR #62 feedback: registration is enabled-only — conformance is NOT part of it), the plugin registers a virtual **FallbacksChain** provider with one catalog row, **Auto**, on the host LLM runtime. Web and dsh-tui both see the row because they share the same adapter catalog (`session.models` / `listModels`) — no settings-page control or TUI surface is involved.
- **Picker label**: the catalog row's `id` stays `Auto`; its `name` (what the host ModelSelect trigger and menu render) is live — `Auto: <displayName>[<slot>]`, e.g. `Auto: DeepSeek V4 Flash[Liang Peak]`. The display name comes from the head provider's catalog (`listModels`), not the model id, so the same id on different platforms stays distinguishable. Slot label comes from `resolveSlotState`. Bare `Auto` when the all-day chain is non-conforming. The host reloads the catalog on picker open, so the label refreshes then.

- **Select-is-primary**: selecting `FallbacksChain` / `Auto` means "use the configured chain as the root primary". At `agent/request`, a root-origin seed of the virtual pair (plugin `enabled`; detected after pending-switch application, so a failure decision already progressed past the head wins) is overridden to the **first exact `provider/model` head** of the effective chain at that moment — `resolveEffectiveChain(config, now, tz)` from `src/time-slots.ts`, slot-aware when a `timeSlots` row matches, `rootChain` otherwise; the resolver is the single source and there is deliberately no `rootChain[0]` fallback branch. A non-conforming all-day head (empty or not an official V4 model) or an empty/wildcard-only effective chain yields no override and one warn.
- **Real models stay fallback-only**: selecting any real catalog model keeps the v0.2.2 semantics — the session model is primary, the chain engages only after it fails.
- **No `rootMode`**: there is no config key, YAML field, settings toggle, or gateway flag for this mode; the mode is the current session `{provider, model}` selection itself.
- **Root only**: the override applies to root-origin agents only (mirroring the role-inject gate). Subagent seeds that still carry the virtual pair are not overridden — their requests route through the virtual adapter's thin `stream()` delegate (below); subagent role resolution and injection are unchanged.
- **Registration lifecycle**: the row registers whenever `enabled` — an idempotent transition-reconcile on committed config snapshots, unregistering on disable. The condition deliberately ignores `timeSlots` and conformance, so slot-row / chain edits never churn registration. A duplicate registration across fibers degrades to the first fiber owning the route (`DUPLICATE_ADAPTER` caught).
- **Tail-conformance gate for the override/delegate**: a successful primary override and a successful `stream()` delegate both require the all-day chain to be **tail-conforming** — its LAST entry must be exactly one official V4 model (`isAllDayConforming` in `src/time-slots.ts`; leading 默认降级链 entries are walked first). A legacy multi-model or empty chain keeps the row visible but refuses the override (one warn) and the delegate (`UNDISPATCHABLE_EFFECTIVE_HEAD`).
- **Thin delegate**: the virtual adapter's `stream()` resolves the effective head and dispatches that real pair through the host LLM runtime — no chain walk, cooldown, caps, revert bookkeeping, or state writes live in the route (those stay in the `agent/request` / `agent/request-error` listeners). A failure inside the delegate surfaces at `agent/request-error`, where the existing engine walks from there. An empty effective chain, an undispatchable head (non-conforming all-day / wildcard / malformed / self-route), or a vanished runtime throws an explicit `LlmError`, normalized by the runtime into a terminal error finish — the documented listener-order degradation stays graceful.
- **Metadata follows the head**: `resolveModel('Auto')` proxies the current effective head's model info (modalities / context window / reasoning) when resolvable, with a permissive identity default otherwise (never throws). `providerRetryPolicy` keeps the permissive default: retries and failures are attributed to the real head pair the delegate dispatches, not to the `FallbacksChain` provider — retry attribution limits are a documented consequence of the mount-only design.
- **Stale selection after unregister**: if the row disappears (plugin disabled) while `FallbacksChain` / `Auto` is the session selection, the host keeps showing it as session `current` with `routable: false` (host-native catalog semantics) — select a real model to continue.

## Time slots (分时切换)

Time slots are the wall-clock peak/valley model: each slot row — a frozen UTC+8 preset (Liang Peak / Liang Valley / GLM Peak / GLM Valley) or a custom window — carries its own fallback chain, and the first matching row becomes the effective root chain while the all-day chain stays as the last resort (see the featured overview on [README.md](../README.md#time-slots)).

![Time slots](docs/assets/screenshot-1-en.png)

Time-slot rows rotate the **effective root chain** by wall-clock windows. At every **root** request the resolver (`resolveEffectiveChain` in `src/time-slots.ts`) walks the stored rows top-to-bottom: the FIRST row whose window contains `now` (in the config-level `tz`, default `Asia/Shanghai`) wins and its `chain` **replaces** the all-day chain (never concatenated); no match → the all-day `rootChain`. Subagent walks and role-inject are unchanged. The all-day row is always last and **required**.

**Copy split (never mix):** slot rotation is a **分时切换** / time-slot switch — a routing seed: it applies on the **next** root request (no mid-step preemption), is exempt from `cooldownMs` and does not count against `maxSwitchesPerStep`, and is mount-only (info log + card / `/fallbacks` status line; no durable `fallbacks/switch` event). The failure walk keeps **降级切换** / fallback switch and the conversation notice 模型已降级 / Model downgraded stays on the failure path only.

### Row shape

```text
{ kind: 'preset' | 'custom', preset?, start?, end?, days?, name?, chain }
```

| Field | Type | Rules |
|---|---|---|
| `kind` | `'preset'` \| `'custom'` | Required. Anything else is rejected on save (the resolver warns and skips at load) |
| `preset` | string | `kind: 'preset'` only — one of `liang-peak` / `liang-valley` / `glm-peak` / `glm-valley`. At most ONE row per preset id (duplicates are rejected on save, first row wins at load). Preset rows must NOT carry `start`/`end`/`days`/`name` — their windows are frozen code constants and their name is the frozen label |
| `start` / `end` | string (`HH:mm`) | `kind: 'custom'` only — strict 24h format. `end` is EXCLUSIVE; `start > end` wraps midnight |
| `days` | number[] | Custom only — 0=Sunday … 6=Saturday; omitted/empty = every day |
| `name` | string | Custom only — display name (shown in the settings card's collapsed rows and the `/fallbacks` status line); omitted = `custom start-end` |
| `chain` | string[] | Always required and editable (entry syntax below). A matched row's chain is the effective chain |

### Frozen preset windows (UTC+8)

| preset | Window (not user-editable) |
|--------|----------------------------|
| `liang-peak` | 09:00–12:00 **and** 14:00–18:00 (both clocks, Monday–Friday; ONE row) |
| `liang-valley` | all UTC+8 times that are not Liang Peak (complement of the peak) |
| `glm-peak` | Monday–Friday 14:00–18:00 |
| `glm-valley` | all other times (complement of GLM Peak) |

### All-day chain tail (默认模型) and chain (默认降级链)

The all-day `rootChain` is a chain: its LAST entry (the tail — the card's 默认模型 panel) must be **exactly one** official V4 model — `deepseek-official/deepseek-v4-flash` XOR `deepseek-official/deepseek-v4-pro`; leading entries (the card's 默认降级链 block) are optional, ordered walk targets before that last-resort fallback. The card renders the tail as an exclusive 2-choose-1 panel (required, not removable) and the rest as a selector list above it (UI order = walk order), and both the card and the gateway **reject** any value whose last entry is not an official V4 model on save — an empty chain or a legacy non-official-tail `rootChain` cannot be saved as-is (no migration wizard; pick one of the two models). At load, a non-conforming tail earns ONE startup warn, slot rows stay inert, the virtual picker row refuses override/delegate, and the v0.2.2 fallback-only walk continues over the raw chain.

### Save rules (card + gateway)

The gateway (`/api/fallbacks/set`) and the card's pre-save validation apply the same guards: all-day must conform; preset ids must be known and unique; preset rows carry no windows; custom rows need strict `HH:mm` bounds and 0–6 integer days; every row needs a non-empty chain. Malformed rows are rejected — they are never persisted.

## Example YAML

The following configuration demonstrates the full two-block shape — a root chain, role entities (including their `fallback` policy), and rules referencing declared roles / the built-in `inherit` (write it into `$DSH_HOME/settings.yaml`):

```yaml
fallbacks:
  enabled: true
  triggerCodes:
    - AUTH
    - QUOTA
    - RATE_LIMIT
  rootChain:                     # All-day chain: LAST entry is 默认模型 (official V4)
    - anthropic/claude-3-5-sonnet          # leading entries = 默认降级链 (walked first)
    - deepseek-official/deepseek-v4-flash  # last = Flash XOR Pro last-resort fallback
  timeSlots:                     # Optional: rotate the effective root chain by wall-clock windows
    - kind: preset               # Frozen UTC+8 windows; only the chain is editable (locks tz to Asia/Shanghai)
      preset: liang-peak         # Monday–Friday 09:00–12:00 AND 14:00–18:00
      chain:
        - anthropic/claude-3-5-sonnet
    - kind: custom               # Custom window: HH:mm, may wrap midnight
      name: 晚班                   # Optional display name (custom rows)
      start: '22:00'
      end: '02:00'
      days: [1, 5]               # Optional; omitted/empty = every day (0=Sunday…6=Saturday)
      chain:
        - openai/gpt-4o
  tz: Asia/Shanghai              # Config-level slot timezone (default Asia/Shanghai; preset rows lock it)
  roles:                         # Block 2: declare roles first, then let rules reference them
    list:
      - id: reviewer             # Role entity: unique id matching /^[a-z0-9-]{1,32}$/; 'inherit' is reserved
        persona: Code review subagent   # Personality hint (free text)
        chain:                   # The role's own chain
          - openai/gpt-4o-mini
        fallback: inherit-root   # Default: append rootChain after the role's own chain
      - id: cheap
        persona: Cost first
        chain:
          - deepseek/deepseek-chat
        fallback: none           # Role's own chain only; no rootChain appended
    rules:                       # Subagent-only: match provider/model in order, first hit wins; specific rules before broad ones
      - provider: deepseek       # Most specific first: exact provider/model → explicitly targets the built-in inherit (root chain)
        model: deepseek-reasoner
        role: inherit
      - role: reviewer           # All subagents → reviewer role
      - provider: deepseek       # Broad rules last: other deepseek providers' agents → cheap role
        role: cheap
  cooldownMs: 300000
  revertPolicy: cooldown-expiry
  recovery: timer              # Optional: 'timer' (default) | 'half-open' — evidence-driven recovery
  maxSwitchesPerStep: 8
  alwaysModeRetryCap: 5
```

Key points:

- The example sets `enabled: true` explicitly — the feature switch defaults to `false`; without an explicit opt-in the plugin never intervenes and the card hides the configuration form body.
- The first chain entry is the first fallback target after the primary model; entries in the chain are ordered by priority.
- Declaring a role without any rule = that role is **never hit** (a no-match goes to `inherit` → `rootChain`); to have a role hit you must also write a `roles.rules` entry referencing it.
- `role: inherit` is a valid rule target: it explicitly points a class of requests at the built-in inherit (the root chain).
- `timeSlots` rows rotate the effective root chain by wall-clock windows: first matching row wins (its chain replaces the all-day chain), no match → the all-day `rootChain`; the all-day row is always last and required (exactly one official V4 model — the example above shows both).
- Switching only changes the provider/model routing of subsequent requests; it does not reset session context or tool state.
- Each chain-target model needs its own credentials and quota configured (costs/quotas can differ between providers).

## Migration mapping table (old format → new format)

Legacy-format (iter-20260812 and earlier) configuration is **not migrated automatically**: once detected, the plugin flags it through three channels (see the next section) and the user rewrites it manually per the table below.

| Old (iter-20260812 and earlier) | New |
|----------------------------|-----|
| `chains: { default: [...] }` | `rootChain: [...]` |
| `chains: { reviewer: [...] }` | `roles.list: [{ id: reviewer, chain: [...] }]` (also write a `roles.rules` entry for the role to be hit; declaring without referencing = never hit, no-match goes to `inherit`) |
| `chains: { deepseek/*: [...] }` | `roles.rules: [{ provider: deepseek, role: <declared id> }]` (requires a corresponding `roles.list` entry first; move the old chain entries into that `roles.list[].chain`; or delete the key) |
| `chains: { deepseek/deepseek-chat: [...] }` | `roles.rules: [{ provider: deepseek, model: deepseek-chat, role: <declared id> }]` (move the old chain entries into the corresponding `roles.list[].chain`) |
| `roles.rules[].role` any string | Reference `roles.list[].id` or the built-in `'inherit'` (enum); an undeclared reference → `legacyKeys` + warning, the entry does not take effect |
| `roles.default: 'default'` (or any string) | **Delete this field**; no rule match → the built-in `'inherit'` (→ `rootChain`). Rewrite "all subagents default to some chain" as one `{ role: <id> }` entry (rules are subagent-only; a legacy `origin` field is ignored) |
| Role chain without a fallback | `fallback: inherit-root` (default) → `[...role.chain, ...rootChain]`; `fallback: none` → `role.chain` only |
| (no old counterpart) `prompt` / `permissions` | schema **reserved**; no UI and no runtime consumption this round; writing them in YAML does not change this round's fallback behavior |
| `roles.list[].label` | **Delete this field** — the role id serves as the name |
| `roles.list[].description` | Rename to `roles.list[].persona` (personality hint); the old key stays inert (flagged via `legacyKeys` + warning) until removed |
| (no old counterpart) role id = `inherit` | **forbidden** in `roles.list`; `inherit` serves only as a rule target / no-match default |

## Three-channel legacy notice

After an upgrade, legacy-format configuration is flagged through **three channels** — nothing is silently dropped and **no file is rewritten automatically**:

1. **UI banner** (live this round): the Fallbacks card renders a migration banner at the top of its body (when the `get` / `set` / `reset` response carries a non-empty `legacyKeys`) — "Legacy config fields detected (...): now shown in the new model — rewrite them manually following the migration table in docs/configuration.md (the plugin will not rewrite them automatically)." It does not block editing or touch disk; **saving does not delete the old-format keys** (`set` is merge-semantics, so old `chains` / `roles.default` stay in the user layer) — clean them up by editing YAML manually (the card's Reset-to-defaults button was removed in PR #62 UX round 3; the gateway `reset` RPC stays as a host API for callers outside the card).
2. **Startup warn** (shipped): on plugin startup / config read, detected legacy fields are reported via `logger.warn` — `apply()` detects them through `detectLegacyKeys`, and the `legacyKeys` pipeline reports synchronously; the three channels are closed.
3. **This document's migration table**: the "Migration mapping table" section above is the reference for manual rewriting.

## Web plugin-config card usage

- **Entry**: web settings GUI → Settings → **Plugin Settings** page → **Fallbacks card** (rc.7 keyed slot: key `fallbacks`, the settings namespace the card edits, rendered after the bash / agent-loop / web-search / advisor cards in registration order; the card replaces the old standalone Settings navigation page).
- **Always available (skeleton always renders)**: in any state — first open, loading, error — the card renders its skeleton: card header (name/description), read-only status block, feature switch `enabled`, and the save actions. The config comes from the gateway channel `get` (`present` when it succeeds); when `get` fails / the channel is unreachable, an actionable skeleton is shown instead of a dead card, and saving stays available (failures are reported truthfully, see below).
- **Legacy banner**: a non-empty `legacyKeys` in the `get` response → a migration banner (zh/en) renders at the top of the card body, pointing at this document's migration table; it does not block editing or touch disk.
- **Feature switch `enabled` (default OFF)**: the switch is the user-config field `fallbacks.enabled`, off by default. When off, the configuration form body is hidden (`triggerCodes` / `timeSlots` / `rootChain` / `roles` / `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`) and the hint "Feature disabled: turn on the enabled switch to show the configuration interface." is shown — hiding does not discard anything; an in-progress draft is kept. Turning the switch on reveals the full configuration interface. Toggling shows/hides immediately (draft-driven) and persists via the save action.
- **Readable labels**: enumerable config items show readable labels instead of raw enum values — `RATE_LIMIT` → "Rate limit (429)", `QUOTA` → "Quota exceeded", `AUTH` → "Auth / permission failure"; `cooldown-expiry` → "Return to the primary model", `never` → "Keep the fallback model (until session end)"; `inherit-root` → "Inherit root (append rootChain after the role chain)", `none` → "Role chain only (no rootChain)". Numeric fields show the default value beside them; other fields show the currently effective value (the default when unset). The **Advanced options** group (`triggerCodes` / `revertPolicy` / `cooldownMs` / `maxSwitchesPerStep` / `alwaysModeRetryCap`) is collapsible and starts collapsed; its disclosure button expands/collapses it. In a **read-only** view (`!writable` — the environment is read-only) the group is **forced expanded** so the fields show without interaction; when the config channel is unreachable but the form stays writable, the group keeps the user's collapsed/expanded state and can still be toggled manually.
- **主代理 section (PR #62 feedback round)**: the section groups three blocks. **分时槽设置** — the extra-row list: "Add preset" (four frozen ids in a picker; an already-added preset is not offered again) / "Add custom time slot" buttons; per-row remove + move-up/down + **drag-reorder** (HTML5 drag on the row card); rows are **collapsible** to name + first model. A **preset row** shows its frozen name (梁文峰 / 梁文谷 / GLM峰 / GLM谷) + a read-only window summary and edits the model chain only (no start/end/days controls — windows are code constants; GLM rows carry a "仅配置了 zai-coding-cn 时有效" caveat); a **custom row** edits an optional display **name**, start/end (`HH:mm`) + optional weekday toggles (none checked = every day) + the model chain. The **timezone picker** lives inside this block and is **locked to Asia/Shanghai while any preset row exists** (preset windows are frozen UTC+8 constants; custom rows follow the selection). There is **no `timeSlots.enabled` master switch** (adding a row is the opt-in) and **no `rootMode` control** (picker selection is the mode). **默认降级链** — the all-day chain as a configurable provider/model selector list (add/remove; the preemption hints are removed). **默认模型** — the official V4 Flash | Pro **exclusive 2-choose-1 panel** (the chain's required head): a legacy/empty head reads back with no selection + a "pick one of the two official V4 models" notice; saving is blocked until one is picked. Trailing 默认降级链 entries compose `rootChain = [默认模型, ...默认降级链]`.
- **roles.list area (子代理)**: one entity card per role — **collapsible** to id + first chain model (or `inherit-root` when the chain is empty under the inherit-root strategy); expanded shows id (text, format-validated: `/^[a-z0-9-]{1,32}$/`, unique, the `inherit` reserved word is invalid), persona (personality hint, multiline text, **recommended**, on its own line below the id), chain selector rows (appendable), fallback dropdown (`inherit-root` / `none`), and a delete button; an "Add role" button. `prompt` / `permissions` are **not rendered this round**.
- **roles.rules area**: **no origin control** — rules are subagent-only (PR #62 feedback); per-row editing of provider (catalog dropdown/any) + model (cascade dropdown/any) + role (**dropdown**: `inherit` + declared role ids, linked within the page — role add/remove reflects immediately); an "Add rule" button. Empty fields do not participate in matching; a persisted legacy `origin` on the wire is ignored.
- **Pre-save validation (blocks save)**: id format/uniqueness/reserved word, rule role references, invalid selectors, empty role chain (no model config), **non-official all-day head (默认模型 must be exactly one official V4 model)**, and malformed time-slot rows (empty chain, non-`HH:mm` custom window, invalid kind/preset) → inline annotation (red border/hint) + error banner; **a failed validation blocks `save()`** — clicking save writes nothing and shows the error; only a passing validation writes the user layer via the gateway `set` (the gateway applies the same guards).
- **model-selection coordination (AC-2, documented degradation)**: with an active model-selection (the user picked a provider/model in the settings page or `settings.yaml`), a switch after a trigger-code failure is **still decided and recorded in the info log** (no durable `fallbacks/switch` event — issue #52 stop-write; cooldown unchanged; the step's actual routing may be overridden by the active selection, with the final provider/model following the re-applied selection) — this is **host-native behavior** after removing the local patch-marker coordination (T2 conclusion). request-error-triggered chains are unaffected; without an active selection the request routes to the chain target. This degradation is documented in [docs/verification.md](docs/verification.md) §4.7 (the card no longer carries the former one-line `status.selectionNote`, which was trimmed with the status block).
- **Reset to defaults (removed from the card, PR #62 UX round 3)**: the card no longer offers a Reset button. The gateway RPC `fallbacks/reset` (clears the user layer; the composed defaults take effect — `enabled` back to `false`) and the store `resetToDefaults()` remain as **host APIs** with their own store/gateway tests — only the card affordance was removed.
- **Per-section save (PR #62 UX round 3)**: each of the three big sections (主代理 / 子代理 / 高级选项) carries its own Save/Discard beside its heading, gated on that section's own dirty term. **主代理 Save** persists `rootChain` / `timeSlots` / `tz` (+ the card-level `enabled`); **子代理 Save** persists `roles`; **高级选项 Save** persists the advanced scalars (`triggerCodes` / `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap` / `roleAutoMatch`). Every other section's value in the write comes from the last accepted config, so one section's Save never rides along another section's unsaved edits — and validation gates only the section being saved (a bad role id never blocks 主代理 Save). After a save, only clean sections re-seed from the accepted config; unsaved sibling edits survive. Discard is per-section too (主代理 Discard never reverts 子代理 edits). While `enabled` is OFF, the compact row's Save/Discard operate on `enabled` only (hidden section drafts are never persisted).
- **Saving and error presentation**: saving writes the user layer via the gateway `set` (merge semantics) with no revision guard — on concurrent/write failure an error banner truthfully presents the save result, and the skeleton and draft are kept (no silent overwrite).
- **Read-only status block**: trimmed (compass AC-2) to the **recent-switch line only** — the most recent `fallbacks/switch` from the current session's raw event surface, newest first, rendered as `from → to (role · reason)` and read naturally for dispatch-time `role-inject` entries (`role → to (role-inject)`). The plugin writes no new durable events (issue #52 stop-write), so the line reflects only events already in the session history (e.g. legacy events marked ignorable by `scripts/repair-fallbacks-switch-logs.ts`); new switches are not visible here — not in-process and not after a restart (they are recorded in the info logs instead). The former "current effective model" line (D-6 — the derivation stays a tested store export, see `deriveEffectiveModel`) and the `selectionNote` degradation line were removed from the card (the selectionNote degradation is re-homed to [docs/verification.md](docs/verification.md) §4.7; the D-6 effective-model line removal is documented there at §4.3 step 4). Empty / loading / error states still render compactly. The line refreshes via push (no polling) on `settings/document-updated` (fallbacks namespace) / `llm/adapters-updated` (catalog only) / session switch / connection reset — with no durable events written, a switch occurring while the page is open never appears, with or without a page reload or host restart. The status block is read-only and not editable. The same in-session diagnostics are available via the `/fallbacks` command (see README; it shows the **role's own chain entries**, annotated `(inherit-root)` when `rootChain` is the fallback, without rendering `rootChain` entries one by one; `rootChain` entries render in full only when the role has no own chain — matching the runtime composition order). **Legacy note**: for users with only old-format `chains` configured (not migrated, no `rootChain`), the recent-switch surface stays empty (no switches are produced under the old shape) and the migration signal is the startup warn plus the card-top **migration banner** (see "Three-channel legacy notice"); the runtime **no longer reads** the old `chains` key (decisions work only on the new shape; old-only fields behave as a no-op pass-through).

## TUI readback (dsh-tui profile)

In a terminal (`dsh-tui`) profile the plugin's write surface is the **`/settings` screen**: with **dsh-tui ≥ v0.8.5** (commit `c51661f` or later on `main`; the `tuiSettingsSections` seam shipped in v0.8.0, the groups shape + validation in v0.8.5; reference dsh-TUI `main` `2747b87`) the plugin registers a **fallbacks** section with **full parity to the web Settings → 插件配置 → Fallbacks card** — booleans/numbers/selects use native field kinds, complex structures (`rootChain`, `timeSlots`, `roles.list`, `roles.rules`) are JSON text fields, `triggerCodes` is a comma-separated text field, and `tz` a plain text field. Complex-field parsing mirrors the gateway validation (invalid JSON / non-conforming chain / malformed time-slot row → draft invalid → save blocked; a blank draft stages a `clear` that re-inherits the composition layer). On an older dsh-tui the section is absent and file editing remains the only TUI surface. Configuration also lives in the same files as everywhere else and is read back through the command:

- **Where config lives**: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings; the profile patch layer `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (plugin-row `config:` overrides) for dsh-tui-specific values. The namespace itself is not TUI-specific — the composed config the TUI reads is the same composed config the runtime uses.
- **Readback**: `/fallbacks config` prints the composed `fallbacks` namespace — first line `Fallbacks 配置: 已启用` / `未启用` (the command renders in its default locale `zh`, like the rest of `/fallbacks`; the en dictionary mirrors the same line as `Fallbacks config: enabled` / `disabled`), then trigger codes, root chain, time slots (`N — {preset} (chain: n, window …)` / `custom {start}-{end} (chain: n)`, long lists truncated with `…`), timezone, roles (`N — id (chain: n)` per role, long lists truncated with `…`), role rules (`N — provider/model → role`, `*` for wildcard), cooldown, revert policy, max switches/step, always-mode cap, presets, role auto-match (`enabled`/`disabled`), and edit hints pointing at `/settings` (file editing still documented). Bare `/fallbacks` stays the session diagnostic (origin / role / chain / current time-slot winner — 分时 side — / recent **fallback switches** — 降级 side — / cooldown) — the two surfaces are distinct from their first line.
- **Action command**: `/fallbacks config revert-seed <role-id>` restores a seeded role's persona to its declared seed default (a web-card action the settings seam cannot express) and prints the outcome.
- **Menu + completion**: `/fallbacks`, `/fallbacks config` and the `config` → `revert-seed` leaf appear in the TUI `/` menu with subcommand completion when the profile carries the `tuiCommandTrees` service (the `dsh-tui-command-trees` bundle row; the shipped dsh-tui bundle has it).

Installation for the dsh-tui profile → [docs/install.md](install.md) §5.

## Behavior notes

### Trigger conditions

Chain decision is entered when `enabled` is true, a matching candidate chain exists, and the failure code ∈ `triggerCodes` (default `AUTH`/`QUOTA`/`RATE_LIMIT`):

- `AUTH` / `QUOTA` are non-retryable codes and reach this plugin directly without backoff;
- retryable codes such as `RATE_LIMIT` and 5xx are first retried with backoff by llm-retry and are delegated to this plugin only when its budget is exhausted;
- failures that do not hit `triggerCodes` (including non-triggerCode failures under always mode) always pass through, taking the llm-retry or original-error path.

### Continuing after a switch

A candidate hit → record a pending switch + push the current model into cooldown + bookkeeping (no durable `fallbacks/switch` event is written — issue #52 stop-write; the switch is recorded in the info log) → return a retry → the next request builds on the target model, and the current step/turn continues to completion without interrupting the task.

### Cooldown and returning to the primary

A switched-away / failed model is not re-selected within `cooldownMs` (cooldown and "already failed this step" double suppression); with `cooldown-expiry` the model can be re-selected after the cooldown expires (return to primary); `never` does not return within the session (infinite cooldown).

### Recovery mode (`recovery` key)

`recovery` selects how an expired cooldown brings the route back — `'timer'` (default) or `'half-open'`:

- **`'timer'` (default)** — today's behavior, byte-identical: when the cooldown expires the model is re-selected as the preferred candidate (return to primary, subject to `revertPolicy`).
- **`'half-open'`** — evidence-driven recovery: when the cooldown expires the route is **not** restored as the preferred candidate. It goes **half-open**: the next real user request routed to it is admitted as **one logged probe** per expiry episode (an info log line `llm-fallbacks: agent "…" half-open probe …`; the probe is a normal user request through the existing chain — no synthetic health checks, no background traffic). An **observed completion** on that route closes the circuit — the entry is cleared and the preference is fully restored (restoration is evidence-backed, not timer-backed). A **cancelled** (interrupted) completion is neutral: it neither closes nor fails the circuit, so the route stays half-open for the next probe. A probe failure re-suppresses the route with an **escalated** duration and the request falls over per the usual switch-away path, consuming the normal `maxSwitchesPerStep` budget. The probe marker is not a gate: concurrent requests admitted while the episode is unresolved all route normally — only the first logs the probe line.

**Escalation**: consecutive failures multiply the suppression duration by **2** per failure, capped at **1 hour** — `cooldownMs` → 2× → 4× → … → 1 h (the default `300000` escalates 5 m → 10 m → 20 m → 40 m → 1 h → 1 h …). The first failure of an episode is the flat `cooldownMs`; escalation changes the suppression **duration only**, never the per-step switch count (`maxSwitchesPerStep` is untouched).

**Interaction with `revertPolicy`**: `revertPolicy: 'never'` makes the half-open mechanism entirely inert — the infinite cooldown never expires, so no probe is admitted and nothing escalates.

**Session-scoped state**: half-open flags and escalation counters are in-memory and session-scoped (the same lifetime as the cooldown store) — a restart resets every route to a flat first cooldown.

**YAML-only discovery**: `recovery` is a YAML-only key — the settings card and the TUI `/settings` section render no control for it, and `/fallbacks config` prints no `recovery` line (default-mode output is byte-identical). Machine readback flows only through the gateway `get` passthrough. Set it in `$DSH_HOME/settings.yaml` (or the profile patch layer). While a route is half-open, `/fallbacks` shows a marker row `{key} half-open (awaiting recovery probe)` instead of a suppression time.

### Safety valve and always mode

- **Safety valve**: per step the failed-model set and switch count are recorded; beyond `maxSwitchesPerStep` no more decisions are made and the step ends with the original error semantics (the original error code and message are preserved verbatim); the counters reset when the step advances.
- **always-mode cap**: for providers with `retryPolicy.mode === 'always'`, persisted `llm/retry` events are counted per turn/step/provider at the request-building boundary; at ≥ `alwaysModeRetryCap` (0 disables) a switch is triggered (`reason: always-cap`). llm-retry's always mode delegates downstream before backing off; before the cap this plugin never preempts (see spec ADR-2).

### No-op invariant

With no `rootChain` configured and no role chain hit / `enabled: false` / no `triggerCodes` hit / role-resolution failure / chain exhausted / safety-valve cap exceeded: the plugin always passes through, the request and session event stream are identical to an uninstalled plugin, and no `fallbacks/switch` events are produced.

### Relationship with llm-retry

This plugin **does not modify** llm-retry's or providers' `retryPolicy`: fallback only intervenes after llm-retry delegates/exhausts its budget (guaranteed by bundle layer order, see [docs/install.md](docs/install.md)); `llm/retry` events are used only for always-mode cap counting. On plugin unload (HMR/dispose) the listeners unload with the fiber and all per-agent state is cleared entirely — no residual state.
