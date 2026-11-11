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
  LlmConfigurableProvider, ModelProviderGroup,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ClientConnectionRpc, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '../src/client/use-snapshot.ts'
import { FallbacksCard } from '../src/client/FallbacksCard.tsx'
import type { FallbacksCardProps } from '../src/client/FallbacksCard.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import type { FallbacksRemote, FallbacksSettingsState } from '../src/client/fallbacks-store.ts'
import type { SeedsWireStatus } from '../src/seeds.ts'
import { presetRoles } from '../src/presets.ts'
import { apply } from '../src/client/index.ts'
import { defaultFallbacksConfig, migrateLegacyConfig } from '../src/config.ts'
import { parseFallbacksConfig } from '../src/client/fallbacks-store.ts'
import { OFFICIAL_FLASH, OFFICIAL_PRO } from '../src/time-slots.ts'
import { en, zh } from '../src/client/locales.ts'

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
 * Chain-row accessible names (plan fallbacks-chain-row-compact T3): the two
 * selects and the remove button carry the field AND the 1-based row position
 * (`Selector {index} provider` / `… model` / `Remove selector {index}`); the
 * visible ordinal span is `aria-hidden`. The module `t` seat does not
 * interpolate, so a card mounted with it renders the raw template — these
 * constants are that template, which is enough to prove every chain row moved
 * off the shared `roles.rule.*` names (those stay on the role-RULE rows). The
 * concrete per-index strings and their mutual distinctness are pinned in the
 * compact-row describe, which rerenders with {@link interpolatingT}.
 */
const CHAIN_PROVIDER_LABEL = en['chains.selector.providerAria']
const CHAIN_MODEL_LABEL = en['chains.selector.modelAria']

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

interface Scripted {
  api: FallbacksRemote
  rpc: ClientConnectionRpc
  call: Mock
  get: Mock
  set: Mock
  reset: Mock
  describe: Mock
  providers: Mock
  models: Mock
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
  catalog?: { providers: LlmConfigurableProvider[]; groups: ModelProviderGroup[] }
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
    call, get, set, reset, describe, providers, models,
  }
}

/** Preload the store, then render the card (advisor spec pattern). */
async function mountCard(options: Parameters<typeof scriptedApi>[0] = {}, preload = true) {
  const scripted = scriptedApi(options)
  const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
  if (preload) await controller.load()
  // A catalog fixture must be READY before the first render: the provider /
  // model / effort selects and the 默认模型 panel are all catalog-driven, and
  // the card's own mount effect only kicks off the load.
  if (options.catalog !== undefined) await controller.loadCatalog()
  const props = cardProps(controller, bindSnapshotSelector(controller.store))
  const view = render(<FallbacksCard {...props} />)
  return { view, controller, scripted, props }
}

/**
 * Expand every role card: role editors mount COLLAPSED (one scannable row per
 * role). Content assertions call this right after mounting; the collapse-state
 * assertions skip it. Scoped to the collapse row so the persona disclosure
 * inside an already-expanded card is never toggled.
 */
function expandRoleCards(container: HTMLElement): void {
  for (const toggle of container.querySelectorAll('[data-role-card] [class*="collapseRow"] [aria-expanded="false"]')) {
    fireEvent.click(toggle)
  }
}

/**
 * A base loaded config. The FLAT card renders every field unconditionally —
 * there is no config-level `enabled` gate to satisfy (plan
 * fallbacks-web-ux-alignment T2/T3), so the draft is clean (it seeds from
 * this same config) and the action-gate assertions hold.
 */

/** A v2 fixture: two chains (one with a slot row) + a role pointing at the first. */
function v2Config(): typeof defaultFallbacksConfig {
  return {
    ...defaultFallbacksConfig,
    chains: [
      {
        id: 'Auto',
        label: '默认链',
        entries: ['anthropic/claude-3-5-sonnet', OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '09:00', end: '12:00', days: [], chain: [OFFICIAL_PRO] }],
      },
      { id: 'night', label: '夜间', entries: [OFFICIAL_PRO], timeSlots: [] },
    ],
    roles: { list: [{ id: 'coder', persona: 'Coder', chain: 'Auto' }] },
  }
}

