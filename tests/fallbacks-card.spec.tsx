// @vitest-environment jsdom
/**
 * Fallbacks settings card (plan fallbacks-plugin-config-card, task 1 + 2):
 * registration-surface spec + card-chrome contract spec.
 *
 * Registration surface (task 1): the fake slots runtime runs the inject
 * generator and records every register call, pinning the card contract: the
 * `settings.plugin.item` slot ledger holds key 'fallbacks' (the rc.7 keyed
 * slot — the old list-slot `id` / `order` options are absent), locale
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
  LlmConfigurableProvider, ModelProviderGroup, SessionFollowFrame,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ClientConnectionRpc, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '../src/client/use-snapshot.ts'
import { FallbacksCard } from '../src/client/FallbacksCard.tsx'
import type { FallbacksCardProps } from '../src/client/FallbacksCard.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import type { FallbacksRemote, FallbacksSettingsState, SubagentPolicyView } from '../src/client/fallbacks-store.ts'
import type { SeedsWireStatus } from '../src/seeds.ts'
import { presetRoles } from '../src/presets.ts'
import { apply } from '../src/client/index.ts'
import { defaultFallbacksConfig } from '../src/config.ts'
import { OFFICIAL_V4_FLASH, OFFICIAL_V4_PRO } from '../src/time-slots.ts'
import { en, zh } from '../src/client/locales.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'

afterEach(cleanup)

// The synthesized `t` seat's key domain is the namespace dictionary union
// plus the shared `common` vocabulary; the specs only ever call the card's
// own keys, so the en-lookup casts the key.
const t: FallbacksCardProps['t'] = key => en[key as keyof typeof en]

/**
 * An interpolating `t` seat (status-block pattern) for copy that carries
 * `{n}`-style placeholders — the module `t` returns the raw template, so
 * the PR #62 UX round 4 tag assertions (the x2/x3 multiplier) need this
 * variant to render the concrete factor.
 */
const interpolatingT: FallbacksCardProps['t'] = (key, params) => {
  let text: string = en[key as keyof typeof en]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(value)
  }
  return text
}

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

/** One Remote success (0.1.2 flat `RemoteResult`, no `result` envelope). */
function ok<T>(value: T) {
  return { ok: true as const, value }
}

/**
 * One `fallbacks/switch` history entry with a deterministic seq/time (the
 * store-spec / general-row fixture shape), for the status block's recent-switch
 * face (D-5 — `sessions.history`).
 */
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

