/**
 * Fallbacks settings controller — the client half's own store (slot owner
 * props are empty; data rides this store, per the `settings.section`
 * contract).
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
  defaultFallbacksConfig, type FallbacksConfig, type FallbacksRoleRule,
} from '../config.ts'
import type { FallbacksSwitchEventData } from '../events.ts'
import { parseSelector } from '../selectors.ts'

/** The plugin's settings namespace on the host wire (settings/changed filter). */
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
  /** ① `enabled: false` or no chains configured. */
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
  const chains = value.chains
  if (chains !== undefined && (!isRecord(chains) || Object.values(chains).some(entries => !Array.isArray(entries) || entries.some(e => typeof e !== 'string')))) {
    throw new TypeError('fallbacks descriptor chains must be a string-array record')
  }
  const roles = isRecord(value.roles) ? value.roles : {}
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
  const enabled = value.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError('fallbacks descriptor enabled must be a boolean')
  }
  return {
    enabled: enabled ?? defaultFallbacksConfig.enabled,
    triggerCodes: (triggerCodes as string[] | undefined) ?? [...defaultFallbacksConfig.triggerCodes],
    chains: (chains as Record<string, string[]> | undefined) ?? {},
    roles: {
      default: typeof roles.default === 'string' ? roles.default : defaultFallbacksConfig.roles.default,
      rules: parsedRules,
    },
    // The field-level guards above narrowed the raw values only inside the
    // loop; the fallback merge re-narrows each field for the return type.
    cooldownMs: (cooldownMs as number | undefined) ?? defaultFallbacksConfig.cooldownMs,
    revertPolicy: (revertPolicy as FallbacksConfig['revertPolicy'] | undefined) ?? defaultFallbacksConfig.revertPolicy,
    maxSwitchesPerStep: (maxSwitchesPerStep as number | undefined) ?? defaultFallbacksConfig.maxSwitchesPerStep,
    alwaysModeRetryCap: (alwaysModeRetryCap as number | undefined) ?? defaultFallbacksConfig.alwaysModeRetryCap,
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

/** The config's primary target: the first selector of the first chain (D-6 ③). */
function configPrimaryTarget(config: FallbacksConfig): { provider: string; model: string } | null {
  const firstChain = Object.values(config.chains)[0]
  const firstEntry = firstChain?.[0]
  if (firstEntry === undefined) return null
  try {
    const selector = parseSelector(firstEntry)
    return { provider: selector.provider, model: selector.model ?? '*' }
  } catch {
    // A malformed legacy entry (not `provider/model`): show it verbatim rather
    // than mis-parsing it into a plausible-looking route.
    return { provider: firstEntry, model: '*' }
  }
}

/**
 * Derive the status block's "current effective model" (spec §2.5 D-6): ①
 * disabled/empty chains → unavailable; ② a recent switch exists → the latest
 * one's `to`; ③ otherwise → the config's primary target. A **display value** —
 * never a live route probe (the section appends the non-probing note inline
 * right after the derived value, available case only; the unavailable 空态
 * renders its own copy without the note).
 */
export function deriveEffectiveModel(
  config: FallbacksConfig,
  switches: readonly FallbacksSwitchSnapshot[],
): EffectiveModelView {
  if (!config.enabled || Object.keys(config.chains).length === 0) {
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

/** One chain row in the editor: key (free text) + ordered selector rows. */
export interface ChainRow {
  key: string
  selectors: ChainSelectorRow[]
}

/** Serialize one selector row to its wire string (`provider/model` | `provider/*`). */
export function selectorRowToRaw(row: ChainSelectorRow): string {
  const provider = selectionToRaw(row.provider)
  if (provider === '') return ''
  if (row.wildcard) return `${provider}/*`
  const model = selectionToRaw(row.model)
  return model === '' ? provider : `${provider}/${model}`
}

/** Project the chains record into editable rows (one selector list per key). */
export function chainsToRows(chains: Record<string, string[]>, catalog?: CatalogLookup): ChainRow[] {
  return Object.entries(chains).map(([key, entries]) => ({
    key,
    selectors: entries.map(entry => entryToSelectorRow(entry, catalog)),
  }))
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
    // A malformed legacy entry (not `provider/model`): keep it verbatim as a
    // bare outside value so a save never drops it — the runtime's
    // config-warning semantics are unchanged.
    return { wildcard: false, provider: { kind: 'outside', raw: entry.trim() }, model: null }
  }
}

/** Rebuild the chains record from edited rows; empty keys drop out. */
export function rowsToChains(rows: readonly ChainRow[]): Record<string, string[]> {
  const chains: Record<string, string[]> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    chains[key] = row.selectors.map(selectorRowToRaw).filter(entry => entry !== '')
  }
  return chains
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

  private generation = 0
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
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      // describe (writable + namespace directory) and the gateway get are
      // independent reads with distinct failure semantics — run them in
      // parallel so a refresh costs one round trip, not two (halves the
      // latency of every `settings/changed` push after a save).
      const [describeResult, getResult] = await Promise.all([
        this.api.settings.describe({}),
        // A get failure — transport down, gateway not ready, no settings
        // service on the host — resolves to present=false (the
        // channel-unreachable notice), never a hard load error (KD-G5). The
        // catch keeps the get's failure OUT of Promise.all's rejection so a
        // describe success + get failure still reaches accept(undefined).
        this.rpc.call('/api', 'fallbacks/get', { args: {} }).catch(() => undefined),
      ])
      if (generation !== this.generation) return
      if (!describeResult.result.ok) throw describeResult.result.error
      this.namespaces = new Map(describeResult.result.value.namespaces.map(entry => [entry.ns, entry]))
      const writable = describeResult.result.value.writable
      // Draft seed invariant (I-1): a failed get must not clobber the
      // accepted config with defaults — `accept` only replaces
      // `state.config` from a REAL resolved value.
      let config: unknown
      if (getResult !== undefined && getResult.ok && getResult.value !== null
        && typeof getResult.value === 'object' && 'config' in getResult.value) {
        config = getResult.value.config
      }
      this.accept(config, writable)
    } catch (error) {
      if (generation !== this.generation) return
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
   * (`/api/fallbacks/set`). The full config is sent as the patch — a merge
   * with all keys present is a full overwrite (guide §9). The gateway merge
   * has no revision guard: any failure (business rejection or transport)
   * surfaces its message in `state.error` for the section's error banner and
   * the form stays editable for retry (KD-G3).
   * @param next - the complete edited configuration.
   */
  async save(next: FallbacksConfig): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.writable || state.status === 'saving') return
    const generation = ++this.generation
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const result = await this.rpc.call('/api', 'fallbacks/set', { args: { patch: next } })
      if (generation !== this.generation) return
      if (!result.ok) throw result.error
      const config = result.value !== null && typeof result.value === 'object' && 'config' in result.value
        ? result.value.config
        : undefined
      this.accept(config, true)
    } catch (error) {
      if (generation !== this.generation) return
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
    const generation = ++this.generation
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const result = await this.rpc.call('/api', 'fallbacks/reset', { args: {} })
      if (generation !== this.generation) return
      if (!result.ok) throw result.error
      const config = result.value !== null && typeof result.value === 'object' && 'config' in result.value
        ? result.value.config
        : undefined
      this.accept(config, true)
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error)
    }
  }

  /** Stop in-flight responses from publishing after plugin disposal. */
  dispose(): void {
    this.generation += 1
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
   * the form with defaults over real server truth.
   */
  private accept(config: unknown, writable: boolean): void {
    const parsed = config === undefined ? undefined : parseFallbacksConfig(config)
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.present = parsed !== undefined
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
 * Refetch the catalog after `models/changed` only when it has already been
 * opened once (the catalog twin of {@link refreshFallbacksIfLoaded}).
 * @param controller - the fallbacks settings controller.
 */
export function refreshCatalogIfLoaded(controller: FallbacksSettingsController): void {
  if (controller.store.getSnapshot().catalogStatus === 'idle') return
  void controller.loadCatalog()
}

/**
 * Refetch the recent-switch summary after `settings/changed` (fallbacks ns) /
 * `connection/reset` only when the status block has already been read once
 * (the switches twin of {@link refreshFallbacksIfLoaded}).
 * @param controller - the fallbacks settings controller.
 */
export function refreshSwitchesIfLoaded(controller: FallbacksSettingsController): void {
  if (controller.store.getSnapshot().switchesStatus === 'idle') return
  void controller.loadSwitches()
}
