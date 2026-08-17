/**
 * Fallbacks settings controller — the client half's own store (slot owner
 * props are empty; data rides this store, per the `settings.plugin.item`
 * card contract).
 *
 * Read path: the fallbacks config rides the plugin's own gateway channel —
 * `connection.rpc.call('/api', 'fallbacks/get', { args: {} })` — NOT the
 * apiproxy wire: after the settings-exposure patches are gone the
 * `fallbacks` namespace is absent from `settings.describe` on every host
 * (like `advisor` is). `settings.describe({})` is still called, but only
 * for the top-level `writable` flag (host read-only mode) and the namespace
 * directory (the configured-provider join reads model-provider namespaces).
 * A `get` that does not resolve (transport down / gateway not ready / no
 * settings service on the host) is NOT a page error — `state.present` goes
 * false and the section keeps the usable defaults skeleton (KD-G5).
 *
 * Write path: `save(next)` → `rpc.call('/api', 'fallbacks/set', { args: {
 * patch: next } })` (the full edited config is the patch — a merge with all
 * keys present is a full overwrite); `resetToDefaults()` →
 * `rpc.call('/api', 'fallbacks/reset', { args: {} })` (the host clears the
 * user layer via `settings.replace(ns, {})` — the removal path a merge
 * cannot express). The gateway channel has NO revision guard: any
 * `set`/`reset` failure (business rejection or transport) surfaces its
 * message in `state.error` for the section's error banner (KD-G3 — the old
 * `settings-conflict` branch is gone).
 */

import type {
  ClientConnectionRpc, ConfigurableProviderView, HistoryEntry, IApiClient,
  ModelProviderGroup, SessionId, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  defaultFallbacksConfig, INHERIT_ROLE_ID,
  type FallbackStrategy, type FallbacksConfig, type FallbacksRole,
  type FallbacksRoleRule, type FallbacksRoles,
} from '../config.ts'
// Type-only — `src/time-slots.ts` is a pure module (no `@deepseek-ai/*`
// runtime imports), so the row type stays out of the client runtime graph.
import type { SlotRowConfig } from '../time-slots.ts'
import type { FallbacksSwitchEventData } from '../events.ts'
import { parseSelector } from '../selectors.ts'
// Type-only — `src/seeds.ts` carries no `@deepseek-ai/*` value imports, so
// this stays out of the client bundle (purity gate).
import type { SeedsWireStatus } from '../seeds.ts'

/** The plugin's settings namespace on the host wire (settings/document-updated ns filter). */
export const FALLBACKS_SETTINGS_NS = 'fallbacks'

/** Single-page history read for the status block (spec §2.5 D-5: `HISTORY_PAGE_MESSAGES`-sized). */
export const SWITCHES_HISTORY_PAGE = 50

/** How many recent switches the status block renders (spec §2.5 D-5: N=5). */
export const RECENT_SWITCH_LIMIT = 5

/**
 * One recent `fallbacks/switch` event as the status block renders it: the
 * durable payload plus the raw event's ordering key and time (the payload
 * itself carries no seq/time — spec §5 table).
 */
export interface FallbacksSwitchSnapshot extends FallbacksSwitchEventData {
  /** Event seq within the session (newest-first ordering key). */
  seq: number
  /** Event time, Unix epoch milliseconds. */
  time: number
}

/**
 * The status block's derived "current effective model" (spec §2.5 D-6) — a
 * **display value** derived from configuration + recent switches, never a
 * live route probe.
 */
export type EffectiveModelView =
  /** ① `enabled: false` or an empty rootChain. */
  | { kind: 'unavailable' }
  /** ② The most recent switch's target (`to`). */
  | { kind: 'switched'; provider: string; model: string }
  /** ③ No switches yet: the config's primary target (first chain entry). */
  | { kind: 'config'; provider: string; model: string }

/** Fallbacks settings-row snapshot. */
export interface FallbacksSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  error: string | null
  /** Whether the provider allows writes at all (describe top-level flag). */
  writable: boolean
  /** The resolved configuration (last accepted gateway response, or the defaults skeleton). */
  config: FallbacksConfig
  /**
   * Whether the `fallbacks/get` gateway channel resolved on the last load.
   * `false` = channel unreachable (transport down / gateway not ready / no
   * settings service) → the section keeps the usable skeleton (KD-G5).
   */
  present: boolean
  /**
   * Legacy (two-block-era) config keys the gateway detected on the composed
   * source (`get().legacyKeys` / the post-write `set`/`reset` response,
   * spec §9): non-empty → the migration banner renders. The wire field is
   * authoritative — the client never guesses legacy status on its own
   * (detectLegacyClientKeys is a test-only fallback). A `set`/`reset`
   * response WITHOUT the field (older gateway) keeps the last accepted
   * value — only a `get` may settle legacy truth (W-1/F-1: a save merges
   * over the user layer, so it cannot delete legacy keys).
   */
  legacyKeys: string[]
  /**
   * Seeded-role badge state (spec §9.4): one entry per live seed, with the
   * gateway's override verdict. The wire field is authoritative — absent on
   * an old response it keeps the last accepted value (the `legacyKeys`
   * honest rule: only a `get` may settle seed truth).
   */
  seeds: SeedsWireStatus[]
  /** Provider/model directory snapshot (spec §2.5 D-4). */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Catalog read diagnostic: whole-load failure or per-provider lookups. */
  catalogError: string | null
  /** Configurable-provider directory (`llm.providers`). */
  providers: ConfigurableProviderView[]
  /**
   * The provider dropdown's offer set: catalog providers whose settings
   * profile resolves, with the Models page's `configured` join semantics
   * (spec §2.5 — see {@link configuredProvidersOf}). Unconfigured directory
   * providers never appear as options.
   */
  configuredProviders: ConfigurableProviderView[]
  /** Model catalog groups (`llm.models`). */
  groups: ModelProviderGroup[]
  /** Bumped on every accepted catalog read; drives row re-classification. */
  catalogEpoch: number
  /** Recent-switch summary (spec §2.4 R-4a / §2.5 D-5). */
  switchesStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Switch-read diagnostic (wire message); null when none. */
  switchesError: string | null
  /** Most recent `fallbacks/switch` events of the current session, newest first. */
  switches: FallbacksSwitchSnapshot[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a nested value by path — the `@deepseek-ai/dsh-client-schema-form`
 * `getPath` semantics, copied locally so the provider-configured join needs no
 * new dependency (array indexes as numeric keys, `undefined` along a missing
 * branch).
 */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Shape-guard the wire `seeds` badge field (spec §9.4): only `{ id,
 * overridden }` entries survive — the `legacyKeys` element-filter
 * precedent. A non-array value resolves to `[]`; malformed entries are
 * dropped, so an all-bad array also lands `[]`. The store never trusts a
 * misshapen badge field.
 */
function parseSeedsWire(value: unknown): SeedsWireStatus[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is SeedsWireStatus => {
    if (!isRecord(entry)) return false
    return typeof entry.id === 'string' && typeof entry.overridden === 'boolean'
  })
}

