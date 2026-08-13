/**
 * Client-half store unit tests (plan Task 5 + llm-fallbacks-settings-gateway
 * Task 2, Validation Plan client row).
 *
 * Covers the testable client surface: config parsing (the gateway `config`
 * value folded against spec §4 defaults, malformed values rejected), the
 * rootChain/role/rule row editors' pure round-trips, and the controller's
 * load/save/reset lifecycle over the plugin gateway channel — a fake
 * `connection.rpc` for `/api/fallbacks/get|set|reset` plus `api` mocks for
 * describe (writable + namespace directory) / llm catalog / session history.
 * The `settings-conflict` branch is gone (KD-G3): set/reset failures surface
 * the message in the error banner state, and a get failure is the
 * channel-unreachable `present: false` skeleton (KD-G5), never a page error.
 * Component rendering has no DOM test environment here — the section's
 * build-level validation is the client bundle (build-client) + tsc; runtime
 * UI verification lands with T8.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientConnectionRpc, HistoryEntry, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'
import { KNOWN_TRIGGER_CODES, TRIGGER_CODE_LABELS } from '../src/client/locales.ts'
import { apply as applyClient } from '../src/client/index.ts'
import {
  classifyModel,
  classifyProvider,
  configuredProvidersOf,
  deriveEffectiveModel,
  detectLegacyClientKeys,
  extractRecentSwitches,
  FALLBACKS_SETTINGS_NS,
  FallbacksSettingsController,
  parseFallbacksConfig,
  refreshCatalogIfLoaded,
  refreshFallbacksIfLoaded,
  refreshSwitchesIfLoaded,
  rolesToRows,
  rootChainToRows,
  rowsToRoles,
  rowsToRootChain,
  rowsToRules,
  ruleRoleOptions,
  rulesToRows,
  selectorRowToRaw,
  RECENT_SWITCH_LIMIT,
  SWITCHES_HISTORY_PAGE,
  type CatalogLookup,
  type FallbacksSwitchSnapshot,
  type RoleRow,
  type RootChainRow,
} from '../src/client/fallbacks-store.ts'

/** One gateway RPC success (the channel returns the unwrapped result). */
function okResult<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** One gateway RPC failure. */
function failResult(message: string): { ok: false; error: { code: string; message: string; details: object } } {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * A scripted gateway RPC face for the `/api/fallbacks` channel.
 * `config: null` = the channel is down (get fails — the KD-G5 notice path).
 * The fake `set`/`reset` fold the write into the effective config exactly
 * like the host gateway (merge / clear-user-layer → new composed config), so
 * a follow-up get/accept reflects the write.
 */
function makeRpc(config?: FallbacksConfig | null) {
  let current = config === undefined ? defaultFallbacksConfig : config
  const get = vi.fn(() => Promise.resolve(
    current === null
      ? failResult('fallbacks gateway is not ready')
      : okResult({ config: current }),
  ))
  const set = vi.fn((payload: { args: { patch: FallbacksConfig } }) => {
    if (current === null) throw new Error('test: set on an unavailable gateway')
    current = payload.args.patch
    return Promise.resolve(okResult({ config: current }))
  })
  const reset = vi.fn(() => {
    if (current === null) throw new Error('test: reset on an unavailable gateway')
    current = defaultFallbacksConfig
    return Promise.resolve(okResult({ config: current }))
  })
  const call = vi.fn((channel: string, endpoint: string, payload: unknown) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'fallbacks/get') return get()
    if (endpoint === 'fallbacks/set') return set(payload as { args: { patch: FallbacksConfig } })
    if (endpoint === 'fallbacks/reset') return reset()
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, reset,
  }
}

/** A settings + llm + sessions wire face whose methods are spies (real `IApiClient` also carries `openDocument`). */
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
    sessions: {
      history: vi.fn(),
    },
  }
}

/**
 * A `remote` service double for the client apply wiring: records `$on`
 * subscriptions (returning per-event disposers, tracked for teardown
 * assertions) and dispatches the forwarded remote events
 * (`settings/document-updated`, `llm/adapters-updated`) through the recorded
 * listener, mirroring the gateway's one-way delivery. One `Set` per event
 * (qc2 S-5 / qc3 S-3): `Map.set` silently overwrote an earlier listener, so
 * a regressed duplicate `$on` registration would pass; the Set plus the
 * single-listener emit guard make any double subscription fail loudly.
 */
function makeRemote() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const disposers: Array<{ invoked: boolean }> = []
  const $on = vi.fn((event: string, listener: (...args: unknown[]) => void): (() => void) => {
    const set = listeners.get(event) ?? new Set<(...args: unknown[]) => void>()
    set.add(listener)
    listeners.set(event, set)
    const entry = { invoked: false }
    disposers.push(entry)
    return () => {
      set.delete(listener)
      entry.invoked = true
    }
  })
  return {
    remote: { $on } as { $on: typeof $on },
    $on,
    emit(event: string, ...args: unknown[]): void {
      const set = listeners.get(event)
      if (set === undefined || set.size === 0) {
        throw new Error(`test: no listener for remote event ${event}`)
      }
      if (set.size !== 1) {
        throw new Error(`test: ${set.size} listeners for remote event ${event} — duplicate $on registration`)
      }
      for (const listener of set) listener(...args)
    },
    disposers,
  }
}

/** One `fallbacks/switch` history entry with a deterministic seq/time. */
function switchEntry(seq: number, overrides: Partial<FallbacksSwitchEventData> = {}): HistoryEntry {
  return {
    event: {
      type: 'fallbacks/switch',
      seq,
      time: 1_700_000_000_000 + seq * 1000,
      data: {
        turn: 1,
        step: 1,
        from: { provider: 'openai', model: 'gpt-4o' },
        to: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
        role: 'default',
        reason: 'trigger-code',
        ...overrides,
      },
    },
  } as HistoryEntry
}

