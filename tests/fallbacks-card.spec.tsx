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
 *
 * Plan fallbacks-role-config-ui (task 1 + 2 + QC fix wave): the role persona
 * is a multiline textarea, no chain editor offers the `provider/*` wildcard
 * (a wildcard read-back renders with a conversion hint and becomes an exact
 * entry once a model is picked), and the Advanced options section is a
 * collapsible disclosure starting collapsed. The QC fix wave pins the
 * read-only forced-open behavior (writable:false → advanced body visible,
 * toggle inert, aria-expanded "true"), the rootChain wildcard read-back
 * conversion, the aria-expanded value transitions, and the conversion-hint
 * gating on convertible rows (F-002 / F-003 / F-007 / N-003/N-004).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  ClientConnectionRpc, ConfigurableProviderView, IApiClient, ModelProviderGroup, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { FallbacksCard } from '../src/client/FallbacksCard.tsx'
import type { FallbacksCardProps } from '../src/client/FallbacksCard.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import type { FallbacksSettingsState } from '../src/client/fallbacks-store.ts'
import type { SeedsWireStatus } from '../src/seeds.ts'
import { presetRoles } from '../src/presets.ts'
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
  revertSeed: Mock
  describe: Mock
}

/**
 * A scripted wire face: `settings.describe` carries `writable` + an empty
 * namespace directory, the catalog is empty (the chrome spec does not
 * exercise dropdown options), and the fake `rpc.call` serves the
 * `fallbacks/get` + `fallbacks/set` + `fallbacks/reset` endpoints against a
 * mutable effective config (store-spec fixture shape). `config: null` = the
 * gateway is unreachable (get fails) — the KD-G5 degraded path. Pass
 * `catalog` to serve a populated provider/model directory on mount plus the
 * `llm-providers` namespace so those providers count as configured (the
 * join that makes the provider dropdown offer them).
 */