describe('chain tabs (named virtual chains §4)', () => {
  it('renders one tab per chain with the tablist roles and roving tabindex', async () => {
    const { view } = await mountCard({ config: v2Config() })
    const tablist = view.container.querySelector('[data-tablist]')!
    expect(tablist.getAttribute('role')).toBe('tablist')
    const tabs = [...tablist.querySelectorAll('[data-chain-tab]')] as HTMLButtonElement[]
    expect(tabs.map(tab => tab.getAttribute('data-chain-tab'))).toEqual(['Auto', 'night'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0')
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1')
    // The active tab renders the 2px underline + label-primary (class hook),
    // and the panel is labelled by the tab.
    expect(view.container.querySelector('[data-chain-panel]')!.id)
      .toBe(`fallbacks-chain-panel-${'Auto'}`)
  })

  it('moves the selection with Arrow keys and Home/End (keyboard semantics)', async () => {
    const { view } = await mountCard({ config: v2Config() })
    const tab = (id: string) => view.container.querySelector(`[data-chain-tab="${id}"]`) as HTMLButtonElement
    fireEvent.keyDown(tab('Auto'), { key: 'ArrowRight' })
    expect(tab('night').getAttribute('aria-selected')).toBe('true')
    expect(tab('night').getAttribute('tabindex')).toBe('0')
    expect(tab('Auto').getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(tab('night'), { key: 'Home' })
    expect(tab('Auto').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Auto'), { key: 'End' })
    expect(tab('night').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('night'), { key: 'ArrowLeft' })
    expect(tab('Auto').getAttribute('aria-selected')).toBe('true')
  })

  it('＋ adds a chain and selects it', async () => {
    const { view } = await mountCard({ config: v2Config() })
    fireEvent.click(view.container.querySelector('[data-tab-add]')!)
    const tabs = [...view.container.querySelectorAll('[data-chain-tab]')]
    expect(tabs).toHaveLength(3)
    expect((tabs[2] as HTMLElement).getAttribute('data-chain-tab')).toBe('chain-3')
    expect((tabs[2] as HTMLButtonElement).getAttribute('aria-selected')).toBe('true')
  })

  it('⋯ renames the LABEL only (the id stays) and deletes with ≥1 kept', async () => {
    const { view } = await mountCard({ config: v2Config() })
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    const panel = view.container.querySelector('[data-menu-panel]')!
    const input = panel.querySelector('[data-menu-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '改名链' } })
    fireEvent.click(panel.querySelector('[data-menu-apply]')!)
    const tabs = [...view.container.querySelectorAll('[data-chain-tab]')] as HTMLButtonElement[]
    expect(tabs[0]!.textContent).toContain('改名链')
    expect(tabs[0]!.getAttribute('data-chain-tab')).toBe('Auto')

    // Delete: two chains → deleting the active removes it and keeps one.
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.click(view.container.querySelector('[data-menu-delete]')!)
    expect([...view.container.querySelectorAll('[data-chain-tab]')]).toHaveLength(1)
    // A single chain disables delete (≥1 chain remains).
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    expect((view.container.querySelector('[data-menu-delete]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the empty state renders with the create affordance when no chains exist', async () => {
    const { view } = await mountCard({ config: { ...defaultFallbacksConfig, chains: [] } })
    expect(view.container.querySelector('[data-empty-state]')).not.toBeNull()
    expect(view.container.querySelector('[data-empty-create]')).not.toBeNull()
  })

  it('a dirty chain shows the pip and an invalid chain shows the error mark', async () => {
    const { view } = await mountCard({ config: v2Config() })
    // Rename the active chain's label → dirty pip on tab Auto.
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.change(view.container.querySelector('[data-menu-input]')!, { target: { value: 'x' } })
    fireEvent.click(view.container.querySelector('[data-menu-apply]')!)
    expect(view.container.querySelector('[data-chain-tab="Auto"] [data-dirty-pip]')).not.toBeNull()

    // An invalid chain (missing label after clearing + empty entries) shows "!".
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.change(view.container.querySelector('[data-menu-input]')!, { target: { value: '' } })
    fireEvent.click(view.container.querySelector('[data-menu-apply]')!)
    // Empty entries → tail conformance error on the active chain.
    expect(view.container.querySelector('[data-chain-tab="Auto"] [data-error-mark]')).not.toBeNull()
  })
})

/**
 * A catalog whose first model discloses two reasoning tiers and whose second
 * model discloses none — the two branches the effort column must distinguish.
 * `deepseek-official` is registered so the 默认模型 panel has a provider to
 * offer (a catalog-less mount is the "unknown catalog" path, see the tail
 * panel describe).
 */
function effortCatalog(): { providers: LlmConfigurableProvider[]; groups: ModelProviderGroup[] } {
  // `settingsPath` addresses the harness's single `llm-providers` namespace, so
  // every provider here counts as CONFIGURED (the join the tail panel filters
  // on).
  const provider = (id: string, displayName: string): LlmConfigurableProvider => ({
    provider: id, displayName, settingsNs: 'llm-providers', settingsPath: ['providers', id],
  })
  return {
    providers: [
      provider('openai', 'OpenAI'),
      provider('anthropic', 'Anthropic'),
      provider('deepseek-official', 'DeepSeek Official'),
      provider('deepseek-account', 'DeepSeek Account'),
    ],
    groups: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
          { id: 'plain', name: 'Plain' },
        ],
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
        ],
      },
      {
        id: 'deepseek-official',
        name: 'DeepSeek Official',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }] } },
        ],
      },
      {
        id: 'deepseek-account',
        name: 'DeepSeek Account',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }] } },
        ],
      },
    ],
  }
}

/** A chain whose HEAD row exercises the effort column. */
function effortConfig(head = 'openai/gpt-4o'): typeof defaultFallbacksConfig {
  return {
    ...defaultFallbacksConfig,
    chains: [{ id: 'Auto', label: '默认链', entries: [head, OFFICIAL_FLASH], timeSlots: [] }],
    roles: { list: [] },
  }
}

/** The effort select of one row inside the 默认降级链 block. */
function effortSelectOf(container: HTMLElement, rowIndex = 0): HTMLSelectElement {
  const rows = container.querySelectorAll('[aria-labelledby="fallbacks-root-chain-Auto"] [data-selector-row]')
  return within(rows[rowIndex] as HTMLElement).getByLabelText(en['chains.selector.effortAria']) as HTMLSelectElement
}

/** `effortCatalog()` minus the official providers — the "none configured" case. */
function catalogWithoutOfficials() {
  const catalog = effortCatalog()
  const drop = (id: string) => id === 'deepseek-account' || id === 'deepseek-official'
  return {
    providers: catalog.providers.filter(entry => !drop(entry.provider)),
    groups: catalog.groups.filter(group => !drop(group.id)),
  }
}

/** A chain whose only entry is NOT an official tail (the blocked-save case). */
function nonConformingConfig(): typeof defaultFallbacksConfig {
  return {
    ...defaultFallbacksConfig,
    chains: [{ id: 'Auto', label: '默认链', entries: ['openai/gpt-4o'], timeSlots: [] }],
    roles: { list: [] },
  }
}

