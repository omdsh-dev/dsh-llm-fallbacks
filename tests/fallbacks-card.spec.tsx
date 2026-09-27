// @vitest-environment jsdom
/**
 * Fallbacks settings card (plan fallbacks-plugin-config-card, task 1 + 2):
 * registration-surface spec + card-chrome contract spec.
 *
 * Registration surface (task 1): the fake slots runtime runs the inject
 * generator and records every register call, pinning the card contract: the
 * `plugins.bundle.config` slot ledger holds key 'dsh-llm-fallbacks' (bundle package name
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
 * is a multiline textarea and no chain editor offers the `provider/*`
 * wildcard (a wildcard read-back renders with a conversion hint and becomes
 * an exact entry once a model is picked). Plan fallbacks-card-section-ux
 * restores the per-section saves (one Discard + Save pair per section
 * heading, section-scoped dirty/patch/ride-along protection), makes the
 * 高级选项 section a collapsed-by-default disclosure with the read-only
 * forced-open contract (writable:false → advanced body visible, toggle
 * inert, aria-expanded "true"), turns the three section titles into h2
 * headings, and moves the numeric fields' default values into their
 * info-hint tooltips (zero defaultNote spans).
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
import { OFFICIAL_FLASH, OFFICIAL_PRO } from '../src/time-slots.ts'
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
 * The zh `t` seat (same synthesized-locale pattern as {@link t}) — the
 * locale-sensitive badge specs rerender the mounted card with it.
 */
const zhT: FallbacksCardProps['t'] = key => zh[key as keyof typeof zh]

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
    view: 'page',
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
  const call = vi.fn((channel: string, endpoint: string, payload: unknown) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'fallbacks/get') return get()
    if (endpoint === 'fallbacks/set') return set(payload as { args: { patch: typeof defaultFallbacksConfig } })
    if (endpoint === 'fallbacks/reset') return reset()
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    api: {
      settings: { describe },
      llm: { listConfigurableProviders: providers },
      session: { modelCatalog: models, follow: history },
    } as unknown as FallbacksRemote,
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
 * A base loaded config. The FLAT card renders every field unconditionally —
 * there is no config-level `enabled` gate to satisfy (plan
 * fallbacks-web-ux-alignment T2/T3), so the draft is clean (it seeds from
 * this same config) and the action-gate assertions hold.
 */
const BASE_CONFIG: typeof defaultFallbacksConfig = { ...defaultFallbacksConfig }

/**
 * A config with the `roleAutoMatch` key removed — the pre-fold legacy wire
 * shape (plan fallbacks-settings-visibility T3): a unit fixture can hand-build
 * it, but the REAL gateway composition always folds the schema default
 * `roleAutoMatch: true` into the wire (see tests/gateway.spec.ts), so the
 * card must render the toggle (default on) even for this shape and a save
 * persists the resolved value (AC-7 re-scope, PM decision 2026-08-17
 * Option A).
 */
const LEGACY_CONFIG: typeof defaultFallbacksConfig = withoutRoleAutoMatch({
  ...BASE_CONFIG,
  // Conforming all-day tail — the save test drives the whole-form gate (T3).
  rootChain: [OFFICIAL_FLASH],
})

/** Copy a config without the `roleAutoMatch` property. */
function withoutRoleAutoMatch(config: typeof defaultFallbacksConfig): typeof defaultFallbacksConfig {
  const copy: Record<string, unknown> = { ...config }
  delete copy.roleAutoMatch
  return copy as typeof defaultFallbacksConfig
}

/**
 * A two-block config (spec §8) exercising every new editing surface: a
 * CONFORMING all-day rootChain (official Flash head — the 默认模型 panel),
 * two declared role entities (one `inherit-root`, one
 * `fallback: none` — both with their own chains so the draft is save-valid
 * under the role model-config rule, plan fallbacks-feedback-round T2), and
 * role rules referencing a declared id and the built-in `inherit`. The
 * chain-less role save-block is exercised by dedicated tests below.
 */
const TWO_BLOCK_CONFIG: typeof defaultFallbacksConfig = {
  ...defaultFallbacksConfig,
  rootChain: [OFFICIAL_FLASH],
  roles: {
    list: [
      { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
      { id: 'architect', persona: 'Designs systems', chain: ['other/gpt-4o'], fallback: 'none' },
    ],
    // No `origin` on the rules — the editor rows never carry it (PR #62
    // feedback; origin is an accepted-and-ignored wire field), so the
    // fixture round-trips byte-identically and loads clean.
    rules: [
      { role: 'reviewer' },
      { role: 'inherit' },
    ],
  },
}

const VALID_CUSTOM_SLOT = {
  kind: 'custom' as const,
  start: '09:00',
  end: '10:00',
  days: [] as number[],
  chain: [OFFICIAL_FLASH],
}

/**
 * A legacy two-block config whose all-day `rootChain` has a NON-official
 * head (a multi-model chain from the pre-Task-3 era): the 默认模型 panel
 * reads back with no selection + the nonconforming notice, the chain
 * entries ride the 默认降级链 editor, and save validation blocks the value
 * until the user picks one of the two official models (Flash or Pro —
 * plan fallbacks-timeslots Task 3, no migration wizard).
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
  roles: { list: [{ id: 'coder', persona: '', chain: ['openai/*'], fallback: 'none' }], rules: [] },
}

/**
 * The FLAT card always renders its whole form — there is no collapsible
 * chrome (no header button, no chevron, no unsaved pill, no card-local open
 * state). Per-section saves (plan fallbacks-card-section-ux): each section
 * heading carries its own Discard + Save pair (高级选项's pair lives inside
 * its expanded body), so the action helpers below are SECTION-SCOPED and
 * anchor on the section ids.
 */
type CardSection = 'main' | 'sub' | 'advanced'

/**
 * The container holding a section's action pair: the 主代理 / 子代理 h2
 * headings, or the expanded 高级选项 body (collapsed → the pair is
 * unmounted; call {@link expandAdvanced} first).
 */
function sectionContainer(section: CardSection): HTMLElement {
  if (section === 'advanced') {
    const body = document.getElementById('fallbacks-advanced-body')
    if (body === null) throw new Error('advanced body is collapsed; call expandAdvanced() first')
    return body
  }
  const heading = document.getElementById(section === 'main' ? 'fallbacks-main-agent' : 'fallbacks-subagents')
  if (heading === null) throw new Error(`missing section heading for ${section}`)
  return heading
}

/** The section's Save button (writes ONLY that section's fields — T2). */
function saveButton(section: CardSection): HTMLButtonElement {
  return within(sectionContainer(section)).getByRole('button', { name: en.save }) as HTMLButtonElement
}

/** The section's Discard button (reverts ONLY that section's editors). */
function discardButton(section: CardSection): HTMLButtonElement {
  return within(sectionContainer(section)).getByRole('button', { name: en.discard }) as HTMLButtonElement
}

/**
 * Expand the collapsed-by-default 高级选项 section (plan
 * fallbacks-card-section-ux T3) so its fields and action pair mount.
 */
function expandAdvanced(): void {
  fireEvent.click(within(advancedHeading()).getByRole('button', { name: en['advanced.expand'] }))
}

/** Collapse the expanded 高级选项 section back. */
function collapseAdvanced(): void {
  fireEvent.click(within(advancedHeading()).getByRole('button', { name: en['advanced.collapse'] }))
}

/** The 子代理 section heading (id anchor — validation alerts render under it). */
function subagentsHeading(): HTMLElement {
  return document.getElementById('fallbacks-subagents') as HTMLElement
}

/** The 高级选项 section heading (id anchor — hosts the disclosure toggle). */
function advancedHeading(): HTMLElement {
  return document.getElementById('fallbacks-advanced') as HTMLElement
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

/** Pick the official Flash radio in the all-day chooser (Task 3). */
function pickAllDayFlash(): void {
  fireEvent.click(flashRadio())
}

/** Pick the official Pro radio in the all-day chooser (0.1.7-rc.1 catalog). */
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
      get llm() { return services['remote.llm'] },
      get settings() { return services['remote.settings'] },
      get session() { return services['remote.session'] },
    },
  }
  return { ctx, ledger, locales }
}

