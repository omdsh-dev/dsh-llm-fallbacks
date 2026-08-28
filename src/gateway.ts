/**
 * T1 (plan llm-fallbacks-settings-gateway) + T3 (plan fallbacks-role-seeds) —
 * host-side `fallbacks` config gateway: the `/api/fallbacks/get` +
 * `/api/fallbacks/set` + `/api/fallbacks/reset` + `/api/fallbacks/revert-seed`
 * endpoints.
 *
 * Transport: the typertGateway `/api` interceptor is the single host-wide RPC
 * slot (a plugin must NOT `connection.rpc.intercept('/api')` again — it would
 * throw). The service declares a typertGateway binding (via the
 * `TypertRemoteService` base — kept ONLY for its `typertRemote` binding, which
 * dispatch's `validateBinding` requires on the live service) and the
 * endpoints are registered EXPLICITLY through
 * `ctx.typert.register(fallbacksTypertContribution())` (see `apply` in
 * `src/index.ts`) — NOT via `@Remote` SRC markers: SRC discovery reads
 * `remoteMethods()`, a module-private WeakMap in `@deepseek-ai/dsh-typert-protocol`,
 * so a locally-linked plugin whose peers resolve outside the host
 * installation never shares that table with the host typertGateway (zero
 * claimed endpoints, `/api/fallbacks/*` 404). The explicit
 * `TypertRegistry.register` path writes the invocation descriptors into
 * `ctx.typert.local`, which `claimsEndpoint` checks FIRST, so claim +
 * dispatch work regardless of module identity. The payload contract is
 * exactly one plain-object `args` field whose keys are the method parameter
 * names (`get()` → `{ args: {} }`; `set(patch)` → `{ args: { patch } }`;
 * `reset()` → `{ args: {} }`).
 *
 * Data: `get` reads the `FallbacksSettingsBridge` source — the same live
 * composed config the runtime reads (schema defaults → plugin-row base →
 * settings user layer). There is NO hard-gate resolver (unlike advisor's
 * `resolveAdvisorConfig`): the fallbacks decision path runs at
 * `agent/request` time in `src/index.ts`, so the gateway returns the raw
 * composed config — `enabled` is a plain config field, not a gate output.
 * `set` validates the patch against the `Config` schema first (unknown-key
 * rejection unchanged — the settings service itself is non-strict and would
 * merge the unknown key through), then writes the USER layer in-process via
 * `ctx.settings.update` (no exposed-namespace gate on the in-process write —
 * the wire-level `exposedNamespaces()` check only guards the apiproxy path),
 * and returns the new composed value. `reset` (fallbacks-specific third
 * method — advisor has only get/set) clears the user layer via
 * `ctx.settings.replace(ns, {})`: `set` is merge-only and cannot express
 * "reset to composition defaults" (sending default VALUES as a patch would
 * pin stale defaults into the user layer). Every read response (get/set/reset)
 * carries the additive `seeds: SeedsWireStatus[]` badge state (spec §9.4) and
 * `revert-seed` exposes revert-to-current-seed-default for one id — both
 * delegate to the per-apply `FallbacksSeedManager` passed into the
 * constructor (single point of truth, no copied manager logic).
 *
 * The settings service is OPTIONAL (no settings service → the bridge source
 * stays the entry, `get` still works; `set`/`reset` fail with a clear
 * error — KD-G5 fallback). The gateway captures the service through a
 * conditional `ctx.inject(['settings'], ...)` child (the same activation
 * pattern as `installSettingsSection`), because `ctx.settings` is only
 * resolvable from a fiber that declares it.
 *
 * The returned config is normalized to the typertGateway JSON wire boundary:
 * only schema-declared keys cross the wire, and absent values are OMITTED,
 * never present-as-undefined (the gateway's result validation rejects
 * undefined values).
 *
 * @module dsh-llm-fallbacks/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { Config } from './schema'
import { detectLegacyKeys } from './config'
import type { FallbacksConfig } from './config'
import { PRESETS, isAllDayConforming } from './time-slots'
import type { FallbacksSeedManager, SeedRevertOutcome, SeedsIo, SeedsWireStatus } from './seeds'

/** The `fallbacks` settings namespace (registered when a settings service exists). */
export const FALLBACKS_SETTINGS_NAMESPACE = settingsNamespace('fallbacks')