/**
 * The provider dropdown's offer set (spec §2.5 D-4): catalog providers whose
 * settings profile resolves in the describe namespaces — the Models page's
 * `configured` predicate (`ui-models` store.ts): a provider is configured
 * when its settings namespace exists AND either it addresses the whole
 * section (`settingsPath` empty) or its profile path resolves in the resolved
 * value. Directory-only (unconfigured) providers never become options; the
 * section still renders existing values for them (read-back + annotation) so
 * nothing is lost on save.
 */
export function configuredProvidersOf(
  providers: readonly ConfigurableProviderView[],
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
): ConfigurableProviderView[] {
  return providers.filter((entry) => {
    const namespace = namespaces.get(entry.settingsNs)
    return namespace !== undefined
      && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
  })
}

/**
 * Fold the redacted descriptor value into a complete {@link FallbacksConfig}:
 * missing optional fields take spec §4 defaults; gross type mismatches throw
 * so the UI can surface a broken descriptor instead of mis-rendering.
 */
export function parseFallbacksConfig(value: unknown): FallbacksConfig {
  if (!isRecord(value)) {
    throw new TypeError(`fallbacks descriptor value is not an object: ${String(value)}`)
  }
  const triggerCodes = value.triggerCodes
  if (triggerCodes !== undefined && (!Array.isArray(triggerCodes) || triggerCodes.some(code => typeof code !== 'string'))) {
    throw new TypeError('fallbacks descriptor triggerCodes must be a string array')
  }
  const rootChain = value.rootChain
  if (rootChain !== undefined && (!Array.isArray(rootChain) || rootChain.some(entry => typeof entry !== 'string'))) {
    throw new TypeError('fallbacks descriptor rootChain must be a string array')
  }
  const roles = isRecord(value.roles) ? value.roles : {}
  const list = Array.isArray(roles.list) ? roles.list : []
  const parsedList: FallbacksRole[] = list.map((role, index) => {
    if (!isRecord(role) || typeof role.id !== 'string') {
      throw new TypeError(`fallbacks descriptor roles.list[${String(index)}] must have a string id`)
    }
    const persona = role.persona
    if (persona !== undefined && typeof persona !== 'string') {
      throw new TypeError(`fallbacks descriptor roles.list[${String(index)}].persona must be a string`)
    }
    // prompt/permissions are schema-reserved for the next iteration — parsed
    // and preserved on a read, but never edited by this round's rows.
    const prompt = role.prompt
    if (prompt !== undefined && typeof prompt !== 'string') {
      throw new TypeError(`fallbacks descriptor roles.list[${String(index)}].prompt must be a string`)
    }
    const permissions = role.permissions
    if (permissions !== undefined && (!isRecord(permissions)
      || (permissions.allow !== undefined && (!Array.isArray(permissions.allow) || permissions.allow.some(item => typeof item !== 'string')))
      || (permissions.deny !== undefined && (!Array.isArray(permissions.deny) || permissions.deny.some(item => typeof item !== 'string'))))) {
      throw new TypeError(`fallbacks descriptor roles.list[${String(index)}].permissions must be an allow/deny string-array object`)
    }
    const chain = role.chain
    if (chain !== undefined && (!Array.isArray(chain) || chain.some(entry => typeof entry !== 'string'))) {
      throw new TypeError(`fallbacks descriptor roles.list[${String(index)}].chain must be a string array`)
    }
    const fallback = role.fallback
    if (fallback !== undefined && fallback !== 'inherit-root' && fallback !== 'none') {
      throw new TypeError(`fallbacks descriptor roles.list[${String(index)}].fallback must be inherit-root|none`)
    }
    return {
      id: role.id,
      persona: persona ?? '',
      ...(prompt === undefined ? {} : { prompt }),
      ...(permissions === undefined ? {} : { permissions }),
      chain: (chain as string[] | undefined) ?? [],
      fallback: (fallback as FallbackStrategy | undefined) ?? 'inherit-root',
    }
  })
  const rules = Array.isArray(roles.rules) ? roles.rules : []
  const parsedRules: FallbacksRoleRule[] = rules.map((rule, index) => {
    if (!isRecord(rule) || typeof rule.role !== 'string') {
      throw new TypeError(`fallbacks descriptor roles.rules[${String(index)}] must have a string role`)
    }
    const origin = rule.origin
    if (origin !== undefined && origin !== 'root' && origin !== 'subagent') {
      throw new TypeError(`fallbacks descriptor roles.rules[${String(index)}].origin must be root|subagent`)
    }
    const provider = rule.provider
    const model = rule.model
    if (provider !== undefined && typeof provider !== 'string') {
      throw new TypeError(`fallbacks descriptor roles.rules[${String(index)}].provider must be a string`)
    }
    if (model !== undefined && typeof model !== 'string') {
      throw new TypeError(`fallbacks descriptor roles.rules[${String(index)}].model must be a string`)
    }
    return {
      ...(origin === undefined ? {} : { origin }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      role: rule.role,
    }
  })
  const cooldownMs = value.cooldownMs
  const maxSwitchesPerStep = value.maxSwitchesPerStep
  const alwaysModeRetryCap = value.alwaysModeRetryCap
  for (const [field, raw] of [['cooldownMs', cooldownMs], ['maxSwitchesPerStep', maxSwitchesPerStep], ['alwaysModeRetryCap', alwaysModeRetryCap]] as const) {
    if (raw !== undefined && typeof raw !== 'number') {
      throw new TypeError(`fallbacks descriptor ${field} must be a number`)
    }
  }
  const revertPolicy = value.revertPolicy
  if (revertPolicy !== undefined && revertPolicy !== 'cooldown-expiry' && revertPolicy !== 'never') {
    throw new TypeError('fallbacks descriptor revertPolicy must be cooldown-expiry|never')
  }
  const presets = value.presets
  if (presets !== undefined && presets !== 'bundled' && presets !== 'none') {
    throw new TypeError('fallbacks descriptor presets must be bundled|none')
  }
  const enabled = value.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError('fallbacks descriptor enabled must be a boolean')
  }
  const roleAutoMatch = value.roleAutoMatch
  if (roleAutoMatch !== undefined && typeof roleAutoMatch !== 'boolean') {
    throw new TypeError('fallbacks descriptor roleAutoMatch must be a boolean')
  }
  // P5 mirror: the host schema gained `timeSlots` (11th field) — mechanical
  // descriptor guard for the row shape; the card edits rows in Task 3.
  const timeSlots = value.timeSlots
  if (timeSlots !== undefined && (!Array.isArray(timeSlots) || timeSlots.some((row) => {
    if (!isRecord(row)) return true
    for (const field of ['kind', 'preset', 'start', 'end'] as const) {
      if (row[field] !== undefined && typeof row[field] !== 'string') return true
    }
    const chain = row.chain
    if (chain !== undefined && (!Array.isArray(chain) || chain.some(entry => typeof entry !== 'string'))) return true
    const days = row.days
    if (days !== undefined && (!Array.isArray(days) || days.some(day => typeof day !== 'number'))) return true
    return false
  }))) {
    throw new TypeError('fallbacks descriptor timeSlots must be an array of slot rows (kind/preset/start/end strings, chain string array, days number array)')
  }
  // P5 mirror: the host schema gained `tz` (12th field).
  const tz = value.tz
  if (tz !== undefined && typeof tz !== 'string') {
    throw new TypeError('fallbacks descriptor tz must be a string')
  }
  return {
    enabled: enabled ?? defaultFallbacksConfig.enabled,
    triggerCodes: (triggerCodes as string[] | undefined) ?? [...defaultFallbacksConfig.triggerCodes],
    rootChain: (rootChain as string[] | undefined) ?? [...defaultFallbacksConfig.rootChain],
    roles: {
      list: parsedList,
      rules: parsedRules,
    },
    // The field-level guards above narrowed the raw values only inside the
    // loop; the fallback merge re-narrows each field for the return type.
    cooldownMs: (cooldownMs as number | undefined) ?? defaultFallbacksConfig.cooldownMs,
    revertPolicy: (revertPolicy as FallbacksConfig['revertPolicy'] | undefined) ?? defaultFallbacksConfig.revertPolicy,
    maxSwitchesPerStep: (maxSwitchesPerStep as number | undefined) ?? defaultFallbacksConfig.maxSwitchesPerStep,
    alwaysModeRetryCap: (alwaysModeRetryCap as number | undefined) ?? defaultFallbacksConfig.alwaysModeRetryCap,
    // §9.4 mirror: the host default gained `presets` (9th field), so the
    // client fold mirrors it too — `parseFallbacksConfig` output must stay
    // equal to `defaultFallbacksConfig` (pinned invariant). Mechanical
    // mirror of `revertPolicy`; the settings card neither consumes nor
    // renders `presets` (R-001 re-defer — no client feature change).
    presets: (presets as FallbacksConfig['presets'] | undefined) ?? defaultFallbacksConfig.presets,
    // §9.4 mirror: the host default gained `roleAutoMatch` (10th field), so
    // the client fold mirrors it too — `parseFallbacksConfig` output must
    // stay equal to `defaultFallbacksConfig` (pinned invariant). Mechanical
    // mirror of `enabled`; the settings card renders the key as an always-on
    // "Enable role auto-match" toggle (default true, plan
    // fallbacks-settings-visibility Task 3).
    roleAutoMatch: roleAutoMatch ?? defaultFallbacksConfig.roleAutoMatch,
    // P5 mirror: the host default gained `timeSlots` (11th field), so the
    // client fold mirrors it too — `parseFallbacksConfig` output must stay
    // equal to `defaultFallbacksConfig` (pinned invariant). Mechanical
    // mirror of `triggerCodes`; the settings card edits rows in Task 3.
    timeSlots: (timeSlots as SlotRowConfig[] | undefined) ?? [...(defaultFallbacksConfig.timeSlots ?? [])],
    // P5 mirror: the host default gained `tz` (12th field), so the client
    // fold mirrors it too — mechanical mirror of `presets`.
    tz: (tz as FallbacksConfig['tz'] | undefined) ?? defaultFallbacksConfig.tz,
  }
}

