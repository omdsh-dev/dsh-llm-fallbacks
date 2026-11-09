/**
 * Client-half store unit tests (named virtual chains, plan
 * named-virtual-chains T5): config parsing (the gateway `config` value
 * folded against spec defaults, malformed values rejected), the per-chain
 * / role / slot row editors' pure round-trips, the role chain POINTER
 * merge, `deriveEffectiveModel` per chain, and the controller's
 * load/save/reset lifecycle over the plugin gateway channel — a fake
 * `connection.rpc` for `/api/fallbacks/get|set|reset` plus `api` mocks for
 * describe (writable + namespace directory) / llm catalog. The
 * switch-history read and the host-policy view are GONE with the status
 * surfaces; set/reset failures surface the message in the error banner
 * state, and a get failure is the channel-unreachable `present: false`
 * skeleton (KD-G5), never a page error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { defaultFallbacksConfig, type FallbacksConfig, type NamedChain } from '../src/config.ts'
import { OFFICIAL_FLASH, OFFICIAL_PRO } from '../src/time-slots.ts'
import { apply as applyClient } from '../src/client/index.ts'
import {
  chainsToDrafts,
  classifyModel,
  classifyProvider,
  configuredProvidersOf,
  deriveEffectiveModel,
  draftToChain,
  entryToSelectorRow,
  mergeRoleExtras,
  newChainId,
  FALLBACKS_SETTINGS_NS,
  FallbacksSettingsController,
  parseFallbacksConfig,
  refreshCatalogIfLoaded,
  refreshFallbacksIfLoaded,
  roleChainOptions,
  rolesToRows,
  rowsToRoles,
  rowsToTimeSlots,
  selectorRowToRaw,
  timeSlotsToRows,
  type CatalogLookup,
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

/** The settings + llm + session Remote-namespace faces the store reads, as spies (0.1.2 `ctx.remote` face). */
function makeApi() {
  return {
    settings: {
      describe: vi.fn(),
    },
    llm: {
      listConfigurableProviders: vi.fn(),
      modelCatalog: vi.fn(),
    },
  }
}

/**
 * A `remote` service double for the client apply wiring: provides the rc.1
 * dotted namespace services (`remote.settings` / `remote.llm` /
 * `remote.session` — upstream `remoteServiceKey`) so the declared injects
 * resolve through the same fiber walk production uses, and provides the
 * assembly face (`remote`) whose namespace getters forward to the dotted
 * services (mirror of the traceable proxy: `ctx.remote.llm` →
 * `ctx['remote.llm']`). Records `$on` subscriptions (returning per-event
 * disposers, tracked for teardown assertions) and dispatches the forwarded
 * remote events (`settings/document-updated`, `llm/adapters-updated`)
 * through the recorded listener, mirroring the gateway's one-way delivery.
 * One `Set` per event (qc2 S-5 / qc3 S-3): `Map.set` silently overwrote an
 * earlier listener, so a regressed duplicate `$on` registration would pass;
 * the Set plus the single-listener emit guard make any double subscription
 * fail loudly.
 */
