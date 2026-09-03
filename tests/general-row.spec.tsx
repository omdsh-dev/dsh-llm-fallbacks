// @vitest-environment jsdom
/**
 * General settings status row (plan fallbacks-aux-seams, task 1):
 * registration-surface spec + rendered-state spec.
 *
 * Registration surface: the fake slots runtime runs the inject generators
 * and records every register call, pinning the row contract: the
 * `settings.general.item` slot ledger holds id 'fallbacks', order 100,
 * locale 'fallbacks', with a business-face-only inject (controller +
 * useSnapshot — no `t`, which the renderer synthesizes from `locale:`
 * via PropsLocale); the plugin-config card registration is untouched.
 *
 * Rendered states: the component is rendered over a scripted gateway wire
 * face (the card spec pattern) and the compact read-only row contract is
 * asserted — enabled badge + one summary line, with honest degraded states:
 * a hard load error or an unreachable channel renders the neutral 'unknown'
 * badge (never 'disabled' — KD-G5), and the switches face keeps its own
 * error/empty states. The lazy first-read effect (mount on an idle store
 * pulls descriptor + recent-switch summary) is pinned by call counts.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ClientConnectionRpc, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '../src/client/use-snapshot.ts'
import { GeneralFallbacksRow } from '../src/client/GeneralFallbacksRow.tsx'
import type { GeneralFallbacksRowProps } from '../src/client/GeneralFallbacksRow.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import type { FallbacksRemote } from '../src/client/fallbacks-store.ts'
import type { FallbacksSettingsState } from '../src/client/fallbacks-store.ts'
import { apply } from '../src/client/index.ts'
import { defaultFallbacksConfig } from '../src/config.ts'
import { en, zh } from '../src/client/locales.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'

afterEach(cleanup)

// The synthesized `t` seat's key domain is the namespace dictionary union
// plus the shared `common` vocabulary; the specs only ever call the row's
// own keys. The test seat performs the framework's `{name}` interpolation
// (the real `t` synthesizes it from the dictionary's declared placeholders),
// so exact-copy assertions exercise the substituted text.
const t: GeneralFallbacksRowProps['t'] = ((key, params) => {
  let text: string = en[key as keyof typeof en]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(value)
    }
  }
  return text
}) as GeneralFallbacksRowProps['t']

/** Full row props the renderer would bind (mirror of the card spec). */
function rowProps(
  controller: FallbacksSettingsController,
  useSnapshot: SnapshotSelectorHook<FallbacksSettingsState>,
): GeneralFallbacksRowProps {
  return {
    controller,
    useSnapshot,
    t,
    useSessions: undefined as never,
    useWorkspaces: undefined as never,
  }
}

/** One gateway RPC success (the channel returns the unwrapped result). */
function okResult<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/** One gateway RPC failure (business rejection or transport fold). */
function failResult(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** One settings/api RPC response envelope (describe/history). */
function ok<T>(value: T) {
  return { ok: true as const, value }
}

interface Scripted {
  api: FallbacksRemote
  rpc: ClientConnectionRpc
  call: Mock
  get: Mock
  describe: Mock
  history: Mock
}

/**
 * A scripted wire face for the row's two reads: `settings.describe` carries
 * `writable` + an empty namespace directory, the fake `rpc.call` serves the
 * `fallbacks/get` endpoint against a mutable effective config, and
 * `sessions.history` serves the recent-switch page. `config: null` = the
 * gateway is unreachable (get fails) — the KD-G5 degraded path.
 */
function scriptedApi(options: {
  config?: typeof defaultFallbacksConfig | null
  historyEntries?: SessionEventLikeEntry[]
  historyError?: string
  describeError?: string
} = {}): Scripted {
  let current = options.config === undefined ? defaultFallbacksConfig : options.config
  const describe = vi.fn(() => options.describeError === undefined
    ? Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [] }))
    : Promise.reject(new Error(options.describeError)))
  const get = vi.fn(() => Promise.resolve(
    current === null
      ? failResult('fallbacks gateway is not ready')
      : okResult({ config: current }),
  ))
  const history = vi.fn((): AsyncIterable<SessionFollowFrame> => (async function* (): AsyncGenerator<SessionFollowFrame> {
    if (options.historyError !== undefined) throw new Error(options.historyError)
    yield {
      type: 'snapshot', records: options.historyEntries ?? [], hasMore: false,
    } as unknown as SessionFollowFrame
    await Promise.withResolvers().promise
  })())
  const call = vi.fn((channel: string, endpoint: string) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'fallbacks/get') return get()
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    api: {
      settings: { describe },
      session: { follow: history },
    } as unknown as FallbacksRemote,
    rpc: { call } as unknown as ClientConnectionRpc,
    call,
    get,
    describe,
    history,
  }
}

/** One `fallbacks/switch` history entry with a deterministic seq/time (store-spec fixture shape). */
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