describe('默认模型 panel — generated from the configured providers (T3)', () => {
  it('lists the four legal tails, account pair first, each with its wire id', async () => {
    const { view, props } = await mountCard({ config: v2Config(), catalog: effortCatalog() })
    // The label template interpolates {model}/{provider}.
    view.rerender(<FallbacksCard {...props} t={interpolatingT} />)
    const ids = [...view.container.querySelectorAll('[data-tail-option]')]
      .map(option => option.getAttribute('data-tail-option'))
    expect(ids).toEqual([
      'deepseek-account/deepseek-flash',
      'deepseek-account/deepseek-v4-pro',
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
    ])
    const first = view.container.querySelector('[data-tail-option="deepseek-account/deepseek-flash"]')!
    // Short label + provider tone + the exact id the conformance check uses.
    expect(first.textContent).toContain(en['allDay.flash'])
    expect(first.textContent).toContain(en['allDay.account'])
    expect(first.textContent).toContain('deepseek-account/deepseek-flash')
  })

  it('picks an account tail and saves it as the LAST entry', async () => {
    const { view, scripted } = await mountCard({ config: v2Config(), catalog: effortCatalog() })
    fireEvent.click(view.container.querySelector('[data-tail-option="deepseek-account/deepseek-v4-pro"] input')!)
    fireEvent.click(view.container.querySelector('[data-chain-foot] button[class*="save"]')!)
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = scripted.set.mock.calls[0]![0].args.patch
    expect(patch.chains[0].entries.at(-1)).toBe('deepseek-account/deepseek-v4-pro')
  })

  it('a suffixed tail still selects its radio (the comparison parses the key)', async () => {
    const { view } = await mountCard({
      config: { ...v2Config(), chains: [{ id: 'Auto', label: 'A', entries: [`${OFFICIAL_FLASH}@high`], timeSlots: [] }] },
      catalog: effortCatalog(),
    })
    const radio = (id: string) => view.container.querySelector(`[data-tail-option="${id}"] input`) as HTMLInputElement
    expect(radio(OFFICIAL_FLASH).checked).toBe(true)
    expect(radio(OFFICIAL_PRO).checked).toBe(false)
  })

  it('one official provider → its two radios plus the "only this provider" hint', async () => {
    const catalog = effortCatalog()
    catalog.providers = catalog.providers.filter(entry => entry.provider !== 'deepseek-account')
    const { view, props } = await mountCard({ config: v2Config(), catalog })
    expect(view.container.querySelectorAll('[data-tail-option]')).toHaveLength(2)
    view.rerender(<FallbacksCard {...props} t={interpolatingT} />)
    const hint = view.container.querySelector('[aria-labelledby="fallbacks-default-model-Auto"]')!.textContent!
    expect(hint).toContain('only DeepSeek Official is available')
  })

  it('no official provider → no radios, the explanation, and the blocked save', async () => {
    const { view } = await mountCard({ config: nonConformingConfig(), catalog: catalogWithoutOfficials() })
    expect(view.container.querySelectorAll('[data-tail-option]')).toHaveLength(0)
    const panel = view.container.querySelector('[aria-labelledby="fallbacks-default-model-Auto"]')!
    expect(panel.textContent).toContain(en['allDay.none'])
    expect(panel.querySelector('[data-tail-error]')).not.toBeNull()
    expect((view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('compact slot rows (Plan A)', () => {
  /** A chain carrying one preset row and one custom row. */
  function slotsConfig(): typeof defaultFallbacksConfig {
    return {
      ...defaultFallbacksConfig,
      chains: [{
        id: 'Auto',
        label: '默认链',
        entries: [OFFICIAL_FLASH],
        timeSlots: [
          { kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_FLASH] },
          { kind: 'custom', start: '23:00', end: '07:00', days: [], name: '夜间', chain: [OFFICIAL_FLASH] },
        ],
      }],
      roles: { list: [] },
    }
  }

  it('deletes the action footer and folds the row actions into the header', async () => {
    const { view } = await mountCard({ config: slotsConfig(), catalog: effortCatalog() })
    // Slot rows mount collapsed, so the actions must already be reachable.
    expect(view.container.querySelector('[data-chain-panel] [class*="cardFoot"]')).toBeNull()
    const cards = [...view.container.querySelectorAll('[data-chain-panel] [class*="editorCard"]')]
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      const header = card.querySelector('[class*="collapseRow"]')!
      expect(header.querySelectorAll('button[class*="iconButton"]')).toHaveLength(3)
    }
  })

  it('drops the duplicated preset block and puts the window in the collapsed meta', async () => {
    const { view, props } = await mountCard({ config: slotsConfig(), catalog: effortCatalog() })
    view.rerender(<FallbacksCard {...props} t={interpolatingT} />)
    const cards = [...view.container.querySelectorAll('[data-chain-panel] [class*="editorCard"]')]
    const presetCard = cards[0]!
    // Collapsed: no rule grid, and the meta already carries the short window.
    expect(presetCard.querySelector('[class*="ruleGrid"]')).toBeNull()
    expect(presetCard.textContent).toContain('09:00–12:00 · 14:00–18:00 Mon–Fri')
    // Expanded: still no duplicated preset/window block — only the chain list.
    fireEvent.click(presetCard.querySelector('[class*="collapseToggle"]')!)
    expect(presetCard.querySelector('[class*="ruleGrid"]')).toBeNull()
    expect(presetCard.querySelector('[data-chain-block]')).not.toBeNull()
    // The custom row keeps its fields on ONE line once expanded.
    fireEvent.click(cards[1]!.querySelector('[class*="collapseToggle"]')!)
    expect(cards[1]!.querySelector('[class*="slotFields"]')).not.toBeNull()
  })
})

describe('per-entry reasoning effort (selector @effort)', () => {
  it('offers 跟随会话 plus the model\'s catalog tiers, and saves the pin as a suffix', async () => {
    const { view, scripted } = await mountCard({ config: effortConfig(), catalog: effortCatalog() })
    const select = effortSelectOf(view.container)
    expect(select.disabled).toBe(false)
    expect([...select.options].map(option => option.text)).toEqual([
      en['chains.selector.effortFollow'], 'Low', 'High',
    ])
    // Unset by default: nothing is imposed on the hop.
    expect(select.value).toBe('')

    fireEvent.change(select, { target: { value: 'high' } })
    fireEvent.click(view.container.querySelector('[data-chain-foot] button[class*="save"]')!)
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = scripted.set.mock.calls[0]![0].args.patch
    expect(patch.chains[0].entries[0]).toBe('openai/gpt-4o@high')
    // The tail entry is untouched.
    expect(patch.chains[0].entries.at(-1)).toBe(OFFICIAL_FLASH)
  })

  it('renders a disabled 无 and explains itself when the model reports no metadata', async () => {
    const { view } = await mountCard({ config: effortConfig('openai/plain'), catalog: effortCatalog() })
    const select = effortSelectOf(view.container)
    expect(select.disabled).toBe(true)
    expect([...select.options].map(option => option.text)).toEqual([en['chains.selector.effortNone']])
    // The reason is announced, not just hovered: the described element exists.
    const describedBy = select.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy!)!.textContent).toBe(en['chains.selector.effortNoMetadata'])
  })

  it('keeps a stored pin the model no longer lists selected, with the unsupported hint', async () => {
    const { view } = await mountCard({ config: effortConfig('openai/gpt-4o@max'), catalog: effortCatalog() })
    const select = effortSelectOf(view.container)
    expect(select.disabled).toBe(false)
    expect(select.value).toBe('max')
    // The stored value is a real option, so the control never silently shows
    // a different tier than the string it will write.
    expect([...select.options].map(option => option.value)).toEqual(['', 'low', 'high', 'max'])
    const row = view.container.querySelector('[aria-labelledby="fallbacks-root-chain-Auto"] [data-selector-row]')!
    expect(row.textContent).toContain(en['chains.selector.effortUnsupported'])
  })

  it('clears the pin when the provider changes (it belonged to the dropped model)', async () => {
    const { view, scripted } = await mountCard({ config: effortConfig('openai/gpt-4o@high'), catalog: effortCatalog() })
    const rows = view.container.querySelectorAll('[aria-labelledby="fallbacks-root-chain-Auto"] [data-selector-row]')
    const provider = within(rows[0] as HTMLElement).getByLabelText(en['chains.selector.providerAria']) as HTMLSelectElement
    fireEvent.change(provider, { target: { value: 'anthropic' } })
    // A different provider → the row's model AND pin are dropped; pick the new
    // pair, then pin its tier.
    const rowsAfter = view.container.querySelectorAll('[aria-labelledby="fallbacks-root-chain-Auto"] [data-selector-row]')
    const model = within(rowsAfter[0] as HTMLElement).getByLabelText(en['chains.selector.modelAria']) as HTMLSelectElement
    fireEvent.change(model, { target: { value: 'claude-3-5-sonnet' } })
    fireEvent.change(effortSelectOf(view.container), { target: { value: 'low' } })
    fireEvent.click(view.container.querySelector('[data-chain-foot] button[class*="save"]')!)
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = scripted.set.mock.calls[0]![0].args.patch
    expect(patch.chains[0].entries[0]).toBe('anthropic/claude-3-5-sonnet@low')
  })
})

describe('per-tab blocks and per-tab save isolation', () => {
  it('renders 分时槽设置 → 默认降级链 → 默认模型 in order, with block ids per chain', async () => {
    const { view } = await mountCard({ config: v2Config() })
    const panel = view.container.querySelector('[data-chain-panel]')!
    expect(document.getElementById('fallbacks-time-slots-Auto')).not.toBeNull()
    expect(document.getElementById('fallbacks-root-chain-Auto')).not.toBeNull()
    expect(document.getElementById('fallbacks-default-model-Auto')).not.toBeNull()
    // Shipped order: slots block before chain block before tail block.
    const slotsTop = document.getElementById('fallbacks-time-slots-Auto')!.getBoundingClientRect().top
    const chainTop = document.getElementById('fallbacks-root-chain-Auto')!.getBoundingClientRect().top
    const tailTop = document.getElementById('fallbacks-default-model-Auto')!.getBoundingClientRect().top
    expect(slotsTop).toBeLessThanOrEqual(chainTop)
    expect(chainTop).toBeLessThanOrEqual(tailTop)
    void panel
  })

  it('marks the four tab-body titles as block headings and drops the editor-card wrappers', async () => {
    const { view } = await mountCard({ config: v2Config() })
    // T1/AC1: the four per-chain titles carry the block-heading tier, so they
    // outrank the field labels inside them (the CSS supplies 14px/600).
    for (const id of [
      'fallbacks-chain-name-Auto',
      'fallbacks-time-slots-Auto',
      'fallbacks-root-chain-Auto',
      'fallbacks-default-model-Auto',
    ]) {
      expect(document.getElementById(id)!.parentElement!.getAttribute('class')).toContain('blockHeading')
    }
    // AC2: the default-chain selector list and the 默认模型 radio group sit
    // directly in their block — no second container language.
    for (const id of ['fallbacks-root-chain-Auto', 'fallbacks-default-model-Auto']) {
      const block = view.container.querySelector(`[aria-labelledby="${id}"]`)!
      expect(block.querySelector('[class*="editorCard"]')).toBeNull()
    }
  })

  it('an empty time-slot block explains the all-day default (zh + en)', async () => {
    const { view, props } = await mountCard({ config: v2Config() })
    // Chain Auto carries one slot row → no empty line.
    expect(view.container.querySelector('[data-slot-empty]')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-chain-tab="night"]')!)
    const empty = view.container.querySelector('[data-slot-empty]')!
    expect(empty.textContent).toBe(en['timeSlots.empty'])
    // One tertiary line, not an error.
    expect(empty.getAttribute('class')).toContain('hint')
    // The zh half of the dictionary.
    view.rerender(<FallbacksCard {...props} t={zhT} />)
    expect(view.container.querySelector('[data-slot-empty]')!.textContent).toBe(zh['timeSlots.empty'])
  })

  it('the 默认模型 radio owns the LAST entry (tail) and save validation blocks a non-official tail', async () => {
    const { view, scripted } = await mountCard({ config: v2Config(), catalog: effortCatalog() })
    // Pick the official Pro: the last selector row becomes
    // deepseek-official/deepseek-v4-pro.
    const radio = view.container.querySelector(
      `[data-tail-option="deepseek-official/deepseek-v4-pro"] input`,
    ) as HTMLInputElement
    fireEvent.click(radio)
    // The chain foot Save is armed by the dirty tab.
    const save = view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = scripted.set.mock.calls[0]![0].args.patch
    expect(patch.chains[0].entries.at(-1)).toBe(OFFICIAL_PRO)
    // The second chain is UNTOUCHED (per-tab save isolation).
    expect(patch.chains[1]).toEqual(v2Config().chains[1])
  })

  it('an invalid chain disarms its own Save but not a sibling chain', async () => {
    const { view } = await mountCard({ config: v2Config() })
    // Chain Auto: break the tail by switching the radio OFF is impossible —
    // instead break the LABEL (validation error on Auto only).
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.change(view.container.querySelector('[data-menu-input]')!, { target: { value: '' } })
    fireEvent.click(view.container.querySelector('[data-menu-apply]')!)
    const save = view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // Switch to the VALID sibling: its Save is armed (its own dirt? none —
    // it must stay DISABLED because it is clean; the isolation is that the
    // sibling's save is NOT blocked by Auto's error bucket).
    const nightTab = view.container.querySelector('[data-chain-tab="night"]') as HTMLButtonElement
    fireEvent.click(nightTab)
    const nightSave = view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement
    // Clean tab → disabled by dirtiness, NOT by validation.
    expect(nightSave.disabled).toBe(true)
    expect((view.container.querySelector('[data-chain-tab="night"] [data-error-mark]'))).toBeNull()
  })

  it('two consecutive + clicks get DISTINCT ids and both persist', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    fireEvent.click(view.container.querySelector('[data-tab-add]')!)
    fireEvent.click(view.container.querySelector('[data-tab-add]')!)

    const ids = [...view.container.querySelectorAll('[data-chain-tab]')]
      .map(tab => tab.getAttribute('data-chain-tab'))
    expect(ids).toEqual(['Auto', 'night', 'chain-3', 'chain-4'])
    expect(new Set(ids).size).toBe(ids.length)

    // Name + give each a tail so the section is valid, then save from the
    // last tab: both additions are in the payload with their own ids.
    for (const id of ['chain-3', 'chain-4'] as const) {
      fireEvent.click(view.container.querySelector(`[data-chain-tab="${id}"]`)!)
      fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
      fireEvent.change(view.container.querySelector('[data-menu-input]')!, { target: { value: `label ${id}` } })
      fireEvent.click(view.container.querySelector('[data-menu-apply]')!)
      const radios = [...view.container.querySelectorAll('input[type="radio"][name^="fallbacks-chain-tail-"]')] as HTMLInputElement[]
      fireEvent.click(radios[1]!)
    }
    fireEvent.click(view.container.querySelector('[data-chain-foot] button[class*="save"]')!)

    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const chains: Array<{ id: string }> = scripted.set.mock.calls[0]![0].args.patch.chains
    expect(chains.map(chain => chain.id)).toEqual(['Auto', 'night', 'chain-3', 'chain-4'])
  })

  it('does NOT persist an invalid pending chain staged in another tab', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    // Add a chain, leave it unnamed (label '' + empty entries = invalid), then
    // move to a sibling tab: the structural change alone would arm the save,
    // and chainsPatch() writes the whole draft list — so the section save must
    // stay blocked while ANY chain is invalid.
    fireEvent.click(view.container.querySelector('[data-tab-add]')!)
    expect([...view.container.querySelectorAll('[data-chain-tab]')]).toHaveLength(3)
    fireEvent.click(view.container.querySelector('[data-chain-tab="night"]')!)

    const save = view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // Firing the click anyway must not persist the pending row.
    fireEvent.click(save)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(scripted.set).not.toHaveBeenCalled()
    // The invalid tab still carries its own error mark.
    expect(view.container.querySelector('[data-chain-tab="chain-3"] [data-error-mark]')).not.toBeNull()
  })

  it('persists a newly ADDED chain (append survives the save)', async () => {
    const { view, scripted } = await mountCard({ config: v2Config(), catalog: effortCatalog() })
    fireEvent.click(view.container.querySelector('[data-tab-add]')!)
    // The new tab is active and INVALID until named + given a tail, so its
    // Save starts disarmed.
    const tabIds = () => [...view.container.querySelectorAll('[data-chain-tab]')]
      .map(tab => tab.getAttribute('data-chain-tab'))
    expect(tabIds()).toEqual(['Auto', 'night', 'chain-3'])
    expect((view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement).disabled).toBe(true)

    // Name it, then pick the 默认模型 tail.
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.change(view.container.querySelector('[data-menu-input]')!, { target: { value: '第三条链' } })
    fireEvent.click(view.container.querySelector('[data-menu-apply]')!)
    fireEvent.click(view.container.querySelector('[data-tail-option="deepseek-official/deepseek-v4-pro"] input')!)
    fireEvent.click(view.container.querySelector('[data-chain-foot] button[class*="save"]')!)

    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const chains: Array<{ id: string; label: string; entries: string[] }> = scripted.set.mock.calls[0]![0].args.patch.chains
    // The new chain is IN the payload (the append is expressible), the two
    // accepted chains keep their values.
    expect(chains.map(chain => chain.id)).toEqual(['Auto', 'night', 'chain-3'])
    expect(chains[2]).toMatchObject({ id: 'chain-3', label: '第三条链', entries: [OFFICIAL_PRO] })
    expect(chains[0]).toEqual(v2Config().chains[0])
    expect(chains[1]).toEqual(v2Config().chains[1])
  })

  it('persists a DELETED non-last chain without duplicating the next one', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    // Delete the FIRST chain (a non-last position: the old index patch wrote
    // the following chain into the deleted slot, producing a duplicate id the
    // gateway rejects).
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.click(view.container.querySelector('[data-menu-delete]')!)

    const tabs = [...view.container.querySelectorAll('[data-chain-tab]')] as HTMLButtonElement[]
    expect(tabs.map(tab => tab.getAttribute('data-chain-tab'))).toEqual(['night'])
    // The structural change alone arms the (otherwise clean) tab's Save.
    const save = view.container.querySelector('[data-chain-foot] button[class*="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const chains: Array<{ id: string }> = scripted.set.mock.calls[0]![0].args.patch.chains
    expect(chains.map(chain => chain.id)).toEqual(['night'])
    expect(chains[0]).toEqual(v2Config().chains[1])
  })

  it('persists a deleted LAST chain (the surviving slot is not the active index)', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    fireEvent.click(view.container.querySelector('[data-chain-tab="night"]')!)
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.click(view.container.querySelector('[data-menu-delete]')!)

    expect([...view.container.querySelectorAll('[data-chain-tab]')]).toHaveLength(1)
    fireEvent.click(view.container.querySelector('[data-chain-foot] button[class*="save"]')!)

    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const chains: Array<{ id: string }> = scripted.set.mock.calls[0]![0].args.patch.chains
    expect(chains.map(chain => chain.id)).toEqual(['Auto'])
  })

  it('blocks deleting the only remaining chain (≥1 rule)', async () => {
    const { view } = await mountCard({
      config: { ...v2Config(), chains: [v2Config().chains[0]!] },
    })
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    const remove = view.container.querySelector('[data-menu-delete]') as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    // Firing the click anyway is a no-op: the tab stays.
    fireEvent.click(remove)
    expect([...view.container.querySelectorAll('[data-chain-tab]')]).toHaveLength(1)
  })

  it('the chain save discards only the active chain', async () => {
    const { view } = await mountCard({ config: v2Config() })
    fireEvent.click(view.container.querySelector('[data-menu-btn]')!)
    fireEvent.change(view.container.querySelector('[data-menu-input]')!, { target: { value: 'x' } })
    fireEvent.click(view.container.querySelector('[data-menu-apply]')!)
    const discard = view.container.querySelector('[data-chain-foot] button[class*="discard"]') as HTMLButtonElement
    fireEvent.click(discard)
    expect(view.container.querySelector('[data-chain-tab="Auto"] [data-dirty-pip]')).toBeNull()
  })
})

