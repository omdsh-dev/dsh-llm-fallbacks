/**
 * Fallbacks settings controller — the client half's own store (slot owner
 * props are empty; data rides this store, per the `settings.section`
 * contract).
 *
 * Read path: `settings.describe({})` → the `fallbacks` namespace descriptor.
 * The descriptor is the **redactSecrets** face: `value` is the redacted
 * resolved layer (schema defaults → composition base → user section) and
 * secret slots only report presence. `fallbacks` declares no secret-role
 * fields today, but the store reads through the same seam.
 *
 * Write path: `settings.update({ ns, patch, expectedRevision })` merges the
 * draft into the user layer; `settings.replace({ ns, section: {},
 * expectedRevision })` resets to composition defaults. A write whose
 * `expectedRevision` is stale is refused by the host with the wire error
 * code `settings-conflict` (details carry expected/actual); the store
 * surfaces it as `state.conflict` so the form can prompt a reload instead of
 * silently overwriting a concurrent change (the `SettingsConflictError`
 * presentation contract).
 *
 * Namespace-missing writes (readme-settings spec §1.4-2): when no view has
 * ever been accepted the store still attempts `update`/`replace` with
 * `expectedRevision` omitted (no precondition) — acceptance is the host's
 * call; a refusal lands in `error` with the banner surfacing it honestly.
 */

import type {
  ConfigurableProviderView, HistoryEntry, IApiClient, ModelProviderGroup, SessionId,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  defaultFallbacksConfig, type FallbacksConfig, type FallbacksRoleRule,
} from '../config.ts'
import type { FallbacksSwitchEventData } from '../events.ts'
import { parseSelector } from '../selectors.ts'

/** The plugin's settings namespace on the host wire. */
export const FALLBACKS_SETTINGS_NS = 'fallbacks'

/** Stable wire code of a refused stale-revision write (rpc.d.ts mirror). */
export const SETTINGS_CONFLICT_CODE = 'settings-conflict'

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
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  /** Whether the provider allows writes at all. */
  writable: boolean
  /** The resolved configuration from the descriptor. */
  config: FallbacksConfig
  /** The descriptor revision the loaded config was read at. */
  revision: number
  /** A refused write's expected/actual revisions; null when none pending. */
  conflict: { expected: number; actual: number } | null
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

/** Whether a wire error is the stale-revision refusal (`settings-conflict`). */
export function isSettingsConflict(error: { code?: string } | null | undefined): boolean {
  return error?.code === SETTINGS_CONFLICT_CODE
}

/** Extract the conflict revisions from a `settings-conflict` wire error. */
export function conflictDetailsOf(error: { code?: string; details?: unknown } | null | undefined):
  { expected: number; actual: number } | null {
  if (!isSettingsConflict(error)) return null
  const details = error?.details
  if (!isRecord(details) || typeof details.expected !== 'number' || typeof details.actual !== 'number') return null
  return { expected: details.expected, actual: details.actual }
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
 * never a live route probe (the section always appends the non-probing note).
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
    revision: 0,
    conflict: null,
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
  private view: SettingsNamespaceView | undefined
  /** Every settings namespace from the last describe, keyed by ns — the configured-provider join's other input. */
  private namespaces: Map<string, SettingsNamespaceView> = new Map()
  private currentSession: SessionId | undefined

  /** @param api - Settings / Llm / Sessions wire faces (the status block reads session history). */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'llm' | 'sessions'>) {}

  /**
   * Refresh the `fallbacks` descriptor. Latest request wins. The describe
   * response also carries every registered namespace, retained as the
   * configured-provider join's other input (re-derived into
   * `state.configuredProviders` whenever either side lands).
   * @returns nothing; {@link store} carries success or failure.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
      state.conflict = null
    })
    try {
      const response = await this.api.settings.describe({})
      if (generation !== this.generation) return
      if (!response.result.ok) throw response.result.error
      this.namespaces = new Map(response.result.value.namespaces.map(entry => [entry.ns, entry]))
      const view = response.result.value.namespaces.find(entry => entry.ns === FALLBACKS_SETTINGS_NS)
      if (view === undefined) {
        // Namespace not registered (readme-settings spec §1.4-3): keep the
        // 'unavailable' status — there is no server truth (no view/revision)
        // — but seed the spec defaults and follow the describe response's
        // writable flag instead of forcing `false`, so the page stays a
        // usable skeleton and a first config can be attempted.
        this.view = undefined
        const writable = response.result.value.writable
        this.store.update((state) => {
          state.status = 'unavailable'
          state.writable = writable
          state.config = defaultFallbacksConfig
          state.revision = 0
          state.error = null
          state.configuredProviders = configuredProvidersOf(state.providers, this.namespaces)
        })
        return
      }
      this.accept(view, response.result.value.writable)
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
   * Persist the full edited configuration via `settings.update` (merge
   * semantics). With a descriptor view the write carries `view.revision` so a
   * stale editor is refused rather than silently overwriting a concurrent
   * change; without a view (namespace never registered) `expectedRevision` is
   * omitted — a precondition-less write whose acceptance is the host's call
   * (readme-settings spec §1.4-2).
   * @param next - the complete edited configuration.
   */
  async save(next: FallbacksConfig): Promise<void> {
    const view = this.view
    const state = this.store.getSnapshot()
    if (!state.writable || state.status === 'saving') return
    const generation = ++this.generation
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
      draft.conflict = null
    })
    try {
      const response = await this.api.settings.update({
        ns: FALLBACKS_SETTINGS_NS,
        patch: next as unknown as object,
        ...(view === undefined ? {} : { expectedRevision: view.revision }),
      })
      if (generation !== this.generation) return
      if (!response.result.ok) throw response.result.error
      this.accept(response.result.value, true)
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error)
    }
  }

  /**
   * Reset the namespace's user section wholesale via `settings.replace`
   * (`section: {}` resets to composition defaults — the removal path a merge
   * cannot express). `expectedRevision` rides along when a view exists and is
   * omitted otherwise, mirroring {@link save}'s namespace-missing policy.
   */
  async resetToDefaults(): Promise<void> {
    const view = this.view
    const state = this.store.getSnapshot()
    if (!state.writable || state.status === 'saving') return
    const generation = ++this.generation
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
      draft.conflict = null
    })
    try {
      const response = await this.api.settings.replace({
        ns: FALLBACKS_SETTINGS_NS,
        section: {},
        ...(view === undefined ? {} : { expectedRevision: view.revision }),
      })
      if (generation !== this.generation) return
      if (!response.result.ok) throw response.result.error
      this.accept(response.result.value, true)
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
    this.view = undefined
    this.namespaces = new Map()
  }

  private accept(view: SettingsNamespaceView, writable: boolean): void {
    const config = parseFallbacksConfig(view.value)
    this.view = view
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.config = config
      state.revision = view.revision
      state.conflict = null
      state.configuredProviders = configuredProvidersOf(state.providers, this.namespaces)
    })
  }

  private fail(error: unknown): void {
    const wire = error as { code?: string; details?: unknown; message?: string } | null
    this.store.update((state) => {
      state.status = 'error'
      state.error = typeof wire?.message === 'string' ? wire.message : messageOf(error)
      state.conflict = isSettingsConflict(wire) ? conflictDetailsOf(wire) : null
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
