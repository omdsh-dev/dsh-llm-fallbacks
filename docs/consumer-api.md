# Consumer Contract (Consumer API)

This document defines the **consumer surface** `dsh-llm-fallbacks` exposes: (1) the package-root library API (`import { … } from 'dsh-llm-fallbacks'`); (2) the named cordis service (`ctx.get('llm-fallbacks')`). Both entry points share the same function implementations (single point of truth, no copied logic). Installation → [docs/install.md](install.md); release process → [docs/release.md](release.md).

> **Contract boundary**: this document describes **this package's** export surface and lifecycle. **A valid package contract ≠ an integrated downstream repository** — whether integration is complete must be judged by the actual wiring in the target repository.

## Library API (package-root re-export)

`src/index.ts` re-exports the runtime functions, value constants, and types uniformly from the package root, so consumers `import { … } from 'dsh-llm-fallbacks'` directly without reaching into submodule paths.

### Minimal example

```ts
import { resolveRole, resolveChain, validateFallbacksConfig } from 'dsh-llm-fallbacks'

// resolveRole: matches roles.rules in origin/provider/model order → role id (no match → 'inherit')
const role = resolveRole(agent, config.roles.rules, roleIds)

// resolveChain: concatenates the role chain + rootChain and returns surviving candidates (same as the decision path)
const candidates = resolveChain(config.roles.list, config.rootChain, role, provider, model)

// validateFallbacksConfig: validates the config; problems are warned via logger.warn (never throws)
validateFallbacksConfig(config, logger)
```

### Function exports

| Export | Description |
|---|---|
| `resolveRole(agent, rules, roleIds, warn?)` | Matches `roles.rules` in `origin`/`provider`/`model` order and returns the matched role id; returns the built-in `'inherit'` when no rule matches or a referenced role is undeclared. |
| `resolveCandidate(entry, failing, modelExists?)` | Resolves a single chain entry into a candidate; `provider/*` wildcards expand to the failing models; returns `null` for invalid entries or failed existence probes. |
| `resolveChainViews(roles, rootChain, role, provider, model, warn?)` | Single-pass resolution of a role's concatenated chain, returning the unfiltered candidate views `{ all, wildcard }` (`wildcard[i]` marks whether candidate `all[i]` came from a wildcard entry). |
| `selectCandidates(all, wildcard, filter?, modelExists?)` | Applies the filter and existence probes to the candidate views, returning the list of surviving candidates. |
| `resolveChain(roles, rootChain, role, provider, model, filter?, modelExists?, warn?)` | Full chain resolution (same as the decision path): concatenates the role chain + `rootChain` (`fallback: 'none'` appends nothing), returning the surviving candidates. |
| `hasWildcardEntry(roles, rootChain, role)` | Detects whether a role's concatenated chain contains `provider/*` wildcard entries — callers use it to decide whether catalog existence probes are needed (same source as resolution, no over-approximation). |
| `createCandidateFilter(options)` | Builds a candidate filter: skips the current model, models in cooldown, models already failed in this step, and missing model ids. |
| `annotateCandidates(candidates, surviving, options)` | Annotates each candidate with its skip reason (`skip` undefined = surviving), for visibility / logging. |
| `validateFallbacksConfig(config, logger)` | Validates config legality (undeclared role references, illegal chains, etc.); problems are warned via `logger.warn` (never throws). |
| `detectLegacyKeys(source)` | Detects removed legacy keys (e.g. `chains`) in the config, returning the list of keys hit. |
| `parseSelector(input)` | Parses a `provider/model` or `provider/*` selector; throws `SelectorError` on invalid input. |

### Value exports

| Export | Description |
|---|---|
| `INHERIT_ROLE_ID` | Built-in reserved role id `'inherit'` (fallback target when no rule matches). |
| `ROLE_ID_PATTERN` | Role id format regex `/^[a-z0-9-]{1,32}$/`. |
| `defaultFallbacksConfig` | Default config object (`enabled: false`, default `triggerCodes`, empty chains). |
| `provide` | Declarative service metadata `['llm-fallbacks'] as const` (for loader/tool recognition; actual registration happens inside `apply()` — see the named service section below). |
| `SelectorError` | The catchable error class thrown by `parseSelector` — catch-side type safety depends on it. |

### Type exports