/** One exact child LLM route on the additive `subagentPolicy` wire field (T5). */
export type SubagentPolicyRoute = { provider: string; model: string }

/**
 * Additive `/api/fallbacks/get` host-policy snapshot (spec D4 / T5).
 * Omitted when the policy is disabled/absent so older clients and the
 * 3-arg gateway constructor keep a byte-identical `{ config, legacyKeys,
 * seeds }` payload. Never written through `set`/`reset`.
 */
export type SubagentPolicyWire =
  | {
      state: 'enabled'
      allowedModels: SubagentPolicyRoute[]
      head?: { route: SubagentPolicyRoute; source: 'authorized' | 'injected' }
      blockedAttempt?: { at: number; route: SubagentPolicyRoute; reason: string }
    }
  | { state: 'disabled' }
  | { state: 'unprovable' }

/**
 * Live host-policy snapshot the gateway projects onto the wire. Built in
 * `apply()` from the SAME T1 reader the override paths use — no second
 * policy source. Optional: the 3-arg constructor (gateway unit tests)
 * omits the field entirely.
 */
export type SubagentPolicySnapshotFn = () => {
  policy:
    | { state: 'disabled' }
    | { state: 'enabled'; allowedModels: readonly SubagentPolicyRoute[] }
    | { state: 'unprovable' }
  head?: { route: SubagentPolicyRoute; source: 'authorized' | 'injected' }
  blockedAttempt?: { at: number; route: SubagentPolicyRoute; reason: string }
}


/**
 * The live configuration source for the gateway (guide §7 — the same bridge
 * shape the runtime reads through). `source()` returns the live composed
 * config (schema defaults → plugin-row base → settings user layer). The
 * gateway reads it LIVE on every call, so no change notification is needed
 * (the bridge stays minimal: source + the settings write channel; the dead
 * `onChange` fan-out was removed in the QC fix wave — nothing subscribed).
 */
export interface FallbacksSettingsBridge {
  source(): FallbacksConfig
}

/** Patch shape accepted by `fallbacks.set` — any subset of the config keys. */
export type FallbacksConfigPatch = Partial<FallbacksConfig>

/**
 * The wire response of every read (get/set/reset — W-1/F-1): the normalized
 * config plus `legacyKeys` plus the additive `seeds` badge state (spec §9.4,
 * legacyKeys precedent — old clients ignore it).
 */
export interface FallbacksReadResult {
  config: FallbacksConfig
  legacyKeys: string[]
  seeds: SeedsWireStatus[]
  /**
   * Host subagent-model-selection policy (spec D4). Additive — old readers
   * ignore it; omitted when disabled/absent or when no snapshot is wired.
   */
  subagentPolicy?: SubagentPolicyWire
}

/** The `fallbacks/revert-seed` response — a read result plus the revert outcome. */
export interface FallbacksRevertResult extends FallbacksReadResult {
  outcome: SeedRevertOutcome
}

/**
 * Complete configuration key lookup for strict unknown-key rejection. The
 * schemastery object resolver merges unknown keys by default, so the gateway
 * rejects them explicitly — same strictness as advisor and the Loader.
 */
const CONFIG_KEYS: Record<string, true> = {
  enabled: true,
  triggerCodes: true,
  rootChain: true,
  roles: true,
  cooldownMs: true,
  revertPolicy: true,
  maxSwitchesPerStep: true,
  alwaysModeRetryCap: true,
  presets: true,
  roleAutoMatch: true,
  // Plan fallbacks-timeslots (P5): time-slot rows + config-level tz. The
  // READ side carries them so `get` matches the composed config (schema
  // defaults); the WRITE side validates them — nested row-shape guards in
  // validateConfigPatch (the ROLES_KEYS pattern, Task 3).
  timeSlots: true,
  tz: true,
  // Plan fallbacks-half-open-recovery (P1): the single gateway surface for
  // the `recovery` key — readConfig whitelists it for `get` readback, and
  // set acceptance resolves it through validateConfigPatch's schema check
  // (no hand-written enum guard; scalars rely on schema resolve).
  recovery: true,
}

/** Declared nested keys of the `roles` patch — anything else is rejected (qc2 S-1). */
const ROLES_KEYS: Record<string, true> = {
  list: true,
  rules: true,
}

/** Declared nested keys of one `timeSlots` row — anything else is rejected
 * (plan fallbacks-timeslots Task 3, the `ROLES_KEYS` pattern; `name` is the
 * custom-row display name, PR #62 feedback round). */