interface Scripted {
  api: FallbacksRemote
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
  subagentPolicy?: SubagentPolicyView
  catalog?: { providers: LlmConfigurableProvider[]; groups: ModelProviderGroup[] }
  historyEntries?: SessionEventLikeEntry[]
  historyError?: string
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
  const providers = vi.fn(() => Promise.resolve(ok(options.catalog?.providers ?? [])))
  const models = vi.fn(() => Promise.resolve(ok({ groups: options.catalog?.groups ?? [], failures: [] })))
  const history = vi.fn((): AsyncIterable<SessionFollowFrame> => (async function* (): AsyncGenerator<SessionFollowFrame> {
    if (options.historyError !== undefined) throw new Error(options.historyError)
    yield {
      type: 'snapshot', records: options.historyEntries ?? [], hasMore: false,
    } as unknown as SessionFollowFrame
    await Promise.withResolvers().promise
  })())
  const get = vi.fn(() => Promise.resolve(
    current === null
      ? failResult('fallbacks gateway is not ready')
      : okResult({
          config: current,
          ...(options.legacyKeys === undefined ? {} : { legacyKeys: options.legacyKeys }),
          // spec §9.4: the additive seeds field rides the get response; an
          // absent option means "no seeds to badge" on this fixture.
          ...(options.seeds === undefined ? {} : { seeds: options.seeds }),
          // Spec D4 / T5: additive host-policy snapshot. Absent option =
          // old payload (field omitted) — the card must still render.
          ...(options.subagentPolicy === undefined ? {} : { subagentPolicy: options.subagentPolicy }),
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
      settings: { describe },
      llm: { listConfigurableProviders: providers },
      session: { modelCatalog: models, follow: history },
    } as unknown as FallbacksRemote,
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
 * A config with the `roleAutoMatch` key removed — the pre-fold legacy wire
 * shape (plan fallbacks-settings-visibility T3): a unit fixture can hand-build
 * it, but the REAL gateway composition always folds the schema default
 * `roleAutoMatch: true` into the wire (see tests/gateway.spec.ts), so the
 * card must render the toggle (default on) even for this shape and a save
 * persists the resolved value (AC-7 re-scope, PM decision 2026-08-17
 * Option A).
 */
const LEGACY_CONFIG: typeof defaultFallbacksConfig = withoutRoleAutoMatch(ENABLED_CONFIG)

/** Copy a config without the `roleAutoMatch` property. */
function withoutRoleAutoMatch(config: typeof defaultFallbacksConfig): typeof defaultFallbacksConfig {
  const copy: Record<string, unknown> = { ...config }
  delete copy.roleAutoMatch
  return copy as typeof defaultFallbacksConfig
}

/**
 * A two-block config (spec §8) exercising every new editing surface: a
 * CONFORMING all-day rootChain (official V4 head — the 默认模型 panel),
 * two declared role entities (one `inherit-root`, one
 * `fallback: none` — both with their own chains so the draft is save-valid
 * under the role model-config rule, plan fallbacks-feedback-round T2), and
 * role rules referencing a declared id and the built-in `inherit`. The
 * chain-less role save-block is exercised by dedicated tests below.
 */
const TWO_BLOCK_CONFIG: typeof defaultFallbacksConfig = {
  ...defaultFallbacksConfig,
  enabled: true,
  rootChain: [OFFICIAL_V4_FLASH],
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

const VALID_CUSTOM_SLOT = {
  kind: 'custom' as const,
  start: '09:00',
  end: '10:00',
  days: [] as number[],
  chain: [OFFICIAL_V4_FLASH],
}

/**
 * A legacy two-block config whose all-day `rootChain` has a NON-official
 * head (a multi-model chain from the pre-Task-3 era): the 默认模型 panel
 * reads back with no selection + the nonconforming notice, the chain
 * entries ride the 默认降级链 editor, and save validation blocks the value
 * until the user picks Flash or Pro (plan fallbacks-timeslots Task 3 — no
 * migration wizard).
 */
const LEGACY_ALL_DAY_CONFIG: typeof defaultFallbacksConfig = {
  ...TWO_BLOCK_CONFIG,
  rootChain: ['openai/gpt-4o'],
}

/**
 * A populated catalog for the chain-add interaction: one configured
 * provider (openai) with advertised models. The `catalog` scriptedApi
 * option also serves the `llm-providers` namespace so openai counts as
 * configured and appears in the selector provider dropdown.
 */
const CHAIN_CATALOG = {
  providers: [
    { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: [] },
  ] as LlmConfigurableProvider[],
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

// PR #62 UX round 2: the card footer is gone — Save/Discard live beside the
// 主代理 / 子代理 headings and inside the expanded 高级选项 body. PR #62 UX
// round 3: the Reset affordance is gone from the card entirely (the gateway
// RPC + store method stay as host APIs). The helpers below anchor on the
// section ids so a test can click the exact section's action even though
// every section's Save shares the same label.

/** The 主代理 section heading (id anchor — the heading div carries the actions). */
function mainAgentHeading(): HTMLElement {
  return document.getElementById('fallbacks-main-agent') as HTMLElement
}

/** The 子代理 section heading (id anchor). */
function subagentsHeading(): HTMLElement {
  return document.getElementById('fallbacks-subagents') as HTMLElement
}

/** The 主代理 section's Save button (beside the heading). */
function mainSave(): HTMLButtonElement {
  return within(mainAgentHeading()).getByRole('button', { name: en.save }) as HTMLButtonElement
}

/** The 子代理 section's Save button (beside the heading). */
function subSave(): HTMLButtonElement {
  return within(subagentsHeading()).getByRole('button', { name: en.save }) as HTMLButtonElement
}

/** The 主代理 section's Discard button (beside the heading). */
function mainDiscard(): HTMLButtonElement {
  return within(mainAgentHeading()).getByRole('button', { name: en.discard }) as HTMLButtonElement
}

/** The advanced section's Save button (inside the expanded body). */
function advancedSave(): HTMLButtonElement {
  return within(document.getElementById('fallbacks-advanced-body')!).getByRole('button', { name: en.save }) as HTMLButtonElement
}

/** The advanced section's Discard button (inside the expanded body). */
function advancedDiscard(): HTMLButtonElement {
  return within(document.getElementById('fallbacks-advanced-body')!).getByRole('button', { name: en.discard }) as HTMLButtonElement
}

/**
 * Expand every collapsed role card (PR #62 UX round 2: role cards default
 * collapsed). Re-queries after each click because expanding one card
 * re-renders the list (its expand button becomes a collapse button).
 */
function expandAllRoles(): void {
  let expand = screen.queryAllByRole('button', { name: en['roles.expand'] })
  while (expand.length > 0) {
    fireEvent.click(expand[0]!)
    expand = screen.queryAllByRole('button', { name: en['roles.expand'] })
  }
}

/**
 * Expand every collapsed time-slot row (PR #62 UX round 4 part C: slot rows
 * default collapsed like role cards). Same re-query rhythm as
 * `expandAllRoles` — expanding one row re-renders the list.
 */
function expandAllSlots(): void {
  let expand = screen.queryAllByRole('button', { name: en['timeSlots.expand'] })
  while (expand.length > 0) {
    fireEvent.click(expand[0]!)
    expand = screen.queryAllByRole('button', { name: en['timeSlots.expand'] })
  }
}

/** Add a custom slot (starts expanded) so the in-row timezone label mounts. */
function addCustomSlot(): void {
  fireEvent.click(screen.getByRole('button', { name: en['timeSlots.addCustom'] }))
}

function customTzLabel(): HTMLElement {
  return screen.getByLabelText(en['timeSlots.tz.label'])
}

/**
 * The error surface rendered DIRECTLY under the 子代理 heading (validation
 * or store error — PR #62 UX round 2 splits the old single banner by
 * owning section, so a 主代理 violation and a 子代理 violation are two
 * separate alerts).
 */
function subError(): HTMLElement {
  const next = subagentsHeading().nextElementSibling
  if (next === null || next.getAttribute('role') !== 'alert') {
    throw new Error('expected an alert directly under the 子代理 heading')
  }
  return next
}

/** Regex-escape a literal string (the model labels carry parens). */
function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The all-day chooser's Flash radio, by its full accessible label. */
function flashRadio(): HTMLInputElement {
  return screen.getByLabelText(new RegExp(`^${esc(en['allDay.flash'])}$`)) as HTMLInputElement
}

/** The all-day chooser's Pro radio, by its full accessible label. */
function proRadio(): HTMLInputElement {
  return screen.getByLabelText(new RegExp(`^${esc(en['allDay.pro'])}$`)) as HTMLInputElement
}

/** Pick the official V4 Flash radio in the all-day chooser (Task 3). */
function pickAllDayFlash(): void {
  fireEvent.click(flashRadio())
}

/** Pick the official V4 Pro radio in the all-day chooser (Task 3). */
function pickAllDayPro(): void {
  fireEvent.click(proRadio())
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
    // `uiConversation` service double (the D1 Definition registry's home
    // since 0.1.2): apply() registers the `fallbacks-switch` Definition
    // through `ctx.uiConversation.events`; the card spec only pins that the
    // call happens without disturbing the card.
    uiConversation: {
      events: { register: (): (() => void) => () => {} },
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
    apply(ctx as unknown as Parameters<typeof apply>[0])

    // The card ledger holds exactly one fallbacks card.
    const cards = ledger['settings.plugin.item'] ?? []
    expect(cards).toHaveLength(1)
    // rc.7 keyed slot: `key` is the settings namespace the card edits; the
    // list-slot `id` rides along so pre-rc.7 hosts (which declare the slot
    // as a list and require options.id) can mount the card — the keyed
    // loader ignores the extra id.
    expect(cards[0].options.key).toBe('fallbacks')
    expect(cards[0].options.id).toBe('fallbacks')
    expect(cards[0].options).not.toHaveProperty('order')
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

    // Expanding reveals the enabled row. The default config is DISABLED, so
    // the form (and its per-section actions) is hidden — the compact
    // disabled-state row (Discard + Save) keeps the enabled flip saveable
    // (PR #62 UX round 2: the card footer is gone; the per-section actions
    // only exist inside the enabled form).
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(headerButton(true).getAttribute('aria-label')).toBe(`${en.collapse}: ${en.title}`)
    const toggle = screen.getByLabelText(en['enabled.label']) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(en['enabled.off'])).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(1)
    // Flipping the switch on reveals the form: Save/Discard beside the
    // 主代理 / 子代理 headings, then a third pair inside the expanded
    // advanced body. The Reset button never exists on the card (PR #62 UX
    // round 3).
    fireEvent.click(toggle)
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(2)
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(3)
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
    // Discard lives beside the section headings (and inside the advanced
    // body) — the advanced Discard reverts the advanced section (the only
    // dirty one here).
    fireEvent.click(advancedDiscard())
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    // The draft reverted to the accepted config, not to defaults.
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).value).toBe(
      String(defaultFallbacksConfig.cooldownMs),
    )
  })

  it('a 主代理 Discard reverts ONLY main fields — unsaved 子代理 edits survive (PR #62 UX round 3)', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    addCustomSlot()
    expandAllRoles()
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited persona' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainDiscard())
    view.rerender(<FallbacksCard {...props} />)
    // Discard drops the added custom row (and its tz picker) — main is clean.
    expect(screen.queryByLabelText(en['timeSlots.tz.label'])).toBeNull()
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    expect((screen.getAllByLabelText(en['roles.persona'])[0] as HTMLTextAreaElement).value).toBe('Edited persona')
  })

  it('compact Discard while enabled is OFF reverts enabled only — hidden section edits survive (PR #62 UX round 3)', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    addCustomSlot()
    fireEvent.click(screen.getByLabelText(en['enabled.label']))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['enabled.off'])).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.discard })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).checked).toBe(true)
    expect(customTzLabel().textContent).toMatch(/UTC/)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('disables Save and Discard when clean; a dirty section enables ONLY its own Save/Discard (PR #62 UX round 3)', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    expandAdvanced()
    // Clean (no edits): neither action is offered (upstream semantics —
    // save = !sectionDirty || saving || !writable; discard = !sectionDirty
    // || saving). Every section's Save/Discard gates on ITS OWN dirty term
    // (PR #62 UX round 3 — a 子代理 edit never enables 主代理 Save).
    expect(mainSave().disabled).toBe(true)
    expect(mainDiscard().disabled).toBe(true)
    expect(advancedSave().disabled).toBe(true)
    // One staged ADVANCED edit → only the advanced actions become
    // available; 主代理 stays disabled (its fields are still clean).
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(mainSave().disabled).toBe(true)
    expect(mainDiscard().disabled).toBe(true)
    expect(advancedSave().disabled).toBe(false)
    expect(advancedDiscard().disabled).toBe(false)
    // A 主代理 edit (custom-slot timezone) enables the main actions.
    addCustomSlot()
    view.rerender(<FallbacksCard {...props} />)
    expect(mainSave().disabled).toBe(false)
    expect(mainDiscard().disabled).toBe(false)
    expect(advancedSave().disabled).toBe(false) // advanced is still dirty too
  })

  it('saves the advanced section through the store face and clears the pill', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    // The advanced section's Save writes ONLY the advanced fields (plus
    // the card-level `enabled`) — it neither needs a 主代理 all-day pick
    // (per-section validation) nor persists one.
    fireEvent.click(advancedSave())
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
    expect(mainSave().disabled).toBe(true)
  })

  it('a failed save from the disabled-state row surfaces the error under the row (PR #62 UX round 2)', async () => {
    // The form (and its per-section error surfaces) is hidden while the
    // plugin is disabled — the disabled-state row must surface a store
    // write failure itself, or the error would be invisible.
    // A conforming all-day head so the disabled-state save passes
    // validation and the failure comes from the gateway wire.
    const { view, props, controller, scripted } = await mountCard({ config: { ...ENABLED_CONFIG, rootChain: [OFFICIAL_V4_FLASH] } })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Flip the switch off → the form hides, the disabled-state row appears.
    fireEvent.click(screen.getByLabelText(en['enabled.label']))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['enabled.off'])).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(1)
    // The gateway rejects the write → the error renders under the row.
    scripted.set.mockResolvedValueOnce(failResult('rejected by gateway'))
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('error'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en['error.generic']) // the test `t` does not interpolate
  })

  it('a 子代理 Save persists ONLY the roles section — sibling 主代理/高级 edits stay unsaved (PR #62 UX round 3)', async () => {
    // PR #62 UX round 3: section placement is ownership — clicking the
    // 子代理 Save persists only the roles; a 主代理 tz edit and an advanced
    // cooldown edit ride NEITHER (their drafts stay in the editors).
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    // Edit a 主代理 field (timezone), an advanced field (cooldown), and a
    // 子代理 field (role persona).
    addCustomSlot()
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    expandAllRoles()
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited persona' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          // The sub edit persists…
          roles: {
            list: [
              expect.objectContaining({ id: 'reviewer', persona: 'Edited persona' }),
              expect.objectContaining({ id: 'architect', persona: 'Designs systems' }),
            ],
            rules: expect.anything(),
          },
          // …but the main + advanced edits do NOT ride along (the patch
          // carries the last ACCEPTED values for every other section).
          tz: 'Asia/Shanghai',
          cooldownMs: defaultFallbacksConfig.cooldownMs,
        }) },
      }))
    })
    // The unsaved 主代理 + 高级 edits survive in the editors; the pill stays.
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    expect(customTzLabel().textContent).toMatch(/UTC/)
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).value).toBe('5000')
  })

  it('a 主代理 Save writes new main fields + ACCEPTED roles; the unsaved 子代理 edit survives until its own Save (PR #62 UX round 3)', async () => {
    const { view, props, controller, scripted } = await mountCard({
      config: { ...TWO_BLOCK_CONFIG, timeSlots: [VALID_CUSTOM_SLOT] },
    })
    toggleCard()
    expandAllSlots()
    fireEvent.change(screen.getByLabelText(en['timeSlots.name']), { target: { value: 'noon' } })
    expandAllRoles()
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited persona' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          // The main edit persists…
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          // …but the roles stay the ACCEPTED config — the unsaved sub edit
          // never rides along (and the card never validates it here).
          roles: {
            list: [
              expect.objectContaining({ id: 'reviewer', persona: 'Reviews code' }),
              expect.objectContaining({ id: 'architect', persona: 'Designs systems' }),
            ],
            rules: expect.anything(),
          },
        }) },
      }))
    })
    // The unsaved 子代理 edit survives the reseed (only clean sections
    // re-seed): the role editor still shows it and the pill stays.
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    expect((screen.getAllByLabelText(en['roles.persona'])[0] as HTMLTextAreaElement).value).toBe('Edited persona')
    // The follow-up 子代理 Save persists the roles on top of the accepted
    // main fields.
    fireEvent.click(subSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          roles: {
            list: [
              expect.objectContaining({ id: 'reviewer', persona: 'Edited persona' }),
              expect.objectContaining({ id: 'architect', persona: 'Designs systems' }),
            ],
            rules: expect.anything(),
          },
        }) },
      }))
    })
    // Both sections saved → the pill clears.
    await waitFor(() => {
      expect(controller.store.getSnapshot().status).toBe('ready')
    })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
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
    // (KD-G3) UNDER the section whose Save was clicked (PR #62 UX round 2 —
    // the advanced section here) and the form stays editable for retry — no
    // Retry button (the form itself is the retry surface when writable).
    scripted.set.mockResolvedValueOnce(failResult('rejected by gateway'))
    fireEvent.click(advancedSave())
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('error'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en['error.generic']) // the test `t` does not interpolate
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(false)
    expect(advancedSave().disabled).toBe(false)
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
    // A follow-up save succeeds (the mock default folded the write): the
    // accepted config re-seeds the draft → clean again, pill gone.
    fireEvent.click(advancedSave())
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect(advancedSave().disabled).toBe(true)
  })

  it('shows the read-only notice only once a settled describe reports read-only', async () => {
    // ENABLED_CONFIG so the form (and its per-section actions) renders —
    // the read-only terms are what this test pins.
    const { view, props } = await mountCard({ config: ENABLED_CONFIG, writable: false })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    // The form is inert in a read-only environment (every section's Save
    // shares the `!writable` term — PR #62 UX round 2).
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(true)
    expect(mainSave().disabled).toBe(true)
    expect(subSave().disabled).toBe(true)
  })
})