function makeRemote(ctx: Context, namespaces: { settings?: unknown; llm?: unknown; session?: unknown } = {}) {
  // rc.1 dotted-namespace contract: each client Remote namespace is a
  // child-fiber service named `remote.<ns>`; provide them as separate
  // dotted services so the fiber walk resolves them exactly like production.
  for (const [ns, value] of Object.entries(namespaces)) {
    ctx.provide(`remote.${ns}`, value)
  }
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
  // The assembly face: `$on` invalidation seat + namespace getters
  // forwarding to the dotted services (mirror of the traceable proxy).
  const remote = {
    $on,
    get settings() { return ctx.get('remote.settings') },
    get llm() { return ctx.get('remote.llm') },
    get session() { return ctx.get('remote.session') },
  }
  ctx.provide('remote', remote)
  return {
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


/** A v2 config fixture: two named chains + a role pointing at the first. */
function v2Config(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return {
    ...defaultFallbacksConfig,
    chains: [
      { id: 'Auto', label: '默认链', entries: ['openai/gpt-4o', OFFICIAL_FLASH], timeSlots: [] },
      { id: 'night', label: '夜间', entries: [OFFICIAL_PRO], timeSlots: [] },
    ],
    roles: { list: [{ id: 'coder', persona: 'Coder', chain: 'Auto' }] },
    ...overrides,
  }
}

describe('parseFallbacksConfig (descriptor read, v2)', () => {
  it('returns the spec defaults for an empty descriptor', () => {
    expect(parseFallbacksConfig({})).toEqual(defaultFallbacksConfig)
  })

  it('parses the v2 shape and preserves role extras (prompt/permissions)', () => {
    const parsed = parseFallbacksConfig({
      chains: [{ id: 'Auto', label: '默认链', entries: [OFFICIAL_FLASH], timeSlots: [{ kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_PRO] }] }],
      roles: { list: [{ id: 'coder', persona: 'C', chain: 'Auto', prompt: 'be nice', permissions: { allow: ['a'] } }] },
      cooldownMs: 5,
    })
    expect(parsed.chains).toEqual([{
      id: 'Auto', label: '默认链', entries: [OFFICIAL_FLASH],
      timeSlots: [{ kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_PRO] }],
    }])
    expect(parsed.roles.list).toEqual([{
      id: 'coder', persona: 'C', chain: 'Auto', prompt: 'be nice', permissions: { allow: ['a'] },
    }])
    expect(parsed.cooldownMs).toBe(5)
    expect(parsed.triggerCodes).toEqual(defaultFallbacksConfig.triggerCodes)
  })

  it('an empty role chain pointer stays absent (NOT SPECIFIED)', () => {
    const parsed = parseFallbacksConfig({ roles: { list: [{ id: 'a', persona: '', chain: '' }] } })
    expect(parsed.roles.list[0]).toEqual({ id: 'a', persona: '' })
  })

  it('rejects malformed descriptor shapes', () => {
    expect(() => parseFallbacksConfig('nope')).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ chains: 'nope' })).toThrow(/named chains/)
    expect(() => parseFallbacksConfig({ chains: [{ id: 1 }] })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ chains: [{ id: 'a', label: 'b', entries: 'x' }] })).toThrow(TypeError)
    expect(() => parseFallbacksConfig({ roles: { list: [{ persona: 'no id' }] } })).toThrow(/string id/)
    // A v1 ARRAY chain is NOT a malformed shape any more: an un-migrated host
    // must not brick the card, so it reads as NOT SPECIFIED (plan
    // fallbacks-v1-auto-migration T2).
    expect(parseFallbacksConfig({ roles: { list: [{ id: 'a', chain: ['v1-array'] }] } }).roles.list[0]).toEqual({ id: 'a', persona: '' })
    expect(() => parseFallbacksConfig({ cooldownMs: 'x' })).toThrow(/number/)
    expect(() => parseFallbacksConfig({ revertPolicy: 'sometimes' })).toThrow(/cooldown-expiry\|never/)
    expect(() => parseFallbacksConfig({ presets: 'sometimes' })).toThrow(/bundled\|none/)
    expect(() => parseFallbacksConfig({ recovery: 'sometimes' })).toThrow(/timer\|half-open/)
  })
})