const SLOT_ROW_KEYS: Record<string, true> = {
  kind: true,
  preset: true,
  start: true,
  end: true,
  days: true,
  name: true,
  chain: true,
}

/** Strict 24h `HH:mm` — the resolver's HHMM_RE twin (the reject-on-save
 * mirror of the resolver's warn-and-skip `describeRow`). */
const SLOT_HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * The host-side `fallbacks` config gateway (`/api/fallbacks/get` +
 * `/api/fallbacks/set` + `/api/fallbacks/reset`). Registered as the cordis
 * service key `'fallbacks'` (namespace defaults to the service key). The
 * `TypertRemoteService` base is kept ONLY for its `typertRemote` binding —
 * the typertGateway's dispatch `validateBinding` requires the visible binding
 * on the live service (a pure instance property, no module-private state).
 * Endpoints are registered EXPLICITLY through
 * `ctx.typert.register(fallbacksTypertContribution())` (see `apply` in
 * `src/index.ts`) instead of `@Remote` SRC markers (see the module docblock
 * for why).
 */
export class FallbacksConfigGateway extends TypertRemoteService {
  private readonly bridge: FallbacksSettingsBridge
  /** The per-apply seed manager — single point of truth for seed state (spec §9.4). */
  private readonly seeds: FallbacksSeedManager
  /** The live settings service once the optional inject child activates. */
  private settings: SettingsProvider | undefined
  /**
   * Optional host-policy snapshot (T5). When omitted the additive
   * `subagentPolicy` field is absent on every read — the 3-arg constructor
   * used by gateway unit tests stays byte-identical to the pre-T5 payload.
   */
  private readonly subagentPolicy: SubagentPolicySnapshotFn | undefined

  /**
   * @param ctx - owning context (the plugin fiber's ctx inside `apply`).
   * @param bridge - the same `FallbacksSettingsBridge` the runtime reads, so
   *   get/set/reset always operate on the live composed config.
   * @param seeds - the per-apply `FallbacksSeedManager` constructed in
   *   `apply()` — the gateway delegates badge state and revert to it (no
   *   copied manager logic), through the io seam built over this bridge.
   * @param subagentPolicy - live host-policy snapshot from `apply()`; omit
   *   to leave the additive field off the wire.
   */
  constructor(
    ctx: Context,
    bridge: FallbacksSettingsBridge,
    seeds: FallbacksSeedManager,
    subagentPolicy?: SubagentPolicySnapshotFn,
  ) {
    super(ctx, 'fallbacks')
    this.bridge = bridge
    this.seeds = seeds
    this.subagentPolicy = subagentPolicy
    // The settings service is optional (no settings → entry fallback). The
    // inject child activates only when a settings service is composed,
    // mirroring installSettingsSection's conditional child; the returned
    // disposer mirrors its detach path — when the settings service goes away,
    // the write channel is gone with it, and `set`/`reset` must fail cleanly
    // (KD-G5) instead of holding a stale service reference.
    ctx.inject(['settings'], (sctx) => {
      this.settings = sctx.settings
      return () => {
        this.settings = undefined
      }
    })
  }

  /**
   * Read the current composed config (schema defaults → entry base → settings
   * user layer). No hard-gate resolver (ADR-2): the raw composed config is
   * the wire value — `enabled` is a plain field, not a gate output.
   * @returns the wire-normalized composed config plus `legacyKeys` — legacy
   *   two-block-era fields (`chains` / `roles.default` / undeclared rule
   *   role refs) detected on the composed source (schemastery retains them,
   *   plan Task 1 Step 1), so the client can show a migration banner (spec
   *   §9, incremental field — old clients ignore it) — plus the additive
   *   `seeds` badge state (spec §9.4, legacyKeys precedent — old clients
   *   ignore it).
   */
  get(): FallbacksReadResult {
    return this.readResult()
  }

