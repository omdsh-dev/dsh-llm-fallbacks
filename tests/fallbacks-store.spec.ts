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

import { describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import {
  chainsToRows,
  conflictDetailsOf,
  FallbacksSettingsController,
  formatEntries,
  isSettingsConflict,
  parseEntryLines,
  parseFallbacksConfig,
  rowsToChains,
  rowsToRules,
  rulesToRows,
  FALLBACKS_SETTINGS_NS,
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

/** A settings wire face whose methods are spies. */
function makeApi() {
  return {
    settings: {
      describe: vi.fn(),
      update: vi.fn(),
      replace: vi.fn(),
      mutate: vi.fn(),
    },
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
  it('splits entry textarea bodies into trimmed non-empty lines', () => {
    expect(parseEntryLines('  openai/gpt-4o \n\nanthropic/*\n')).toEqual(['openai/gpt-4o', 'anthropic/*'])
    expect(formatEntries(['a', 'b'])).toBe('a\nb')
  })

  it('round-trips chains through rows; empty keys drop out', () => {
    const chains = { default: ['openai/gpt-4o', 'openai/*'], 'anthropic/*': ['anthropic/claude-3-5-sonnet'] }
    const rows = chainsToRows(chains)
    expect(rows).toHaveLength(2)
    expect(rowsToChains(rows)).toEqual(chains)
    expect(rowsToChains([...rows, { key: '   ', entries: 'openai/gpt-4o' }])).toEqual(chains)
  })

  it('round-trips role rules through rows; empty optional fields drop out', () => {
    const rules = [
      { origin: 'subagent' as const, provider: 'openai', model: '', role: 'reviewer' },
      { origin: undefined, provider: undefined, model: undefined, role: 'default' },
    ]
    const rows = rulesToRows(rules)
    expect(rows[0]).toEqual({ origin: 'subagent', provider: 'openai', model: '', role: 'reviewer' })
    expect(rows[1]).toEqual({ origin: '', provider: '', model: '', role: 'default' })
    expect(rowsToRules(rows)).toEqual([
      { origin: 'subagent', provider: 'openai', role: 'reviewer' },
      { role: 'default' },
    ])
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

  it('reports unavailable when the namespace is missing from the descriptor', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('unavailable')
    expect(state.writable).toBe(false)
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

  it('refuses writes when the namespace is missing or not writable', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: false, hasDocument: false, namespaces: [viewOf()] }))
    const controller = new FallbacksSettingsController(api)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    await controller.resetToDefaults()
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(api.settings.replace).not.toHaveBeenCalled()
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
})