describe('FallbacksCard two-block editing surface (plan fallbacks-role-config-model T3)', () => {
  it('renders the default-chain selector list + the separate default-model Flash | Pro panel', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // PR #62 feedback round: 默认降级链 is a configurable selector list
    // (add-selector affordance present, no radios inside); the official
    // Flash | Pro radios live in the separate 默认模型 panel. The
    // chain-key text input of the old model is gone.
    expect(screen.getByText(en['rootChain.label'])).toBeTruthy()
    expect(screen.queryByLabelText('Key')).toBeNull()
    const chainGroup = screen.getByText(en['rootChain.label']).closest('[role="group"]') as HTMLElement
    expect(within(chainGroup).getByRole('button', { name: en['timeSlots.selector.add'] })).toBeTruthy()
    // TWO_BLOCK_CONFIG's conforming head is consumed by the 默认模型 panel →
    // the chain editor starts with no trailing selectors.
    expect(within(chainGroup).queryByLabelText(en['roles.rule.provider'])).toBeNull()
    // Exactly the two official radios in the default-model panel; the
    // accepted conforming head is pre-selected (Flash) and no
    // nonconforming notice shows.
    expect(screen.getByText(en['defaultModel.label'])).toBeTruthy()
    const flash = flashRadio()
    const pro = proRadio()
    expect(flash.type).toBe('radio')
    expect(pro.type).toBe('radio')
    expect(flash.checked).toBe(true)
    expect(pro.checked).toBe(false)
    const modelGroup = screen.getByText(en['defaultModel.label']).closest('[role="group"]') as HTMLElement
    expect(within(modelGroup).queryByText(en['allDay.nonconforming'])).toBeNull()
  })

  it('reads back a legacy non-official-head chain: chain entries + unselected default model + the notice (no migration wizard)', async () => {
    const { view, props } = await mountCard({ config: LEGACY_ALL_DAY_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // PR #62 feedback round: the legacy entry rides the 默认降级链 editor
    // (its head is not official → not consumed by the 默认模型 panel).
    const chainGroup = screen.getByText(en['rootChain.label']).closest('[role="group"]') as HTMLElement
    expect(within(chainGroup).getByLabelText(en['roles.rule.provider'])).toBeTruthy()
    const flash = flashRadio()
    const pro = proRadio()
    // The legacy head is not one of the two official ids → nothing is
    // selected in the default-model panel (the draft rides the accepted
    // value until a pick) and the notice shows in THAT panel.
    expect(flash.checked).toBe(false)
    expect(pro.checked).toBe(false)
    const modelGroup = screen.getByText(en['defaultModel.label']).closest('[role="group"]') as HTMLElement
    expect(within(modelGroup).getByText(en['allDay.nonconforming'])).toBeTruthy()
    // Picking Flash selects it; the nonconforming notice clears.
    pickAllDayFlash()
    view.rerender(<FallbacksCard {...props} />)
    expect(flash.checked).toBe(true)
    expect(screen.queryByText(en['allDay.nonconforming'])).toBeNull()
  })

  it('renders the chain/role sections before the advanced options and offers no provider wildcard in any chain editor', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Section order (PR #62 feedback round): 主代理 heading → 分时槽设置
    // (extra rows — plan fallbacks-timeslots Task 3) → 默认降级链 → 默认模型
    // → 子代理 heading → role entities → role rules → advanced options
    // (trigger codes / cooldown / switch caps) at the end. The advanced
    // group is reachable while collapsed — the disclosure button's label
    // text stays mounted. The headings are static section labels (not
    // role=group); their position pins the grouping.
    const groups = [
      screen.getByText(en['timeSlots.label']).closest('[role="group"]')!,
      screen.getByText(en['rootChain.label']).closest('[role="group"]')!,
      screen.getByText(en['defaultModel.label']).closest('[role="group"]')!,
      screen.getByText(en['roles.list.label']).closest('[role="group"]')!,
      screen.getByText(en['roles.rules']).closest('[role="group"]')!,
      screen.getByText(en['advanced.label']).closest('[role="group"]')!,
    ]
    const mainHeading = screen.getByText(en['mainAgent.label'])
    const subHeading = screen.getByText(en['subagents.label'])
    expect(mainHeading.compareDocumentPosition(groups[0]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(groups[2]!.compareDocumentPosition(subHeading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(subHeading.compareDocumentPosition(groups[3]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
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

  it('rejects a legacy wildcard all-day chain: chain editor keeps the entry, save blocked until a default model is picked', async () => {
    // PR #62 feedback round: the all-day chain is a selector list again —
    // a legacy `provider/*` rootChain reads back INTO the 默认降级链 editor
    // (wildcard entry + conversion hint) while the 默认模型 panel shows no
    // selection + the notice. The save stays blocked
    // (validation.allDayRequired) until the user picks Flash or Pro; the
    // pick composes rootChain = [...chain entries, default model].
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: ['openai/*'],
      timeSlots: [VALID_CUSTOM_SLOT],
    }
    const { view, props, controller, scripted } = await mountCard({ config, catalog: CHAIN_CATALOG })
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const chainGroup = screen.getByText(en['rootChain.label']).closest('[role="group"]') as HTMLElement
    // The wildcard rides the chain editor with its conversion hint and an
    // enabled model select (openai is on the catalog).
    expect(within(chainGroup).getByText(en['chains.selector.wildcardLegacy'])).toBeTruthy()
    expect(within(chainGroup).getByLabelText(en['roles.rule.model'])).toBeTruthy()
    // The nonconforming notice lives in the 默认模型 panel.
    const modelGroup = screen.getByText(en['defaultModel.label']).closest('[role="group"]') as HTMLElement
    expect(within(modelGroup).getByText(en['allDay.nonconforming'])).toBeTruthy()
    // A 主代理 edit (timezone) dirties the MAIN section; save is blocked
    // with the default-model requirement — the legacy value never crosses
    // the wire (per-section dirty: an advanced-only edit would not enable
    expandAllSlots()
    fireEvent.change(screen.getByLabelText(en['timeSlots.name']), { target: { value: 'tmp' } })
    view.rerender(<FallbacksCard {...props} />)
    // The 主代理 section's Save is blocked; the all-day violation renders
    // under the 主代理 heading (its owning section).
    fireEvent.click(mainSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.allDayRequired'])
    // Picking Flash makes the draft valid → the save patch composes the
    // legacy chain entry + the tail (tail-conforming).
    pickAllDayFlash()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({ rootChain: ['openai/*', OFFICIAL_V4_FLASH] }) },
      }))
    })
  })

  it('reads back a role wildcard chain entry with the conversion hint and converts it to an exact entry on save (T1)', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: WILDCARD_ROLE_CONFIG, catalog: CHAIN_CATALOG })
    // Settle the catalog explicitly so the model select is enabled before
    // the interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    toggleCard()
    // The unsaved 默认模型 pick (Flash) stays a MAIN-section edit: the
    // sub Save must NOT persist it (per-section save — PR #62 UX round 3),
    // and the sub save needs no all-day pick to pass validation.
    pickAllDayFlash()
    // Role cards default collapsed (PR #62 UX round 2) — open the role
    // editor first.
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // The wildcard read-back row shows the legacy-conversion hint inside the
    // role card; the openai catalog group keeps the model select enabled so
    // the row can convert to an exact entry.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(rolesGroup).getByText(en['chains.selector.wildcardLegacy'])).toBeTruthy()
    const model = within(rolesGroup).getByLabelText(en['roles.rule.model']) as HTMLSelectElement
    expect(model.disabled).toBe(false)
    // Picking a concrete model converts the wildcard row → the save patch
    // carries the exact entry, never a `provider/*` line — and the rootChain
    // stays the ACCEPTED (empty) chain: the unsaved Flash pick does not
    // ride along.
    fireEvent.change(model, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          roles: {
            list: [expect.objectContaining({ chain: ['openai/gpt-4o'] })],
            rules: [],
          },
          rootChain: [],
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
    expandAllRoles()
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
    expandAllRoles()
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
    // Role cards default collapsed (PR #62 UX round 2): the editors are
    // hidden behind the summary rows until the header is clicked.
    expect(screen.queryByLabelText(en['roles.id'])).toBeNull()
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
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

  it('collapses role panels to id + first chain model (or inherit-root) and expands back (PR #62 feedback round)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: [OFFICIAL_V4_FLASH],
      roles: {
        list: [
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'empty', persona: '', chain: [], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    // PR #62 UX round 2: role cards START collapsed — the summary rows are
    // the quiet default: reviewer shows id + first chain model; the
    // empty-chain role shows id + inherit-root (its chain falls back to the
    // root chain). No editors are mounted.
    expect(within(rolesGroup).queryByLabelText(en['roles.id'])).toBeNull()
    expect(within(rolesGroup).getByText('reviewer')).toBeTruthy()
    expect(within(rolesGroup).getByText('anthropic/claude-3-5-sonnet')).toBeTruthy()
    expect(within(rolesGroup).getByText('empty')).toBeTruthy()
    expect(within(rolesGroup).getByText('inherit-root')).toBeTruthy()
    // The WHOLE first row is the toggle: clicking the header (the collapse
    // button spans the row) expands the panel.
    fireEvent.click(within(rolesGroup).getAllByRole('button', { name: en['roles.expand'] })[0]!)
    fireEvent.click(within(rolesGroup).getAllByRole('button', { name: en['roles.expand'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(rolesGroup).getAllByLabelText(en['roles.id'])).toHaveLength(2)
    // Collapse both again: the editors unmount, the summaries return.
    fireEvent.click(within(rolesGroup).getAllByRole('button', { name: en['roles.collapse'] })[0]!)
    fireEvent.click(within(rolesGroup).getAllByRole('button', { name: en['roles.collapse'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(rolesGroup).queryByLabelText(en['roles.persona'])).toBeNull()
    expect(within(rolesGroup).getByText('reviewer')).toBeTruthy()
    expect(within(rolesGroup).getByText('anthropic/claude-3-5-sonnet')).toBeTruthy()
    // Expand the first back: its id input returns.
    fireEvent.click(within(rolesGroup).getAllByRole('button', { name: en['roles.expand'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(rolesGroup).getAllByLabelText(en['roles.id'])).toHaveLength(1)
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

  it('renders rule rows without an origin control — rules are subagent-only (PR #62 feedback)', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The legacy origin cell (root/subagent/any) is gone; each rule row
    // carries exactly provider + model + role selects (TWO_BLOCK_CONFIG
    // persists two rules, one with a legacy `origin` — ignored by the row
    // projection). Scoped to the rules group: the chain editors share the
    // provider/model labels.
    expect(screen.queryByLabelText('Origin')).toBeNull()
    const rulesGroup = screen.getByText(en['roles.rules']).closest('[role="group"]') as HTMLElement
    expect(within(rulesGroup).getAllByLabelText(en['roles.rule.provider'])).toHaveLength(2)
    expect(within(rulesGroup).getAllByLabelText(en['roles.rule.model'])).toHaveLength(2)
    expect(within(rulesGroup).getAllByLabelText(en['roles.rule.role'])).toHaveLength(2)
    // The subagent-only hint renders for the rules section.
    expect(screen.getByText(en['roles.rules.hint'])).toBeTruthy()
  })

  it('reflects role add/remove in the rules role dropdown on the same page', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    expandAllRoles()
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

    // Adding a role entity with a typed id offers it immediately (the new
    // card starts collapsed — expand it to reach its id input).
    fireEvent.click(screen.getByRole('button', { name: en['roles.add'] }))
    expandAllRoles()
    const ids = screen.getAllByLabelText(en['roles.id'])
    fireEvent.change(ids[ids.length - 1]!, { target: { value: 'coder' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(within(updatedSelect).getByRole('option', { name: 'coder' })).toBeTruthy()

    // The orphaned reference survives into the draft: a save attempt is
    // blocked — the dangling rule keeps the write off the wire and the
    // banner names the undeclared role under the 子代理 heading (T3 fix
    // wave Minor 2).
    fireEvent.click(subSave())
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
    // (rowsToRules drops role === '') with no explanation. The violation
    // renders under the 子代理 heading (its owning section).
    fireEvent.click(subSave())
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'Bad ID' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // Reserved word.
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'inherit' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.roleIdReserved'])
    // Duplicates (after fixing the reserved id to a legal one).
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'coder' } })
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[1]!, { target: { value: 'coder' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.roleIdDuplicate'])
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids[0]!.getAttribute('aria-invalid')).toBe('true')
    expect(ids[1]!.getAttribute('aria-invalid')).toBe('true')
  })

  it('blocks save on a malformed all-day chain: banner, no gateway write (Task 3)', async () => {
    // A malformed entry riding the accepted config (e.g. hand-edited YAML):
    // the all-day chooser has no free-text input, so a non-conforming chain
    // reads back with no selection; an unrelated edit makes the draft dirty
    // and the save attempt is blocked with the all-day requirement (plus
    // the per-entry selector violation) — the write never crosses the wire.
    const config: typeof defaultFallbacksConfig = { ...TWO_BLOCK_CONFIG, rootChain: ['bad-selector'] }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['allDay.nonconforming'])).toBeTruthy()
    // A 主代理 edit (timezone) dirties the main section so the save attempt
    // fires (per-section dirty).
    addCustomSlot()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.allDayRequired'])
  })

  it('clears the blocked-save state once the draft is valid again, then saves', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'Bad ID' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
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
    fireEvent.click(subSave())
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
    // An advanced edit dirties the advanced section; the Save needs no
    // 主代理 all-day pick (per-section validation — PR #62 UX round 3).
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(advancedSave())
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
    // still crosses the wire (informational only, spec §8). The advanced
    // Save needs no 主代理 all-day pick (per-section validation).
    expect((screen.getByLabelText(en['enabled.label']) as HTMLInputElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(advancedSave())
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // The inline hint explains the chain-less role before any save attempt.
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // A persona edit dirties the SUB section (a clean section's Save button
    // is disabled — per-section dirty) before the save attempt.
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    // Save is blocked: the role has no model config (the violation renders
    // under the 子代理 heading — the non-official all-day head earns its
    // own alert under 主代理, so the sub error is queried directly).
    fireEvent.click(subSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = subError()
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // A 子代理 edit (persona) makes the sub section dirty so the save
    // attempt fires — per-section dirty: the sub Save itself needs no
    // 主代理 all-day pick (PR #62 UX round 3). The Flash pick below is NOT
    // a save requirement — it only isolates the blocked-save banner: the
    // live-clear assertion below needs a fully valid draft (an empty
    // rootChain would keep a 主代理 allDayRequired alert on screen).
    pickAllDayFlash()
    // Chain area empty → inline hint shown; save is blocked by the
    // chain-less role.
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
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
    fireEvent.click(subSave())
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
    expandAllRoles()
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
    // Save is still blocked with only blank rows (a persona edit dirties
    // the SUB section so the save attempt fires — per-section dirty; the
    // blank row serializes to '' and leaves the assembled draft unchanged).
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    // The empty all-day head earns its own alert under 主代理 — the sub
    // violation is queried directly under the 子代理 heading.
    const alert = subError()
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleChainRequired'])
  })
})

describe('FallbacksCard time-slot rows (plan fallbacks-timeslots Task 3)', () => {
  // A conforming enabled config with no extra rows: the card starts clean
  // and every row below is a user action. No `timeSlots.enabled` master
  // switch — adding a row IS the opt-in (spec Settings UX notes).
  const SLOT_CONFIG: typeof defaultFallbacksConfig = { ...ENABLED_CONFIG, rootChain: [OFFICIAL_V4_FLASH] }

  /** The time-slots group element (the extra-row list ABOVE the all-day row). */
  function slotsGroup(): HTMLElement {
    return screen.getByText(en['timeSlots.label']).closest('[role="group"]') as HTMLElement
  }

  it('adds a preset row through the picker: frozen window summary, models-only editor', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: SLOT_CONFIG, catalog: CHAIN_CATALOG })
    // Settle the catalog so the chain editor offers openai/gpt-4o before the
    // interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    // No rows yet and no master switch: the group holds only the picker row
    // (no checkbox anywhere in the empty state; the picker's option text is
    // not a row — the read-only window summary only renders inside a row).
    expect(within(group).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(group).queryByText(en['timeSlots.preset.liang-peak.window'])).toBeNull()
    const picker = within(group).getByLabelText(en['timeSlots.presetPlaceholder']) as HTMLSelectElement
    expect(Array.from(picker.querySelectorAll('option')).map(option => option.value))
      .toEqual(['', 'liang-peak', 'liang-valley', 'glm-peak', 'glm-valley'])
    // Add liang-peak.
    fireEvent.change(picker, { target: { value: 'liang-peak' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(within(group).getByRole('button', { name: en['timeSlots.addPreset'] }))
    view.rerender(<FallbacksCard {...props} />)
    // The preset row renders its frozen name + read-only window summary; the
    // window is NOT editable (no start/end/days controls — code constants).
    // The name appears twice: the collapse header + the frozen-name cell.
    expect(within(group).getAllByText(en['timeSlots.preset.liang-peak.label'])).toHaveLength(2)
    expect(within(group).getByText(en['timeSlots.preset.liang-peak.window'])).toBeTruthy()
    expect(within(group).getByText(en['timeSlots.preset.chainsOnly'])).toBeTruthy()
    expect(within(group).queryByLabelText(en['timeSlots.start'])).toBeNull()
    expect(within(group).queryByLabelText(en['timeSlots.end'])).toBeNull()
    expect(within(group).queryByText(en['timeSlots.days'])).toBeNull()
    // The picker no longer offers the added preset (one row per preset id).
    const remaining = within(group).getByLabelText(en['timeSlots.presetPlaceholder']) as HTMLSelectElement
    expect(Array.from(remaining.querySelectorAll('option')).map(option => option.value))
      .not.toContain('liang-peak')
    // Save is blocked while the row has no models (chain required) — the
    // violation renders under the 主代理 heading (its owning section).
    fireEvent.click(mainSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.slotChainRequired'])
    // Add a model to the preset row's chain → the save patch carries the
    // preset row with ONLY kind/preset/days/chain — no stored windows.
    fireEvent.click(within(group).getByRole('button', { name: en['timeSlots.selector.add'] }))
    view.rerender(<FallbacksCard {...props} />)
    const providerSelect = within(group).getByLabelText(en['roles.rule.provider']) as HTMLSelectElement
    fireEvent.change(providerSelect, { target: { value: 'openai' } })
    view.rerender(<FallbacksCard {...props} />)
    const modelSelect = within(group).getByLabelText(en['roles.rule.model']) as HTMLSelectElement
    fireEvent.change(modelSelect, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] }],
        }) },
      }))
    })
  })

  it('adds a custom row: HH:mm window + optional days + models; a malformed window blocks save', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: SLOT_CONFIG, catalog: CHAIN_CATALOG })
    // Settle the catalog so the chain editor offers openai/gpt-4o before the
    // interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    fireEvent.click(within(group).getByRole('button', { name: en['timeSlots.addCustom'] }))
    view.rerender(<FallbacksCard {...props} />)
    // The fresh custom row has editable start/end inputs and the seven day
    // toggles (all unchecked = every day).
    const start = within(group).getByLabelText(en['timeSlots.start']) as HTMLInputElement
    const end = within(group).getByLabelText(en['timeSlots.end']) as HTMLInputElement
    const dayCells = within(group).getAllByRole('checkbox')
    expect(dayCells).toHaveLength(7)
    expect(dayCells.every(cell => !(cell as HTMLInputElement).checked)).toBe(true)
    // A non-HH:mm window surfaces the inline hint and blocks the save.
    fireEvent.change(start, { target: { value: '9:00' } })
    fireEvent.change(end, { target: { value: '10:00' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(within(group).getByText(en['validation.slotWindow'])).toBeTruthy()
    fireEvent.click(mainSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.slotWindow'])
    // Fill a valid wrap-midnight window + models + a day mask (Monday) →
    // the save patch carries the custom row with days serialized.
    fireEvent.change(start, { target: { value: '22:00' } })
    fireEvent.change(end, { target: { value: '02:00' } })
    fireEvent.click(within(group).getByRole('button', { name: en['timeSlots.selector.add'] }))
    view.rerender(<FallbacksCard {...props} />)
    const providerSelect = within(group).getByLabelText(en['roles.rule.provider']) as HTMLSelectElement
    fireEvent.change(providerSelect, { target: { value: 'openai' } })
    view.rerender(<FallbacksCard {...props} />)
    const modelSelect = within(group).getByLabelText(en['roles.rule.model']) as HTMLSelectElement
    fireEvent.change(modelSelect, { target: { value: 'gpt-4o' } })
    fireEvent.click(dayCells[1]!) // Monday
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          timeSlots: [{ kind: 'custom', start: '22:00', end: '02:00', days: [1], chain: ['openai/gpt-4o'] }],
        }) },
      }))
    })
  })

  it('removes and reorders extra rows; the all-day row is never in the list', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'custom', start: '09:00', end: '10:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
      ],
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Slot rows default collapsed — expand them so the move/remove cluster
    // is mounted.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    // Both rows render with move-up/move-down/remove; the ends are
    // correctly disabled (first row has no up, last row has no down).
    const upButtons = within(group).getAllByRole('button', { name: en['timeSlots.moveUp'] })
    const downButtons = within(group).getAllByRole('button', { name: en['timeSlots.moveDown'] })
    expect(upButtons).toHaveLength(2)
    expect(downButtons).toHaveLength(2)
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true)
    expect((downButtons[1] as HTMLButtonElement).disabled).toBe(true)
    // Move the first (preset) row down → the custom row becomes first; the
    // save patch reflects the new order (first matching row wins).
    fireEvent.click(downButtons[0]!)
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          timeSlots: [
            { kind: 'custom', start: '09:00', end: '10:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
            { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
          ],
        }) },
      }))
    })
    // The save re-seeds the rows COLLAPSED (default) — expand again before
    // driving the remove cluster.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    // Remove the (now first) custom row → only the preset row remains.
    fireEvent.click(within(group).getAllByRole('button', { name: en['timeSlots.remove'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(group).getAllByRole('button', { name: en['timeSlots.remove'] })).toHaveLength(1)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] }],
        }) },
      }))
    })
  })

  it('loads existing time-slot rows clean (no unsaved pill) and reads back preset windows + day toggles', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        { kind: 'preset', preset: 'glm-valley', days: [], chain: [OFFICIAL_V4_FLASH] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [5], chain: ['openai/gpt-4o'] },
      ],
    }
    const { view, props } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The accepted rows round-trip through the editor: no spurious unsaved
    // pill (dirty-check invariant).
    expect(screen.queryByText(en.unsaved)).toBeNull()
    // Slot rows default collapsed — expand so the frozen-name cells / day
    // toggles (expanded-body content) are readable.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    // The preset name appears twice: the collapse header + the frozen-name
    // cell (PR #62 feedback round).
    expect(within(group).getAllByText(en['timeSlots.preset.glm-valley.label'])).toHaveLength(2)
    expect(within(group).getByText(en['timeSlots.preset.glm-valley.window'])).toBeTruthy()
    // PR #62 feedback: GLM preset rows carry the zai-coding-cn validity
    // caveat.
    expect(within(group).getByText(en['timeSlots.preset.glm.note'])).toBeTruthy()
    // The custom row's stored days render as checked day toggles (Fri = 5).
    const dayCells = within(group).getAllByRole('checkbox')
    expect(dayCells).toHaveLength(7)
    expect((dayCells[5] as HTMLInputElement).checked).toBe(true)
    expect(dayCells.every((cell, index) => index === 5 || !(cell as HTMLInputElement).checked)).toBe(true)
  })

  it('collapses a slot row to name + first model and expands it back (PR #62 feedback round)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [], name: '晚班', chain: ['anthropic/claude-3-5-sonnet'] },
      ],
    }
    const { view, props } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Slot rows default collapsed (PR #62 UX round 4 part C) — expand them
    // to reach the editors this test drives.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    // Custom rows carry an editable name field (read back from the wire).
    const nameInput = within(group).getByLabelText(en['timeSlots.name']) as HTMLInputElement
    expect(nameInput.value).toBe('晚班')
    // PR #62 UX round 2: the WHOLE first row is the toggle — the collapse
    // button spans the row and carries the name + first model inside it.
    const collapseToggle = within(group).getAllByRole('button', { name: en['timeSlots.collapse'] })[0]!
    expect(within(collapseToggle).getByText(en['timeSlots.preset.liang-peak.label'])).toBeTruthy()
    expect(within(collapseToggle).getByText('openai/gpt-4o')).toBeTruthy()
    // Collapse the preset row: header shows the frozen name + first model;
    // the window summary, the chainsOnly hint, and the chain editor hide.
    fireEvent.click(collapseToggle)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(group).getAllByText(en['timeSlots.preset.liang-peak.label'])).toHaveLength(1)
    expect(within(group).queryByText(en['timeSlots.preset.liang-peak.window'])).toBeNull()
    expect(within(group).queryByText(en['timeSlots.preset.chainsOnly'])).toBeNull()
    expect(within(group).getByText('openai/gpt-4o')).toBeTruthy()
    // Expand it back: the full editor returns (name appears twice again).
    fireEvent.click(within(group).getAllByRole('button', { name: en['timeSlots.expand'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(group).getAllByText(en['timeSlots.preset.liang-peak.label'])).toHaveLength(2)
    expect(within(group).getByText(en['timeSlots.preset.liang-peak.window'])).toBeTruthy()
  })

  it('drag-reorders slot rows via the dedicated handle; the reorder persists on save (PR #62 UX round 2)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
      ],
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Slot rows default collapsed — expand them so the move-cluster
    // assertion after the drop can see the up buttons.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    // PR #62 UX round 2: the drag HANDLE is the only draggable element
    // (click ≠ drag — the collapse header is a plain button); the row card
    // is the drop target. Grab the SECOND row's handle and drop it onto the
    // FIRST row's card.
    const handles = within(group).getAllByRole('button', { name: en['timeSlots.drag'] })
    expect(handles).toHaveLength(2)
    const cards = handles.map(handle => handle.closest('div')!.parentElement as HTMLElement)
    fireEvent.dragStart(handles[1]!)
    fireEvent.dragOver(cards[0]!)
    fireEvent.drop(cards[0]!)
    view.rerender(<FallbacksCard {...props} />)
    // The custom row now sits first (its up button is disabled) and the
    // preset row follows — the save patch carries the new order.
    const upButtons = within(group).getAllByRole('button', { name: en['timeSlots.moveUp'] })
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          timeSlots: [
            { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
            { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
          ],
        }) },
      }))
    })
  })

  it('keeps a COLLAPSED slot row drag-reorderable through the handle (PR #62 UX round 2)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
      ],
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    // Slot rows default COLLAPSED (PR #62 UX round 4 part C) — the editors
    // are unmounted from the start, the summary rows remain.
    expect(within(group).queryByLabelText(en['timeSlots.start'])).toBeNull()
    // The drag handles are still there and still draggable while collapsed:
    // grab the SECOND row's handle and drop it onto the FIRST row's card.
    const handles = within(group).getAllByRole('button', { name: en['timeSlots.drag'] })
    expect(handles).toHaveLength(2)
    const cards = handles.map(handle => handle.closest('div')!.parentElement as HTMLElement)
    fireEvent.dragStart(handles[1]!)
    fireEvent.dragOver(cards[0]!)
    fireEvent.drop(cards[0]!)
    view.rerender(<FallbacksCard {...props} />)
    // The custom row now sits first — expand the rows to verify the order
    // through the move buttons (the move cluster only renders expanded).
    fireEvent.click(within(group).getAllByRole('button', { name: en['timeSlots.expand'] })[0]!)
    fireEvent.click(within(group).getAllByRole('button', { name: en['timeSlots.expand'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    const upButtons = within(group).getAllByRole('button', { name: en['timeSlots.moveUp'] })
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          timeSlots: [
            { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
            { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
          ],
        }) },
      }))
    })
  })

  it('blocks save on an empty preset row chain even when other edits are valid (chain required)', async () => {
    const { view, props, scripted } = await mountCard({ config: SLOT_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    const picker = within(group).getByLabelText(en['timeSlots.presetPlaceholder']) as HTMLSelectElement
    // liang-peak (not a GLM preset — those are gated on zai-coding-cn).
    fireEvent.change(picker, { target: { value: 'liang-peak' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(within(group).getByRole('button', { name: en['timeSlots.addPreset'] }))
    view.rerender(<FallbacksCard {...props} />)
    // The empty-chain preset row shows the inline chain-required hint.
    expect(within(group).getByText(en['validation.slotChainRequired'])).toBeTruthy()
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.slotChainRequired'])
  })

  it('rejects a YAML preset row carrying a day mask on save (qc1 F-002 — frozen windows, gateway mirror)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        // Hand-written YAML row: preset windows are frozen code constants,
        // so `days` is illegal. The preset UI renders NO day controls —
        // the offending value is invisible in the card, so without this
        // guard the row would pass card validation and be rejected only at
        // the gateway with a generic English banner, un-fixable from here.
        { kind: 'preset', preset: 'liang-peak', days: [1], chain: ['openai/gpt-4o'] },
      ],
    }
    const { view, props, scripted } = await mountCard({ config })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Slot rows default collapsed — expand so the frozen-name cell (the
    // second label occurrence) is mounted.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    // The row loads clean (days round-trips through the editor — the
    // dirty-check invariant holds; no unsaved pill).
    expect(screen.queryByText(en.unsaved)).toBeNull()
    // The preset name appears twice: the collapse header + the frozen-name
    // cell (PR #62 feedback round).
    expect(within(slotsGroup()).getAllByText(en['timeSlots.preset.liang-peak.label'])).toHaveLength(2)
    // A 主代理 edit (a fresh custom slot row) dirties the MAIN section so
    // the save attempt fires (per-section dirty — an advanced-only edit
    // would not enable 主代理 Save), then Save is blocked by the
    // frozen-window guard with an inline explanation — the gateway error
    // never becomes the first word.
    fireEvent.click(screen.getByRole('button', { name: en['timeSlots.addCustom'] }))
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.slotPresetFrozen'])
  })

  it('renders cost/multiplier tags on peak preset rows only (PR #62 UX round 4)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...SLOT_CONFIG,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'preset', preset: 'glm-peak', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'preset', preset: 'liang-valley', days: [], chain: ['openai/gpt-4o'] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: ['openai/gpt-4o'] },
      ],
    }
    const { view, props } = await mountCard({ config })
    // The multiplier copy carries `{n}` — bind the interpolating seat so the
    // concrete x2/x3 factor renders (the module `t` returns raw templates).
    toggleCard()
    view.rerender(<FallbacksCard {...{ ...props, t: interpolatingT }} />)
    const group = slotsGroup()
    // Both PEAK rows carry the red 高消耗 chip…
    expect(within(group).getAllByText(en['timeSlots.preset.highCost'])).toHaveLength(2)
    // …and the yellow multiplier chip: x2 on liang-peak, x3 on glm-peak.
    expect(within(group).getAllByText('x2')).toHaveLength(1)
    expect(within(group).getAllByText('x3')).toHaveLength(1)
    // The valley + custom rows render NO chips: the tags live only in the
    // peak rows' collapsed titles (rows default collapsed — the header
    // toggle reads as an expand button).
    const toggles = within(group).getAllByRole('button', { name: en['timeSlots.expand'] })
    expect(toggles).toHaveLength(4)
    expect(within(toggles[2]!).queryByText(en['timeSlots.preset.highCost'])).toBeNull() // liang-valley
    expect(within(toggles[2]!).queryByText(/^x\d$/)).toBeNull()
    expect(within(toggles[3]!).queryByText(en['timeSlots.preset.highCost'])).toBeNull() // custom
    expect(within(toggles[3]!).queryByText(/^x\d$/)).toBeNull()
  })

  it('tags the currently-active slot row with the Active chip (PR #62 UX round 4)', async () => {
    // The active slot is resolved with the RUNTIME helper (P5): freeze the
    // clock at 10:00 Asia/Shanghai — inside the liang-peak window
    // (09:00–12:00) — so the first row wins deterministically.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-18T02:00:00Z'))
      const config: typeof defaultFallbacksConfig = {
        ...SLOT_CONFIG,
        timeSlots: [
          { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
          { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: ['anthropic/claude-3-5-sonnet'] },
        ],
      }
      const { view, props } = await mountCard({ config })
      toggleCard()
      view.rerender(<FallbacksCard {...{ ...props, t: interpolatingT }} />)
      const group = slotsGroup()
      // Rows default collapsed — the header toggles read as expand buttons
      // and carry the chips (the 激活 chip rides the active row's title).
      const toggles = within(group).getAllByRole('button', { name: en['timeSlots.expand'] })
      // The ACTIVE (liang-peak) row's title carries the 激活 chip…
      expect(within(toggles[0]!).getByText(en['timeSlots.active'])).toBeTruthy()
      // …the non-active custom row does not.
      expect(within(toggles[1]!).queryByText(en['timeSlots.active'])).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tags NO slot row when the active surface is all-day (PR #62 UX round 4)', async () => {
    // 13:00 Asia/Shanghai is OUTSIDE the liang-peak windows (09:00–12:00
    // & 14:00–18:00) and no valley row is configured → the winner is
    // 'all-day' → no row is tagged (the all-day surface is the 默认模型
    // panel, out of scope for the slot-row indicator).
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-18T05:00:00Z'))
      const config: typeof defaultFallbacksConfig = {
        ...SLOT_CONFIG,
        timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] }],
      }
      const { view, props } = await mountCard({ config })
      toggleCard()
      view.rerender(<FallbacksCard {...{ ...props, t: interpolatingT }} />)
      expect(screen.queryByText(en['timeSlots.active'])).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disables the GLM preset options until zai-coding-cn is configured (PR #62 UX round 4 part B)', async () => {
    // The openai-only catalog leaves zai-coding-cn UNCONFIGURED (the
    // Models-page `configured` join): the GLM options stay visible but
    // disabled with the reason suffix; the add guard refuses them too.
    const { view, props, controller } = await mountCard({ config: SLOT_CONFIG, catalog: CHAIN_CATALOG })
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const group = slotsGroup()
    const picker = within(group).getByLabelText(en['timeSlots.presetPlaceholder']) as HTMLSelectElement
    const options = Array.from(picker.querySelectorAll('option'))
    const byValue = (value: string): HTMLOptionElement => options.find(option => option.value === value) as HTMLOptionElement
    expect(byValue('glm-peak').disabled).toBe(true)
    expect(byValue('glm-valley').disabled).toBe(true)
    expect(byValue('liang-peak').disabled).toBe(false)
    expect(byValue('liang-valley').disabled).toBe(false)
    // The disabled GLM options carry the unconfigured suffix; the enabled
    // Liang options do not.
    expect(byValue('glm-peak').textContent).toContain(en['timeSlots.preset.glm.unconfigured'])
    expect(byValue('glm-valley').textContent).toContain(en['timeSlots.preset.glm.unconfigured'])
    expect(byValue('liang-peak').textContent).not.toContain(en['timeSlots.preset.glm.unconfigured'])
    // Defensive guard: even a programmatically forced GLM selection (jsdom
    // lets fireEvent set a disabled option) must not add a row.
    fireEvent.change(picker, { target: { value: 'glm-peak' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(within(group).getByRole('button', { name: en['timeSlots.addPreset'] }))
    view.rerender(<FallbacksCard {...props} />)
    expect(within(group).queryAllByRole('button', { name: en['timeSlots.expand'] })).toHaveLength(0)
  })

  it('enables the GLM preset options once zai-coding-cn is configured (PR #62 UX round 4 part B)', async () => {
    const catalog = {
      providers: [
        { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-providers', settingsPath: [] },
        { provider: 'zai-coding-cn', displayName: 'ZAI', settingsNs: 'llm-providers', settingsPath: [] },
      ] as LlmConfigurableProvider[],
      groups: [
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
        { id: 'zai-coding-cn', name: 'ZAI', models: [{ id: 'glm-4.6', name: 'GLM 4.6' }] },
      ] as ModelProviderGroup[],
    }
    const { view, props, controller } = await mountCard({ config: SLOT_CONFIG, catalog })
    await controller.loadCatalog()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    const picker = within(slotsGroup()).getByLabelText(en['timeSlots.presetPlaceholder']) as HTMLSelectElement
    const options = Array.from(picker.querySelectorAll('option'))
    const byValue = (value: string): HTMLOptionElement => options.find(option => option.value === value) as HTMLOptionElement
    expect(byValue('glm-peak').disabled).toBe(false)
    expect(byValue('glm-valley').disabled).toBe(false)
    expect(byValue('glm-peak').textContent).not.toContain(en['timeSlots.preset.glm.unconfigured'])
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
    // Role cards default collapsed (PR #62 UX round 2) — the badge lives
    // inside the role editor, so open the cards first.
    expandAllRoles()
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
    expandAllRoles()
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['roles.revertPersona'] }))
    // The store mirrors save: the rpc reaches fallbacks/revert-seed with the
    // row's trimmed id (spec §9.4), independent of any card Save.
    expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/revert-seed', { args: { id: 'architect' } })
    expect(scripted.revertSeed).toHaveBeenCalledTimes(1)
  })

  it('revert snaps an unsaved persona draft back to the seed default (issue #59)', async () => {
    // Persisted persona IS the seed default — gateway revert is a persist
    // no-op. The button must still restore the in-card draft.
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    const personas = screen.getAllByLabelText(en['roles.persona']) as HTMLTextAreaElement[]
    fireEvent.change(personas[0]!, { target: { value: 'Edited, not saved' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(personas[0]!.value).toBe('Edited, not saved')
    scripted.revertSeed.mockReturnValueOnce(okResult({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false }],
      outcome: { reverted: true, persona: 'Designs systems' },
    }))
    fireEvent.click(screen.getByRole('button', { name: en['roles.revertPersona'] }))
    await waitFor(() => {
      expect((screen.getAllByLabelText(en['roles.persona'])[0] as HTMLTextAreaElement).value).toBe('Designs systems')
    })
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
    // Read-only forces the role cards open (the collapse toggle is inert),
    // so the revert button is reachable and disabled.
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
    expandAllRoles()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    const gate = Promise.withResolvers<unknown>()
    scripted.set.mockReturnValueOnce(gate.promise as never)
    // An advanced edit makes the advanced section dirty so Save is enabled
    // (no 主代理 all-day pick needed — per-section validation); the
    // in-flight write flips the store to 'saving'.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(advancedSave())
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // The seeded row shows the non-blocking chain hint instead of the
    // blocking one.
    expect(screen.getByText(en['roles.seedChainOptional'])).toBeTruthy()
    expect(screen.queryByText(en['validation.roleChainRequired'])).toBeNull()
    // A persona edit dirties the SUB section so its Save is enabled (no
    // 主代理 all-day pick needed — per-section validation), then Save
    // passes validation (the seeded relax) and writes.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    fireEvent.change(within(rolesGroup).getAllByLabelText(en['roles.persona'])[0]!, { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // architect is seeded → the seeded (non-blocking) hint; reviewer is NOT
    // seeded → the blocking chain-required hint stays.
    expect(screen.getByText(en['roles.seedChainOptional'])).toBeTruthy()
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // Save is blocked: the non-seeded empty-chain role keeps the draft off
    // the wire (the violation renders under the 子代理 heading). A persona
    // edit dirties the SUB section so its Save attempt fires (per-section
    // dirty — PR #62 UX round 3).
    fireEvent.change(screen.getAllByLabelText(en['roles.persona'])[1]!, { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(subSave())
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    // The empty all-day head earns its own alert under 主代理 — the sub
    // violation is queried directly under the 子代理 heading.
    const alert = subError()
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleChainRequired'])
  })

  it('round-trips an override: edit persona → save → override badge → revert → default badge', async () => {
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false }],
    })
    toggleCard()
    expandAllRoles()
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
    fireEvent.click(subSave())
    // The save lands: the accepted config re-seeds the draft → role cards
    // re-collapse (default collapsed, PR #62 UX round 2). Wait for the
    // collapse, then re-open the editors to read the persona + badge back.
    await waitFor(() => expect(screen.getAllByRole('button', { name: en['roles.expand'] })).toHaveLength(2))
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getAllByText(en['roles.seedOverride'])).toHaveLength(1)
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
    // Same re-seed rhythm after the revert write.
    await waitFor(() => expect(screen.getAllByRole('button', { name: en['roles.expand'] })).toHaveLength(2))
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getAllByText(en['roles.seedDefault'])).toHaveLength(1)
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
    expandAllRoles()
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
    expandAllRoles()
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(2)
    expect((ids[0] as HTMLInputElement).value).toBe('designer')
    expect((ids[1] as HTMLInputElement).value).toBe('reviewer')
    expect((ids[0] as HTMLInputElement).disabled).toBe(true)
    expect((ids[1] as HTMLInputElement).disabled).toBe(false)
  })
})