  /**
   * Validate a config patch and write it to the settings USER layer (live —
   * the runtime re-reads the same bridge source; no restart needed).
   * @param patch - any subset of the config keys; unknown keys (top-level
   *   and nested under `roles`) are rejected before anything is written.
   * @returns the NEW composed config plus `legacyKeys` detected on the
   *   POST-WRITE composed source (W-1/F-1): `set` is a settings MERGE, so a
   *   legacy user layer (`chains` / `roles.default`) survives a new-shape
   *   save — the response must keep reporting it, or the client banner
   *   would clear against server truth — plus the post-write `seeds` badge
   *   state (same W-1/F-1 rule as `legacyKeys`). Same shape as `get`.
   * @throws when the patch fails `Config` validation, or when no settings
   *   service is composed (KD-G5: the write channel is unavailable).
   */
  async set(patch: FallbacksConfigPatch): Promise<FallbacksReadResult> {
    // Unknown-key rejection + type validation. The settings service schema is
    // non-strict (unknown keys merge through), so the explicit reject happens
    // here, before the write — same strictness as the Loader.
    validateConfigPatch(patch)
    // S2: an empty patch is a no-op — return the current composed value
    // without a pointless settings round-trip.
    if (Object.keys(patch).length === 0) return this.readResult()
    const settings = this.settings
    if (settings === undefined) {
      throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
    }
    // Wire normalization: JSON cannot carry undefined, so a null-valued key
    // is a third-party client's way of saying "absent". Drop null values
    // before the write (an all-null patch is a no-op, like the empty patch).
    const normalized = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
    )
    if (Object.keys(normalized).length === 0) return this.readResult()
    await settings.update(FALLBACKS_SETTINGS_NAMESPACE, normalized)
    return this.readResult()
  }

  /**
   * Clear the fallbacks settings USER layer so the composition defaults
   * reapply (`settings.replace(ns, {})` — the in-process removal path a
   * merge-only `set` cannot express).
   * @returns the new composed config plus `legacyKeys` on the post-write
   *   source — `replace` drops the user layer, but legacy keys carried by
   *   the entry base survive and are correctly re-reported (W-1/F-1) — plus
   *   the post-write `seeds` badge state (clearing the user layer also
   *   clears the materialized seed rows, so the honest response reports the
   *   emptied state; the registry survives and the next declare re-materializes).
   * @throws when no settings service is composed (KD-G5: the write channel
   *   is unavailable).
   */
  async reset(): Promise<FallbacksReadResult> {
    const settings = this.settings
    if (settings === undefined) {
      throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
    }
    await settings.replace(FALLBACKS_SETTINGS_NAMESPACE, {})
    return this.readResult()
  }

  /**
   * Revert one seeded role to its CURRENT declared seed default (AC-3, spec
   * §9.4) — the gateway half of surface (c), delegating to the same manager
   * the service method uses (single point of truth). Business failures are
   * values, never throws: a non-seeded id or a deleted row returns
   * `{ reverted: false, reason }` without writing. The only throw is the
   * KD-G5 settings-unavailable path, and only when a write is actually
   * needed (an idempotent revert at the default needs no channel).
   * @param id - the seeded role id; matched by trimmed id against the
   *   registry (row matching, spec §9.3).
   * @returns the post-write read result (config / legacyKeys / seeds — the
   *   write happened before this read, W-1/F-1) plus the revert `outcome`.
   * @throws TypeError when `id` is not a string; Error when the settings
   *   write channel is unavailable (KD-G5).
   */
  async revertSeed(id: string): Promise<FallbacksRevertResult> {
    if (typeof id !== 'string') {
      throw new TypeError('dsh-llm-fallbacks: seed revert id must be a string')
    }
    const outcome = await this.seeds.revert(id, this.seedsIo())
    return { ...this.readResult(), outcome }
  }

  /**
   * Read the live composed config and normalize it to the typertGateway JSON
   * wire boundary. Containment (guide §10): a malformed stored user layer
   * that the non-strict settings schema let through (e.g. an unknown key)
   * must never fail the RPC — only schema-declared keys cross the wire, and
   * absent values are omitted, never present-as-undefined (the result
   * validator rejects undefined values). The `roles` object is additionally
   * normalized to its declared `list`/`rules` fields: legacy nested keys
   * (e.g. `roles.default`) that schemastery retains on the composed source
   * never leak past the wire boundary (reviewer finding T1 Important #1 —
   * a consumer like Task 2's parseFallbacksConfig would misread them),
   * even though `legacyKeys` still reports them.
   */
  private readConfig(source: FallbacksConfig = this.bridge.source()): FallbacksConfig {
    const wire: Record<string, unknown> = {}
    for (const key of Object.keys(CONFIG_KEYS)) {
      const value = (source as unknown as Record<string, unknown>)[key]
      if (value === undefined) continue
      wire[key] = key === 'roles' ? normalizeRoles(value) : value
    }
    return wire as unknown as FallbacksConfig
  }

  /**
   * The wire response of every read (get/set/reset — W-1/F-1): the
   * normalized config plus `legacyKeys` detected on the live composed
   * source plus the additive `seeds` badge state. set/reset must report the
   * POST-WRITE source: the settings merge retains legacy user-layer keys,
   * so a save cannot clear them — the honest response keeps the migration
   * banner until a get agrees; `seeds` follows the same rule (post-write
   * badge state, W-1/F-1).
   */
  private readResult(): FallbacksReadResult {
    const source = this.bridge.source()
    const result: FallbacksReadResult = {
      config: this.readConfig(source),
      legacyKeys: detectLegacyKeys(source as unknown as Record<string, unknown>),
      seeds: this.seeds.wireStatus(this.seedsIo()),
    }
    const projected = projectSubagentPolicy(this.subagentPolicy)
    if (projected !== undefined) result.subagentPolicy = projected
    return result
  }

  /**
   * The io seam the seed manager writes through (spec §9.1): `read` walks
   * the same live bridge source the gateway reads; `writeRoles` persists a
   * full `{ list, rules }` to the settings user layer — both arrays always
   * computed from a fresh composed read, so the write stays correct under
   * dsh-settings `mergeLayers` array-replace semantics and never touches
   * operator rules. The write channel fails with the same KD-G5 message as
   * set/reset when no settings service is composed. Built fresh per call so
   * the mutable settings capture is read at call time (the inject child
   * swaps it when the settings service appears/disappears).
   */
  private seedsIo(): SeedsIo {
    const settings = this.settings
    return {
      read: () => this.bridge.source(),
      writeRoles: (roles) => {
        if (settings === undefined) {
          throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
        }
        return settings.update(FALLBACKS_SETTINGS_NAMESPACE, { roles })
      },
    }
  }
}

