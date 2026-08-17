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
| `rootChain` | string[] | `[]` | **Block 1**. The root agent's ordered fallback chain; entries are `provider/model` or `provider/*` (see entry syntax below). Empty = root does not fall back (no-op pass-through) |
| `roles.list` | Array | `[]` | **Block 2**. Declarative role-entity collection (id/persona + optional chain/fallback; entry fields in the table below). The id must match `/^[a-z0-9-]{1,32}$/` and be unique within the collection; `'inherit'` is a reserved word and **must not** be used as an id |
| `roles.rules` | Array | `[]` | **Block 2**. Role rules: match to a role in order by `origin` (`root`/`subagent`), `provider`, `model` patterns (omitted fields are unconstrained; first match wins); `role` may only reference `roles.list[].id` or the built-in `'inherit'` |
| `cooldownMs` | number | `300000` | Cooldown duration (milliseconds). Switched-away / failed models are not re-selected during the cooldown period |
| `revertPolicy` | `'cooldown-expiry'` \| `'never'` | `'cooldown-expiry'` | Primary-return policy after cooldown expiry: return to the primary model on expiry / keep the fallback model for the session |
| `maxSwitchesPerStep` | number | `8` | Per-step safety valve: the switch-count cap per step; beyond it switching stops and the original error semantics are kept, preventing chain loops from amplifying latency |
| `alwaysModeRetryCap` | number | `5` | Always-mode retry cap: providers with `retryPolicy.mode === 'always'` switch after this many retries within the same request; `0` disables |
| `presets` | `'bundled'` \| `'none'` | `'bundled'` | Preset-role switch: `'bundled'` declares the 7 bundled preset roles as seeded `roles.list` rows on apply; `'none'` disables declaration (zero declarations, zero writes from this switch). Optional key — unset configs resolve to the default via the schema. See [Preset roles](#preset-roles-presets-key) |
| `roleAutoMatch` | boolean | `true` | Dispatch-time LLM role auto-match switch: when `true` (default), a subagent-origin request whose role is not resolved by an explicit `agentPreset` or a rule may have the best-fit declared role picked by the LLM (three-stage resolution — see [Dispatch-time role resolution and injection](#dispatch-time-role-resolution-and-injection-roleautomatch)); `false` disables ONLY the LLM auto-match stage — with no explicit role it reproduces the previous rules-only behavior (the explicit `agentPreset` stage is independent new behavior, not gated by the toggle). Optional key — unset configs resolve to the default via the schema |

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
| `origin` | `'root'` \| `'subagent'` | Origin constraint; omitted = unconstrained |
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

**Chain entries** (the values of `rootChain` / `roles.list[].chain`, ordered):

- `provider/model` — exact switch: switch to the specified model;
- `provider/*` — keep the failed model id and switch the provider only; when the target provider lacks this model id the candidate is skipped (fuzzy near-match resolution is out of scope for this iteration).

> **The chain-key namespace is removed**: the three key semantics of the old `chains` key (`provider/model` exact, `provider/*` wildcard, role-name keys) no longer exist — model-specific routing on failure is now approximated by `roles.rules` (matching to a role by provider/model pattern), and role membership is expressed by declared entities. The entry-side `provider/*` wildcard stays a valid YAML entry everywhere (role chains and `rootChain`); the settings GUI no longer offers a wildcard checkbox in any chain editor (rootChain and role chains alike) — chains are edited as provider/model lines, a hand-written `provider/*` entry reads back with a conversion hint and becomes an exact entry once a model is picked, and provider-any matching is expressed through the `any` option in `roles.rules` instead. In the GUI, changing the provider of a legacy `provider/*` entry keeps its wildcard semantics — the entry stays a wildcard until a concrete model is chosen, which is what converts it to an exact entry.

Whitespace padding: whitespace padding in a selector (e.g. `other/ gpt-4o`) is **preserved as-is** on save (the GUI does not rewrite user input); runtime parsing normalizes it (`parseSelector` tolerates whitespace), so the semantics are identical to the unpadded form.

Invalid/unknown entries (missing separator, empty segment, extra separator, etc.) warn at save validation and **block the save** (card) or warn at startup (validation function); they never crash and never take effect. In a running dsh environment (with a model-catalog service) `*/*` never matches — the target provider has no `*` model catalog, so the existence probe skips that candidate.

## Role resolution and chain composition

**Role resolution** (uniform for all agents, root and subagent alike; ordered matching, first match wins):

1. `roles.rules` matches by `origin` / `provider` / `model` pattern (omitted fields are unconstrained) → the target role of the matched rule;
2. no rule matches → the built-in `'inherit'` role (no own chain → `rootChain`).

`inherit` is a **reserved role id**: it serves only as a rule target / no-match default and **must not** be written to `roles.list[].id`. A matched rule whose target role is not declared in `roles.list` → defensive fallback to `'inherit'` with a warning.

**Chain composition** (append-not-replace): the actual candidate chain for a matched role is

```text
[...role.chain, ...(role.fallback === 'none' ? [] : rootChain)]
```

- `fallback: inherit-root` (default): the role's own chain first, `rootChain` as the trailing fallback;
- `fallback: none`: the role's own chain only; an empty own chain with `none` → no-op pass-through;
- no rule matched (`inherit`) or role undeclared: candidate chain = `rootChain`.

Candidate filtering (skipped on hit): same as the current model, in cooldown, already failed this step, or the `provider/*` entry's target provider lacks this model id.

> **Roles require model config**: a declared role without model config is meaningless — either give the role at least one `chain` entry or have rules reference the built-in `inherit` directly. The settings card enforces this on save (an empty chain blocks the save + inline hint); a hand-written YAML with a missing/empty chain triggers a `logger.warn` at startup (no crash); at runtime a missing chain still falls back to `rootChain` defensively (the existing "no chain → rootChain" behavior is unchanged).

> **Runtime landing note**: the new role-resolution / chain-composition semantics above are consumed by the runtime (`src/roles.ts` / `src/chains.ts` / `src/index.ts`, fallbacks-role-runtime Plan 2); old-shape fields (`chains` / `roles.default` / undeclared role references) are flagged for migration at startup via `detectLegacyKeys` (see the migration mapping table below), and decision behavior follows the new model.

## Dispatch-time role resolution and injection (`roleAutoMatch`)

**Dispatch-time resolution** runs at a **subagent-origin** agent's **first request** only (a per-agent once-marker; a later request never re-evaluates). The role is resolved in **three ordered stages** (first hit wins):

1. **Explicit** — the subagent's `agentPreset` session-header value, trimmed, matches a declared role id → that role. The reserved `'inherit'` and any undeclared preset are **never** dispatchable explicit roles and fall through to rules.
2. **Rules** — the same deterministic `roles.rules` matching as failure-time (a declared role wins; no rule match → the built-in `'inherit'`).
3. **LLM auto-match** — only when stage 2 resolved to `'inherit'` **and** `roleAutoMatch: true` (the default): the model picks the best-fit declared role from the taxonomy (id + persona). The call is **bounded** — one completion per decision, a small `maxTokens`, a 5s timeout that abandons the stream; `none`, an unknown/garbage id, a timeout, any throw, an empty taxonomy, or an absent `llm` service all resolve to `'inherit'` and never block the request.

When a **specific** role resolves (anything but `'inherit'`), its **chain head** — the first exact (non-wildcard) candidate of the role's concatenated chain — is **injected** into the agent's first request when it differs from the request's current model: the request is overridden to the head (`overrideConfig`), a `fallbacks/switch` event is appended with `reason: 'role-inject'` (from = current model, to = injected model, role = resolved role), and an explicit `role → model` log line is written. Injection is **idempotent** (first request only) and **not a failure decision** — it writes no pending switch, no cooldown, and no failure bookkeeping (no `commit()`).

Key semantics:

- **`roleAutoMatch: false`** disables stage 3 (the LLM auto-match) only — the explicit (`agentPreset`) and rules stages still resolve and inject under `false`. "Reproduces the previous rules-only behavior" applies precisely when there is **no explicit role** and no rule match; the explicit stage is independent new behavior, not gated by the toggle. The key is **toggleable in the settings card**: the Fallbacks card always renders an "Enable role auto-match" switch (default `true`, read/write via the same draft → `set` save path). The schema default applies whenever the key is unset — a legacy config that never declared the key still shows the toggle on, and its first save pins `roleAutoMatch: true` (semantically identical to the default).
- **Judgment-call route**: the auto-match LLM call routes via the roles' declared chain selectors first (the first exact `provider/model` across the declared chains in declaration order), then the agent's own provider/model, else it is skipped (`inherit`). A session whose active provider is outside the declared taxonomy therefore never auto-matches — it fails safe to `'inherit'`, it never errors.
- **First-request failure is permanent (anti-hotloop)**: the dispatch-injection once-marker is set **before** the resolution try, so a transient first-request failure (e.g. an auto-match timeout) permanently forgoes dispatch injection for that agent — the deliberate anti-hotloop choice; the agent keeps its `'inherit'` (no specific role) routing for its lifetime.
- **Role id `none` edge**: a declared role id `none` collides with the auto-match `none` decline token — such a role can be selected via the explicit/rules stages but can never be picked by auto-match.
- **`'inherit'` never injects**: the "no specific role" outcome always leaves the request's model untouched.
- **Root agents are untouched**: the dispatch-time path applies to `session.header.origin === 'subagent'` only; a root agent's model follows the normal selection/fallback path.
- **`role-inject` is an additive event reason**: the `fallbacks/switch` payload stays a superset of the failure-time shape; renderers show a localized `role-inject` label and an explicit `role → model` line (conversation badge card / recent-switch lines), with any unknown reason still rendered raw.
- **Documented degradation (honesty)**: dispatch injection reuses the same `agent/request` override path as the failure-time fallback, so whether it survives a **manual web model selection** depends on waterfall listener order — the same documented degradation as the failure-time switch (see the model-selection coordination note in the card-usage section and [docs/verification.md](docs/verification.md) §4.3).

## Example YAML

The following configuration demonstrates the full two-block shape — a root chain, role entities (including their `fallback` policy), and rules referencing declared roles / the built-in `inherit` (write it into `$DSH_HOME/settings.yaml`):

```yaml
fallbacks:
  enabled: true
  triggerCodes:
    - AUTH
    - QUOTA
    - RATE_LIMIT
  rootChain:                     # Block 1: the root agent's fallback chain; empty = root does not fall back
    - anthropic/claude-3-5-sonnet
    - openai/*
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
    rules:                       # Match origin/provider/model in order, first hit wins; specific rules before broad ones
      - provider: deepseek       # Most specific first: exact provider/model → explicitly targets the built-in inherit (root chain)
        model: deepseek-reasoner
        role: inherit
      - origin: subagent         # All subagents → reviewer role
        role: reviewer
      - provider: deepseek       # Broad rules last: other deepseek providers' agents → cheap role
        role: cheap
  cooldownMs: 300000
  revertPolicy: cooldown-expiry
  maxSwitchesPerStep: 8
  alwaysModeRetryCap: 5
```

Key points:

- The example sets `enabled: true` explicitly — the feature switch defaults to `false`; without an explicit opt-in the plugin never intervenes and the card hides the configuration form body.
- The first chain entry is the first fallback target after the primary model; entries in the chain are ordered by priority.
- Declaring a role without any rule = that role is **never hit** (a no-match goes to `inherit` → `rootChain`); to have a role hit you must also write a `roles.rules` entry referencing it.
- `role: inherit` is a valid rule target: it explicitly points a class of requests at the built-in inherit (the root chain).
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
| `roles.default: 'default'` (or any string) | **Delete this field**; no rule match → the built-in `'inherit'` (→ `rootChain`). Rewrite "all subagents default to some chain" as one `{ origin: subagent, role: <id> }` entry |
| Role chain without a fallback | `fallback: inherit-root` (default) → `[...role.chain, ...rootChain]`; `fallback: none` → `role.chain` only |
| (no old counterpart) `prompt` / `permissions` | schema **reserved**; no UI and no runtime consumption this round; writing them in YAML does not change this round's fallback behavior |
| `roles.list[].label` | **Delete this field** — the role id serves as the name |
| `roles.list[].description` | Rename to `roles.list[].persona` (personality hint); the old key stays inert (flagged via `legacyKeys` + warning) until removed |
| (no old counterpart) role id = `inherit` | **forbidden** in `roles.list`; `inherit` serves only as a rule target / no-match default |

## Three-channel legacy notice

After an upgrade, legacy-format configuration is flagged through **three channels** — nothing is silently dropped and **no file is rewritten automatically**:

1. **UI banner** (live this round): the Fallbacks card renders a migration banner at the top of its body (when the `get` / `set` / `reset` response carries a non-empty `legacyKeys`) — "Legacy config fields detected (...): now shown in the new model — rewrite them manually following the migration table in docs/configuration.md (the plugin will not rewrite them automatically)." It does not block editing or touch disk; **saving does not delete the old-format keys** (`set` is merge-semantics, so old `chains` / `roles.default` stay in the user layer) — clean them up by editing YAML manually or by resetting the namespace with "Reset to defaults".
2. **Startup warn** (shipped): on plugin startup / config read, detected legacy fields are reported via `logger.warn` — `apply()` detects them through `detectLegacyKeys`, and the `legacyKeys` pipeline reports synchronously; the three channels are closed.
3. **This document's migration table**: the "Migration mapping table" section above is the reference for manual rewriting.

## Web plugin-config card usage

- **Entry**: web settings GUI → Settings → **Plugin Settings** page → **Fallbacks card** (same list as the bash / agent-loop / web-search / advisor cards, order 30; the card replaces the old standalone Settings navigation page).
- **Always available (skeleton always renders)**: in any state — first open, loading, error — the card renders its skeleton: card header (name/description), read-only status block, feature switch `enabled`, and the save / reset-to-defaults actions. The config comes from the gateway channel `get` (`present` when it succeeds); when `get` fails / the channel is unreachable, an actionable skeleton is shown instead of a dead card, and saving stays available (failures are reported truthfully, see below).
- **Legacy banner**: a non-empty `legacyKeys` in the `get` response → a migration banner (zh/en) renders at the top of the card body, pointing at this document's migration table; it does not block editing or touch disk.
- **Feature switch `enabled` (default OFF)**: the switch is the user-config field `fallbacks.enabled`, off by default. When off, the configuration form body is hidden (`triggerCodes` / `rootChain` / `roles` / `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`) and the hint "Feature disabled: turn on the enabled switch to show the configuration interface." is shown — hiding does not discard anything; an in-progress draft is kept. Turning the switch on reveals the full configuration interface. Toggling shows/hides immediately (draft-driven) and persists via the save action.
- **Readable labels**: enumerable config items show readable labels instead of raw enum values — `RATE_LIMIT` → "Rate limit (429)", `QUOTA` → "Quota exceeded", `AUTH` → "Auth / permission failure"; `cooldown-expiry` → "Return to the primary model", `never` → "Keep the fallback model (until session end)"; `inherit-root` → "Inherit root (append rootChain after the role chain)", `none` → "Role chain only (no rootChain)". Numeric fields show the default value beside them; other fields show the currently effective value (the default when unset). The **Advanced options** group (`triggerCodes` / `revertPolicy` / `cooldownMs` / `maxSwitchesPerStep` / `alwaysModeRetryCap`) is collapsible and starts collapsed; its disclosure button expands/collapses it. In a **read-only** view (`!writable` — the environment is read-only) the group is **forced expanded** so the fields show without interaction; when the config channel is unreachable but the form stays writable, the group keeps the user's collapsed/expanded state and can still be toggled manually.
- **rootChain area**: title "Root agent fallback chain" + a first line that makes the engagement semantics explicit — "Engages only after the current session's selected model fails — it never preempts the session model" — plus a prefer-session-model hint ("Prefer the current session's model; degrade down this chain only after it fails") that is rendered **only when fallbacks is enabled and a root chain is configured** (hidden when off or unset). Selector rows reuse the catalog dropdown (provider/model cascade, **no wildcard checkbox** — no chain editor in the card offers one; chains stay provider/model lines, and provider-any matching lives in the role rules) + synthetic options for values outside the catalog, **no key input**.
- **roles.list area**: one entity card per role — id (text, format-validated: `/^[a-z0-9-]{1,32}$/`, unique, the `inherit` reserved word is invalid), persona (personality hint, multiline text, **recommended**, on its own line below the id), chain selector rows (collapsible / appendable), fallback dropdown (`inherit-root` / `none`), and a delete button; an "Add role" button. `prompt` / `permissions` are **not rendered this round**.
- **roles.rules area**: per-row editing of origin (root/subagent/any) + provider (catalog dropdown/any) + model (cascade dropdown/any) + role (**dropdown**: `inherit` + declared role ids, linked within the page — role add/remove reflects immediately); an "Add rule" button. Empty fields do not participate in matching.
- **Pre-save validation (blocks save)**: id format/uniqueness/reserved word, rule role references, invalid selectors, empty role chain (no model config) → inline annotation (red border/hint) + error banner; **a failed validation blocks `save()`** — clicking save writes nothing and shows the error; only a passing validation writes the user layer via the gateway `set`.
- **model-selection coordination (AC-2, documented degradation)**: with an active model-selection (the user picked a provider/model in the settings page or `settings.yaml`), a switch after a trigger-code failure is **still decided and recorded** (`fallbacks/switch` event, cooldown; the step's actual routing may be overridden by the active selection, with the final provider/model following the re-applied selection) — this is **host-native behavior** after removing the local patch-marker coordination (T2 conclusion). request-error-triggered chains are unaffected; without an active selection the request routes to the chain target. This degradation is documented in [docs/verification.md](docs/verification.md) §4.7 (the card no longer carries the former one-line `status.selectionNote`, which was trimmed with the status block).
- **Reset to defaults**: one click resets this namespace's user configuration to the composed defaults (`enabled` back to `false`) — via the gateway `reset` (clears the user layer; the composed defaults take effect).
- **Saving and error presentation**: saving writes the user layer via the gateway `set` (merge semantics) with no revision guard — on concurrent/write failure an error banner truthfully presents the save result, and the skeleton and draft are kept (no silent overwrite).
- **Read-only status block**: trimmed (compass AC-2) to the **recent-switch line only** — the most recent `fallbacks/switch` from the current session's raw event surface, newest first, rendered as `from → to (role · reason)` and read naturally for dispatch-time `role-inject` entries (`role → to (role-inject)`). The former "current effective model" line (D-6 — the derivation stays a tested store export, see `deriveEffectiveModel`) and the `selectionNote` degradation line were removed from the card (the selectionNote degradation is re-homed to [docs/verification.md](docs/verification.md) §4.7; the D-6 effective-model line removal is documented there at §4.3 step 4). Empty / loading / error states still render compactly. The line refreshes via push (no polling) on `settings/document-updated` (fallbacks namespace) / `llm/adapters-updated` (catalog only) / session switch / connection reset — a switch that happens while the page is open appears after the next push or a page reload. The status block is read-only and not editable. The same in-session diagnostics are available via the `/fallbacks` command (see README; it shows the **role's own chain entries**, annotated `(inherit-root)` when `rootChain` is the fallback, without rendering `rootChain` entries one by one; `rootChain` entries render in full only when the role has no own chain — matching the runtime composition order). **Legacy note**: for users with only old-format `chains` configured (not migrated, no `rootChain`), the recent-switch surface stays empty (no switches are produced under the old shape) and the migration signal is the startup warn plus the card-top **migration banner** (see "Three-channel legacy notice"); the runtime **no longer reads** the old `chains` key (decisions work only on the new shape; old-only fields behave as a no-op pass-through).

## TUI readback (dsh-tui profile)

In a terminal (`dsh-tui`) profile the plugin has **no settings page and no write surface** — the web Settings → 插件配置 → Fallbacks card (and its migration banner) is web-only, and there is no `set` / form / mutate command. Configuration lives in the same files as everywhere else and is read back through the command:

- **Where config lives**: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings; the profile patch layer `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (plugin-row `config:` overrides) for dsh-tui-specific values. The namespace itself is not TUI-specific — the composed config the TUI reads is the same composed config the runtime uses.
- **Readback**: `/fallbacks config` prints the composed `fallbacks` namespace — first line `Fallbacks 配置: 已启用` / `未启用` (the command renders in its default locale `zh`, like the rest of `/fallbacks`; the en dictionary mirrors the same line as `Fallbacks config: enabled` / `disabled`), then trigger codes, root chain, roles (`N — id (chain: n)` per role, long lists truncated with `…`), cooldown, revert policy, max switches/step, always-mode cap, presets, role auto-match (`enabled`/`disabled`), and the file-only edit hints. Bare `/fallbacks` stays the session diagnostic (origin / role / chain / recent switches / cooldown) — the two surfaces are distinct from their first line.
- **Menu + completion**: `/fallbacks` and `/fallbacks config` appear in the TUI `/` menu with `config` subcommand completion when the profile carries the `tuiCommandTrees` service (the `dsh-tui-command-trees` bundle row; the shipped dsh-tui bundle has it).

Installation for the dsh-tui profile → [docs/install.md](install.md) §5.

## Behavior notes

### Trigger conditions

Chain decision is entered when `enabled` is true, a matching candidate chain exists, and the failure code ∈ `triggerCodes` (default `AUTH`/`QUOTA`/`RATE_LIMIT`):

- `AUTH` / `QUOTA` are non-retryable codes and reach this plugin directly without backoff;
- retryable codes such as `RATE_LIMIT` and 5xx are first retried with backoff by llm-retry and are delegated to this plugin only when its budget is exhausted;
- failures that do not hit `triggerCodes` (including non-triggerCode failures under always mode) always pass through, taking the llm-retry or original-error path.

### Continuing after a switch

A candidate hit → record a pending switch + push the current model into cooldown + bookkeeping + append the `fallbacks/switch` event → return a retry → the next request builds on the target model, and the current step/turn continues to completion without interrupting the task.

### Cooldown and returning to the primary

A switched-away / failed model is not re-selected within `cooldownMs` (cooldown and "already failed this step" double suppression); with `cooldown-expiry` the model can be re-selected after the cooldown expires (return to primary); `never` does not return within the session (infinite cooldown).

### Safety valve and always mode

- **Safety valve**: per step the failed-model set and switch count are recorded; beyond `maxSwitchesPerStep` no more decisions are made and the step ends with the original error semantics (the original error code and message are preserved verbatim); the counters reset when the step advances.
- **always-mode cap**: for providers with `retryPolicy.mode === 'always'`, persisted `llm/retry` events are counted per turn/step/provider at the request-building boundary; at ≥ `alwaysModeRetryCap` (0 disables) a switch is triggered (`reason: always-cap`). llm-retry's always mode delegates downstream before backing off; before the cap this plugin never preempts (see spec ADR-2).

### No-op invariant

With no `rootChain` configured and no role chain hit / `enabled: false` / no `triggerCodes` hit / role-resolution failure / chain exhausted / safety-valve cap exceeded: the plugin always passes through, the request and session event stream are identical to an uninstalled plugin, and no `fallbacks/switch` events are produced.

### Relationship with llm-retry

This plugin **does not modify** llm-retry's or providers' `retryPolicy`: fallback only intervenes after llm-retry delegates/exhausts its budget (guaranteed by bundle layer order, see [docs/install.md](docs/install.md)); `llm/retry` events are used only for always-mode cap counting. On plugin unload (HMR/dispose) the listeners unload with the fiber and all per-agent state is cleared entirely — no residual state.
