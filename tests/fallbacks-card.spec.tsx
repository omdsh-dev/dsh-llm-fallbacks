// @vitest-environment jsdom
/**
 * Fallbacks settings card (plan fallbacks-plugin-config-card, task 1 + 2):
 * registration-surface spec + card-chrome contract spec.
 *
 * Registration surface (task 1): the fake slots runtime runs the inject
 * generator and records every register call, pinning the card contract: the
 * `settings.plugin.item` slot ledger holds id 'fallbacks', order 30, locale
 * 'fallbacks' with a business-face-only inject (controller + useSnapshot —
 * no `t`, which the renderer synthesizes from `locale:` via PropsLocale);
 * the old `settings.section` fallbacks registration is gone, so the section
 * ledger never holds a fallbacks entry (nav removal regression).
 *
 * Card chrome (task 2): the component is rendered over a scripted gateway
 * wire face (the advisor spec pattern) and the upstream PluginCard contract
 * is asserted — a single `<li>` whose header button (name over description,
 * dirty pill, chevron, aria-expanded/aria-label) discloses the form body;
 * collapsed by default, staged edits outlive collapsing, Discard/Save follow
 * the upstream disabled semantics, and the degraded card (gateway channel
 * unreachable — `ready && !present`) is derived-open with the notice + the
 * still-usable skeleton (AC-1 divergence: no white screen).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  ClientConnectionRpc, IApiClient, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { FallbacksCard } from '../src/client/FallbacksCard.tsx'
import type { FallbacksCardProps } from '../src/client/FallbacksCard.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import type { FallbacksSettingsState } from '../src/client/fallbacks-store.ts'
import { apply } from '../src/client/index.ts'
import { defaultFallbacksConfig } from '../src/config.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The synthesized `t` seat's key domain is the namespace dictionary union
// plus the shared `common` vocabulary; the specs only ever call the card's
// own keys, so the en-lookup casts the key.
const t: FallbacksCardProps['t'] = key => en[key as keyof typeof en]

/**
 * Full card props the renderer would bind: the registrant's business inject
 * face (controller + useSnapshot), the framework-synthesized `t` seat, and
 * the runtime's global seat (session-list / workspace-list selector hooks —
 * every slot component receives them; the specs never exercise them).
 */
