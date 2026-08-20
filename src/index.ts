/**
 * dsh-llm-fallbacks host half (plan Task 3: settings + waterfall + state
 * machine + events).
 *
 * Cordis function plugin mounted by the profile bundle patch row
 * `llm-fallbacks` (see `bundle/cordis.patch.yml`), composed AFTER llm-retry.
 *
 * Wiring:
 * - `fallbacks` settings namespace via {@link installSettingsSection}
 *   (composition entry as base; `scope.watch` → `onChange` re-reads the
 *   runtime and re-validates selectors — spec §4).
 * - `agent/request-error` waterfall: `!enabled` / code ∉ `triggerCodes`
 *   (**always mode included**) → `next()`; otherwise resolve role + chain,
 *   and when a candidate survives the filter (current / cooldown /
 *   step-failed / `provider/*`-missing-id) write the pending switch +
 *   cooldown + failure bookkeeping, then return
 *   `{ kind: 'retry' }` (own recovery, no `next()`).
 * - `agent/request` waterfall: apply a pending switch after `await next()`
 *   (provider/model override, inherited `reasoningEffort` dropped — the
 *   `installModelSelection` `withoutInheritedEffort` pattern); a
 *   root-origin `FallbacksChain/Auto` seed then overrides to the
 *   effective chain's first exact head (select-is-primary, plan
 *   fallbacks-virtual-chain Task 2); then the always-mode cap check (count
 *   `llm/retry` events for the current turn/step/provider; ≥
 *   `alwaysModeRetryCap` → same decision path, reason `always-cap` —
 *   ADR-2).
 * - Per-agent state (`FallbackStateStore`): `agent/disposed` removes it,
 *   `agent/status` idle prunes per-step state defensively, plugin dispose
 *   clears everything (spec §6 — no residual state).
 *
 * @module dsh-llm-fallbacks
 */

import { createRequire } from 'node:module'
import type { Context, Logger } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defaultFallbacksConfig, detectLegacyKeys, INHERIT_ROLE_ID, validateFallbacksConfig, type FallbacksConfig } from './config.ts'
import { Config } from './schema.ts'
import { pickRoleByLlm } from './automatch.ts'
import { annotateCandidates, createCandidateFilter, hasWildcardEntry, resolveChain, resolveChainViews, selectCandidates, type FailingModel } from './chains.ts'
import { parseSelector, selectorKey, type Selector } from './selectors.ts'
import { resolveRole } from './roles.ts'
import { firstExactCandidate, resolveRoleAtDispatch } from './role-resolution.ts'
import { FallbackStateStore, type AgentFallbackState, type PendingSwitch } from './state.ts'
import {
  isAllDayConforming,
  resolveEffectiveChain,
  resolveSlotState,
  type SlotRowConfig,
} from './time-slots.ts'
import type { FallbackSwitchReason } from './events.ts'
import {
  FALLBACKS_SETTINGS_NAMESPACE,
  FallbacksConfigGateway,
  fallbacksTypertContribution,
  type FallbacksSettingsBridge,
} from './gateway.ts'
import {
  RECENT_SWITCHES_LIMIT,
  recentFallbacksSwitches,
  registerFallbacksCommands,
  resolveChainForDiagnostic,
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
  type SeedsIo,
} from './seeds.ts'
import { presetRoles } from './presets.ts'
import { installTuiClient } from './tui.ts'
import { installTuiSettingsSection } from './tui-settings.ts'
import {
  FALLBACKS_CHAIN_MODEL,
  FALLBACKS_PROVIDER,
  firstDispatchableExactHead,
  installFallbacksAdapter,
} from './virtual-adapter.ts'

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
 * fallbacks-role-seeds T2). Deliberately no state BEARING FIELDS (no
 * stateStore, no event emitters, no filter helpers) — the seed methods are
 * closures over the per-apply `FallbacksSeedManager`, so state stays behind
 * the closure and dies with the fiber (spec §9.5).
 */
export interface FallbacksService {
  /** Matches the plugin `name`. */
  name: 'llm-fallbacks'
  /** Package.json version string (module-load snapshot). */
  version: string
  resolveRole: typeof resolveRole
  resolveChain: typeof resolveChain
  validateFallbacksConfig: typeof validateFallbacksConfig
  detectLegacyKeys: typeof detectLegacyKeys
  /** (a) Declare the companion's FULL current seed set (replacement semantics, spec §9.1). */
  declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome>
  /** (b) Sync readback — effective taxonomy with seed annotations. */
  getEffectiveRoles(): EffectiveRolesReadback
  /** (c) Revert one id to the CURRENT declared seed default. */
  revertSeededPersona(id: string): Promise<SeedRevertOutcome>
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
export type { AgentFallbackState, FallbackStateStore, PendingSwitch, StepFailures } from './state.ts'

// --- Library API re-exports (plan fallbacks-consumer-api T1) ---
// The full fallback-runtime surface — role resolution, chain resolution,
// config validation, selector parsing — re-exported from the package root so
// consumers can `import { resolveRole } from 'dsh-llm-fallbacks'`. Each block
// mirrors its submodule's export surface exactly; symbols also used
// internally by apply() keep their local imports (the re-export refers to
// the same binding — no duplicate definitions).
export {
  resolveRole,
  type AgentLike,
  type Origin,
} from './roles.ts'
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
  defaultFallbacksConfig,
  detectLegacyKeys,
  INHERIT_ROLE_ID,
  ROLE_ID_PATTERN,
  validateFallbacksConfig,
  type FallbacksConfig,
  type FallbacksConfigLogger,
  type FallbacksRole,
  type FallbacksRoles,
  type FallbacksRoleRule,
  type FallbackStrategy,
  type RevertPolicy,
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
  type SeedsIo,
  type SeedsWireStatus,
} from './seeds.ts'
// --- Bundled preset roles (plan fallbacks-preset-roles T3) ---
// The 7 omp-style bundled preset role declarations re-exported from the
// package root so library consumers can `import { presetRoles } from
// 'dsh-llm-fallbacks'` and `declareSeeds(presetRoles)` — the SAME data
// source apply()'s self-declaration fires (derivation: omp coding-agent
// agent prompts, snapshot 2026-08-16; frozen text = spec §9.2).
export { presetRoles } from './presets.ts'

