/**
 * dsh-llm-fallbacks host half: settings, the virtual chain row, the dispatch
 * seam, role seeds and the diagnostics surfaces (direction C, plan
 * dsh-022-rc1-upgrade).
 *
 * Cordis function plugin mounted by the profile bundle patch row
 * `llm-fallbacks` (see `bundle/cordis.patch.yml`), composed AFTER llm-retry.
 *
 * Wiring:
 * - `fallbacks` settings via the Loader entry Config (the current host contract: the
 *   volatile `Config` schema in `src/schema.ts` IS the settings section;
 *   `apply` reads the Loader's live config reference, and the
 *   `settings/document-updated` listener re-derives the runtime caches —
 *   the old `installSection` setSource/onChange contract, spec §4).
 * - The virtual `FallbacksChain/Auto` adapter is the ONLY fallback path: its
 *   `stream()` WALKS the session's chain (`src/chain-walk.ts`). No
 *   `agent/request` / `agent/request-error` listener is registered — rc.1
 *   rejects a request that changes the captured selection, and a
 *   request-error retry `continue`s with that captured selection, so the old
 *   waterfall could not route a retried attempt at all. Real-model sessions
 *   therefore have no plugin fallback; `llm-retry` owns their recovery.
 * - Subagents: the dispatch seam (`src/subagents-seam.ts`) mounts an
 *   inheriting child on the virtual row by stamping its creation options
 *   (design §1.3) — creation-time only, so a resumed child's own durable
 *   selection always wins.
 * - Per-agent state (`FallbackStateStore`): `agent/disposed` removes it, plugin
 *   dispose clears everything (spec §6 — no residual state). The cooldown /
 *   recovery circuit is the cross-call memory the walk reads; per-request
 *   bookkeeping lives inside one walk.
 *
 * @module dsh-llm-fallbacks
 */

import { createRequire } from 'node:module'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the settings seam's cordis `Events` entry
// (`settings/document-updated(ns, revision)` — the live-config change event
// the settings child below follows).
import type {} from '@deepseek-ai/dsh-settings/types'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { defaultFallbacksConfig, detectLegacyKeys, isFallbackActive, migrateLegacyConfig, validateFallbacksConfig, type FallbacksConfig } from './config.ts'
import { Config } from './schema.ts'
import { resolveChain } from './chains.ts'
import { slotMarkerPrefix, walkChain, type ChainWalkDeps } from './chain-walk.ts'
import { installSubagentSeam, subagentSeamOf, type SubagentSeam } from './subagents-seam.ts'
import { installRolePersona } from './role-persona.ts'
import { FallbackStateStore } from './state.ts'
import { resolveSlotState } from './time-slots.ts'
import {
  FALLBACKS_PROFILE_ENTRY,
  FallbacksConfigGateway,
  fallbacksTypertContribution,
  writeFallbacksSection,
  type FallbacksSettingsBridge,
} from './gateway.ts'
import {
  RECENT_SWITCHES_LIMIT,
  recentFallbacksSwitches,
  registerFallbacksCommands,
  type FallbacksCommandController,
  type FallbacksCommandSnapshot,
  type FallbacksConfigSummary,
} from './commands.ts'
import {
  FallbacksSeedManager,
  type EffectiveRolesReadback,
  type SeedDeclaration,
  type SeedDeclareOutcome,
  type SeedRevertOutcome,
  type SeedsDeclareOptions,
  type SeedsIo,
} from './seeds.ts'
import { presetRoles } from './presets.ts'
import { installTuiClient } from './tui.ts'
import { installTuiSettingsSection } from './tui-settings.ts'
import { FALLBACKS_PROVIDER, installFallbacksAdapter } from './virtual-adapter.ts'

/** The plugin row id mounted by the profile bundle patch. */
export const name = 'llm-fallbacks'

/**
 * Declarative service metadata (cordis `Plugin.Base.provide`, read by
 * loaders/tooling). The actual registration happens in `apply()` via
 * `ctx.provide('llm-fallbacks', …)` — the static array never registers
 * anything by itself.
 */
export const provide = ['llm-fallbacks'] as const

/**
 * The plugin's version, read once from the package manifest at module load
 * (zero build changes): `createRequire(import.meta.url)` resolves relative
 * to this module, so `../package.json` is the repo root under src/vitest and
 * the package root when published (`dist/index.js` → `../package.json`, and
 * npm `files` always ships package.json).
 */
const { version } = createRequire(import.meta.url)('../package.json')

/**
 * The named cordis service `ctx.get('llm-fallbacks')` exposes while the
 * plugin is applied: the pure-function library surface + `name`/`version`
 * metadata, plus the three ADDITIVE role-seed methods (spec §9.1, plan
 * fallbacks-role-seeds T2) and the ADDITIVE dispatch-role getter (plan
 * agent-role-getter). Deliberately no state BEARING FIELDS (no
 * stateStore, no event emitters, no filter helpers) — the seed methods are
 * closures over the per-apply `FallbacksSeedManager` and the getter is a
 * closure over the fiber's own seam, so state stays behind the closures and
 * dies with the fiber (spec §9.5).
 */
