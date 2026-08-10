/**
 * Client-half store unit tests (plan Task 5, Validation Plan client row).
 *
 * Covers the testable client surface: descriptor parsing (the redactSecrets
 * read face — `view.value` folded against spec §4 defaults, malformed
 * descriptors rejected), the `settings-conflict` wire-error recognition and
 * revision extraction, the chain/rule row editors' pure round-trips, and the
 * controller's load/save/reset lifecycle (expectedRevision writes, conflict
 * presentation, generation guards). Component rendering has no DOM test
 * environment here — the section's build-level validation is the client
 * bundle (build-client) + tsc; runtime UI verification lands with T8.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { KNOWN_TRIGGER_CODES, TRIGGER_CODE_LABELS } from '../src/client/locales.ts'
import { apply as applyClient } from '../src/client/index.ts'
import {
  chainsToRows,
  classifyModel,
  classifyProvider,
  conflictDetailsOf,
  FallbacksSettingsController,
  isSettingsConflict,
  parseFallbacksConfig,
  refreshCatalogIfLoaded,
  rowsToChains,
  rowsToRules,
  rulesToRows,
  selectorRowToRaw,
  FALLBACKS_SETTINGS_NS,
  type CatalogLookup,
} from '../src/client/fallbacks-store.ts'

/** Build a fallbacks descriptor view with spec-default value unless overridden. */
function viewOf(overrides: Partial<SettingsNamespaceView> = {}): SettingsNamespaceView {
  return {
    ns: FALLBACKS_SETTINGS_NS,
    schema: {},
    value: defaultFallbacksConfig,
    applies: 'live',
    secrets: [],
    revision: 1,
    ...overrides,
  }
}

/** A settings + llm wire face whose methods are spies (real `IApiClient` also carries `openDocument`). */
function makeApi() {
  return {
    settings: {
      describe: vi.fn(),
      openDocument: vi.fn(),
      update: vi.fn(),
      replace: vi.fn(),
      mutate: vi.fn(),
    },
    llm: {
      providers: vi.fn(),
      models: vi.fn(),
      discoverModels: vi.fn(),
    },
  }
}

/** A catalog fixture: two providers, one with advertised models, one without. */
function catalogFixture(): CatalogLookup {
  return {
    providers: [
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: [], active: true },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-providers', settingsPath: [], active: true },
    ],
    groups: [
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'o3', name: 'o3' }] },
    ],
  }
}

function ok(value: unknown) {
  return { result: { ok: true, value } }
}

function error(code: string, message: string, details?: unknown) {
  return { result: { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } } }
}

