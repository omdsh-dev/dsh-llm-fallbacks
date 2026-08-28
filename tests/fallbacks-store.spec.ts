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
import type {
  SessionFollowFrame, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
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
  mergeRoleExtras,
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
  rowsToTimeSlots,
  ruleRoleOptions,
  rulesToRows,
  selectorRowToRaw,
  timeSlotsToRows,
  RECENT_SWITCH_LIMIT,
  SWITCHES_HISTORY_PAGE,
  type CatalogLookup,
  type FallbacksSwitchSnapshot,
  type RoleRow,
  type RootChainRow,
} from '../src/client/fallbacks-store.ts'
import type { SlotRowConfig } from '../src/time-slots.ts'

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
  // The revert-seed fake keeps the effective config (no persona registry
  // here); tests script specific post-write read results with
  // `mockReturnValueOnce` when they exercise the accepted response.
  const revertSeed = vi.fn((payload: { args: { id: string } }) => {
    if (current === null) throw new Error('test: revert-seed on an unavailable gateway')
    return Promise.resolve(okResult({ config: current }))
  })
  const call = vi.fn((channel: string, endpoint: string, payload: unknown) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'fallbacks/get') return get()
    if (endpoint === 'fallbacks/set') return set(payload as { args: { patch: FallbacksConfig } })
    if (endpoint === 'fallbacks/reset') return reset()
    if (endpoint === 'fallbacks/revert-seed') return revertSeed(payload as { args: { id: string } })
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, reset, revertSeed,
  }
}

/** A config with the `roleAutoMatch` key removed (the pre-Plan-A / legacy shape). */
function withoutRoleAutoMatch(config: FallbacksConfig): FallbacksConfig {
  const copy: Record<string, unknown> = { ...config }
  delete copy.roleAutoMatch
  return copy as FallbacksConfig
}

/** The settings + llm + session Remote-namespace faces the store reads, as spies (0.1.2 `ctx.remote` face). */
function makeApi() {
  return {
    settings: {
      describe: vi.fn(),
    },
    llm: {
      listConfigurableProviders: vi.fn(),
    },
    session: {
      modelCatalog: vi.fn(),
      follow: vi.fn(),
    },
  }
}

/**
 * A `session/follow` answer: yields the opening snapshot carrying `records`
 * (the tail page the switches read consumes), then idles — the store cancels
 * the stream right after the snapshot.
 */
function followAnswer(records: readonly SessionEventLikeEntry[]): AsyncIterable<SessionFollowFrame> {
  return (async function* (): AsyncGenerator<SessionFollowFrame> {
    yield { type: 'snapshot', records, hasMore: false } as unknown as SessionFollowFrame
    await Promise.withResolvers().promise
  })()
}

/** A `session/follow` answer whose first frame read rejects (business or transport failure). */
function followThrow(error: Error): AsyncIterable<SessionFollowFrame> {
  return (async function* (): AsyncGenerator<SessionFollowFrame> {
    throw error
  })()
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
function makeRemote(namespaces: { settings?: unknown; llm?: unknown; session?: unknown } = {}) {
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
    remote: { $on, ...namespaces },
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
function switchEntry(seq: number, overrides: Partial<FallbacksSwitchEventData> = {}): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'fallbacks/switch',
      seq,
      time: 1_700_000_000_000 + seq * 1000,
      data: {
        turn: 1,
        step: 1,
        from: { provider: 'openai', model: 'gpt-4o' },
        to: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
        role: 'inherit',
        reason: 'trigger-code',
        ...overrides,
      },
    },
  }
}

/** A non-switch history entry (must be filtered out by the extraction). */
function otherEntry(seq: number, type = 'assistant/message'): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: 1_700_000_000_000, data: {} } } as unknown as SessionEventLikeEntry
}

/** A packed Assistant chunk run (0.1.2 history pages interleave these with scalar events). */
function chunksEntry(seq: number): SessionEventLikeEntry {
  return { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq, time: 1_700_000_000_000, data: {} } } as unknown as SessionEventLikeEntry
}

/** A catalog fixture: two providers, one with advertised models, one without. */
function catalogFixture(): CatalogLookup {
  return {
    providers: [
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: [] },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-providers', settingsPath: [] },
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
      { provider: 'deepseek-official', displayName: 'DeepSeek Official', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: ['providers', 'openai'] },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-providers', settingsPath: ['providers', 'anthropic'] },
      { provider: 'google', displayName: 'Google', settingsNs: 'llm-providers', settingsPath: ['providers', 'google'] },
    ],
  }
}

/** One Remote success (0.1.2 flat `RemoteResult`, no `result` envelope). */
function ok<T>(value: T) {
  return { ok: true as const, value }
}