describe('migrated v1 config (plan fallbacks-v1-auto-migration)', () => {
  /** The LIVE profile shape (synthetic ids/personas): v1 rootChain + array role chains. */
  const v1Descriptor = () => ({
    triggerCodes: ['AUTH'],
    rootChain: ['a/one', 'b/two', OFFICIAL_FLASH],
    timeSlots: [],
    roles: {
      rules: [{ role: 'alpha' }],
      list: [
        { id: 'alpha', persona: 'Alpha persona', chain: ['a/one', 'b/two'], fallback: 'inherit-root' },
        { id: 'beta', persona: 'Beta persona', chain: ['b/two'], fallback: 'none' },
      ],
    },
  })

  it('renders chain #0 plus both roles, with 未指定 selected and the chains offered', async () => {
    const migrated = parseFallbacksConfig(migrateLegacyConfig(v1Descriptor()))
    const { view } = await mountCard({ config: migrated as typeof defaultFallbacksConfig })

    // chain #0 is the migrated default chain.
    const tab = view.container.querySelector('[data-chain-tab="Auto"]')
    expect(tab).not.toBeNull()
    expect(tab!.textContent).toContain('默认链')

    // Both roles survived as identity rows.
    expect(view.container.querySelector('[data-role-card="alpha"]')).not.toBeNull()
    expect(view.container.querySelector('[data-role-card="beta"]')).not.toBeNull()

    // Each role's pointer select is present, UNSET, and offers the chains.
    expandRoleCards(view.container)
    const selects = [...view.container.querySelectorAll('[data-role-chain-select]')] as HTMLSelectElement[]
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      expect(select.value).toBe('')
      const values = [...select.options].map(option => option.value)
      expect(values).toEqual(['', 'Auto'])
    }
  })

  it('persists a re-attached 指定降级链 as the chain id string', async () => {
    const migrated = parseFallbacksConfig(migrateLegacyConfig(v1Descriptor()))
    const { view, scripted } = await mountCard({ config: migrated as typeof defaultFallbacksConfig })

    expandRoleCards(view.container)
    const selects = [...view.container.querySelectorAll('[data-role-chain-select]')] as HTMLSelectElement[]
    expect(selects).toHaveLength(2) // alpha + beta, both UNSET after the migration
    fireEvent.change(selects[0]!, { target: { value: 'Auto' } })

    const heading = view.container.querySelector('#fallbacks-subagents')!
    const save = [...heading.querySelectorAll('button')].at(-1) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = scripted.set.mock.calls.at(-1)![0].args.patch
    const alpha = patch.roles.list.find((role: { id: string }) => role.id === 'alpha')
    expect(alpha.chain).toBe('Auto')
    expect(typeof alpha.chain).toBe('string')
  })
})