describe('FallbacksCard registration (plugins.bundle.config)', () => {
  it('registers the fallbacks card and leaves no fallbacks entry in settings.section', () => {
    const { ctx, ledger, locales } = fakeRuntime()
    apply(ctx as unknown as Parameters<typeof apply>[0])

    // The card ledger holds exactly one fallbacks card.
    const cards = ledger['plugins.bundle.config'] ?? []
    expect(cards).toHaveLength(1)
    // rc.7 keyed slot: `key` is the settings namespace the card edits; the
    // list-slot `id` rides along so pre-rc.7 hosts (which declare the slot
    // as a list and require options.id) can mount the card — the keyed
    // loader ignores the extra id.
    expect(cards[0].options.key).toBe('dsh-llm-fallbacks')
    expect(cards[0].options.id).toBeUndefined()
    expect(cards[0].options).not.toHaveProperty('order')
    expect(cards[0].options.locale).toBe('fallbacks')
    // No nav-label thunk survives from the removed section registration.
    expect(cards[0].options).not.toHaveProperty('label')
    expect(cards[0].component).toBe(FallbacksCard)

    // Inject face carries the business surface only — the typed `t` seat is
    // synthesized by the renderer from `locale:`, never injected.
    const face = (cards[0].options.inject as () => Record<string, unknown>)()
    expect(face.controller).toBeInstanceOf(FallbacksSettingsController)
    expect(face.hooks?.snapshot).toBeDefined()
    expect(face).not.toHaveProperty('useSnapshot')
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

describe('FallbacksCard section saves (plan fallbacks-card-section-ux)', () => {
  it('renders the flat always-open card: h2 section headings, one action pair per section, advanced collapsed', async () => {
    await mountCard()
    // No collapsible chrome: no <li> box, no header disclosure button, no
    // unsaved pill — the host page renders the plugin title/description
    // above the card (the locale meta files).
    expect(document.querySelectorAll('li')).toHaveLength(0)
    expect(screen.queryByText('Unsaved')).toBeNull()
    expect(screen.queryByText('未保存')).toBeNull()
    // No enabled row and no enabled.off hiding: the switch is gone, and the
    // 主代理 / 子代理 / 高级选项 titles are semantic h2 headings (T1)
    // carrying the aria-wiring ids.
    expect(screen.queryByLabelText('Enable failure fallback')).toBeNull()
    expect(Array.from(document.querySelectorAll('h2')).map(heading => heading.id))
      .toEqual(['fallbacks-main-agent', 'fallbacks-subagents', 'fallbacks-advanced'])
    // T3: 高级选项 is collapsed by default — its fields are unmounted and
    // the h2 hosts the disclosure toggle with the collapsed a11y state.
    expect(screen.queryByLabelText(en['cooldownMs.label'])).toBeNull()
    const toggle = within(advancedHeading()).getByRole('button', { name: en['advanced.expand'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.hasAttribute('aria-controls')).toBe(false)
    // T2: one Discard + Save pair PER SECTION, all disabled on a clean
    // draft (KD-U1: save = !sectionDirty || saving || !writable; discard =
    // !sectionDirty || saving). The advanced pair lives inside the collapsed
    // body — expand to reach the full three.
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(2)
    expandAdvanced()
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(3)
    expect(saveButton('main').disabled).toBe(true)
    expect(discardButton('main').disabled).toBe(true)
    expect(saveButton('sub').disabled).toBe(true)
    expect(discardButton('sub').disabled).toBe(true)
    expect(saveButton('advanced').disabled).toBe(true)
    expect(discardButton('advanced').disabled).toBe(true)
    // The Reset affordance never exists on the card (PR #62 UX round 3).
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull()
  })

  it('expands the collapsed advanced section: fields mount, aria-expanded flips, collapse unmounts (T3)', async () => {
    await mountCard()
    expandAdvanced()
    // The body mounts with the id the toggle now controls; the fields and
    // the section's own action pair become reachable.
    const toggle = within(advancedHeading()).getByRole('button', { name: en['advanced.collapse'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe('fallbacks-advanced-body')
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy()
    expect(saveButton('advanced')).toBeTruthy()
    // Collapsing unmounts the body again (aria-controls is conditional —
    // the F-006 contract).
    collapseAdvanced()
    expect(screen.queryByLabelText(en['cooldownMs.label'])).toBeNull()
  })

  it('carries the field defaults in the info-hint tooltips with no standalone default notes (T4)', async () => {
    await mountCard()
    expandAdvanced()
    // The three numeric fields' defaults ride the info hint (role="img" +
    // aria-label, the data-tip twin) as the final sentence composed from
    // `defaults.prefix` — the label row carries no default note any more
    // (zero defaultNote spans; the 冷却时长（毫秒） row no longer wraps).
    expect(document.querySelectorAll('.defaultNote')).toHaveLength(0)
    expect(screen.getByRole('img', { name: `${en['cooldownMs.tooltip']} ${en['defaults.prefix']}: 300000` })).toBeTruthy()
    expect(screen.getByRole('img', { name: `${en['maxSwitchesPerStep.tooltip']} ${en['defaults.prefix']}: 8` })).toBeTruthy()
    expect(screen.getByRole('img', { name: `${en['alwaysModeRetryCap.tooltip']} ${en['defaults.prefix']}: 5` })).toBeTruthy()
  })

  it('keeps dirty tracking section-scoped: an advanced edit arms only the advanced pair', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('advanced').disabled).toBe(false)
    expect(discardButton('advanced').disabled).toBe(false)
    // Editing 高级选项 never enables 主代理's or 子代理's Save.
    expect(saveButton('main').disabled).toBe(true)
    expect(discardButton('main').disabled).toBe(true)
    expect(saveButton('sub').disabled).toBe(true)
    expect(discardButton('sub').disabled).toBe(true)
  })

  it('keeps dirty tracking section-scoped: a 主代理 edit arms only the main pair', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    addCustomSlot()
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('main').disabled).toBe(false)
    expect(discardButton('main').disabled).toBe(false)
    expandAdvanced()
    expect(saveButton('advanced').disabled).toBe(true)
    expect(discardButton('advanced').disabled).toBe(true)
    expect(saveButton('sub').disabled).toBe(true)
    expect(discardButton('sub').disabled).toBe(true)
  })

  it('a section Discard reverts only that section (per-section revert)', async () => {
    const { view, props } = await mountCard({ config: BASE_CONFIG })
    // An advanced edit + a 主代理 edit stage together.
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    addCustomSlot()
    view.rerender(<FallbacksCard {...props} />)
    // The advanced Discard reverts the cooldown only; the 主代理 edit stays
    // staged (its Save stays armed, the custom row still mounted).
    fireEvent.click(discardButton('advanced'))
    view.rerender(<FallbacksCard {...props} />)
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).value).toBe(
      String(defaultFallbacksConfig.cooldownMs),
    )
    expect(saveButton('advanced').disabled).toBe(true)
    expect(saveButton('main').disabled).toBe(false)
    expect(screen.queryByLabelText(en['timeSlots.tz.label'])).not.toBeNull()
    // The 主代理 Discard reverts the slot row: the staged edit is gone and
    // the gate relocks.
    fireEvent.click(discardButton('main'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.queryByLabelText(en['timeSlots.tz.label'])).toBeNull()
    expect(saveButton('main').disabled).toBe(true)
    expect(discardButton('main').disabled).toBe(true)
  })

  it('a section Save sends only its own fields — sibling edits never ride along (T2)', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    // Stage BOTH an advanced edit and a 主代理 edit (a valid one: the
    // all-day pick — an empty-chain slot row would block the main save on
    // its own violation instead).
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    pickAllDayPro()
    view.rerender(<FallbacksCard {...props} />)
    // The advanced Save writes the last ACCEPTED 主代理 fields (the staged
    // Pro pick never rides) with only the cooldown replaced — the
    // ride-along protection (PR #62 UX round 3).
    fireEvent.click(saveButton('advanced'))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({
          cooldownMs: 5000,
          timeSlots: [],
          rootChain: TWO_BLOCK_CONFIG.rootChain,
          roles: TWO_BLOCK_CONFIG.roles,
        }) },
      }))
    })
    // The 主代理 edit stays staged (only its own section's Save persists
    // it), then the main Save writes the staged pick.
    expect(saveButton('main').disabled).toBe(false)
    fireEvent.click(saveButton('main'))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({ rootChain: [OFFICIAL_PRO] }) },
      }))
    })
  })

  it('keeps the advanced-disclosure keys in both zh and en dictionaries', () => {
    // Bilingual-pair constraint (plan Global Constraints): the restored
    // disclosure labels exist in BOTH dictionaries, non-empty.
    expect(zh['advanced.expand']).toBeTruthy()
    expect(en['advanced.expand']).toBeTruthy()
    expect(zh['advanced.collapse']).toBeTruthy()
    expect(en['advanced.collapse']).toBeTruthy()
  })

  it('a failed section save surfaces the store error under THAT section (lastSaveSection)', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '5000' } })
    view.rerender(<FallbacksCard {...props} />)
    // The gateway rejects the write: the error renders inside the advanced
    // body — the section whose Save was clicked — not as the card-top
    // load-failure notice, and no Retry button (the form itself is the
    // retry surface when writable).
    scripted.set.mockResolvedValueOnce(failResult('rejected by gateway'))
    fireEvent.click(saveButton('advanced'))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('error'))
    view.rerender(<FallbacksCard {...props} />)
    const body = document.getElementById('fallbacks-advanced-body')
    expect(Array.from(body!.querySelectorAll('[role="alert"]')).some(alert => alert.textContent === en['error.generic'])).toBe(true)
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
    // The form stays editable; a follow-up save succeeds (the mock default
    // folded the write): the accepted config re-seeds the section → clean
    // again, gates relocked.
    expect(saveButton('advanced').disabled).toBe(false)
    fireEvent.click(saveButton('advanced'))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('advanced').disabled).toBe(true)
  })

  it('renders the unavailable notice flat with the usable skeleton (KD-G5, AC-1 divergence)', async () => {
    // Gateway channel unreachable: get fails, describe succeeds → the card
    // shows the unavailable notice ALWAYS (no interaction), the form stays
    // usable (writable), and there is no open/close surface to hide it.
    const { props, controller } = await mountCard({ config: null })
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expandAdvanced()
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy() // skeleton still rendered
    // The notice holds through a background refresh window (the card-local
    // degraded latch; the store stays untouched).
    const reload = controller.load() // do not await yet
    expect(controller.store.getSnapshot().status).toBe('loading')
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    await reload
  })

  it('keeps the error notice + Retry (inert form) through the Retry→loading window (qc2 S-1)', async () => {
    // An initial-load failure (describe fails) lands the hard `error` state:
    // the flat error notice + Retry (the load never landed → the form is
    // inert), no open/close surface to lose the notice behind. Clicking
    // Retry flips status to 'loading'; the notice reappears when the reload
    // fails again.
    const scripted = scriptedApi({})
    scripted.describe.mockResolvedValue({ result: { ok: false, error: { code: 'internal', message: 'describe exploded', details: {} } } })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)

    // Flat error notice + Retry, inert form. The whole-form validation
    // alerts render always-on in the flat card (the defaulted config carries
    // a live all-day-required violation), so target the STORE error by copy.
    expect(screen.getAllByRole('alert').some(alert => alert.textContent === en['error.generic'])).toBe(true) // the test `t` does not interpolate
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).disabled).toBe(true)

    // Retry → the S-1 loading window: the body still renders (the flat form
    // is always mounted).
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(controller.store.getSnapshot().status).toBe('loading')

    // The reload fails again → the error notice + Retry reappear.
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('error'))
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getAllByRole('alert').some(alert => alert.textContent === en['error.generic'])).toBe(true)
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it('clears the error notice on a successful reload', async () => {
    const scripted = scriptedApi({})
    scripted.describe.mockResolvedValueOnce({ result: { ok: false, error: { code: 'internal', message: 'describe exploded', details: {} } } })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)
    expect(screen.getAllByRole('alert').some(alert => alert.textContent === en['error.generic'])).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<FallbacksCard {...props} />)
    // The STORE error is gone; the always-on whole-form validation alert of
    // the defaulted config may remain (that is not the store error).
    expect(screen.queryAllByRole('alert').some(alert => alert.textContent === en['error.generic'])).toBe(false)
    // The recovered card is writable → the advanced section collapsed back;
    // expand to reach the (now enabled) fields.
    expandAdvanced()
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).disabled).toBe(false)
  })

  it('shows the read-only notice only once a settled describe reports read-only', async () => {
    const { view, props } = await mountCard({ config: BASE_CONFIG, writable: false })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    // The form is inert in a read-only environment (the fieldset[disabled]
    // propagates; the section Saves share the !writable term — KD-U1).
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).disabled).toBe(true)
    expect(saveButton('main').disabled).toBe(true)
    // Discard stays available: a pure client-side revert must not strand
    // staged edits in a read-only environment (KD-U1 has no !writable
    // term) — a clean draft merely keeps it gated on !sectionDirty.
    expect(discardButton('main').disabled).toBe(true)
  })
})