describe('FallbacksCard 主代理 layout (PR #62 feedback round)', () => {
  const slotGroup = (): HTMLElement =>
    screen.getByText(en['timeSlots.label']).closest('[role="group"]') as HTMLElement

  it('removes the preemption hints from the default-chain block', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // PR #62 feedback round: the old "engages only after the session model
    // fails" first line and the prefer-session-model hint are removed
    // entirely from the 默认降级链 block.
    expect(screen.queryByText(/Engages only after the current session/)).toBeNull()
    expect(screen.queryByText(/Prefer the current session/)).toBeNull()
  })
  it('hides the timezone picker on preset-only configs; mixed configs lock it to Asia/Shanghai', async () => {
    const presetOnly: typeof defaultFallbacksConfig = {
      ...ENABLED_CONFIG,
      rootChain: [OFFICIAL_V4_FLASH],
      timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_V4_FLASH] }],
    }
    const first = await mountCard({ config: presetOnly })
    toggleCard()
    first.view.rerender(<FallbacksCard {...first.props} />)
    // Preset rows have no tz picker — windows are frozen UTC+8.
    expect(screen.queryByLabelText(en['timeSlots.tz.label'])).toBeNull()
    first.view.unmount()

    const mixed: typeof defaultFallbacksConfig = {
      ...presetOnly,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_V4_FLASH] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: [OFFICIAL_V4_FLASH] },
      ],
    }
    const second = await mountCard({ config: mixed })
    toggleCard()
    second.view.rerender(<FallbacksCard {...second.props} />)
    expandAllSlots()
    expect(customTzLabel().textContent).toContain('Asia/Shanghai')
    expect(customTzLabel().textContent).toMatch(/UTC/)
    expect(screen.queryByRole('combobox', { name: en['timeSlots.tz.label'] })).toBeNull()
  })

  it('shows the host timezone as a label on custom slots and persists it on save', async () => {
    const { view, props, scripted } = await mountCard({
      config: { ...ENABLED_CONFIG, rootChain: [OFFICIAL_V4_FLASH], timeSlots: [VALID_CUSTOM_SLOT] },
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expandAllSlots()
    const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    expect(customTzLabel().textContent).toContain(hostTz)
    fireEvent.change(screen.getByLabelText(en['timeSlots.name']), { target: { value: 'noon' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(mainSave())
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({ tz: hostTz }) },
      }))
    })
  })

  it('keeps the 主代理 layout keys in both zh and en dictionaries', () => {
    // Bilingual-pair constraint (plan Global Constraints): every locale
    // change lands in both zh and en, non-empty.
    expect(zh['mainAgent.label']).toBeTruthy()
    expect(en['mainAgent.label']).toBeTruthy()
    expect(zh['rootChain.label']).toBeTruthy()
    expect(en['rootChain.label']).toBeTruthy()
    expect(zh['defaultModel.label']).toBeTruthy()
    expect(en['defaultModel.label']).toBeTruthy()
    expect(zh['timeSlots.tz.label']).toBeTruthy()
    expect(en['timeSlots.tz.label']).toBeTruthy()
    expect(zh['timeSlots.name']).toBeTruthy()
    expect(en['timeSlots.name']).toBeTruthy()
  })
})