describe('role cards (指定降级链)', () => {
  it('renders a role card with id, persona, and the chain-pointer select', async () => {
    const { view } = await mountCard({ config: v2Config() })
    expect(view.container.querySelector('[data-role-card="coder"]')).not.toBeNull()
    expandRoleCards(view.container)
    const select = view.container.querySelector('[data-role-chain-select]') as HTMLSelectElement
    const options = [...select.options].map(option => option.value)
    expect(options[0]).toBe('') // 未指定（沿用 dsh 默认）
    expect(options).toContain('Auto')
    expect(options).toContain('night')
    // Option labels carry the picker route.
    expect(select.textContent).toContain(`FallbacksChain/Auto`)
    // The chain help copy rides the info badge and DESCRIBES the select: the
    // badge's aria-label is the select's accessible description.
    const described = view.container.querySelector(`#${select.getAttribute('aria-describedby')}`) as HTMLElement
    expect(described).not.toBeNull()
    expect(described.getAttribute('role')).toBe('img')
    expect(described.getAttribute('aria-label')).toBe(en['roles.chain.tooltip'])
    expect(described.getAttribute('data-tip')).toBe(en['roles.chain.tooltip'])
    expect(view.container.querySelector('[data-role-card="coder"]')!.textContent)
      .not.toContain(en['roles.chain.tooltip'])
  })

  it('changing the pointer stages the roles save and writes the pointer', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    expandRoleCards(view.container)
    const select = view.container.querySelector('[data-role-chain-select]') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'night' } })
    const heading = view.container.querySelector('#fallbacks-subagents')!
    const save = [...heading.querySelectorAll('button')].at(-1) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const patch = scripted.set.mock.calls[0]![0].args.patch
    expect(patch.roles.list[0]).toEqual({ id: 'coder', persona: 'Coder', chain: 'night' })
    // Chains ride along UNCHANGED (the roles save does not touch them).
    expect(patch.chains).toEqual(v2Config().chains)
  })

  it('a saved pointer re-seeds the rows COLLAPSED with the accepted value', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    expandRoleCards(view.container)
    const select = view.container.querySelector('[data-role-chain-select]') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'night' } })
    const heading = view.container.querySelector('#fallbacks-subagents')!
    fireEvent.click([...heading.querySelectorAll('button')].at(-1)!)
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    const card = view.container.querySelector('[data-role-card="coder"]') as HTMLElement
    // The post-save re-seed rebuilds the rows from the accepted config:
    // collapsed again, with the saved chain's LABEL on the collapse meta (the
    // exact route stays in the title tooltip).
    await waitFor(() => expect(card.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false'))
    expect(card.querySelector('select')).toBeNull()
    expect(card.textContent).toContain('夜间')
    expect(card.textContent).not.toContain('FallbacksChain/night')
    expect(card.querySelector('[class*="collapseMeta"]')!.getAttribute('title')).toBe('FallbacksChain/night')
    // Re-opening the card shows the ACCEPTED pointer, not the stale draft.
    fireEvent.click(card.querySelector('[class*="collapseRow"] [aria-expanded="false"]')!)
    expect((card.querySelector('[data-role-chain-select]') as HTMLSelectElement).value).toBe('night')
  })

  it('the collapsed meta names the chain label or 未指定降级链 — never an auto mode', async () => {
    const { view } = await mountCard({
      config: { ...v2Config(), roles: { list: [{ id: 'coder', persona: '' }] } },
    })
    const card = view.container.querySelector('[data-role-card="coder"]')!
    const meta = () => card.querySelector('[class*="collapseMeta"]') as HTMLElement
    expect(meta().textContent).toBe(en['roles.chainMeta.unspecified'])
    // No pointer, no route tooltip.
    expect(meta().getAttribute('title')).toBe(en['roles.chainMeta.unspecified'])
    expect(card.textContent).not.toContain('自动')
    // Pick a chain → the meta shows its LABEL, the title keeps the route.
    expandRoleCards(view.container)
    const select = card.querySelector('[data-role-chain-select]') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'Auto' } })
    expect(meta().textContent).toBe('默认链')
    expect(meta().getAttribute('title')).toBe('FallbacksChain/Auto')
  })

  it('a dangling pointer renders the raw chain id', async () => {
    const { view } = await mountCard({
      config: { ...v2Config(), roles: { list: [{ id: 'coder', persona: '', chain: 'ghost' }] } },
    })
    const card = view.container.querySelector('[data-role-card="coder"]')!
    const meta = card.querySelector('[class*="collapseMeta"]') as HTMLElement
    // The chain is gone: no label to show, but never a blank meta.
    expect(meta.textContent).toBe('ghost')
    expect(meta.getAttribute('title')).toBe('FallbacksChain/ghost')
  })

  it('a chain with a blank label falls back to the raw chain id', async () => {
    const { view } = await mountCard({
      config: {
        ...v2Config(),
        chains: [...v2Config().chains, { id: 'blank', label: '', entries: [OFFICIAL_PRO], timeSlots: [] }],
        roles: { list: [{ id: 'coder', persona: '', chain: 'blank' }] },
      },
    })
    const card = view.container.querySelector('[data-role-card="coder"]')!
    const meta = card.querySelector('[class*="collapseMeta"]') as HTMLElement
    // A blank label has nothing to show: the id, never an empty meta.
    expect(meta.textContent).toBe('blank')
    expect(meta.getAttribute('title')).toBe('FallbacksChain/blank')
  })
})