describe('per-chain row editors (pure round-trips)', () => {
  it('chainsToDrafts classifies entries; draftToChain round-trips verbatim', () => {
    const config = v2Config()
    const drafts = chainsToDrafts(config.chains, catalogFixture())
    expect(drafts.map(draft => draft.id)).toEqual(['Auto', 'night'])
    expect(draftToChain(drafts[0]!)).toEqual(config.chains[0])
    expect(draftToChain(drafts[1]!)).toEqual(config.chains[1])
  })

  it('draftToChain drops blank selector rows', () => {
    const drafts = chainsToDrafts(v2Config().chains)
    drafts[0]!.selectors = [{ wildcard: false, provider: null, model: null, effort: null }, ...drafts[0]!.selectors]
    expect(draftToChain(drafts[0]!).entries).toEqual(['openai/gpt-4o', OFFICIAL_FLASH])
  })

  it('reads a pinned effort from the entry and serializes it back', () => {
    const row = entryToSelectorRow('openai/gpt-4o@high', catalogFixture())
    expect(row).toMatchObject({ wildcard: false, effort: 'high' })
    expect(selectorRowToRaw(row)).toBe('openai/gpt-4o@high')
    // A wildcard entry keeps its own pin.
    expect(selectorRowToRaw(entryToSelectorRow('anthropic/*@low', catalogFixture()))).toBe('anthropic/*@low')
  })

  it('an effort-free entry stays byte-identical to today', () => {
    const row = entryToSelectorRow(OFFICIAL_FLASH, catalogFixture())
    expect(row.effort).toBeNull()
    expect(selectorRowToRaw(row)).toBe(OFFICIAL_FLASH)
  })

  it('legacy configs round-trip byte-identically (the dirty check stays quiet)', () => {
    const config = v2Config()
    const drafts = chainsToDrafts(config.chains, catalogFixture())
    // JSON equality, not just deep equality: an `effort: null` that leaked into
    // the wire string would show up here first.
    expect(JSON.stringify(drafts.map(draftToChain))).toBe(JSON.stringify(config.chains))
  })

  it('newChainId generates a unique id', () => {
    const chains = v2Config().chains
    expect(newChainId(chains)).toBe('chain-3')
    expect(newChainId([...chains, { id: 'chain-3', label: '', entries: [] }])).toBe('chain-4')
  })

  it('timeSlotsToRows/rowsToTimeSlots round-trip; kind rides VERBATIM (hand-written unknown kind)', () => {
    const slots: SlotRowConfig[] = [
      { kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_PRO] },
      { kind: 'custom', start: '09:00', end: '12:00', days: [1], name: '早高峰', chain: [OFFICIAL_FLASH] },
    ]
    const rows = timeSlotsToRows(slots, catalogFixture())
    expect(rowsToTimeSlots(rows)).toEqual(slots)
    const weird = timeSlotsToRows([{ kind: 'weird', chain: [OFFICIAL_FLASH] } as unknown as SlotRowConfig])
    expect(rowsToTimeSlots(weird)[0]).toEqual({ kind: 'weird', preset: undefined, start: '', end: '', days: [], chain: [OFFICIAL_FLASH] })
  })
})

describe('role chain POINTER (指定降级链)', () => {
  it('rolesToRows keeps the pointer; rowsToRoles drops an empty one', () => {
    const rows = rolesToRows(v2Config().roles.list)
    expect(rows[0]).toMatchObject({ id: 'coder', persona: 'Coder', chain: 'Auto', collapsed: true })
    expect(rowsToRoles([{ id: 'a', persona: '', chain: '', collapsed: false, personaOpen: false }]))
      .toEqual([{ id: 'a', persona: '' }])
    expect(rowsToRoles(rows)).toEqual(v2Config().roles.list)
  })

  it('mergeRoleExtras re-attaches the schema-reserved prompt/permissions by id', () => {
    const original = parseFallbacksConfig({
      roles: { list: [{ id: 'coder', persona: 'old', chain: 'Auto', prompt: 'keep me' }] },
    }).roles.list
    const rows = rolesToRows(original).map(row => ({ ...row, persona: 'new' }))
    expect(mergeRoleExtras(rows, original)).toEqual([{ id: 'coder', persona: 'new', prompt: 'keep me', chain: 'Auto' }])
    // A fresh row keeps no extras.
    expect(mergeRoleExtras([{ id: 'new', persona: '', chain: '', collapsed: false, personaOpen: false }], original))
      .toEqual([{ id: 'new', persona: '' }])
  })

  it('roleChainOptions lists every declared chain id in order', () => {
    expect(roleChainOptions(v2Config().chains)).toEqual(['Auto', 'night'])
    expect(roleChainOptions([])).toEqual([])
  })
})

