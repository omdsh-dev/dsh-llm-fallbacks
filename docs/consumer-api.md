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

`FallbacksConfig` / `FallbacksRole` / `FallbacksRoles` / `FallbacksRoleRule` / `FallbackStrategy` / `RevertPolicy` / `Origin` / `AgentLike` / `Selector` / `FailingModel` / `AnnotatedCandidate` / `CandidateSkipReason` / `CandidateFilterOptions` / `FallbacksConfigLogger` / `FallbacksService` — all `export type`, compile-time only.

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
}
```

The service surface **deliberately excludes** runtime state (no `stateStore` / event emitter) and the filtering helpers — those go through library imports only. The static export `provide = ['llm-fallbacks'] as const` is declarative metadata (for loader/tool recognition); the actual registration happens inside `apply()`.

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

## Version metadata

`version` is the package.json version string at publish time (a snapshot read once at module load via `createRequire`), updated with each release; consumers can use it for version gating, but it is **not runtime state** and does not represent any live status.