export interface FallbacksService {
  /** Matches the plugin `name`. */
  name: 'llm-fallbacks'
  /** Package.json version string (module-load snapshot). */
  version: string
  resolveChain: typeof resolveChain
  validateFallbacksConfig: typeof validateFallbacksConfig
  detectLegacyKeys: typeof detectLegacyKeys
  /**
   * (a) Declare the companion's FULL current seed set (replacement semantics,
   * spec §9.1). The optional `options.set` records the batch's registered
   * provenance set name (read back as the rows' `source`); there is
   * deliberately no way to label a declare `bundled` — reserved for the
   * plugin's own preset self-declare.
   */
  declareSeeds(seeds: readonly SeedDeclaration[], options?: SeedsDeclareOptions): Promise<SeedDeclareOutcome>
  /** (b) Sync readback — effective taxonomy with seed annotations. */
  getEffectiveRoles(): EffectiveRolesReadback
  /** (c) Revert one id to the CURRENT declared seed default. */
  revertSeededPersona(id: string): Promise<SeedRevertOutcome>
  /**
   * (d) The dispatch role the seam resolved for a live agent, keyed by child
   * session id (= `Agent.id`).
   *
   * Reads the seam's ROOT-shared per-child record, which the install writes at
   * dispatch BEFORE the native activation call — so the role is readable
   * before the child's first step and for the whole activation lifetime (the
   * existing `agent/disposed` cleanup bounds it, unchanged). The durable
   * surface stays the notice row / `fallbacksSubagentRole` projection; this is
   * the immediate in-memory read over the same single record, with no write
   * path of its own.
   *
   * @returns the DECLARED RAW role id, or `null` when the agent carries no
   *          resolved dispatch role (no header / undeclared / `inherit` /
   *          unknown id).
   */
  getAgentRole(agentId: string): string | null
}

// Consumers importing this package get the typed `ctx.get('llm-fallbacks')`
// surface via the cordis 4 interface-Context merge (precedent: dsh-settings
// `settings`, dsh-agent-default-model `agentDefaultModel`).
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The fallbacks service while the plugin is applied; `undefined` otherwise. */
    'llm-fallbacks'?: FallbacksService
  }
}

export { Config }
/** The plugin's composition config — the `fallbacks` settings schema (spec §4). */
export type Config = FallbacksConfig
export type { FallbackSwitchReason, FallbacksSwitchEventData } from './events.ts'
export type { AgentFallbackState, FallbackStateStore } from './state.ts'

// --- Library API re-exports (plan fallbacks-consumer-api T1) ---
// The fallback-runtime surface — chain resolution, config validation,
// selector parsing — re-exported from the package root so consumers can
// `import { resolveChain } from 'dsh-llm-fallbacks'`. Each block mirrors its
// submodule's export surface exactly; symbols also used internally by apply()
// keep their local imports (the re-export refers to the same binding — no
// duplicate definitions). Role resolution stays seam-internal
// (`resolveDeclaredRole`), not a package-root function.
export {
  annotateCandidates,
  createCandidateFilter,
  hasWildcardEntry,
  resolveCandidate,
  resolveChain,
  resolveChainViews,
  selectCandidates,
  type AnnotatedCandidate,
  type CandidateFilterOptions,
  type CandidateSkipReason,
  type FailingModel,
} from './chains.ts'
export {
  CHAIN_ID_PATTERN,
  defaultFallbacksConfig,
  detectLegacyKeys,
  INHERIT_ROLE_ID,
  ROLE_ID_PATTERN,
  validateFallbacksConfig,
  type FallbacksConfig,
  type FallbacksConfigLogger,
  type FallbacksRole,
  type FallbacksRoles,
  type NamedChain,
  type RevertPolicy,
  type RecoveryPolicy,
} from './config.ts'
export {
  parseSelector,
  SelectorError,
  type Selector,
} from './selectors.ts'
// --- Role-seeds surface (plan fallbacks-role-seeds T2) ---
// The seed declaration domain re-exported from the package root: the
// FallbacksSeedManager class plus every §9.1 supporting type. The service
// methods in apply() delegate to this same module (single point of truth).
export {
  FallbacksSeedManager,
  type EffectiveRole,
  type EffectiveRolesReadback,
  type SeedConflict,
  type SeedDeclaration,
  type SeedDeclareOutcome,
  type SeedRevertFailReason,
  type SeedRevertOutcome,
  type SeedSkipReason,
  type SeedSource,
  type SeedsDeclareOptions,
  type SeedsIo,
  type SeedsWireStatus,
} from './seeds.ts'
// --- Bundled preset roles (plan fallbacks-preset-roles T3) ---
// The 5 omp-style bundled preset role declarations re-exported from the
// package root so library consumers can `import { presetRoles } from
// 'dsh-llm-fallbacks'` and `declareSeeds(presetRoles)` — the SAME data
// source apply()'s self-declaration fires (derivation: omp coding-agent
// agent prompts, snapshot 2026-08-16; frozen text = spec §9.2). The
// self-declare is the ONLY declare labeled `bundled` (internal marker at
// the preset child; the service face accepts the public
// `SeedsDeclareOptions` — `set` only, reserved labels unreachable).
export { presetRoles } from './presets.ts'
// --- Session-projection key + guard (plan agent-role-getter) ---
// The role pill's public contract re-exported from the package root, so a
// companion stops hard-coding the `'fallbacksSubagentRole'` literal or
// re-implementing the blank-string guard. The client half imports the same
// module (one literal, no drift).
export { ROLE_PROJECTION_KEY, readRoleProjectionValue } from './role-projection-key.ts'

/**
 * Per-apply state stores, keyed by context. Weak so entries die with the
 * context; the plugin's own dispose effect clears the store contents.
 * @internal
 */
const stateStores = new WeakMap<Context, FallbackStateStore>()

/**
 * @internal Test seam (T3 review Minor 3): the per-agent fallback state store
 * of the plugin applied to `ctx` — last apply wins. Not part of the plugin's
 * public surface; lets tests assert the no-op purity invariant (a plain
 * request must not grow the store) without reaching into the closure.
 */