/** A non-switch history entry (must be filtered out by the extraction). */
function otherEntry(seq: number, type = 'assistant/message'): HistoryEntry {
  return { event: { type, seq, time: 1_700_000_000_000, data: {} } } as unknown as HistoryEntry
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

/** A settings namespace view for a non-fallbacks section (the configured join's other input). */
function providerNs(ns: string, value: unknown): SettingsNamespaceView {
  return { ns, schema: {}, value, applies: 'live', secrets: [], revision: 1 }
}

/** A directory fixture exercising every configured-join branch. */
function configuredFixture() {
  return {
    providers: [
      { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: ['providers', 'openai'], active: true },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-providers', settingsPath: ['providers', 'anthropic'], active: true },
      { provider: 'google', displayName: 'Google', settingsNs: 'llm-providers', settingsPath: ['providers', 'google'], active: true },
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
      rootChain: ['openai/gpt-4o', 'openai/*'],
      roles: {
        list: [{
          id: 'reviewer',
          label: 'Reviewer',
          description: 'Deep review pass',
          chain: ['anthropic/claude-3-5-sonnet'],
          fallback: 'none',
        }],
        rules: [{ origin: 'subagent', provider: 'openai', role: 'reviewer' }],
      },
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
    expect(() => parseFallbacksConfig({ rootChain: 'openai/gpt-4o' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ rootChain: [1] })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ label: 'no id' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ id: 'a', chain: 'openai/gpt-4o' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ id: 'a', fallback: 'sometimes' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ id: 'a', permissions: { allow: 'read' } }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { rules: [{ provider: 'openai' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { rules: [{ origin: 'host', role: 'x' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ revertPolicy: 'sometimes' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ cooldownMs: 'soon' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ enabled: 'yes' })).toThrow(TypeError)
  })

  it('preserves schema-reserved prompt/permissions fields on a read (no row editing this round)', () => {
    const parsed = parseFallbacksConfig({
      roles: { list: [{ id: 'architect', label: 'A', description: 'D', prompt: 'think hard', permissions: { allow: ['files.read'] } }] },
    })
    expect(parsed.roles.list[0]).toEqual({
      id: 'architect',
      label: 'A',
      description: 'D',
      prompt: 'think hard',
      permissions: { allow: ['files.read'] },
      chain: [],
      fallback: 'inherit-root',
    })
  })
})

describe('rootChain/role/rule row editors (pure round-trips)', () => {
  it('round-trips the rootChain through one flat selector row; empty rows drop out', () => {
    const rootChain = ['openai/gpt-4o', 'openai/*']
    const rows = rootChainToRows(rootChain)
    expect(rows).toHaveLength(1)
    expect(rowsToRootChain(rows)).toEqual(rootChain)
    // A row with no selectors (and a row whose only selector is empty) must
    // not leak into output.
    const emptyRows: RootChainRow[] = [
      { selectors: [] },
      { selectors: [{ wildcard: false, provider: null, model: null }] },
    ]
    expect(rowsToRootChain([...rows, ...emptyRows])).toEqual(rootChain)
  })

  it('round-trips an empty rootChain as a single empty row (add-selector affordance)', () => {
    const rows = rootChainToRows([])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.selectors).toEqual([])
    expect(rowsToRootChain(rows)).toEqual([])
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

  it('round-trips declared role entities through rows (id/label/description/chain/fallback)', () => {
    const roles = [
      {
        id: 'reviewer',
        label: 'Reviewer',
        description: 'Deep review pass',
        chain: ['openai/gpt-4o', 'openai/*'],
        fallback: 'none' as const,
      },
      {
        id: 'architect',
        label: 'Architect',
        description: '',
        chain: [],
        fallback: 'inherit-root' as const,
      },
    ]
    const rows = rolesToRows(roles)
    expect(rows).toEqual<RoleRow[]>([
      {
        id: 'reviewer',
        label: 'Reviewer',
        description: 'Deep review pass',
        selectors: [
          { wildcard: false, provider: { kind: 'outside', raw: 'openai' }, model: { kind: 'outside', raw: 'gpt-4o' } },
          { wildcard: true, provider: { kind: 'outside', raw: 'openai' }, model: null },
        ],
        fallback: 'none',
      },
      { id: 'architect', label: 'Architect', description: '', selectors: [], fallback: 'inherit-root' },
    ])
    expect(rowsToRoles(rows)).toEqual(roles)
  })

  it('classifies a role chain against the catalog like any selector list', () => {
    const catalog = catalogFixture()
    const rows = rolesToRows([{ id: 'reviewer', label: 'R', description: '', chain: ['openai/gpt-4o'], fallback: 'inherit-root' }], catalog)
    expect(rows[0]!.selectors[0]).toEqual({
      wildcard: false,
      provider: { kind: 'catalog', id: 'openai' },
      model: { kind: 'catalog', id: 'gpt-4o' },
    })
    expect(rowsToRoles(rows)).toEqual([{ id: 'reviewer', label: 'R', description: '', chain: ['openai/gpt-4o'], fallback: 'inherit-root' }])
  })

  it('ruleRoleOptions offers the built-in inherit target plus every declared id in order', () => {
    expect(ruleRoleOptions({ list: [] })).toEqual(['inherit'])
    expect(ruleRoleOptions({ list: [{ id: 'reviewer', label: '', description: '' }, { id: 'architect', label: '', description: '' }] }))
      .toEqual(['inherit', 'reviewer', 'architect'])
    // The same page's role edits are reflected immediately (derived, never cached).
    expect(ruleRoleOptions({ list: [{ id: 'reviewer', label: '', description: '' }, { id: 'c', label: '', description: '' }] }))
      .toEqual(['inherit', 'reviewer', 'c'])
  })

  it('detectLegacyClientKeys flags undeclared rule role references (test fallback)', () => {
    // Declared refs + the built-in inherit target are clean.
    expect(detectLegacyClientKeys({
      ...defaultFallbacksConfig,
      roles: {
        list: [{ id: 'reviewer', label: '', description: '', chain: [], fallback: 'inherit-root' }],
        rules: [{ role: 'reviewer' }, { role: 'inherit' }],
      },
    })).toEqual([])
    // An undeclared rule role is the only legacy leftover that survives wire normalization.
    expect(detectLegacyClientKeys({
      ...defaultFallbacksConfig,
      roles: { list: [], rules: [{ role: 'reviewer' }] },
    })).toEqual(['roles.rules[].role: reviewer'])
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

  it('round-trips the rootChain with outside values losslessly (D-3 mixed dropdown carrier)', () => {
    const catalog = catalogFixture()
    const rootChain = ['other/gpt-4o', 'openai/gpt-4o', 'openai/*', 'anthropic/claude-3-5-sonnet']
    const rows = rootChainToRows(rootChain, catalog)
    const selectors = rows[0]!.selectors
    // Unknown provider → both parts outside, verbatim.
    expect(selectors[0]).toEqual({
      wildcard: false,
      provider: { kind: 'outside', raw: 'other' },
      model: { kind: 'outside', raw: 'gpt-4o' },
    })
    // Known provider + known model → catalog.
    expect(selectors[1]).toEqual({
      wildcard: false,
      provider: { kind: 'catalog', id: 'openai' },
      model: { kind: 'catalog', id: 'gpt-4o' },
    })
    // Wildcard entry → model null.
    expect(selectors[2]).toEqual({ wildcard: true, provider: { kind: 'catalog', id: 'openai' }, model: null })
    // Round-trip: the original strings come back unchanged.
    expect(rowsToRootChain(rows)).toEqual(rootChain)
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

  it('preserves a malformed entry verbatim instead of dropping it', () => {
    // A selector line that never matched `provider/model` keeps its raw text
    // as a bare outside value — the runtime config-warning path is unchanged.
    const rows = rootChainToRows(['gpt-4o'], catalogFixture())
    expect(rows[0]!.selectors[0]).toEqual({ wildcard: false, provider: { kind: 'outside', raw: 'gpt-4o' }, model: null })
    expect(rowsToRootChain(rows)).toEqual(['gpt-4o'])
  })
})

describe('extractRecentSwitches (spec §2.5 D-5 raw event face)', () => {
  it('filters only `fallbacks/switch` events out of a mixed page', () => {
    const entries = [
      otherEntry(3),
      switchEntry(5, { to: { provider: 'anthropic', model: 'claude-3-5-sonnet' } }),
      otherEntry(4, 'tool/result'),
      switchEntry(7, { to: { provider: 'google', model: 'gemini-2.0-flash' } }),
    ]
    const extracted = extractRecentSwitches(entries)
    expect(extracted).toHaveLength(2)
    expect(extracted.map(item => item.seq)).toEqual([7, 5])
  })

  it('orders by event seq descending (newest first)', () => {
    const entries = [switchEntry(2), switchEntry(10), switchEntry(5)]
    const extracted = extractRecentSwitches(entries)
    expect(extracted.map(item => item.seq)).toEqual([10, 5, 2])
  })

  it('carries the durable payload plus the raw seq and time', () => {
    const [item] = extractRecentSwitches([switchEntry(9, { role: 'reviewer', reason: 'always-cap' })])
    expect(item).toEqual<FallbacksSwitchSnapshot>({
      seq: 9,
      time: 1_700_000_000_000 + 9000,
      turn: 1,
      step: 1,
      from: { provider: 'openai', model: 'gpt-4o' },
      to: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      role: 'reviewer',
      reason: 'always-cap',
    })
  })

  it(`caps at the default N=${RECENT_SWITCH_LIMIT} (newest wins)`, () => {
    const entries = Array.from({ length: 9 }, (_, index) => switchEntry(index + 1))
    const extracted = extractRecentSwitches(entries)
    expect(extracted).toHaveLength(RECENT_SWITCH_LIMIT)
    expect(extracted.map(item => item.seq)).toEqual([9, 8, 7, 6, 5])
  })

  it('shows the actual count when the page holds fewer than N (no multi-page backfill)', () => {
    const extracted = extractRecentSwitches([switchEntry(3), switchEntry(1)])
    expect(extracted).toHaveLength(2)
    expect(extracted.map(item => item.seq)).toEqual([3, 1])
  })

  it('returns an empty list for a page without switch events', () => {
    expect(extractRecentSwitches([otherEntry(1), otherEntry(2)])).toEqual([])
    expect(extractRecentSwitches([])).toEqual([])
  })
})

describe('deriveEffectiveModel (spec §2.5 D-6 display value)', () => {
  const enabledConfig: FallbacksConfig = {
    ...defaultFallbacksConfig,
    enabled: true,
    rootChain: ['openai/gpt-4o', 'openai/*'],
  }

  it('① disabled → unavailable even when switches exist', () => {
    const view = deriveEffectiveModel(defaultFallbacksConfig, [{
      seq: 2, time: 1, turn: 1, step: 1,
      from: { provider: 'openai', model: 'gpt-4o' },
      to: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      role: 'default', reason: 'trigger-code',
    }])
    expect(view).toEqual({ kind: 'unavailable' })
  })

  it('① enabled with an empty rootChain → unavailable', () => {
    const config = { ...enabledConfig, rootChain: [] }
    expect(deriveEffectiveModel(config, [])).toEqual({ kind: 'unavailable' })
  })

  it('② a recent switch exists → the latest one\'s target (`to`)', () => {
    const switches: FallbacksSwitchSnapshot[] = [
      { seq: 9, time: 1, turn: 1, step: 1, from: { provider: 'openai', model: 'gpt-4o' }, to: { provider: 'google', model: 'gemini-2.0-flash' }, role: 'default', reason: 'always-cap' },
      { seq: 3, time: 1, turn: 1, step: 1, from: { provider: 'openai', model: 'gpt-4o' }, to: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, role: 'default', reason: 'trigger-code' },
    ]
    // The store keeps switches newest-first, so [0] is the latest.
    expect(deriveEffectiveModel(enabledConfig, switches)).toEqual({
      kind: 'switched',
      provider: 'google',
      model: 'gemini-2.0-flash',
    })
  })

  it('③ no switches → the config\'s primary target (first rootChain entry)', () => {
    expect(deriveEffectiveModel(enabledConfig, [])).toEqual({
      kind: 'config',
      provider: 'openai',
      model: 'gpt-4o',
    })
  })

  it('③ a wildcard first entry derives as provider/*', () => {
    const config = { ...enabledConfig, rootChain: ['anthropic/*'] }
    expect(deriveEffectiveModel(config, [])).toEqual({ kind: 'config', provider: 'anthropic', model: '*' })
  })

  it('③ a malformed first entry stays verbatim rather than mis-parsed', () => {
    const config = { ...enabledConfig, rootChain: ['gpt-4o'] }
    expect(deriveEffectiveModel(config, [])).toEqual({ kind: 'config', provider: 'gpt-4o', model: '*' })
  })
})

describe('FallbacksSettingsController', () => {
  it('loads the config over the gateway into a ready state (describe stays for writable + directory)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, call, get } = makeRpc({ ...defaultFallbacksConfig, enabled: false })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.present).toBe(true)
    expect(state.config.enabled).toBe(false)
    // describe is still called (writable + namespace directory)…
    expect(api.settings.describe).toHaveBeenCalledWith({})
    // …but the config itself rides the gateway channel, never describe.
    expect(call).toHaveBeenCalledWith('/api', 'fallbacks/get', { args: {} })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('keeps the usable skeleton when the gateway get fails (ok:false → present:false, not a dead end)', async () => {
    // KD-G5: a get failure (channel down / gateway not ready / no settings
    // service) is NOT a page error — the section shows the channel-unreachable
    // notice over the defaults skeleton; writable still follows describe.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc } = makeRpc(null)
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(false)
    expect(state.writable).toBe(true)
    expect(state.config).toEqual(defaultFallbacksConfig)
    expect(state.error).toBeNull()
  })

  it('keeps the usable skeleton when the gateway get throws (transport down → present:false)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockRejectedValueOnce(new Error('transport down'))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(false)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('preserves the accepted config when a follow-up get fails after a successful load (I-1)', async () => {
    // Draft seed invariant (I-1): `accept(undefined, …)` keeps the last
    // accepted config — a transient channel-down on a REFRESH must not
    // clobber real server truth with the defaults skeleton. The second
    // failed get lands present:false (channel-unreachable notice), never a
    // page error, and `state.config` stays exactly as loaded.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().present).toBe(true)
    expect(controller.store.getSnapshot().config.cooldownMs).toBe(99_000)
    // The channel drops before the next refresh's get resolves.
    get.mockReturnValueOnce(Promise.resolve(failResult('fallbacks gateway is not ready')))
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(false)
    expect(state.error).toBeNull()
    expect(state.config).toEqual({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
  })

  it('keeps a read-only environment honest: writable:false disables the controls', async () => {
    // §1.4-4: only a real read-only describe response disables the controls —
    // the always-visible skeleton must not weaken honest read-only rendering.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: false, hasDocument: false, namespaces: [] }))
    const { rpc } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.writable).toBe(false)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('surfaces a failed describe as a hard error state (no provider directory → no form)', async () => {
    // describe failure remains a hard error: the form cannot render
    // provider/model options without the directory (guide §9).
    const api = makeApi()
    api.settings.describe.mockResolvedValue(error('settings-rejected', 'read refused', { ns: 'fallbacks' }))
    const { rpc, call } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('read refused')
    // The gateway get ran in parallel (Promise.all) — its result is
    // DISCARDED: the describe failure throws before accept, so the get's
    // config never lands in the store (status stays 'error', not 'ready').
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('/api', 'fallbacks/get', { args: {} })
    expect(state.present).toBe(false)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('never looks for the fallbacks namespace in describe (it is off the wire)', async () => {
    // The directory may or may not contain `fallbacks` — presence comes from
    // the gateway get, never from describe (guide §9).
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [providerNs('llm-deepseek', {})],
    }))
    const { rpc, get } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 7_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(7_000)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('saves the full config through the gateway set and adopts the returned composed config', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, call, set } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const next = { ...defaultFallbacksConfig, cooldownMs: 99_000 }
    await controller.save(next)
    expect(call).toHaveBeenLastCalledWith('/api', 'fallbacks/set', { args: { patch: next } })
    expect(set).toHaveBeenCalledTimes(1)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(99_000)
  })

  it('loads legacyKeys from the gateway get response (the migration banner source)', async () => {
    // The wire field is authoritative: the get response's legacyKeys ride
    // through load() → accept() into state.legacyKeys for the banner.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, cooldownMs: 99_000 },
      legacyKeys: ['chains', 'roles.default'],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(99_000)
    expect(state.legacyKeys).toEqual(['chains', 'roles.default'])
  })

  it('guards a malformed legacyKeys wire value as [] (Array.isArray guard)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    // Non-array → [] ; mixed array → string entries only.
    get.mockReturnValueOnce(Promise.resolve(okResult({ config: defaultFallbacksConfig, legacyKeys: 'chains' })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().legacyKeys).toEqual([])

    get.mockReturnValueOnce(Promise.resolve(okResult({ config: defaultFallbacksConfig, legacyKeys: ['chains', 7] })))
    await controller.load()
    expect(controller.store.getSnapshot().legacyKeys).toEqual(['chains'])
  })

  it('a save response without legacyKeys clears the banner (full-overwrite save has no leftovers)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      legacyKeys: ['chains'],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().legacyKeys).toEqual(['chains'])
    // The gateway set returns { config } only → accept(config, true, []).
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.config.cooldownMs).toBe(55_000)
    expect(state.legacyKeys).toEqual([])
  })

  it('a save response carrying legacyKeys lands them in state', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    set.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, cooldownMs: 33_000 },
      legacyKeys: ['roles.default'],
    })))
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 33_000 })
    const state = controller.store.getSnapshot()
    expect(state.config.cooldownMs).toBe(33_000)
    expect(state.legacyKeys).toEqual(['roles.default'])
  })

  it('a reset response without legacyKeys clears the banner too', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, cooldownMs: 99_000 },
      legacyKeys: ['roles.default'],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().legacyKeys).toEqual(['roles.default'])
    await controller.resetToDefaults()
    const state = controller.store.getSnapshot()
    expect(state.config).toEqual(defaultFallbacksConfig)
    expect(state.legacyKeys).toEqual([])
  })

  it('surfaces a set rejection as the error banner (KD-G3 — no conflict branch)', async () => {
    // The gateway merge has no revision guard: a refused write is a plain
    // error. The old `settings-conflict` state is gone — the message lands in
    // `state.error` and the form stays editable for retry.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc()
    set.mockReturnValueOnce(Promise.resolve(failResult('changed since read')))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('changed since read')
    expect(state).not.toHaveProperty('conflict')
    expect(state).not.toHaveProperty('revision')
  })

  it('surfaces a set transport throw as the error banner (KD-G3)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc()
    set.mockRejectedValueOnce(new Error('transport down'))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('transport down')
  })

  it('resets to defaults through the gateway reset (never set)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, call, set, reset } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().config.cooldownMs).toBe(99_000)
    await controller.resetToDefaults()
    expect(call).toHaveBeenLastCalledWith('/api', 'fallbacks/reset', { args: {} })
    expect(reset).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('surfaces a reset rejection as the error banner and leaves the store retryable (I-2)', async () => {
    // KD-G3 symmetry: `resetToDefaults()` rides the same `fail()` path as
    // `save()` — a refused gateway reset lands the message in `state.error`
    // (the error banner), never leaves the store stuck in `saving`, and
    // keeps the accepted config intact for retry.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, call, reset } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    reset.mockReturnValueOnce(Promise.resolve(failResult('reset refused')))
    await controller.resetToDefaults()
    expect(call).toHaveBeenLastCalledWith('/api', 'fallbacks/reset', { args: {} })
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('reset refused')
    // The refused reset did not corrupt the accepted config or flip present.
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(99_000)
    // The store is not stuck in saving: a follow-up save still goes through
    // (the error banner leaves the form editable for retry).
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    const after = controller.store.getSnapshot()
    expect(after.status).toBe('ready')
    expect(after.error).toBeNull()
    expect(after.config.cooldownMs).toBe(55_000)
  })

  it('refuses writes when the provider is not writable', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: false, hasDocument: false, namespaces: [] }))
    const { rpc, call } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    await controller.resetToDefaults()
    // Only the load's get crossed the channel; set/reset were never called.
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('/api', 'fallbacks/get', { args: {} })
  })

  it('attempts a save even when the gateway get previously failed (usable skeleton save)', async () => {
    // KD-G5 skeleton semantics: a failed read does not block a later write
    // once the channel recovers — a successful set restores present and
    // adopts the returned config.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc(null)
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().present).toBe(false)
    set.mockReturnValueOnce(Promise.resolve(okResult({ config: { ...defaultFallbacksConfig, cooldownMs: 33_000 } })))
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 33_000 })
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(33_000)
  })

  it('drops in-flight responses after dispose (generation guard)', async () => {
    const api = makeApi()
    const gate = Promise.withResolvers<unknown>()
    api.settings.describe.mockReturnValue(gate.promise)
    const { rpc, call } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    const loading = controller.load()
    controller.dispose()
    gate.resolve(ok({ writable: true, hasDocument: false, namespaces: [] }))
    await loading
    const state = controller.store.getSnapshot()
    // The stale response never published: the store stays on the loading
    // state it was left in, with the initial defaults (never accepted).
    expect(state.status).not.toBe('ready')
    expect(state.present).toBe(false)
    expect(state.config).toEqual(defaultFallbacksConfig)
    // The parallel load issued the gateway get up front (Promise.all) — the
    // generation guard discarded its result together with the describe's.
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('/api', 'fallbacks/get', { args: {} })
  })

  it('loads the provider directory and model groups into the catalog snapshot (D-4)', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
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
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
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
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
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
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.catalogStatus).toBe('ready')
    expect(state.catalogError).toBeNull()
    expect(state.providers).toEqual([])
    expect(state.groups).toEqual([])
  })

  it('guards catalog refreshes on load with an independent generation (llm/adapters-updated)', async () => {
    const api = makeApi()
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    const gate = Promise.withResolvers<unknown>()
    api.llm.models.mockReturnValue(gate.promise)
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    const first = controller.loadCatalog()
    controller.dispose()
    gate.resolve(ok({ groups: catalogFixture().groups, failures: [] }))
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
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    // Idle → no refetch.
    refreshCatalogIfLoaded(controller)
    expect(api.llm.providers).not.toHaveBeenCalled()
    await controller.loadCatalog()
    expect(api.llm.providers).toHaveBeenCalledTimes(1)
    // Opened (ready) → refetches.
    refreshCatalogIfLoaded(controller)
    expect(api.llm.providers).toHaveBeenCalledTimes(2)
  })

  it('refreshFallbacksIfLoaded skips an idle store and refreshes an opened one', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    // Idle → no refetch (the section has never opened).
    refreshFallbacksIfLoaded(controller)
    expect(get).not.toHaveBeenCalled()
    await controller.load()
    expect(get).toHaveBeenCalledTimes(1)
    // Opened (ready) → refetches (the settings/document-updated + connection/reset push).
    refreshFallbacksIfLoaded(controller)
    expect(get).toHaveBeenCalledTimes(2)
  })
})