/** Preload the store (descriptor + current session + switches), then render the row. */
async function mountRow(
  options: Parameters<typeof scriptedApi>[0] = {},
  preload: { load?: boolean; switches?: boolean } = { load: true, switches: true },
) {
  const scripted = scriptedApi(options)
  const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
  if (preload.load !== false) await controller.load()
  if (preload.switches !== false) {
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
  }
  const props = rowProps(controller, bindSnapshotSelector(controller.store))
  const view = render(<GeneralFallbacksRow {...props} />)
  return { view, controller, scripted, props }
}

/** A loaded config with `enabled: true`. */
const ENABLED_CONFIG: typeof defaultFallbacksConfig = { ...defaultFallbacksConfig, enabled: true }

/**
 * A minimal fake of the client slots service + context for the registration
 * ledger test (the card spec's pattern): `inject(name, generator)` runs the
 * generator and records every `register` call; `ctx.get('connection')`
 * serves an inert wire face; everything else apply() touches (locale
 * register, pushed-invalidation subscriptions) is recorded but inert.
 */
function fakeRuntime() {
  const ledger: Record<string, Array<{ name: string; options: Record<string, unknown>; component: unknown }>> = {}
  const disposers: Array<() => void> = []
  const locales: Record<string, unknown> = {}
  // rc.1 dotted-namespace contract: each client Remote namespace is a
  // child-fiber service named `remote.<ns>` (upstream `remoteServiceKey`);
  // the fixture provides them as separate dotted services (empty faces —
  // this spec never reads namespaces) so the declared injects resolve like
  // production, and the assembly face forwards to them (mirror of the
  // traceable proxy: `ctx.remote.llm` → `ctx['remote.llm']`).
  const services: Record<string, unknown> = {
    'remote.llm': {},
    'remote.settings': {},
    'remote.session': {},
  }
  const slots = {
    register: (options: Record<string, unknown>, component: unknown): (() => void) => {
      const name = options.name as string
      ;(ledger[name] ??= []).push({ name, options, component })
      return () => {}
    },
    inject: (name: string, callback: () => Iterable<() => void>): (() => void) => {
      for (const dispose of callback()) disposers.push(dispose)
      return () => { for (const dispose of disposers.splice(0)) dispose() }
    },
  }
  const ctx = {
    slots,
    // `uiConversation` service double (the D1 Definition registry's home
    // since 0.1.2): apply() registers the `fallbacks-switch` Definition
    // through `ctx.uiConversation.events`; the row spec only pins that the
    // call happens without disturbing the row/card.
    uiConversation: {
      events: { register: (): (() => void) => () => {} },
    },
    locale: {
      register: (ns: string, dict: unknown): (() => void) => {
        locales[ns] = dict
        return () => { delete locales[ns] }
      },
      bind: (): never => { throw new Error('test: apply must not bind t — the row t seat comes from PropsLocale') },
    },
    get: (key: string): unknown => {
      if (key === 'connection') {
        return { rpc: { call: vi.fn() } }
      }
      return services[key]
    },
    effect: (fn: () => unknown): (() => void) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer as () => void : () => {}
    },
    on: (event: string, _handler: () => void): (() => void) => {
      if (!['connection/reset'].includes(event)) {
        throw new Error(`test: unexpected event ${event}`)
      }
      return () => {}
    },
    remote: {
      $on: (event: string, _listener: (...args: unknown[]) => void): (() => void) => {
        if (!['settings/document-updated', 'llm/adapters-updated'].includes(event)) {
          throw new Error(`test: unexpected remote event ${event}`)
        }
        return () => {}
      },
      get llm() { return services['remote.llm'] },
      get settings() { return services['remote.settings'] },
      get session() { return services['remote.session'] },
    },
  }
  return { ctx, ledger, locales }
}

describe('GeneralFallbacksRow registration (settings.general.item)', () => {
  it('registers the status row alongside the unchanged plugin-config card', () => {
    const { ctx, ledger, locales } = fakeRuntime()
    apply(ctx as unknown as Parameters<typeof apply>[0])

    // The general-item ledger holds exactly one fallbacks row.
    const rows = ledger['settings.general.item'] ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0].options.id).toBe('fallbacks')
    expect(rows[0].options.order).toBe(100)
    expect(rows[0].options.locale).toBe('fallbacks')
    expect(rows[0].component).toBe(GeneralFallbacksRow)

    // Inject face carries the business surface only — the typed `t` seat is
    // synthesized by the renderer from `locale:`, never injected.
    const face = (rows[0].options.inject as () => Record<string, unknown>)()
    expect(face.controller).toBeInstanceOf(FallbacksSettingsController)
    expect(typeof face.useSnapshot).toBe('function')
    expect(face).not.toHaveProperty('t')

    // The plugin-config card registration is untouched (rc.7 keyed-slot `key`
    // alongside the list-slot `id` — pre-rc.7 hosts require options.id, the
    // keyed loader ignores the extra id).
    const cards = ledger['settings.plugin.item'] ?? []
    expect(cards).toHaveLength(1)
    expect(cards[0].options.key).toBe('fallbacks')
    expect(cards[0].options.id).toBe('fallbacks')
    expect(cards[0].options).not.toHaveProperty('order')

    // The dictionary namespace registers with the en/zh pair.
    expect(locales['fallbacks']).toEqual({ zh, en })
  })
})