/** Model-catalog service shape the wildcard existence probe reads (`ctx.llm`). */
interface ModelCatalogService {
  listModels(provider: string): Promise<readonly { id: string }[]>
}

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
 * The `provider/*`-entry existence probe (spec §2 clause 2): the target
 * provider's advertised catalog, fetched once per decision and cached per
 * provider. A missing/unknown provider or a failing catalog reads as "no such
 * model", so wildcard candidates to it are skipped; without an `llm` service
 * no filtering happens (`() => true`).
 *
 * simplify: catalog fetched per decision, never cached across decisions.
 * Decisions are failure-driven and rare; cache per provider in the plugin if
 * they ever become hot.
 */
async function makeModelExists(
  ctx: Context,
  providers: readonly string[],
): Promise<(provider: string, model: string) => boolean> {
  const llm = ctx.get('llm') as ModelCatalogService | undefined
  if (llm === undefined || typeof llm.listModels !== 'function') return () => true
  const catalog = new Map<string, Set<string>>()
  await Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider)
      catalog.set(provider, new Set(models.map((model) => model.id)))
    } catch {
      catalog.set(provider, new Set())
    }
  }))
  return (provider, model) => catalog.get(provider)?.has(model) ?? false
}

/**
 * Count durable `llm/retry` events for the current (turn, step, provider) in
 * **always mode** (ADR-2; spec §2 clause 5). Normal-mode retries belong to
 * llm-retry's bounded budget and must not preempt the fallback, so only
 * `mode: 'always'` events count toward `alwaysModeRetryCap` (T3 review
 * Minor 2 — the real event carries the discriminator, llm-retry types.ts).
 *
 * Fast path (T3 review Minor 4): the session log is append-ordered, so the
 * scan runs backwards and stops at the first event older than the target
 * (turn, step) — a long session's earlier turns are never scanned.
 *
 * Exported for direct unit testing of the counting + fast path.
 */
export function countRetryEvents(session: Session, turn: number, step: number, provider: string): number {
  let count = 0
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    const data = event.data as { turn?: number; step?: number }
    // Everything before the first event older than the target cannot match.
    if (
      typeof data.turn === 'number'
      && typeof data.step === 'number'
      && (data.turn < turn || (data.turn === turn && data.step < step))
    ) break
    if (event.type !== 'llm/retry') continue
    if (data.turn === turn && data.step === step && event.data.provider === provider && event.data.mode === 'always') {
      count += 1
    }
  }
  return count
}

/** The model the failed/current request was routed to. */
function currentModel(agent: Agent, provider: string): FailingModel {
  const header = agent.session.requestHeader()
  return { provider, model: header?.config.model ?? agent.options.model ?? '' }
}

/**
 * Stable identity of a slot winner for the 分时切换 marker (P7): preset
 * rows key by their frozen id, custom rows by their window — a chain-only
 * edit keeps the SAME logical row (no spurious rotation log), while a
 * window/preset change or a new matching row reads as a switch. `'all-day'`
 * is the no-extra-row winner.
 */
function slotWinnerKey(winner: SlotRowConfig | 'all-day'): string {
  if (winner === 'all-day') return 'all-day'
  return winner.kind === 'preset'
    ? `preset:${winner.preset}`
    : `custom:${winner.start}-${winner.end}`
}

/**
 * Override a request config with a pending switch: provider/model replaced,
 * inherited `reasoningEffort` dropped (the `installModelSelection`
 * `withoutInheritedEffort` pattern).
 */
function overrideConfig(seed: LlmCallConfig, to: { provider: string; model: string }): LlmCallConfig {
  const { reasoningEffort: _inherited, ...withoutInheritedEffort } = seed
  return { ...withoutInheritedEffort, provider: to.provider, model: to.model }
}