/**
 * Row-level selection state of one provider/model cell (spec §2.5 D-3):
 * a catalog id, an out-of-catalog raw value read back from the server, or
 * nothing (empty / "any"). Serialization always writes the raw string, so an
 * outside value is preserved verbatim — round-trip lossless.
 */
export type CatalogSelection =
  | { kind: 'catalog'; id: string }
  | { kind: 'outside'; raw: string }
  | null

/** The catalog faces row conversions classify raw values against (D-4). */
export interface CatalogLookup {
  providers: readonly ConfigurableProviderView[]
  groups: readonly ModelProviderGroup[]
}

/** The raw selector string a selection serializes to ('' when empty). */
export function selectionToRaw(selection: CatalogSelection): string {
  return selection === null ? '' : selection.kind === 'catalog' ? selection.id : selection.raw
}

/**
 * Classify a raw provider value against the catalog: a catalog route id is a
 * catalog selection, anything else is an outside value kept verbatim.
 */
export function classifyProvider(raw: string, catalog: CatalogLookup | undefined): CatalogSelection {
  if (raw === '') return null
  if (catalog !== undefined && catalog.providers.some(entry => entry.provider === raw)) {
    return { kind: 'catalog', id: raw }
  }
  return { kind: 'outside', raw }
}

/**
 * Classify a raw model value under its provider against the catalog: a model
 * id advertised by that provider is a catalog selection, anything else is an
 * outside value kept verbatim.
 */