describe('FallbacksCard two-block editing surface (plan fallbacks-role-config-model T3)', () => {
  it('renders the default-chain selector list + the separate default-model Flash | Pro panel', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
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
    // nonconforming notice shows. Both tails are selectable — 0.1.7-rc.1's
    // catalog serves Pro as deepseek-v4-pro.
    expect(screen.getByText(en['defaultModel.label'])).toBeTruthy()
    const modelGroup = screen.getByText(en['defaultModel.label']).closest('[role="group"]') as HTMLElement
    // Panel-scoped count: exactly two all-day radios (a third official
    // option would fail this), independent of any radio elsewhere in the card.
    expect(within(modelGroup).getAllByRole('radio')).toHaveLength(2)
    const flash = flashRadio()
    const pro = proRadio()
    expect(flash.type).toBe('radio')
    expect(pro.type).toBe('radio')
    expect(flash.checked).toBe(true)
    expect(pro.checked).toBe(false)
    expect(flash.disabled).toBe(false)
    expect(pro.disabled).toBe(false)
    expect(within(modelGroup).queryByText(en['allDay.nonconforming'])).toBeNull()
  })

  it('reads back a legacy non-official-head chain: chain entries + unselected default model + the notice (no migration wizard)', async () => {
    const { view, props } = await mountCard({ config: LEGACY_ALL_DAY_CONFIG })
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

  it('reads back a retired V4 tail as non-conforming: unselected panel + the notice', async () => {
    const { view, props } = await mountCard({ config: { ...TWO_BLOCK_CONFIG, rootChain: ['deepseek-official/deepseek-v4-flash'] } })
    view.rerender(<FallbacksCard {...props} />)
    // The V4 id is no longer a legal tail → the 默认模型 panel reads back
    // unselected and the nonconforming notice shows (save stays blocked).
    const modelGroup = screen.getByText(en['defaultModel.label']).closest('[role="group"]') as HTMLElement
    expect(within(modelGroup).getAllByRole('radio')).toHaveLength(2)
    const flash = flashRadio()
    const pro = proRadio()
    expect(flash.checked).toBe(false)
    expect(pro.checked).toBe(false)
    expect(within(modelGroup).getByText(en['allDay.nonconforming'])).toBeTruthy()
  })

  it('reads back a Pro all-day tail as the selected default model — catalog-served as deepseek-v4-pro', async () => {
    const { view, props } = await mountCard({ config: { ...TWO_BLOCK_CONFIG, rootChain: [OFFICIAL_PRO] } })
    view.rerender(<FallbacksCard {...props} />)
    // The Pro tail is consumed by the 默认模型 panel → the chain editor
    // starts with no trailing selectors and the Pro radio is pre-selected
    // (and selectable — the id is catalog-served); no nonconforming notice
    // shows.
    const chainGroup = screen.getByText(en['rootChain.label']).closest('[role="group"]') as HTMLElement
    expect(within(chainGroup).queryByLabelText(en['roles.rule.provider'])).toBeNull()
    const modelGroup = screen.getByText(en['defaultModel.label']).closest('[role="group"]') as HTMLElement
    expect(within(modelGroup).getAllByRole('radio')).toHaveLength(2)
    const flash = flashRadio()
    const pro = proRadio()
    expect(flash.checked).toBe(false)
    expect(pro.checked).toBe(true)
    expect(pro.disabled).toBe(false)
    expect(within(modelGroup).queryByText(en['allDay.nonconforming'])).toBeNull()
  })

  it('offers the official Pro tail as a selectable default model (0.1.7-rc.1 catalog)', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    // Both official tails are selectable: picking Pro selects it and the
    // Flash radio clears (XOR head).
    const flash = flashRadio()
    const pro = proRadio()
    expect(flash.checked).toBe(true)
    expect(pro.checked).toBe(false)
    pickAllDayPro()
    view.rerender(<FallbacksCard {...props} />)
    expect(pro.checked).toBe(true)
    expect(flash.checked).toBe(false)
  })

  it('renders the chain/role sections before the advanced options and offers no provider wildcard in any chain editor', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    // Section order (PR #62 feedback round): 主代理 heading → 分时槽设置
    // (extra rows — plan fallbacks-timeslots Task 3) → 默认降级链 → 默认模型
    // → 子代理 heading → role entities → role rules → advanced options
    // (trigger codes / cooldown / switch caps) at the end. The advanced
    // group starts collapsed (plan fallbacks-card-section-ux T3) — expand
    // it so its fields' groups are mounted for the ordering walk. The
    // headings are static section labels (not role=group); their position
    // pins the grouping.
    expandAdvanced()
    const groups = [
      screen.getByText(en['timeSlots.label']).closest('[role="group"]')!,
      screen.getByText(en['rootChain.label']).closest('[role="group"]')!,
      screen.getByText(en['defaultModel.label']).closest('[role="group"]')!,
      screen.getByText(en['roles.list.label']).closest('[role="group"]')!,
      screen.getByText(en['roles.rules']).closest('[role="group"]')!,
      // The advanced section is NOT one group: its fields keep their own
      // groups — the last group in order is the trigger codes.
      screen.getByText(en['triggerCodes.label']).closest('[role="group"]')!,
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

  it('collapses the advanced options by default and discloses them via the heading toggle (T3)', async () => {
    await mountCard({ config: BASE_CONFIG })
    // The advanced body is UNMOUNTED while collapsed — the fields are
    // reachable only through the h2-hosted disclosure toggle.
    expect(screen.getByText(en['advanced.label'])).toBeTruthy()
    expect(screen.queryByLabelText(en['cooldownMs.label'])).toBeNull()
    expandAdvanced()
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy()
    collapseAdvanced()
    expect(screen.queryByLabelText(en['cooldownMs.label'])).toBeNull()
  })

  it('keeps the advanced options visible and inert in a read-only view (F-002 successor)', async () => {
    await mountCard({ config: BASE_CONFIG, writable: false })
    // Read-only FORCES the advanced section open (the toggle is inert there
    // — without the forced-open term the fields would be unreachable) and
    // the whole fieldset is inert (disabled propagation).
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByLabelText(en['cooldownMs.label'])).toBeTruthy()
    expect((screen.getByLabelText(en['cooldownMs.label']) as HTMLInputElement).disabled).toBe(true)
    // The forced-open toggle reports the expanded state while disabled.
    const toggle = within(advancedHeading()).getByRole('button', { name: en['advanced.collapse'] })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('rejects a legacy wildcard all-day chain: chain editor keeps the entry, save blocked until a default model is picked', async () => {
    // PR #62 feedback round: the all-day chain is a selector list again —
    // a legacy `provider/*` rootChain reads back INTO the 默认降级链 editor
    // (wildcard entry + conversion hint) while the 默认模型 panel shows no
    // selection + the notice. The save stays blocked
    // (validation.allDayRequired) until the user picks one of the two
    // official models (Flash or Pro); the pick composes
    // rootChain = [...chain entries, default model].
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: ['openai/*'],
      timeSlots: [VALID_CUSTOM_SLOT],
    }
    const { view, props, controller, scripted } = await mountCard({ config, catalog: CHAIN_CATALOG })
    await controller.loadCatalog()
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
    fireEvent.click(saveButton('main'))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.allDayRequired'])
    // Picking Flash makes the draft valid → the 主代理 save patch composes
    // the legacy chain entry + the tail (tail-conforming).
    pickAllDayFlash()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('main'))
    await waitFor(() => {
      expect(scripted.call).toHaveBeenCalledWith('/api', 'fallbacks/set', expect.objectContaining({
        args: { patch: expect.objectContaining({ rootChain: ['openai/*', OFFICIAL_FLASH] }) },
      }))
    })
  })

  it('reads back a role wildcard chain entry with the conversion hint and converts it to an exact entry on save (T1)', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: WILDCARD_ROLE_CONFIG, catalog: CHAIN_CATALOG })
    // Settle the catalog explicitly so the model select is enabled before
    // the interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
    // An unsaved 默认模型 pick (Flash) stages a 主代理 edit BESIDE the 子代理
    // edit below — the per-section save model (plan fallbacks-card-section-ux)
    // keeps them apart: the 子代理 Save writes ONLY the roles section, with
    // rootChain carried from the last ACCEPTED config (the staged Flash pick
    // never rides along).
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
    // Picking a concrete model converts the wildcard row → the 子代理 save
    // patch carries the exact entry, never a `provider/*` line — and the
    // accepted rootChain (no default tail) rides instead of the staged pick.
    fireEvent.change(model, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
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
      rootChain: [OFFICIAL_FLASH],
      roles: {
        list: [
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'empty', persona: '', chain: [], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props } = await mountCard({ config })
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
    fireEvent.click(saveButton('sub'))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.ruleRoleUndeclared'])
  })

  it('blocks save on an empty rule row with a hint instead of silently dropping it (qc3 F-4)', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
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
    // blocks the 子代理 write (the row is invisible to validateDraft, so
    // the empty-row check rides the save path) while the inline hint IS
    // the live violation surface.
    fireEvent.click(saveButton('sub'))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    expect(screen.getAllByText(en['validation.ruleRoleRequired'])).toHaveLength(1)

    // Picking a role makes the draft valid again → the 子代理 save passes.
    const selectsAfterBlock = screen.getAllByLabelText(en['roles.rule.role'])
    const last = selectsAfterBlock[selectsAfterBlock.length - 1] as HTMLSelectElement
    fireEvent.change(last, { target: { value: 'reviewer' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
  })

  it('blocks save on an invalid role id: banner + inline red, no gateway write', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'Bad ID' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // Reserved word.
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'inherit' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(en['validation.roleIdReserved'])
    // Duplicates (after fixing the reserved id to a legal one).
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'coder' } })
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[1]!, { target: { value: 'coder' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
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
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['allDay.nonconforming'])).toBeTruthy()
    // A 主代理 edit (timezone) dirties the main section so the save attempt
    // fires (per-section dirty).
    addCustomSlot()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('main'))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.allDayRequired'])
  })

  it('clears the blocked-save state once the draft is valid again, then saves', async () => {
    const { view, props, scripted } = await mountCard({ config: TWO_BLOCK_CONFIG })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(screen.getAllByLabelText(en['roles.id'])[0]!, { target: { value: 'Bad ID' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
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
    fireEvent.click(saveButton('sub'))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
  })

  it('preserves schema-reserved prompt/permissions through a save (rows do not round-trip them)', async () => {
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      // A conforming all-day tail so the accepted config is save-valid; the
      // per-section save model (plan fallbacks-card-section-ux) keeps the
      // untouched sections riding the last accepted config.
      rootChain: [OFFICIAL_FLASH],
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
    view.rerender(<FallbacksCard {...props} />)
    // The card starts CLEAN: the merged draft equals the accepted config
    // (the action gates locked), proving the merge participates in dirty.
    expandAdvanced()
    expect(discardButton('advanced').disabled).toBe(true)
    // An advanced edit dirties the advanced section; the advanced Save
    // writes its own fields with the accepted roles (and their
    // schema-reserved extras) riding through untouched.
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('advanced'))
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
      config: { ...defaultFallbacksConfig, rootChain: [OFFICIAL_FLASH] },
      legacyKeys: ['chains', 'roles.default'],
    })
    view.rerender(<FallbacksCard {...props} />)
    expect(controller.store.getSnapshot().legacyKeys).toEqual(['chains', 'roles.default'])
    expect(screen.getByText(en['legacy.banner'])).toBeTruthy()
    // The banner never blocks editing: the form stays writable and a save
    // still crosses the wire (informational only, spec §8) — here the
    // advanced section's own Save.
    expandAdvanced()
    expect(saveButton('advanced').disabled).toBe(true) // clean draft
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('advanced'))
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
    fireEvent.click(saveButton('sub'))
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
    fireEvent.click(saveButton('sub'))
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
    fireEvent.click(saveButton('sub'))
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
    fireEvent.click(saveButton('sub'))
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
  const SLOT_CONFIG: typeof defaultFallbacksConfig = { ...BASE_CONFIG, rootChain: [OFFICIAL_FLASH] }

  /** The time-slots group element (the extra-row list ABOVE the all-day row). */
  function slotsGroup(): HTMLElement {
    return screen.getByText(en['timeSlots.label']).closest('[role="group"]') as HTMLElement
  }

  it('adds a preset row through the picker: frozen window summary, models-only editor', async () => {
    const { view, props, controller, scripted } = await mountCard({ config: SLOT_CONFIG, catalog: CHAIN_CATALOG })
    // Settle the catalog so the chain editor offers openai/gpt-4o before the
    // interaction (the mount-effect load is asynchronous).
    await controller.loadCatalog()
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
    fireEvent.click(saveButton('main'))
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
    fireEvent.click(saveButton('main'))
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
    fireEvent.click(saveButton('main'))
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
    fireEvent.click(saveButton('main'))
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
    fireEvent.click(saveButton('main'))
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
    fireEvent.click(saveButton('main'))
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
        { kind: 'preset', preset: 'glm-valley', days: [], chain: [OFFICIAL_FLASH] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [5], chain: ['openai/gpt-4o'] },
      ],
    }
    const { view, props } = await mountCard({ config })
    view.rerender(<FallbacksCard {...props} />)
    // The accepted rows round-trip through the editor: no spurious dirty
    // state (dirty-check invariant — the action gates locked).
    expect(discardButton('main').disabled).toBe(true)
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
    fireEvent.click(saveButton('main'))
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
    fireEvent.click(saveButton('main'))
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
    // A staged 高级选项 edit (the section expanded first) sits beside the
    // 主代理 violation — per-section saves keep it out of the main write.
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('main'))
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
    view.rerender(<FallbacksCard {...props} />)
    // Slot rows default collapsed — expand so the frozen-name cell (the
    // second label occurrence) is mounted.
    expandAllSlots()
    view.rerender(<FallbacksCard {...props} />)
    // The row loads clean (days round-trips through the editor — the
    // dirty-check invariant holds; the action gates locked).
    expect(discardButton('main').disabled).toBe(true)
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
    fireEvent.click(saveButton('main'))
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
    // Conforming all-day tail — the section saves gate on their own bucket
    // validateDraft (T3).
    rootChain: [OFFICIAL_FLASH],
    roles: {
      list: [
        { id: 'architect', persona: 'Designs systems', chain: [], fallback: 'inherit-root' },
        { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
      ],
      rules: [],
    },
  }

  it('badges every row with its source: bundled / set name / User — none under version skew', async () => {
    // The provenance badge rides every collapse title (plan
    // role-card-seeded-ux): a live seed shows its declaring producer's
    // label — `bundled` resolves to its localized label, an unnamed
    // producer's `external` localizes too (plan
    // seeds-source-and-persona-width), a named set renders VERBATIM
    // (case-preserved) — and a row no live declaration covers is the
    // operator's own (`User`).
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [
          { id: 'architect', persona: 'Designs systems', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'writer', persona: 'Writes copy', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'scout', persona: 'Explores', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const first = await mountCard({
      config,
      seeds: [
        { id: 'architect', overridden: false, source: 'bundled' },
        { id: 'reviewer', overridden: false, source: 'Prod presets' },
        { id: 'writer', overridden: false, source: 'external' },
      ],
    })
    // The badge lives on the collapse title row — visible without expanding.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    within(rolesGroup).getByText(en['roles.seedSource.bundled'])
    within(rolesGroup).getByText('Prod presets')
    within(rolesGroup).getByText(en['roles.seedSource.external'])
    within(rolesGroup).getByText(en['roles.seedSource.user'])
    first.view.unmount()

    // Version skew (a pre-`source` gateway): the seeded entry parses but
    // carries no label — that row renders NO badge (the degradation path,
    // never an error); the uncovered rows still read `User`.
    const second = await mountCard({ config, seeds: [{ id: 'architect', overridden: false }] })
    const secondGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(secondGroup).queryByText(en['roles.seedSource.bundled'])).toBeNull()
    expect(within(secondGroup).getAllByText(en['roles.seedSource.user'])).toHaveLength(3)
    second.view.unmount()

    // A blank or whitespace-only wire `source` degrades exactly like an
    // absent one (plan Global Constraint 3, T2's guard fix): the store
    // boundary drops the field as malformed, so the card renders NO badge —
    // never a textless pill with an empty tooltip — and the mount does not
    // crash. The badge span is the card's only `title=` carrier, so the
    // empty/whitespace title queries pin the textless-pill regression.
    const third = await mountCard({
      config,
      seeds: [
        { id: 'architect', overridden: false, source: '' },
        { id: 'reviewer', overridden: false, source: '   ' },
      ],
    })
    const thirdGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(thirdGroup).queryByText(en['roles.seedSource.bundled'])).toBeNull()
    expect(within(thirdGroup).queryByText('Prod presets')).toBeNull()
    expect(within(thirdGroup).queryAllByTitle('')).toHaveLength(0)
    expect(within(thirdGroup).queryAllByTitle('   ')).toHaveLength(0)
    // Only the uncovered rows (writer, scout) badge — with the localized
    // User label, per the normal derivation.
    expect(within(thirdGroup).getAllByText(en['roles.seedSource.user'])).toHaveLength(2)
    third.view.unmount()
  })

  it('badges the unnamed external producer with the localized label in both locales — never the raw token', async () => {
    // plan seeds-source-and-persona-width Task 2: `external` is a FIXED
    // label (the shared unnamed-producer slice), so it localizes like
    // `bundled` / `User`; only registered set names render verbatim. The
    // en label coincides with the raw token, so the zh render is the
    // discriminating half (the en half pins the vocabulary contract).
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [
          { id: 'architect', persona: 'Designs systems', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props } = await mountCard({
      config,
      seeds: [{ id: 'architect', overridden: false, source: 'external' }],
    })
    const enGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(enGroup).getByText('external')).toBeTruthy()
    // zh seat: the badge reads 外部 and the raw English token never
    // renders. (The literal matches zh['roles.seedSource.external'] — the
    // dictionary parity spec pins the key's value.)
    view.rerender(<FallbacksCard {...{ ...props, t: zhT }} />)
    const zhGroup = screen.getByText(zh['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(zhGroup).getByText('外部')).toBeTruthy()
    expect(within(zhGroup).queryByText('external')).toBeNull()
  })

  it('renders a registered set name badge verbatim (case-preserved) while external localizes', async () => {
    // plan seeds-source-and-persona-width Task 2: the verbatim contract is
    // UNCHANGED for registered set names — a companion named `mstar` badges
    // as `mstar`, never folded to a locale key; only the reserved labels
    // (bundled / external / user) localize.
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [
          { id: 'architect', persona: 'Designs systems', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props } = await mountCard({
      config,
      seeds: [
        { id: 'architect', overridden: false, source: 'mstar' },
        { id: 'reviewer', overridden: false, source: 'external' },
      ],
    })
    view.rerender(<FallbacksCard {...props} />)
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    expect(within(rolesGroup).getByText('mstar')).toBeTruthy()
    expect(within(rolesGroup).getByText(en['roles.seedSource.external'])).toBeTruthy()
  })

  it('presents a seeded row read-only: no revert button, no persona editor, brief + expand instead', async () => {
    // The card no longer offers the seed-persona revert (plan clarify
    // 2026-09-09: seeded rows lose the card revert button) and the persona
    // is reference material: a read-only single-line brief — no textarea —
    // so no persona RPC can fire from the row.
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false, source: 'bundled' }],
    })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // The old revert affordance is gone (the literal it used to carry).
    expect(screen.queryByRole('button', { name: 'Revert to seed default' })).toBeNull()
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    // Only the non-seeded sibling keeps a persona textarea; the seeded
    // persona surfaces as the brief text instead.
    expect(within(rolesGroup).queryAllByLabelText(en['roles.persona'])).toHaveLength(1)
    expect(within(rolesGroup).getAllByText('Designs systems')).toHaveLength(1)
    // The brief's chevron discloses the full persona text (client-local
    // state — no write rides it).
    const expandPersona = within(rolesGroup).getByRole('button', { name: en['roles.persona.expand'] })
    // The iconButton contract: the label rides `data-tip` too — no empty
    // tooltip pill on hover/focus (the only iconButton without one, wave-1 fix).
    expect(expandPersona.getAttribute('data-tip')).toBe(en['roles.persona.expand'])
    expect(expandPersona.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expandPersona)
    view.rerender(<FallbacksCard {...props} />)
    const collapsePersona = within(rolesGroup).getByRole('button', { name: en['roles.persona.collapse'] })
    expect(collapsePersona.getAttribute('data-tip')).toBe(en['roles.persona.collapse'])
    expect(collapsePersona.getAttribute('aria-expanded')).toBe('true')
    expect(within(rolesGroup).getAllByText('Designs systems')).toHaveLength(2)
    fireEvent.click(collapsePersona)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(rolesGroup).getAllByText('Designs systems')).toHaveLength(1)
    // No revert RPC can fire from the row (the store's revertSeed write
    // path is removed with the button — the card has no revert caller).
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/revert-seed', expect.anything())
  })

  it('saves a seeded role whose chain is empty (AC-3 card path)', async () => {
    // A seeded role with a legitimately empty chain (R4) must stay
    // persistable: the Save gate relaxes for seeded ids only (spec §9.6) so
    // a section save never blocks on the seeded row. The persona is
    // read-only now, so the SUB dirty trigger is the operator-owned
    // sibling: the reviewer persona edit rides the seeded (empty-chain)
    // architect row through the same save.
    const { view, props, scripted } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false, source: 'bundled' }],
    })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // The seeded row shows the non-blocking chain hint instead of the
    // blocking one.
    expect(screen.getByText(en['roles.seedChainOptional'])).toBeTruthy()
    expect(screen.queryByText(en['validation.roleChainRequired'])).toBeNull()
    // The sibling persona edit dirties the SUB section so its Save is
    // enabled (no 主代理 all-day pick needed — per-section validation), then
    // Save passes validation (the seeded relax) and writes.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    fireEvent.change(within(rolesGroup).getByLabelText(en['roles.persona']), { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
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
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // architect is seeded → the seeded (non-blocking) hint; reviewer is NOT
    // seeded → the blocking chain-required hint stays.
    expect(screen.getByText(en['roles.seedChainOptional'])).toBeTruthy()
    expect(screen.getAllByText(en['validation.roleChainRequired'])).toHaveLength(1)
    // Save is blocked: the non-seeded empty-chain role keeps the draft off
    // the wire (the violation renders under the 子代理 heading). A persona
    // edit dirties the SUB section so its Save attempt fires (per-section
    // dirty — PR #62 UX round 3). The seeded architect row renders no
    // persona textarea (read-only brief), so the only one on the page is
    // the non-seeded reviewer's.
    fireEvent.change(screen.getByLabelText(en['roles.persona']), { target: { value: 'Edited' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('sub'))
    view.rerender(<FallbacksCard {...props} />)
    expect(scripted.set).not.toHaveBeenCalled()
    expect(scripted.call).not.toHaveBeenCalledWith('/api', 'fallbacks/set', expect.anything())
    // The empty all-day head earns its own alert under 主代理 — the sub
    // violation is queried directly under the 子代理 heading.
    const alert = subError()
    expect(alert.textContent).toContain(en['validation.blocked'])
    expect(alert.textContent).toContain(en['validation.roleChainRequired'])
  })

  it('shows an overridden seeded row honestly: the brief carries the effective persona', async () => {
    // Overrides arrive via external config edits now (the card renders no
    // persona editor for seeded rows) — the brief must show the EFFECTIVE
    // persona, never the seed default (plan role-card-seeded-ux).
    const overriddenConfig: typeof defaultFallbacksConfig = {
      ...SEEDED_CONFIG,
      roles: {
        ...SEEDED_CONFIG.roles,
        list: SEEDED_CONFIG.roles.list.map(role => role.id === 'architect'
          ? { ...role, persona: 'Edited persona' }
          : role),
      },
    }
    const { view, props } = await mountCard({
      config: overriddenConfig,
      seeds: [{ id: 'architect', overridden: true, source: 'bundled' }],
    })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getAllByText('Edited persona')).toHaveLength(1)
    expect(screen.queryByText('Designs systems')).toBeNull()
  })

  it('hides the seeded row id (the title carries it); user rows keep full editing (regression)', async () => {
    const { view, props } = await mountCard({
      config: SEEDED_CONFIG,
      seeds: [{ id: 'architect', overridden: false, source: 'bundled' }],
    })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // SEEDED_CONFIG declares architect (seeded) before reviewer (ordinary).
    // The seeded row renders NO id input at all (R2 — immutable, and the
    // collapse title carries the id); the non-seeded reviewer keeps the
    // editable one.
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(1)
    expect((ids[0] as HTMLInputElement).value).toBe('reviewer')
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    within(rolesGroup).getByText('architect')
    // The persona split follows the same line: the seeded row renders the
    // read-only brief (no textarea), the user row keeps the editable one.
    expect(within(rolesGroup).queryAllByLabelText(en['roles.persona'])).toHaveLength(1)
    // The seeded row's fallback selector stays editable — chain/fallback
    // controls keep the `!writable`-only term (R4; qc1 S-3).
    const fallbacks = screen.getAllByLabelText(en['roles.fallback'])
    expect(fallbacks).toHaveLength(2)
    expect((fallbacks[0] as HTMLSelectElement).disabled).toBe(false)
    expect((fallbacks[1] as HTMLSelectElement).disabled).toBe(false)
  })

  it('treats preset-materialized rows as seeded: a scout preset row is read-only (regression pin)', async () => {
    // Presets land as seeded two-key rows through the seeds face (spec
    // §9.3), so a preset row IS a seeded row — the same `seedInfo`
    // derivation must give it the read-only presentation (plan
    // role-card-seeded-ux). The persona rides the frozen presets source so
    // the fixture cannot drift from the spec-frozen preset set
    // (presets.spec.ts pins the personas verbatim to spec §9.2). The
    // chain/fallback keys are config-shape requirements of this card
    // fixture — the presentation keys on the id match only.
    const scout = presetRoles.find((role) => role.id === 'scout')
    expect(scout).toBeDefined()
    if (!scout) throw new Error('preset scout removed')
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      roles: {
        list: [
          { id: 'scout', persona: scout.persona, chain: [], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props } = await mountCard({
      config,
      seeds: [{ id: 'scout', overridden: false, source: 'bundled' }],
    })
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // Only the ordinary reviewer row renders an id input; the scout row's
    // identity lives in its collapse title.
    const ids = screen.getAllByLabelText(en['roles.id'])
    expect(ids).toHaveLength(1)
    expect((ids[0] as HTMLInputElement).value).toBe('reviewer')
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    within(rolesGroup).getByText('scout')
    expect(within(rolesGroup).queryAllByLabelText(en['roles.persona'])).toHaveLength(1)
  })
})

