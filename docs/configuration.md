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
| `triggerCodes` | string[] | `['AUTH', 'QUOTA', 'RATE_LIMIT']` | Failures with these codes enter chain decision. Retryable failures (5xx / `RATE_LIMIT` etc.) are first retried with backoff by llm-retry and enter the decision the same way once its budget is exhausted — **no extra `triggerCodes` entries are needed for 5xx** |
| `rootChain` | string[] | `[]` | **主代理 — the all-day chain**. Must END with exactly one official model (`deepseek-official/deepseek-flash` **or** `deepseek-official/deepseek-v4-pro` — the card's 默认模型 panel); leading entries (the card's 默认降级链 block) are walked first, then the tail is the last-resort fallback. An empty chain or a chain whose last entry is not an official model (including the retired `deepseek-v4-flash` and the never-served legacy `deepseek-official/deepseek-pro` ids) warns at startup and makes a **root** walk refuse to start (`UNDISPATCHABLE_EFFECTIVE_HEAD` / `EMPTY_EFFECTIVE_CHAIN`), but cannot be saved as-is through the card/gateway. A subagent walks its role chain, so the all-day shape never gates a child. Used whenever no `timeSlots` row matches |
| `roles.list` | Array | `[]` | **Block 2**. Declarative role-entity collection (id/persona + optional chain/fallback; entry fields in the table below). The id must match `/^[a-z0-9-]{1,32}$/` and be unique within the collection; `'inherit'` is a reserved word and **must not** be used as an id |
| `roles.rules` | Array | `[]` | **子代理 — role rules (SUBAGENT-ONLY)**: match to a role in order by `provider`, `model` patterns (omitted fields are unconstrained; first match wins; root requests NEVER match rules and resolve to `inherit`); `role` may only reference `roles.list[].id` or the built-in `'inherit'`. The legacy per-rule `origin` field is accepted for config compatibility and IGNORED at match time |
| `cooldownMs` | number | `300000` | Cooldown duration (milliseconds). Switched-away / failed models are not re-selected during the cooldown period |
| `revertPolicy` | `'cooldown-expiry'` \| `'never'` | `'cooldown-expiry'` | Primary-return policy after cooldown expiry: return to the primary model on expiry / keep the fallback model for the session |
| `recovery` | `'timer'` \| `'half-open'` | `'timer'` | Cooldown-expiry recovery mode: `'timer'` restores the preferred candidate when the cooldown expires (today's behavior, byte-identical); `'half-open'` leaves the route half-open for one logged probe line instead (see [Recovery mode](#recovery-mode-recovery-key)). Optional key — unset configs resolve to the default via the schema; YAML-only (no card / TUI control) |
| `maxSwitchesPerStep` | number | `8` | Per-request-walk safety valve: the switch-count cap for one walk (attempts ≤ cap + 1); beyond it the walk stops advancing and re-emits the last attempt's terminal error verbatim, preventing chain loops from amplifying latency |
| `presets` | `'bundled'` \| `'none'` | `'bundled'` | Preset-role switch: `'bundled'` declares the 5 bundled preset roles as seeded `roles.list` rows on apply; `'none'` disables declaration (zero declarations, zero writes from this switch). Optional key — unset configs resolve to the default via the schema. See [Preset roles](#preset-roles-presets-key) |
| `timeSlots` | Array | `[]` | Extra time-slot rows (see [Time slots (分时切换)](#time-slots-分时切换)): the FIRST row whose window contains the current moment wins and its chain **replaces** the all-day chain; no match → `rootChain`. Rows are `{ kind: 'preset' \| 'custom', preset?, start?, end?, days?, chain }` — preset windows are frozen code constants, custom windows may wrap midnight. There is NO `timeSlots.enabled` master switch — adding rows IS the opt-in. The gateway rejects malformed rows on save (unknown preset ids, duplicate presets, preset rows carrying windows, non-`HH:mm` custom bounds, out-of-range days, empty chains) |
| `tz` | string | `'Asia/Shanghai'` | Config-level timezone for slot matching (standard `Intl` timezone rules, DST-safe). Not per-slot; no settings-card picker this iteration (YAML only) |

> The defaults are defined by `defaultFallbacksConfig` in `src/config.ts`; the card shows the default value next to numeric fields (`cooldownMs` / `maxSwitchesPerStep`) and the currently effective value for all other fields (which equals the default when unset).

> **Removed keys (0.2.2-rc.1)**: `alwaysModeRetryCap` and `roleAutoMatch` no longer exist (the always-mode cap is structurally unnecessary — every llm-retry re-entry resumes past a cooled head — and the LLM auto-match stage is gone with the request-override path). Both are reported by `detectLegacyKeys`, so a stored section that still carries them shows the migration banner and the startup warn; they are never read, and no successor key exists. Delete them by hand.

> **No feature switch (breaking change)**: there is NO config-level `enabled` key. The plugin registers and intervenes exactly when content is configured — a non-empty `rootChain`, at least one `timeSlots` row, or one declared role — and even then only sessions whose model selection routes to `FallbacksChain / Auto` have a chain; an empty configuration is a pass-through exactly like an uninstalled plugin (no-op invariant). The **Plugins-page row toggle is the master switch** (disabling the plugin row stops the plugin entirely). A stored profile still carrying the removed `enabled: true/false` line loads cleanly — the key is tolerated, never read, and silently stripped from snapshots and saves (it is never re-persisted; there is no successor key and no migration entry) — but it no longer gates anything. If you relied on `enabled: false` to keep the plugin inert, empty the section instead.

### `roles.list` entry fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Role id: `/^[a-z0-9-]{1,32}$/`, unique within the collection; `'inherit'` is reserved and forbidden |
| `persona` | string | Recommended | Personality hint (free text, not validated); schema default is the empty string, absence does not block saving |
| `chain` | string[] | No (enforced by the settings card on save) | The role's own ordered fallback chain (entry syntax same as `rootChain`). **Required semantics**: a role without model config is meaningless — the settings card enforces at least one entry on save (an empty chain blocks the save + inline hint); a hand-written YAML with a missing/empty chain warns at startup (no crash); at runtime a missing chain still falls back to `rootChain` defensively |
| `fallback` | `'inherit-root'` \| `'none'` | No (default `'inherit-root'`) | Chain-append policy: `inherit-root` = append `rootChain` after the role chain; `none` = the role's own chain only |
| `prompt` / `permissions` | string / object | No | **Reserved fields** (see next section) |

**Seeded rows**: a companion plugin may also auto-provision role rows through the service seeding API — a seeded role is a plain `roles.list` row (`{ id, persona }`, two keys only): seeds never write `chain` / `fallback` (a new seeded role keeps an empty chain until you fill it), its persona can be reverted to the currently declared seed default via the service or the TUI `/fallbacks config revert-seed <role-id>` command (the web settings card offers no revert), and the card shows a source badge (`bundled` / the declaring set's name, `external` when unnamed / `User`). The card presents a seeded row as reference material, not editable config: no id field (the collapse title carries the immutable id, R2) and the persona renders as a read-only single-line brief with an expandable full view (no persona editor, no revert button), while chain and fallback stay editable. See [docs/consumer-api.md](consumer-api.md) → Role seeds. The plugin itself also auto-provisions 5 bundled preset roles on apply by default (see [Preset roles](#preset-roles-presets-key)) — same seed semantics, same source badge.

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
- **Persona injection has since shipped — but from `persona`, not from these two fields**: a declared role's `persona` is installed on the child as a scoped system-prompt section at the `deployment:persona-prefix` slot, independent of routing, so a role with an empty `chain` gets its persona exactly like a chained one (see [docs/features.md](features.md#role-persona-on-the-child)). Being a section on the child's own context, it does not survive a host restart: a role child resumed afterwards runs without its role persona. `prompt` and `permissions` themselves still have no runtime consumer, so the tool filtering they were reserved for (`permissions.allow` / `deny`) remains the planned `fallbacks-explicit-role-tool` (roadmap item — no plan file yet).

## Preset roles (`presets` key)

The plugin ships **5 bundled omp-style preset roles** — generic subagent roles available out of the box: `reviewer` / `scout` / `security-reviewer` / `sonic` / `task`. Each persona is a concise instruction set distilled from the omp bundled agent prompts (`packages/coding-agent/src/prompts/agents/`, snapshot 2026-08-16) — a distillation, not a verbatim copy of a full prompt. The bundled set previously also carried `designer` and `librarian`; those two were removed (see the upgrade note below).

| `presets` value | Effect |
|---|---|
| `'bundled'` (default) | On `apply`, the plugin automatically declares the 5 preset roles through the role-seeds surface: they materialize as plain `roles.list` rows (`{ id, persona }`, two keys only) |
| `'none'` | No declarations, no writes — this apply round makes **zero** settings writes on account of this switch |

- **Idempotent**: re-declaring the same preset payload is a no-op — repeated `apply` / HMR / fiber swaps never duplicate rows and never drop an override.
- **Not gated by anything**: the self-declaration fires on apply unconditionally (it was never gated by the removed `enabled` switch, and that switch no longer exists) — even a content-less install materializes the 5 preset rows. The only zero-declaration path is `presets: 'none'`.
- **Upgrade behavior**: with the default configuration, the first `apply` after upgrading materializes the 5 rows into `roles.list`; each row shows a **source badge** in the settings card (existing capability — no extra configuration). Setting `presets: 'none'` stops further declarations but does **not** retract already-materialized rows — delete them by hand if you want them gone. **Honest limitation**: a hand-deleted row is re-materialized by the next `apply` (the plugin cannot distinguish "operator deleted" from "never existed").
- **Trim upgrade note (honest copy)**: versions before the trim also declared `designer` and `librarian`. After upgrading, rows saved by those earlier versions keep their persona and survive bundled declares untouched, but they are no longer in the bundled producer's slice — the plugin no longer has a live declaration for them. They now show source `user` (the `User` badge, no seeded-row treatment) only when no live producer still declares the id, **even though the operator never wrote those rows**. Only then are they ordinary editable config rows again (the label means "no live declaration", not "operator-written"); a companion's live declaration keeps them seeded and read-only with the winning producer's source label (`external` when unnamed, otherwise its registered set name), including when the mstar merge-preserve pattern copies currently seeded non-own ids verbatim. Delete them by hand if unwanted.
- **Per-row source**: every row carries a provenance label, read-time derived and never persisted — preset rows read back with source `bundled`; a row no live declaration covers reads `user`. The contract → [docs/consumer-api.md](consumer-api.md) → Per-row source.
- **Same-name operator rows are never overwritten**: a row the operator already defined keeps its persona — the declaration is flagged with a loud `logger.warn` (`'persona-source'` conflict, seed semantics unchanged) and the row still derives `seeded=true`, so the source badge is available. The preset persona is only ever applied to a brand-new row.
- The `presets` key is an **optional, YAML-only** switch — the settings card does not render a control for it this round. Unset configs resolve to the default through the schema; an invalid value (anything other than `'bundled'` / `'none'`) fails at config resolve, like `revertPolicy`.

## Entry syntax

**Chain entries** (the values of `roles.list[].chain` / `timeSlots[].chain`, ordered; the all-day `rootChain` is an ordered chain whose LAST entry must be exactly one official model — leading entries are optional walk targets before that last-resort tail):

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

> **Root tail is slot-effective (分时切换)**: for ROOT-origin agents the trailing `rootChain` in the composition above is replaced by the **effective chain** at request time — `resolveEffectiveChain(config, now, tz)`: the first matching `timeSlots` row's chain, else the all-day `rootChain` (see [Time slots](#time-slots-分时切换)). Subagent walks keep the raw `rootChain` (the role chain is not slot-rotated).

Candidate filtering (skipped on hit): the same-as-current route, in cooldown, already failed in this walk, or the `provider/*` entry's target provider lacks this model id.

> **Roles require model config**: a declared role without model config is meaningless — either give the role at least one `chain` entry or have rules reference the built-in `inherit` directly. The settings card enforces this on save (an empty chain blocks the save + inline hint); a hand-written YAML with a missing/empty chain triggers a `logger.warn` at startup (no crash); at runtime a missing chain still falls back to `rootChain` defensively (the existing "no chain → rootChain" behavior is unchanged).

> **Runtime landing note**: the new role-resolution / chain-composition semantics above are consumed by the runtime (`src/roles.ts` / `src/chains.ts` / `src/index.ts`, fallbacks-role-runtime Plan 2); old-shape fields (`chains` / `roles.default` / undeclared role references) are flagged for migration at startup via `detectLegacyKeys` (see the migration mapping table below), and decision behavior follows the new model.

## Subagent role resolution and chain mounting

**Role resolution** runs inside every chain walk — that is, for a session whose model selection routes to `FallbacksChain / Auto` — in **three ordered stages** (first hit wins):

1. **Explicit** — the agent's `agentPreset` session-header value, trimmed, matches a declared role id → that role. The reserved `'inherit'` and any undeclared preset are **never** dispatchable explicit roles and fall through.
2. **Dispatch-declared role** — the role the dispatch seam resolved from the child request's prompt header `**Execute as**: <id>` (a normally delegated Assignment, or an Agent Team teammate's initial prompt — see [Agent Team members](#agent-team-members)), trimmed and looked up in the live declared-role `roleIds` map. Validated against the **live** declaration set, so an absent header, the reserved `'inherit'`, and a role removed by a later settings edit all fall through silently — a stale reference is not an error.
3. **Rules** — the deterministic `roles.rules` matching described above (subagent-only; a declared role wins; no rule match → the built-in `'inherit'`). The rules stage matches **either** the recorded request pair or the served head of a `FallbacksChain/Auto` selection (see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)).

There is **no LLM auto-match stage**: a walk is already inside the request whose chain it picks, and a nested completion per decision was its only remaining cost with no consumer left. The role decides only **which chain the walk uses** — the role's own chain plus the root tail (`fallback: inherit-root`) or alone (`none`); `inherit` walks the root chain. Resolution is a pure in-memory read: no request override, no pending switch, no cooldown, no failure bookkeeping. The resolution runs per walk, so a settings edit that adds or removes a role applies to the next walk without any once-marker to reset.

**Mounting a child on the virtual route.** A subagent only gets a chain if its route is the virtual row, and for an inheriting child the dispatch seam is what puts it there: it stamps `request.agentOptions = { ...agentOptions, provider: 'FallbacksChain', model: 'Auto' }` (rc.1 merges these over the parent's route when the child is created) when **all** of the following hold:

1. a dispatch role resolved (the prompt header, or the seam record of a reserved child on a resume);
2. the request carries **no** explicit `agentOptions.provider` / `agentOptions.model` — an explicit route is **authorized** and is never touched;
3. the backend is **local** (`isLocalBackend`) — an external (acp) child creates no local agent and cannot resolve the virtual provider, so it keeps pure inheritance, i.e. no chain;
4. the config is active and the resolved role's concatenated chain has at least one dispatchable exact head (`roleChainEntries` + `firstDispatchableExactHead`, the same two calls the walk starts from);
5. the host subagent policy is not `unprovable` (fail-closed: never mount a route whose switches the plugin could not prove), and — when that policy is `enabled` — the role chain has at least one dispatchable exact head **on** the allowlist: the first attempt is a plugin-originated route like every switch, so an empty intersection declines the mount and the child keeps pure inheritance.

Mounting is **creation-time only**, so it can never overwrite a resumed child's own durable selection, and it is not a routing engine: the child's role chain is still resolved per walk. The seam records the verdict:

- `virtualRouteInjected: true` on the subagent seam record (sticky across record rewrites) — this is also the flag that makes the walk allowlist-filter the child's candidates;
- `chainHeads`: source `injected` for a mount, source `authorized` for a request that already carried an explicit route (the card renders both labels).

Any contained failure while deciding (a throwing config or policy read) forwards the caller's spec **untouched** with one debug line — a degraded dispatch, never a failed one.

Key semantics:

- **Root agents are untouched by mounting**: a root agent is on the virtual route only because the user selected the row; its failures follow the walk over the slot-effective all-day chain.
- **No first-request hook**: nothing runs at the child's first request any more — the mount decides the route at creation, and the walk decides the chain per request.
- **`role-inject` is history vocabulary only**: the plugin writes no durable `fallbacks/switch` event (issue #52), so the only `role-inject` occurrences a reader can still meet are legacy session events, which renderers label and show as an explicit `role → model` line.
- **Host policy constrains the mount (dsh 0.1.2)**: mounting is plugin-originated, so it is skipped while the policy is unprovable and, when the policy is enabled, skipped unless the role chain has a dispatchable exact head on the allowlist. A mounted child's first attempt is allowlist-admitted the same way as every switch — the walk starts on the first dispatchable route on the allowlist, and refuses before any attempt when the policy reads unprovable or when no route is on the allowlist. Its later resolved candidates are intersected with the effective allowlist in candidate order — an empty intersection blocks the switch, logs a warn line and records a blocked attempt in-process. An explicit spawn route is `authorized` and its walk is not filtered. Policy off → no filter (no allowlist constraint at all). See [Host subagent model selection](#host-subagent-model-selection-dsh-012).

### Agent Team members

With the experimental Agent Team bundle enabled, ordinary delegation is replaced by `spawn_teammate` / `send_message`; a teammate's role is carried by the **same** `**Execute as**: <id>` prompt header — written by the model into its initial spawn prompt, because the spawn request has no role or persona field. `roster.spawn` creates the member through `ctx.subagents.startActivation`, so the teammate flows through the resolution above unchanged:

- **The header is the only role carrier.** A teammate whose prompt omits it, or names an id that is not currently declared, falls through to rules → `inherit`, exactly like a normally delegated child without a header.
- **Names stay arbitrary (but unique inside one Team).** Any number of differently named teammates can carry the same role; there is **no name→role mapping**.
- **Persona, role notice, badge and chain head follow the normal child contract** — the teammate's first request is routed to its role's chain head (stage 2 above). As on the normal path, the persona is a scoped `deployment:persona-prefix` section on the child's own context and does not survive a host restart.
- **Non-local provider — two outcomes.** An external (acp) provider creates no local agent, so a normally delegated external child resolves its role but gets **no persona, role notice or badge**. A **teammate cannot use one**: roster.spawn always reserves a childId, and the runtime rejects a reserved id for a non-local provider (UNSUPPORTED_CAPABILITY), so member creation fails and no role is delivered.

## Host subagent model selection (dsh 0.1.2)

dsh 0.1.2 adds optional host-side child-model selection for subagents: a `subagent-model-selection` settings allowlist (`{ enabled: boolean; allowedModels: [{ provider, model }] }`), a per-session `subagent/model-selection-policy` event (payload `{ allowedModels: [{ provider, model }] }`, written once by the host before the first model request), and spawn-time `provider/model/reasoning_effort` routing. The plugin reconciles its mount and failure-switch behavior with that policy under **one runtime arbiter** — plugin roles/chains remain the failure-recovery layer the host does not provide. Nothing here changes root (non-subagent) routing.

**Effective policy read (per session, in order)**:

1. the session `subagent/model-selection-policy` event (read structurally, never throws); otherwise
2. the host `subagent-model-selection` settings service snapshot when `enabled: true`.

Missing service, `enabled !== true`, and no session event → the policy is **off**. A present-but-malformed event payload, or enabled settings with an unreadable/empty route list, resolves to **unprovable** (fail-closed, below).

### When the policy is enabled

The allowlist is a **hard constraint**: no code path writes, overrides, or sends an out-of-allowlist plugin-originated route. Route identity is exact `provider` + exact `model` — no aliasing, no case-folding, no catalog-id substitution; the intersection runs on **resolved** candidates (wildcards already expanded by the existing chain pipeline).

- **Authorized route preserved (no mount)**: a spawn request that already carries an explicit `provider`+`model` in `agentOptions` is the authorized route — the seam does not mount the child on the virtual row, records the pair with source label `authorized`, and leaves it in place. The child then has no chain (its route is an explicit real model), so there is nothing to filter. A route requires BOTH provider and model — an effort alone is not a route. **Pure inheritance is not an authorized route.**
- **Allowlist-constrained mount**: the mount itself is plugin-originated, so it is skipped while the policy is `unprovable` (fail-closed, next bullet) and declined when no dispatchable route of the role chain is on the allowlist — either way the child keeps pure inheritance and the host seed stands. A mounted child's **first attempt** is allowlist-admitted like every switch: the walk starts on the first dispatchable route on the allowlist and refuses before any attempt when none remains. Its later switches intersect the resolved surviving candidates (after the cooldown / per-walk failed / same-as-current / missing-id filters) with the effective allowlist **in candidate order** — the first in-allowlist candidate wins. When no surviving candidate is on the allowlist → **no switch**: no out-of-allowlist request is sent, a warn line is logged (`fallback switch … blocked: resolved candidates are all outside the subagent allowlist — no switch`) and a **blocked attempt** is recorded in-process (warn log + card warning; **no** durable session write — issue #52 stands).
- **Fail-closed (unprovable)**: with the policy on but unreadable, plugin-originated mounts and switches are skipped (debug line `subagent seam — model-selection policy is unprovable for "<id>"; not mounting the virtual chain route`, warn line `… subagent model-selection policy is on but unreadable — skipping fallback switch`) and a mounted child's walk refuses before its first attempt (`UNDISPATCHABLE_HEAD_CODE`; no request is sent), exactly as the mount gate would have; pure inheritance and all non-switch behavior are untouched. Neither read throws.
- **Virtual-route carve-out (injected vs authorized)**: only a *user- or model-chosen* virtual route is user-authorized — an explicit `FallbacksChain` / `Auto` spawn route, or a parent-inherited virtual selection. Its walk is outside D1's selection semantics (D1 governs provider/model selection the plugin makes, not which head a deliberately chosen virtual route serves), so its candidates are **not** allowlist-filtered. A **seam-mounted** child is the opposite case: the plugin chose that route, so it keeps D1 continuity and is filtered.

### When the policy is disabled or absent

With the policy off there is no allowlist filter and no authorized-route check beyond the explicit-route skip, so a walk takes the first surviving resolved candidate.

### Effort rule

The walk never rewrites a seed config, so `reasoningEffort` is a verbatim passthrough:

| Case | Result |
|------|--------|
| The session's virtual selection names an effort | that effort rides every attempt |
| It names none | none is sent (the virtual pair owns no real route for an inherited effort to belong to) |

This is the same rule the retired `overrideConfig` path enforced by dropping a stale effort on a route change, collapsed into one line because there is no config rewrite left to apply it to. Policy-independent either way.

### Card: filtered titles, policy hint and the explicit sync button

The Fallbacks card Subagents section (`#fallbacks-subagents`) gains a host-policy status area fed by the same runtime reader the walk uses (gateway `/api/fallbacks/get`, additive `subagentPolicy` field — old readers tolerate its absence; `set`/`reset` reject it as a config key):

- **enabled**: the allowlist routes (each `provider/model`), the effective chain head with its source label (`authorized` / `injected`) once one is recorded, and — when a switch was blocked — the empty-intersection warning (`No in-allowlist fallback candidate — switch skipped`). Enabled without a recorded head yet → allowlist shown, head line omitted.
- **unprovable**: a distinct warning line (`Policy present but unreadable — plugin switches disabled`), never an active allowlist.
- **disabled / absent**: the status area and every allowlist-visibility addition are hidden — never an active allowlist.

While enabled, the card also makes the allowlist's effect visible and actionable:

- **Filtered role-card titles**: the collapsed role header's chain summary drops exact entries that are not on the allowlist; wildcard entries stay (their resolved routes are unknown client-side). The visible summary and its `title` tooltip both use the filtered string.
- **Cut-count hint**: a line reports how many selected exact role-chain entries are outside the allowlist.
- **Virtual-route recommendation**: `FallbacksChain/Auto` is recommended only while the allowlist does not already carry that exact route.
- **Sync button**: "sync to host allowlist" — disabled when the store is not writable — merges the CURRENT allowlist with every exact `provider/model` route in `roles.list[].chain` and `rootChain` plus `FallbacksChain/Auto`, de-duplicated by exact provider+model (the current allowlist first, first-seen order), and writes **only** `allowedModels` (never `enabled`) through the host settings service (`settings.mutate`). Wildcard entries are never expanded or written. The card shows success/failure and the refreshed post-write snapshot. **The button click is the only trigger: nothing writes the host allowlist silently or automatically.** The sync merges the **saved** configuration only — unsaved role-chain or root-chain edits disable the button (with a "save first" hint), because the gateway reads the persisted config, not the card draft.

Roles/rules editors stay editable. zh is the locale key-set source of truth with en twins (`subagents.policy.*`).

## FallbacksChain in the model picker

Whenever the plugin has content configured (PR #62 feedback's registration gate re-keyed from the removed `enabled` switch to content presence — conformance is NOT part of it), the plugin registers a virtual **FallbacksChain** provider with one catalog row, **Auto**, on the host LLM runtime. Web and dsh-tui both see the row because they share the same adapter catalog (`session.models` / `listModels`) — no settings-page control or TUI surface is involved.
- **Picker label**: the catalog row's `id` stays `Auto`; its `name` (what the host ModelSelect trigger and menu render) is live — `Auto: <displayName>[<slot>]`, e.g. `Auto: DeepSeek Flash[Liang Peak]`. The display name comes from the head provider's catalog (`listModels`), not the model id, so the same id on different platforms stays distinguishable. Slot label comes from `resolveSlotState`. Bare `Auto` when the all-day chain is non-conforming. The host reloads the catalog on picker open, so the label refreshes then.

- **Select-is-primary is a walk, not a rewrite**: selecting `FallbacksChain` / `Auto` means "use the configured chain as the root primary". The virtual pair is served **unchanged**; the adapter's `stream()` walks the effective chain (see [Chain walk](#chain-walk)) and dispatches the **first dispatchable exact `provider/model`** head of it as the first attempt — `effectiveHeadOf` → `resolveEffectiveChain(config, now, tz)` from `src/time-slots.ts`, slot-aware when a `timeSlots` row matches, `rootChain` otherwise; the resolver is the single source and there is deliberately no `rootChain[0]` fallback branch. Serving the selection unchanged is what keeps the durable `request/header` equal to the session selection, so the host `model-selection` notice fires on a genuine selection change instead of being re-armed on every step. Every consumer that has to compare a **recorded** route against the chain anchors the virtual pair at the served head instead (`anchorServedRoute` in `src/index.ts`; `servedRouteFor` for rule matching) — left on the virtual pair, the failure walk would treat the head that just failed as a fresh candidate and key cooldown / step bookkeeping on the picker row, the rule-6 half-open **success observer** could never close the head's circuit (its durable `assistant/message` source records the request route), and a dispatch-time **role rule** keyed on the real head would stop matching a delegated child whose recorded pair is the virtual row.
- **Misconfiguration surfaces at the request**: the two routing-path warns that shipped with the removed primary rewrite ("the all-day rootChain is not conforming … no primary override" and "the effective chain has no exact head … no primary override") are **gone** with it. A non-conforming all-day chain is therefore observed through the failed request: the walk throws `UNDISPATCHABLE_EFFECTIVE_HEAD` (non-conforming all-day, wildcard selector, malformed selector, or a self-route to `FallbacksChain/*`) or `EMPTY_EFFECTIVE_CHAIN` (empty chain), and the runtime normalizes that into a terminal error finish. There is no longer a plugin log line at the moment the row refuses to serve.
- **Real models get no chain**: selecting any real catalog model means the session is not on the virtual route, so this plugin never touches its requests — no walk, no cooldown, no switch. `llm-retry` is the only retry layer. This is the cost of direction C and the reason the row exists.
- **No `rootMode`**: there is no config key, YAML field, settings toggle, or gateway flag for this mode; the mode is the current session `{provider, model}` selection itself.
- **One walk for every origin**: the row is served by the same `stream()` walk for a root agent and for a subagent session mounted on (or inheriting) the selection — there is no origin gate on the route itself. The walk picks the tail by origin: the slot-effective all-day chain for root, the role chain + raw `rootChain` for a subagent. A delegated child records the parent's `request/header` pair — the virtual row when the parent runs on the virtual route — so the rules stage accepts **either** that pair or the served head (the optional served route on `resolveDeclaredRole`): a rule keyed on the real head keeps matching, and a rule that names the virtual row keeps matching too. The virtual row serves the chain; it is never a second routing engine. The walk anchor (`anchorServedRoute`) has **no** origin gate either: a subagent-origin virtual route is anchored at the served head too, while a subagent's own walk tail stays the raw `rootChain`. That asymmetry is an **accepted gap** — gating the anchor by origin would make the decision's `from` name a route the delegate never served. A second accepted gap sits in the clock: the anchor stamps its **own** `new Date()` while `decide` re-resolves the effective chain with a fresh one, so a time-slot boundary landing between those two reads can name a different head for the same step. The window is bounded by one decision for the `decide` / `anchorServedRoute` pair, and by roughly **one request duration** for the rule-6 **success observer**, which stamps its own `new Date()` when the `assistant/message` arrives rather than reusing the head resolved at request time — a slot boundary crossing inside a long request can therefore anchor that observation to a different head than the one served. Both windows self-heal on the next request and neither can be closed from inside the plugin. A third accepted gap sits at the **outer** ownership pass of a virtual-route session: a durable assistant message whose recorded source names a **real** provider loses its `replayState` before the virtual adapter's `stream()` is entered, because that pass targets the virtual adapter — which does not own the historical provider — so the runtime's ownership check strips the envelope first. It is reachable whenever a session carries real-route envelope history, which is the very scenario this route creates (e.g. switching to `FallbacksChain` / `Auto` inside a session that already has pi-ai-backed history), and it is a **regression introduced by the change that removed the root rewrite**, not a pre-existing condition: the removed rewrite made the root request carry the head pair, so that pass aimed at the head adapter and kept history recorded on that head — only the cross-adapter-instance rotation subset predates it. Evidence strength, stated exactly: the post-change half is **executed** (the real-route boundary arm in `tests/virtual-adapter.spec.ts` asserts the envelope is withheld); the "the removed rewrite kept it" half is **reasoned** from the deleted rewrite plus the runtime's instance-ownership rule, not measured. It cannot be closed from inside the plugin — the envelope is already absent from the delegated history — so the seams are upstream: the loop records the served route rather than the request route, or the ownership pass consults the envelope's own provenance (the same shape this route's own re-stamp uses).
- **Registration lifecycle**: the row registers whenever the plugin has content (content presence — see the field-overview note) — an idempotent transition-reconcile on committed config snapshots, unregistering on deactivation. The condition deliberately ignores `timeSlots` and conformance, so slot-row / chain edits never churn registration. A duplicate registration across fibers degrades to the first fiber owning the route (`DUPLICATE_ADAPTER` caught).
- **Tail-conformance gate for the walk**: a successful root walk requires the all-day chain to be **tail-conforming** — its LAST entry must be exactly one official model (`isAllDayConforming` in `src/time-slots.ts`; leading 默认降级链 entries are walked first). A legacy multi-model or empty chain keeps the row visible, but a root walk refuses it: `UNDISPATCHABLE_EFFECTIVE_HEAD` for a non-conforming multi-model chain, `EMPTY_EFFECTIVE_CHAIN` for an empty one. The routing-path warn that used to accompany the refusal left with the primary rewrite (see the misconfiguration bullet above).
- **The route owns the walk**: the virtual adapter's `stream()` returns the walk (`src/chain-walk.ts`), so cooldown, the switch cap, revert bookkeeping and state writes live in the route itself — the plugin registers no request-path listener at all. An empty effective chain, an undispatchable head (non-conforming all-day / wildcard / malformed / self-route), or a vanished runtime throws an explicit `LlmError` **synchronously before any chunk**, normalized by the runtime into a terminal error finish. Once an attempt has emitted a chunk, its failure is forwarded verbatim (the committed rule) — see [Chain walk](#chain-walk).
- **Metadata and retry policy follow the head**: `resolveModel('Auto')` proxies the current effective head's model info (modalities / context window / reasoning) when resolvable, with a permissive identity default otherwise (never throws). `providerRetryPolicy('FallbacksChain')` returns the **effective head provider's** policy resolved through the live runtime (`src/virtual-adapter.ts`), so a user's `llm-deepseek.retryPolicy` — including `mode: 'always'` — behaves on the virtual route exactly as it does on the head the walk dispatches; an unresolvable head, a vanished runtime, or an unregistered head provider degrades to `undefined` (the host's own default) and never throws. Two consequences, stated one-directionally: the host captures that policy **once**, inside `prepareRoutes` at `registerAdapter` time (`@deepseek-ai/dsh-llm` `lib/index.js`), so a later `llm-deepseek.retryPolicy` edit — or a slot-driven head-**provider** rotation — is only reflected after the plugin re-registers; and because the capture is a snapshot, a rotated head can leave the captured policy **more** permissive than the live head's. Before this change the virtual route always answered with the permissive default, so the snapshot is strictly better than that pre-fix state only in the direction measured here — it is not a blanket improvement over the live policy. Retry **accounting** follows the route the runtime sees, which on the virtual route is the virtual pair: `llm/retry` events are keyed by `FallbacksChain`, and the plugin's own cap counting reads the same key.
- **Stale selection after unregister**: if the row disappears (plugin disabled) while `FallbacksChain` / `Auto` is the session selection, the host keeps showing it as session `current` with `routable: false` (host-native catalog semantics) — select a real model to continue.

## Time slots (分时切换)

Time slots are the wall-clock peak/valley model: each slot row — a frozen UTC+8 preset (Liang Peak / Liang Valley / GLM Peak / GLM Valley) or a custom window — carries its own fallback chain, and the first matching row becomes the effective root chain while the all-day chain stays as the last resort (see [docs/features.md](features.md#time-slots)).

![Time slots](docs/assets/screenshot-1-en.png)

Time-slot rows rotate the **effective root chain** by wall-clock windows. At every **root** request the resolver (`resolveEffectiveChain` in `src/time-slots.ts`) walks the stored rows top-to-bottom: the FIRST row whose window contains `now` (in the config-level `tz`, default `Asia/Shanghai`) wins and its `chain` **replaces** the all-day chain (never concatenated); no match → the all-day `rootChain`. Subagent walks are not slot-rotated (they use the raw `rootChain` tail). The all-day row is always last and **required**.

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

The all-day `rootChain` is a chain: its LAST entry (the tail — the card's 默认模型 panel) must be **exactly one** official model — `deepseek-official/deepseek-flash` XOR `deepseek-official/deepseek-v4-pro`; leading entries (the card's 默认降级链 block) are optional, ordered walk targets before that last-resort fallback. The card renders the tail as an exclusive 2-choose-1 panel (required, not removable) and the rest as a selector list above it (UI order = walk order), and both the card and the gateway **reject** any value whose last entry is not an official model on save — an empty chain or a legacy non-official-tail `rootChain` cannot be saved as-is (no migration wizard; pick one of the two models). At load, a non-conforming tail earns ONE startup warn, slot rows stay inert, and a **root** virtual-route request is refused (`UNDISPATCHABLE_EFFECTIVE_HEAD`), so nothing is dispatched on it; a subagent walks its role chain and is unaffected.

**Retired id**: the previous `deepseek-official/deepseek-v4-flash` tail is no longer legal — the catalog dropped the model (its sibling `deepseek-v4-pro` is the legal Pro tail again, see below). A saved `rootChain` whose tail is `deepseek-official/deepseek-v4-flash` is now non-conforming: startup warns, time-slot rows and the virtual picker row go inert, and the card/gateway refuse to save it until a legal tail (Flash or Pro) is picked.

**Pro availability**: the 0.2.0-rc.2 official default catalog serves the Pro tail as `deepseek-official/deepseek-v4-pro` (alongside the default `deepseek-official/deepseek-flash`), and the settings card offers it as a selectable option — no disabled state, no availability caveat. A hand-written legacy `deepseek-official/deepseek-pro` tail was never catalog-served nor selectable: it reads back as a non-conforming tail (one startup warn, inert slot rows, unselected in the card) — no migration wizard; re-pick the tail as `deepseek-official/deepseek-v4-pro`. The plugin does not probe catalog availability: a chain containing `deepseek-official/deepseek-v4-pro` dispatches to it like any other exact entry, and on the virtual route the `stream()` walk starts at the first dispatchable exact head of the effective chain, so a chain with a working entry before Pro still routes to that earlier entry.

### Save rules (card + gateway)

The gateway (`/api/fallbacks/set`) and the card's pre-save validation apply the same guards: all-day must conform; preset ids must be known and unique; preset rows carry no windows; custom rows need strict `HH:mm` bounds and 0–6 integer days; every row needs a non-empty chain. Malformed rows are rejected — they are never persisted.

## Example YAML

The following configuration demonstrates the full two-block shape — a root chain, role entities (including their `fallback` policy), and rules referencing declared roles / the built-in `inherit` (write it into `$DSH_HOME/settings.yaml`):

```yaml
fallbacks:
  triggerCodes:
    - AUTH
    - QUOTA
    - RATE_LIMIT
  rootChain:                     # All-day chain: LAST entry is 默认模型 (official model)
    - anthropic/claude-3-5-sonnet          # leading entries = 默认降级链 (walked first)
    - deepseek-official/deepseek-flash  # last = Flash / Pro last-resort fallback
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
```

Key points:

- There is no `enabled` key to set (it was removed): the example's content — a non-empty `rootChain` — is what activates the plugin; an empty section is the no-op pass-through.
- The first chain entry is the first fallback target after the primary model; entries in the chain are ordered by priority.
- Declaring a role without any rule = that role is **never hit** (a no-match goes to `inherit` → `rootChain`); to have a role hit you must also write a `roles.rules` entry referencing it.
- `role: inherit` is a valid rule target: it explicitly points a class of requests at the built-in inherit (the root chain).
- `timeSlots` rows rotate the effective root chain by wall-clock windows: first matching row wins (its chain replaces the all-day chain), no match → the all-day `rootChain`; the all-day row is always last and required (exactly one official model — the example above shows one of the two).
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
- **Flat always-open card (the official Plugins-page form language)**: the card renders its whole form unconditionally in any state — first open, loading, error — with no collapsible chrome (no header button, no chevron, no unsaved pill) and **no feature switch** (the config-level `enabled` key is removed; the Plugins-page row toggle is the master switch). The 主代理 / 子代理 / 高级选项 headings are flat, non-collapsible section markers. The config comes from the gateway channel `get` (`present` when it succeeds); when `get` fails / the channel is unreachable, the always-visible informational notice renders **flat atop the form** and the card stays the usable last-known skeleton (failures are reported truthfully, see below).
- **Legacy banner**: a non-empty `legacyKeys` in the `get` response → a migration banner (zh/en) renders at the top of the card body, pointing at this document's migration table; it does not block editing or touch disk.
- **Readable labels**: enumerable config items show readable labels instead of raw enum values — `RATE_LIMIT` → "Rate limit (429)", `QUOTA` → "Quota exceeded", `AUTH` → "Auth / permission failure"; `cooldown-expiry` → "Return to the primary model", `never` → "Keep the fallback model (until session end)"; `inherit-root` → "Inherit root (append rootChain after the role chain)", `none` → "Role chain only (no rootChain)". Numeric fields show the default value beside them; other fields show the currently effective value (the default when unset). The **Advanced options** (高级选项) group (`triggerCodes` / `revertPolicy` / `cooldownMs` / `maxSwitchesPerStep`) is a **flat, non-collapsible section** — no disclosure button; its fields render unconditionally, also in a **read-only** view (`!writable`), where the whole form renders inert (fieldset disabled).
- **主代理 section (PR #62 feedback round)**: the section groups three blocks. **分时槽设置** — the extra-row list: "Add preset" (four frozen ids in a picker; an already-added preset is not offered again) / "Add custom time slot" buttons; per-row remove + move-up/down + **drag-reorder** (HTML5 drag on the row card); rows are **collapsible** to name + first model. A **preset row** shows its frozen name (梁文峰 / 梁文谷 / GLM峰 / GLM谷) + a read-only window summary and edits the model chain only (no start/end/days controls — windows are code constants; GLM rows carry a "仅配置了 zai-coding-cn 时有效" caveat); a **custom row** edits an optional display **name**, start/end (`HH:mm`) + optional weekday toggles (none checked = every day) + the model chain. The **timezone picker** lives inside this block and is **locked to Asia/Shanghai while any preset row exists** (preset windows are frozen UTC+8 constants; custom rows follow the selection). There is **no `timeSlots.enabled` master switch** (adding a row is the opt-in) and **no `rootMode` control** (picker selection is the mode). **默认降级链** — the all-day chain as a configurable provider/model selector list (add/remove; the preemption hints are removed). **默认模型** — the official Flash | Pro **exclusive 2-choose-1 panel** (the chain's required head): a legacy/empty head reads back with no selection + a "pick one of the two official models" notice; saving is blocked until one is picked. Trailing 默认降级链 entries compose `rootChain = [默认模型, ...默认降级链]`.
- **roles.list area (子代理)**: one entity card per role — **collapsible** to id + first chain model (or `inherit-root` when the chain is empty under the inherit-root strategy); expanded shows id (text, format-validated: `/^[a-z0-9-]{1,32}$/`, unique, the `inherit` reserved word is invalid), persona (personality hint, multiline text, **recommended**, on its own line below the id), chain selector rows (appendable), fallback dropdown (`inherit-root` / `none`), and a delete button; an "Add role" button. `prompt` / `permissions` are **not rendered this round**.
- **roles.rules area**: **no origin control** — rules are subagent-only (PR #62 feedback); per-row editing of provider (catalog dropdown/any) + model (cascade dropdown/any) + role (**dropdown**: `inherit` + declared role ids, linked within the page — role add/remove reflects immediately); an "Add rule" button. Empty fields do not participate in matching; a persisted legacy `origin` on the wire is ignored.
- **Pre-save validation (blocks save)**: id format/uniqueness/reserved word, rule role references, invalid selectors, empty role chain (no model config), **non-official all-day head (默认模型 must be exactly one official model)**, and malformed time-slot rows (empty chain, non-`HH:mm` custom window, invalid kind/preset) → inline annotation (red border/hint) + error banner; **a failed validation blocks `save()`** — clicking save writes nothing and shows the error; only a passing validation writes the user layer via the gateway `set` (the gateway applies the same guards).
- **No model-selection coordination is needed (AC-2, degradation retired)**: the walk dispatches each attempt itself, inside the virtual route's own `stream()` — it never rewrites the session's route and never depends on a request-time preview of the session selection. An active `{provider, model}` selection therefore cannot be re-applied over a switch: either the session is on `FallbacksChain / Auto` (the selection *is* the virtual row, and attempts are internal), or the session is on a real model and this plugin does not participate at all. The former listener-order degradation is gone by construction. [verification.md](verification.md) §4.7 (the card no longer carries the former one-line `status.selectionNote`, which was trimmed with the status block). Selecting the virtual `FallbacksChain` / `Auto` row is a **separate** case, not part of this degradation: that route is served and recorded as the virtual pair (see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)), so the durable `request/header` equals the session selection and the host's model-change notice fires on a genuine selection change instead of being re-armed on every step.
- **Reset to defaults (removed from the card, PR #62 UX round 3)**: the card no longer offers a Reset button. The gateway RPC `fallbacks/reset` (clears the user layer; the composition defaults take effect — an empty content config, i.e. the no-op pass-through) and the store `resetToDefaults()` remain as **host APIs** with their own store/gateway tests — only the card affordance was removed.
- **ONE footer save (replaces the per-section saves)**: the card has exactly one **Save/Discard** footer pair. Save is disabled = `!dirty || invalid || saving || !writable` and writes the **whole validated draft** — everything saves together or nothing does; the former per-section split (PR #62 UX round 3) existed so one section's Save could not ride along another section's unsaved edits, which is moot with ONE save over ONE document. Whole-form validation (`validateDraft`) gates the save, with each violation rendering under its owning section heading (主代理 / 子代理 / 高级选项). Discard is a pure client-side revert of the WHOLE draft to the last accepted config (disabled = `!dirty || saving`; kept — this card's staged edits survive refresh, the documented divergence from the official no-discard form). After a save, only clean sections re-seed from the accepted config; unsaved staged edits in dirty sections survive (the per-section reseed contract).
- **Saving and error presentation**: saving writes the user layer via the gateway `set` (merge semantics) with no revision guard — on concurrent/write failure an error banner truthfully presents the save result, and the skeleton and draft are kept (no silent overwrite).
- **Read-only status block**: trimmed (compass AC-2) to the **recent-switch line only** — the most recent `fallbacks/switch` from the current session's raw event surface, newest first, rendered as `from → to (role · reason)` and read naturally for legacy `role-inject` entries (`role → to (role-inject)`). The plugin writes no new durable events (issue #52 stop-write), so the line reflects only events already in the session history (e.g. legacy `fallbacks/switch` events — the repair script cannot make such sessions loadable, see [docs/repair.md](repair.md)); new switches are not visible here — not in-process and not after a restart (they are recorded in the info logs instead). The former "current effective model" line (D-6 — the derivation stays a tested store export, see `deriveEffectiveModel`) and the `selectionNote` degradation line were removed from the card (the selectionNote degradation is re-homed to [verification.md](verification.md) §4.7; the D-6 effective-model line removal is documented there at §4.3 step 4). Empty / loading / error states still render compactly. The line refreshes via push (no polling) on `settings/document-updated` (fallbacks namespace) / `llm/adapters-updated` (catalog only) / session switch / connection reset — with no durable events written, a switch occurring while the page is open never appears, with or without a page reload or host restart. The status block is read-only and not editable. The same in-session diagnostics are available via the `/fallbacks` command (see [docs/features.md](features.md#dsh-tui-surfaces); it shows the **role's own chain entries**, annotated `(inherit-root)` when `rootChain` is the fallback, without rendering `rootChain` entries one by one; `rootChain` entries render in full only when the role has no own chain — matching the runtime composition order). **Legacy note**: for users with only old-format `chains` configured (not migrated, no `rootChain`), the recent-switch surface stays empty (no switches are produced under the old shape) and the migration signal is the startup warn plus the card-top **migration banner** (see "Three-channel legacy notice"); the runtime **no longer reads** the old `chains` key (decisions work only on the new shape; old-only fields behave as a no-op pass-through).

## TUI readback (dsh-tui profile)

In a terminal (`dsh-tui`) profile the plugin's write surface is the **`/settings` screen**: with **dsh-tui ≥ v0.8.5** (commit `c51661f` or later on `main`; the `tuiSettingsSections` seam shipped in v0.8.0, the groups shape + validation in v0.8.5; reference dsh-TUI `main` `2747b87`) the plugin registers a **fallbacks** section with **full parity to the web Settings → 插件配置 → Fallbacks card** — booleans/numbers/selects use native field kinds, complex structures (`rootChain`, `timeSlots`, `roles.list`, `roles.rules`) are JSON text fields, `triggerCodes` is a comma-separated text field, and `tz` a plain text field. Complex-field parsing mirrors the gateway validation (invalid JSON / non-conforming chain / malformed time-slot row → draft invalid → save blocked; a blank draft stages a `clear` that re-inherits the composition layer). On an older dsh-tui the section is absent and file editing remains the only TUI surface. Configuration also lives in the same files as everywhere else and is read back through the command:

- **Where config lives**: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web card writes) for global settings; the profile patch layer `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (plugin-row `config:` overrides) for dsh-tui-specific values. The namespace itself is not TUI-specific — the composed config the TUI reads is the same composed config the runtime uses.
- **Readback**: `/fallbacks config` prints the composed `fallbacks` namespace — first line `Fallbacks 配置: 已启用` / `未启用` (the command renders in its default locale `zh`, like the rest of `/fallbacks`; the en dictionary mirrors the same line as `Fallbacks config: enabled` / `disabled`), then trigger codes, root chain, time slots (`N — {preset} (chain: n, window …)` / `custom {start}-{end} (chain: n)`, long lists truncated with `…`), timezone, roles (`N — id (chain: n)` per role, long lists truncated with `…`), role rules (`N — provider/model → role`, `*` for wildcard), cooldown, revert policy, max switches per request walk (printed as `Max switches per request walk` / `单次请求行走最大切换`), presets, and edit hints pointing at `/settings` (file editing still documented). Bare `/fallbacks` stays the session diagnostic (origin / role / chain / current time-slot winner — 分时 side — / recent **fallback switches** — 降级 side — / cooldown) — the two surfaces are distinct from their first line.
- **Action command**: `/fallbacks config revert-seed <role-id>` restores a seeded role's persona to its declared seed default and prints the outcome — the web settings card presents seeded personas read-only (no revert affordance), so the command is this action's only surface.
- **Menu + completion**: `/fallbacks`, `/fallbacks config` and the `config` → `revert-seed` leaf appear in the TUI `/` menu with subcommand completion when the profile carries the `tuiCommandTrees` service (the `dsh-tui-command-trees` bundle row; the shipped dsh-tui bundle has it).

Installation for the dsh-tui profile → [docs/install.md](install.md) §6.

## Behavior notes

### Trigger conditions

A walk runs on a session whose model selection is `FallbacksChain / Auto` (the root agent by selection, a subagent by seam mount), with configured content and a resolvable candidate chain; the chain advances only on a failure code ∈ `triggerCodes` (default `AUTH`/`QUOTA`/`RATE_LIMIT`) that arrives **before the attempt emitted any chunk**:

- `AUTH` / `QUOTA` are non-retryable codes and reach the walk as the attempt's own terminal finish, with no backoff in between;
- retryable codes such as `RATE_LIMIT` and 5xx are first retried with backoff by llm-retry; each retry re-enters the walk as a fresh request, which starts past the cooled head;
- a failure whose code is not in `triggerCodes` is forwarded verbatim, taking the llm-retry or original-error path.

### Chain walk

One walk per `stream()` call of the virtual `FallbacksChain/Auto` route (`src/chain-walk.ts`):

1. **Start**: resolve the agent view, the role and the chain tail; throw `EMPTY_EFFECTIVE_CHAIN` / `UNDISPATCHABLE_EFFECTIVE_HEAD` / `LLM_UNAVAILABLE` synchronously when no attempt can start. A root walk additionally requires the all-day tail to be conforming; a subagent walks its role chain, so the all-day shape never gates it.
2. **First attempt**: the chain head — or, when cross-call memory has the head on cooldown, the next surviving candidate (the llm-retry re-entry contract). A chain whose candidates are all cooled still attempts the head, so a request is never left without an answer.
3. **Per attempt**: nested `llm.stream({ ...options, provider, model })`, every chunk yielded as it arrives. The first yielded chunk **commits** the attempt.
4. **On an uncommitted trigger-code failure**: swallow the finish, add the route to this walk's failed set, cool it down (unless the code is request-scoped), log the switch line (from/to/role/reason/candidates) and advance — until `maxSwitchesPerStep` switches are spent.
5. **Otherwise**: forward the attempt's finish verbatim and end the walk — a normal finish, an aborted finish, a non-trigger failure, any failure after commit, or an exhausted chain / spent cap (the last attempted failure is re-emitted).

Exactly one terminal `finish` chunk is emitted per walk, no attempt's provider is ever `FallbacksChain` (recursion guard), and a walk never writes a durable `fallbacks/switch` event (issue #52) — the info log is the record.

### Cooldown and returning to the primary

A switched-away / failed model is not re-selected within `cooldownMs` (cooldown and the walk's own failed-candidate set are separate suppressions); with `cooldown-expiry` the model can be re-selected after the cooldown expires (return to primary); `never` does not return within the session (infinite cooldown).

### Recovery mode (`recovery` key)

`recovery` selects how an expired cooldown brings the route back — `'timer'` (default) or `'half-open'`:

- **`'timer'` (default)** — today's behavior, byte-identical: when the cooldown expires the model is re-selected as the preferred candidate (return to primary, subject to `revertPolicy`).
- **`'half-open'`** — evidence-driven recovery: when the cooldown expires the route is **not** restored as the preferred candidate. It goes **half-open**: while the episode is unresolved, every real user request routed to it is admitted normally — exactly as under `'timer'`, there is no admission limit. The episode's **one logged probe** is a single info log line (`llm-fallbacks: agent "…" half-open probe …`; the `probeLogged` marker) emitted for the first admitted request; later admissions route silently. The probe is a normal user request through the existing chain — no synthetic health checks, no background traffic. An **observed completion** on that route closes the circuit — the entry is cleared and the preference is fully restored (restoration is evidence-backed, not timer-backed). This holds whether or not a decision read has already marked the route half-open: a completion observed **after the cooldown lapsed** closes the circuit directly (a manual re-selection of the route, or a route no failure walk ever consulted because the current route kept succeeding), while a completion observed while the cooldown is **still active** is ignored — a stale in-flight success never cancels a fresher suppression. A **cancelled** (interrupted) completion is neutral: it neither closes nor fails the circuit, so the route stays half-open for the next probe. A probe failure re-suppresses the route with an **escalated** duration and the request falls over per the usual switch-away path, consuming the normal `maxSwitchesPerStep` budget.

**Escalation**: consecutive failures multiply the suppression duration by **2** per failure, capped at **1 hour** — `cooldownMs` → 2× → 4× → … → 1 h (the default `300000` escalates 5 m → 10 m → 20 m → 40 m → 1 h → 1 h …). The first failure of an episode is the flat `cooldownMs`; escalation changes the suppression **duration only**, never the per-walk switch count (`maxSwitchesPerStep` is untouched). If `cooldownMs` is at or above the 1-hour cap, escalation is inert (every suppression is already the cap) — `validateFallbacksConfig` warns about this at startup.

**Interaction with `revertPolicy`**: `revertPolicy: 'never'` makes the half-open mechanism entirely inert — the infinite cooldown never expires, so no probe is admitted and nothing escalates.

**Session-scoped state**: half-open flags and escalation counters are in-memory and session-scoped (the same lifetime as the cooldown store) — a restart resets every route to a flat first cooldown.

**YAML-only discovery**: `recovery` is a YAML-only key — the settings card and the TUI `/settings` section render no control for it, and `/fallbacks config` prints no `recovery` line (default-mode output is byte-identical). Machine readback flows only through the gateway `get` passthrough. Set it in `$DSH_HOME/settings.yaml` (or the profile patch layer). While a route is half-open, `/fallbacks` shows a marker row `{key} half-open (awaiting recovery probe)` instead of a suppression time.

### Safety valve

The failed-candidate set and the switch count are **walk-local**: they exist for the duration of one `stream()` call. Beyond `maxSwitchesPerStep` the walk stops advancing and re-emits the last attempt's terminal error verbatim (original code and message preserved), so a chain loop cannot amplify latency. Cross-call memory is the cooldown/recovery store only.

The retired `alwaysModeRetryCap` has no successor and no reason to exist: under the walk, every llm-retry retry is a fresh request, and a route-scoped failure has already cooled the head, so an always-mode retry loop advances through the chain by construction instead of pinning a failing route.

### No-op invariant

With no configured content (no `rootChain`, no `timeSlots` rows, no declared roles — the removed `enabled: false` re-keyed to content absence), or a session not routed to `FallbacksChain / Auto`, or no role chain hit, or no `triggerCodes` hit, or an empty/undispatchable chain, or an exhausted chain, or the switch cap spent: the plugin contributes nothing — the request and session event stream are identical to an uninstalled plugin, and no `fallbacks/switch` events are produced.

### Relationship with llm-retry

This plugin **does not modify** llm-retry's or providers' `retryPolicy`, and it registers no listener on the request waterfalls — llm-retry owns the request-error waterfall exclusively. The two compose through the walk: a retryable failure reaches this plugin only as llm-retry's re-entry, and that fresh request starts past the cooled head. The virtual row's `providerRetryPolicy` mirrors the head's policy, so a user's retry configuration applies on the virtual route exactly as it does on the real head. On plugin unload (HMR/dispose) the injected walk unloads with the fiber and all per-agent state is cleared entirely — no residual state.

### Agent presets (plugin composition)

Agent **presets** are a dsh mechanism for composing plugins — a declarative child-plugin entry list applied as a set, carrying **no** model fields of their own. The fallbacks plugin needs no preset-specific configuration: a preset that includes the `dsh-llm-fallbacks` plugin row gives that preset's sessions the same chains/roles configured for the plugin — the plugin (and therefore its virtual `FallbacksChain / Auto` route) exists **wherever the plugin's row is mounted**, and sessions on that row get the chain. Two caveats:

- **A user preset override replaces the entire child list** (no merge): a preset that omits the fallbacks row silently unmounts the plugin for sessions using that preset. Restate every plugin row you want to keep.
- **Preset-scoped chain configs are possible by mounting the row inside a preset**: the plugin row's `config:` overrides in the preset composition produce a chain configuration that applies to that preset's sessions only (patch rows replace the whole `config`, so restate every field).

The plugin's own settings-namespace chains stay the sanctioned pattern for model routing — dsh's own `subagent-model-selection` policy works the same way (a settings namespace consumed by a tool package), and presets own no model config.

### AUTH triggers and `deepseek-account` routes

Since dsh 0.2.0-rc.2, account-provider credentials expire on an inference 401 and rejected tokens sign the session out (host-side account work). An **AUTH-triggered fallback away from a `deepseek-account` route** therefore now coincides with the host's own credential-expiry/sign-out handling — the plugin's switch-away-and-cooldown semantics are unchanged and aligned with it: the failure walk moves the session to the next candidate (or the primary after cooldown), while the host refreshes or re-prompts for credentials on its side. No plugin configuration is needed; listing or omitting `AUTH` in `triggerCodes` behaves as documented above.