export function classifyModel(provider: string, raw: string, catalog: CatalogLookup | undefined): CatalogSelection {
  if (raw === '') return null
  if (catalog !== undefined && catalog.groups.some(group => group.id === provider && group.models.some(model => model.id === raw))) {
    return { kind: 'catalog', id: raw }
  }
  return { kind: 'outside', raw }
}

/**
 * Extract the most recent `fallbacks/switch` events from one history page
 * (spec §2.5 D-5): filter by event type, order by `seq` descending, take at
 * most `limit`. Single-page read — fewer than `limit` events show as-is; no
 * multi-page backfill (Non-Goal).
 */
export function extractRecentSwitches(
  entries: readonly HistoryEntry[],
  limit: number = RECENT_SWITCH_LIMIT,
): FallbacksSwitchSnapshot[] {
  const switches: FallbacksSwitchSnapshot[] = []
  for (const entry of entries) {
    const event = entry.event
    if (event.type !== 'fallbacks/switch') continue
    // The discriminated union narrows `event.data` to FallbacksSwitchEventData
    // after the type check (src/events.ts SessionEventMap augmentation).
    switches.push({ ...event.data, seq: event.seq, time: event.time })
  }
  switches.sort((a, b) => b.seq - a.seq)
  return switches.slice(0, limit)
}

/** The config's primary target: the rootChain's first entry (spec §2.5 D-6 ③). */
function configPrimaryTarget(config: FallbacksConfig): { provider: string; model: string } | null {
  const firstEntry = config.rootChain[0]
  if (firstEntry === undefined) return null
  try {
    const selector = parseSelector(firstEntry)
    return { provider: selector.provider, model: selector.model ?? '*' }
  } catch {
    // A malformed entry (not `provider/model`): show it verbatim rather
    // than mis-parsing it into a plausible-looking route.
    return { provider: firstEntry, model: '*' }
  }
}

/**
 * Derive the "current effective model" (spec §2.5 D-6): ① disabled / empty
 * rootChain → unavailable; ② a recent switch exists → the latest one's `to`;
 * ③ otherwise → the config's primary target. A **display value** — never a
 * live route probe.
 *
 * INTENTIONAL D-6 CONTRACT RETENTION: after the AC-2 trim (plan
 * fallbacks-settings-visibility Task 2) the settings card's status block no
 * longer consumes this derivation, and no other production code imports it —
 * it is retained (NOT dead code to delete) as the spec §2.5 D-6 derived-value
 * surface, pinned by `tests/fallbacks-store.spec.ts` (D-6 display-value
 * contract). Keep both exports until the spec derivation is removed or gains
 * a real consumer.
 */
export function deriveEffectiveModel(
  config: FallbacksConfig,
  switches: readonly FallbacksSwitchSnapshot[],
): EffectiveModelView {
  if (!config.enabled || config.rootChain.length === 0) {
    return { kind: 'unavailable' }
  }
  const latest = switches[0]
  if (latest !== undefined) {
    return { kind: 'switched', provider: latest.to.provider, model: latest.to.model }
  }
  const target = configPrimaryTarget(config)
  if (target === null) return { kind: 'unavailable' }
  return { kind: 'config', ...target }
}

/** One chain selector row: provider + model (or wildcard). */
export interface ChainSelectorRow {
  /** `provider/*` wildcard entry: the model part is absent. */
  wildcard: boolean
  provider: CatalogSelection
  /** Null when wildcard (or the entry carries no model part). */
  model: CatalogSelection
}

/** Serialize one selector row to its wire string (`provider/model` | `provider/*`). */
export function selectorRowToRaw(row: ChainSelectorRow): string {
  const provider = selectionToRaw(row.provider)
  if (provider === '') return ''
  if (row.wildcard) return `${provider}/*`
  const model = selectionToRaw(row.model)
  return model === '' ? provider : `${provider}/${model}`
}

/** Parse one entry line into a selector row, classifying against the catalog. */
function entryToSelectorRow(entry: string, catalog: CatalogLookup | undefined): ChainSelectorRow {
  try {
    const selector = parseSelector(entry)
    return {
      wildcard: selector.model === undefined,
      provider: classifyProvider(selector.provider, catalog),
      model: selector.model === undefined ? null : classifyModel(selector.provider, selector.model, catalog),
    }
  } catch {
    // A malformed entry (not `provider/model`): keep it verbatim as a
    // bare outside value so a save never drops it — the runtime's
    // config-warning semantics are unchanged.
    return { wildcard: false, provider: { kind: 'outside', raw: entry.trim() }, model: null }
  }
}

/**
 * One rootChain row in the editor: the root agent's single fallback chain
 * (block 1 of the two-block model) as an ordered selector list. There is no
 * key input — the row IS the chain.
 */
export interface RootChainRow {
  selectors: ChainSelectorRow[]
}

/** Project the rootChain entries into editable rows (one flat chain row). */
export function rootChainToRows(rootChain: readonly string[], catalog?: CatalogLookup): RootChainRow[] {
  return [{ selectors: rootChain.map(entry => entryToSelectorRow(entry, catalog)) }]
}

/** Rebuild the rootChain from edited rows; rows with no usable selector drop out. */
export function rowsToRootChain(rows: readonly RootChainRow[]): string[] {
  const entries: string[] = []
  for (const row of rows) {
    if (row.selectors.length === 0) continue
    for (const selector of row.selectors) {
      const raw = selectorRowToRaw(selector)
      if (raw !== '') entries.push(raw)
    }
  }
  return entries
}

/**
 * One declared-role row in the editor (block 2 `roles.list`): identity
 * fields + the role's own chain selector list + its append strategy.
 * `prompt`/`permissions` are schema-reserved for the next iteration
 * (fallbacks-explicit-role-tool) — they never enter row editing this round.
 */
export interface RoleRow {
  id: string
  persona: string
  selectors: ChainSelectorRow[]
  fallback: FallbackStrategy
}