/** One Remote business rejection. */
function error(code: string, message: string, details?: unknown) {
  return { ok: false as const, error: { code, message, details: details ?? {} } }
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
          persona: 'Deep review pass',
          chain: ['anthropic/claude-3-5-sonnet'],
          fallback: 'none',
        }],
        rules: [{ origin: 'subagent', provider: 'openai', role: 'reviewer' }],
      },
      cooldownMs: 60_000,
      revertPolicy: 'never',
      maxSwitchesPerStep: 4,
      alwaysModeRetryCap: 0,
      presets: 'bundled',
      roleAutoMatch: true,
      // P5 keys (plan fallbacks-timeslots Task 1): the fold mirrors the
      // host defaults, so a truly complete config carries them.
      timeSlots: [],
      tz: 'Asia/Shanghai',
      // P1 key (plan fallbacks-half-open-recovery Task 1): the fold mirrors
      // the host default, so a truly complete config carries it.
      recovery: 'timer',
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
    expect(() => parseFallbacksConfig({ roles: { list: [{ persona: 'no id' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ id: 'a', chain: 'openai/gpt-4o' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ id: 'a', fallback: 'sometimes' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ id: 'a', permissions: { allow: 'read' } }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { rules: [{ provider: 'openai' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { rules: [{ origin: 'host', role: 'x' }] } })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ revertPolicy: 'sometimes' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ presets: 'sometimes' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ recovery: 'sometimes' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ cooldownMs: 'soon' })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ enabled: 'yes' })).toThrow(TypeError)
  })

  it('preserves schema-reserved prompt/permissions fields on a read (no row editing this round)', () => {
    const parsed = parseFallbacksConfig({
      roles: { list: [{ id: 'architect', persona: 'D', prompt: 'think hard', permissions: { allow: ['files.read'] } }] },
    })
    expect(parsed.roles.list[0]).toEqual({
      id: 'architect',
      persona: 'D',
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
    // PR #62 feedback: the editor rows carry no origin (rules are
    // subagent-only); a persisted wire `origin` on the source rules is
    // ignored by the row projection.
    const rules = [
      { origin: 'subagent' as const, provider: 'openai', model: '', role: 'reviewer' },
      { provider: undefined, model: undefined, role: 'default' },
    ]
    const rows = rulesToRows(rules)
    expect(rows[0]).toEqual({ provider: { kind: 'outside', raw: 'openai' }, model: null, role: 'reviewer' })
    expect(rows[1]).toEqual({ provider: null, model: null, role: 'default' })
    expect(rowsToRules(rows)).toEqual([
      { provider: 'openai', role: 'reviewer' },
      { role: 'default' },
    ])
  })

  it('round-trips declared role entities through rows (id/persona/chain/fallback)', () => {
    const roles = [
      {
        id: 'reviewer',
        persona: 'Deep review pass',
        chain: ['openai/gpt-4o', 'openai/*'],
        fallback: 'none' as const,
      },
      {
        id: 'architect',
        persona: '',
        chain: [],
        fallback: 'inherit-root' as const,
      },
    ]
    const rows = rolesToRows(roles)
    expect(rows).toEqual<RoleRow[]>([
      {
        id: 'reviewer',
        persona: 'Deep review pass',
        selectors: [
          { wildcard: false, provider: { kind: 'outside', raw: 'openai' }, model: { kind: 'outside', raw: 'gpt-4o' } },
          { wildcard: true, provider: { kind: 'outside', raw: 'openai' }, model: null },
        ],
        fallback: 'none',
        // UI-only collapse state (PR #62 UX round 2) — role cards start
        // collapsed and the flag never serializes back.
        collapsed: true,
      },
      { id: 'architect', persona: '', selectors: [], fallback: 'inherit-root', collapsed: true },
    ])
    expect(rowsToRoles(rows)).toEqual(roles)
  })

  it('classifies a role chain against the catalog like any selector list', () => {
    const catalog = catalogFixture()
    const rows = rolesToRows([{ id: 'reviewer', persona: 'R', chain: ['openai/gpt-4o'], fallback: 'inherit-root' }], catalog)
    expect(rows[0]!.selectors[0]).toEqual({
      wildcard: false,
      provider: { kind: 'catalog', id: 'openai' },
      model: { kind: 'catalog', id: 'gpt-4o' },
    })
    expect(rowsToRoles(rows)).toEqual([{ id: 'reviewer', persona: 'R', chain: ['openai/gpt-4o'], fallback: 'inherit-root' }])
  })

  it('ruleRoleOptions offers the built-in inherit target plus every declared id in order', () => {
    expect(ruleRoleOptions({ list: [] })).toEqual(['inherit'])
    expect(ruleRoleOptions({ list: [{ id: 'reviewer', persona: '' }, { id: 'architect', persona: '' }] }))
      .toEqual(['inherit', 'reviewer', 'architect'])
    // The same page's role edits are reflected immediately (derived, never cached).
    expect(ruleRoleOptions({ list: [{ id: 'reviewer', persona: '' }, { id: 'c', persona: '' }] }))
      .toEqual(['inherit', 'reviewer', 'c'])
  })

  it('ruleRoleOptions canonicalizes ids and dedupes the offer set (qc3 F-3)', () => {
    // Mid-edit duplicate ids must not render duplicate <option> entries
    // (React key collision): trimmed to the canonical form and offered once;
    // save-time validation still blocks the duplicate draft.
    expect(ruleRoleOptions({ list: [
      { id: ' reviewer ', persona: '' },
      { id: 'reviewer', persona: '' },
      { id: 'architect', persona: '' },
    ] })).toEqual(['inherit', 'reviewer', 'architect'])
  })

  it('mergeRoleExtras re-attaches prompt/permissions from the original list by (trimmed) id', () => {
    // The schema-reserved prompt/permissions never round-trip through rows;
    // the merge is what keeps them alive across a save (T2 reviewer minor
    // #2). The reviewer row's edited id carries surrounding whitespace —
    // the merge matches the canonical (trimmed) id, exactly like the rest
    // of the rowsToRoles pipeline. A brand-new row has no original and
    // keeps no extras.
    const originalRoles = [
      {
        id: 'reviewer', persona: 'Deep review pass',
        prompt: 'You review', permissions: { allow: ['files.read'] },
        chain: ['openai/gpt-4o'], fallback: 'inherit-root' as const,
      },
      {
        id: 'architect', persona: 'Designs systems',
        chain: [], fallback: 'none' as const,
      },
    ]
    const rows: RoleRow[] = [
      {
        id: ' reviewer ', persona: 'Deep review pass v2',
        selectors: [
          { wildcard: false, provider: { kind: 'outside', raw: 'openai' }, model: { kind: 'outside', raw: 'gpt-4o' } },
        ],
        fallback: 'inherit-root',
      },
      { id: 'coder', persona: '', selectors: [], fallback: 'inherit-root' },
    ]
    expect(mergeRoleExtras(rows, originalRoles)).toEqual([
      {
        id: 'reviewer', persona: 'Deep review pass v2',
        prompt: 'You review', permissions: { allow: ['files.read'] },
        chain: ['openai/gpt-4o'], fallback: 'inherit-root',
      },
      { id: 'coder', persona: '', chain: [], fallback: 'inherit-root' },
    ])
  })

  it('detectLegacyClientKeys flags undeclared rule role references (test fallback)', () => {
    // Declared refs + the built-in inherit target are clean.
    expect(detectLegacyClientKeys({
      ...defaultFallbacksConfig,
      roles: {
        list: [{ id: 'reviewer', persona: '', chain: [], fallback: 'inherit-root' }],
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
    // PR #62 feedback: the editor drops the legacy `origin` field — a
    // persisted `origin: root` rule re-serializes WITHOUT it.
    const catalog = catalogFixture()
    const rules = [
      { provider: 'other', model: 'gpt-4o', role: 'x' },
      { role: 'y', provider: 'openai', model: 'gpt-4o' },
    ]
    const rows = rulesToRows(rules, catalog)
    expect(rows[0]).toEqual({ provider: { kind: 'outside', raw: 'other' }, model: { kind: 'outside', raw: 'gpt-4o' }, role: 'x' })
    expect(rows[1]).toEqual({ provider: { kind: 'catalog', id: 'openai' }, model: { kind: 'catalog', id: 'gpt-4o' }, role: 'y' })
    expect(rowsToRules(rows)).toEqual(rules)
  })

  it('preserves a malformed entry verbatim instead of dropping it', () => {
    // A selector line that never matched `provider/model` keeps its raw text
    // as a bare outside value — the runtime config-warning path is unchanged.
    const rows = rootChainToRows(['gpt-4o'], catalogFixture())
    expect(rows[0]!.selectors[0]).toEqual({ wildcard: false, provider: { kind: 'outside', raw: 'gpt-4o' }, model: null })
    expect(rowsToRootChain(rows)).toEqual(['gpt-4o'])
  })

  it('round-trips time-slot rows losslessly (Task 3 editor carrier)', () => {
    const catalog = catalogFixture()
    // The composed shape every card load accepts: `days` materialized on
    // every row (schemastery composes absent arrays as []).
    const timeSlots: SlotRowConfig[] = [
      { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o', 'openai/*'] },
      { kind: 'custom', start: '22:00', end: '02:00', days: [1, 5], chain: ['anthropic/claude-3-5-sonnet'] },
      { kind: 'custom', start: '09:00', end: '10:00', days: [], chain: ['openai/gpt-4o'] },
    ]
    const rows = timeSlotsToRows(timeSlots, catalog)
    expect(rows[0]!.kind).toBe('preset')
    expect(rows[0]!.preset).toBe('liang-peak')
    expect(rows[0]!.days).toEqual([])
    // UI-only collapse state (PR #62 UX round 4 part C) — slot rows default
    // collapsed like role cards; the flag never serializes back.
    expect(rows[0]!.collapsed).toBe(true)
    // The wildcard entry reads back as a wildcard selector row (the GUI
    // conversion hint path, same as role chains).
    expect(rows[0]!.selectors[1]).toEqual({ wildcard: true, provider: { kind: 'catalog', id: 'openai' }, model: null })
    expect(rows[1]!.days).toEqual([1, 5])
    // Round-trip: the original rows come back unchanged (blank selectors
    // drop out, but there are none here).
    expect(rowsToTimeSlots(rows)).toEqual(timeSlots)
  })

  it('serializes an unknown row kind verbatim and drops blank selectors (dirty-check honesty)', () => {
    // A hand-written YAML row with an unknown kind reads back unchanged —
    // the card's dirty check stays quiet; save validation rejects it.
    const rows = timeSlotsToRows([{ kind: 'weird', start: '09:00', end: '10:00', chain: ['openai/gpt-4o'] }])
    expect(rows[0]!.kind).toBe('weird')
    expect(rowsToTimeSlots(rows)).toEqual([{ kind: 'weird', start: '09:00', end: '10:00', days: [], chain: ['openai/gpt-4o'] }])
    // Blank selector rows serialize to nothing (the chain-required
    // validation surfaces the empty result).
    const blank = timeSlotsToRows([{ kind: 'custom', start: '09:00', end: '10:00', days: [], chain: [] }])
    expect(rowsToTimeSlots(blank)).toEqual([{ kind: 'custom', start: '09:00', end: '10:00', days: [], chain: [] }])
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

  it('skips packed Assistant chunk runs (`chunks` entries) interleaved on the page', () => {
    // 0.1.2 history pages interleave packed chunk runs with scalar events;
    // the chunk run carries the highest seq, so reading it as a scalar entry
    // would mis-order or leak it into the summary.
    const extracted = extractRecentSwitches([switchEntry(4), chunksEntry(9), switchEntry(2)])
    expect(extracted.map(item => item.seq)).toEqual([4, 2])
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
      role: 'inherit', reason: 'trigger-code',
    }])
    expect(view).toEqual({ kind: 'unavailable' })
  })

  it('① enabled with an empty rootChain → unavailable', () => {
    const config = { ...enabledConfig, rootChain: [] }
    expect(deriveEffectiveModel(config, [])).toEqual({ kind: 'unavailable' })
  })

  it('② a recent switch exists → the latest one\'s target (`to`)', () => {
    const switches: FallbacksSwitchSnapshot[] = [
      { seq: 9, time: 1, turn: 1, step: 1, from: { provider: 'openai', model: 'gpt-4o' }, to: { provider: 'google', model: 'gemini-2.0-flash' }, role: 'inherit', reason: 'always-cap' },
      { seq: 3, time: 1, turn: 1, step: 1, from: { provider: 'openai', model: 'gpt-4o' }, to: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, role: 'inherit', reason: 'trigger-code' },
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
    expect(api.settings.describe).toHaveBeenCalledWith()
    // …but the config itself rides the gateway channel, never describe.
    expect(call).toHaveBeenCalledWith('/api', 'fallbacks/get', { args: {} })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('parses roleAutoMatch to the schema default true for a legacy wire — the accepted basis always carries the key (AC-7 re-scope Option A)', async () => {
    // The raw descriptor's `roleAutoMatch` key presence (plan
    // fallbacks-settings-visibility T3, AC-7 re-scope — PM decision
    // 2026-08-17 Option A): the REAL gateway composition always resolves the
    // schemastery default `true` (the entry base carries the key, and the
    // wire `readConfig` emits every non-undefined declared key — see
    // tests/gateway.spec.ts), so no client-side key-presence signal exists
    // to honor. `parseFallbacksConfig` folds the key to the default and the
    // accepted config-basis KEEPS it: the toggle always renders (default on)
    // and a save persists the resolved value. A config that declares the
    // key (true or false) is retained verbatim, as before.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))

    // Key declared (false) → retained verbatim.
    const declared = makeRpc({ ...defaultFallbacksConfig, roleAutoMatch: false })
    const one = new FallbacksSettingsController(api, declared.rpc)
    await one.load()
    expect(one.store.getSnapshot().config.roleAutoMatch).toBe(false)

    // Key absent on the wire (the pre-fold legacy shape this unit fixture
    // can hand-build) → the accepted config-basis carries the folded default
    // `true` — the same value every real-wire read emits.
    const legacy = makeRpc(withoutRoleAutoMatch(defaultFallbacksConfig))
    const two = new FallbacksSettingsController(api, legacy.rpc)
    await two.load()
    expect(two.store.getSnapshot().config.roleAutoMatch).toBe(true)
    expect('roleAutoMatch' in two.store.getSnapshot().config).toBe(true)
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

  it('preserves legacyKeys when a follow-up get fails (the banner survives transient channel-down, T3 reviewer minor)', async () => {
    // accept() only lets a REAL config clear/replace the wire legacyKeys: a
    // complete get failure (config undefined) keeps the last accepted value
    // so a transient refresh can never clear the migration banner.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, cooldownMs: 99_000 },
      legacyKeys: ['chains'],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().legacyKeys).toEqual(['chains'])
    // The channel drops before the next refresh's get resolves.
    get.mockReturnValueOnce(Promise.resolve(failResult('fallbacks gateway is not ready')))
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(false)
    expect(state.config.cooldownMs).toBe(99_000)
    expect(state.legacyKeys).toEqual(['chains'])
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

  it('a save response without legacyKeys KEEPS the banner (W-1/F-1: only a get may settle legacy truth)', async () => {
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
    // The gateway set response omits the field (older gateway / pre-W-1):
    // the last accepted value is kept — a save merges over the user layer,
    // so the server's silence must never clear the banner against truth.
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.config.cooldownMs).toBe(55_000)
    expect(state.legacyKeys).toEqual(['chains'])
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

  it('loads seeds from the gateway get response (the card badge source)', async () => {
    // spec §9.4: the additive seeds field rides the get response exactly
    // like legacyKeys — the wire value is authoritative for the badge.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      seeds: [
        { id: 'architect', overridden: false },
        { id: 'qa-engineer', overridden: true },
      ],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([
      { id: 'architect', overridden: false },
      { id: 'qa-engineer', overridden: true },
    ])
  })

  it('a get WITHOUT the seeds field leaves state.seeds as [] (get-authority rule)', async () => {
    // spec §9.4: only a real get settles seed truth; an omitted field
    // (older gateway) means "no seeds to badge" on this fresh read —
    // load() must leave the initial [] rather than inventing state.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc } = makeRpc() // default get response carries { config } only — no seeds
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([])
  })

  it('guards a malformed seeds wire value as [] (Array.isArray + shape guard)', async () => {
    // Non-array → [] ; all-malformed entries → [] ; mixed array → the
    // well-shaped entries only (the legacyKeys element-filter precedent).
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({ config: defaultFallbacksConfig, seeds: 'junk' })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([])

    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      seeds: [{ id: 'architect' }, 'junk', 7, null],
    })))
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([])

    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      seeds: [{ id: 'architect', overridden: true }, { id: 5 }, 'junk'],
    })))
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([{ id: 'architect', overridden: true }])
  })

  it('preserves seeds when a follow-up get fails (the badge survives transient channel-down)', async () => {
    // accept() only lets a REAL config replace the wire seeds: a complete
    // get failure (config undefined) keeps the last accepted value so a
    // transient refresh can never clear the badge.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      seeds: [{ id: 'architect', overridden: false }],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([{ id: 'architect', overridden: false }])
    // The channel drops before the next refresh's get resolves.
    get.mockReturnValueOnce(Promise.resolve(failResult('fallbacks gateway is not ready')))
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.present).toBe(false)
    expect(state.seeds).toEqual([{ id: 'architect', overridden: false }])
  })

  it('a save response without seeds keeps the last badge state (W-1/F-1: only a get may settle seeds truth)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      seeds: [{ id: 'architect', overridden: false }],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([{ id: 'architect', overridden: false }])
    // The gateway set response omits the field (older gateway): keep the
    // last accepted value — a save merges over the user layer, so the
    // server's silence must never clear the badge against truth.
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    const state = controller.store.getSnapshot()
    expect(state.config.cooldownMs).toBe(55_000)
    expect(state.seeds).toEqual([{ id: 'architect', overridden: false }])
  })

  it('a save response carrying seeds lands them in state', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    set.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, cooldownMs: 33_000 },
      seeds: [{ id: 'architect', overridden: true }],
    })))
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 33_000 })
    const state = controller.store.getSnapshot()
    expect(state.config.cooldownMs).toBe(33_000)
    expect(state.seeds).toEqual([{ id: 'architect', overridden: true }])
  })

  it('a reset response without seeds keeps the last badge state too', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, cooldownMs: 99_000 },
      seeds: [{ id: 'architect', overridden: false }],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([{ id: 'architect', overridden: false }])
    await controller.resetToDefaults()
    const state = controller.store.getSnapshot()
    expect(state.config).toEqual(defaultFallbacksConfig)
    // Same keep-last rule as save: an absent wire field never clears the
    // badge — the next get is the only seeds-truth authority.
    expect(state.seeds).toEqual([{ id: 'architect', overridden: false }])
  })

  it('a reset response without legacyKeys keeps the banner too', async () => {
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
    // Same keep-last rule as save: an absent wire field never clears the
    // banner — the next get is the only legacy-truth authority.
    expect(state.legacyKeys).toEqual(['roles.default'])
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

  it('reverts one seeded role through the gateway revert-seed endpoint and adopts the post-write result', async () => {
    // spec §9.4: revertSeed mirrors save — the endpoint call, then accept()
    // of the post-write read result (config + legacyKeys + seeds).
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, call, revertSeed } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    revertSeed.mockReturnValueOnce(Promise.resolve(okResult({
      config: { ...defaultFallbacksConfig, roles: { list: [{ id: 'architect', persona: 'v1' }], rules: [] } },
      legacyKeys: [],
      seeds: [{ id: 'architect', overridden: false }],
      outcome: { reverted: true, persona: 'v1' },
    })))
    await expect(controller.revertSeed('architect')).resolves.toBe('v1')
    expect(call).toHaveBeenLastCalledWith('/api', 'fallbacks/revert-seed', { args: { id: 'architect' } })
    expect(revertSeed).toHaveBeenCalledTimes(1)
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.roles.list).toEqual([{ id: 'architect', persona: 'v1', chain: [], fallback: 'inherit-root' }])
    expect(state.seeds).toEqual([{ id: 'architect', overridden: false }])
  })

  it('revertSeed returns the outcome persona even when persist is a no-op (issue #59)', async () => {
    const alreadySeed = {
      ...defaultFallbacksConfig,
      roles: { list: [{ id: 'architect', persona: 'Designs systems' }], rules: [] },
    }
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, revertSeed } = makeRpc(alreadySeed)
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    revertSeed.mockReturnValueOnce(Promise.resolve(okResult({
      config: alreadySeed,
      seeds: [{ id: 'architect', overridden: false }],
      outcome: { reverted: true, persona: 'Designs systems' },
    })))
    await expect(controller.revertSeed('architect')).resolves.toBe('Designs systems')
  })


  it('a revert-seed response without seeds keeps the last badge state (W-1/F-1)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get } = makeRpc()
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: defaultFallbacksConfig,
      seeds: [{ id: 'architect', overridden: true }],
    })))
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().seeds).toEqual([{ id: 'architect', overridden: true }])
    // The gateway revert-seed response omits the field (older gateway):
    // the last accepted badge value is kept, never cleared on silence.
    await controller.revertSeed('architect')
    expect(controller.store.getSnapshot().seeds).toEqual([{ id: 'architect', overridden: true }])
  })

  it('refuses a revert while a save is in flight (saving guard)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set, revertSeed } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    // A save hangs in flight → status is 'saving'; the revert must not
    // start a second write on the same write generation.
    const gate = Promise.withResolvers<unknown>()
    set.mockReturnValueOnce(gate.promise)
    const saving = controller.save({ ...defaultFallbacksConfig, cooldownMs: 11_000 })
    await controller.revertSeed('architect')
    expect(revertSeed).not.toHaveBeenCalled()
    // Let the save finish to keep the test clean.
    gate.resolve(okResult({ config: { ...defaultFallbacksConfig, cooldownMs: 11_000 } }))
    await saving
  })

  it('surfaces a revert-seed rejection as the error banner (KD-G3)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, call, revertSeed } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    revertSeed.mockReturnValueOnce(Promise.resolve(failResult('revert refused')))
    await controller.revertSeed('architect')
    expect(call).toHaveBeenLastCalledWith('/api', 'fallbacks/revert-seed', { args: { id: 'architect' } })
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('revert refused')
    // The refused revert did not corrupt the accepted config or flip present.
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(99_000)
  })

  it('surfaces a revert-seed transport throw as the error banner (KD-G3)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, revertSeed } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    revertSeed.mockRejectedValueOnce(new Error('transport down'))
    await controller.revertSeed('architect')
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('transport down')
  })

  it('refuses writes when the provider is not writable', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: false, hasDocument: false, namespaces: [] }))
    const { rpc, call } = makeRpc()
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    await controller.save(defaultFallbacksConfig)
    await controller.resetToDefaults()
    await controller.revertSeed('architect')
    // Only the load's get crossed the channel; set/reset/revert-seed never ran.
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

  it('drops an in-flight save accept after dispose (write path never publishes)', async () => {
    // F-002: the existing dispose test only covered the READ path. A write
    // in flight at dispose time must not publish either — the stale save
    // accept must not replace the frozen store's config with the response.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()

    const gate = Promise.withResolvers<{ ok: true; value: { config: FallbacksConfig } }>()
    set.mockReturnValueOnce(gate.promise)
    const saving = controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    controller.dispose()
    gate.resolve(okResult({ config: { ...defaultFallbacksConfig, cooldownMs: 55_000 } }))
    await saving
    const state = controller.store.getSnapshot()
    // The stale write accept never published: the store stays frozen on the
    // write's 'saving' state with the pre-save config (never replaced).
    expect(state.status).toBe('saving')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(99_000)
  })

  it('drops an in-flight save rejection after dispose (write path never publishes)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()

    const gate = Promise.withResolvers<{ ok: true; value: { config: FallbacksConfig } }>()
    set.mockReturnValueOnce(gate.promise)
    const saving = controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    controller.dispose()
    gate.reject(new Error('transport down'))
    await saving
    const state = controller.store.getSnapshot()
    // The stale write FAILURE never published either: no error banner after
    // disposal — fail() sits under the same writeGeneration guard.
    expect(state.status).not.toBe('error')
    expect(state.error).toBeNull()
    expect(state.config.cooldownMs).toBe(99_000)
  })

  it('drops an in-flight reset accept after dispose (write path never publishes)', async () => {
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, reset } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()

    const gate = Promise.withResolvers<{ ok: true; value: { config: FallbacksConfig } }>()
    reset.mockReturnValueOnce(gate.promise)
    const resetting = controller.resetToDefaults()
    controller.dispose()
    gate.resolve(okResult({ config: defaultFallbacksConfig }))
    await resetting
    const state = controller.store.getSnapshot()
    // Symmetric to the save case: the stale reset accept never published.
    expect(state.status).toBe('saving')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(99_000)
  })

  it('accepts the save response when an overlapping load with a failing get supersedes the read (write generation split)', async () => {
    // Audit F1: load() and save() shared one generation counter, so the
    // post-save refresh (settings/document-updated → load()) could bump the
    // counter while the write was in flight and discard the save's accept().
    // When that refresh's get fails, the UI kept the PRE-SAVE config even
    // though the server accepted the write. The read/write generation split
    // lets the write completion publish regardless of overlapping reads.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get, set } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().config.cooldownMs).toBe(99_000)

    // The save's set stays in flight while the overlapping refresh runs.
    const gate = Promise.withResolvers<{ ok: true; value: { config: FallbacksConfig } }>()
    set.mockReturnValueOnce(gate.promise)
    const saving = controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })

    // The refresh overlaps the write and its get fails — the exact overlap
    // where the shared counter dropped the save's accept().
    get.mockReturnValueOnce(Promise.resolve(failResult('fallbacks gateway is not ready')))
    await controller.load()
    expect(controller.store.getSnapshot().present).toBe(false)

    // The server accepted the write and returned the post-write config.
    gate.resolve(okResult({ config: { ...defaultFallbacksConfig, cooldownMs: 55_000 } }))
    await saving
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(55_000)
  })

  it('drops a pre-write load whose get fails after a save accepted (mirrored race guard)', async () => {
    // F-301: the mirror image of F1. A load STARTED before a write can
    // settle AFTER the write's accept — when its get then fails, the old
    // read's accept(undefined) would pull present back to false and leave
    // the UI showing the pre-save config even though the server accepted
    // the write. Write-wins: a read that observed the pre-write generation
    // must not clobber the write's publish on EITHER branch.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get, set } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().config.cooldownMs).toBe(99_000)

    // The load's get stays in flight while the write completes first.
    const gate = Promise.withResolvers<unknown>()
    get.mockReturnValueOnce(gate.promise)
    const loading = controller.load()
    set.mockReturnValueOnce(Promise.resolve(okResult({ config: { ...defaultFallbacksConfig, cooldownMs: 55_000 } })))
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })
    expect(controller.store.getSnapshot().config.cooldownMs).toBe(55_000)

    // The pre-write read settles LAST, with a FAILING get — without the
    // guard its accept(undefined) clobbers the save's publish.
    gate.resolve(failResult('fallbacks gateway is not ready'))
    await loading
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(55_000)
  })

  it('drops a pre-write load whose describe fails after a save accepted (mirrored race, failure branch)', async () => {
    // The catch branch of load() is under the same guard: a describe
    // failure settling after the write must not flip the store to 'error'
    // over the write's published accept.
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, set } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()

    // The refresh's describe stays in flight while the write completes.
    const gate = Promise.withResolvers<unknown>()
    api.settings.describe.mockReturnValueOnce(gate.promise)
    const loading = controller.load()
    set.mockReturnValueOnce(Promise.resolve(okResult({ config: { ...defaultFallbacksConfig, cooldownMs: 55_000 } })))
    await controller.save({ ...defaultFallbacksConfig, cooldownMs: 55_000 })

    // The stale read's describe fails — without the guard fail() flips the
    // store to 'error' over the write's accept.
    gate.resolve(error('read-refused', 'read refused'))
    await loading
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
    expect(state.present).toBe(true)
    expect(state.config.cooldownMs).toBe(55_000)
  })

  it('accepts the reset response when an overlapping load with a failing get supersedes the read (reset write generation split)', async () => {
    // F-001/F-303: resetToDefaults() rides the same writeGeneration guard
    // as save() — an overlapping refresh whose get fails must not discard
    // the reset's accept of the post-reset defaults (write-wins symmetry).
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { rpc, get, reset } = makeRpc({ ...defaultFallbacksConfig, cooldownMs: 99_000 })
    const controller = new FallbacksSettingsController(api, rpc)
    await controller.load()
    expect(controller.store.getSnapshot().config.cooldownMs).toBe(99_000)

    // The reset stays in flight while the overlapping refresh runs.
    const gate = Promise.withResolvers<{ ok: true; value: { config: FallbacksConfig } }>()
    reset.mockReturnValueOnce(gate.promise)
    const resetting = controller.resetToDefaults()

    // The refresh overlaps the write and its get fails.
    get.mockReturnValueOnce(Promise.resolve(failResult('fallbacks gateway is not ready')))
    await controller.load()
    expect(controller.store.getSnapshot().present).toBe(false)

    // The server accepted the reset and returned the composed defaults.
    gate.resolve(okResult({ config: defaultFallbacksConfig }))
    await resetting
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('loads the provider directory and model groups into the catalog snapshot (D-4)', async () => {
    const api = makeApi()
    api.llm.listConfigurableProviders.mockResolvedValue(ok(catalogFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
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
    expect(api.llm.listConfigurableProviders).toHaveBeenCalledWith()
    expect(api.session.modelCatalog).toHaveBeenCalledWith()
  })

  it('keeps sound groups usable and reports per-provider failures as a diagnostic (D-4)', async () => {
    const api = makeApi()
    api.llm.listConfigurableProviders.mockResolvedValue(ok(catalogFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({
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
    api.llm.listConfigurableProviders.mockResolvedValue(error('llm-rejected', 'directory read refused'))
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok([]))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: [], failures: [] }))
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(catalogFixture().providers))
    const gate = Promise.withResolvers<unknown>()
    api.session.modelCatalog.mockReturnValue(gate.promise)
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(catalogFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    // Idle → no refetch.
    refreshCatalogIfLoaded(controller)
    expect(api.llm.listConfigurableProviders).not.toHaveBeenCalled()
    await controller.loadCatalog()
    expect(api.llm.listConfigurableProviders).toHaveBeenCalledTimes(1)
    // Opened (ready) → refetches.
    refreshCatalogIfLoaded(controller)
    expect(api.llm.listConfigurableProviders).toHaveBeenCalledTimes(2)
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(configuredFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: [], failures: [] }))
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(configuredFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: [], failures: [] }))
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(configuredFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: [], failures: [] }))
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(catalogFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
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
    api.llm.listConfigurableProviders.mockResolvedValue(ok(configuredFixture().providers))
    api.session.modelCatalog.mockResolvedValue(ok({ groups: catalogFixture().groups, failures: [] }))
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
    api.session.follow.mockImplementation(() => followAnswer([otherEntry(3), switchEntry(5), switchEntry(9)]))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const state = controller.store.getSnapshot()
    expect(api.session.follow).toHaveBeenCalledWith({
      address: { kind: 'session', sessionId: 'sess-1' },
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
    expect(api.session.follow).not.toHaveBeenCalled()
  })

  it('marks the switches read errored on a failed history without blocking the settings state', async () => {
    const api = makeApi()
    api.session.follow.mockImplementation(() => followThrow(new Error('history read refused')))
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
    api.session.follow.mockImplementation(() => followThrow(new Error('transport down')))
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
    api.session.follow.mockImplementation(() => (async function* (): AsyncGenerator<SessionFollowFrame> {
      await gate.promise
      yield { type: 'snapshot', records: [switchEntry(1)], hasMore: false } as unknown as SessionFollowFrame
      await Promise.withResolvers().promise
    })())
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    const loading = controller.loadSwitches()
    controller.dispose()
    gate.resolve(undefined)
    await loading
    const state = controller.store.getSnapshot()
    // The stale response never published: the block stays on the loading
    // state it was left in.
    expect(state.switchesStatus).not.toBe('ready')
    expect(state.switches).toEqual([])
  })

  it('session switch reloads the summary for the new session once read', async () => {
    const api = makeApi()
    api.session.follow.mockImplementation(() => followAnswer([switchEntry(2)]))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    expect(api.session.follow).toHaveBeenCalledTimes(1)

    // A different current session → immediate reload for the new id.
    controller.setCurrentSession('sess-2' as never)
    await Promise.resolve()
    expect(api.session.follow).toHaveBeenCalledTimes(2)
    expect(api.session.follow).toHaveBeenLastCalledWith({
      address: { kind: 'session', sessionId: 'sess-2' },
      maxMessages: SWITCHES_HISTORY_PAGE,
    })

    // The same id again → no reload.
    controller.setCurrentSession('sess-2' as never)
    await Promise.resolve()
    expect(api.session.follow).toHaveBeenCalledTimes(2)
  })

  it('recording the current session before the block is read only stores the id (first read stays with the section mount)', async () => {
    const api = makeApi()
    api.session.follow.mockImplementation(() => followAnswer([]))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    // Idle block: recording must not trigger a read.
    expect(api.session.follow).not.toHaveBeenCalled()
    await controller.loadSwitches()
    expect(api.session.follow).toHaveBeenCalledWith({
      address: { kind: 'session', sessionId: 'sess-1' },
      maxMessages: SWITCHES_HISTORY_PAGE,
    })
  })

  it('refreshSwitchesIfLoaded skips an idle block and refreshes an opened one', async () => {
    const api = makeApi()
    api.session.follow.mockImplementation(() => followAnswer([]))
    const controller = new FallbacksSettingsController(api, makeRpc().rpc)
    controller.setCurrentSession('sess-1' as never)
    // Idle → no refetch.
    refreshSwitchesIfLoaded(controller)
    expect(api.session.follow).not.toHaveBeenCalled()
    await controller.loadSwitches()
    expect(api.session.follow).toHaveBeenCalledTimes(1)
    // Opened (ready) → refetches for the tracked session.
    refreshSwitchesIfLoaded(controller)
    expect(api.session.follow).toHaveBeenCalledTimes(2)
    expect(api.session.follow).toHaveBeenLastCalledWith({
      address: { kind: 'session', sessionId: 'sess-1' },
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
    // `uiConversation` service double (the D1 Definition registry's home
    // since 0.1.2): apply() registers the `fallbacks-switch` node Definition
    // through `ctx.uiConversation.events` (plan 3 T2 D1).
    ctx.provide('uiConversation', { events: { register: () => () => {}, registerFallback: () => () => {} } })
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
    // Connection service double: only the gateway rpc face (never reached —
    // describe never resolves pre-dispose).
    const gate = Promise.withResolvers<unknown>()
    const describe = vi.fn(() => gate.promise)
    ctx.provide('connection', {
      rpc: { call: vi.fn() },
    })
    // Remote service double: the apply wiring subscribes the pushed
    // invalidations through `ctx.remote.$on` (20260811 remote events), and
    // the store reads the settings namespace through it (0.1.2:
    // `ConnectionHandle` dropped `api` — describe rides `ctx.remote`).
    const { remote, disposers } = makeRemote({ settings: { describe } })
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
    applyClient(ctx)
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
    const history = vi.fn().mockImplementation(() => followAnswer([switchEntry(1)]))
    ctx.provide('connection', {
      rpc: makeRpc().rpc,
    })
    ctx.provide('remote', makeRemote({
      settings: { describe },
      llm: { listConfigurableProviders: providers },
      session: { modelCatalog: models, follow: history },
    }).remote)
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
    applyClient(ctx)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok([]))
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
    // Connection service double: only the gateway rpc face.
    const describe = vi.fn()
    const providers = vi.fn()
    const models = vi.fn()
    ctx.provide('connection', {
      rpc: { call: vi.fn() },
    })
    // Remote service double: the payload-free llm/adapters-updated event
    // (20260811 forwarding) is dispatched through the recorded listener; the
    // settings + llm + session namespaces ride it (0.1.2 remote face).
    const { remote, emit } = makeRemote({
      settings: { describe },
      llm: { listConfigurableProviders: providers },
      session: { modelCatalog: models },
    })
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
    applyClient(ctx)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok([]))
    models.mockResolvedValue(ok({ groups: [], failures: [] }))
    await controller!.loadCatalog()
    expect(providers).toHaveBeenCalledTimes(1)
    // Pins the 0.1.2 catalog home: the model catalog loads through
    // `session.modelCatalog` — re-homing it on `llm` in the double turns
    // this red instead of silently re-greening (review IMPORTANT-1).
    expect(models).toHaveBeenCalledTimes(1)

    // A pushed llm/adapters-updated refetches the catalog and leaves the
    // settings descriptor untouched.
    emit('llm/adapters-updated')
    await Promise.resolve()
    expect(providers).toHaveBeenCalledTimes(2)
    expect(models).toHaveBeenCalledTimes(2)
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
    // Connection service double: only the gateway rpc face.
    const history = vi.fn().mockImplementation(() => followAnswer([switchEntry(1)]))
    ctx.provide('connection', {
      rpc: { call: vi.fn() },
    })
    // Remote service double: the invalidation wiring subscribes through it;
    // `session/follow` is the status block's face (0.1.2 remote face).
    ctx.provide('remote', makeRemote({
      settings: { describe: vi.fn() },
      llm: { listConfigurableProviders: vi.fn() },
      session: { modelCatalog: vi.fn(), follow: history },
    }).remote)
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
    applyClient(ctx)
    expect(controller).toBeDefined()

    // The status block opened once (the section mount effect's first read).
    await controller!.loadSwitches()
    expect(history).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledWith({
      address: { kind: 'session', sessionId: 'sess-1' },
      maxMessages: SWITCHES_HISTORY_PAGE,
    })

    // The user switches session → the list subscription reloads for the new id.
    current = 'sess-2'
    for (const listener of [...listeners]) listener()
    await Promise.resolve()
    expect(history).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenLastCalledWith({
      address: { kind: 'session', sessionId: 'sess-2' },
      maxMessages: SWITCHES_HISTORY_PAGE,
    })
  })

  it('settings/document-updated (fallbacks ns) refreshes settings + switches, never the catalog', async () => {
    // Locale service double: register + bind (bind returns a translate thunk).
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
    // Sessions service double: a fixed current session so switches can load.
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: 'sess-1' }), subscribe: () => () => {} },
    })
    // Connection service double: a scripted gateway rpc so load() succeeds.
    const describe = vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const providers = vi.fn()
    const models = vi.fn()
    const history = vi.fn().mockImplementation(() => followAnswer([switchEntry(1)]))
    ctx.provide('connection', {
      rpc: makeRpc().rpc,
    })
    // Remote service double: describe + llm providers + session catalog/follow ride it
    // (0.1.2 remote face).
    const { remote, emit } = makeRemote({
      settings: { describe },
      llm: { listConfigurableProviders: providers },
      session: { modelCatalog: models, follow: history },
    })
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
    applyClient(ctx)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok([]))
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
    const history = vi.fn().mockImplementation(() => followAnswer([switchEntry(1)]))
    ctx.provide('connection', {
      rpc: makeRpc().rpc,
    })
    // Remote service double: describe + session follow ride it (0.1.2 remote face).
    const { remote, emit } = makeRemote({
      settings: { describe },
      llm: { listConfigurableProviders: vi.fn() },
      session: { modelCatalog: vi.fn(), follow: history },
    })
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
    applyClient(ctx)
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
    const history = vi.fn().mockImplementation(() => followAnswer([switchEntry(1)]))
    ctx.provide('connection', {
      rpc: makeRpc().rpc,
    })
    const { remote } = makeRemote({
      settings: { describe },
      llm: { listConfigurableProviders: providers },
      session: { modelCatalog: models, follow: history },
    })
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
    applyClient(ctx)
    expect(controller).toBeDefined()
    providers.mockResolvedValue(ok([]))
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
