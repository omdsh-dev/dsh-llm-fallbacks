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
  IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  defaultFallbacksConfig, type FallbacksConfig, type FallbacksRoleRule,
} from '../config.ts'

/** The plugin's settings namespace on the host wire. */
export const FALLBACKS_SETTINGS_NS = 'fallbacks'

/** Stable wire code of a refused stale-revision write (rpc.d.ts mirror). */
export const SETTINGS_CONFLICT_CODE = 'settings-conflict'

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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** Split a chains textarea into trimmed, non-empty selector lines. */
export function parseEntryLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
}

/** Join ordered selectors into one textarea body. */
export function formatEntries(entries: readonly string[]): string {
  return entries.join('\n')
}

/** One chain row in the editor: key + the entries textarea body. */
export interface ChainRow {
  key: string
  entries: string
}

/** Project the chains record into editable rows (one textarea body per key). */
export function chainsToRows(chains: Record<string, string[]>): ChainRow[] {
  return Object.entries(chains).map(([key, entries]) => ({ key, entries: formatEntries(entries) }))
}

/** Rebuild the chains record from edited rows; empty keys drop out. */
export function rowsToChains(rows: readonly ChainRow[]): Record<string, string[]> {
  const chains: Record<string, string[]> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    chains[key] = parseEntryLines(row.entries)
  }
  return chains
}

/** One role-rule row in the editor; empty origin means "any". */
export interface RoleRuleRow {
  origin: string
  provider: string
  model: string
  role: string
}

/** Project the role rules into editable rows. */
export function rulesToRows(rules: readonly FallbacksRoleRule[]): RoleRuleRow[] {
  return rules.map(rule => ({
    origin: rule.origin ?? '',
    provider: rule.provider ?? '',
    model: rule.model ?? '',
    role: rule.role,
  }))
}

/** Rebuild the role rules from edited rows; empty origin/provider/model drop out. */
export function rowsToRules(rows: readonly RoleRuleRow[]): FallbacksRoleRule[] {
  return rows
    .map(row => ({
      ...(row.origin === '' ? {} : { origin: row.origin as 'root' | 'subagent' }),
      ...(row.provider.trim() === '' ? {} : { provider: row.provider.trim() }),
      ...(row.model.trim() === '' ? {} : { model: row.model.trim() }),
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
  })

  private generation = 0
  private view: SettingsNamespaceView | undefined

  /** @param api - Settings wire face. */
  constructor(private readonly api: Pick<IApiClient, 'settings'>) {}

  /**
   * Refresh the `fallbacks` descriptor. Latest request wins.
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
    this.view = undefined
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