/** Project the declared roles into editable rows (chain selectors classified). */
export function rolesToRows(roles: readonly FallbacksRole[], catalog?: CatalogLookup): RoleRow[] {
  return roles.map(role => ({
    id: role.id,
    persona: role.persona,
    selectors: (role.chain ?? []).map(entry => entryToSelectorRow(entry, catalog)),
    fallback: role.fallback ?? 'inherit-root',
  }))
}

/** Rebuild the declared roles from edited rows; empty selectors drop out. */
export function rowsToRoles(rows: readonly RoleRow[]): FallbacksRole[] {
  return rows.map(row => ({
    id: row.id.trim(),
    persona: row.persona,
    chain: row.selectors.map(selectorRowToRaw).filter(entry => entry !== ''),
    fallback: row.fallback,
  }))
}

/**
 * Rebuild the declared roles from edited rows, re-attaching the
 * schema-reserved `prompt`/`permissions` fields from the last accepted
 * config by role id — they never round-trip through rows this round, so
 * without the merge a save would silently drop them (T2 reviewer minor
 * #2). The id trim matches {@link rowsToRoles}; a row whose id matches no
 * original role (a freshly added one) keeps no extras. Key order mirrors
 * `parseFallbacksConfig` so a clean draft's JSON dirty comparison never
 * flags it.
 */
export function mergeRoleExtras(rows: readonly RoleRow[], originalRoles: readonly FallbacksRole[]): FallbacksRole[] {
  const originalById = new Map(originalRoles.map(role => [role.id, role]))
  return rowsToRoles(rows).map(role => {
    const original = originalById.get(role.id)
    if (original === undefined) return role
    return {
      id: role.id,
      persona: role.persona,
      ...(original.prompt === undefined ? {} : { prompt: original.prompt }),
      ...(original.permissions === undefined ? {} : { permissions: original.permissions }),
      chain: role.chain,
      fallback: role.fallback,
    }
  })
}

/**
 * The `roles.rules` role dropdown's offer set — the ONLY data source for the
 * rule rows' role selector: the built-in `'inherit'` target plus every
 * declared `roles.list` id, in declaration order (a role added/removed on
 * the same page is reflected immediately).
 */
export function ruleRoleOptions(roles: Pick<FallbacksRoles, 'list'>): string[] {
  // Canonical ids only, deduplicated (qc3 F-3): ids are trimmed exactly like
  // rowsToRoles/rowsToRules rebuild them, and mid-edit duplicate ids must not
  // render duplicate <option> entries (React key collision) — the dropdown
  // offers each declared id once; save-time validation still blocks the
  // duplicate draft.
  return [INHERIT_ROLE_ID, ...new Set(roles.list.map(role => role.id.trim()))]
}

/**
 * Client-side legacy fallback detection (spec §9). The gateway's
 * `legacyKeys` wire field is authoritative for the migration banner; this is
 * a defensive fallback for configs that already passed wire normalization
 * yet still carry a `roles.rules` reference to an undeclared role id — the
 * only two-block-era leftover that can survive the wire (the removed
 * `chains`/`roles.default` keys never ride it).
 */
export function detectLegacyClientKeys(config: FallbacksConfig): string[] {
  const declared = new Set(config.roles.list.map(role => role.id))
  const keys: string[] = []
  for (const rule of config.roles.rules) {
    if (rule.role !== INHERIT_ROLE_ID && !declared.has(rule.role)) {
      keys.push(`roles.rules[].role: ${rule.role}`)
    }
  }
  return keys
}

/** One role-rule row in the editor; empty origin means "any". */
export interface RoleRuleRow {
  origin: string
  provider: CatalogSelection
  model: CatalogSelection
  role: string
}

/** Project the role rules into editable rows (provider/model classified). */
export function rulesToRows(rules: readonly FallbacksRoleRule[], catalog?: CatalogLookup): RoleRuleRow[] {
  return rules.map(rule => ({
    origin: rule.origin ?? '',
    provider: classifyProvider(rule.provider ?? '', catalog),
    model: classifyModel(rule.provider ?? '', rule.model ?? '', catalog),
    role: rule.role,
  }))
}

/** Rebuild the role rules from edited rows; empty origin/provider/model drop out. */
export function rowsToRules(rows: readonly RoleRuleRow[]): FallbacksRoleRule[] {
  return rows
    .map(row => ({
      ...(row.origin === '' ? {} : { origin: row.origin as 'root' | 'subagent' }),
      ...(row.provider === null ? {} : { provider: selectionToRaw(row.provider) }),
      ...(row.model === null ? {} : { model: selectionToRaw(row.model) }),
      role: row.role.trim(),
    }))
    .filter(rule => rule.role !== '')
}

/** Controller joining Settings reads, writes, and pushed invalidations. */
export class FallbacksSettingsController {
  /** Snapshot consumed by the section through `useSyncExternalStore`. */
  readonly store: SnapshotStore<FallbacksSettingsState> = createSnapshotStore({
    status: 'idle',
    error: null,
    writable: false,
    config: defaultFallbacksConfig,
    present: false,
    legacyKeys: [],
    seeds: [],
    catalogStatus: 'idle',
    catalogError: null,
    providers: [],
    configuredProviders: [],
    groups: [],
    catalogEpoch: 0,
    switchesStatus: 'idle',
    switchesError: null,
    switches: [],
  })

  /** Read guard: a newer load() supersedes an older one's publish. */
  private readGeneration = 0
  /**
   * Write guard: save()/resetToDefaults() completions ALWAYS publish unless
   * dispose() invalidated them — an overlapping read must never discard a
   * successful write's accept() (audit F1).
   */
  private writeGeneration = 0
  private catalogGeneration = 0
  private switchesGeneration = 0
  /** Every settings namespace from the last describe, keyed by ns — the configured-provider join's other input. */
  private namespaces: Map<string, SettingsNamespaceView> = new Map()
  private currentSession: SessionId | undefined