export function stateStore(ctx: Context): FallbackStateStore | undefined {
  return stateStores.get(ctx)
}

/**
 * The live config reference the Loader hands `apply` for a
 * volatile Config schema: an identity-stable `{ get }` view (cosmokit's
 * `Volatile` protocol) whose snapshot the Loader re-commits on every form
 * save, so reading `.get()` per call is the authoritative live composed
 * config. Detected STRUCTURALLY on purpose — the protocol is duck-shaped and
 * the dev-time schemastery resolved from the lockfile can predate it, in
 * which case the plain composed object arrives exactly as before.
 */
interface LiveConfigRef {
  get(): unknown
}

/** Whether `value` is a live Loader config reference rather than a plain object. */
function isLiveConfigRef(value: unknown): value is LiveConfigRef {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Materialize one apply-time config value: unwrap a live reference, then
 * resolve schema defaults. `Config(...)` on a volatile-aware schemastery
 * re-wraps its result into a live reference (the marker rides the whole
 * schema), so the result is unwrapped once more — a no-op where the dev-time
 * schemastery resolves to a plain object.
 */
function normalizeConfig(value: FallbacksConfig | LiveConfigRef): FallbacksConfig {
  const plain = isLiveConfigRef(value) ? (value.get() as FallbacksConfig) : value
  const resolved: unknown = Config(plain)
  return isLiveConfigRef(resolved) ? (resolved.get() as FallbacksConfig) : (resolved as FallbacksConfig)
}

/**
 * Deep-merge a stored patch section onto a composed base: plain objects merge
 * recursively, every other value (arrays included) replaces — the same
 * layering rule the settings merge applies, so a plain-config read (no live
 * Loader reference; direct calls and settings-service-backed test doubles)
 * composes `entry` with the entry's stored section identically.
 */
function mergeConfigLayer(under: FallbacksConfig, over: unknown): FallbacksConfig {
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return under
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    const current = merged[key]
    merged[key] = typeof current === 'object' && current !== null && !Array.isArray(current)
      && typeof value === 'object' && value !== null && !Array.isArray(value)
      ? mergeConfigLayer(current as FallbacksConfig, value)
      : value
  }
  return merged as unknown as FallbacksConfig
}