/**
 * Project the live host-policy snapshot onto the additive wire field.
 * Disabled/absent (or an unwired snapshot) omits the field; `unprovable`
 * and `enabled` always ride. Never throws: a throwing snapshot fails
 * closed to `{ state: 'unprovable' }` (same outcome as an unreadable
 * runtime policy — the card must not 500 the settings page).
 */
function projectSubagentPolicy(
  snapshot: SubagentPolicySnapshotFn | undefined,
): SubagentPolicyWire | undefined {
  if (snapshot === undefined) return undefined
  let captured: ReturnType<SubagentPolicySnapshotFn>
  try {
    captured = snapshot()
  } catch {
    return { state: 'unprovable' }
  }
  const { policy, head, blockedAttempt } = captured
  if (policy.state === 'disabled') return undefined
  if (policy.state === 'unprovable') return { state: 'unprovable' }
  const wire: SubagentPolicyWire = {
    state: 'enabled',
    allowedModels: policy.allowedModels.map((route) => ({
      provider: route.provider,
      model: route.model,
    })),
  }
  if (head !== undefined) {
    wire.head = {
      route: { provider: head.route.provider, model: head.route.model },
      source: head.source,
    }
  }
  if (blockedAttempt !== undefined) {
    wire.blockedAttempt = {
      at: blockedAttempt.at,
      route: { provider: blockedAttempt.route.provider, model: blockedAttempt.route.model },
      reason: blockedAttempt.reason,
    }
  }
  return wire
}

/**
 * Keep only the declared `roles` fields (`list` + `rules`) for the wire.
 * Legacy nested keys (e.g. `roles.default` from the two-block era) are
 * retained on the composed source by schemastery and reported via
 * `legacyKeys`, but must never ride the wire (reviewer finding T1 Important
 * #1). Non-object values pass through untouched — readConfig only filters
 * schema-declared keys, and absent fields stay omitted per the wire boundary
 * rule above.
 */
function normalizeRoles(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const roles: Record<string, unknown> = {}
  for (const field of ['list', 'rules']) {
    const member = (value as Record<string, unknown>)[field]
    if (member !== undefined) roles[field] = member
  }
  return roles
}