describe('parseFallbacksConfig (descriptor read, redactSecrets face)', () => {
  it('passes a complete config through unchanged', () => {
    const config: FallbacksConfig = {
      enabled: false,
      triggerCodes: ['AUTH'],
      chains: { default: ['openai/gpt-4o', 'openai/*'] },
      roles: { default: 'reviewer', rules: [{ origin: 'subagent', provider: 'openai', role: 'reviewer' }] },
      cooldownMs: 60_000,
      revertPolicy: 'never',
      maxSwitchesPerStep: 4,
      alwaysModeRetryCap: 0,
    }
    expect(parseFallbacksConfig(config)).toEqual(config)
  })

  it('folds spec §4 defaults for missing optional fields', () => {
    const parsed = parseFallbacksConfig({})
    expect(parsed).toEqual(defaultFallbacksConfig)
  })

  it('drops unknown extra fields and keeps only declared keys', () => {
    const parsed = parseFallbacksConfig({ enabled: false, extra: 'junk' })
    expect(parsed).toEqual({ ...defaultFallbacksConfig, enabled: false })
    expect('extra' in parsed).toBe(false)
  })

  it('rejects a non-object descriptor value', () => {
    expect(() => parseFallbacksConfig('nope')).toThrow(TypeError)
    expect(() => parseFallbacksConfig(null)).toThrow(TypeError)
    expect(() => parseFallbacksConfig([])).toThrow(TypeError)
  })

  it('rejects malformed typed fields', () => {
    expect(() => parseFallbacksConfig({ triggerCodes: 'AUTH' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ triggerCodes: [1] })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ chains: { default: 'gpt-4o' } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { rules: [{ provider: 'openai' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { rules: [{ origin: 'host', role: 'x' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ revertPolicy: 'sometimes' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ cooldownMs: 'soon' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ enabled: 'yes' })).toThrow(TypeError)
  })
})

describe('settings-conflict recognition', () => {
  it('recognizes the settings-conflict wire code', () => {
    expect(isSettingsConflict({ code: 'settings-conflict' })).toBe(true)
    expect(isSettingsConflict({ code: 'settings-rejected' })).toBe(false)
    expect(isSettingsConflict(null)).toBe(false)
    expect(isSettingsConflict(undefined)).toBe(false)
  })

  it('extracts expected/actual revisions from the wire details', () => {
    const details = conflictDetailsOf({
      code: 'settings-conflict',
      details: { ns: 'fallbacks', expected: 1, actual: 3 },
    })
    expect(details).toEqual({ expected: 1, actual: 3 })
  })

  it('returns null for non-conflict or malformed details', () => {
    expect(conflictDetailsOf({ code: 'settings-rejected', details: {} })).toBeNull()
    expect(conflictDetailsOf({ code: 'settings-conflict', details: {} })).toBeNull()
  })
})

describe('chain/role row editors (pure round-trips)', () => {
  it('round-trips chains through selector rows; empty keys drop out', () => {
    const chains = { default: ['openai/gpt-4o', 'openai/*'], 'anthropic/*': ['anthropic/claude-3-5-sonnet'] }
    const rows = chainsToRows(chains)
    expect(rows).toHaveLength(2)
    expect(rowsToChains(rows)).toEqual(chains)
    // An empty key row (and an empty selector row) must not leak into output.
    expect(rowsToChains([...rows, {
      key: '   ',
      selectors: [{ wildcard: false, provider: null, model: null }],
    }])).toEqual(chains)
  })

  it('serializes selector rows to provider/model and provider/* wire strings', () => {
    expect(selectorRowToRaw({ wildcard: false, provider: { kind: 'catalog', id: 'openai' }, model: { kind: 'catalog', id: 'gpt-4o' } }))
      .toBe('openai/gpt-4o')
    expect(selectorRowToRaw({ wildcard: true, provider: { kind: 'catalog', id: 'openai' }, model: null }))
      .toBe('openai/*')
    // Outside raw values serialize verbatim.
    expect(selectorRowToRaw({ wildcard: false, provider: { kind: 'outside', raw: 'other' }, model: { kind: 'outside', raw: 'gpt-4o' } }))
      .toBe('other/gpt-4o')
    // A row with no provider serializes to '' (dropped).
    expect(selectorRowToRaw({ wildcard: false, provider: null, model: null })).toBe('')
  })

  it('round-trips role rules through rows; empty optional fields drop out', () => {
    const rules = [
      { origin: 'subagent' as const, provider: 'openai', model: '', role: 'reviewer' },
      { origin: undefined, provider: undefined, model: undefined, role: 'default' },
    ]
    const rows = rulesToRows(rules)
    expect(rows[0]).toEqual({ origin: 'subagent', provider: { kind: 'outside', raw: 'openai' }, model: null, role: 'reviewer' })
    expect(rows[1]).toEqual({ origin: '', provider: null, model: null, role: 'default' })
    expect(rowsToRules(rows)).toEqual([
      { origin: 'subagent', provider: 'openai', role: 'reviewer' },
      { role: 'default' },
    ])
  })
})

describe('catalog classification (spec §2.5 D-3)', () => {
  it('classifies catalog provider/model ids as catalog selections', () => {
    const catalog = catalogFixture()
    expect(classifyProvider('openai', catalog)).toEqual({ kind: 'catalog', id: 'openai' })
    expect(classifyModel('openai', 'gpt-4o', catalog)).toEqual({ kind: 'catalog', id: 'gpt-4o' })
  })

  it('keeps out-of-catalog values verbatim as outside selections', () => {
    const catalog = catalogFixture()
    // Unknown provider; known provider with an unknown model.
    expect(classifyProvider('other', catalog)).toEqual({ kind: 'outside', raw: 'other' })
    expect(classifyModel('openai', 'gpt-5', catalog)).toEqual({ kind: 'outside', raw: 'gpt-5' })
    // A model id another provider advertises is still outside under this provider.
    expect(classifyModel('anthropic', 'gpt-4o', catalog)).toEqual({ kind: 'outside', raw: 'gpt-4o' })
  })

  it('classifies everything as outside when no catalog is available yet', () => {
    expect(classifyProvider('openai', undefined)).toEqual({ kind: 'outside', raw: 'openai' })
    expect(classifyModel('openai', 'gpt-4o', undefined)).toEqual({ kind: 'outside', raw: 'gpt-4o' })
  })

  it('round-trips chains with outside values losslessly (D-3 mixed dropdown carrier)', () => {
    const catalog = catalogFixture()
    const chains = {
      default: ['other/gpt-4o', 'openai/gpt-4o', 'openai/*', 'anthropic/claude-3-5-sonnet'],
    }
    const rows = chainsToRows(chains, catalog)
    const defaultSelectors = rows[0]!.selectors
    // Unknown provider → both parts outside, verbatim.
    expect(defaultSelectors[0]).toEqual({
      wildcard: false,
      provider: { kind: 'outside', raw: 'other' },
      model: { kind: 'outside', raw: 'gpt-4o' },
    })
    // Known provider + known model → catalog.
    expect(defaultSelectors[1]).toEqual({
      wildcard: false,
      provider: { kind: 'catalog', id: 'openai' },
      model: { kind: 'catalog', id: 'gpt-4o' },
    })
    // Wildcard entry → model null.
    expect(defaultSelectors[2]).toEqual({ wildcard: true, provider: { kind: 'catalog', id: 'openai' }, model: null })
    // Round-trip: the original strings come back unchanged.
    expect(rowsToChains(rows)).toEqual(chains)
  })

  it('round-trips role rules with outside values losslessly', () => {
    const catalog = catalogFixture()
    const rules = [
      { origin: 'root' as const, provider: 'other', model: 'gpt-4o', role: 'x' },
      { role: 'y', provider: 'openai', model: 'gpt-4o' },
    ]
    const rows = rulesToRows(rules, catalog)
    expect(rows[0]).toEqual({ origin: 'root', provider: { kind: 'outside', raw: 'other' }, model: { kind: 'outside', raw: 'gpt-4o' }, role: 'x' })
    expect(rows[1]).toEqual({ origin: '', provider: { kind: 'catalog', id: 'openai' }, model: { kind: 'catalog', id: 'gpt-4o' }, role: 'y' })
    expect(rowsToRules(rows)).toEqual(rules)
  })

  it('preserves a malformed legacy chain entry verbatim instead of dropping it', () => {
    // A selector line that never matched `provider/model` keeps its raw text
    // as a bare outside value — the runtime config-warning path is unchanged.
    const rows = chainsToRows({ default: ['gpt-4o'] }, catalogFixture())
    expect(rows[0]!.selectors[0]).toEqual({ wildcard: false, provider: { kind: 'outside', raw: 'gpt-4o' }, model: null })
    expect(rowsToChains(rows)).toEqual({ default: ['gpt-4o'] })
  })
})

describe('FallbacksSettingsController', () => {
  it('loads the descriptor into a ready state', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [viewOf({ value: { ...defaultFallbacksConfig, enabled: false }, revision: 7 })],
    }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.revision).toBe(7)
    expect(state.config.enabled).toBe(false)
    expect(api.settings.describe).toHaveBeenCalledWith({})
  })

  it('seeds defaults and follows writable when the namespace is missing (unavailable, not a dead end)', async () => {
    // readme-settings spec §1.4-3: the 'unavailable' status is kept — there is
    // no server truth (no view/revision) — but the page must stay a usable
    // skeleton: spec-default seed + writable following the describe response.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('unavailable')
    expect(state.writable).toBe(true)
    expect(state.config).toEqual(defaultFallbacksConfig)
    expect(state.revision).toBe(0)
    expect(state.error).toBeNull()
  })

  it('keeps a read-only environment honest: missing namespace + writable:false stays disabled', async () => {
    // §1.4-4: only a real read-only describe response disables the controls —
    // the always-visible skeleton must not weaken honest read-only rendering.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: false, hasDocument: false, namespaces: [] }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('unavailable')
    expect(state.writable).toBe(false)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('surfaces a failed describe as an error state', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(error('settings-rejected', 'read refused', { ns: 'fallbacks' }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('read refused')
    expect(state.conflict).toBeNull()
  })

  it('saves a full config via settings.update with expectedRevision', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [viewOf({ revision: 4 })] }))
    api.settings.update.mockResolvedValue(ok(viewOf({ value: { ...defaultFallbacksConfig, cooldownMs: 99_000 }, revision: 5 })))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    expect(api.settings.update).toHaveBeenCalledWith({
      ns: 'fallbacks',
      patch: { ...defaultFallbacksConfig, cooldownMs: 99_000 },
      expectedRevision: 4,
    })
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.revision).toBe(5)
    expect(state.config.cooldownMs).toBe(99_000)
  })

  it('presents a settings-conflict write as a conflict state with revisions', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [viewOf({ revision: 4 })] }))
    api.settings.update.mockResolvedValue(error(
      'settings-conflict',
      'changed since read',
      { ns: 'fallbacks', expected: 4, actual: 6 },
    ))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.conflict).toEqual({ expected: 4, actual: 6 })
    expect(state.error).toBe('changed since read')
  })

  it('surfaces a non-conflict write failure without a conflict record', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [viewOf()] }))
    api.settings.update.mockResolvedValue(error('settings-rejected', 'schema violation', { ns: 'fallbacks' }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.conflict).toBeNull()
    expect(state.error).toBe('schema violation')
  })

  it('resets to defaults via settings.replace with an empty section', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [viewOf({ revision: 2 })] }))
    api.settings.replace.mockResolvedValue(ok(viewOf({ value: defaultFallbacksConfig, revision: 3 })))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.resetToDefaults()
    expect(api.settings.replace).toHaveBeenCalledWith({ ns: 'fallbacks', section: {}, expectedRevision: 2 })
    expect(controller.store.getSnapshot().revision).toBe(3)
  })

  it('refuses writes when the provider is not writable', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: false, hasDocument: false, namespaces: [viewOf()] }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    await controller.resetToDefaults()
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(api.settings.replace).not.toHaveBeenCalled()
  })

  it('attempts a precondition-less write when the namespace is missing but writable (spec §1.4-2)', async () => {
    // No view → expectedRevision is omitted (no precondition); the host's
    // acceptance lands the store in ready with a real view/revision.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    api.settings.update.mockResolvedValue(ok(viewOf({ value: defaultFallbacksConfig, revision: 1 })))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    expect(api.settings.update).toHaveBeenCalledTimes(1)
    const write = api.settings.update.mock.calls[0]![0] as Record<string, unknown>
    expect(write.ns).toBe('fallbacks')
    expect(write.patch).toEqual(defaultFallbacksConfig)
    expect(write).not.toHaveProperty('expectedRevision')
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.revision).toBe(1)
  })

  it('resets via settings.replace with no expectedRevision when the namespace is missing but writable (spec §1.4-2)', async () => {
    // resetToDefaults mirrors save()'s precondition-less policy: no view →
    // expectedRevision is omitted (no precondition); the host's acceptance
    // lands the store in ready with a real view/revision.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    api.settings.replace.mockResolvedValue(ok(viewOf({ value: defaultFallbacksConfig, revision: 1 })))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.resetToDefaults()
    expect(api.settings.replace).toHaveBeenCalledTimes(1)
    const write = api.settings.replace.mock.calls[0]![0] as Record<string, unknown>
    expect(write.ns).toBe('fallbacks')
    expect(write.section).toEqual({})
    expect(write).not.toHaveProperty('expectedRevision')
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.revision).toBe(1)
  })

  it('surfaces a host refusal of a precondition-less write as an error (spec §1.4-2)', async () => {
    // The host says no (unregistered namespace / read refusal): the error
    // state + banner render honestly — the skeleton and draft survive.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    api.settings.update.mockResolvedValue(error('settings-rejected', 'namespace not registered', { ns: 'fallbacks' }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('namespace not registered')
    expect(state.conflict).toBeNull()
  })

  it('drops in-flight responses after dispose (generation guard)', async () => {
    const api = makeApi()
    let resolveDescribe: (value: unknown) => void = () => {}
    api.settings.describe.mockReturnValue(new Promise(resolve => { resolveDescribe = resolve }))
    const controller = new FallbacksSettingsController(api)
    const loading = controller.load()
    controller.dispose()
    resolveDescribe(ok({ writable: true, hasDocument: false, namespaces: [viewOf({ revision: 9 })] }))
    await loading
    const state = controller.store.getSnapshot()
    // The stale response never published: the store stays on the loading
    // state it was left in, with the initial revision (never accepted).
    expect(state.status).not.toBe('ready')
    expect(state.revision).toBe(0)
  })

  it('loads the provider directory and model groups into the catalog snapshot (D-4)', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
    const controller = new FallbacksSettingsController(api)
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.catalogStatus).toBe('ready')
    expect(state.catalogError).toBeNull()
    expect(state.providers).toEqual(catalogFixture().providers)
    expect(state.groups).toEqual(catalogFixture().groups)
    expect(state.catalogEpoch).toBe(1)
    // The catalog read never touches the settings side of the store.
    expect(state.status).toBe('idle')
    expect(api.llm.providers).toHaveBeenCalledWith({})
    expect(api.llm.models).toHaveBeenCalledWith({})
  })

  it('keeps sound groups usable and reports per-provider failures as a diagnostic (D-4)', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    api.llm.models.mockResolvedValue(ok({
      groups: catalogFixture().groups,
      failures: [{ id: 'anthropic', name: 'Anthropic', message: 'lookup refused' }],
    }))
    const controller = new FallbacksSettingsController(api)
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.catalogStatus).toBe('ready')
    expect(state.groups).toEqual(catalogFixture().groups)
    expect(state.catalogError).toContain('Anthropic')
    expect(state.catalogError).toContain('lookup refused')
  })

  it('marks the catalog errored on a failed read without blocking the settings state', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(error('llm-rejected', 'directory read refused'))
    const controller = new FallbacksSettingsController(api)
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.catalogStatus).toBe('error')
    expect(state.catalogError).toBe('directory read refused')
    // Settings status untouched: the form keeps editing/saving normally.
    expect(state.status).toBe('idle')
    expect(state.writable).toBe(false)
  })

  it('accepts an empty catalog as ready (empty-state guidance, not an error)', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(ok({ providers: [] }))
    api.llm.models.mockResolvedValue(ok({ groups: [], failures: [] }))
    const controller = new FallbacksSettingsController(api)
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.catalogStatus).toBe('ready')
    expect(state.catalogError).toBeNull()
    expect(state.providers).toEqual([])
    expect(state.groups).toEqual([])
  })

  it('guards catalog refreshes on load with an independent generation (models/changed)', async () => {
    const api = makeApi()
    let resolveModels: (value: unknown) => void = () => {}
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    api.llm.models.mockReturnValue(new Promise(resolve => { resolveModels = resolve }))
    const controller = new FallbacksSettingsController(api)
    const first = controller.loadCatalog()
    controller.dispose()
    resolveModels(ok({ groups: catalogFixture().groups, failures: [] }))
    await first
    const state = controller.store.getSnapshot()
    // The stale catalog response never published after dispose.
    expect(state.catalogStatus).not.toBe('ready')
    expect(state.catalogEpoch).toBe(0)
  })

  it('refreshCatalogIfLoaded skips an idle catalog and refreshes an opened one', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
    const controller = new FallbacksSettingsController(api)
    // Idle → no refetch.
    refreshCatalogIfLoaded(controller)
    expect(api.llm.providers).not.toHaveBeenCalled()
    await controller.loadCatalog()
    expect(api.llm.providers).toHaveBeenCalledTimes(1)
    // Opened (ready) → refetches.
    refreshCatalogIfLoaded(controller)
    expect(api.llm.providers).toHaveBeenCalledTimes(2)
  })
})