describe('GeneralFallbacksRow states (compact read-only row)', () => {
  it('renders the enabled badge + last-switch summary from a settled read', async () => {
    await mountRow({
      config: ENABLED_CONFIG,
      historyEntries: [switchEntry(9), switchEntry(4)],
    })
    await waitFor(() => expect(screen.getByText(en['general.enabled'])).toBeTruthy())
    expect(screen.getByText(en['general.title'])).toBeTruthy()
    // The most recent switch (newest first): from → to (role · reason).
    expect(screen.getByText(
      'Last switch: openai/gpt-4o → anthropic/claude-3-5-sonnet (inherit · trigger code)',
    )).toBeTruthy()
    // No error alert on a healthy row.
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders the disabled badge + honest empty switch state', async () => {
    await mountRow({ config: defaultFallbacksConfig, historyEntries: [] })
    await waitFor(() => expect(screen.getByText(en['general.disabled'])).toBeTruthy())
    expect(screen.getByText(en['general.switch.empty'])).toBeTruthy()
  })

  it('renders an unknown reason value raw (forward-compatible log)', async () => {
    await mountRow({
      config: ENABLED_CONFIG,
      historyEntries: [switchEntry(2, { reason: 'future-reason' as never })],
    })
    await waitFor(() => expect(screen.getByText(
      'Last switch: openai/gpt-4o → anthropic/claude-3-5-sonnet (inherit · future-reason)',
    )).toBeTruthy())
  })

  it('renders the role-inject last-switch line as the deduped role → model mapping (localized reason)', async () => {
    // Task 5 (direction 3): a `role-inject` switch reads naturally as the
    // resolved role mapping to its chain-head model (`reviewer →
    // anthropic/claude-3-5-sonnet`) — the destination `{to}` appears once
    // (as the role→model mapping), not twice; the leading `{from} → {to}`
    // is dropped. Role + reason both stay visible (AC-5).
    await mountRow({
      config: ENABLED_CONFIG,
      historyEntries: [switchEntry(9, { role: 'reviewer', reason: 'role-inject' })],
    })
    await waitFor(() => expect(screen.getByText(en['general.enabled'])).toBeTruthy())
    expect(screen.getByText(
      'Last switch: reviewer → anthropic/claude-3-5-sonnet (role inject)',
    )).toBeTruthy()
    // No error alert on a healthy role-inject row.
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders the neutral unknown badge + channel-unavailable line when the gateway is unreachable', async () => {
    await mountRow({ config: null })
    await waitFor(() => expect(screen.getByText(en['general.unknown'])).toBeTruthy())
    // KD-G5 honesty: an unreachable channel never masquerades as 'disabled'.
    expect(screen.queryByText(en['general.disabled'])).toBeNull()
    expect(screen.getByText(en['general.unavailable'])).toBeTruthy()
  })

  it('renders the neutral unknown badge + status read error on a hard load failure', async () => {
    await mountRow({ describeError: 'describe refused' })
    await waitFor(() => expect(screen.getByText(en['general.unknown'])).toBeTruthy())
    expect(screen.getByText('Status read failed: describe refused')).toBeTruthy()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('keeps the enabled badge and surfaces the switches read error with an alert', async () => {
    await mountRow({ config: ENABLED_CONFIG, historyError: 'history refused' })
    await waitFor(() => expect(screen.getByText(en['general.enabled'])).toBeTruthy())
    expect(screen.getByText('Switch history read failed: history refused')).toBeTruthy()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('pulls the first read on mount when the store is idle (lazy load)', async () => {
    const scripted = scriptedApi({ config: ENABLED_CONFIG, historyEntries: [] })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    const view = render(<GeneralFallbacksRow {...rowProps(controller, bindSnapshotSelector(controller.store))} />)
    // The mount effect fires both idle guards.
    await waitFor(() => expect(scripted.get).toHaveBeenCalledTimes(1))
    expect(scripted.describe).toHaveBeenCalledTimes(1)
    // No current session → the switches face settles empty without an RPC.
    expect(scripted.history).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText(en['general.enabled'])).toBeTruthy())
    expect(screen.getByText(en['general.switch.empty'])).toBeTruthy()
    view.unmount()
  })

  it('does not re-read when the store was already loaded', async () => {
    const scripted = scriptedApi({ config: ENABLED_CONFIG, historyEntries: [switchEntry(1)] })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const getCalls = scripted.get.mock.calls.length
    const historyCalls = scripted.history.mock.calls.length

    render(<GeneralFallbacksRow {...rowProps(controller, bindSnapshotSelector(controller.store))} />)
    await waitFor(() => expect(screen.getByText(en['general.enabled'])).toBeTruthy())
    // Both idle guards are already satisfied → no new reads.
    expect(scripted.get).toHaveBeenCalledTimes(getCalls)
    expect(scripted.history).toHaveBeenCalledTimes(historyCalls)
  })
})