export function apply(ctx: Context, config: FallbacksConfig = defaultFallbacksConfig): void {
  const logger = ctx.logger('llm-fallbacks')
  // Cordis resolves the entry through the schema before apply, so `config` is
  // already defaulted; re-resolving keeps direct calls (tests) normalized.
  const entry = Config(config)
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
  ctx.inject(['settings'], (sctx) => {
    writeRoles = (roles) => sctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { roles })
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
  // The named service surface (responsive capability probe for consumers like
  // mstar-harness): VALUE-form registration — cordis 4 `ReflectService.provide`
  // stores the value directly, so a factory shape would register the function
  // itself as the service. The object references the SAME re-exported
  // functions (single point of truth, no copied logic). Registration is
  // fiber-scoped via `ctx.fiber.effect` — the fiber unload on plugin dispose
  // auto-unregisters it, so the returned disposer is ignored here.
  // Multi-fiber dedupe (W-1): a later fiber applying over a shared context
  // root hits cordis' loud duplicate-key failure (`service "llm-fallbacks"
  // has been registered at <…>`), which would abort apply() BEFORE the
  // dedupe-guarded gateway/typert registrations below. Mirror advisor's
  // multi-fiber dedupe: the catch lets the FIRST fiber own the service while
  // later fibers degrade gracefully (no service on that fiber).
  // Preset self-declaration ownership (plan fallbacks-preset-roles T3, spec
  // §9.3 D9.3-a W-1): `serviceOwned` records which fiber successfully
  // registered the service — only that fiber's tail settings child fires
  // the bundled preset declare; a deduped later fiber must not re-fire (no
  // duplicate conflict warns, no duplicate writes).
  let serviceOwned = false
  try {
    ctx.provide('llm-fallbacks', {
      name: 'llm-fallbacks',
      version,
      resolveRole,
      resolveChain,
      validateFallbacksConfig,
      detectLegacyKeys,
      // (a)(b)(c) — plan fallbacks-role-seeds T2: additive seed surface. Each
      // method delegates to the per-apply manager through the io seam
      // (single point of truth — no copied logic).
      declareSeeds: (declarations: readonly SeedDeclaration[]) => seeds.declare(declarations, seedsIo),
      getEffectiveRoles: () => seeds.effectiveRoles(seedsIo),
      revertSeededPersona: (id: string) => seeds.revert(id, seedsIo),
    })
    serviceOwned = true
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
    serviceOwned = false
    ctx.logger('llm-fallbacks').debug('fallbacks service already registered — no service on this fiber (multi-fiber dedupe)')
  }
  let source: () => FallbacksConfig = () => entry
  // Virtual FallbacksChain/Auto adapter (plan fallbacks-virtual-chain
  // Task 1, P2; PR #62 feedback): ONE conditional `ctx.inject(['llm'])`
  // child — the picker row registers whenever `enabled` (conformance of
  // the all-day chain is NOT part of registration: a legacy multi-model or
  // empty rootChain still earns the row; the override below and the
  // adapter's delegate still refuse a non-conforming all-day), and hides
  // on disable. The returned reconcile thunk is wired into the settings
  // onChange below: transition-reconcile over COMMITTED composed
  // snapshots only (card drafts are client-side until gateway save), so
  // the catalog never flickers; the condition deliberately ignores
  // timeSlots and conformance, so slot-row / chain edits never churn
  // registration.
  // `() => source()` — the mutable binding, not the initial thunk: the
  // settings section's setSource swaps `source` for the composed scope, and
  // reconcile must read the LIVE composed snapshot (same pattern as the
  // settings bridge below).
  const reconcileFallbacksAdapter = installFallbacksAdapter(ctx, () => source())
  // AC-4: warn-not-crash startup validation — the schema-resolved entry is
  // checked once (invalid ids / undeclared rule references / illegal
  // selectors / bad fallback enum); each violation warns and "does not take
  // effect", the config stays usable (spec §4).
  validateFallbacksConfig(entry, logger)
  // US-4: two-block-era leftovers in the live source (schemastery retains
  // unknown keys, verified plan Task 1 Step 1) → one startup warn pointing
  // at the migration table; the gateway separately reports the same keys as
  // get().legacyKeys for the UI banner. warn-only — never auto-migrates.
  const legacyKeys = detectLegacyKeys(source() as unknown as Record<string, unknown>)
  if (legacyKeys.length > 0) {
    logger.warn('llm-fallbacks: legacy config keys detected (chains/roles.default/undeclared role refs); see docs/configuration.md migration table — %o', legacyKeys)
  }
  // Declared role ids rules resolve against (spec §7.1): trimmed id → the
  // DECLARED RAW id, so a padded YAML id (' coder ') and a trimmed rule
  // reference ('coder') resolve to the same role (client-canonical trim
  // alignment, qc2 F-001 — validateFallbacksConfig trims both sides, and
  // resolveRole returns the raw declared id so roleDef lookups match the
  // stored roles.list entry exactly). The built-in 'inherit' is always
  // legal and never listed. Re-derived on every settings change (onChange
  // below) — both roleIds and hasChains follow source().
  let roleIds = new Map(entry.roles.list.map((role) => [role.id.trim(), role.id] as const))
  // F-001: an unconfigured install (no chains anywhere) must be truly
  // zero-cost — the always-cap session scan is short-circuited on this flag,
  // so a plain request never touches the event log when no chains are
  // configured (AC-8). New-shape probe: candidates exist only via rootChain
  // entries or a declared role's own chain (T1 review Minor 2 rewire).
  let hasChains = entry.rootChain.length > 0 || entry.roles.list.some((role) => (role.chain?.length ?? 0) > 0)

  // Guide §7 (plan llm-fallbacks-settings-gateway): the setSource hook is
  // wired into the FallbacksSettingsBridge the gateway consumes — the SAME
  // live source the runtime reads (schema defaults → plugin-row base →
  // settings user layer). The existing onChange re-derives roleIds/hasChains
  // from that live source (new config shape — no chain map anymore).
  // No settings-exposure opt-in here: upstream dsh has no such
  // registration-level option (it existed only via a local patch, now
  // removed) — web clients reach the config through the gateway channel
  // instead. The gateway reads `source()` live per call, so the bridge
  // carries no change fan-out (dead machinery removed in the QC fix wave —
  // nothing ever subscribed).
  installSettingsSection(ctx, FALLBACKS_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (current) => {
      source = current
    },
    onChange: () => {
      // A settings update can change roles.list / rootChain — roleIds and
      // hasChains re-derive from the same live source the runtime reads.
      // Validation (validateFallbacksConfig / detectLegacyKeys) is
      // intentionally STARTUP-ONLY: a live settings merge is already
      // schema-validated by the settings layer, and the defensive runtime
      // (resolveRole / resolveChainViews / roleDef lookups) tolerates bad
      // values with warn-not-crash semantics (qc1 F-006).
      const current = source()
      roleIds = new Map(current.roles.list.map((role) => [role.id.trim(), role.id] as const))
      hasChains = current.rootChain.length > 0 || current.roles.list.some((role) => (role.chain?.length ?? 0) > 0)
      // Virtual adapter registration reconcile (P2): enabled / all-day
      // conformance transitions only — idempotent, slot edits no-op.
      reconcileFallbacksAdapter()
      // P7: a settings edit is a config change, not a wall-clock rotation —
      // re-baseline the 分时切换 markers so the next root request starts
      // from the new config instead of logging a spurious switch.
      slotWinners.clear()
    },
  })
  const bridge: FallbacksSettingsBridge = {
    source: (): FallbacksConfig => source(),
  }
  // T1 (plan llm-fallbacks-settings-gateway): the host-side `fallbacks` config
  // gateway — the `/api/fallbacks/get` + `/api/fallbacks/set` +
  // `/api/fallbacks/reset` endpoints. It reads the SAME bridge the runtime
  // reads, so get/set/reset always operate on the live composed config.
  // Mirror advisor's multi-fiber dedupe: the cordis Service registration
  // fails loud on a duplicate key, so the catch lets the first fiber own the
  // `fallbacks` service key while later fibers fall back (no gateway) — the
  // typertGateway claim set dedupes, so claims never conflict.
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
  // Dispatch-injection once-marker (plan fallbacks-role-automatch Task 4):
  // agent ids whose FIRST request has already been evaluated for dispatch-time
  // role injection. Survives across the agent's request lifecycle; cleaned on
  // agent/disposed + plugin dispose (mirrors `states`).
  const dispatchInjected = new Set<string>()
  // P7 分时切换 marker (plan fallbacks-timeslots Task 2): per-root-agent
  // LAST slot winner (identity key + display label), in-process only. A
  // winner change between root requests logs 分时切换 — a routing seed, NOT
  // a failure decision: no cooldown, no switch count, no pending switch, no
  // durable event. Cleaned on agent/disposed + plugin dispose (mirrors
  // `dispatchInjected`) and re-baselined on settings change (a config edit
  // is not a wall-clock rotation).
  const slotWinners = new Map<string, { key: string; label: string }>()

  /**
   * Shared decision path (spec §5.1 lifecycle step 1): resolve the agent's
   * role and chain, filter candidates (same-model / cooldown / step-failed /
   * `provider/*`-missing-id), enforce the per-step safety valve, and — on a
   * hit — return the pending switch for the caller to commit.
   *
   * `state` is the agent's peeked entry: `undefined` for agents with no state
   * yet (F-004 — the store is only grown on a real switch intent, inside
   * `commit`). With no state there is no step bookkeeping, so the valve check
   * passes and cooldown/step-failed reads are false.
   */
  async function decide(
    agent: Agent,
    turn: number,
    step: number,
    current: FailingModel,
    reason: FallbackSwitchReason,
    state: AgentFallbackState | undefined,
  ): Promise<PendingSwitch | null> {
    const config = source()
    if (state !== undefined) {
      states.syncStep(state, turn, step)
      if (state.stepFailures.switchCount >= config.maxSwitchesPerStep) return null
    }
    const role = resolveRole(agent, config.roles.rules, roleIds, logger.warn)
    // P7 (plan fallbacks-timeslots Task 2): slot rotation applies to
    // ROOT-origin agents only, in BOTH primary and fallback-only modes —
    // the effective chain (first matching extra row, else the all-day
    // `rootChain`) replaces the raw `rootChain` as the root role's
    // resolveChainViews tail. Subagent walks are UNCHANGED (raw rootChain
    // append). P6 (qc1 F-001 — the gate lives in `resolveSlotState`, the
    // single source every slot surface reads): without a conforming all-day
    // the effective chain IS the raw rootChain — slot rows stay inert and
    // the v0.2.2 walk over the raw rootChain runs verbatim (mirror the
    // virtual adapter registration gate).
    const rootTail = agent.session?.header?.origin === 'subagent'
      ? config.rootChain
      : resolveEffectiveChain(config, new Date(), config.tz ?? 'Asia/Shanghai')
    // T1 review Important #2: resolveChainViews walks the concatenated
    // candidates ONCE — `all` (early-exit / annotation view) and the
    // wildcard provenance come from the same pass, and `surviving` is the
    // same list filtered in place via selectCandidates — so an unknown role
    // warns at most once per decision (previously resolveChain ran twice:
    // all + surviving). Defensive warns flow through the plugin logger
    // (qc2 F-002 — not console).
    const { all, wildcard } = resolveChainViews(config.roles.list, rootTail, role, current.provider, current.model, logger.warn)
    if (all.length === 0) return null
    // T2 review Important #1 (decision-path contract): the "missing id" skip
    // stays scoped to `provider/*` entries (spec §2 clause 2 — exact entries
    // are never existence-filtered; createCandidateFilter's own modelExists
    // would over-filter them), so the probe is applied via selectCandidates
    // to wildcard-origin candidates only while the filter deliberately does
    // NOT receive modelExists. F-002: the probe is built only when a
    // wildcard entry is reachable on the role's concatenated candidates —
    // pure exact chains take zero catalog probes.
    // The wildcard probe walks the SAME tail the candidates come from
    // (`rootTail` — P7: the slot-effective chain for root-origin agents), so
    // it never diverges from the resolution (qc2 F-003): a wildcard that
    // only the winning slot row reaches still gets the existence filter, and
    // pure exact chains stay zero-probe (F-002).
    const modelExists = hasWildcardEntry(config.roles.list, rootTail, role)
      ? await makeModelExists(
        ctx,
        [...new Set(all.map((candidate) => candidate.provider))],
      )
      : undefined
    const cooldown = {
      isSuppressed: (key: string) => state !== undefined && states.isSuppressed(state, key),
    }
    const failed = {
      has: (key: string) => state !== undefined && state.stepFailures.failed.has(key),
    }
    const filter = createCandidateFilter({ current, cooldown, failed })
    const surviving = selectCandidates(all, wildcard, filter, modelExists)
    const target = surviving[0]
    if (target === undefined || target.model === undefined) return null
    logger.info(
      // Copy split (spec § Copy): the failure walk is 降级切换 / fallback
      // switch — never 分时 (that copy belongs to the slot-rotation log in
      // agent/request). The keep-模型已降级 conversation notice is untouched
      // (failure path only).
      'llm-fallbacks: agent "%s" fallback switch (降级切换) %s/%s -> %s/%s (role=%s, reason=%s, candidates=%o)',
      agent.id,
      current.provider,
      current.model,
      target.provider,
      target.model,
      role,
      reason,
      // spec §2 行为可见性: the log shows the candidate attempt order AND why
      // each candidate was skipped (cooldown / step-failed / same-as-current /
      // target-provider missing id); survivors (including the target) are
      // unlabelled.
      annotateCandidates(all, surviving, { current, cooldown, failed })
        .map(({ candidate, skip }) => skip === undefined
          ? `${candidate.provider}/${candidate.model}`
          : `${candidate.provider}/${candidate.model} (skipped: ${skip})`),
    )
    return {
      from: { provider: current.provider, model: current.model },
      to: { provider: target.provider, model: target.model },
      role,
      reason,
    }
  }

  /** Commit a decision: pending switch + cooldown + failure bookkeeping (spec §5.1 step 1). */
  function commit(state: AgentFallbackState, pending: PendingSwitch, turn: number, step: number): void {
    const config = source()
    const fromKey = selectorKey(pending.from.provider, pending.from.model)
    const until = config.revertPolicy === 'never' ? Number.POSITIVE_INFINITY : Date.now() + config.cooldownMs
    // F-004 follow-up: a state freshly created by `states.get` at the commit
    // site carries no (turn, step) markers — sync them here so the next
    // decision's valve/failed-set bookkeeping sees this committed step (a
    // no-op for states `decide` already synced at the same (turn, step)).
    states.syncStep(state, turn, step)
    states.writePending(state, pending)
    states.suppress(state, fromKey, until)
    states.recordFailure(state, fromKey)
    states.recordSwitch(state)
    // issue #52: no durable `fallbacks/switch` session event is written — the
    // registration seam was proven ineffective at runtime (the plugin's
    // `@deepseek-ai/dsh-session` is a different module instance than the host's,
    // so the catalog `.add()` never reached the persistence read path), so a
    // session containing the event refused to load after a dsh restart. The
    // switch decision is still recorded by the decide() info log; only the
    // durable event is dropped (never poison a session log).
  }

  ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure },
    next,
  ) => {
    const config = source()
    // Always mode delegates downstream first (llm-retry), so non-trigger
    // failures must pass through here too — the cap lives at agent/request
    // (ADR-2). Only trigger codes enter the decision path.
    if (!config.enabled || !config.triggerCodes.includes(failure.code)) return next()
    const current = currentModel(agent, provider)
    if (!current.model) return next()
    // F-005: the decision path is defensive — an unexpected throw (e.g. a
    // future refactor) must not replace the original failure semantics
    // (spec §6); log and delegate instead.
    try {
      // F-004: peek, never create — a null decision must not grow the store.
      const state = states.peek(agent.id)
      const pending = await decide(agent, turn, step, current, 'trigger-code', state)
      if (pending === null) return next()
      commit(states.get(agent.id), pending, turn, step)
      return { kind: 'retry' }
    } catch (error) {
      logger.warn(
        'llm-fallbacks: decision path failed, passing the original failure through: %s',
        (error as Error)?.message ?? String(error),
      )
      return next()
    }
  })

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const seed = await next()
    // No-op purity (T3 review Minor 3): peek, never create — a plain request
    // must not grow the per-agent map (AC-8). State is created lazily only
    // when a real switch intent exists (a pending decision to apply, or the
    // always-cap tripped below).
    const state = states.peek(agent.id)
    // Apply a pending decision first (trigger-code path); a switch for this
    // request means the always-cap count of the previous provider is moot.
    const applied = state === undefined ? undefined : states.applyPending(state, turn, step)
    // The override creates a NEW spread config object (never the deep-frozen
    // Host-native semantics (the marker coordination shipped with
    // the local dsh-agent patch is removed — see
    // .mstar/iterations/iter-20260811-fallbacks-mount-only/guides/
    // role-and-model-selection-exploration.md): whether this step's routing
    // survives a manual web model selection depends on waterfall listener
    // order. When this plugin's listener is outer (registered first, the
    // default web-profile composition) the switch wins; when the
    // model-selection listener is outer (e.g. headless profile, or any agent
    // created before the plugin registered) the selection re-applies over
    // this step — the documented degradation. For a FallbacksChain seed the
    // same degradation stays graceful: the re-applied selection dispatches
    // to the virtual route, whose stream() is P1's thin delegate to the
    // effective head — no hard outage.
    if (applied !== undefined) {
      return overrideConfig(seed, applied.to)
    }
    const config = source()
    // P7 分时切换 detection (plan fallbacks-timeslots Task 2): ROOT-origin
    // requests only, in BOTH primary and fallback-only modes. `resolveSlotState`
    // reads the current slot winner; a winner different from this agent's last
    // seen winner (in-process `slotWinners` marker, cleaned on agent/disposed
    // and settings change) is a time-slot switch (分时切换) — a routing seed,
    // NOT a failure decision: info log only, exempt from cooldown and
    // `maxSwitchesPerStep`, no pending switch, no durable event. Never
    // force-switches an in-flight step — the rotation is observed here and
    // applies through the SAME resolver to the failure walk (decide) and the
    // FallbacksChain primary override below. Skipped entirely when no extra
    // slot rows exist (the winner would always be 'all-day'). P6 (qc1
    // F-001): gated on a conforming all-day like every other slot surface —
    // a legacy multi-model chain keeps the rows inert HERE too (the
    // resolver already reports 'all-day', but the explicit gate also keeps
    // the per-agent marker and the log untouched across a config change).
    if (
      config.enabled
      && isAllDayConforming(config.rootChain)
      && (config.timeSlots?.length ?? 0) > 0
      && agent.session?.header?.origin !== 'subagent'
    ) {
      const slot = resolveSlotState(config, new Date(), config.tz ?? 'Asia/Shanghai')
      const key = slotWinnerKey(slot.winner)
      const previous = slotWinners.get(agent.id)
      if (previous !== undefined && previous.key !== key) {
        logger.info(
          'llm-fallbacks: agent "%s" time-slot switch (分时切换): %s -> %s',
          agent.id,
          previous.label,
          slot.label,
        )
      }
      slotWinners.set(agent.id, { key, label: slot.label })
    }
    // Select-is-primary (plan fallbacks-virtual-chain Task 2, P3; PR #62
    // feedback): a ROOT-origin seed of the virtual `FallbacksChain/Auto`
    // row means "use the chain as the root primary" — override the seed to
    // the effective chain's FIRST DISPATCHABLE EXACT head (the shared
    // `firstDispatchableExactHead` the virtual adapter's delegate paths
    // also use — ONE skip/walk rule for override and delegate; the chain
    // comes from `resolveEffectiveChain`, the single source — no
    // rootChain[0] fallback branch here). Detection lives AFTER
    // pending-switch application: a failure decision already progressed
    // past the head and wins. Root-origin only (mirror the role-inject
    // gate — a subagent seed that still carries the virtual pair is NOT
    // overridden here; P1's thin stream() delegate handles those), plugin
    // `enabled`, a CONFORMING all-day rootChain (the row is visible for a
    // legacy/empty chain but the override refuses it — conformance still
    // required for a successful primary, PR #62 feedback), and the
    // effective chain must yield a dispatchable head — an empty /
    // wildcard-only / self-route chain warns once and skips.
    if (
      config.enabled
      && seed.provider === FALLBACKS_PROVIDER
      && seed.model === FALLBACKS_CHAIN_MODEL
      && agent.session?.header?.origin !== 'subagent'
    ) {
      if (!isAllDayConforming(config.rootChain)) {
        logger.warn(
          'llm-fallbacks: FallbacksChain/Auto selected but the all-day rootChain is not conforming (exactly one official V4 model) — no primary override',
        )
      } else {
        const effective = resolveEffectiveChain(config, new Date(), config.tz ?? 'Asia/Shanghai')
        const head = firstDispatchableExactHead(effective)
        if (head === undefined) {
          logger.warn(
            'llm-fallbacks: FallbacksChain/Auto selected but the effective chain has no exact head (empty, wildcard-only, or self-route) — no primary override',
          )
        } else {
          logger.info(
            'llm-fallbacks: FallbacksChain/Auto selection overrides to the effective head %s/%s',
            head.provider,
            head.model,
          )
          return overrideConfig(seed, head)
        }
      }
    }
    // Dispatch-time role injection (plan fallbacks-role-automatch Task 4): a
    // subagent-origin agent's FIRST request only (per-agent once-marker,
    // `dispatchInjected`, cleaned on agent/disposed + plugin dispose below).
    // Evaluated ONLY in this branch — a failure-path pending switch always
    // wins above. Resolve the role (explicit → rules → auto-match hook), then
    // inject the resolved role's chain head (first exact, non-wildcard
    // candidate — no cooldown/failed filtering, no existence probe, per the
    // Task 4 decision) when it differs from the request's current model. This
    // is NOT a failure decision: no commit(), no pending switch, no cooldown,
    // no failure bookkeeping — only the override + an explicit role → model
    // log. `'inherit'` ("no specific role") NEVER
    // injects, so with `roleAutoMatch: false` and no explicit/rules role the
    // outcome is identical to today. Defensive: any throw in the
    // resolution/injection path warns and the request proceeds unchanged
    // (mirror the `agent/request-error` defensive pattern).
    if (config.enabled && hasChains && agent.session?.header?.origin === 'subagent' && !dispatchInjected.has(agent.id)) {
      dispatchInjected.add(agent.id)
      try {
        const role = await resolveRoleAtDispatch(agent, config.roles.rules, roleIds, {
          automatchEnabled: config.roleAutoMatch ?? true,
          automatch: (agent) => pickRoleByLlm(ctx, config.roles, agent, { warn: logger.warn }),
          warn: logger.warn,
        })
        if (role !== INHERIT_ROLE_ID) {
          const { all, wildcard } = resolveChainViews(
            config.roles.list,
            config.rootChain,
            role,
            seed.provider,
            seed.model,
            logger.warn,
          )
          const head = firstExactCandidate(all, wildcard)
          if (head !== undefined && head.model !== undefined && !(head.provider === seed.provider && head.model === seed.model)) {
            const to = { provider: head.provider, model: head.model }
            // issue #52: no durable `fallbacks/switch` role-inject event is
            // written (same reason as commit() — the registration seam was
            // ineffective, and a session containing the event would refuse to
            // load after a dsh restart). The override still applies below and
            // the role→model info log still fires.
            logger.info(
              'llm-fallbacks: agent "%s" role-inject role=%s model=%s/%s',
              agent.id,
              role,
              head.provider,
              head.model,
            )
            return overrideConfig(seed, to)
          }
        }
      } catch (error) {
        logger.warn(
          'llm-fallbacks: dispatch role-injection failed, proceeding with the request unchanged: %s',
          (error as Error)?.message ?? String(error),
        )
      }
    }
    if (
      hasChains
      && config.enabled
      && config.alwaysModeRetryCap > 0
      && countRetryEvents(agent.session, turn, step, seed.provider) >= config.alwaysModeRetryCap
    ) {
      // Cap tripped: a genuine switch intent — but the state is still only
      // grown when the decision actually commits (F-004: a null decision —
      // e.g. all candidates filtered — leaves no entry behind).
      const decisionState = states.peek(agent.id)
      const pending = await decide(
        agent,
        turn,
        step,
        { provider: seed.provider, model: seed.model },
        'always-cap',
        decisionState,
      )
      if (pending !== null) {
        const commitState = states.get(agent.id)
        commit(commitState, pending, turn, step)
        const appliedCap = states.applyPending(commitState, turn, step)
        if (appliedCap !== undefined) {
          // Same host-native routing as the trigger-code path above.
          return overrideConfig(seed, appliedCap.to)
        }
      }
    }
    return seed
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const state = states.peek(agent.id)
    if (state !== undefined) states.clearStepState(state)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
    dispatchInjected.delete(agent.id)
    slotWinners.delete(agent.id)
  })

  ctx.effect(() => () => {
    states.clear()
    dispatchInjected.clear()
    slotWinners.clear()
  }, 'llm-fallbacks: clear per-agent state')

  // AC-5: /fallbacks — session-scoped read-only diagnostics. Conditional
  // inject child (commands must NOT join the top-level inject list —
  // advisor T1 fix): the child activates only when a command registry is
  // composed, so an absent commands service leaves the command silently
  // unavailable with no top-level error. The handler reads live state
  // through the SAME `source()` / `roleIds` / `states` the runtime uses and
  // never mutates fallback state (read-only; no cooldown reset, no pending
  // writes).
  const fallbacksCommandController: FallbacksCommandController = {
    getSnapshot(agent): FallbacksCommandSnapshot {
      const config = source()
      const role = resolveRole(agent, config.roles.rules, roleIds, logger.warn)
      const state = states.peek(agent.id)
      return {
        origin: agent.session.header?.origin ?? 'root',
        role,
        ...resolveChainForDiagnostic(config.roles.list, config.rootChain, role, logger.warn),
        // P7: current slot winner + label — the 分时 side of the status
        // strip; the switches section below is the 降级切换 side. Config
        // fact at `now` (a subagent session's chain display is unchanged).
        slot: resolveSlotState(config, new Date(), config.tz ?? 'Asia/Shanghai'),
        switches: recentFallbacksSwitches(agent.session.events, RECENT_SWITCHES_LIMIT),
        cooldown: state === undefined ? [] : state.cooldown.snapshot(),
      }
    },
    // T2 AC-2: composed-config readback — the SAME live `source()` the
    // runtime reads (schema defaults → plugin-row base → settings user
    // layer). Role summaries from `roles.list` (id + chain length, the
    // two-block model); `presets` is optional-on-type with a schema default,
    // so the summary falls back to 'bundled' explicitly; `roleAutoMatch`
    // reads defensively (`?? true`) for direct constructors that omit it.
    // T2 AC-4 (fallbacks-tui-settings): the readback is enriched with the
    // time-slot rows (preset rows carry `{ preset, chainCount }` — windows
    // are frozen PRESETS constants, never stored; custom rows carry
    // `{ start, end, chainCount }`), the config `tz`, and the role rules
    // (`provider`/`model` optional at the config model, summarized as `''`
    // → rendered `*` when omitted). Chain counts read defensively (`?? []`)
    // so a malformed legacy slot row never crashes the readback (the
    // resolver warns and skips it at request time).
    getConfig(): FallbacksConfigSummary {
      const config = source()
      return {
        enabled: config.enabled,
        triggerCodes: config.triggerCodes,
        rootChain: config.rootChain,
        timeSlots: (config.timeSlots ?? []).map((row) => row.kind === 'preset'
          ? { preset: row.preset, chainCount: (row.chain ?? []).length }
          : { start: row.start, end: row.end, days: row.days, chainCount: (row.chain ?? []).length }),
        tz: config.tz ?? 'Asia/Shanghai',
        roles: config.roles.list.map((role) => ({ id: role.id, chainCount: role.chain?.length ?? 0 })),
        rules: config.roles.rules.map((rule) => ({ provider: rule.provider ?? '', model: rule.model ?? '', role: rule.role })),
        cooldownMs: config.cooldownMs,
        revertPolicy: config.revertPolicy,
        maxSwitchesPerStep: config.maxSwitchesPerStep,
        alwaysModeRetryCap: config.alwaysModeRetryCap,
        presets: config.presets ?? 'bundled',
        roleAutoMatch: config.roleAutoMatch ?? true,
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
  // children — absent service = clean no-op. First-fiber-only via
  // `serviceOwned` (the host registry throws on duplicate roots, so a
  // deduped later fiber must never register). Registered here — after the
  // commands child, BEFORE the tail settings preset child — so the tail
  // child's last-registered activation order is preserved.
  installTuiClient(ctx, { serviceOwned })

  // dsh-tui settings write surface (plan fallbacks-tui-settings Task 1,
  // AC-1/AC-2): register the `tuiSettingsSections` `fallbacks` section —
  // the `/settings` editable form with full web-card parity. Same
  // conditional inject child + first-fiber-only `serviceOwned` gate as the
  // command-tree client; absent service = clean no-op. Registered here,
  // right after installTuiClient and before the tail settings preset child
  // (the tail child must stay last-registered — see below).
  installTuiSettingsSection(ctx, { serviceOwned })

  // Bundled preset self-declaration (plan fallbacks-preset-roles T3, spec
  // §9.3 D9.3-a): a NEW conditional settings inject child, registered LAST
  // (after the writeRoles child and installSettingsSection's internal
  // child), so by cordis' activation order its fire sees the composed live
  // source (setSource already ran) and a live write channel — reusing the
  // writeRoles child would materialize against the base-only entry and
  // clobber operator user-layer rows. apply() stays synchronous (D9.3-a):
  // the fire is fire-and-forget with a terminal catch — a failed write
  // never FAILEDs this fiber (cordis would treat a rejected thenable apply
  // return as a plugin load failure), never rethrows, and leaves no
  // unhandled rejection. The registry only commits on a successful write
  // (declare's compute → write → commit), so failure leaves badge/revert
  // unseeded (D9.3-b); retry happens on the next apply / child
  // re-activation — no in-process retry loop. `presets: 'none'` reads the
  // LIVE composed source at fire time and short-circuits before declare:
  // zero declarations, zero writes, zero registry change (D9.3-c; no
  // `enabled` gate — enabled:false still materializes). No per-apply
  // one-shot guard: declare is idempotent (no-delta zero write, D9.3-d),
  // so every child re-activation re-fires safely.
  ctx.inject(['settings'], () => {
    if (!serviceOwned) return
    if (seedsIo.read().presets === 'none') return
    seeds.declare(presetRoles, seedsIo).catch((error) => {
      logger.error(
        'llm-fallbacks: seeds: preset role declaration failed — %s',
        (error as Error)?.message ?? String(error),
      )
    })
  })
}