/**
 * Reject a patch the `Config` schema cannot express: non-object input, unknown
 * top-level keys (schemastery merges them silently — the settings service
 * would accept them), and schema type violations — plus the Task 3 semantic
 * guards the permissive schema deliberately does not carry: nested `roles`
 * keys, `timeSlots` row shapes (unknown preset ids, duplicate presets, preset
 * rows carrying windows, non-`HH:mm` custom bounds, out-of-range days, empty
 * chains), and the all-day `rootChain` head conformance.
 *
 * Exported (plan fallbacks-tui-settings Task 1): the TUI settings section's
 * JSON-field `parse` mirrors the gateway save rules through this single
 * validator (it internally routes `timeSlots` → {@link validateTimeSlotsPatch}),
 * so an invalid draft blocks the TUI save exactly like a rejected gateway
 * patch. No shared-module extraction — the two-keyword diff is the minimal
 * change.
 */
export function validateConfigPatch(patch: unknown): void {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('dsh-llm-fallbacks: configuration patch must be a plain object')
  }
  for (const key of Object.keys(patch)) {
    // Own-key membership, never `in` — `in` walks the prototype chain, so a
    // patch with an own `__proto__`/`constructor`/`toString` key would pass
    // the guard (F-001, qc wave): an own `__proto__` key in particular can
    // corrupt the settings merge and wipe the user layer. Same strictness as
    // advisor's `CONFIG_KEYS.has(key)` on a Set.
    if (!Object.hasOwn(CONFIG_KEYS, key)) {
      throw new Error(`dsh-llm-fallbacks: unknown config key "${key}"`)
    }
    // qc2 S-1: the `roles` object is itself a patch boundary — schemastery
    // retains unknown NESTED keys too, so a `roles.default` (or any other
    // two-block-era leftover) would be persisted by the settings merge and
    // re-arm the legacy banner. Reject non-declared nested keys here, the
    // mirror of the top-level guard.
    if (key === 'roles') {
      const roles = (patch as Record<string, unknown>)[key]
      if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) {
        for (const nestedKey of Object.keys(roles)) {
          if (!Object.hasOwn(ROLES_KEYS, nestedKey)) {
            throw new Error(`dsh-llm-fallbacks: unknown config key "roles.${nestedKey}"`)
          }
        }
      }
    }
    // Plan fallbacks-timeslots Task 3: the READ side carries the keys (Task
    // 1), the WRITE side validates them — nested row-shape guards mirroring
    // the `roles` boundary above. The schema keeps the row shape permissive
    // on purpose (malformed rows warn at load, P6 warn-not-crash); the
    // reject-on-save rules live here, the mirror of the resolver's
    // warn-and-skip `describeRow`.
    if (key === 'timeSlots') {
      const rows = (patch as Record<string, unknown>)[key]
      if (rows !== null && rows !== undefined) {
        validateTimeSlotsPatch(rows)
      }
    }
    // All-day tail gate: `rootChain` must END with exactly one official
    // V4 model — Flash XOR Pro (the card's 默认模型 panel); leading
    // entries (默认降级链) are the ordered walk before that last-resort
    // fallback. Empty / non-official tail rejected on save.
    if (key === 'rootChain') {
      const chain = (patch as Record<string, unknown>)[key]
      if (chain !== null && chain !== undefined && (!Array.isArray(chain) || !isAllDayConforming(chain))) {
        throw new Error(
          'dsh-llm-fallbacks: rootChain must end with exactly one official V4 model (deepseek-official/deepseek-v4-flash or deepseek-official/deepseek-v4-pro)',
        )
      }
    }
  }
  // Type/bounds validation (schemastery fills defaults for absent keys; null
  // is treated as missing by defaulted fields, so it validates and is dropped
  // by the caller's wire normalization).
  Config(patch as unknown as FallbacksConfig)
}

/**
 * Reject a `timeSlots` patch value the config model cannot express
 * (plan fallbacks-timeslots Task 3 — the `ROLES_KEYS` pattern applied to
 * slot rows): unknown nested keys, non-object rows, unknown preset ids,
 * duplicate preset rows, preset rows carrying their own windows/day masks
 * (windows are frozen code constants, P4), custom rows without strict
 * `HH:mm` bounds or out-of-range day entries, and empty chains. Every rule
 * here is the reject-on-save mirror of the resolver's warn-and-skip
 * `describeRow` (load stays warn-not-crash, P6).
 */