describe('FallbacksCard roleAutoMatch toggle (plan fallbacks-settings-visibility T3)', () => {
  it('renders the toggle in the advanced options, default on', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // The toggle lives in the advanced section and starts checked (the
    // config-model default, `true` — compass AC-6 roleAutoMatch default on).
    const toggle = screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  it('writes the toggle to the scalar and persists roleAutoMatch:false through a save', async () => {
    const { view, props, scripted } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // Flipping the toggle off makes the advanced section dirty (scalar
    // roleAutoMatch true → false); the advanced Save persists it without
    // any 主代理 all-day pick (per-section validation — PR #62 UX round 3).
    fireEvent.click(screen.getByLabelText(en['roleAutoMatch.label']))
    view.rerender(<FallbacksCard {...props} />)
    expect((screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(advancedSave())
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    expect(scripted.set).toHaveBeenCalledWith(expect.objectContaining({
      args: { patch: expect.objectContaining({ roleAutoMatch: false }) },
    }))
  })

  it('renders the toggle (default on) for a legacy config that never declared the key (AC-7 re-scope Option A)', async () => {
    const { view, props } = await mountCard({ config: LEGACY_CONFIG })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // AC-7 re-scope (PM decision 2026-08-17 Option A): the real gateway wire
    // always carries `roleAutoMatch: true` (the schema fold — see
    // tests/gateway.spec.ts), so the card ALWAYS renders the toggle and it
    // starts checked. The advanced options render the rest as usual.
    const toggle = screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy()
  })

  it('loads a legacy config clean (no unsaved pill) — the draft and accepted basis both carry the folded roleAutoMatch: true', async () => {
    // The dirty-check invariant must hold for legacy configs too: the
    // accepted config-basis keeps the folded `roleAutoMatch: true` (the
    // value every real-wire read emits), and the assembled draft carries the
    // same value, so the card does NOT show a spurious "unsaved" state the
    // moment it loads.
    const { view, props } = await mountCard({ config: LEGACY_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect(mainSave().disabled).toBe(true)
  })

  it('a legacy-config save persists roleAutoMatch: true (the schema default is pinned, not invented)', async () => {
    const { view, props, scripted } = await mountCard({ config: LEGACY_CONFIG })
    toggleCard()
    expandAdvanced()
    view.rerender(<FallbacksCard {...props} />)
    // An advanced edit makes the advanced section dirty (a clean draft's
    // Save button is disabled); the always-rendered toggle stays on, so the
    // saved section carries `roleAutoMatch: true` and the save pins it —
    // semantically identical to the schema default (AC-7 re-scope Option A).
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(advancedSave())
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    expect(scripted.set).toHaveBeenCalledWith(expect.objectContaining({
      args: { patch: expect.objectContaining({ roleAutoMatch: true }) },
    }))
  })

  it('keeps the roleAutoMatch label + hint/tooltip keys in both zh and en dictionaries', () => {
    // Bilingual-pair constraint (plan Global Constraints).
    expect(zh['roleAutoMatch.label']).toBeTruthy()
    expect(en['roleAutoMatch.label']).toBeTruthy()
    expect(zh['roleAutoMatch.hint']).toBeTruthy()
    expect(en['roleAutoMatch.hint']).toBeTruthy()
    expect(zh['roleAutoMatch.tooltip']).toBeTruthy()
    expect(en['roleAutoMatch.tooltip']).toBeTruthy()
  })

  it('keeps the toggle inert under the global read-only gate (!writable)', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG, writable: false })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // Read-only forces the advanced options open and the wrapping fieldset
    // + explicit disabled term make the toggle inert (F-002 precedent).
    const toggle = screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
  })
})

describe('FallbacksCard status block (AC-2: recent switch only)', () => {
  it('renders only the recent-switch line — no effective-model line, no selectionNote', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The read-only block keeps its title and the recent-switch (empty) line.
    expect(screen.getByText(en['status.title'])).toBeTruthy()
    expect(screen.getByText(/^Recent switches:/)).toBeTruthy()
    expect(screen.getByText(en['status.switches.empty'])).toBeTruthy()
    // Compass AC-2: the effective-model line and the selectionNote are gone
    // from the card (the degradation content is re-homed to verification.md).
    expect(screen.queryByText(/current effective model/i)).toBeNull()
    expect(screen.queryByText(/manually selected in the web front end/i)).toBeNull()
  })

  it('renders the recent-switch compact line when a switch exists (still no effective-model/selectionNote)', async () => {
    const scripted = scriptedApi({ config: ENABLED_CONFIG, historyEntries: [switchEntry(1)] })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    // The compact line's {count}/{from}/{to}/{role}/{reason} slots are
    // interpolated at render time, so this test binds an interpolating `t`
    // (the module `t` seat is deliberately non-interpolating — the validation
    // specs pin raw templates there; the sibling general-row spec uses the
    // same interpolating seat to pin the concrete from → to (role · reason)).
    const interpolate = ((key, params) => {
      let text: string = en[key as keyof typeof en]
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(value)
      }
      return text
    }) as FallbacksCardProps['t']
    const props: FallbacksCardProps = {
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      t: interpolate,
      useSessions: undefined as never,
      useWorkspaces: undefined as never,
    }
    const view = render(<FallbacksCard {...props} />)
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(
      'last 1 · openai/gpt-4o → anthropic/claude-3-5-sonnet (inherit · trigger code)',
    )).toBeTruthy()
    expect(screen.queryByText(/current effective model/i)).toBeNull()
    expect(screen.queryByText(/manually selected in the web front end/i)).toBeNull()
  })

  it('renders the role-inject recent-switch line as the deduped role → model mapping (localized reason)', async () => {
    // Task 5 (direction 3): a `role-inject` switch reads naturally as the
    // resolved role mapping to its chain-head model (`reviewer →
    // anthropic/claude-3-5-sonnet`) — the destination `{to}` appears once
    // (as the role→model mapping), not twice; the leading `{from} → {to}`
    // is dropped. Role + reason both stay visible (AC-5).
    const scripted = scriptedApi({
      config: ENABLED_CONFIG,
      historyEntries: [switchEntry(1, { role: 'reviewer', reason: 'role-inject' })],
    })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const interpolate = ((key, params) => {
      let text: string = en[key as keyof typeof en]
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(value)
      }
      return text
    }) as FallbacksCardProps['t']
    const props: FallbacksCardProps = {
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      t: interpolate,
      useSessions: undefined as never,
      useWorkspaces: undefined as never,
    }
    const view = render(<FallbacksCard {...props} />)
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(
      'last 1 · reviewer → anthropic/claude-3-5-sonnet (role inject)',
    )).toBeTruthy()
    expect(screen.queryByText(/current effective model/i)).toBeNull()
    expect(screen.queryByText(/manually selected in the web front end/i)).toBeNull()
  })

  it('keeps the role-inject recent-switch keys in both zh and en dictionaries', () => {
    // Bilingual pair (HARD): the new role-inject line shape exists in both
    // dictionaries, non-empty — the row spec pins its own `general.switch.roleInject`
    // rendering; the en dictionary completeness is type-enforced by `satisfies
    // Record<FallbacksKey, string>` in locales.ts.
    expect(zh['status.switches.compact.roleInject']).toBeTruthy()
    expect(en['status.switches.compact.roleInject']).toBeTruthy()
    expect(zh['general.switch.roleInject']).toBeTruthy()
    expect(en['general.switch.roleInject']).toBeTruthy()
  })

  it('shows the loading term while the switch history read is in flight', async () => {
    const scripted = scriptedApi({ config: ENABLED_CONFIG })
    scripted.api.session.follow = vi.fn((): AsyncIterable<SessionFollowFrame> => (async function* (): AsyncGenerator<SessionFollowFrame> {
      await Promise.withResolvers().promise
    })())
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    void controller.loadSwitches()
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('surfaces the switches read error with an alert and no effective-model/selectionNote', async () => {
    const scripted = scriptedApi({ config: ENABLED_CONFIG, historyError: 'history refused' })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    // The switches face carried the read error into the line's `{message}`
    // slot (the card-spec `t` seat is non-interpolating, so assert the state
    // + the error line + the alert, per the file's convention).
    expect(controller.store.getSnapshot().switchesError).toBe('history refused')
    expect(screen.getByText(/Switch history read failed/)).toBeTruthy()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(screen.queryByText(/current effective model/i)).toBeNull()
    expect(screen.queryByText(/manually selected in the web front end/i)).toBeNull()
  })
})