function cardProps(controller: FallbacksSettingsController, useSnapshot: SnapshotSelectorHook<FallbacksSettingsState>): FallbacksCardProps {
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

/** One settings/api RPC response envelope (describe/providers/models/history). */
function ok(value: unknown) {
  return { result: { ok: true, value } }
}

interface Scripted {
  api: Pick<IApiClient, 'settings' | 'llm' | 'sessions'>
  rpc: ClientConnectionRpc
  call: Mock
  get: Mock
  set: Mock
  reset: Mock
  describe: Mock
}

/**
 * A scripted wire face: `settings.describe` carries `writable` + an empty
 * namespace directory, the catalog is empty (the chrome spec does not
 * exercise dropdown options), and the fake `rpc.call` serves the
 * `fallbacks/get` + `fallbacks/set` + `fallbacks/reset` endpoints against a
 * mutable effective config (store-spec fixture shape). `config: null` = the
 * gateway is unreachable (get fails) — the KD-G5 degraded path.
 */
function scriptedApi(options: {
  config?: typeof defaultFallbacksConfig | null
  writable?: boolean
  legacyKeys?: string[]
} = {}): Scripted {
  let current = options.config === undefined ? defaultFallbacksConfig : options.config
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: options.writable ?? true,
    hasDocument: false,
    namespaces: [],
  })))
  const providers = vi.fn(() => Promise.resolve(ok({ providers: [] })))
  const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
  const history = vi.fn(() => Promise.resolve(ok({ events: [] })))
  const get = vi.fn(() => Promise.resolve(
    current === null
      ? failResult('fallbacks gateway is not ready')
      : okResult({
          config: current,
          ...(options.legacyKeys === undefined ? {} : { legacyKeys: options.legacyKeys }),
        }),
  ))
  const set = vi.fn((payload: { args: { patch: typeof defaultFallbacksConfig } }) => {
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
    if (endpoint === 'fallbacks/set') return set(payload as { args: { patch: typeof defaultFallbacksConfig } })
    if (endpoint === 'fallbacks/reset') return reset()
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    api: {
      settings: { describe, openDocument: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
      llm: { providers, models, discoverModels: vi.fn() },
      sessions: { history },
    } as unknown as Pick<IApiClient, 'settings' | 'llm' | 'sessions'>,
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, reset, describe,
  }
}

/** Preload the store, then render the card (advisor spec pattern). */
async function mountCard(options: Parameters<typeof scriptedApi>[0] = {}, preload = true) {
  const scripted = scriptedApi(options)
  const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
  if (preload) await controller.load()
  const props = cardProps(controller, bindSnapshotSelector(controller.store))
  const view = render(<FallbacksCard {...props} />)
  return { view, controller, scripted, props }
}

/**
 * A loaded config with `enabled: true` so the enabled-gated fieldset (the
 * numeric fields, chains, roles) renders in the card body — the draft is
 * still clean (it seeds from this same config), so the disabled-term and
 * dirty-transition assertions hold.
 */
const ENABLED_CONFIG: typeof defaultFallbacksConfig = { ...defaultFallbacksConfig, enabled: true }

/**
 * A two-block config (spec §8) exercising every new editing surface: a
 * rootChain, two declared role entities (one with its own chain, one
 * chain-less with `fallback: none`), and role rules referencing a declared
 * id and the built-in `inherit`.
 */
const TWO_BLOCK_CONFIG: typeof defaultFallbacksConfig = {
  ...defaultFallbacksConfig,
  enabled: true,
  rootChain: ['openai/gpt-4o'],
  roles: {
    list: [
      { id: 'reviewer', label: 'Reviewer', description: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
      { id: 'architect', label: 'Architect', description: 'Designs systems', chain: [], fallback: 'none' },
    ],
    rules: [
      { origin: 'subagent', role: 'reviewer' },
      { role: 'inherit' },
    ],
  },
}

/**
 * The card's header disclosure button. The accessible name is the upstream
 * aria-label — `collapse/expand: title` — which flips with the open state.
 */
function headerButton(open: boolean): HTMLElement {
  const label = `${open ? en.collapse : en.expand}: ${en.title}`
  return screen.getByRole('button', { name: new RegExp(`^${label}$`) })
}

/** Toggle the card open/closed through its header button. */
function toggleCard(): void {
  const button = screen.getByRole('button', {
    name: new RegExp(`^(${en.expand}|${en.collapse}): ${en.title}$`),
  })
  fireEvent.click(button)
}

/**
 * A minimal fake of the client slots service + context for the registration
 * ledger test: `inject(name, generator)` runs the generator and records every
 * `register` call (the real runtime does the same through ctx.effect), and
 * `ctx.get('connection')` serves an inert wire face (the controller only
 * stores it until a load is requested). Everything else the plugin's apply
 * touches (locale register, pushed-invalidation subscriptions) is recorded
 * but inert; the locale `bind` seat throws because apply must NOT bind `t` —
 * the card `t` seat comes from PropsLocale.
 */
function fakeRuntime() {
  const ledger: Record<string, Array<{ name: string; options: Record<string, unknown>; component: unknown }>> = {}
  const disposers: Array<() => void> = []
  const locales: Record<string, unknown> = {}
  const slots = {
    register: (options: Record<string, unknown>, component: unknown): (() => void) => {
      const name = options.name as string
      ;(ledger[name] ??= []).push({ name, options, component })
      return () => {}
    },
    inject: (name: string, callback: () => Iterable<() => void>): (() => void) => {
      // The runtime iterates the generator transactionally; the yields are
      // the register disposers. The register calls themselves already filled
      // the ledger.
      for (const dispose of callback()) disposers.push(dispose)
      return () => { for (const dispose of disposers.splice(0)) dispose() }
    },
  }
  const ctx = {
    slots,
    conversationEvents: {
      // The transcript switch node Definition registry (plan 3 T2 D1):
      // apply() registers the `fallbacks-switch` Definition; the card spec
      // only pins that the call happens without disturbing the card.
      register: (): (() => void) => () => {},
    },
    locale: {
      register: (ns: string, dict: unknown): (() => void) => {
        locales[ns] = dict
        return () => { delete locales[ns] }
      },
      bind: (): never => { throw new Error('test: apply must not bind t — the card t seat comes from PropsLocale') },
    },
    get: (key: string): unknown => (
      key === 'connection'
        ? {
            api: {
              settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
              llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
              sessions: { history: vi.fn() },
            },
            rpc: { call: vi.fn() },
          }
        : undefined
    ),
    effect: (fn: () => unknown): (() => void) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer as () => void : () => {}
    },
    on: (event: string, _handler: () => void): (() => void) => {
      // Task 3 moved the settings/catalog invalidations onto ctx.remote.$on
      // (the 20260811 remote events); only the client `connection/reset`
      // event remains on the context itself. Pinning the exact set here
      // makes any future drift visible.
      if (!['connection/reset'].includes(event)) {
        throw new Error(`test: unexpected event ${event}`)
      }
      return () => {}
    },
    remote: {
      $on: (event: string, _listener: (...args: unknown[]) => void): (() => void) => {
        // The two forwarded remote events the invalidation wiring subscribes
        // through (settings/document-updated ns-filtered, llm/adapters-updated
        // payload-free). The registration spec below pins them; dispatch
        // semantics live in the store spec's remote double.
        if (!['settings/document-updated', 'llm/adapters-updated'].includes(event)) {
          throw new Error(`test: unexpected remote event ${event}`)
        }
        return () => {}
      },
    },
  }
  return { ctx, ledger, locales }
}

describe('FallbacksCard registration (settings.plugin.item)', () => {
  it('registers the fallbacks card and leaves no fallbacks entry in settings.section', () => {
    const { ctx, ledger, locales } = fakeRuntime()
    apply(ctx as unknown as ClientContext)

    // The card ledger holds exactly one fallbacks card.
    const cards = ledger['settings.plugin.item'] ?? []
    expect(cards).toHaveLength(1)
    expect(cards[0].options.id).toBe('fallbacks')
    expect(cards[0].options.order).toBe(30)
    expect(cards[0].options.locale).toBe('fallbacks')
    // No nav-label thunk survives from the removed section registration.
    expect(cards[0].options).not.toHaveProperty('label')
    expect(cards[0].component).toBe(FallbacksCard)

    // Inject face carries the business surface only — the typed `t` seat is
    // synthesized by the renderer from `locale:`, never injected.
    const face = (cards[0].options.inject as () => Record<string, unknown>)()
    expect(face.controller).toBeInstanceOf(FallbacksSettingsController)
    expect(typeof face.useSnapshot).toBe('function')
    expect(face).not.toHaveProperty('t')

    // The old section registration is gone (nav removal regression): the
    // section ledger holds no fallbacks entry at all.
    const sections = ledger['settings.section'] ?? []
    expect(sections.some(entry => entry.options.id === 'fallbacks')).toBe(false)
    expect(sections).toHaveLength(0)

    // The dictionary namespace registers with the en/zh pair.
    expect(locales['fallbacks']).toEqual({ zh, en })
  })
})

describe('FallbacksCard chrome (upstream PluginCard contract)', () => {
  it('renders a single li collapsed by default: header copy + chevron, no form', async () => {
    const { view, props } = await mountCard()
    // The card root is one <li> (the plugin-config section lists the cards).
    expect(document.querySelectorAll('li')).toHaveLength(1)
    const header = headerButton(false)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.getAttribute('aria-label')).toBe(`${en.expand}: ${en.title}`)
    expect(within(header).getByText(en.title)).toBeTruthy()
    expect(within(header).getByText(en.intro)).toBeTruthy()
    // The chevron rotation is a CSS-module class toggle — jsdom resolves the
    // module to `{}`, so the literal `chevronOpen` class is asserted at the
    // bundle level and through the substitutes here: the svg presence +
    // aria-expanded + the body toggle (advisor spec convention).
    expect(header.querySelector('svg')).toBeTruthy() // the chevron icon
    expect(screen.queryByLabelText(en['enabled.label'])).toBeNull()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    expect(screen.queryByRole('button', { name: en.discard })).toBeNull()

    // Expanding reveals the enabled row and the footer actions.
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(headerButton(true).getAttribute('aria-label')).toBe(`${en.collapse}: ${en.title}`)
    const toggle = screen.getByLabelText(en['enabled.label']) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByRole('button', { name: en.save })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.discard })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.reset })).toBeTruthy()
  })

  it('flips aria-expanded and toggles the body on repeated header clicks', async () => {
    await mountCard()
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    toggleCard()
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(en['enabled.label'])).toBeTruthy()
    toggleCard()
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(en['enabled.label'])).toBeNull()
  })

  it('shows the unsaved pill after an edit and keeps it while collapsed', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    // Staged edits outlive collapsing — the pill rides the header (upstream).
    toggleCard()
    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('clears the unsaved pill after discard', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    // The draft reverted to the accepted config, not to defaults.
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).value).toBe(
      String(defaultFallbacksConfig.cooldownMs),
    )
  })

  it('disables Save and Discard when clean, enables both once the draft is dirty', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    // Clean (no edits): neither action is offered (upstream semantics —
    // save = !dirty || saving || !writable; discard = !dirty || saving).
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en.discard }) as HTMLButtonElement).disabled).toBe(true)
    // One staged edit → both actions become available.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: en.discard }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('saves the assembled draft through the store face and clears the pill', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({ cooldownMs: 5000 }) },
      }))
    })
    await waitFor(() => {
      expect(controller.store.getSnapshot().status).toBe('ready')
    })
    // The accepted config re-seeded the draft → clean again, pill gone.
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('loads on mount when the store has not loaded yet (status idle → load)', async () => {
    // The plugin-config page mounts the card lazily; the first mount must
    // trigger the first gateway load (advisor card pattern).
    const { controller, scripted } = await mountCard({}, false)
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/get', { args: {} })
    })
    await waitFor(() => {
      expect(controller.store.getSnapshot().status).toBe('ready')
    })
  })

  it('keeps the degraded card derived-open with the notice + usable skeleton (AC-1 divergence)', async () => {
    // Gateway channel unreachable: get fails, describe succeeds → the card
    // shows the unavailable notice ALWAYS (no interaction), the form stays
    // usable (writable), and the header click cannot collapse the notice away.
    const { view, props } = await mountCard({ config: null })
    const header = headerButton(true)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.getAttribute('aria-label')).toBe(`${en.collapse}: ${en.title}`)
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(screen.getByLabelText(en['enabled.label'])).toBeTruthy() // skeleton still rendered
    // The header click is a no-op on a degraded card (advisor qc3 S-1).
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.unavailable)).toBeTruthy()
  })

  it('keeps the degraded body open through a refresh window (latched derivation)', async () => {
    // A background refresh (pushed invalidation) flips status to 'loading'
    // while `present` keeps its stale false — the latched degraded value
    // must keep the notice body open through the window (advisor qc1 S-2;
    // the fallbacks latch lives in the card, the store stays untouched).
    const { view, props, controller } = await mountCard({ config: null })
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    const reload = controller.load() // do not await yet
    expect(controller.store.getSnapshot().status).toBe('loading')
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    await reload
  })

  it('keeps the error card derived-open with the notice + Retry, and through the Retry→loading window (qc2 S-1)', async () => {
    // An initial-load failure (describe fails) lands the hard `error` state:
    // the card forces open with the error notice + Retry (AC-1), the header
    // click cannot collapse the notice away, and the form is inert (the load
    // never landed). Clicking Retry flips status to 'loading' — the latched
    // error term must keep the body open through the window (the unlatched
    // derivation collapsed it, hiding the error mid-flight), and when the
    // reload fails again the notice + Retry reappear still open.
    const scripted = scriptedApi({})
    scripted.describe.mockResolvedValue({ result: { ok: false, error: { code: 'internal', message: 'describe exploded', details: {} } } })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)

    // Error card is derived-open: notice + Retry, inert form, no-op header.
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(headerButton(true).getAttribute('aria-label')).toBe(`${en.collapse}: ${en.title}`)
    expect(screen.getByRole('alert').textContent).toBe(en['error.generic']) // the test `t` does not interpolate
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(true)
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')

    // Retry → the S-1 loading window: the body must stay open (latched
    // error term) even though `userOpen` is false and `state.status` is no
    // longer 'error'.
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(controller.store.getSnapshot().status).toBe('loading')
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(en['enabled.label'])).toBeTruthy() // body still rendered

    // The reload fails again → the error notice + Retry reappear, still open.
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('error'))
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it('releases the error latch on a successful reload (recovered card collapses)', async () => {
    // The latch holds only until a successful state transition: once Retry
    // lands ready, the error term unlatches and the healthy card collapses
    // like any never-opened card.
    const scripted = scriptedApi({})
    scripted.describe.mockResolvedValueOnce({ result: { ok: false, error: { code: 'internal', message: 'describe exploded', details: {} } } })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByLabelText(en['enabled.label'])).toBeNull()
  })

  it('a failed save shows the error notice and keeps the form editable (qc2 S-4)', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    // The gateway rejects the write: the error notice surfaces the message
    // (KD-G3) and the form stays editable for retry — no Retry button (the
    // form itself is the retry surface when writable).
    scripted.set.mockResolvedValueOnce(failResult('rejected by gateway'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('error'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en['error.generic']) // the test `t` does not interpolate
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
    // A follow-up save succeeds (the mock default folded the write): the
    // accepted config re-seeds the draft → clean again, pill gone.
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reset asks for confirmation in the Modal and only resets on confirm (qc2 S-4)', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    // Reset opens the confirmation dialog (portal to document.body).
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    const dialog = screen.getByRole('dialog', { name: en['reset.confirmTitle'] })
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText(en['reset.confirm'])).toBeTruthy()
    // Cancel closes the dialog without touching the gateway.
    fireEvent.click(within(dialog).getByRole('button', { name: en['reset.confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(scripted.reset).not.toHaveBeenCalled()
    // Confirm runs the reset through the store face and closes the dialog.
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    fireEvent.click(screen.getByRole('button', { name: en['reset.confirm.action'] }))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/reset', { args: {} })
    })
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    // The draft re-seeded from the reset defaults: the switch flips back to
    // off (default enabled: false → the off-notice body replaces the form).
    const toggle = screen.getByLabelText(en['enabled.label']) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(en['enabled.off'])).toBeTruthy()
  })

  it('shows the read-only notice only once a settled describe reports read-only', async () => {
    const { view, props } = await mountCard({ writable: false })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    // The form is inert in a read-only environment.
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('FallbacksCard two-block editing surface (plan fallbacks-role-config-model T3)', () => {
  it('renders the rootChain block with selector rows and no key input', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Block 1: title + the "unset = no fallback" hint; the chain-key text
    // input of the old model is gone (spec §8 无键输入).
    expect(screen.getByText(en['rootChain.label'])).toBeTruthy()
    expect(screen.getByText(en['rootChain.hint'])).toBeTruthy()
    expect(screen.queryByLabelText('Key')).toBeNull()
    // The single rootChain row renders its add-selector affordance; its
    // selector editor renders one provider select (the read-back value).
    const rootChainGroup = screen.getByText(en['rootChain.label']).closest('[role="group"]') as HTMLElement
    expect(within(rootChainGroup).getByRole('button', { name: en['rootChain.selector.add'] })).toBeTruthy()
    expect(screen.getAllByLabelText(en['roles.rule.provider']).length).toBeGreaterThanOrEqual(1)
  })

  it('renders the declared role entity cards with id/label/description/fallback', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['roles.list.label'])).toBeTruthy()
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).value).toBe('reviewer')
    expect((ids[1] as HTMLInputElement).value).toBe('architect')
    expect(screen.getAllByLabelText(en['roles.label'])).toHaveLength(2)
    expect(screen.getAllByLabelText(en['roles.description'])).toHaveLength(2)
    const fallbacks = screen.getAllByLabelText(en['roles.fallback'])
    expect(fallbacks).toHaveLength(2)
    expect((fallbacks[0] as HTMLSelectElement).value).toBe('inherit-root')
    expect((fallbacks[1] as HTMLSelectElement).value).toBe('none')
    // Each role card carries its own add-selector affordance (scoped to the
    // roles group — the rootChain group's add button shares the label).
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(rolesGroup).getAllByRole('button', { name: en['roles.selector.add'] })).toHaveLength(2)
    expect(screen.getAllByLabelText(en['roles.remove'])).toHaveLength(2)
    expect(screen.getByRole('button', { name: en['roles.add'] })).toBeTruthy()
  })

  it('binds the rules role field to a dropdown of inherit + declared ids', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const roleSelects = screen.getAllByLabelText(en['roles.rule.role'])
    expect(roleSelects).toHaveLength(2)
    const first = roleSelects[0] as HTMLSelectElement
    expect(first.value).toBe('reviewer')
    // The offer set: the built-in inherit target (with its label) + every
    // declared id — no free-text role input remains.
    expect(within(first).getByRole('option', { name: en['roles.rule.role.inherit'] })).toBeTruthy()
    expect(within(first).getByRole('option', { name: 'reviewer' })).toBeTruthy()
    expect(within(first).getByRole('option', { name: 'architect' })).toBeTruthy()
    // The old free-text role input is gone (the placeholder text it used).
    expect(screen.queryByLabelText('Role name')).toBeNull()
    expect(screen.getByRole('button', { name: en['roles.addRule'] })).toBeTruthy()
  })

  it('reflects role add/remove in the rules role dropdown on the same page', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const roleSelect = screen.getAllByLabelText(en['roles.rule.role'])[0] as HTMLSelectElement
    expect(within(roleSelect).getByRole('option', { name: 'reviewer' })).toBeTruthy()

    // Removing the reviewer entity drops its id from the dropdown; the
    // referencing rule's orphaned value stays visible as a synthetic
    // "undeclared" option (honest dangling reference — save validation
    // flags it).
    fireEvent.click(screen.getAllByRole('button', { name: en['roles.remove'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    const updatedSelect = screen.getAllByLabelText(en['roles.rule.role'])[0] as HTMLSelectElement
    expect(within(updatedSelect).queryByRole('option', { name: 'reviewer' })).toBeNull()
    expect(within(updatedSelect).getByRole('option', { name: 'architect' })).toBeTruthy()
    expect(within(updatedSelect).getByRole('option', { name: 'reviewer (undeclared)' })).toBeTruthy()

    // Adding a role entity with a typed id offers it immediately.
    fireEvent.click(screen.getByRole('button', { name: en['roles.add'] }))
    const ids = screen.getAllByLabelText(en['roles.id'])
    fireEvent.change(ids[ids.length - 1]!, { target: { value: 'coder' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(within(updatedSelect).getByRole('option', { name: 'coder' })).toBeTruthy()

    // The orphaned reference survives into the draft: a save attempt is
    // blocked — the dangling rule keeps the write off the wire and the
    // banner names the undeclared role (T3 fix wave Minor 2).
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.ruleRoleUndeclared'])
  })

  it('blocks save on an invalid role id: banner + inline red, no gateway write', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'Bad ID' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    // The write is intercepted: no fallbacks/set ever crosses the wire.
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    // The error banner carries the blocked notice + the offending message.
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleIdFormat'])
    // Only the offending id input is marked inline (aria-invalid drives the
    // red border); the sibling role stays clean.
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids[0]!.getAttribute('aria-invalid')).toBe('true')
    expect(ids[1]!.getAttribute('aria-invalid')).toBeNull()
  })

  it('blocks save on the reserved id "inherit" and on duplicate ids', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Reserved word.
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'inherit' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.roleIdReserved'])
    // Duplicates (after fixing the reserved id to a legal one).
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'coder' } })
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[1]!, { target: { value: 'coder' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.roleIdDuplicate'])
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids[0]!.getAttribute('aria-invalid')).toBe('true')
    expect(ids[1]!.getAttribute('aria-invalid')).toBe('true')
  })

  it('blocks save on an illegal selector in rootChain: banner, no gateway write', async () => {
    // A malformed entry riding the accepted config (e.g. hand-edited YAML —
    // the selector editor itself has no free-text input): it reads back
    // verbatim as a synthetic outside option, so the seeded draft is clean;
    // an unrelated edit makes it dirty, and the save attempt is blocked
    // with the selector violation — the write never crosses the wire.
    const config: typeof defaultFallbacksConfig = { ...TWO_BLOCK_CONFIG, rootChain: ['bad-selector'] }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByRole('option', { name: 'bad-selector (outside catalog)' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.selector'])
  })

  it('clears the blocked-save state once the draft is valid again, then saves', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'Bad ID' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.blocked'])
    // Fixing the offending id alone leaves the rule referencing the old id
    // undeclared (the banner honestly stays); repairing the reference too
    // makes the draft valid → banner + inline mark clear live, with no
    // stale "blocked" presentation over a valid draft.
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'coder' } })
    fireEvent.change(screen.getAllByLabelText(en['roles.rule.role'])[0]!, { target: { value: 'coder' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByLabelText(en['roles.id'])[0]!.getAttribute('aria-invalid')).toBeNull()
    // A subsequent valid save goes through.
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
  })

  it('preserves schema-reserved prompt/permissions through a save (rows do not round-trip them)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [{
          id: 'reviewer', label: '', description: '',
          prompt: 'You review', permissions: { allow: ['read'] },
        }],
        rules: [],
      },
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The card starts CLEAN: the merged draft equals the accepted config
    // (no unsaved pill), proving the merge participates in dirty.
    expect(screen.queryByText(en.unsaved)).toBeNull()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(scripted.set).toHaveBeenCalledWith(expect.objectContaining({
        args: { patch: expect.objectContaining({
          cooldownMs: 7000,
          roles: {
            list: [expect.objectContaining({
              id: 'reviewer', prompt: 'You review', permissions: { allow: ['read'] },
            })],
            rules: [],
          },
        }) },
      }))
    })
  })

  it('renders the migration banner from wire legacyKeys without blocking editing or saves', async () => {
    const { view, props, controller, scripted } = await mountCard({
      config: ENABLED_CONFIG,
      legacyKeys: ['chains', 'roles.default'],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(controller.store.getSnapshot().legacyKeys).toEqual(['chains', 'roles.default'])
    expect(screen.getByText(en['legacy.banner'])).toBeTruthy()
    // The banner never blocks editing: the form stays writable and a save
    // still crosses the wire (informational only, spec §8).
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
  })
})
