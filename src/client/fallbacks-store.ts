/**
 * Fallbacks settings controller — the client half's own store (slot owner
 * props are empty; data rides this store, per the `plugins.bundle.config`
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

// Host re-home: the connection client entry dropped the apiproxy-era view
// types; they now live with their owner packages, re-exported through the
// remotes assembly barrel (`ModelProviderGroup`/`SessionFollow*` →
// api-session-controller types, `SettingsNamespaceView`/`SettingsDescribeValue`
// → dsh-settings types, `LlmConfigurableProvider` → dsh-llm types).
import type {
  LlmConfigurableProvider, ModelCatalog, ModelProviderGroup, SessionId,
  SettingsDescribeValue, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  defaultFallbacksConfig, isFallbackActive,
  type FallbacksConfig, type FallbacksRole, type NamedChain,
} from '../config.ts'
// Type-only — `src/time-slots.ts` is a pure module (no `@deepseek-ai/*`
// runtime imports), so the row types stay out of the client runtime graph.
import type { PresetId, SlotRowConfig } from '../time-slots.ts'
import { parseSelector } from '../selectors.ts'
// Type-only — `src/seeds.ts` carries no `@deepseek-ai/*` value imports, so
// this stays out of the client bundle (purity gate).
import type { SeedsWireStatus } from '../seeds.ts'

/** The plugin's settings namespace on the host wire (settings/document-updated ns filter). */
export const FALLBACKS_SETTINGS_NS = 'fallbacks'

/**
 * The per-chain "current effective model" (named virtual chains §4) — a
 * **display value** derived from one chain's entries, never a live route
 * probe.
 */
export type EffectiveModelView =
  /** ① An inactive config (no chains) or an empty entries list. */
  | { kind: 'unavailable' }
  /** ② The chain's first entry (the dispatch head). */
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
  /** Configurable-provider directory (`llm/listConfigurableProviders`). */
  providers: LlmConfigurableProvider[]
  /**
   * The provider dropdown's offer set: catalog providers whose settings
   * profile resolves, with the Models page's `configured` join semantics
   * (spec §2.5 — see {@link configuredProvidersOf}). Unconfigured directory
   * providers never appear as options.
   */
  configuredProviders: LlmConfigurableProvider[]
  /** Model catalog groups (`session/modelCatalog`). */
  groups: readonly ModelProviderGroup[]
  /** Bumped on every accepted catalog read; drives row re-classification. */
  catalogEpoch: number
  /** Current session id the conversation switch strip follows. */
  currentSession: SessionId | undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a nested value by path — the upstream `dsh-client-schema-form`
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
 * precedent. `source` is optional on the wire (gateway version skew): a
 * present-and-string label is kept, an absent/malformed one drops the
 * field while the entry itself still parses — consumers treat a missing
 * label as "no badge" (the degradation path, never an error). A blank or
 * whitespace-only label counts as malformed (it would render a textless
 * badge). Entries are
 * NORMALIZED to the known keys, so a wire entry can never smuggle a
 * non-string `source` past the guard's type. A non-array value resolves
 * to `[]`; malformed entries are dropped, so an all-bad array also lands
 * `[]`. The store never trusts a misshapen badge field.
 */