describe('FallbacksCard seeded-role read-only UX (plan role-card-seeded-ux T3)', () => {
  // The Task-1/Task-2 reconciled block above pins the presentation surface
  // (badge vocabulary, read-only split, AC-3 relax, overridden honesty).
  // This block adds the coverage that block does not pin: the empty-persona
  // brief fallback, the dirty-computation contract, the read-only
  // (writable:false) disclosure gate, and the bilingual string parity.

  it('renders an empty or whitespace-only seeded persona as the (not set) brief with the chevron withheld', async () => {
    // The brief fallback for a seeded row with no persona (plan Task 2's
    // third string group): the read-only presentation still applies — the
    // hint-tone empty label replaces the brief text, and the expand chevron
    // is WITHHELD (there is nothing to disclose), so no persona
    // expand/collapse control exists on the row. The blank verdict is a
    // TRIM check: a whitespace-only persona degrades to the same empty
    // state instead of an invisible brief + chevron (wave-1 fix).
    for (const persona of ['', '   ']) {
      const config: typeof defaultFallbacksConfig = {
        ...defaultFallbacksConfig,
        enabled: true,
        roles: {
          list: [
            { id: 'architect', persona, chain: [], fallback: 'inherit-root' },
            { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          ],
          rules: [],
        },
      }
      const { view, props } = await mountCard({
        config,
        seeds: [{ id: 'architect', overridden: false, source: 'bundled' }],
      })
      expandAllRoles()
      view.rerender(<FallbacksCard {...props} />)
      const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
      expect(within(rolesGroup).getByText(en['roles.persona.empty'])).toBeTruthy()
      expect(within(rolesGroup).queryByRole('button', { name: en['roles.persona.expand'] })).toBeNull()
      expect(within(rolesGroup).queryByRole('button', { name: en['roles.persona.collapse'] })).toBeNull()
      view.unmount()
    }
  })

  it('keeps the seeded persona disclosure non-dirty while a chain edit still dirties and saves', async () => {
    // Dirty contract (plan Task 3 case d): seeded identity+persona have no
    // edit surface, and toggling the persona chevron only moves the
    // client-local `personaOpen` disclosure state (never serialized by
    // rowsToRoles) — the 子代理 section stays clean. The chain remains
    // operator-owned (R4): editing the SEEDED row's chain dirties the
    // section, the save goes through, and the patch carries the seeded
    // persona through byte-identical (rowsToRoles passthrough) next to the
    // untouched user row.
    const config: typeof defaultFallbacksConfig = {
      ...defaultFallbacksConfig,
      // Conforming all-day tail — the whole-form Save gate (T3).
      rootChain: [OFFICIAL_FLASH],
      roles: {
        list: [
          { id: 'architect', persona: 'Designs systems', chain: ['openai/gpt-4o'], fallback: 'inherit-root' },
          { id: 'reviewer', persona: 'Reviews code', chain: ['openai/gpt-4o'], fallback: 'inherit-root' },
        ],
        rules: [],
      },
    }
    const { view, props, controller, scripted } = await mountCard({
      config,
      seeds: [{ id: 'architect', overridden: false, source: 'bundled' }],
      catalog: CHAIN_CATALOG,
    })
    await controller.loadCatalog()
    expandAllRoles()
    view.rerender(<FallbacksCard {...props} />)
    // Clean draft: the sub Save is disabled.
    expect(saveButton('sub').disabled).toBe(true)
    // Expanding and re-collapsing the seeded persona brief moves no dirty
    // term — the section stays clean.
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    fireEvent.click(within(rolesGroup).getByRole('button', { name: en['roles.persona.expand'] }))
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('sub').disabled).toBe(true)
    fireEvent.click(within(rolesGroup).getByRole('button', { name: en['roles.persona.collapse'] }))
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('sub').disabled).toBe(true)
    // A chain edit on the seeded row (append + fill a second entry on
    // architect — the first row card, so its new selector owns index 1 of
    // the provider/model selects) still dirties and saves.
    fireEvent.click(within(rolesGroup).getAllByRole('button', { name: en['roles.selector.add'] })[0]!)
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(within(rolesGroup).getAllByLabelText(en['roles.rule.provider'])[1]!, { target: { value: 'openai' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.change(within(rolesGroup).getAllByLabelText(en['roles.rule.model'])[1]!, { target: { value: 'gpt-4o' } })
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('sub').disabled).toBe(false)
    fireEvent.click(saveButton('sub'))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = (scripted.set.mock.calls[0]![0] as { args: { patch: typeof defaultFallbacksConfig } }).args.patch
    expect(patch.roles.list).toEqual([
      { id: 'architect', persona: 'Designs systems', chain: ['openai/gpt-4o', 'openai/gpt-4o'], fallback: 'inherit-root' },
      { id: 'reviewer', persona: 'Reviews code', chain: ['openai/gpt-4o'], fallback: 'inherit-root' },
    ])
  })

  it('keeps the persona disclosure available in a read-only view while the row collapse toggle stays inert', async () => {
    // The routed writable-gate asymmetry (Task-1 review Minor 3), pinned
    // with the consistent reading: the row collapse toggle is
    // `disabled={!writable}` BECAUSE read-only forces rows open — its
    // effect would be nullified, so the control would lie. The persona
    // chevron's effect (`personaOpen`) stays REAL in read-only (the render
    // honors it unconditionally) and the disclosure is non-mutating
    // client-local state, so it keeps NO writable gate: read-only doctrine
    // is content reachable, mutating controls inert. The chevron is a
    // span[role="button"], NOT a native <button> (QA finding e, fix wave
    // 2): the row sits inside the form body's `disabled` fieldset, and
    // fieldset[disabled] propagation disables every descendant form control
    // in real browsers — QA confirmed the old native button live in real
    // Chromium (`matches(':disabled')=true`, clicks inert) exactly when the
    // forced-open read-only rows made it the only way to read the persona.
    // jsdom cannot model fieldset propagation, so this pin asserts the
    // MECHANISM rather than a live click: no disabled attribute and a
    // non-form-control tag (span), which propagation cannot reach by
    // construction — a regression back to a native button fails here, and
    // real-browser operability is re-verified by the QA gate's live repro.
    const { view, props } = await mountCard({
      config: {
        ...defaultFallbacksConfig,
        enabled: true,
        roles: {
          list: [
            { id: 'architect', persona: 'Designs systems', chain: [], fallback: 'inherit-root' },
            { id: 'reviewer', persona: 'Reviews code', chain: ['anthropic/claude-3-5-sonnet'], fallback: 'inherit-root' },
          ],
          rules: [],
        },
      },
      seeds: [{ id: 'architect', overridden: false, source: 'bundled' }],
      writable: false,
    })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    const rolesGroup = screen.getByText(en['roles.list.label']).closest('[role="group"]') as HTMLElement
    // Both rows force open WITHOUT expandAllRoles(): the seeded brief is
    // visible and every collapse toggle is inert while reporting the forced
    // state.
    expect(within(rolesGroup).getAllByText('Designs systems')).toHaveLength(1)
    const collapseToggles = within(rolesGroup).getAllByRole('button', { name: en['roles.collapse'] })
    expect(collapseToggles).toHaveLength(2)
    for (const toggle of collapseToggles) {
      expect((toggle as HTMLButtonElement).disabled).toBe(true)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    }
    // The seeded persona chevron carries no disabled gate and is a
    // non-form-control (span), so the disabled fieldset cannot reach it —
    // and it still round-trips the disclosure in the read-only view.
    const expandPersona = within(rolesGroup).getByRole('button', { name: en['roles.persona.expand'] })
    expect(expandPersona.hasAttribute('disabled')).toBe(false)
    expect(expandPersona.tagName).toBe('SPAN')
    fireEvent.click(expandPersona)
    view.rerender(<FallbacksCard {...props} />)
    const collapsePersona = within(rolesGroup).getByRole('button', { name: en['roles.persona.collapse'] })
    expect(collapsePersona.getAttribute('aria-expanded')).toBe('true')
    expect(within(rolesGroup).getAllByText('Designs systems')).toHaveLength(2)
    fireEvent.click(collapsePersona)
    view.rerender(<FallbacksCard {...props} />)
    expect(within(rolesGroup).getAllByText('Designs systems')).toHaveLength(1)
  })

  it('keeps the seeded-UX persona + source keys in both zh and en dictionaries', () => {
    // Bilingual-pair constraint (plan Global Constraints): every new string
    // lands in BOTH dictionaries, non-empty (the Task 2 parity review,
    // pinned here so it can no longer drift silently).
    const keys = [
      'roles.persona.expand',
      'roles.persona.collapse',
      'roles.persona.empty',
      'roles.seedSource.bundled',
      'roles.seedSource.external',
      'roles.seedSource.user',
    ] as const
    for (const key of keys) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
    // The badge labels ARE the plan Goal's vocabulary contract: the
    // rendered badges read exactly `bundled` / `external` / `User` (en) —
    // `external` localizes too (plan seeds-source-and-persona-width Task
    // 2): the zh label is 外部, never the raw token.
    expect(en['roles.seedSource.bundled']).toBe('bundled')
    expect(en['roles.seedSource.external']).toBe('external')
    expect(en['roles.seedSource.user']).toBe('User')
    expect(zh['roles.seedSource.external']).toBe('外部')
  })
})

describe('FallbacksCard 主代理 layout (PR #62 feedback round)', () => {
  const slotGroup = (): HTMLElement =>
    screen.getByText(en['timeSlots.label']).closest('[role="group"]') as HTMLElement

  it('removes the preemption hints from the default-chain block', async () => {
    const { view, props } = await mountCard({ config: TWO_BLOCK_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    // PR #62 feedback round: the old "engages only after the session model
    // fails" first line and the prefer-session-model hint are removed
    // entirely from the 默认降级链 block.
    expect(screen.queryByText(/Engages only after the current session/)).toBeNull()
    expect(screen.queryByText(/Prefer the current session/)).toBeNull()
  })
  it('hides the timezone picker on preset-only configs; mixed configs lock it to Asia/Shanghai', async () => {
    const presetOnly: typeof defaultFallbacksConfig = {
      ...BASE_CONFIG,
      rootChain: [OFFICIAL_FLASH],
      timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_FLASH] }],
    }
    const first = await mountCard({ config: presetOnly })
    first.view.rerender(<FallbacksCard {...first.props} />)
    // Preset rows have no tz picker — windows are frozen UTC+8.
    expect(screen.queryByLabelText(en['timeSlots.tz.label'])).toBeNull()
    first.view.unmount()

    const mixed: typeof defaultFallbacksConfig = {
      ...presetOnly,
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_FLASH] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [], chain: [OFFICIAL_FLASH] },
      ],
    }
    const second = await mountCard({ config: mixed })
    second.view.rerender(<FallbacksCard {...second.props} />)
    expandAllSlots()
    expect(customTzLabel().textContent).toContain('Asia/Shanghai')
    expect(customTzLabel().textContent).toMatch(/UTC/)
    expect(screen.queryByRole('combobox', { name: en['timeSlots.tz.label'] })).toBeNull()
  })

  it('shows the host timezone as a label on custom slots and persists it on save', async () => {
    const { view, props, scripted } = await mountCard({
      config: { ...BASE_CONFIG, rootChain: [OFFICIAL_FLASH], timeSlots: [VALID_CUSTOM_SLOT] },
    })
    view.rerender(<FallbacksCard {...props} />)
    expandAllSlots()
    const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    expect(customTzLabel().textContent).toContain(hostTz)
    fireEvent.change(screen.getByLabelText(en['timeSlots.name']), { target: { value: 'noon' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('main'))
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
    const { view, props } = await mountCard({ config: BASE_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    // The toggle lives in the advanced section (collapsed by default —
    // plan fallbacks-card-section-ux T3) and starts checked (the
    // config-model default, `true` — compass AC-6 roleAutoMatch default on).
    expandAdvanced()
    const toggle = screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  it('writes the toggle to the scalar and persists roleAutoMatch:false through a save', async () => {
    // A conforming all-day tail so the accepted config is save-valid; the
    // advanced section's own Save persists the scalar.
    const { view, props, scripted } = await mountCard({
      config: { ...defaultFallbacksConfig, rootChain: [OFFICIAL_FLASH] },
    })
    view.rerender(<FallbacksCard {...props} />)
    expandAdvanced()
    // Flipping the toggle off dirties the advanced section (scalar
    // roleAutoMatch true → false); the advanced Save persists it.
    fireEvent.click(screen.getByLabelText(en['roleAutoMatch.label']))
    view.rerender(<FallbacksCard {...props} />)
    expect((screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(saveButton('advanced'))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    expect(scripted.set).toHaveBeenCalledWith(expect.objectContaining({
      args: { patch: expect.objectContaining({ roleAutoMatch: false }) },
    }))
  })

  it('renders the toggle (default on) for a legacy config that never declared the key (AC-7 re-scope Option A)', async () => {
    const { view, props } = await mountCard({ config: LEGACY_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    // AC-7 re-scope (PM decision 2026-08-17 Option A): the real gateway wire
    // always carries `roleAutoMatch: true` (the schema fold — see
    // tests/gateway.spec.ts), so the card ALWAYS renders the toggle and it
    // starts checked. The advanced options render the rest as usual.
    expandAdvanced()
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
    view.rerender(<FallbacksCard {...props} />)
    expect(saveButton('main').disabled).toBe(true)
  })

  it('a legacy-config save persists roleAutoMatch: true (the schema default is pinned, not invented)', async () => {
    const { view, props, scripted } = await mountCard({ config: LEGACY_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    // An advanced edit makes the advanced section dirty (a clean section's
    // Save button is disabled); the always-rendered toggle stays on, so the
    // saved section carries `roleAutoMatch: true` and the save pins it —
    // semantically identical to the schema default (AC-7 re-scope Option A).
    expandAdvanced()
    fireEvent.change(screen.getByLabelText(en['cooldownMs.label']), { target: { value: '7000' } })
    view.rerender(<FallbacksCard {...props} />)
    fireEvent.click(saveButton('advanced'))
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
    const { view, props } = await mountCard({ config: BASE_CONFIG, writable: false })
    view.rerender(<FallbacksCard {...props} />)
    // Read-only forces the advanced options open and the wrapping fieldset
    // + explicit disabled term make the toggle inert (F-002 precedent).
    const toggle = screen.getByLabelText(en['roleAutoMatch.label']) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
  })
})

describe('FallbacksCard status block (AC-2: recent switch only)', () => {
  it('renders only the recent-switch line — no effective-model line, no selectionNote', async () => {
    const { view, props } = await mountCard({ config: BASE_CONFIG })
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
    const scripted = scriptedApi({ config: BASE_CONFIG, historyEntries: [switchEntry(1)] })
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
      config: BASE_CONFIG,
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
    const scripted = scriptedApi({ config: BASE_CONFIG })
    scripted.api.session.follow = vi.fn((): AsyncIterable<SessionFollowFrame> => (async function* (): AsyncGenerator<SessionFollowFrame> {
      await Promise.withResolvers().promise
    })())
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    void controller.loadSwitches()
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
  })

  it('surfaces the switches read error with an alert and no effective-model/selectionNote', async () => {
    const scripted = scriptedApi({ config: BASE_CONFIG, historyError: 'history refused' })
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    controller.setCurrentSession('sess-1' as never)
    await controller.loadSwitches()
    const props = cardProps(controller, bindSnapshotSelector(controller.store))
    const view = render(<FallbacksCard {...props} />)
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
      config: BASE_CONFIG,
      subagentPolicy: ENABLED_POLICY,
    })
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
    const { view, props } = await mountCard({ config: BASE_CONFIG })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.label'])).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.allowlist'], { exact: false })).toBeNull()
    expect(screen.queryByText('policy-test/alpha')).toBeNull()
    cleanup()

    const disabled = await mountCard({
      config: BASE_CONFIG,
      subagentPolicy: { state: 'disabled' },
    })
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
    const { view, props, controller } = await mountCard({ config: BASE_CONFIG })
    expect(controller.store.getSnapshot().subagentPolicy).toBeUndefined()
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.label'])).toBeTruthy()
    expect(screen.getByText(en['roles.list.label'])).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.unprovable'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.blocked'])).toBeNull()
  })

  it('pins the head-source label: authorized vs injected', async () => {
    const authorized = await mountCard({
      config: BASE_CONFIG,
      subagentPolicy: {
        state: 'enabled',
        allowedModels: [ALPHA],
        head: { route: ALPHA, source: 'authorized' },
      },
    })
    authorized.view.rerender(<FallbacksCard {...authorized.props} />)
    expect(screen.getByText(
      `${en['subagents.policy.head']}: policy-test/alpha (${en['subagents.policy.source.authorized']})`,
    )).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.source.injected'])).toBeNull()
    cleanup()

    const injected = await mountCard({
      config: BASE_CONFIG,
      subagentPolicy: {
        state: 'enabled',
        allowedModels: [ALPHA],
        head: { route: ALPHA, source: 'injected' },
      },
    })
    injected.view.rerender(<FallbacksCard {...injected.props} />)
    expect(screen.getByText(
      `${en['subagents.policy.head']}: policy-test/alpha (${en['subagents.policy.source.injected']})`,
    )).toBeTruthy()
    expect(screen.queryByText(`(${en['subagents.policy.source.authorized']})`)).toBeNull()
  })

  it('unprovable is its own state — not empty-intersection, not enabled', async () => {
    const { view, props, controller } = await mountCard({
      config: BASE_CONFIG,
      subagentPolicy: { state: 'unprovable' },
    })
    expect(controller.store.getSnapshot().subagentPolicy).toEqual({ state: 'unprovable' })
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
      config: BASE_CONFIG,
      subagentPolicy: ENABLED_POLICY,
    })
    expect(controller.store.getSnapshot().subagentPolicy?.state).toBe('enabled')
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(en['subagents.policy.label'])).toBeTruthy()

    scripted.set.mockImplementation((payload: { args: { patch: typeof defaultFallbacksConfig } }) => (
      Promise.resolve(okResult({
        config: payload.args.patch,
        subagentPolicy: { state: 'disabled' },
      }))
    ))
    await controller.save(BASE_CONFIG)
    view.rerender(<FallbacksCard {...props} />)
    expect(controller.store.getSnapshot().subagentPolicy).toEqual({ state: 'disabled' })
    expect(screen.queryByText(en['subagents.policy.label'])).toBeNull()
    expect(screen.queryByText(en['subagents.policy.allowlist'], { exact: false })).toBeNull()
    expect(screen.queryByText('policy-test/alpha')).toBeNull()
  })

  it('enabled with no recorded head still shows the allowlist and omits the head line', async () => {
    const { view, props } = await mountCard({
      config: BASE_CONFIG,
      subagentPolicy: { state: 'enabled', allowedModels: [ALPHA] },
    })
    view.rerender(<FallbacksCard {...props} />)
    expect(screen.getByText(`${en['subagents.policy.allowlist']}: policy-test/alpha`)).toBeTruthy()
    expect(screen.queryByText(en['subagents.policy.head'], { exact: false })).toBeNull()
  })
})

