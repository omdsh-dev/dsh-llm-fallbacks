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
 * profile patch). There is NO hard-gate resolver (unlike advisor's
 * `resolveAdvisorConfig`): the fallbacks decision path runs inside the
 * virtual route's chain walk (`src/chain-walk.ts`), so the gateway returns
 * the raw composed config. There is NO config-level `enabled` key on the contract
 * (plan fallbacks-web-ux-alignment T2): the Plugins-page row toggle is the
 * master switch, the runtime gates read content presence
 * (`isFallbackActive` in `src/config.ts`), and a stored `enabled:` line is
 * tolerated-and-stripped ({@link LEGACY_KEYS} — never read, never
 * re-persisted).
 * `set` validates the patch against the `Config` schema first (unknown-key
 * rejection unchanged — the settings service itself is non-strict and would
 * merge the unknown key through), then writes the plugin's profile-entry
 * section in-process via `ctx.settings.update` (the `SettingsForms` form
 * service; the host replaced the namespace registry — the write lands in
 * the active profile's patch under {@link FALLBACKS_PROFILE_ENTRY} and the
 * Loader commits it into the plugin's live config reference), and returns
 * the new composed value. `reset` (fallbacks-specific third method —
 * advisor has only get/set) clears the entry's patch section via
 * `ctx.settings.replace(ns, {})`: `set` is merge-only and cannot express
 * "reset to composition defaults" (sending default VALUES as a patch would
 * pin stale defaults into the patch). Every read response (get/set/reset)
 * carries the additive `seeds: SeedsWireStatus[]` badge state (spec §9.4) and
 * `revert-seed` exposes revert-to-current-seed-default for one id — both
 * delegate to the per-apply `FallbacksSeedManager` passed into the
 * constructor (single point of truth, no copied manager logic).
 *
 * The settings service is OPTIONAL (no settings service → the bridge source
 * stays the entry, `get` still works; `set`/`reset` fail with a clear
 * error — KD-G5 fallback). The gateway captures the service through a
 * conditional `ctx.inject(['settings'], ...)` child (the same activation
 * pattern as the plugin apply's own settings child), because `ctx.settings`
 * is only resolvable from a fiber that declares it.
 *
 * The returned config is normalized to the typertGateway JSON wire boundary:
 * only schema-declared keys cross the wire, and absent values are OMITTED,
 * never present-as-undefined (the gateway's result validation rejects
 * undefined values).
 *
 * @module dsh-llm-fallbacks/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import SettingsForms, { type SettingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { Config } from './schema'
import { detectLegacyKeys } from './config'
import type { FallbacksConfig } from './config'
import { PRESETS, isAllDayConforming } from './time-slots'
import { CHAIN_ID_PATTERN } from './config'
import { parseSelector } from './selectors'
import type { FallbacksSeedManager, SeedRevertOutcome, SeedsIo, SeedsWireStatus } from './seeds'

/**
 * The `fallbacks` service/typert namespace identity (`fallbacks`): the cordis
 * service key, the typert namespace under `/api/fallbacks/*`, and the settings
 * identity under the legacy dsh API. Current settings writes target the
 * PROFILE ENTRY id instead (see {@link FALLBACKS_PROFILE_ENTRY}); the branded
 * `SettingsNamespace` type the old service APIs constrained on survives as the
 * type this constant carries.
 */
export const FALLBACKS_SETTINGS_NAMESPACE: SettingsNamespace = 'fallbacks' as SettingsNamespace

/**
 * The plugin's profile ENTRY id — the settings-write target on the current dsh host:
 * `SettingsForms` keys every form and write by the Loader entry id
 * (`entry.options.id`), and this plugin's bundle row ships `id: llm-fallbacks`
 * (`bundle/cordis.patch.yml`), so `settings.update('llm-fallbacks', …)` edits
 * exactly this plugin's section of the active profile patch. The section IS
 * the Loader entry config now (schema defaults → bundle row base → profile
 * patch), so a write is visible to the runtime through the same live config
 * reference `apply()` reads — no separate registration step.
 */
export const FALLBACKS_PROFILE_ENTRY = 'llm-fallbacks'

/**
 * The live configuration source for the gateway (guide §7 — the same bridge
 * shape the runtime reads through). `source()` returns the live composed
 * config (schema defaults → plugin-row base → profile patch). The
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
}

/** The `fallbacks/revert-seed` response — a read result plus the revert outcome. */
export interface FallbacksRevertResult extends FallbacksReadResult {
  outcome: SeedRevertOutcome
}

/**
 * Complete configuration key lookup for strict unknown-key rejection. The
 * schemastery object resolver merges unknown keys by default, so the gateway
 * rejects them explicitly — same strictness as advisor and the Loader. The
 * removed config-level `enabled` is NOT here: it is the one tolerated
 * unknown key ({@link LEGACY_KEYS}) and never crosses the wire (the read
 * whitelist drops it, the write path strips it).
 */
const CONFIG_KEYS: Record<string, true> = {
  triggerCodes: true,
  chains: true,
  roles: true,
  cooldownMs: true,
  revertPolicy: true,
  maxSwitchesPerStep: true,
  presets: true,
  // Config-level timezone for slot matching (named virtual chains).
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
}

/**
 * Removed config keys the strict unknown-key rejection TOLERATES — accepted
 * into a patch but stripped from every snapshot/write so they are never read
 * and never re-persisted (the advisor LEGACY_KEYS mechanism). Only the
 * removed config-level `enabled` lives here: the Plugins-page row toggle
 * replaced the master switch, and stored profiles still carrying
 * `enabled: true/false` must load and save cleanly instead of being rejected
 * (plan fallbacks-web-ux-alignment T2 — the stored line is simply ignored;
 * no migration-banner entry, nothing for the user to rewrite). Every other
 * unknown key stays a hard reject.
 */
const LEGACY_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  // v1 two-block keys (named virtual chains): tolerated in a patch, stripped
  // from every snapshot/write — never read, never re-persisted. Nested v1
  // keys (`roles.rules`, `roles.list[].fallback`, the v1 ARRAY form of
  // `roles.list[].chain`) are stripped by the `roles` normalizer below.
  'rootChain',
  'timeSlots',
])

/** Declared nested keys of one `chains[]` row — anything else is rejected. */
const CHAIN_KEYS: Record<string, true> = {
  id: true,
  label: true,
  entries: true,
  timeSlots: true,
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
  private settings: SettingsForms | undefined

  /**
   * @param ctx - owning context (the plugin fiber's ctx inside `apply`).
   * @param bridge - the same `FallbacksSettingsBridge` the runtime reads, so
   *   get/set/reset always operate on the live composed config.
   * @param seeds - the per-apply `FallbacksSeedManager` constructed in
   *   `apply()` — the gateway delegates badge state and revert to it (no
   *   copied manager logic), through the io seam built over this bridge.
   */
  constructor(
    ctx: Context,
    bridge: FallbacksSettingsBridge,
    seeds: FallbacksSeedManager,
  ) {
    super(ctx, 'fallbacks')
    this.bridge = bridge
    this.seeds = seeds
    // The settings service is optional (no settings → entry fallback). The
    // inject child activates only when a settings service is composed,
    // mirroring the plugin apply's own settings child; the returned disposer
    // mirrors its detach path — when the settings service goes away,
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
   * Read the current composed config (schema defaults → entry base → profile
   * patch). No hard-gate resolver (ADR-2): the raw composed config is
   * the wire value. The removed `enabled` key never crosses the wire (the
   * read whitelist drops it — the snapshot-strip half of LEGACY_KEYS).
   * @returns the wire-normalized composed config plus `legacyKeys` — every
   *   v1 field detected on the composed source (`rootChain`, top-level
   *   `timeSlots`, `roles.rules`, `roles.default`, `roles.list[].fallback`,
   *   the v1 ARRAY form of `roles.list[].chain`, plus the older
   *   `alwaysModeRetryCap` / `roleAutoMatch` / renamed role fields —
   *   schemastery retains them), so the client can show a migration banner
   *   (incremental field — old clients ignore it) — plus the additive `seeds`
   *   badge state (legacyKeys precedent — old clients ignore it).
   */
  get(): FallbacksReadResult {
    return this.readResult()
  }

  /**
   * Validate a config patch and write it to the plugin's profile-entry section
   * (live — the runtime reads the same composed source through the Loader; no
   * restart needed).
   * @param patch - any subset of the config keys; unknown keys (top-level
   *   and nested under `roles`) are rejected before anything is written.
   * @returns the NEW composed config plus `legacyKeys` detected on the
   *   POST-WRITE composed source (W-1/F-1): `set` is a config MERGE, so a
   *   legacy patch section (`chains` / `roles.default`) survives a new-shape
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
    // The schema-removed `enabled` rides the same drop ({@link LEGACY_KEYS}):
    // validateConfigPatch TOLERATES it in a patch — stored profiles must load
    // and save cleanly — but the dead key must never be re-persisted here
    // (the Plugins-page row toggle replaced it; writing it back would
    // resurrect a switch nothing reads). An all-null / enabled-only patch is
    // a no-op, like the empty patch above.
    const normalized = stripLegacyForWrite(
      Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)),
    )
    // A no-op patch (empty, or only legacy keys — those are stripped above)
    // still cleans the persisted section: an explicit save is the moment a
    // stored v1 field must go. A truly empty patch keeps the S2 no-op.
    if (Object.keys(normalized).length === 0 && Object.keys(patch).length === 0) return this.readResult()
    await this.writeSection(normalized)
    return this.readResult()
  }

  /**
   * Clear the fallbacks profile-entry section so the composition defaults
   * reapply (`settings.replace(ns, {})` — the in-process removal path a
   * merge-only `set` cannot express).
   * @returns the new composed config plus `legacyKeys` on the post-write
   *   source — `replace` drops the patch section, but legacy keys carried by
   *   the entry base survive and are correctly re-reported (W-1/F-1) — plus
   *   the post-write `seeds` badge state (clearing the patch section also
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
    await settings.replace(FALLBACKS_PROFILE_ENTRY, {})
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
   * wire boundary. Containment (guide §10): a malformed stored patch section
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
   * POST-WRITE source: the config merge retains legacy patch-section keys,
   * so a save cannot clear them — the honest response keeps the migration
   * banner until a get agrees; `seeds` follows the same rule (post-write
   * badge state, W-1/F-1).
   */
  private readResult(): FallbacksReadResult {
    const source = this.bridge.source()
    return {
      config: this.readConfig(source),
      legacyKeys: detectLegacyKeys(source as unknown as Record<string, unknown>),
      seeds: this.seeds.wireStatus(this.seedsIo()),
    }
  }

  /**
   * The io seam the seed manager writes through (spec §9.1): `read` walks the
   * same live bridge source the gateway reads; `writeRoles` persists the
   * declared roles as `{ list }` — the v2 shape, whose rows are `{ id,
   * persona, chain? }` — computed from a fresh composed read, so the write
   * stays correct under the settings merge's replace-whole-array semantics
   * and every operator-specified `chain` pointer survives verbatim. It goes
   * through {@link writeSection}, so a seed write also drops any stored v1
   * field. The write channel fails with the same KD-G5 message as set/reset
   * when no settings service is composed. Built fresh per call so the mutable
   * settings capture is read at call time (the inject child swaps it when the
   * settings service appears/disappears).
   */
  private seedsIo(): SeedsIo {
    const settings = this.settings
    return {
      read: () => this.bridge.source(),
      writeRoles: (roles) => {
        if (settings === undefined) {
          throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
        }
        return this.writeSection(stripLegacyForWrite({ roles: roles as unknown as Record<string, unknown> }))
      },
    }
  }

  /**
   * Write a CLEANED patch and, in the same save, remove v1 fields the
   * persisted section may still carry. `settings.update` is merge-only, so a
   * stored `rootChain` / top-level `timeSlots` / `roles.rules` /
   * `roles.list[].fallback` would otherwise survive every v2 save; the
   * removals ride `settings.mutate`'s `unset` path ops, which touch only the
   * named fields (unrelated configuration, foreign keys and redacted secrets
   * are preserved — a wholesale `replace` rebuilt from a descriptor would not
   * be).
   * @param patch - already stripped of v1 fields and null values.
   */
  private async writeSection(patch: Record<string, unknown>): Promise<void> {
    const settings = this.settings
    if (settings === undefined) {
      throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
    }
    await writeFallbacksSection(settings, patch)
  }
}

/**
 * Persist a CLEANED patch and, in the same operation, remove the v1 fields the
 * ACTIVE PROFILE's persisted section still holds. `settings.update` is
 * merge-only, so a stored `rootChain` / top-level `timeSlots` / `roles.rules` /
 * `roles.list[].fallback` would otherwise survive every v2 save; the removals
 * ride `settings.mutate`'s path ops, which touch only the named fields
 * (unrelated configuration, foreign keys and redacted secrets are preserved —
 * a wholesale `replace` rebuilt from a descriptor would delete them).
 *
 * Exported because the plugin has TWO write entry points — the gateway
 * (`set` / `writeRoles`) and the apply-level `SeedsIo` (`declareSeeds`,
 * `revertSeededPersona`, the bundled preset self-declaration) — and the same
 * logical operation must clean the same way through both.
 * @param settings - the live settings service.
 * @param patch - a patch; v1 fields are stripped here, callers need not.
 * @param ns - profile entry id (defaults to the plugin's own).
 */
export async function writeFallbacksSection(
  settings: SettingsForms,
  patch: Record<string, unknown>,
  ns: string = FALLBACKS_PROFILE_ENTRY,
): Promise<void> {
  const cleaned = stripLegacyForWrite(patch)
  const removals = legacySectionRemovals(settings, ns)
  if (removals.length > 0) await settings.mutate(ns, removals)
  if (Object.keys(cleaned).length > 0) await settings.update(ns, cleaned)
}

/**
 * `unset` path ops for every v1 field the persisted section still holds.
 * Path-addressed on purpose: the write must not restate (and so cannot
 * destroy) fields this plugin does not own.
 * @param settings - the live settings service.
 * @param ns - profile entry id.
 */
function legacySectionRemovals(settings: SettingsForms, ns: string): readonly SettingsPathOp[] {
  const descriptor = settings.describe().find((candidate) => candidate.ns === ns)
  const user = descriptor?.user
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return []
  const section = user as Record<string, unknown>
  const removals: SettingsPathOp[] = []
  for (const key of LEGACY_KEYS) {
    if (Object.hasOwn(section, key)) removals.push({ op: 'unset', path: [key] })
  }
  const roles = section['roles']
  if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) return removals
  const declared = roles as Record<string, unknown>
  for (const key of ['rules', 'default']) {
    if (Object.hasOwn(declared, key)) removals.push({ op: 'unset', path: ['roles', key] })
  }
  if (!Array.isArray(declared['list'])) return removals
  // Rows are rewritten as a whole rather than unset per index: the list is the
  // one array a v1 field lives in, and these values come from the REDACTED
  // `describe().user` view — safe only because no role member is a
  // schema-declared secret. Prefer per-index `unset` if `SettingsPathOp` ever
  // expresses an array member cleanly.
  const stale = declared['list'].some((row) => typeof row === 'object' && row !== null
    && !Array.isArray(row)
    && (Object.hasOwn(row as Record<string, unknown>, 'fallback')
      || Array.isArray((row as Record<string, unknown>)['chain'])))
  if (stale) {
    const cleanedRoles = normalizeRoles({ list: declared['list'] }) as Record<string, unknown>
    removals.push({ op: 'set', path: ['roles', 'list'], value: cleanedRoles['list'] ?? [] })
  }
  return removals
}

/**
 * Strip the v1 two-block fields from a patch on the WRITE path (the read side
 * filters by schema-declared keys instead). Recursive by construction: the
 * top-level {@link LEGACY_KEYS} and `roles` — whose rows lose `fallback` and
 * the v1 ARRAY form of `chain` — are the only places a v1 field can live.
 * @param value - the patch (or a section being rewritten) to clean.
 * @returns a new object; the input is never mutated.
 */
function stripLegacyForWrite(value: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    if (LEGACY_KEYS.has(key)) continue
    if (key === 'roles') {
      const roles = normalizeRoles(member)
      if (roles !== undefined) cleaned[key] = roles
      continue
    }
    cleaned[key] = member
  }
  // `timeSlots` is a v1 TOP-LEVEL key and a v2 PER-CHAIN field: the set only
  // strips the former, which is what the loop above already did.
  return cleaned
}