describe('configuredProviders derivation (Models-page `configured` join)', () => {
  it('keeps a whole-section provider when its namespace exists (empty settingsPath)', () => {
    const { providers } = configuredFixture()
    const namespaces = new Map([['llm-deepseek', providerNs('llm-deepseek', {})]])
    expect(configuredProvidersOf(providers, namespaces).map(entry => entry.provider)).toEqual(['deepseek-official'])
  })

  it('drops a provider whose settings namespace is missing', () => {
    const { providers } = configuredFixture()
    // No `llm-deepseek` namespace: even the empty-settingsPath provider is unconfigured.
    expect(configuredProvidersOf(providers, new Map())).toEqual([])
  })

  it('keeps path-addressed providers whose profile resolves and drops the rest', () => {
    const { providers } = configuredFixture()
    const namespaces = new Map([['llm-providers', providerNs('llm-providers', {
      providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' }, anthropic: {} },
    })]])
    const configured = configuredProvidersOf(providers, namespaces)
    expect(configured.map(entry => entry.provider)).toEqual(['openai', 'anthropic'])
    // `google` is in the directory but its profile does not resolve → not offered.
    expect(configured.some(entry => entry.provider === 'google')).toBe(false)
  })

  it('derives an empty offer set when no provider is configured', () => {
    const { providers } = configuredFixture()
    const namespaces = new Map([['llm-providers', providerNs('llm-providers', { providers: {} })]])
    expect(configuredProvidersOf(providers, namespaces)).toEqual([])
  })

  it('joins namespaces and catalog into configuredProviders (load then catalog)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [
        providerNs('llm-deepseek', {}),
        providerNs('llm-providers', { providers: { openai: {}, anthropic: {} } }),
      ],
    }))
    api.llm.providers.mockResolvedValue(ok({ providers: configuredFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: [], failures: [] }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    await controller.load()
    // Namespaces landed first; without the catalog the join stays empty.
    expect(controller.store.getSnapshot().configuredProviders).toEqual([])
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.configuredProviders.map(entry => entry.provider))
      .toEqual(['deepseek-official', 'openai', 'anthropic'])
  })

  it('joins the other way: catalog landing before namespaces', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [providerNs('llm-deepseek', {})],
    }))
    api.llm.providers.mockResolvedValue(ok({ providers: configuredFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: [], failures: [] }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    await controller.loadCatalog()
    expect(controller.store.getSnapshot().configuredProviders).toEqual([])
    await controller.load()
    expect(controller.store.getSnapshot().configuredProviders.map(entry => entry.provider))
      .toEqual(['deepseek-official'])
  })

  it('derives the join when describe has no fallbacks namespace (the normal case now)', async () => {
    // The fallbacks namespace never appears in describe (it is off the
    // apiproxy wire post-patch): presence comes from the gateway get, and the
    // configured-provider join reads only the OTHER namespaces.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [providerNs('llm-deepseek', {})],
    }))
    api.llm.providers.mockResolvedValue(ok({ providers: configuredFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: [], failures: [] }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    await controller.load()
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.configuredProviders.map(entry => entry.provider))
      .toEqual(['deepseek-official'])
  })

  it('keeps out-of-catalog existing values round-tripping (the configured filter never touches rows)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    api.llm.providers.mockResolvedValue(ok({ providers: catalogFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
    const controller = new FallbacksSettingsController(
      api,
      makeRpc({ ...defaultFallbacksConfig, rootChain: ['other/gpt-4o'] }).rpc,
    )
    await controller.load()
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    // `other` is outside the catalog and never enters the offer set.
    expect(state.configuredProviders.map(entry => entry.provider)).not.toContain('other')
    // The existing rootChain value still round-trips through the row editor losslessly.
    const rows = rootChainToRows(state.config.rootChain, { providers: state.providers, groups: state.groups })
    expect(rowsToRootChain(rows)).toEqual(state.config.rootChain)
  })

  it('round-trips in-catalog-but-unconfigured existing values (the 未配置 read-back is lossless)', async () => {
    const api = makeApi()
    // `google` is in the catalog directory but its `llm-providers` profile path
    // does not resolve — the configured join keeps it out of the offer set,
    // yet an existing chain value referencing it must still round-trip
    // verbatim (the synthetic 未配置 option serializes back to the raw string).
    api.settings.describe.mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [providerNs('llm-providers', { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' }, anthropic: {} } })],
    }))
    api.llm.providers.mockResolvedValue(ok({ providers: configuredFixture().providers }))
    api.llm.models.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
    const controller = new FallbacksSettingsController(
      api,
      makeRpc({ ...defaultFallbacksConfig, rootChain: ['google/gemini-2.0-flash'] }).rpc,
    )
    await controller.load()
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    // In the directory but unconfigured (profile unresolved) → never offered.
    expect(state.configuredProviders.map(entry => entry.provider)).not.toContain('google')
    // Classifies as a catalog selection (in the directory) and the existing
    // value still round-trips losslessly.
    const rows = rootChainToRows(state.config.rootChain, { providers: state.providers, groups: state.groups })
    expect(rows[0]!.selectors[0]!.provider).toEqual({ kind: 'catalog', id: 'google' })
    expect(rowsToRootChain(rows)).toEqual(state.config.rootChain)
  })
})