function parseSeedsWire(value: unknown): SeedsWireStatus[] {
  if (!Array.isArray(value)) return []
  const entries: SeedsWireStatus[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (typeof entry.id !== 'string' || typeof entry.overridden !== 'boolean') continue
    entries.push({
      id: entry.id,
      overridden: entry.overridden,
      ...(typeof entry.source === 'string' && entry.source.trim() !== '' ? { source: entry.source } : {}),
    })
  }
  return entries
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
  providers: readonly LlmConfigurableProvider[],
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
): LlmConfigurableProvider[] {
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
  // Named chains (v2): { id, label, entries, timeSlots } — mechanical
  // descriptor guard for the row shapes; the card edits them via drafts.
  const chains = value.chains
  if (chains !== undefined && (!Array.isArray(chains) || chains.some((chain) => {
    if (!isRecord(chain)) return true
    if (typeof chain.id !== 'string' || typeof chain.label !== 'string') return true
    const entries = chain.entries
    if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string'))) return true
    const slots = chain.timeSlots
    if (slots !== undefined && (!Array.isArray(slots) || slots.some((row) => {
      if (!isRecord(row)) return true
      for (const field of ['kind', 'preset', 'start', 'end'] as const) {
        if (row[field] !== undefined && typeof row[field] !== 'string') return true
      }
      const rowChain = row.chain
      if (rowChain !== undefined && (!Array.isArray(rowChain) || rowChain.some(entry => typeof entry !== 'string'))) return true
      const days = row.days
      if (days !== undefined && (!Array.isArray(days) || days.some(day => typeof day !== 'number'))) return true
      return false
    }))) return true
    return false
  }))) {
    throw new TypeError('fallbacks descriptor chains must be an array of named chains ({ id, label, entries, timeSlots })')
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
    // v2: `chain` is a single named-chain POINTER (string). A v1 ARRAY is
    // normally stripped by the gateway's migration, but an un-migrated host
    // must never brick the card: a non-string value reads as NOT SPECIFIED
    // (the 指定降级链 select takes over) instead of throwing. Every other
    // malformed shape keeps its strict rejection above.
    const chain = typeof role.chain === 'string' ? role.chain : undefined
    return {
      id: role.id,
      persona: persona ?? '',
      ...(prompt === undefined ? {} : { prompt }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(chain === undefined || chain === '' ? {} : { chain }),
    }
  })
  const cooldownMs = value.cooldownMs
  const maxSwitchesPerStep = value.maxSwitchesPerStep
  for (const [field, raw] of [['cooldownMs', cooldownMs], ['maxSwitchesPerStep', maxSwitchesPerStep]] as const) {
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
  const tz = value.tz
  if (tz !== undefined && typeof tz !== 'string') {
    throw new TypeError('fallbacks descriptor tz must be a string')
  }
  const recovery = value.recovery
  if (recovery !== undefined && recovery !== 'timer' && recovery !== 'half-open') {
    throw new TypeError('fallbacks descriptor recovery must be timer|half-open')
  }
  return {
    triggerCodes: (triggerCodes as string[] | undefined) ?? [...defaultFallbacksConfig.triggerCodes],
    chains: (chains as NamedChain[] | undefined) ?? defaultFallbacksConfig.chains.map((chain) => ({ ...chain, timeSlots: [...(chain.timeSlots ?? [])] })),
    roles: { list: parsedList },
    cooldownMs: (cooldownMs as number | undefined) ?? defaultFallbacksConfig.cooldownMs,
    revertPolicy: (revertPolicy as FallbacksConfig['revertPolicy'] | undefined) ?? defaultFallbacksConfig.revertPolicy,
    maxSwitchesPerStep: (maxSwitchesPerStep as number | undefined) ?? defaultFallbacksConfig.maxSwitchesPerStep,
    presets: (presets as FallbacksConfig['presets'] | undefined) ?? defaultFallbacksConfig.presets,
    tz: (tz as FallbacksConfig['tz'] | undefined) ?? defaultFallbacksConfig.tz,
    recovery: (recovery as FallbacksConfig['recovery'] | undefined) ?? defaultFallbacksConfig.recovery,
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
  providers: readonly LlmConfigurableProvider[]
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
 * Derive the per-chain "current effective model" (named virtual chains §4):
 * an inactive config (no chains) or empty entries → unavailable; otherwise
 * the chain's first entry (the dispatch head). A **display value** — never a
 * live route probe.
 */
export function deriveEffectiveModel(chain: NamedChain | undefined): EffectiveModelView {
  const firstEntry = chain?.entries[0]
  if (firstEntry === undefined) return { kind: 'unavailable' }
  try {
    const selector = parseSelector(firstEntry)
    return { kind: 'config', provider: selector.provider, model: selector.model ?? '*' }
  } catch {
    // A malformed entry (not `provider/model`): show it verbatim rather
    // than mis-parsing it into a plausible-looking route.
    return { kind: 'config', provider: firstEntry, model: '*' }
  }
}

/** One chain selector row: provider + model (or wildcard), plus its pin. */
export interface ChainSelectorRow {
  /** `provider/*` wildcard entry: the model part is absent. */
  wildcard: boolean
  provider: CatalogSelection
  /** Null when wildcard (or the entry carries no model part). */
  model: CatalogSelection
  /**
   * Pinned reasoning effort of this hop (`provider/model@effort`), `null` when
   * the entry follows the session's own selection. A null NEVER writes a
   * suffix, so an effort-free row serializes exactly as it did before the
   * column existed.
   */
  effort: string | null
}

/**
 * Serialize one selector row to its wire string
 * (`provider/model[@effort]` | `provider/*[@effort]`). The suffix is written
 * ONLY for a pinned effort, so an effort-free row stays byte-identical to the
 * pre-@effort wire form.
 */
export function selectorRowToRaw(row: ChainSelectorRow): string {
  const provider = selectionToRaw(row.provider)
  if (provider === '') return ''
  const suffix = row.effort === null ? '' : `@${row.effort}`
  if (row.wildcard) return `${provider}/*${suffix}`
  const model = selectionToRaw(row.model)
  // A bare provider (model not picked yet) has no effort select to pin from;
  // the suffix would make the string unparsable, so it is never appended.
  return model === '' ? provider : `${provider}/${model}${suffix}`
}

/** Parse one entry line into a selector row, classifying against the catalog. */
export function entryToSelectorRow(entry: string, catalog: CatalogLookup | undefined): ChainSelectorRow {
  try {
    const selector = parseSelector(entry)
    return {
      wildcard: selector.model === undefined,
      provider: classifyProvider(selector.provider, catalog),
      model: selector.model === undefined ? null : classifyModel(selector.provider, selector.model, catalog),
      effort: selector.effort ?? null,
    }
  } catch {
    // A malformed entry (not `provider/model`): keep it verbatim as a
    // bare outside value so a save never drops it — the runtime's
    // config-warning semantics are unchanged.
    return { wildcard: false, provider: { kind: 'outside', raw: entry.trim() }, model: null, effort: null }
  }
}

/**
 * One time-slot row in the editor: preset rows freeze their windows
 * (read-only summary, models-only edits); custom rows edit start/end/days +
 * chain. `kind` rides the wire VERBATIM — a hand-written YAML row with an
 * unknown kind reads back as a custom-shaped row and serializes back
 * unchanged, so the dirty check stays quiet (save validation rejects it).
 */
export interface SlotEditorRow {
  kind: string
  /** Frozen preset id — preset rows only (windows are code constants). */
  preset?: string
  /** Custom rows: window start `HH:mm` text. */
  start: string
  /** Custom rows: window end `HH:mm` text. */
  end: string
  /** Custom rows: day mask 0=Sunday…6=Saturday; [] = every day. */
  days: number[]
  /** Custom rows: display name (PR #62 feedback round — collapsed rows). */
  name: string
  /** UI-only collapse state — never serialized (dropped by rowsToTimeSlots). */
  collapsed: boolean
  selectors: ChainSelectorRow[]
}

/** Project the time-slot rows into editable rows (chain selectors classified). */
export function timeSlotsToRows(timeSlots: readonly SlotRowConfig[], catalog?: CatalogLookup): SlotEditorRow[] {
  return timeSlots.map(row => ({
    kind: row.kind,
    ...(row.preset === undefined ? {} : { preset: row.preset }),
    start: row.start ?? '',
    end: row.end ?? '',
    days: [...(row.days ?? [])],
    name: row.name ?? '',
    // UI-only collapse state — never serialized (dropped by rowsToTimeSlots).
    // Time-slot rows default COLLAPSED like role cards; only a freshly ADDED
    // row starts expanded.
    collapsed: true,
    selectors: (row.chain ?? []).map(entry => entryToSelectorRow(entry, catalog)),
  }))
}

/** Rebuild the time-slot rows from edited rows; blank selectors drop out.
 * `kind` rides verbatim (a hand-written unknown kind reads back unchanged;
 * save validation rejects it). `days` is ALWAYS serialized ([] included):
 * schemastery composes absent array fields as `[]`, so the composed config
 * every card load accepts carries `days` on every row — the draft must too,
 * or a clean card would read back dirty. */
export function rowsToTimeSlots(rows: readonly SlotEditorRow[]): SlotRowConfig[] {
  return rows.map(row => {
    const chain = row.selectors.map(selectorRowToRaw).filter(entry => entry !== '')
    if (row.kind === 'preset') {
      return { kind: 'preset', preset: row.preset as PresetId, days: row.days, chain }
    }
    return {
      kind: row.kind as 'custom',
      ...(row.preset === undefined ? {} : { preset: row.preset as PresetId }),
      start: row.start,
      end: row.end,
      days: row.days,
      ...(row.name === '' ? {} : { name: row.name }),
      chain,
    }
  })
}

/**
 * One named-chain draft in the editor (named virtual chains): the chain's
 * id (immutable once created), display label, 默认降级链 selector rows, and
 * its 分时 slot rows. `label`/entries/slots are editable; the id is not.
 */
export interface ChainDraft {
  id: string
  label: string
  selectors: ChainSelectorRow[]
  slots: SlotEditorRow[]
}

/** Project the named chains into editable drafts (selectors classified). */
export function chainsToDrafts(chains: readonly NamedChain[], catalog?: CatalogLookup): ChainDraft[] {
  return chains.map(chain => ({
    id: chain.id,
    label: chain.label,
    selectors: chain.entries.map(entry => entryToSelectorRow(entry, catalog)),
    slots: timeSlotsToRows(chain.timeSlots ?? [], catalog),
  }))
}

/**
 * Generate a fresh unique chain id for the card's `+` affordance. Pass the
 * DRAFT list, not the accepted config: two unsaved additions must not both
 * claim `chain-N` (duplicate React keys, and a section the gateway rejects).
 */
export function newChainId(existing: readonly { id: string }[]): string {
  let index = existing.length + 1
  let id = `chain-${index}`
  while (existing.some(chain => chain.id === id)) {
    index += 1
    id = `chain-${index}`
  }
  return id
}

/** Rebuild one named chain from its draft; blank selectors drop out. */
export function draftToChain(draft: ChainDraft): NamedChain {
  return {
    id: draft.id,
    label: draft.label,
    entries: draft.selectors.map(selectorRowToRaw).filter(entry => entry !== ''),
    timeSlots: rowsToTimeSlots(draft.slots),
  }
}

export function chainToChainDraftOf(chain: NamedChain, catalog?: CatalogLookup): ChainDraft {
  return chainsToDrafts([chain], catalog)[0]!
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
  /** The MANUALLY specified named-chain POINTER (「指定降级链」); '' = NOT SPECIFIED. */
  chain: string
  /** UI-only collapse state — never serialized (dropped by rowsToRoles). */
  collapsed: boolean
  /**
   * UI-only seeded-persona brief disclosure — never serialized (dropped by
   * rowsToRoles). Only seeded rows render the affordance; ordinary rows
   * ignore the flag.
   */
  personaOpen: boolean
}

/** Project the declared roles into editable rows (chain pointer kept verbatim). */
export function rolesToRows(roles: readonly FallbacksRole[]): RoleRow[] {
  return roles.map(role => ({
    id: role.id,
    persona: role.persona,
    chain: role.chain ?? '',
    // Role cards default COLLAPSED: the list stays scannable and every
    // editor opens on demand (a new row starts collapsed too).
    collapsed: true,
    personaOpen: false,
  }))
}

/** Rebuild the declared roles from edited rows; an empty pointer drops out. */
export function rowsToRoles(rows: readonly RoleRow[]): FallbacksRole[] {
  return rows.map(row => ({
    id: row.id.trim(),
    persona: row.persona,
    ...(row.chain === '' ? {} : { chain: row.chain }),
  }))
}

/**
 * Rebuild the declared roles from edited rows, re-attaching the
 * schema-reserved `prompt`/`permissions` fields from the last accepted
 * config by role id — they never round-trip through rows this round, so
 * without the merge a save would silently drop them. The id trim matches
 * {@link rowsToRoles}; a row whose id matches no original role (a freshly
 * added one) keeps no extras.
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
      ...(role.chain === undefined ? {} : { chain: role.chain }),
    }
  })
}

/**
 * The 「指定降级链」 dropdown's offer set: the NOT-SPECIFIED empty value plus
 * every declared chain, in declaration order (option label rendered by the
 * card as `<label>（FallbacksChain/<id>）`).
 */
export function roleChainOptions(chains: readonly NamedChain[]): string[] {
  return chains.map(chain => chain.id)
}

/**
 * The settings Remote namespace face the fallbacks store reads
 * (`ctx.remote.settings`; api-settings-controller `@Remote` methods).
 */
export interface FallbacksSettingsRemote {
  /** Redacted describe: provider writability plus the namespace directory. */
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
}

/**
 * The llm Remote namespace face the fallbacks store reads
 * (`ctx.remote.llm`; dsh-llm `@Remote` methods).
 */
export interface FallbacksLlmRemote {
  /** Declared configurable-provider directory, registered or dormant. */
  listConfigurableProviders(): Promise<RemoteResult<LlmConfigurableProvider[]>>
}

/**
 * The session Remote namespace face the fallbacks store reads
 * (`ctx.remote.session`; api-session-controller `@Remote` methods).
 */
export interface FallbacksSessionRemote {
  /** Host-generation model catalog: provider groups plus per-provider failures. */
  modelCatalog(): Promise<RemoteResult<ModelCatalog>>
}

/**
 * The generated Remote namespaces the fallbacks store consumes, as one
 * structural face. The mount boundary casts `ctx.remote` once — the same
 * pattern as the session-controller client's `ctx.remote as unknown as
 * SessionRemotes` — because the generated `TypertRemoteNamespaceMap` merge
 * ships with the host's build, not with the linked package types.
 */
export interface FallbacksRemote {
  readonly settings: FallbacksSettingsRemote
  readonly llm: FallbacksLlmRemote
  readonly session: FallbacksSessionRemote
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
    currentSession: undefined,
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
  /** Every settings namespace from the last describe, keyed by ns — the configured-provider join's other input. */
  private namespaces: Map<string, SettingsNamespaceView> = new Map()

  /**
   * @param api - the Remote namespace faces the store reads (settings
   *   describe `writable` + namespace directory, llm provider directory,
   *   session model catalog) — `ctx.remote` cast once at
   *   the mount boundary.
   * @param rpc - the connection's generic RPC caller for the host gateway
   *   channel (`/api`), injected from the connection handle.
   */
  constructor(
    private readonly api: FallbacksRemote,
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
        this.api.settings.describe(),
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
      if (!describeResult.ok) throw describeResult.error
      this.namespaces = new Map(describeResult.value.namespaces.map(entry => [entry.ns, entry]))
      const writable = describeResult.value.writable
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
   * Refresh the provider/model catalog (`llm/listConfigurableProviders` +
   * `session/modelCatalog`), an
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
      const [providersResponse, catalogResponse] = await Promise.all([
        this.api.llm.listConfigurableProviders(),
        this.api.session.modelCatalog(),
      ])
      if (generation !== this.catalogGeneration) return
      if (!providersResponse.ok) throw providersResponse.error
      if (!catalogResponse.ok) throw catalogResponse.error
      const providers = providersResponse.value
      const groups = catalogResponse.value.groups
      const failures = catalogResponse.value.failures
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
   * Record the current session the conversation switch strip follows
   * (switch events ride the session stream — no client history read).
   */
  setCurrentSession(sessionId: SessionId | undefined): void {
    this.store.update((state) => {
      state.currentSession = sessionId
    })
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
      this.acceptWire(result.value)
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
      this.acceptWire(result.value)
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
    this.namespaces = new Map()
  }

  /**
   * Unpack one write response (set / reset) into the store snapshot. The
   * additive fields (legacyKeys §9, seeds §9.4) follow the W-1/F-1 rule:
   * absent on the wire keeps the last accepted value — only a `get` may
   * settle server truth.
   */
  private acceptWire(value: unknown): void {
    const config = value !== null && typeof value === 'object' && 'config' in value
      ? value.config
      : undefined
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
  private accept(
    config: unknown,
    writable: boolean,
    legacyKeys: string[],
    seeds: SeedsWireStatus[],
  ): void {
    const parsed = config === undefined ? undefined : parseFallbacksConfig(config)
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