  /**
   * @param api - Settings / Llm / Sessions wire faces (describe `writable` +
   *   namespace directory, provider/model catalog, session history).
   * @param rpc - the connection's generic RPC caller for the host gateway
   *   channel (`/api`), injected from the connection handle.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings' | 'llm' | 'sessions'>,
    private readonly rpc: ClientConnectionRpc,
  ) {}

  /**
   * Refresh the page snapshot. Latest request wins. `settings.describe`
   * still runs — it supplies the top-level `writable` flag (host read-only
   * mode) and the namespace directory (the configured-provider join's other
   * input) — but the fallbacks config itself rides the gateway channel:
   * `rpc.call('/api', 'fallbacks/get', { args: {} })`. The two reads are
   * independent and run in PARALLEL (Promise.all — one round trip per
   * refresh, not two). The `fallbacks` namespace is NOT expected in describe
   * anymore (it is off the apiproxy boundary post-patch); a describe failure
   * remains a hard `error` (the form cannot render provider/model options
   * without the directory), while a get failure is NOT a page error —
   * `present` goes false and the section keeps the usable skeleton (KD-G5).
   * @returns nothing; {@link store} carries success or failure.
   */
  async load(): Promise<void> {
    const generation = ++this.readGeneration
    // Mirrored race guard (F-301): capture the write generation at READ
    // START — a load that began before a save/reset must not publish over
    // the write's accept() when it settles afterwards (write-wins, the F1
    // decision applied to the pre-write read). The next
    // settings/document-updated push refetches, so dropping is safe.
    const writeGenerationAtStart = this.writeGeneration
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      // describe (writable + namespace directory) and the gateway get are
      // independent reads with distinct failure semantics — run them in
      // parallel so a refresh costs one round trip, not two (halves the
      // latency of every `settings/document-updated` push after a save).
      const [describeResult, getResult] = await Promise.all([
        this.api.settings.describe({}),
        // A get failure — transport down, gateway not ready, no settings
        // service on the host — resolves to present=false (the
        // channel-unreachable notice), never a hard load error (KD-G5). The
        // catch keeps the get's failure OUT of Promise.all's rejection so a
        // describe success + get failure still reaches accept(undefined).
        this.rpc.call('/api', 'fallbacks/get', { args: {} }).catch(() => undefined),
      ])
      if (generation !== this.readGeneration) return
      // A write completed (or dispose() ran) while this read was in flight —
      // the write's accept() already published; discard the stale read on
      // both completion branches so it can never clobber the write result.
      if (writeGenerationAtStart !== this.writeGeneration) return
      if (!describeResult.result.ok) throw describeResult.result.error
      this.namespaces = new Map(describeResult.result.value.namespaces.map(entry => [entry.ns, entry]))
      const writable = describeResult.result.value.writable
      // Draft seed invariant (I-1): a failed get must not clobber the
      // accepted config with defaults — `accept` only replaces
      // `state.config` from a REAL resolved value.
      let config: unknown
      let legacyKeys: string[] = []
      let seeds: SeedsWireStatus[] = []
      if (getResult !== undefined && getResult.ok && getResult.value !== null
        && typeof getResult.value === 'object') {
        if ('config' in getResult.value) {
          config = getResult.value.config
        }
        // The wire legacyKeys field is authoritative for the migration
        // banner; an absent/malformed value means "no legacy leftovers".
        if ('legacyKeys' in getResult.value) {
          const wireLegacyKeys: unknown = getResult.value.legacyKeys
          if (Array.isArray(wireLegacyKeys)) {
            legacyKeys = wireLegacyKeys.filter((key): key is string => typeof key === 'string')
          }
        }
        // Same authority rule for the seeds badge (spec §9.4): only a real
        // get settles seed truth — an absent/malformed field means "no
        // seeds to badge" on this fresh read.
        if ('seeds' in getResult.value) {
          seeds = parseSeedsWire(getResult.value.seeds)
        }
      }
      this.accept(config, writable, legacyKeys, seeds)
    } catch (error) {
      if (generation !== this.readGeneration) return
      if (writeGenerationAtStart !== this.writeGeneration) return
      this.fail(error)
    }
  }

  /**
   * Refresh the provider/model catalog (`llm.providers` + `llm.models`), an
   * independent read path with its own generation guard so it can run
   * parallel to {@link load} without clobbering it (spec §2.5 D-4).
   * Per-provider lookup failures ride `catalogError` as a diagnostic without
   * failing the sound groups; a whole-load failure lands `catalogStatus:
   * 'error'` and never blocks the rest of the form.
   * @returns nothing; {@link store} carries success or failure.
   */
  async loadCatalog(): Promise<void> {
    const generation = ++this.catalogGeneration
    this.store.update((state) => {
      state.catalogStatus = 'loading'
      state.catalogError = null
    })
    try {
      const [providersResponse, modelsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.llm.models({}),
      ])
      if (generation !== this.catalogGeneration) return
      if (!providersResponse.result.ok) throw providersResponse.result.error
      if (!modelsResponse.result.ok) throw modelsResponse.result.error
      const providers = providersResponse.result.value.providers
      const groups = modelsResponse.result.value.groups
      const failures = modelsResponse.result.value.failures
      this.store.update((state) => {
        state.catalogStatus = 'ready'
        state.catalogError = failures.length > 0
          ? failures.map(failure => `${failure.name}: ${failure.message}`).join('; ')
          : null
        state.providers = providers
        state.configuredProviders = configuredProvidersOf(providers, this.namespaces)
        state.groups = groups
        state.catalogEpoch += 1
      })
    } catch (error) {
      if (generation !== this.catalogGeneration) return
      const wire = error as { message?: string } | null
      this.store.update((state) => {
        state.catalogStatus = 'error'
        state.catalogError = typeof wire?.message === 'string' ? wire.message : messageOf(error)
      })
    }
  }

  /**
   * Record the current session the status block reads (spec §2.5 D-5). Once
   * the block has been read once, its summary follows session switches
   * immediately; an idle block only records the id — the section's mount
   * effect performs the first read.
   * @param sessionId - the session whose history is summarized; undefined
   *   (no current session) resolves to the empty state.
   */
  setCurrentSession(sessionId: SessionId | undefined): void {
    if (sessionId === this.currentSession) return
    this.currentSession = sessionId
    if (this.store.getSnapshot().switchesStatus !== 'idle') {
      void this.loadSwitches()
    }
  }

  /**
   * Read the recent-switch summary for the current session (spec §2.5 D-5):
   * one `sessions.history` page (`maxMessages` = {@link SWITCHES_HISTORY_PAGE}),
   * `fallbacks/switch` events extracted newest-first capped at
   * {@link RECENT_SWITCH_LIMIT}. No current session → honest empty ready
   * state (no RPC); a read failure lands `switchesStatus: 'error'` and never
   * touches the settings state (the form keeps editing/saving normally).
   * @returns nothing; {@link store} carries success or failure.
   */
  async loadSwitches(): Promise<void> {
    const generation = ++this.switchesGeneration
    const sessionId = this.currentSession
    if (sessionId === undefined) {
      this.store.update((state) => {
        state.switchesStatus = 'ready'
        state.switchesError = null
        state.switches = []
      })
      return
    }
    this.store.update((state) => {
      state.switchesStatus = 'loading'
      state.switchesError = null
    })
    try {
      const response = await this.api.sessions.history({
        sessionId,
        maxMessages: SWITCHES_HISTORY_PAGE,
      })
      if (generation !== this.switchesGeneration) return
      if (!response.result.ok) throw response.result.error
      // Narrowing of `response.result` is lost inside the store-update closure,
      // so extract before publishing (the `ok` check narrows at this level).
      const switches = extractRecentSwitches(response.result.value.events)
      this.store.update((state) => {
        state.switchesStatus = 'ready'
        state.switchesError = null
        state.switches = switches
      })
    } catch (error) {
      if (generation !== this.switchesGeneration) return
      const wire = error as { message?: string } | null
      this.store.update((state) => {
        state.switchesStatus = 'error'
        state.switchesError = typeof wire?.message === 'string' ? wire.message : messageOf(error)
      })
    }
  }

  /**
   * Persist the full edited configuration through the gateway channel
   * (`/api/fallbacks/set`). The full config is sent as a MERGE patch (guide
   * §9) — keys the new schema cannot express (legacy `chains` /
   * `roles.default` in the user layer) survive the write, which is why the
   * gateway returns POST-WRITE `legacyKeys` and the banner stays honest
   * (W-1/F-1). The merge has no revision guard: any failure (business
   * rejection or transport) surfaces its message in `state.error` for the
   * section's error banner and the form stays editable for retry (KD-G3).
   * @param next - the complete edited configuration.
   */
  async save(next: FallbacksConfig): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.writable || state.status === 'saving') return
    const generation = ++this.writeGeneration
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const result = await this.rpc.call('/api', 'fallbacks/set', { args: { patch: next } })
      if (generation !== this.writeGeneration) return
      if (!result.ok) throw result.error
      const value: unknown = result.value
      const config = value !== null && typeof value === 'object' && 'config' in value
        ? value.config
        : undefined
      // The write response carries the post-write legacyKeys (W-1/F-1). When
      // the field is ABSENT (an older gateway), keep the last accepted value
      // — never clear the banner on a save the server cannot vouch for; only
      // a `get` may settle legacy truth.
      let legacyKeys: string[] = this.store.getSnapshot().legacyKeys
      if (value !== null && typeof value === 'object' && 'legacyKeys' in value) {
        const wireLegacyKeys: unknown = value.legacyKeys
        if (Array.isArray(wireLegacyKeys)) {
          legacyKeys = wireLegacyKeys.filter((key): key is string => typeof key === 'string')
        }
      }
      // The write response carries the post-write seeds badge (spec §9.4,
      // same W-1/F-1 rule as legacyKeys): when the field is ABSENT (an
      // older gateway), keep the last accepted value — only a `get` may
      // settle seed truth.
      let seeds: SeedsWireStatus[] = this.store.getSnapshot().seeds
      if (value !== null && typeof value === 'object' && 'seeds' in value) {
        const wireSeeds: unknown = value.seeds
        if (Array.isArray(wireSeeds)) {
          seeds = parseSeedsWire(wireSeeds)
        }
      }
      this.accept(config, true, legacyKeys, seeds)
    } catch (error) {
      if (generation !== this.writeGeneration) return
      this.fail(error)
    }
  }

  /**
   * Reset to composition defaults through the gateway channel
   * (`/api/fallbacks/reset` — the fallbacks-specific third method; the host
   * clears the user layer via `settings.replace(ns, {})`, the removal path a
   * merge cannot express). Same error handling as {@link save} (KD-G3).
   */
  async resetToDefaults(): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.writable || state.status === 'saving') return
    const generation = ++this.writeGeneration
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const result = await this.rpc.call('/api', 'fallbacks/reset', { args: {} })
      if (generation !== this.writeGeneration) return
      if (!result.ok) throw result.error
      const value: unknown = result.value
      const config = value !== null && typeof value === 'object' && 'config' in value
        ? value.config
        : undefined
      // Same keep-last rule as {@link save}: the reset response carries
      // post-write legacyKeys (entry-base leftovers are re-reported); when
      // absent, never clear the banner on the server's silence (W-1/F-1).
      let legacyKeys: string[] = this.store.getSnapshot().legacyKeys
      if (value !== null && typeof value === 'object' && 'legacyKeys' in value) {
        const wireLegacyKeys: unknown = value.legacyKeys
        if (Array.isArray(wireLegacyKeys)) {
          legacyKeys = wireLegacyKeys.filter((key): key is string => typeof key === 'string')
        }
      }
      // Same keep-last rule as {@link save}: the reset response carries the
      // post-write seeds badge (clearing the user layer also clears the
      // materialized rows — the honest response reports the emptied state);
      // when absent, keep the last accepted value (W-1/F-1).
      let seeds: SeedsWireStatus[] = this.store.getSnapshot().seeds
      if (value !== null && typeof value === 'object' && 'seeds' in value) {
        const wireSeeds: unknown = value.seeds
        if (Array.isArray(wireSeeds)) {
          seeds = parseSeedsWire(wireSeeds)
        }
      }
      this.accept(config, true, legacyKeys, seeds)
    } catch (error) {
      if (generation !== this.writeGeneration) return
      this.fail(error)
    }
  }

  /**
   * Revert one seeded role to its CURRENT declared seed default (spec §9.4,
   * AC-3) through the gateway channel (`/api/fallbacks/revert-seed`). Same
   * write guards as {@link save} — writable / saving / write-generation —
   * and the same KD-G3 error handling: any business rejection or transport
   * failure surfaces its message in `state.error` for the error banner and
   * the form stays editable for retry. A business `{ reverted: false,
   * reason }` outcome is still a successful RPC — the post-write read
   * result (config / legacyKeys / seeds) lands either way, and the revert
   * button stays disabled while the write is in flight.
   * @param id - the seeded role id; the host matches it by trimmed id
   *   against the seed registry (spec §9.3).
   */
  async revertSeed(id: string): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.writable || state.status === 'saving') return
    const generation = ++this.writeGeneration
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const result = await this.rpc.call('/api', 'fallbacks/revert-seed', { args: { id } })
      if (generation !== this.writeGeneration) return
      if (!result.ok) throw result.error
      const value: unknown = result.value
      const config = value !== null && typeof value === 'object' && 'config' in value
        ? value.config
        : undefined
      // Same keep-last rules as {@link save}: the revert response carries
      // the post-write read result (W-1/F-1); an absent legacyKeys or seeds
      // field keeps the last accepted value — only a `get` may settle truth.
      let legacyKeys: string[] = this.store.getSnapshot().legacyKeys
      if (value !== null && typeof value === 'object' && 'legacyKeys' in value) {
        const wireLegacyKeys: unknown = value.legacyKeys
        if (Array.isArray(wireLegacyKeys)) {
          legacyKeys = wireLegacyKeys.filter((key): key is string => typeof key === 'string')
        }
      }
      let seeds: SeedsWireStatus[] = this.store.getSnapshot().seeds
      if (value !== null && typeof value === 'object' && 'seeds' in value) {
        const wireSeeds: unknown = value.seeds
        if (Array.isArray(wireSeeds)) {
          seeds = parseSeedsWire(wireSeeds)
        }
      }
      this.accept(config, true, legacyKeys, seeds)
    } catch (error) {
      if (generation !== this.writeGeneration) return
      this.fail(error)
    }
  }

  /** Stop in-flight responses from publishing after plugin disposal. */
  dispose(): void {
    this.readGeneration += 1
    this.writeGeneration += 1
    this.catalogGeneration += 1
    this.switchesGeneration += 1
    this.namespaces = new Map()
  }

  /**
   * Publish a settled load: `status` ready, `writable` from describe, and —
   * only when the gateway returned a REAL config — `present` true and
   * `state.config` replaced with the parsed value. A get that did not
   * resolve (`config === undefined`) lands `present` false and keeps the
   * last accepted config (the defaults skeleton on a first load) — the
   * draft seed invariant (I-1): a transient channel-down must never seed
   * the form with defaults over real server truth. `legacyKeys` rides the
   * same publish: the wire field drives the migration banner. save/reset
   * pass the POST-WRITE value (W-1/F-1) — or the previous value when the
   * response omits the field, so a write can never clear the banner
   * against server truth; only a real `get` may. `seeds` (spec §9.4)
   * follows the same honest rule: the wire badge field is authoritative
   * only when a real config resolved — a transient channel-down keeps the
   * last accepted badge state.
   */
  private accept(config: unknown, writable: boolean, legacyKeys: string[], seeds: SeedsWireStatus[]): void {
    const parsed = config === undefined ? undefined : parseFallbacksConfig(config)
    // `roleAutoMatch` (plan fallbacks-role-automatch Task 1) is a boolean
    // with a schemastery schema default `true`, so the gateway composition
    // (entry base → user layer) ALWAYS resolves the key on the real wire —
    // even for a pre-Plan-A / legacy descriptor that never declared it
    // (AC-7 re-scope, PM decision 2026-08-17 Option A). There is no
    // key-presence signal to honor client-side: `parseFallbacksConfig` folds
    // the key to the default, the card toggle always renders (default on),
    // and a save persists the resolved value (`true` for a legacy config).
    // Keeping the key in the stored config-basis is honest to server truth
    // and the clean-draft invariant holds (both the draft and the accepted
    // config carry `roleAutoMatch`).
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.present = parsed !== undefined
      // The wire legacyKeys is authoritative only when a REAL config
      // resolved: a complete get failure (config undefined — channel down,
      // gateway not ready) must keep the last accepted legacyKeys so a
      // transient refresh can never clear the migration banner (T2 reviewer
      // minor #1).
      state.legacyKeys = parsed === undefined ? state.legacyKeys : legacyKeys
      // Same honest rule for the seeds badge: never clear/overwrite it on a
      // read that resolved no config (the badge is server truth, not a
      // client guess).
      state.seeds = parsed === undefined ? state.seeds : seeds
      if (parsed !== undefined) {
        state.config = parsed
      }
      state.configuredProviders = configuredProvidersOf(state.providers, this.namespaces)
    })
  }

  private fail(error: unknown): void {
    const wire = error as { message?: string } | null
    this.store.update((state) => {
      state.status = 'error'
      state.error = typeof wire?.message === 'string' ? wire.message : messageOf(error)
    })
  }
}

/**
 * Refetch after reconnect / settings change only when the section has already
 * opened once.
 * @param controller - the fallbacks settings controller.
 */
export function refreshFallbacksIfLoaded(controller: FallbacksSettingsController): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Refetch the catalog after `llm/adapters-updated` only when it has already
 * been opened once (the catalog twin of {@link refreshFallbacksIfLoaded}).
 * @param controller - the fallbacks settings controller.
 */
export function refreshCatalogIfLoaded(controller: FallbacksSettingsController): void {
  if (controller.store.getSnapshot().catalogStatus === 'idle') return
  void controller.loadCatalog()
}

/**
 * Refetch the recent-switch summary after `settings/document-updated`
 * (fallbacks ns) / `connection/reset` only when the status block has already
 * been read once
 * (the switches twin of {@link refreshFallbacksIfLoaded}).
 * @param controller - the fallbacks settings controller.
 */
export function refreshSwitchesIfLoaded(controller: FallbacksSettingsController): void {
  if (controller.store.getSnapshot().switchesStatus === 'idle') return
  void controller.loadSwitches()
}