describe('recent-switch summary (spec §2.5 D-5)', () => {
  it('reads one history page for the recorded current session and lands the extracted switches', async () => {
    const api = makeApi()
    api.sessions.history.mockResolvedValue(ok({
      events: [otherEntry(3), switchEntry(5), switchEntry(9)],
      hasMore: false,
    }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const state = controller.store.getSnapshot()
    expect(api.sessions.history).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      maxMessages: SWITCHES_HISTORY_PAGE,
    })
    expect(state.switchesStatus).toBe('ready')
    expect(state.switchesError).toBeNull()
    expect(state.switches.map(item => item.seq)).toEqual([9, 5])
    // The switches read never touches the settings side of the store.
    expect(state.status).toBe('idle')
  })

  it('resolves to the empty state without an RPC when there is no current session', async () => {
    const api = makeApi()
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    await controller.loadSwitches()
    const state = controller.store.getSnapshot()
    expect(state.switchesStatus).toBe('ready')
    expect(state.switchesError).toBeNull()
    expect(state.switches).toEqual([])
    expect(api.sessions.history).not.toHaveBeenCalled()
  })

  it('marks the switches read errored on a failed history without blocking the settings state', async () => {
    const api = makeApi()
    api.sessions.history.mockResolvedValue(error('session-rejected', 'history read refused', { sessionId: 'sess-1' }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const state = controller.store.getSnapshot()
    expect(state.switchesStatus).toBe('error')
    expect(state.switchesError).toBe('history read refused')
    // Settings status untouched: the form keeps editing/saving normally.
    expect(state.status).toBe('idle')
  })

  it('surfaces a transport failure as the switches error (wire message extraction)', async () => {
    const api = makeApi()
    api.sessions.history.mockRejectedValue(new Error('transport down'))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const state = controller.store.getSnapshot()
    expect(state.switchesStatus).toBe('error')
    expect(state.switchesError).toBe('transport down')
  })

  it('drops in-flight history responses after dispose (independent generation guard)', async () => {
    const api = makeApi()
    const gate = Promise.withResolvers<unknown>()
    api.sessions.history.mockReturnValue(gate.promise)
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    const loading = controller.loadSwitches()
    controller.dispose()
    gate.resolve(ok({ events: [switchEntry(1)], hasMore: false }))
    await loading
    const state = controller.store.getSnapshot()
    // The stale response never published: the block stays on the loading
    // state it was left in.
    expect(state.switchesStatus).not.toBe('ready')
    expect(state.switches).toEqual([])
  })

  it('session switch reloads the summary for the new session once read', async () => {
    const api = makeApi()
    api.sessions.history.mockResolvedValue(ok({ events: [switchEntry(2)], hasMore: false }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    expect(api.sessions.history).toHaveBeenCalledTimes(1)

    // A different current session → immediate reload for the new id.
    controller.setCurrentSession('sess-2' as never)
    await Promise.resolve()
    expect(api.sessions.history).toHaveBeenCalledTimes(2)
    expect(api.sessions.history).toHaveBeenLastCalledWith({
      sessionId: 'sess-2',
      maxMessages: SWITCHES_HISTORY_PAGE,
    })

    // The same id again → no reload.
    controller.setCurrentSession('sess-2' as never)
    await Promise.resolve()
    expect(api.sessions.history).toHaveBeenCalledTimes(2)
  })

  it('recording the current session before the block is read only stores the id (first read stays with the section mount)', async () => {
    const api = makeApi()
    api.sessions.history.mockResolvedValue(ok({ events: [], hasMore: false }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    // Idle block: recording must not trigger a read.
    expect(api.sessions.history).not.toHaveBeenCalled()
    await controller.loadSwitches()
    expect(api.sessions.history).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      maxMessages: SWITCHES_HISTORY_PAGE,
    })
  })

  it('refreshSwitchesIfLoaded skips an idle block and refreshes an opened one', async () => {
    const api = makeApi()
    api.sessions.history.mockResolvedValue(ok({ events: [], hasMore: false }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    // Idle → no refetch.
    refreshSwitchesIfLoaded(controller)
    expect(api.sessions.history).not.toHaveBeenCalled()
    await controller.loadSwitches()
    expect(api.sessions.history).toHaveBeenCalledTimes(1)
    // Opened (ready) → refetches for the tracked session.
    refreshSwitchesIfLoaded(controller)
    expect(api.sessions.history).toHaveBeenCalledTimes(2)
    expect(api.sessions.history).toHaveBeenLastCalledWith({
      sessionId: 'sess-1',
      maxMessages: SWITCHES_HISTORY_PAGE,
    })
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
    // ConversationEvents service double: apply() registers the
    // `fallbacks-switch` node Definition through it (plan 3 T2 D1).
    ctx.provide('conversationEvents', { register: () => () => {}, registerFallback: () => () => {} })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('stops in-flight settings responses from publishing after the fiber is disposed', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: the apply wiring reads `list` current and
    // subscribes to changes (D-5) — no current session in this test.
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
    })
    // Connection service double: a controllable settings.describe plus the
    // gateway rpc face (never reached — describe never resolves pre-dispose).
    const gate = Promise.withResolvers<unknown>()
    const describe = vi.fn(() => gate.promise)
    ctx.provide('connection', {
      api: { settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() } },
      rpc: { call: vi.fn() },
    })
    // Remote service double: the apply wiring subscribes the pushed
    // invalidations through `ctx.remote.$on` (20260811 remote events).
    const { remote, disposers } = makeRemote()
    ctx.provide('remote', remote)
    // Slots service double: run the card-registration generator and capture the
    // injected controller — the seam apply() uses to hand the controller over.
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()

    // A load is in flight when the plugin unloads (HMR / dispose).
    const loading = controller!.load()
    await ctx.fiber.dispose()
    // Every remote `$on` disposer was invoked on teardown (qc2 S-5 / qc3
    // S-3): the cleanup disposes all subscriptions BEFORE controller.dispose()
    // (index.ts cleanup), so no forwarded event can reach a dead store.
    expect(disposers).toHaveLength(2) // settings/document-updated + llm/adapters-updated
    expect(disposers.every(entry => entry.invoked)).toBe(true)
    // The response arrives after unload: the dispose wiring must bump the
    // generation so the stale response never publishes to the dead store.
    gate.resolve(ok({ writable: true, hasDocument: false, namespaces: [] }))
    await loading
    const state = controller!.store.getSnapshot()
    expect(state.status).not.toBe('ready')
    expect(state.present).toBe(false)
  })

  it('connection/reset queued in the same tick as teardown starts no RPCs (qc3 S-2)', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: a fixed current session so switches can load.
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: 'sess-1' }), subscribe: () => () => {} },
    })
    const describe = vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const providers = vi.fn()
    const models = vi.fn()
    const history = vi.fn().mockResolvedValue(ok({ events: [switchEntry(1)], hasMore: false }))
    ctx.provide('connection', {
      api: {
        settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers, models, discoverModels: vi.fn() },
        sessions: { history },
      },
      rpc: makeRpc().rpc,
    })
    ctx.provide('remote', makeRemote().remote)
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok({ providers: [] }))
    models.mockResolvedValue(ok({ groups: [], failures: [] }))
    await controller!.load()
    await controller!.loadSwitches()
    await controller!.loadCatalog()
    expect(describe).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
    expect(providers).toHaveBeenCalledTimes(1)

    // The plugin unload begins (fiber dispose initiated — the teardown
    // disposers are still pending) and a connection/reset lands in the same
    // tick: the listener is still registered, but the queued refresh
    // microtask is drained AFTER the cleanup latch is set, so it must be
    // skipped — no discarded RPCs start after teardown (qc3 S-2).
    const unloading = ctx.fiber.dispose()
    ctx.emit('connection/reset')
    await Promise.resolve() // drain: cleanup disposers (latch set), then the refresh microtask (skipped)
    await unloading
    expect(describe).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
    expect(providers).toHaveBeenCalledTimes(1)
  })

  it('llm/adapters-updated refreshes only the catalog, never the settings (D-4)', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: no current session; the wiring still subscribes.
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
    })
    // Connection service double: controllable settings.describe + llm catalog.
    const describe = vi.fn()
    const providers = vi.fn()
    const models = vi.fn()
    ctx.provide('connection', {
      api: {
        settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers, models, discoverModels: vi.fn() },
      },
      rpc: { call: vi.fn() },
    })
    // Remote service double: the payload-free llm/adapters-updated event
    // (20260811 forwarding) is dispatched through the recorded listener.
    const { remote, emit } = makeRemote()
    ctx.provide('remote', remote)
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok({ providers: [] }))
    models.mockResolvedValue(ok({ groups: [], failures: [] }))
    await controller!.loadCatalog()
    expect(providers).toHaveBeenCalledTimes(1)

    // A pushed llm/adapters-updated refetches the catalog and leaves the
    // settings descriptor untouched.
    emit('llm/adapters-updated')
    await Promise.resolve()
    expect(providers).toHaveBeenCalledTimes(2)
    expect(describe).not.toHaveBeenCalled()
  })

  it('a sessions.list current change reloads the status-block switches (D-5)', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: a controllable current selection with a real
    // subscriber list, so the apply wiring's D-5 subscription can be driven.
    let current: string | undefined = 'sess-1'
    const listeners = new Set<() => void>()
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({ current }),
        subscribe: (fn: () => void) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      },
    })
    // Connection service double: sessions.history is the status block's face.
    const history = vi.fn().mockResolvedValue(ok({ events: [switchEntry(1)], hasMore: false }))
    ctx.provide('connection', {
      api: {
        settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
        sessions: { history },
      },
      rpc: { call: vi.fn() },
    })
    // Remote service double: the invalidation wiring subscribes through it.
    ctx.provide('remote', makeRemote().remote)
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()

    // The status block opened once (the section mount effect's first read).
    await controller!.loadSwitches()
    expect(history).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledWith({ sessionId: 'sess-1', maxMessages: SWITCHES_HISTORY_PAGE })

    // The user switches session → the list subscription reloads for the new id.
    current = 'sess-2'
    for (const listener of [...listeners]) listener()
    await Promise.resolve()
    expect(history).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenLastCalledWith({ sessionId: 'sess-2', maxMessages: SWITCHES_HISTORY_PAGE })
  })

  it('settings/document-updated (fallbacks ns) refreshes settings + switches, never the catalog', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: a fixed current session so switches can load.
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: 'sess-1' }), subscribe: () => () => {} },
    })
    // Connection service double: controllable describe + llm catalog +
    // session history, with a scripted gateway rpc so load() succeeds.
    const describe = vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const providers = vi.fn()
    const models = vi.fn()
    const history = vi.fn().mockResolvedValue(ok({ events: [switchEntry(1)], hasMore: false }))
    ctx.provide('connection', {
      api: {
        settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers, models, discoverModels: vi.fn() },
        sessions: { history },
      },
      rpc: makeRpc().rpc,
    })
    const { remote, emit } = makeRemote()
    ctx.provide('remote', remote)
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok({ providers: [] }))
    models.mockResolvedValue(ok({ groups: [], failures: [] }))
    await controller!.load()
    await controller!.loadSwitches()
    await controller!.loadCatalog()
    expect(describe).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
    expect(providers).toHaveBeenCalledTimes(1)

    // A pushed settings/document-updated for the fallbacks namespace
    // refetches the descriptor + recent-switch summary and leaves the
    // catalog untouched.
    emit('settings/document-updated', FALLBACKS_SETTINGS_NS, 2)
    await Promise.resolve()
    expect(describe).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenCalledTimes(2)
    expect(providers).toHaveBeenCalledTimes(1)
  })

  it('settings/document-updated (foreign ns) is filtered out', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: a fixed current session so switches can load.
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: 'sess-1' }), subscribe: () => () => {} },
    })
    const describe = vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const history = vi.fn().mockResolvedValue(ok({ events: [switchEntry(1)], hasMore: false }))
    ctx.provide('connection', {
      api: {
        settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
        sessions: { history },
      },
      rpc: makeRpc().rpc,
    })
    const { remote, emit } = makeRemote()
    ctx.provide('remote', remote)
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()
    await controller!.load()
    await controller!.loadSwitches()
    expect(describe).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)

    // Any other namespace's section change is not this card's concern.
    emit('settings/document-updated', 'some-other-ns', 7)
    await Promise.resolve()
    expect(describe).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
  })

  it('connection/reset refreshes settings + switches + catalog (burst coalesces)', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: 'sess-1' }), subscribe: () => () => {} },
    })
    const describe = vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const providers = vi.fn()
    const models = vi.fn()
    const history = vi.fn().mockResolvedValue(ok({ events: [switchEntry(1)], hasMore: false }))
    ctx.provide('connection', {
      api: {
        settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
        llm: { providers, models, discoverModels: vi.fn() },
        sessions: { history },
      },
      rpc: makeRpc().rpc,
    })
    const { remote } = makeRemote()
    ctx.provide('remote', remote)
    let controller: FallbacksSettingsController | undefined
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { inject?: () => unknown }) => {
        // Only the card/general-row registrations carry an inject face; the
        // transcript node registration (plan 3 T2) is inject-less — its
        // payload arrives through the keyed seat's `node` prop.
        if (options.inject !== undefined) {
          controller = (options.inject() as { controller: FallbacksSettingsController }).controller
        }
        return {}
      },
    })
    applyClient(ctx as unknown as ClientContext)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok({ providers: [] }))
    models.mockResolvedValue(ok({ groups: [], failures: [] }))
    await controller!.load()
    await controller!.loadSwitches()
    await controller!.loadCatalog()
    expect(describe).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
    expect(providers).toHaveBeenCalledTimes(1)

    // A connection/reset refetches all three surfaces.
    ctx.emit('connection/reset')
    await Promise.resolve()
    expect(describe).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenCalledTimes(2)
    expect(providers).toHaveBeenCalledTimes(2)

    // A burst of resets coalesces into a single refetch (microtask debounce).
    ctx.emit('connection/reset')
    ctx.emit('connection/reset')
    await Promise.resolve()
    expect(describe).toHaveBeenCalledTimes(3)
    expect(history).toHaveBeenCalledTimes(3)
    expect(providers).toHaveBeenCalledTimes(3)
  })
})