export function apply(ctx: Context, config: FallbacksConfig | LiveConfigRef = defaultFallbacksConfig): void {
  const logger = ctx.logger('llm-fallbacks')
  // Cordis resolves the entry through the schema before apply, so `config` is
  // already defaulted (and — volatile schema — is the LIVE reference the
  // Loader commits form saves into); re-resolving keeps direct calls (tests)
  // normalized and unwraps the reference for the startup derivations below.
  const entry = normalizeConfig(config)
  // Role-seeds (plan fallbacks-role-seeds T2): the per-apply seed manager
  // and its io adapter are constructed BEFORE the service provide block so
  // the service value closes over them (spec §9.5 — one registry per plugin
  // instance, no module-level global). `read` walks the SAME live `source`
  // the runtime/gateway read (setSource reassignment included — the bridge
  // shape); `writeRoles` mirrors the gateway's OPTIONAL settings channel: a
  // conditional inject child that leaves the adapter in a loud KD-G5-style
  // failure state when no settings service is composed. The manager commits
  // its registry only after a successful write (compute → write → commit),
  // so a failed materialization throws and never leaves a half-applied
  // registry behind (retry-safe).
  const seeds = new FallbacksSeedManager(logger)
  const seedsSettingsUnavailable = 'llm-fallbacks: seeds: settings service is unavailable — seed roles cannot be written'
  let writeRoles: SeedsIo['writeRoles'] = () => {
    throw new Error(seedsSettingsUnavailable)
  }
  // The settings inject child owns the whole service lifecycle (issue #105):
  // its callback binds the write channel FIRST, then provides the named
  // service synchronously in the same body — both done before the callback
  // returns, so "the service probes non-undefined" implies "declareSeeds can
  // write" (service visibility ⟹ write channel bound; a declare-on-probe
  // consumer can no longer hit the settings-unavailable window). The provide
  // is made on `sctx`, making THIS child the service's owner fiber (cordis
  // `provide` registers via the receiver context's fiber effect): the child
  // fiber stays LOADING until the callback returns, so strict `ctx.get` only
  // sees the service after bind+provide completed; when the child unloads
  // (settings teardown or plugin dispose) the provide disposer unregisters
  // the service with it, and on settings re-appearance the child re-fires:
  // re-bind → re-provide → the preset child re-declares (idempotent).
  // VALUE-form registration — cordis 4 `ReflectService.provide` stores the
  // value directly, so a factory shape would register the function itself as
  // the service. The object references the SAME re-exported functions (single
  // point of truth, no copied logic). Multi-fiber dedupe (W-1): a later
  // fiber applying over a shared context root hits cordis' loud
  // duplicate-key failure (`service "llm-fallbacks" has been registered at
  // <…>`). Mirror advisor's multi-fiber dedupe: the catch lets the FIRST
  // fiber own the service while later fibers degrade gracefully; it also
  // clears `serviceOwned` BEFORE rethrowing any other error, so the preset
  // child skips when the child fiber fails (the fiber logs the failure).
  ctx.inject(['settings'], (sctx) => {
    // Same write path as the gateway (strip + path-addressed v1 cleanup): the
    // service-level seeds io is a live entry point too (declareSeeds,
    // revertSeededPersona, the bundled preset self-declaration).
    writeRoles = (roles) => writeFallbacksSection(sctx.settings, { roles })
    try {
      sctx.provide('llm-fallbacks', {
        name: 'llm-fallbacks',
        version,
        resolveChain,
        validateFallbacksConfig,
        detectLegacyKeys,
        // (a)(b)(c) — plan fallbacks-role-seeds T2: additive seed surface. Each
        // method delegates to the per-apply manager through the io seam
        // (single point of truth — no copied logic).
        declareSeeds: (declarations: readonly SeedDeclaration[], options?: SeedsDeclareOptions) =>
          // Whitelist the public contract (qc2 W-001 / qc3 W-1): forward ONLY
          // `{ set }` — every other key on a plain-JS or cast options object
          // (including the internal `bundled` marker) is stripped before it
          // can reach `resolveSource`, so the reserved label is
          // runtime-unreachable through this face, not just type-level. The
          // preset child declares through the manager directly and does not
          // cross this boundary.
          seeds.declare(declarations, seedsIo, options?.set === undefined ? undefined : { set: options.set }),
        getEffectiveRoles: () => seeds.effectiveRoles(seedsIo),
        revertSeededPersona: (id: string) => seeds.revert(id, seedsIo),
        // (d) — plan agent-role-getter: a read-only closure over the seam THIS
        // apply installed (`subagentSeamOf` is keyed by the apply context, not
        // by the settings child). The record is pre-written at dispatch, so
        // the read works before the child's first step; `?? null` maps the
        // absent seam / unknown id / no resolved role onto the documented
        // `null` (never `undefined`) contract. No new state, no write path.
        getAgentRole: (agentId: string) => subagentSeamOf(ctx)?.records.get(agentId)?.role ?? null,
      })
      serviceOwned = true
    } catch (error) {
      serviceOwned = false
      if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
      ctx.logger('llm-fallbacks').debug('fallbacks service already registered — no service on this fiber (multi-fiber dedupe)')
    }
    return () => {
      writeRoles = () => {
        throw new Error(seedsSettingsUnavailable)
      }
    }
  })
  // `writeRoles` is a mutable binding (the inject child swaps it when the
  // settings service appears/disappears) — the adapter must read the binding
  // at CALL time, not capture its initial value at construction.
  const seedsIo: SeedsIo = {
    read: () => source(),
    writeRoles: (roles) => writeRoles(roles),
  }
  // Preset self-declaration ownership (plan fallbacks-preset-roles T3, spec
  // §9.3 D9.3-a W-1): `serviceOwned` records whether this fiber owns the
  // service — only the owning fiber's tail settings child fires the bundled
  // preset declare; a deduped later fiber must not re-fire (no duplicate
  // conflict warns, no duplicate writes). Claimed OPTIMISTICALLY at apply
  // time: the provide now settles inside the settings inject child (after
  // apply returns), while the TUI installers below read this flag
  // synchronously during apply(). The claim is correct whenever settings is
  // absent or arrives later; the child's catch corrects it to false for a
  // deduped/failed fiber BEFORE the preset child fires (same-service inject
  // children settle in registration order — the provide child fires first).
  let serviceOwned = ctx.get('llm-fallbacks') === undefined
  // Live composed source: with the volatile Config schema the
  // Loader hands `apply` an identity-stable config reference and commits every
  // form save INTO it — reading it per call is the live view, and the old
  // installSection `setSource` swap is served by the Loader itself. A plain
  // config (direct calls; test doubles that stand in for the settings service)
  // has no Loader commit to lean on, so the settings child below keeps a
  // settings-composed view fresh instead; before that child fires the
  // normalized entry is the source.
  let settingsComposed: FallbacksConfig | undefined
  // The RAW composed view: schema defaults → plugin row → settings user layer,
  // exactly as stored (v1 keys included).
  const rawSource = (): FallbacksConfig => {
    if (isLiveConfigRef(config)) return config.get() as FallbacksConfig
    if (settingsComposed !== undefined) return settingsComposed
    return entry
  }
  // EVERY read goes through the in-memory v1 → v2 upgrade
  // (plan fallbacks-v1-auto-migration): a profile still holding `rootChain` /
  // array role chains / `roles.rules` keeps working — the old default chain
  // becomes chain #0 `Auto`, so the picker route the user already selected
  // resolves again. No file is rewritten; the next explicit save persists v2.
  const source = (): FallbacksConfig => migrateLegacyConfig(rawSource())
  // Virtual FallbacksChain adapter: ONE conditional `ctx.inject(['llm'])`
  // child — the picker rows register whenever the config is ACTIVE
  // (`isFallbackActive` = `chains.length > 0`), and hide when no chain is
  // configured. Conformance is NOT part of registration: a chain with empty or
  // non-conforming entries still earns its row, and the walk refuses it. The
  // returned reconcile thunk is wired into the settings onChange below:
  // transition-reconcile over COMMITTED composed snapshots only (card drafts
  // are client-side until gateway save), so the catalog never flickers. The
  // gate is the chain LIST, so adding/removing the last chain intentionally
  // churns registration; a per-chain conformance or slot edit never does
  // (conformance gates the walk, not the row).
  // `() => source()` — the mutable binding, not the initial thunk: `source`
  // reads the Loader's live config reference (or the settings-composed view —
  // same binding), and reconcile must read the LIVE composed snapshot (same
  // pattern as the settings bridge below).
  // AC-4: warn-not-crash startup validation — the schema-resolved entry is
  // checked once (invalid ids / undeclared rule references / illegal
  // selectors / bad fallback enum); each violation warns and "does not take
  // effect", the config stays usable (spec §4).
  validateFallbacksConfig(migrateLegacyConfig(entry), logger)
  // US-4: two-block-era leftovers in the live source (schemastery retains
  // unknown keys, verified plan Task 1 Step 1) → one startup warn pointing
  // at the migration table; the gateway separately reports the same keys as
  // get().legacyKeys for the UI banner. warn-only — never auto-migrates.
  const legacyKeys = detectLegacyKeys(rawSource() as unknown as Record<string, unknown>)
  if (legacyKeys.length > 0) {
    logger.warn('llm-fallbacks: legacy config keys detected (v1 two-block keys); see docs/configuration.md migration table — %o', legacyKeys)
  }
  // Declared role ids the seam resolves against (spec §7.1): trimmed id → the
  // DECLARED RAW id, so a padded YAML id (' coder ') and a trimmed header
  // reference ('coder') resolve to the same role (client-canonical trim
  // alignment, qc2 F-001 — validateFallbacksConfig trims both sides, and
  // resolveDeclaredRole returns the raw declared id so roleDef and chain
  // pointers match the stored roles.list entry exactly). The reserved
  // 'inherit' id is always legal and never listed. Re-derived on every
  // settings change (onChange below) — roleIds follows source().
  let roleIds = new Map(entry.roles.list.map((role) => [role.id.trim(), role.id] as const))

  // Guide §7 (plan llm-fallbacks-settings-gateway): the gateway's
  // FallbacksSettingsBridge consumes the SAME live source the runtime reads
  // (schema defaults → plugin-row base → profile patch). No settings-exposure
  // opt-in here: upstream dsh has no such registration-level option — web
  // clients reach the config through the gateway channel instead. The gateway
  // reads `source()` live per call, so the bridge carries no change fan-out
  // (dead machinery removed in the QC fix wave — nothing ever subscribed).
  // Current re-home: `SettingsForms` has no registration step at all — the
  // Loader entry Config IS the settings section (the volatile `Config` export
  // in `src/schema.ts` is what makes the entry describable and writable), and
  // the change notification the old `installSection` `onChange` hook delivered
  // is now the settings seam's `settings/document-updated` event. The
  // conditional `ctx.inject(['settings'])` child preserves the old
  // optional-settings semantics: no settings service composed → no binding
  // (the runtime keeps serving the composition entry), and the deferred
  // callback settles one macrotask after apply (the same "registers through
  // ctx.inject" behavior the tests pin). Registration order matters: this
  // child fires AFTER the writeRoles+provide child above (the service's owner
  // fiber), so its fire sees the write channel already bound and the service
  // provided. The listener re-derives the caches from `source()` — on the live
  // Loader reference path the commit already landed there; on the plain-config
  // path the composed view is refreshed from the settings service first.
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings
    const refreshComposed = (): void => {
      const descriptor = settings.describe().find((d) => d.ns === FALLBACKS_PROFILE_ENTRY)
      // Merge the stored section over the entry, then resolve through the
      // schema — the same layering the Loader applies to a profile patch, so
      // the plain-config path composes identically (defaults fold in, stored
      // rows materialize).
      settingsComposed = descriptor === undefined
        ? undefined
        : normalizeConfig(mergeConfigLayer(entry, descriptor.value))
    }
    if (!isLiveConfigRef(config)) refreshComposed()
    const disposeDocumentUpdated = ctx.on('settings/document-updated', (ns: SettingsNamespace) => {
      if (ns !== FALLBACKS_PROFILE_ENTRY) return
      if (!isLiveConfigRef(config)) refreshComposed()
      // A settings update can change roles.list / chains — roleIds re-derives
      // from the same live source the runtime reads.
      // Validation (validateFallbacksConfig / detectLegacyKeys) is
      // intentionally STARTUP-ONLY: a live settings merge is already
      // schema-validated by the settings layer, and the defensive runtime
      // (resolveDeclaredRole / resolveChainViews / roleDef lookups) tolerates
      // bad values with warn-not-crash semantics (qc1 F-006).
      const current = source()
      roleIds = new Map(current.roles.list.map((role) => [role.id.trim(), role.id] as const))
      // Virtual adapter registration reconcile: an empty/non-empty `chains`
      // transition only — idempotent, per-chain edits no-op.
      reconcileFallbacksAdapter()
      // P7: a settings edit is a config change, not a wall-clock rotation —
      // re-baseline the 分时切换 markers so the next root request starts
      // from the new config instead of logging a spurious switch.
      slotWinners.clear()
    })
    return () => {
      disposeDocumentUpdated()
      settingsComposed = undefined
    }
  })
  const bridge: FallbacksSettingsBridge = {
    source: (): FallbacksConfig => source(),
    // Legacy detection needs the stored view: the upgraded one carries none of
    // the v1 keys by construction (plan fallbacks-v1-auto-migration).
    rawSource: (): FallbacksConfig => rawSource(),
  }
  // T1 (plan llm-fallbacks-settings-gateway): the host-side `fallbacks` config
  // gateway — the `/api/fallbacks/get` + `/api/fallbacks/set` +
  // `/api/fallbacks/reset` endpoints. It reads the SAME bridge the runtime
  // reads, so get/set/reset always operate on the live composed config.
  // Mirror advisor's multi-fiber dedupe: the cordis Service registration
  // fails loud on a duplicate key, so the catch lets the first fiber own the
  // `fallbacks` service key while later fibers fall back (no gateway) — the
  // typertGateway claim set dedupes, so claims never conflict.
  // Plan role-based-subagent-adoption Task 1: the dispatch-seam role record —
  // ONE cordis `internal/get` wrapper over `subagents` resolving the Assignment
  // `**Execute as**: <id>` role at `start`/`startContinuable` and keying a
  // per-child record by the CHILD SESSION ID the wrapped start returns. The
  // wrapper is additive: with no declared role the native request object and
  // result pass through untouched, and any seam failure degrades to the native
  // path with one debug log. Task 2 (below) merges the resolved role's
  // declared persona into the request's NATIVE persona slot at that same
  // single resolution point — chain-independent (the role alone decides) and
  // gated by the provider's measured persona capability; Task 3 emits the
  // once-per-child notice row from `subagentSeam.records` (its `noticeEmitted`
  // marker survives `agent/disposed` — CF-6 — and is cleared when the last
  // fiber of this root disposes), and Task 3b registers the host session projection unit that
  // folds that row back out of the child's log for the header badge. The record
  // map is cleaned on agent/disposed + the last fiber's dispose below.
  // Multi-fiber dedupe (fix M-3, reshaped by the CF-5 fix round): ONLY the
  // seam's `internal/get` wrapper is ROOT-scoped and single-owner, so a later
  // fiber applying over a shared context root must not install a second
  // listener set (nested wrappers + duplicated contained debug lines). Mirror
  // the service / gateway / typert guards below — but structurally, not by
  // matching a thrown message: the install always returns a seam and reports
  // ownership in `ownsWrapper` (false = this fiber shares the root's record map
  // and registers only its own notice emitter + projection unit). The notice
  // emitter and the projection unit are registered PER APPLIED FIBER by the
  // install, so a disposing owner fiber no longer takes the role surfaces down
  // with it.
  const subagentSeam: SubagentSeam = installSubagentSeam(ctx, {
    // Live binding read: the settings onChange below re-derives `roleIds` in
    // place, so the seam sees role edits without a re-install.
    roleIds: () => roleIds,
    // The SAME live roles source `installRolePersona` below reads. Only a
    // reservation failure consults it: the persona listener cannot see the
    // child the runtime then mints, so the seam is what carries that child's
    // persona verdict onto the record the notice row reads.
    roles: () => source().roles.list,
    // Role chain stamp (`injectRoleChain`): the seam points a dispatch child
    // at its role's named chain, reading the SAME live config the walk reads.
    source: () => source(),
    debug: (message) => logger.debug(message),
  })
  if (!subagentSeam.ownsWrapper) {
    ctx.logger('llm-fallbacks').debug(
      'subagent role seam wrapper already installed on this context root — this fiber registers the notice emitter and the projection unit only (multi-fiber dedupe)',
    )
  }
  // Plan dsh-021 Task 1: rc.1's activation spec carries no persona slot, so the
  // role persona is delivered as a scoped `deployment:persona-prefix` section on
  // the CHILD's own context (the shipped `file-reference-local` pattern) —
  // registered over the SAME ROOT-shared record map and read live from the same
  // roles source the seam uses, so a persona edit reaches the next dispatch
  // without a re-install. The section's contained failure verdict
  // (`personaNotApplied`) rides those records into the notice row below.
  installRolePersona(ctx, {
    records: subagentSeam.records,
    roles: () => source().roles.list,
    debug: (message) => logger.debug(message),
  })

  try {
    // T3 (plan fallbacks-role-seeds): the gateway receives the SAME per-apply
    // seed manager the service exposes — badge state (`seeds` wire field) and
    // `fallbacks/revert-seed` both delegate to it (spec §9.4 single point of
    // truth); the gateway builds its io over the bridge + its own settings
    // capture.
    new FallbacksConfigGateway(ctx, bridge, seeds)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
    ctx.logger('llm-fallbacks').debug('fallbacks gateway already registered — no gateway on this fiber (multi-fiber dedupe)')
  }
  // The typert endpoint registration is OPTIONAL, like the settings service:
  // it activates through a conditional inject child, so compositions without
  // a typert registry (headless/standalone/integration harnesses) keep the
  // fallbacks runtime working and simply omit the /api endpoints. The
  // endpoints are registered EXPLICITLY through `ctx.typert.register(...)`
  // (NOT the @Remote SRC markers): the host typertGateway checks
  // `ctx.typert.local` FIRST for claim + dispatch, while SRC discovery reads
  // a module-private marker table that a locally-linked plugin can never
  // share with the host installation (link plugins resolve their peers from
  // their real directory, physically separate from the dlx host tree — the
  // observed failure was zero claimed endpoints → `/api/fallbacks/*` 404).
  // The child disposer is the registration's own effect disposer, so the
  // endpoints withdraw when this fiber (or the typert service) goes away.
  ctx.inject(['typert'], (tctx) => {
    try {
      return tctx.typert.register(fallbacksTypertContribution())
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      tctx.logger('llm-fallbacks').debug('fallbacks typert endpoints already registered — no endpoints on this fiber (multi-fiber dedupe)')
      return () => {}
    }
  })

  const states = new FallbackStateStore()
  stateStores.set(ctx, states)
  const slotWinners = new Map<string, { key: string; label: string }>()
  // P7 分时切换 marker: the LAST slot winner per (agent, chain id) — identity
  // key + display label, in-process only. The WALK compares it against the
  // current winner (a routing seed observation, never a failure decision — no
  // cooldown, no switch count, no durable event). Cleaned on agent/disposed
  // (every chain's marker for that agent) + plugin dispose, and re-baselined
  // on a settings change (a config edit is not a wall-clock rotation).
  // The adapter registration lifecycle is declared above (the install happens
  // below, once the walk deps exist).
  //
  // The deps bundle is built HERE, over the live per-apply state: the walk
  // reads the same `source()` / `roleIds` bindings and the same cooldown
  // store the rest of the runtime reads, so a settings change reaches the next
  // walk without a re-install. `readConfig` is the live binding (not the
  // initial thunk) — reconcile and every walk must see the LIVE composed
  // snapshot.
  const walkDeps: ChainWalkDeps = {
    readConfig: () => source(),
    getLlm: () => ctx.get('llm'),
    states,
    slotWinners,
    log: logger,
  }
  const reconcileFallbacksAdapter = installFallbacksAdapter(ctx, () => source(), (options) => walkChain(walkDeps, options))

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
    // One marker per (agent, chain) — drop every chain's entry for this agent.
    const markerPrefix = slotMarkerPrefix(agent.id)
    for (const key of slotWinners.keys()) {
      if (key.startsWith(markerPrefix)) slotWinners.delete(key)
    }
    subagentSeam.records.delete(agent.id)
    // CF-6: `noticeEmitted` is deliberately NOT cleared here. `Agent.id` IS the
    // child session id, and a continuable child's durable session OUTLIVES the
    // activation — clearing the marker on re-activation resume let a re-dispatch
    // append a SECOND `[role: x]` row to the same session, contradicting the
    // documented "exactly one notice row per child session". The marker is
    // bounded (`NOTICE_EMITTED_LIMIT`) and cleared when the last fiber of this
    // root disposes (the seam's `dispose`, in the effect below).
  })

  ctx.effect(() => () => {
    states.clear()
    slotWinners.clear()
    // The seam is NOT disposed here: it registers its OWN lifecycle effect at
    // install (`src/subagents-seam.ts`) over the same root-shared state, which
    // is also the only release a caller that throws before this effect exists
    // can reach.
  }, 'llm-fallbacks: clear per-agent state')

  // AC-5: /fallbacks — session-scoped read-only diagnostics. Conditional
  // inject child (commands must NOT join the top-level inject list —
  // advisor T1 fix): the child activates only when a command registry is
  // composed, so an absent commands service leaves the command silently
  // unavailable with no top-level error. The handler reads live state
  // through the SAME `source()` / `roleIds` / `states` the runtime uses and
  // never mutates fallback state (read-only; no cooldown reset, no pending
  // writes). The one exception is the half-open display path (P4): expired
  // cooldown entries lazily transition to half-open at the diagnostic read —
  // the same lazy-expiry the decision-path read performs — so the marker
  // appears at expiry without waiting for a failure walk.
  const fallbacksCommandController: FallbacksCommandController = {
    getSnapshot(agent): FallbacksCommandSnapshot {
      const config = source()
      const state = states.peek(agent.id)
      // P4 (plan fallbacks-half-open-recovery Task 4): under half-open mode
      // the expired cooldown entries transition AT the diagnostic read (so
      // the marker appears at expiry without waiting for a failure walk),
      // then the active rows are followed by the half-open marker rows.
      // Timer mode skips syncRecovery entirely — internal state and output
      // stay byte-identical in default mode.
      const recovery = config.recovery ?? 'timer'
      if (state !== undefined && recovery === 'half-open') {
        states.syncRecovery(state, Date.now(), recovery)
      }
      // Named virtual chains (§4): every configured chain with its slot
      // state; the calling agent's selection (its route names the chain id)
      // is marked. The role display is the seam record's id + specified
      // chain pointer.
      const roleRecord = subagentSeam.records.get(agent.id)
      const role = roleRecord?.role ?? ''
      const roleChain = roleRecord === undefined
        ? undefined
        : source().roles.list.find((entry) => entry.id === role)?.chain
      const selectedChainId = agent.options?.provider === 'FallbacksChain' ? agent.options?.model : undefined
      const now = new Date()
      const chains = source().chains.map((chain) => ({
        id: chain.id,
        label: chain.label,
        entries: chain.entries,
        slotLabel: resolveSlotState(chain, now, source().tz ?? 'Asia/Shanghai').label,
        selected: chain.id === selectedChainId,
      }))
      return {
        origin: agent.session.header?.origin ?? 'root',
        role,
        ...(roleChain === undefined ? {} : { roleChain }),
        chains,
        switches: recentFallbacksSwitches(agent.session.snapshotEvents(), RECENT_SWITCHES_LIMIT),
        cooldown: state === undefined
          ? []
          : recovery === 'half-open'
            ? [
              ...state.cooldown.snapshot(),
              ...state.recovery.halfOpenEntries().map((entry) => ({
                key: entry.key,
                untilEpochMs: entry.untilEpochMs,
                halfOpen: true,
              })),
            ]
            : state.cooldown.snapshot(),
      }
    },
    // Composed-config readback — the SAME live `source()` the runtime reads
    // (schema defaults → plugin-row base → settings user layer). Every named
    // chain is summarized with its label, entries and time-slot rows (preset
    // rows carry `{ preset, chainCount }` — windows are frozen PRESETS
    // constants, never stored; custom rows carry `{ start, end, chainCount }`),
    // each role with its `chain` POINTER (the `FallbacksChain/<id>` route it
    // specifies, or absent = NOT SPECIFIED), plus the config `tz`. `presets`
    // is optional-on-type with a schema default, so the summary falls back to
    // 'bundled' explicitly. Chain and entry lists read defensively (`?? []`)
    // so a malformed legacy slot row never crashes the readback (the resolver
    // warns and skips it at request time).
    getConfig(): FallbacksConfigSummary {
      const config = source()
      return {
        active: isFallbackActive(config),
        triggerCodes: config.triggerCodes,
        chains: config.chains.map((chain) => ({
          id: chain.id,
          label: chain.label,
          entries: Array.isArray(chain.entries) ? chain.entries : [],
          timeSlots: (chain.timeSlots ?? []).map((row) => row.kind === 'preset'
            ? { preset: row.preset, chainCount: (row.chain ?? []).length }
            : { start: row.start, end: row.end, days: row.days, chainCount: (row.chain ?? []).length }),
        })),
        tz: config.tz ?? 'Asia/Shanghai',
        roles: config.roles.list.map((role) => ({ id: role.id, chain: role.chain })),
        cooldownMs: config.cooldownMs,
        revertPolicy: config.revertPolicy,
        maxSwitchesPerStep: config.maxSwitchesPerStep,
        presets: config.presets ?? 'bundled',
      }
    },
    // T2 AC-3 (fallbacks-tui-settings): the one write action — revert a
    // role's persona to its CURRENT declared seed default. Wired through the
    // SERVICE path (seeds.revert(roleId, seedsIo), the same single point of
    // truth as revertSeededPersona) rather than the typert gateway RPC: the
    // gateway may not be composed in a dsh-tui profile, while `seeds` is
    // always in scope here. Business failures are VALUES (`ok: false` +
    // the SeedRevertFailReason code — qc1 F-003 / qc2 F-006 / qc3 F-003);
    // the command handler localizes the code per its registration locale,
    // so the controller never composes copy. A failed settings write
    // propagates loudly as a rejection (the seeds contract — never
    // swallowed); the handler maps it to a structured error outcome (C-6).
    revertSeed: async (roleId) => {
      const outcome = await seeds.revert(roleId, seedsIo)
      if (outcome.reverted) return { ok: true }
      return { ok: false, reason: outcome.reason ?? 'not-seeded' }
    },
  }
  ctx.inject(['commands'], (commandCtx) => {
    // Return the registry disposer: cordis collects the inject child's
    // returned function and runs it on unload, making the documented
    // lifetime contract (registerFallbacksCommands' @returns) true.
    return registerFallbacksCommands(commandCtx.commands, fallbacksCommandController)
  })

  // dsh-tui client surface (plan fallbacks-tui-client T1, AC-1 +
  // fallbacks-tui-settings Task 2): register the `tuiCommandTrees`
  // /fallbacks provider (localized root descriptions + `config` →
  // `revert-seed` subcommand completion — the provider now supplies both,
  // not just `config`). Conditional inject child like the commands/typert
  // children — absent service = clean no-op. Gated by `serviceOwned`, now
  // the OPTIMISTIC apply-time claim (the provide settles inside the settings
  // child, after apply returns): a post-settlement duplicate fiber reads
  // false and skips, while a fiber applying inside the claim window
  // registers here and degrades via the installer's own `already
  // registered` catch (never aborts). Registered here — after the
  // commands child, BEFORE the tail settings preset child — so the tail
  // child's last-registered activation order is preserved.
  installTuiClient(ctx, { serviceOwned })

  // dsh-tui settings write surface (plan fallbacks-tui-settings Task 1,
  // AC-1/AC-2): register the `tuiSettingsSections` `fallbacks` section —
  // the `/settings` editable form with full web-card parity. Same
  // conditional inject child + `serviceOwned` gate (optimistic claim, see
  // above) as the command-tree client; absent service = clean no-op, and an
  // in-claim-window duplicate degrades via the installer's own `already
  // registered` catch. Registered here, right after installTuiClient and
  // before the tail settings preset child (the tail child must stay
  // last-registered — see below).
  installTuiSettingsSection(ctx, { serviceOwned })

  // Bundled preset self-declaration (plan fallbacks-preset-roles T3, spec
  // §9.3 D9.3-a): a NEW conditional settings inject child, registered LAST
  // (after the writeRoles+provide child — the service's owner fiber — and
  // the document-updated binding child above), so by cordis' activation
  // order its fire sees the composed live source (the settings binding is
  // in place), a
  // live write channel, and the provide child's final `serviceOwned`
  // verdict (a deduped/failed fiber had its optimistic claim corrected to
  // false before this child fires) — reusing the writeRoles child would
  // materialize against the base-only entry and
  // clobber operator-declared role rows. apply() stays synchronous (D9.3-a):
  // the fire is fire-and-forget with a terminal catch — a failed write
  // never FAILEDs this fiber (cordis would treat a rejected thenable apply
  // return as a plugin load failure), never rethrows, and leaves no
  // unhandled rejection. The registry only commits on a successful write
  // (declare's compute → write → commit), so failure leaves badge/revert
  // unseeded (D9.3-b); retry happens on the next apply / child
  // re-activation — no in-process retry loop. `presets: 'none'` reads the
  // LIVE composed source at fire time and short-circuits before declare:
  // zero declarations, zero writes, zero registry change (D9.3-c; the
  // declaration is content-agnostic — no gate re-reads the removed
  // `enabled` switch and no `isFallbackActive` condition either). No per-apply
  // one-shot guard: declare is idempotent (no-delta zero write, D9.3-d),
  // so every child re-activation re-fires safely.
  ctx.inject(['settings'], () => {
    if (!serviceOwned) return
    if (seedsIo.read().presets === 'none') return
    // `{ bundled: true }` — the INTERNAL provenance marker (seed-source
    // provenance plan): the preset self-declare is the only declare labeled
    // `bundled`. The marker is module-internal to seeds.ts (never exported)
    // and deliberately absent from the `FallbacksService.declareSeeds` face,
    // which forwards only the public `{ set }` key — consumers can never
    // forge the reserved label.
    seeds.declare(presetRoles, seedsIo, { bundled: true }).catch((error) => {
      logger.error(
        'llm-fallbacks: seeds: preset role declaration failed — %s',
        (error as Error)?.message ?? String(error),
      )
    })
  })
}