describe('deriveEffectiveModel (per-chain display value)', () => {
  it('unavailable for no chain / empty entries', () => {
    expect(deriveEffectiveModel(undefined)).toEqual({ kind: 'unavailable' })
    expect(deriveEffectiveModel({ id: 'a', label: '', entries: [] })).toEqual({ kind: 'unavailable' })
  })

  it('config for the first entry (the dispatch head)', () => {
    expect(deriveEffectiveModel(v2Config().chains[0])).toEqual({ kind: 'config', provider: 'openai', model: 'gpt-4o' })
  })
})

describe('FallbacksSettingsController (v2 lifecycle)', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
  })

  function mount(config?: FallbacksConfig | null, options: { writable?: boolean } = {}) {
    const rpc = makeRpc(config)
    const api = makeApi()
    api.settings.describe.mockResolvedValue(ok({ writable: options.writable ?? true, namespaces: [] }))
    api.llm.listConfigurableProviders.mockResolvedValue(ok(configuredFixture().providers))
    api.llm.modelCatalog.mockResolvedValue(ok({ groups: catalogFixture().groups }))
    const controller = new FallbacksSettingsController(api as never, rpc.rpc)
    ctx.effect(() => () => controller.dispose(), 'test: controller dispose')
    return { rpc, api, controller }
  }

  it('load folds the gateway config into the store (chains + roles visible)', async () => {
    const { controller } = mount(v2Config())
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(true)
    expect(state.config.chains.map(chain => chain.id)).toEqual(['Auto', 'night'])
    expect(state.config.roles.list[0]).toMatchObject({ id: 'coder', chain: 'Auto' })
    expect(state.subagentPolicy).toBeUndefined()
    expect('switches' in state).toBe(false)
  })

  it('a get failure is the present:false skeleton (KD-G5), never a page error', async () => {
    const { controller } = mount(null)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.present).toBe(false)
    expect(state.config).toEqual(defaultFallbacksConfig)
  })

  it('save writes the patch and re-accepts the composed config; the per-chain save rides the accepted base', async () => {
    const { rpc, controller } = mount(v2Config())
    await controller.load()
    const edited: NamedChain = { ...v2Config().chains[0]!, label: '改名' }
    await controller.save({ ...v2Config(), chains: [edited, v2Config().chains[1]!] })
    expect(rpc.set).toHaveBeenCalledTimes(1)
    const patch = rpc.set.mock.calls[0]![0].args.patch as FallbacksConfig
    expect(patch.chains[0]).toMatchObject({ id: 'Auto', label: '改名' })
    expect(patch.chains[1]).toEqual(v2Config().chains[1])
    expect(controller.store.getSnapshot().config.chains[0]).toMatchObject({ label: '改名' })
  })

  it('a save failure surfaces the message in state.error and keeps the form editable', async () => {
    const { rpc, controller } = mount(v2Config())
    const innerCall = rpc.call
    rpc.rpc.call = vi.fn(((channel: string, endpoint: string, payload: unknown) => {
      if (endpoint === 'fallbacks/set') {
        return Promise.resolve(failResult('tail must conform'))
      }
      return innerCall(channel, endpoint, payload)
    }) as never) as never
    await controller.load()
    await controller.save(v2Config())
    const state = controller.store.getSnapshot()
    expect(state.error).toBe('tail must conform')
    expect(state.writable).toBe(true)
  })

  it('reset clears the user layer back to defaults', async () => {
    const { rpc, controller } = mount(v2Config())
    await controller.load()
    await controller.resetToDefaults()
    expect(rpc.reset).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().config).toEqual(defaultFallbacksConfig)
  })

})

describe('configuredProvidersOf (Models-page `configured` join)', () => {
  it('joins catalog providers with the settings namespace directory', () => {
    const namespaces = new Map([
      ['llm-providers', providerNs('llm-providers', { providers: { openai: {} } })],
      ['llm-deepseek', providerNs('llm-deepseek', {})],
    ])
    const joined = configuredProvidersOf(configuredFixture().providers, namespaces)
    // deepseek-official (settingsPath []) is always configured; openai's
    // namespace carries the provider; anthropic/google are absent.
    expect(joined.map(entry => entry.provider).sort()).toEqual(['deepseek-official', 'openai'])
  })
})