/**
 * Keep only the declared `roles` fields (`list`) for the wire, and strip the
 * v1 two-block leftovers from each row (`fallback`, and the v1 ARRAY form of
 * `chain` — v2 declares a string pointer). Legacy nested keys (e.g.
 * `roles.default` / `roles.rules` from earlier eras) are retained on the
 * composed source by schemastery and reported via `legacyKeys`, but must
 * never ride the wire (reviewer finding T1 Important #1). Non-object values
 * pass through untouched — readConfig only filters schema-declared keys, and
 * absent fields stay omitted per the wire boundary rule above.
 */
function normalizeRoles(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const roles: Record<string, unknown> = {}
  const list = (value as Record<string, unknown>)['list']
  if (Array.isArray(list)) {
    roles['list'] = list.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
      const row: Record<string, unknown> = {}
      for (const [key, member] of Object.entries(item as Record<string, unknown>)) {
        // v1 leftovers are stripped, never read: the `fallback` strategy and
        // the ARRAY form of the `chain` pointer.
        if (key === 'fallback') continue
        if (key === 'chain' && Array.isArray(member)) continue
        row[key] = member
      }
      return row
    })
  }
  return roles
}

/**
 * Reject a patch the `Config` schema cannot express: non-object input, unknown
 * top-level keys (schemastery merges them silently — the settings service
 * would accept them), and schema type violations — plus the Task 3 semantic
 * guards the permissive schema deliberately does not carry: nested `roles`
 * keys, `chains[]` row shape (id pattern, case-sensitive uniqueness, label),
 * per-chain `timeSlots` row shapes (unknown preset ids, duplicate presets,
 * preset rows carrying windows, non-`HH:mm` custom bounds, out-of-range days,
 * empty chains), and each chain's non-empty `entries` tail conformance.
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
    // corrupt the settings merge and wipe the profile patch section. Same
    // strictness as
    // advisor's `CONFIG_KEYS.has(key)` on a Set. The removed `enabled` is the
    // one tolerated exception ({@link LEGACY_KEYS}): a stored profile still
    // carrying it must parse and save cleanly — the caller's write path
    // strips it, so it is never persisted (plan fallbacks-web-ux-alignment
    // T2).
    if (!Object.hasOwn(CONFIG_KEYS, key) && !LEGACY_KEYS.has(key)) {
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
    if (key === 'chains') {
      validateChainsPatch((patch as Record<string, unknown>)[key])
    }
  }
  // Type/bounds validation (schemastery fills defaults for absent keys; null
  // is treated as missing by defaulted fields, so it validates and is dropped
  // by the caller's wire normalization).
  Config(patch as unknown as FallbacksConfig)
}

/**
 * Reject a `chains` patch value the config model cannot express (named
 * virtual chains): non-array rows, unknown nested keys, invalid ids
 * ({@link CHAIN_ID_PATTERN}), duplicate ids (case-sensitive), per-chain slot
 * rows (via {@link validateTimeSlotsPatch}), and a non-empty `entries` whose
 * LAST entry is not exactly one official model (the reject-on-save mirror of
 * the validator's tail-conformance warn; empty entries stay legal — the
 * picker row registers, the walk refuses).
 */