describe('FallbacksCard host-policy status (plan dsh-012-subagent-routing T5 / spec D4)', () => {
  const POLICY_KEYS = [
    'subagents.policy.label',
    'subagents.policy.allowlist',
    'subagents.policy.head',
    'subagents.policy.source.authorized',
    'subagents.policy.source.injected',
    'subagents.policy.blocked',
    'subagents.policy.unprovable',
  ] as const

  /** Distinct routes so text queries cannot collide with catalog models. */
  const ALPHA = { provider: 'policy-test', model: 'alpha' }
  const BETA = { provider: 'policy-test', model: 'beta' }

  const ENABLED_POLICY: SubagentPolicyView = {
    state: 'enabled',
    allowedModels: [ALPHA, BETA],
    head: { route: ALPHA, source: 'authorized' },
    blockedAttempt: { at: 1, route: BETA, reason: 'empty-intersection' },
  }

  it('policy-on renders the allowlist, head/source, and empty-intersection warning', async () => {
    const { view, props } = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: ENABLED_POLICY,
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.policy.label'])).toBeTruthy()
    expect(screen.getByText(`${en['subagents.policy.allowlist']}: policy-test/alpha, policy-test/beta`)).toBeTruthy()
    expect(screen.getByText(
      `${en['subagents.policy.head']}: policy-test/alpha (${en['subagents.policy.source.authorized']})`,
    )).toBeTruthy()
    expect(screen.getByText(en['subagents.policy.blocked'])).toBeTruthy()
    expect(screen.getByText(en['subagents.policy.blocked']).getAttribute('role')).toBe('alert')
    expect(screen.queryByText(en['subagents.policy.unprovable'])).toBeNull()
  })

  it('policy-off / absent payload renders no active allowlist', async () => {
    const { view, props } = await mountCard({ config: ENABLED_CONFIG })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.label'])).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.allowlist'], { exact: false })).toBeNull()
    expect(screen.queryByText('policy-test/alpha')).toBeNull()
    cleanup()

    const disabled = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: { state: 'disabled' },
    })
    toggleCard()
    disabled.view.rerender(<FallbacksCard {...disabled.props} />)
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.allowlist'], { exact: false })).toBeNull()
  })

  it('every new zh policy key has an en twin', () => {
    for (const key of POLICY_KEYS) {
      expect(zh[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
  })

  it('payload without the new fields still renders (old-payload tolerance)', async () => {
    const { view, props, controller } = await mountCard({ config: ENABLED_CONFIG })
    expect(controller.store.getSnapshot().subagentPolicy).toBeUndefined()
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.label'])).toBeTruthy()
    expect(screen.getByText(en['roles.list.label'])).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.unprovable'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.blocked'])).toBeNull()
  })

  it('pins the head-source label: authorized vs injected', async () => {
    const authorized = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: {
        state: 'enabled',
        allowedModels: [ALPHA],
        head: { route: ALPHA, source: 'authorized' },
      },
    })
    toggleCard()
    authorized.view.rerender(<FallbacksCard {...authorized.props} />)
    expect(screen.getByText(
      `${en['subagents.policy.head']}: policy-test/alpha (${en['subagents.policy.source.authorized']})`,
    )).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.source.injected'])).toBeNull()
    cleanup()

    const injected = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: {
        state: 'enabled',
        allowedModels: [ALPHA],
        head: { route: ALPHA, source: 'injected' },
      },
    })
    toggleCard()
    injected.view.rerender(<FallbacksCard {...injected.props} />)
    expect(screen.getByText(
      `${en['subagents.policy.head']}: policy-test/alpha (${en['subagents.policy.source.injected']})`,
    )).toBeTruthy()
    expect(screen.queryByText(`(${en['subagents.policy.source.authorized']})`)).toBeNull()
  })

  it('unprovable is its own state — not empty-intersection, not enabled', async () => {
    const { view, props, controller } = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: { state: 'unprovable' },
    })
    expect(controller.store.getSnapshot().subagentPolicy).toEqual({ state: 'unprovable' })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.policy.unprovable'])).toBeTruthy()
    expect(screen.getByText(en['subagents.policy.unprovable']).getAttribute('role')).toBe('alert')
    expect(screen.queryByText(en['subagents.policy.blocked'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.allowlist'], { exact: false })).toBeNull()
    expect(screen.queryByText('policy-test/alpha')).toBeNull()
  })

  it('a write that returns { state: disabled } clears a previously-enabled allowlist (keep-last cannot retain it)', async () => {
    const { view, props, controller, scripted } = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: ENABLED_POLICY,
    })
    expect(controller.store.getSnapshot().subagentPolicy?.state).toBe('enabled')
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.policy.label'])).toBeTruthy()

    scripted.set.mockImplementation((payload: { args: { patch: typeof defaultFallbacksConfig } }) => (
      Promise.resolve(okResult({
        config: payload.args.patch,
        subagentPolicy: { state: 'disabled' },
      }))
    ))
    await controller.save(ENABLED_CONFIG)
    view.rerender(<FallbacksCard {...props} />)
    expect(controller.store.getSnapshot().subagentPolicy).toEqual({ state: 'disabled' })
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.allowlist'], { exact: false })).toBeNull()
    expect(screen.queryByText('policy-test/alpha')).toBeNull()
  })

  it('enabled with no recorded head still shows the allowlist and omits the head line', async () => {
    const { view, props } = await mountCard({
      config: ENABLED_CONFIG,
      subagentPolicy: { state: 'enabled', allowedModels: [ALPHA] },
    })
    toggleCard()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(`${en['subagents.policy.allowlist']}: policy-test/alpha`)).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.head'], { exact: false })).toBeNull()
  })
})