describe('role card shape', () => {
  it('carries exactly ONE select — the 指定降级链 pointer', async () => {
    const { view } = await mountCard({ config: v2Config() })
    const card = view.container.querySelector('[data-role-card="coder"]')!
    expandRoleCards(view.container)
    expect(card.querySelectorAll('select')).toHaveLength(1)
  })

  it('mounts every role card COLLAPSED — no editor until the row is opened', async () => {
    const { view } = await mountCard({ config: v2Config() })
    const cards = [...view.container.querySelectorAll('[data-role-card]')]
    expect(cards).toHaveLength(1)
    for (const card of cards) {
      expect(card.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
      expect(card.querySelector('select')).toBeNull()
      expect(card.querySelector('textarea')).toBeNull()
    }
    // AC2: a staged edit survives an expand → collapse → expand round trip.
    const card = cards[0]!
    expandRoleCards(view.container)
    fireEvent.change(card.querySelector('[data-role-chain-select]')!, { target: { value: 'night' } })
    fireEvent.click(card.querySelector('[aria-expanded]')!)
    fireEvent.click(card.querySelector('[aria-expanded]')!)
    expect((card.querySelector('[data-role-chain-select]') as HTMLSelectElement).value).toBe('night')
  })

  it('keeps per-row collapse state independent', async () => {
    const twoRoles = {
      ...v2Config(),
      roles: { list: [{ id: 'alpha', persona: '', chain: 'Auto' }, { id: 'beta', persona: '', chain: '' }] },
    }
    const { view } = await mountCard({ config: twoRoles })
    const alpha = view.container.querySelector('[data-role-card="alpha"]')!
    const beta = view.container.querySelector('[data-role-card="beta"]')!
    expect(alpha.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
    expect(beta.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
    // Expanding alpha leaves beta on its own collapsed row.
    fireEvent.click(alpha.querySelector('[class*="collapseRow"] [aria-expanded="false"]')!)
    expect(alpha.querySelector('[data-role-chain-select]')).not.toBeNull()
    expect(beta.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
    expect(beta.querySelector('select')).toBeNull()
  })

  it('collapses to ONE row: no select, no persona, no footer; delete sits beside the toggle', async () => {
    const { view, props } = await mountCard({ config: v2Config() })
    const card = view.container.querySelector('[data-role-card="coder"]') as HTMLElement
    const row = card.querySelector('[class*="collapseRow"]') as HTMLElement
    // T2/AC3: the compact card tier + the row and nothing else (6px/12px
    // padding and a 10px gap leave the collapsed card one ~40px row).
    expect(card.getAttribute('class')).toContain('roleCard')
    expect(card.children).toHaveLength(1)
    expect(card.querySelector('select')).toBeNull()
    expect(card.querySelector('textarea')).toBeNull()
    expect(card.querySelector('[class*="cardFoot"]')).toBeNull()
    // Role id on the left, the current chain's label on the right.
    expect(row.textContent).toContain('coder')
    expect(row.textContent).toContain('默认链')
    // The delete action is a SIBLING of the collapse button (never nested:
    // a nested button is invalid HTML and double-activates the row).
    const buttons = [...row.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(buttons[0]!.contains(buttons[1]!)).toBe(false)
    // F3: both row controls name the ROLE (id + chain label), not a generic
    // action — otherwise every row of the list sounds identical. The module
    // `t` seat does not interpolate, so this rerenders with the concrete one.
    view.rerender(<FallbacksCard {...props} t={interpolatingT} />)
    const namedRow = view.container.querySelector('[data-role-card="coder"] [class*="collapseRow"]') as HTMLElement
    const named = [...namedRow.querySelectorAll('button')]
    expect(named[0]!.getAttribute('aria-label')).toBe('Expand role coder')
    expect(named[1]!.getAttribute('aria-label')).toBe('Remove role coder (默认链)')
    // The visible bubble stays short — a nowrap tooltip carrying the identity
    // would overflow the row's trailing edge.
    expect(named[1]!.getAttribute('data-tip')).toBe('Remove this role')
    // Re-expanding restores the chain select and the persona field.
    fireEvent.click(named[0]!)
    expect(card.querySelector('select')).not.toBeNull()
    expect(card.querySelector('textarea')).not.toBeNull()
    expect(named[0]!.getAttribute('aria-label')).toBe('Collapse role coder')
    // Clicking the toggle again collapses the body back to the one-row card.
    fireEvent.click(named[0]!)
    expect(card.querySelector('select')).toBeNull()
    expect(named[0]!.getAttribute('aria-expanded')).toBe('false')
  })

  it('the legacy migration banner renders for v1 keys', async () => {
    const { view } = await mountCard({ config: v2Config(), legacyKeys: ['rootChain'] })
    expect(view.container.textContent).toContain('Legacy fields detected')
  })
})

describe('info badge (T3)', () => {
  it('renders a neutral "i" and keeps aria-label + data-tip on every mark', async () => {
    const { view } = await mountCard({ config: v2Config() })
    const badge = view.container.querySelector('[class*="infoHint"]') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe('i')
    expect(badge.getAttribute('role')).toBe('img')
    expect(badge.getAttribute('aria-label')).toBe(en['chains.name.tooltip'])
    expect(badge.getAttribute('data-tip')).toBe(en['chains.name.tooltip'])
    expect(badge.getAttribute('tabindex')).toBe('0')
    // No error-shaped "!" is left on any info mark of the screen.
    const marks = [...view.container.querySelectorAll('[class*="infoHint"]')]
    expect(marks.length).toBeGreaterThan(1)
    for (const mark of marks) expect(mark.textContent).toBe('i')
  })
})

describe('failed client-start warm-up', () => {
  it('opening the card retries the dead config and catalog reads', async () => {
    const scripted = scriptedApi({ config: v2Config() })
    // The client warms the shared store at start (PR #197), so the card's mount
    // can find an ALREADY failed read: both paths must be retried there.
    scripted.describe.mockImplementationOnce(() => Promise.reject(new Error('warm describe failed')))
    scripted.models.mockImplementationOnce(() => Promise.reject(new Error('warm catalog failed')))
    const controller = new FallbacksSettingsController(scripted.api, scripted.rpc)
    await controller.load()
    await controller.loadCatalog()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().catalogStatus).toBe('error')

    const view = render(<FallbacksCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)

    // The retry lands the accepted config (the fetched chains, not the empty
    // default skeleton) and leaves no error surface behind.
    await waitFor(() => expect(view.container.querySelector('[data-chain-tab="Auto"]')).not.toBeNull())
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().catalogStatus).toBe('ready')
  })
})

describe('read-only mode', () => {
  it('disables the tab affordances and forces the cards open', async () => {
    const { view } = await mountCard({ config: v2Config(), writable: false })
    expect((view.container.querySelector('[data-tab-add]') as HTMLButtonElement).disabled).toBe(true)
    // The role card is expanded (read-only forces content disclosures open).
    const card = view.container.querySelector('[data-role-card="coder"]')!
    expect(card.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
    // Edit-control info marks leave the tab order (AC4); the chain explanation
    // is information, not an edit control, so its badge stays reachable even
    // when the surface is read-only.
    const marks = [...view.container.querySelectorAll('[class*="infoHint"]')]
    const chainHint = marks.find(mark => mark.getAttribute('aria-label') === en['roles.chain.tooltip'])!
    const neighbour = marks.find(mark => mark !== chainHint)!
    expect(chainHint.getAttribute('tabindex')).toBe('0')
    expect(neighbour.getAttribute('tabindex')).toBe('-1')
  })
})