function validateChainsPatch(chains: unknown): void {
  if (!Array.isArray(chains)) {
    throw new Error('dsh-llm-fallbacks: chains must be an array of named chains')
  }
  const seenIds = new Set<string>()
  chains.forEach((chain, index) => {
    const at = `chains[${index}]`
    if (chain === null || typeof chain !== 'object' || Array.isArray(chain)) {
      throw new Error(`dsh-llm-fallbacks: ${at} must be a plain object`)
    }
    const record = chain as Record<string, unknown>
    for (const nestedKey of Object.keys(record)) {
      if (!Object.hasOwn(CHAIN_KEYS, nestedKey)) {
        throw new Error(`dsh-llm-fallbacks: unknown config key "${at}.${nestedKey}"`)
      }
    }
    if (typeof record.id !== 'string' || !CHAIN_ID_PATTERN.test(record.id)) {
      throw new Error(
        `dsh-llm-fallbacks: ${at}.id must match /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/ (got ${JSON.stringify(record.id)})`,
      )
    }
    if (seenIds.has(record.id)) {
      throw new Error(`dsh-llm-fallbacks: ${at} duplicates chain id "${record.id}" — chain ids must be unique (case-sensitive)`)
    }
    seenIds.add(record.id)
    if (typeof record.label !== 'string') {
      throw new Error(`dsh-llm-fallbacks: ${at}.label must be a string`)
    }
    const entries = record.entries
    if (entries !== undefined && entries !== null
      && (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'))) {
      throw new Error(`dsh-llm-fallbacks: ${at}.entries must be a string array`)
    }
    if (Array.isArray(entries) && entries.length > 0 && !isAllDayConforming(entries)) {
      throw new Error(
        `dsh-llm-fallbacks: ${at}.entries must end with exactly one official model (deepseek-official/deepseek-flash or deepseek-official/deepseek-v4-pro)`,
      )
    }
    if (record.timeSlots !== undefined && record.timeSlots !== null) {
      validateTimeSlotsPatch(record.timeSlots)
    }
  })
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