function scriptedApi(options: {
  config?: typeof defaultFallbacksConfig | null
  writable?: boolean
  legacyKeys?: string[]
  seeds?: SeedsWireStatus[]
  catalog?: { providers: ConfigurableProviderView[]; groups: ModelProviderGroup[] }
} = {}): Scripted {
  let current = options.config === undefined ? defaultFallbacksConfig : options.config
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: options.writable ?? true,
    hasDocument: false,
    namespaces: options.catalog === undefined
      ? []
      : [{
          ns: 'llm-providers',
          schema: {},
          value: { providers: Object.fromEntries(options.catalog.providers.map(entry => [entry.provider, {}])) },
          applies: 'live',
          secrets: [],
          revision: 1,
        }],
  })))
  const providers = vi.fn(() => Promise.resolve(ok({ providers: options.catalog?.providers ?? [] })))
  const models = vi.fn(() => Promise.resolve(ok({ groups: options.catalog?.groups ?? [], failures: [] })))
  const history = vi.fn(() => Promise.resolve(ok({ events: [] })))
  const get = vi.fn(() => Promise.resolve(
    current === null
      ? failResult('fallbacks gateway is not ready')
      : okResult({
          config: current,
          ...(options.legacyKeys === undefined ? {} : { legacyKeys: options.legacyKeys }),
          // spec §9.4: the additive seeds field rides the get response; an
          // absent option means "no seeds to badge" on this fixture.
          ...(options.seeds === undefined ? {} : { seeds: options.seeds }),
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
  // The revert-seed fake keeps the effective config (no persona registry in
  // this fixture); tests script specific post-write read results with
  // `mockReturnValueOnce` when they exercise the accepted response.
  const revertSeed = vi.fn((payload: { args: { id: string } }) => {
    if (current === null) throw new Error('test: revert-seed on an unavailable gateway')
    return Promise.resolve(okResult({ config: current }))
  })
  const call = vi.fn((channel: string, endpoint: string, payload: unknown) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'fallbacks/get') return get()
    if (endpoint === 'fallbacks/set') return set(payload as { args: { patch: typeof defaultFallbacksConfig } })
    if (endpoint === 'fallbacks/reset') return reset()
    if (endpoint === 'fallbacks/revert-seed') return revertSeed(payload as { args: { id: string } })
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    api: {
      settings: { describe, openDocument: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
      llm: { providers, models, discoverModels: vi.fn() },
      sessions: { history },
    } as unknown as Pick<IApiClient, 'settings' | 'llm' | 'sessions'>,
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, reset, revertSeed, describe,
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
 * rootChain, two declared role entities (one `inherit-root`, one
 * `fallback: none` — both with their own chains so the draft is save-valid
 * under the role model-config rule, plan fallbacks-feedback-round T2), and
 * role rules referencing a declared id and the built-in `inherit`. The
 * chain-less role save-block is exercised by dedicated tests below.
 */
const TWO_BLOCK_CONFIG: typeof defaultFallbacksConfig = {
  ...defaultFallbacksConfig,
  enabled: true,
  rootChain: ['openai/gpt-4o'],
  roles: {
    list: [
      { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
      { id: 'architect', persona: 'Designs systems', chain: ['other/gpt-4o'], fallback: 'none' },
    ],
    rules: [
      { origin: 'subagent', role: 'reviewer' },
      { role: 'inherit' },
    ],
  },
}

/**
 * A populated catalog for the chain-add interaction: one configured
 * provider (openai) with advertised models. The `catalog` scriptedApi
 * option also serves the `llm-providers` namespace so openai counts as
 * configured and appears in the selector provider dropdown.
 */
const CHAIN_CATALOG = {
  providers: [
    { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: [], active: true },
  ] as ConfigurableProviderView[],
  groups: [
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  ] as ModelProviderGroup[],
}

/**
 * A role carrying a legacy `provider/*` wildcard chain entry. The GUI no
 * longer offers the wildcard (task 1), but it stays a legal YAML read-back:
 * the row renders with the legacy-conversion hint and an enabled model
 * select — picking a model converts it to an exact entry on save (plan
 * fallbacks-role-config-ui T1).
 */
const WILDCARD_ROLE_CONFIG: typeof defaultFallbacksConfig = {
  ...defaultFallbacksConfig,
  enabled: true,
  roles: { list: [{ id: 'coder', persona: '', chain: ['openai/*'], fallback: 'none' }], rules: [] },
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
 * Expand the advanced options section (collapsed by default). The disclosure
 * button's accessible name flips with the state; fireEvent flushes
 * synchronously, so the section body is mounted once this returns.
 */
function expandAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: en['advanced.expand'] }))
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
    expandAdvanced()
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
    expandAdvanced()
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
    expandAdvanced()
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
    expandAdvanced()
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
    expandAdvanced()
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

  it('renders the chain/role sections before the advanced options and offers no provider wildcard in any chain editor', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Section order: root chain → role entities → role rules → advanced
    // options (trigger codes / cooldown / switch caps) at the end. The
    // advanced group is reachable while collapsed — the disclosure button's
    // label text stays mounted.
    const groups = [
      screen.getByText(en['rootChain.label']).closest('[role="group"]')!,
      screen.getByText(en['roles.list.label']).closest('[role="group"]')!,
      screen.getByText(en['roles.rules']).closest('[role="group"]')!,
      screen.getByText(en['advanced.label']).closest('[role="group"]')!,
    ]
    for (let i = 1; i < groups.length; i += 1) {
      expect(groups[i - 1]!.compareDocumentPosition(groups[i]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }
    // No `provider/*` wildcard checkbox in any chain editor (root or role):
    // the GUI never offers the wildcard — provider-any matching lives in the
    // roles.rules `any` option. The card's only checkboxes are the enabled
    // switch and the collapsed trigger codes, neither inside these groups.
    expect(within(groups[0]!).queryByRole('checkbox')).toBeNull()
    expect(within(groups[1]!).queryByRole('checkbox')).toBeNull()
  })

  it('keeps the advanced options collapsed by default and expands/collapses them through the disclosure', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The advanced body (cooldown field, trigger codes) is unmounted while
    // collapsed — the disclosure button's label text stays reachable.
    expect(screen.queryByLabelText(en['cooldownMs.label'])).toBeNull()
    expect(screen.getByText(en['advanced.label'])).toBeTruthy()
    // aria-expanded tracks the disclosure state: false while collapsed.
    expect(screen.getByRole('button', { name: en['advanced.expand'] }).getAttribute('aria-expanded')).toBe('false')
    // Expand: the body mounts (fireEvent flushes synchronously).
    expandAdvanced()
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['advanced.collapse'] }).getAttribute('aria-expanded')).toBe('true')
    // Collapse again: the body unmounts and aria-expanded flips back.
    fireEvent.click(screen.getByRole('button', { name: en['advanced.collapse'] }))
    expect(screen.queryByLabelText(en['cooldownMs.label'])).toBeNull()
    expect(screen.getByRole('button', { name: en['advanced.expand'] }).getAttribute('aria-expanded')).toBe('false')
  })

  it('forces the advanced options open in a read-only view with the toggle inert (F-002)', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG, writable: false })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Read-only (`!writable`) forces the advanced group open WITHOUT any
    // disclosure interaction — expandAdvanced() is never called and the
    // cooldown field is already visible (same writable:false pattern as the
    // read-only notice test).
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy()
    // The toggle is inert: the wrapping fieldset's disabled propagation
    // reaches the native button, which reports the derived open state.
    const toggle = screen.getByRole('button', { name: en['advanced.collapse'] }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // The rest of the form is inert too (existing read-only pattern).
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(true)
  })

  it('reads back a rootChain wildcard entry with the conversion hint and converts it on save (F-003)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: ['openai/*'],
    }
    const { view, props, controller, scripted } = await mountCard({ config, catalog: CHAIN_CATALOG })
    // Settle the catalog explicitly so the model select is enabled before
    // the interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The rootChain wildcard read-back row shows the legacy-conversion hint
    // and keeps the model select enabled (the openai catalog group exists).
    const rootGroup = screen.getByText(en['rootChain.label']).closest('[role="group"]') as HTMLElement
    expect(within(rootGroup).getByText(en['chains.selector.wildcardLegacy'])).toBeTruthy()
    const model = within(rootGroup).getByLabelText(en['roles.rule.model']) as HTMLSelectElement
    expect(model.disabled).toBe(false)
    // Picking a concrete model converts the wildcard row → the save patch
    // carries the exact entry, never a `provider/*` line.
    fireEvent.change(model, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({ rootChain: ['openai/gpt-4o'] }) },
      }))
    })
  })

  it('reads back a role wildcard chain entry with the conversion hint and converts it to an exact entry on save (T1)', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: WILDCARD_ROLE_CONFIG, catalog: CHAIN_CATALOG })
    // Settle the catalog explicitly so the model select is enabled before
    // the interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The wildcard read-back row shows the legacy-conversion hint inside the
    // role card; the openai catalog group keeps the model select enabled so
    // the row can convert to an exact entry.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(rolesGroup).getByText(en['chains.selector.wildcardLegacy'])).toBeTruthy()
    const model = within(rolesGroup).getByLabelText(en['roles.rule.model']) as HTMLSelectElement
    expect(model.disabled).toBe(false)
    // Picking a concrete model converts the wildcard row → the save patch
    // carries the exact entry, never a `provider/*` line.
    fireEvent.change(model, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          roles: {
            list: [expect.objectContaining({ chain: ['openai/gpt-4o'] })],
            rules: [],
          },
        }) },
      }))
    })
  })

  it('keeps the model select disabled with the strict hint when a wildcard read-back has no catalog group (T1)', async () => {
    // A catalog provider with no successful model listing offers nothing to
    // convert the wildcard to: the select stays disabled with the strict
    // hint (task 1 changed groupMissing to count wildcard read-backs too),
    // and the legacy-conversion hint stays hidden — with the select disabled
    // there is no model to pick, so the "pick a model" hint would mislead
    // (N-003/N-004).
    const noGroupCatalog = { providers: CHAIN_CATALOG.providers, groups: [] }
    const { view, props, controller } = await mountCard({ config: WILDCARD_ROLE_CONFIG, catalog: noGroupCatalog })
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    // The strict hint renders inside the model's wrapping label, so the
    // label text is "model" + the hint — match the label by its leading text.
    const model = within(rolesGroup).getByLabelText(new RegExp(`^${en['roles.rule.model']}`)) as HTMLSelectElement
    expect(model.disabled).toBe(true)
    expect(within(rolesGroup).getByText(en['chains.selector.noModelsStrict'])).toBeTruthy()
    expect(within(rolesGroup).queryByText(en['chains.selector.wildcardLegacy'])).toBeNull()
  })

  it('offers no wildcard on a freshly added role chain row: no checkbox, no legacy hint', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: { list: [{ id: 'coder', persona: '', chain: [], fallback: 'inherit-root' }], rules: [] },
    }
    const { view, props } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Add a chain entry: the fresh selector row renders provider/model
    // selects only — no wildcard checkbox, and no conversion hint (that
    // hint appears for wildcard read-backs only).
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    fireEvent.click(within(rolesGroup).getByRole('button', { name: en['roles.selector.add'] }))
    view.rerender(<FallbacksCard {...props} />)
    expect(within(rolesGroup).queryByRole('checkbox')).toBeNull()
    expect(within(rolesGroup).queryByText(en['chains.selector.wildcardLegacy'])).toBeNull()
  })

  it('renders the declared role entity cards with id/persona/fallback', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['roles.list.label'])).toBeTruthy()
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).value).toBe('reviewer')
    expect((ids[1] as HTMLInputElement).value).toBe('architect')
    const personas = screen.getAllByLabelText(en['roles.persona'])
    expect(personas).toHaveLength(2)
    // The persona field is a multiline textarea (task 1), not a one-line input.
    expect(personas[0].tagName).toBe('TEXTAREA')
    expect(personas[1].tagName).toBe('TEXTAREA')
    expect((personas[0] as HTMLTextAreaElement).value).toBe('Reviews code')
    expect((personas[1] as HTMLTextAreaElement).value).toBe('Designs systems')
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

  it('blocks save on an empty rule row with a hint instead of silently dropping it (qc3 F-4)', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Add a fresh rule row: the role select stays on the placeholder.
    fireEvent.click(screen.getByRole('button', { name: en['roles.addRule'] }))
    view.rerender(<FallbacksCard {...props} />)
    const roleSelects = screen.getAllByLabelText(en['roles.rule.role'])
    const fresh = roleSelects[roleSelects.length - 1] as HTMLSelectElement
    expect(fresh.value).toBe('')
    // The inline hint explains the row before any save attempt.
    expect(screen.getAllByText(en['validation.ruleRoleRequired'])).toHaveLength(1)

    // Save is blocked: the empty row would otherwise vanish on save
    // (rowsToRules drops role === '') with no explanation.
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.ruleRoleRequired'])

    // Picking a role makes the draft valid again → the blocked
    // presentation clears live (no stale banner over a valid draft).
    const selectsAfterBlock = screen.getAllByLabelText(en['roles.rule.role'])
    const last = selectsAfterBlock[selectsAfterBlock.length - 1] as HTMLSelectElement
    fireEvent.change(last, { target: { value: 'reviewer' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
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
    expandAdvanced()
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
          id: 'reviewer', persona: '',
          // A chain rides the role so the save is valid under the role
          // model-config rule (T2) — this test pins prompt/permissions.
          chain: ['openai/gpt-4o'],
          prompt: 'You review', permissions: { allow: ['read'] },
        }],
        rules: [],
      },
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    expandAdvanced()
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
    expandAdvanced()
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

  it('blocks save on a role without a model config: banner + inline hint, no gateway write (T2)', async () => {
    // A declared role with zero chain selectors has no model config — the
    // draft is rejected before it reaches the wire, and the role card shows
    // the inline hint unconditionally while its chain area is empty (plan
    // fallbacks-feedback-round T2; `fallback: none` + empty chain is
    // blocked too — a role without a model config is meaningless).
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: ['openai/gpt-4o'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: [], fallback: 'none' }],
        rules: [],
      },
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // The inline hint explains the chain-less role before any save attempt.
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // An unrelated edit makes the draft dirty (a clean draft's save button
    // is disabled) before the save attempt.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    // Save is blocked: the role has no model config.
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleChainRequired'])
  })

  it('a role becomes saveable again once a chain entry is added: hint clears, save passes (T2)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [{ id: 'coder', persona: '', chain: [], fallback: 'inherit-root' }],
        rules: [],
      },
    }
    const { view, props, controller, scripted } = await mountCard({ config, catalog: CHAIN_CATALOG })
    // Settle the catalog explicitly so the selector dropdowns offer openai
    // before the interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // Chain area empty → inline hint shown; save is blocked (an unrelated
    // edit first makes the draft dirty so the save button is enabled).
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByRole('alert').textContent).toContain(en['validation.roleChainRequired'])
    // Add a chain entry to the role card and pick provider + model.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    fireEvent.click(within(rolesGroup).getByRole('button', { name: en['roles.selector.add'] }))
    view.rerender(<FallbacksCard {...props} />)
    const providerSelect = within(rolesGroup).getByLabelText(en['roles.rule.provider']) as HTMLSelectElement
    fireEvent.change(providerSelect, { target: { value: 'openai' } })
    view.rerender(<FallbacksCard {...props} />)
    const modelSelect = within(rolesGroup).getByLabelText(en['roles.rule.model']) as HTMLSelectElement
    fireEvent.change(modelSelect, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    // The inline hint clears once the chain area has a selector, and the
    // blocked-save presentation clears live (no stale banner over a valid
    // draft).
    expect(screen.queryByText(en['validation.roleChainRequired'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // The valid draft saves through the gateway.
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
  })

  it('keeps the chain-required hint while the chain area holds only blank selector rows (T2 M-1)', async () => {
    // A role whose chain area holds only a blank placeholder row (added but
    // not yet filled) still has no model config — the hint must not blink
    // out just because a selector row exists; it shows while no row
    // serializes to a usable chain entry (plan fallbacks-feedback-round T3,
    // T2 M-1; mirrors the empty-chain case above).
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [{ id: 'coder', persona: '', chain: [], fallback: 'inherit-root' }],
        rules: [],
      },
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // Chain area empty → inline hint shown.
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // Add ONE selector row but leave it blank (placeholder provider/model).
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    fireEvent.click(within(rolesGroup).getByRole('button', { name: en['roles.selector.add'] }))
    view.rerender(<FallbacksCard {...props} />)
    // A blank placeholder row serializes to '' — the role still has no
    // model config, so the inline hint stays (the transient gap T2 M-1).
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // Save is still blocked with only blank rows (an unrelated edit first
    // makes the draft dirty so the save button is enabled — a blank row
    // serializes to '' and leaves the assembled draft unchanged).
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleChainRequired'])
  })
})

describe('FallbacksCard seeded roles (plan fallbacks-role-seeds T5)', () => {
  // Two declared roles: architect is the seeded one (empty chain is
  // legitimate for a seeded role per R4 — seeds never invent a chain),
  // reviewer is an ordinary non-seeded role with a chain.
  const SEEDED_CONFIG: typeof defaultFallbacksConfig = {
    ...defaultFallbacksConfig,
    enabled: true,
    roles: {
      list: [
        { id: 'architect', persona: 'Designs systems', chain: [], fallback: 'inherit-root' },
        { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
      ],
      rules: [],
    },
  }

  it('badges seeded roles only: default / override pills, none on non-seeded rows', async () => {
    // At default: exactly ONE badge — the seeded architect row; the
    // non-seeded reviewer row renders none, and only the seeded row's
    // persona cell hosts the badge + revert pair.
    const first = await mountCard({ config: SEEDED_CONFIG, seeds: [{ id: 'architect', overridden: false }] })
    toggleCard()
    first.view.rerender(<FallbacksCard {...first.props} />)
    expect(screen.getAllByText(en['roles.seedDefault'])).toHaveLength(1)
    expect(screen.queryByText(en['roles.seedOverride'])).toBeNull()
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(rolesGroup).getAllByText(en['roles.seedDefault'])).toHaveLength(1)
    expect(within(rolesGroup).getAllByRole('button', { name: en['roles.revertPersona'] })).toHaveLength(1)
    first.view.unmount()

    // Override state: the pill flips to the override label; still one badge.
    const second = await mountCard({ config: SEEDED_CONFIG, seeds: [{ id: 'architect', overridden: true }] })
    toggleCard()
    second.view.rerender(<FallbacksCard {...second.props} />)
    expect(screen.getAllByText(en['roles.seedOverride'])).toHaveLength(1)
    expect(screen.queryByText(en['roles.seedDefault'])).toBeNull()
  })

  it('revert calls the store revertSeed through the gateway endpoint', async () => {
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: true }],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['roles.revertPersona'] }))
    // The store mirrors save: the rpc reaches fallbacks/revert-seed with the
    // row's trimmed id (spec §9.4), independent of any card Save.
    expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/revert-seed', { args: { id: 'architect' } })
    expect(scripted.revertSeed).toHaveBeenCalledTimes(1)
  })

  it('disables the revert affordance when the card cannot write or a write is in flight', async () => {
    // Read-only describe: the revert button is inert (the wrapping fieldset
    // also propagates disabled, but the button carries its own term).
    const readOnly = await mountCard({
      config: SEEDED_CONFIG,
      writable: false,
      seeds: [{ id: 'architect', overridden: true }],
    })
    toggleCard()
    readOnly.view.rerender(<FallbacksCard {...readOnly.props} />)
    expect((screen.getByRole('button', { name: en['roles.revertPersona'] }) as HTMLButtonElement).disabled).toBe(true)
    readOnly.view.unmount()

    // While a save is in flight (store status 'saving') the revert is
    // disabled too — the store never lets the two writes overlap.
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: true }],
    })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    const gate = Promise.withResolvers<unknown>()
    scripted.set.mockReturnValueOnce(gate.promise as never)
    // An unrelated edit makes the draft dirty so Save is enabled; the
    // in-flight write flips the store to 'saving'.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect((screen.getByRole('button', { name: en['roles.revertPersona'] }) as HTMLButtonElement).disabled).toBe(true)
    // Release the write so the store settles and the test ends clean.
    gate.resolve(okResult({ config: { ...SEEDED_CONFIG, cooldownMs: 7000 } }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
  })

  it('saves a seeded role whose chain is empty (AC-3 card path)', async () => {
    // A seeded role with a legitimately empty chain (R4) must stay
    // persistable: the Save gate relaxes for seeded ids only (spec §9.6) so
    // the persona edit crosses the wire instead of the validation block.
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // The seeded row shows the non-blocking chain hint instead of the
    // blocking one.
    expect(screen.getByText(en['roles.seedChainOptional'])).toBeTruthy()
    expect(screen.queryByText(en['validation.roleChainRequired'])).toBeNull()
    // An unrelated edit makes the draft dirty (a clean draft's Save button
    // is disabled), then Save passes validation and writes.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still blocks save on a non-seeded empty-chain role while a sibling is seeded (regression pin)', async () => {
    // The relax is seeded-only: an ordinary empty-chain role stays blocked
    // even when a sibling in the same card IS seeded — non-seeded behavior
    // is byte-identical (spec §9.6 regression pin). Both roles are
    // chain-less so the hint contrast is explicit: architect (seeded) gets
    // the non-blocking seeded hint, reviewer (not seeded) keeps the
    // blocking one.
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [
          { id: 'architect', persona: 'Designs systems', chain: [], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: [], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props, scripted } = await mountCard({
      config,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // architect is seeded → the seeded (non-blocking) hint; reviewer is NOT
    // seeded → the blocking chain-required hint stays.
    expect(screen.getByText(en['roles.seedChainOptional'])).toBeTruthy()
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // Save is blocked: the non-seeded empty-chain role keeps the draft off
    // the wire.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleChainRequired'])
  })

  it('round-trips an override: edit persona → save → override badge → revert → default badge', async () => {
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    const personas = within(rolesGroup).getAllByLabelText(en['roles.persona'])
    expect(personas).toHaveLength(2)
    // Edit the seeded role's persona → the draft holds the override.
    fireEvent.change(personas[0]!, { target: { value: 'Edited persona' } })
    view.rerender(<FallbacksCard {...props} />)
    // Save: the post-write response reports the persona override (spec §9.4
    // — the wire's override verdict follows the accepted config).
    const editedConfig = {
      ...SEEDED_CONFIG,
      roles: {
        ...SEEDED_CONFIG.roles,
        list: SEEDED_CONFIG.roles.list.map(role => role.id === 'architect'
          ? { ...role, persona: 'Edited persona' }
          : role),
      },
    }
    scripted.set.mockReturnValueOnce(okResult({
      config: editedConfig,
      seeds: [{ id: 'architect', overridden: true }],
    }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(screen.getAllByText(en['roles.seedOverride'])).toHaveLength(1))
    expect(screen.queryByText(en['roles.seedDefault'])).toBeNull()
    expect((within(rolesGroup).getAllByLabelText(en['roles.persona'])[0] as HTMLTextAreaElement).value)
      .toBe('Edited persona')
    // Revert: the gateway restores the CURRENT seed default persona and
    // reports the badge back at default (AC-3 round-trip).
    const revertedConfig = {
      ...editedConfig,
      roles: {
        ...editedConfig.roles,
        list: editedConfig.roles.list.map(role => role.id === 'architect'
          ? { ...role, persona: 'Designs systems' }
          : role),
      },
    }
    scripted.revertSeed.mockReturnValueOnce(okResult({
      config: revertedConfig,
      seeds: [{ id: 'architect', overridden: false }],
    }))
    fireEvent.click(screen.getByRole('button', { name: en['roles.revertPersona'] }))
    await waitFor(() => expect(screen.getAllByText(en['roles.seedDefault'])).toHaveLength(1))
    expect(screen.queryByText(en['roles.seedOverride'])).toBeNull()
    // The store adopted the post-write config: the restored persona lands
    // back in the draft.
    expect((within(rolesGroup).getAllByLabelText(en['roles.persona'])[0] as HTMLTextAreaElement).value)
      .toBe('Designs systems')
  })

  it('locks the seeded row id only: non-seeded ids stay editable, personas stay editable (R2 id-only)', async () => {
    const { view, props } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // SEEDED_CONFIG declares architect (seeded) before reviewer (ordinary).
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).value).toBe('architect')
    expect((ids[1] as HTMLInputElement).value).toBe('reviewer')
    // Only the seeded row's id input is inert; the non-seeded row keeps an
    // editable id (R2 — renaming a seeded row would detach it from the
    // seed registry, so the id is immutable).
    expect((ids[0] as HTMLInputElement).disabled).toBe(true)
    expect((ids[1] as HTMLInputElement).disabled).toBe(false)
    // The lock covers the id ONLY: the seeded row's persona textarea stays
    // editable (R3 — override/revert remain reachable).
    const personas = screen.getAllByLabelText(en['roles.persona'])
    expect((personas[0] as HTMLTextAreaElement).disabled).toBe(false)
    expect((personas[1] as HTMLTextAreaElement).disabled).toBe(false)
    // The seeded row's fallback selector stays editable too — only the id is
    // locked, chain/fallback controls keep the `!writable`-only term (R4;
    // qc1 S-3).
    const fallbacks = screen.getAllByLabelText(en['roles.fallback'])
    expect(fallbacks).toHaveLength(2)
    expect((fallbacks[0] as HTMLSelectElement).disabled).toBe(false)
    expect((fallbacks[1] as HTMLSelectElement).disabled).toBe(false)
  })

  it('locks the seeded id in override state too (R2 holds across default and override)', async () => {
    const { view, props } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: true }],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).value).toBe('architect')
    expect((ids[1] as HTMLInputElement).value).toBe('reviewer')
    expect((ids[0] as HTMLInputElement).disabled).toBe(true)
    expect((ids[1] as HTMLInputElement).disabled).toBe(false)
    // Mirror of the default-seed pin: the lock covers the id ONLY, so the
    // seeded row's persona textarea stays editable in override state too
    // (R3 — override/revert remain reachable; qc1 S-2).
    const personas = screen.getAllByLabelText(en['roles.persona'])
    expect((personas[0] as HTMLTextAreaElement).disabled).toBe(false)
    expect((personas[1] as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('keeps seeded ids disabled under the global read-only gate (R2 × writable:false)', async () => {
    // The id lock is `disabled={!writable || seed !== undefined}` — read-only
    // mode disables every id through the `!writable` term on its own; the pin
    // documents that a seeded fixture under writable:false stays disabled via
    // the same expression (qc1 S-1, plan §成功判据 (1)).
    const { view, props } = await mountCard({
      config: SEEDED_CONFIG,
      writable: false,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).disabled).toBe(true)
    expect((ids[1] as HTMLInputElement).disabled).toBe(true)
  })

  it('locks preset-materialized rows too: a designer preset row id is disabled (regression pin)', async () => {
    // Presets land as seeded two-key rows through the seeds face (spec
    // §9.3), so a preset row IS a seeded row — the same `seededIds`
    // derivation must lock its id (R2, plan fallbacks-preset-roles). The
    // persona rides the frozen presets source so the fixture cannot drift
    // from the spec-frozen preset set (presets.spec.ts pins the personas
    // verbatim to spec §9.2). The chain/fallback keys are config-shape
    // requirements of this card fixture — the lock keys on the id match
    // only, so they are irrelevant to the asserted behavior.
    const designer = presetRoles.find((role) => role.id === 'designer')
    expect(designer).toBeDefined()
    if (!designer) throw new Error('preset designer removed')
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [
          { id: 'designer', persona: designer.persona, chain: [], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props } = await mountCard({
      config,
      seeds: [{ id: 'designer', overridden: false }],
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).value).toBe('designer')
    expect((ids[1] as HTMLInputElement).value).toBe('reviewer')
    expect((ids[0] as HTMLInputElement).disabled).toBe(true)
    expect((ids[1] as HTMLInputElement).disabled).toBe(false)
  })
})