function validateTimeSlotsPatch(rows: unknown): void {
  if (!Array.isArray(rows)) {
    throw new Error('dsh-llm-fallbacks: timeSlots must be an array of slot rows')
  }
  const seenPresets = new Set<string>()
  rows.forEach((row, index) => {
    const at = `timeSlots[${index}]`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`dsh-llm-fallbacks: ${at} must be a plain object`)
    }
    const record = row as Record<string, unknown>
    for (const nestedKey of Object.keys(record)) {
      if (!Object.hasOwn(SLOT_ROW_KEYS, nestedKey)) {
        throw new Error(`dsh-llm-fallbacks: unknown config key "${at}.${nestedKey}"`)
      }
    }
    if (record.kind === 'preset') {
      const preset = record.preset
      if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) {
        throw new Error(
          `dsh-llm-fallbacks: ${at}.preset must be one of the four frozen preset ids (got ${JSON.stringify(preset)})`,
        )
      }
      if (seenPresets.has(preset)) {
        throw new Error(`dsh-llm-fallbacks: ${at} duplicates preset "${preset}" — at most one row per preset`)
      }
      seenPresets.add(preset)
      if (record.start !== undefined || record.end !== undefined || (Array.isArray(record.days) && record.days.length > 0)) {
        throw new Error(
          `dsh-llm-fallbacks: ${at} preset "${preset}" cannot carry start/end/days — preset windows are frozen code constants`,
        )
      }
      if (record.name !== undefined) {
        throw new Error(`dsh-llm-fallbacks: ${at} preset "${preset}" cannot carry a name — preset rows are named by the frozen label`)
      }
    } else if (record.kind === 'custom') {
      const { start, end } = record
      if (typeof start !== 'string' || typeof end !== 'string' || !SLOT_HHMM_RE.test(start) || !SLOT_HHMM_RE.test(end)) {
        throw new Error(
          `dsh-llm-fallbacks: ${at} custom row requires HH:mm start and end (got ${JSON.stringify(start)}-${JSON.stringify(end)})`,
        )
      }
      if (record.days !== undefined) {
        if (!Array.isArray(record.days) || record.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
          throw new Error(`dsh-llm-fallbacks: ${at}.days must be an array of integers 0–6`)
        }
      }
      if (record.name !== undefined && typeof record.name !== 'string') {
        throw new Error(`dsh-llm-fallbacks: ${at}.name must be a string`)
      }
    } else {
      throw new Error(`dsh-llm-fallbacks: ${at}.kind must be "preset" or "custom" (got ${JSON.stringify(record.kind)})`)
    }
    const chain = record.chain
    if (!Array.isArray(chain) || chain.length === 0 || chain.some(entry => typeof entry !== 'string')) {
      throw new Error(`dsh-llm-fallbacks: ${at}.chain must be a non-empty string array`)
    }
  })
}

/**
 * The explicit typert contribution for the `fallbacks` gateway endpoints —
 * registered via `ctx.typert.register(...)` (see `apply` in `src/index.ts`).
 * The descriptors mirror exactly what the former SRC discovery derived from
 * the `@Remote` markers (`src:<ns>#<endpoint>` identity shape, direct
 * receiver, JSON wire params with `src-json` codec), so the host
 * typertGateway claim + dispatch behavior is the same — the only difference
 * is the registration does not depend on the module-private `remoteMethods`
 * marker table, which a locally-linked plugin can never share with the host
 * installation (see the module docblock).
 */
export function fallbacksTypertContribution(): TypertContribution {
  return {
    package: 'dsh-llm-fallbacks',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: 'dsh-llm-fallbacks#fallbacks/get',
        service: 'fallbacks',
        namespace: 'fallbacks',
        method: 'get',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'src-json' },
      },
      {
        id: 'dsh-llm-fallbacks#fallbacks/set',
        service: 'fallbacks',
        namespace: 'fallbacks',
        method: 'set',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      {
        id: 'dsh-llm-fallbacks#fallbacks/reset',
        service: 'fallbacks',
        namespace: 'fallbacks',
        method: 'reset',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'src-json' },
      },
      {
        // The card revert endpoint (spec §9.4): the wire method is the
        // hyphenated endpoint name, `implementation` aliases the actual
        // service member `revertSeed` (the typertGateway dispatches through
        // `implementation ?? method`).
        id: 'dsh-llm-fallbacks#fallbacks/revert-seed',
        service: 'fallbacks',
        namespace: 'fallbacks',
        method: 'revert-seed',
        implementation: 'revertSeed',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'id', wire: 'id', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
    ],
  }
}