describe('known trigger codes (M-04 single source)', () => {
  it('derives the toggle set from the host defaults', () => {
    expect(KNOWN_TRIGGER_CODES).toEqual(defaultFallbacksConfig.triggerCodes)
  })

  it('labels every derived code', () => {
    for (const code of KNOWN_TRIGGER_CODES) {
      expect(TRIGGER_CODE_LABELS[code]).toBeDefined()
    }
  })
})

describe('client apply disposal wiring (F-006 / M-01)', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('stops in-flight settings responses from publishing after the fiber is disposed', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Connection service double: a controllable settings.describe.
    let resolveDescribe: (value: unknown) => void = () => {}
    const describe = vi.fn(() => new Promise<unknown>(resolve => { resolveDescribe = resolve }))
    ctx.provide('connection', {
      api: { settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() } },
    })
    // Slots service double: run the section-registration thunk and capture the
    // injected controller — the seam apply() uses to hand the controller over.
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => unknown) => { thunk() },
      register: (options: { inject: () => unknown }) => {
        controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()

    // A load is in flight when the plugin unloads (HMR / dispose).
    const loading = controller!.load()
    await ctx.fiber.dispose()
    // The response arrives after unload: the dispose wiring must bump the
    // generation so the stale response never publishes to the dead store.
    resolveDescribe(ok({ writable: true, hasDocument: false, namespaces: [viewOf({ revision: 9 })] }))
    await loading
    const state = controller!.store.getSnapshot()
    expect(state.status).not.toBe('ready')
    expect(state.revision).toBe(0)
  })

  it('models/changed refreshes only the catalog, never the settings (D-4)', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Connection service double: controllable settings.describe + llm catalog.
    const describe = vi.fn()
    const providers = vi.fn()
    const models = vi.fn()
    ctx.provide('connection', {
      api: {
        settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers, models, discoverModels: vi.fn() },
      },
    })
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => unknown) => { thunk() },
      register: (options: { inject: () => unknown }) => {
        controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok({ providers: [] }))
    models.mockResolvedValue(ok({ groups: [], failures: [] }))
    await controller!.loadCatalog()
    expect(providers).toHaveBeenCalledTimes(1)

    // A pushed models/changed refetches the catalog and leaves the settings
    // descriptor untouched.
    ctx.emit('models/changed' as never)
    await Promise.resolve()
    expect(providers).toHaveBeenCalledTimes(2)
    expect(describe).not.toHaveBeenCalled()
  })
})