`FallbacksConfig` / `FallbacksRole` / `FallbacksRoles` / `FallbacksRoleRule` / `FallbackStrategy` / `RevertPolicy` / `Origin` / `AgentLike` / `Selector` / `FailingModel` / `AnnotatedCandidate` / `CandidateSkipReason` / `CandidateFilterOptions` / `FallbacksConfigLogger` / `FallbacksService` — all `export type`, compile-time only. The role-seeds types (`SeedDeclaration` / `SeedSkipReason` / `SeedConflict` / `SeedDeclareOutcome` / `EffectiveRole` / `EffectiveRolesReadback` / `SeedRevertFailReason` / `SeedRevertOutcome` / `SeedsWireStatus` / `SeedsIo`) and the `FallbacksSeedManager` class are also re-exported from the package root — see [Role seeds](#role-seeds-service-seeding-api).

### Existing plugin exports (unchanged)

`name` / `Config` (schemastery schema) / `stateStore` / `countRetryEvents` / `apply` and the event and state types (`FallbackSwitchReason` / `FallbacksSwitchEventData` / `AgentFallbackState` / `FallbackStateStore` / `PendingSwitch` / `StepFailures`) continue to be exported from the package root, zero regression.

> **Mechanical guard (S-3)**: the SSOT for the runtime export inventory above (functions / values / existing plugin exports) is `LIBRARY_EXPORT_KEYS` in `tests/export-surface.spec.ts` — adding or removing any runtime key in this inventory requires syncing that array (and the `valueExports` type mapping in the same file), or CI fails. The type export inventory is pinned by the `expectTypeOf` block in the same file (dev-time type pin, checked by local tsc).

## Named service (`ctx.get('llm-fallbacks')`)

After the plugin's `apply()`, a service is registered on the cordis `Context` under the name `'llm-fallbacks'`. **It is a small pure-function face sharing the same function implementations as the library API — not a second library API**: runtime state (cooldown, recent switches, etc.) is not part of the contract — cross-plugin state reads should listen to `fallbacks/switch` events instead of reading service object internals.

### Shape

```ts
{
  name: 'llm-fallbacks'          // matches the plugin name
  version: string                // package.json version (snapshot taken at module load)
  resolveRole: typeof resolveRole
  resolveChain: typeof resolveChain
  validateFallbacksConfig: typeof validateFallbacksConfig
  detectLegacyKeys: typeof detectLegacyKeys
  declareSeeds: (seeds: readonly SeedDeclaration[]) => Promise<SeedDeclareOutcome>
  getEffectiveRoles: () => EffectiveRolesReadback
  revertSeededPersona: (id: string) => Promise<SeedRevertOutcome>
}
```

The service surface **deliberately excludes** runtime state (no `stateStore` / event emitter) and the filtering helpers — those go through library imports only. The static export `provide = ['llm-fallbacks'] as const` is declarative metadata (for loader/tool recognition); the actual registration happens inside `apply()`. The three role-seeds keys (a)(b)(c) are strictly additive — see [Role seeds](#role-seeds-service-seeding-api) below.

### Probe example

Same usage as the mstar loader-probe: probe availability with `!== undefined` first, then call.

```ts
const fb = ctx.get('llm-fallbacks')
if (fb !== undefined) {
  fb.resolveRole(agent, rules, roleIds)
}
```

### Lifecycle

- **Available after `apply`**: during plugin apply, `ctx.get('llm-fallbacks')` returns the service object; the four functions are the same function references as the library re-exports, and `version` equals the package.json version.
- **Withdrawn after `dispose`**: the registration is automatically unregistered when the plugin fiber unloads (cordis 4 fiber-scoped); after plugin dispose, `ctx.get('llm-fallbacks')` is `undefined` — the strict `get` returns `undefined` for a missing implementation, never throwing.

### Type merging

Importing this package automatically merges the `Context` type (`declare module '@deepseek-ai/cordis'` augments `'llm-fallbacks'?: FallbacksService`), so consumers **do not need to declare it themselves**; the `FallbacksService` type is also exported from the package root. Without importing this package's types, `ctx.get('llm-fallbacks')` degrades to the untyped overload.

### Role seeds (service seeding API)

The service grows three additive keys — the six pre-existing keys are unchanged (strictly additive, spec §9.1). Companion plugins use them to auto-provision role rows into the taxonomy with **zero operator hand-edit** (no config block, no bundle-row write): a seeded role is a plain `roles.list` row, and the settings card surfaces the same state (seed badge + revert) over the gateway wire.

```ts
declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome>
getEffectiveRoles(): EffectiveRolesReadback
revertSeededPersona(id: string): Promise<SeedRevertOutcome>
```

| Method | Surface | Notes |
|---|---|---|
| `declareSeeds(seeds)` | (a) declare | **Replacement semantics**: the batch is the companion's full current declaration set; ids omitted from the batch drop out of the seed registry (the role row and the operator's chain remain — R2). Per-id validation **as declared** — an id failing `ROLE_ID_PATTERN` (`/^[a-z0-9-]{1,32}$/`) or equal to the reserved `'inherit'` is skipped with a warn (never coerced); valid siblings in the same batch still apply. Re-declaring the same payload is a no-op (no settings write). |
| `getEffectiveRoles()` | (b) readback | Sync. The effective taxonomy with per-role seed annotations (`seeded` / `personaOverridden` / `seedPersona`). |
| `revertSeededPersona(id)` | (c) revert | Restores one id to the **currently declared** seed default — never a snapshot of the first seed. `{ reverted: false, reason: 'not-seeded' }` when the id was never declared (no write, no throw). |

#### Minimal example

```ts
const fb = ctx.get('llm-fallbacks')
if (fb !== undefined) {
  // (a) declare — the FULL current set; re-declaring the same payload is a no-op
  const outcome = await fb.declareSeeds([
    { id: 'code-reviewer', persona: 'Reviews code for correctness and security' },
    { id: 'fullstack-dev', persona: 'Backend-led fullstack implementation' },
  ])
  // outcome: { applied: string[], skipped: Array<{ id, reason }>, conflicts: Array<{ id, kind }> }

  // (b) read back effective roles with seed annotations
  const { roles } = fb.getEffectiveRoles()
  // roles[i].seeded / roles[i].personaOverridden / roles[i].seedPersona

  // (c) revert one id to the CURRENT declared seed default
  const outcome2 = await fb.revertSeededPersona('code-reviewer')
  // outcome2: { reverted: true, persona } | { reverted: false, reason }
}
```

#### State model and conservative override semantics

Two stores, strictly separated (spec §9.2):

1. **Operator config (persisted — the only persisted store)**: a seeded role is a plain `roles.list` row `{ id, persona }`. `chain` / `fallback` / `prompt` / `permissions` are **omitted** on insert — seeds never write those values (R4).
2. **Seed registry (in-memory, per-apply)**: `Map<id, seedPersona>`; declare = replacement.

`seeded` and `personaOverridden` are **derived at read time**, never stored — because nothing override-shaped is persisted, a config round-trip cannot orphan an override (AC-3).

- An operator persona edit is an **override** (the row persona differs from the seed default); the card shows override state.
- Revert always restores the **currently declared** seed default — when the companion re-declares a new persona for the same id, revert goes to that new default.
- A declared id that already has an operator row is **attached, never duplicated**; a differing persona is flagged loudly as a `'persona-source'` conflict — the operator persona is retained, never silently overwritten.
- When a declaration is removed, the role row and the operator's chain remain; only the seed-default / revert affordance disappears (R2).
- Seeds never write `chain` / `fallback`: an existing chain is preserved byte-for-byte, and a new seeded role keeps an empty chain for the operator to fill (R4).
- **Honest limitation**: the registry dies with the fiber/process. Until the companion re-declares, seeded rows are ordinary config rows (badge/revert absent); after re-declare, "was at default" is indistinguishable from "operator-edited", so the conservative row-untouched path applies and a differing persona is flagged `'persona-source'`. Revert always restores the current declared default; no data is ever lost or silently overwritten.

#### Types

| Type | Shape | Meaning |
|---|---|---|
| `SeedDeclaration` | `{ id: string; persona: string }` | One declared seed (`persona` is free text, not validated — payload hygiene is the companion's job). |
| `SeedDeclareOutcome` | `{ applied: string[]; skipped: Array<{ id, reason }>; conflicts: Array<{ id, kind }> }` | Structured result of `declareSeeds` — the readable status channel; per-id skip never fails the batch. `reason` ∈ `'invalid-id'` \| `'reserved-id'` \| `'duplicate-in-batch'`; `kind` ∈ `'persona-source'`. |
| `EffectiveRole` | `{ id, persona, chain?, fallback?, seeded, personaOverridden, seedPersona? }` | One effective role with seed annotations (`chain` / `fallback` are passthrough — never touched by seeds). |
| `EffectiveRolesReadback` | `{ roles: EffectiveRole[] }` | Result of `getEffectiveRoles`. |
| `SeedRevertOutcome` | `{ reverted, persona?, reason? }` | Result of `revertSeededPersona`; `reason` ∈ `'not-seeded'` \| `'row-absent'` \| `'settings-unavailable'`. |
| `SeedsWireStatus` | `{ id: string; overridden: boolean }` | Gateway wire entry (card badge state); the gateway `seeds` field is an array of these. |

## Version metadata

`version` is the package.json version string at publish time (a snapshot read once at module load via `createRequire`), updated with each release; consumers can use it for version gating, but it is **not runtime state** and does not represent any live status.
