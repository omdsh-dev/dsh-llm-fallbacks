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
import { defaultFallbacksConfig } from '../src/config.ts'
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

  it('the 默认模型 radio owns the LAST entry (tail) and save validation blocks a non-official tail', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
    // Pick Pro: the last selector row becomes deepseek-official/deepseek-v4-pro.
    const radios = [...view.container.querySelectorAll('input[type="radio"][name^="fallbacks-chain-tail-"]')] as HTMLInputElement[]
    fireEvent.click(radios[1]!)
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

describe('role cards (指定降级链)', () => {
  it('renders a role card with id, persona, and the chain-pointer select', async () => {
    const { view } = await mountCard({ config: v2Config() })
    expect(view.container.querySelector('[data-role-card="coder"]')).not.toBeNull()
    const select = view.container.querySelector('[data-role-chain-select]') as HTMLSelectElement
    const options = [...select.options].map(option => option.value)
    expect(options[0]).toBe('') // 未指定（沿用 dsh 默认）
    expect(options).toContain('Auto')
    expect(options).toContain('night')
    // Option labels carry the picker route.
    expect(select.textContent).toContain(`FallbacksChain/Auto`)
  })

  it('changing the pointer stages the roles save and writes the pointer', async () => {
    const { view, scripted } = await mountCard({ config: v2Config() })
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

  it('the collapsed meta names the specified route or 未指定降级链 — never an auto mode', async () => {
    const { view } = await mountCard({
      config: { ...v2Config(), roles: { list: [{ id: 'coder', persona: '' }] } },
    })
    const card = view.container.querySelector('[data-role-card="coder"]')!
    expect(card.textContent).toContain(en['roles.chainMeta.unspecified'])
    expect(card.textContent).not.toContain('自动')
    // Pick a chain → meta shows the route.
    const select = card.querySelector('[data-role-chain-select]') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'Auto' } })
    expect(card.textContent).toContain('FallbacksChain/Auto')
  })
})

describe('removed surfaces', () => {
  it('no 运行状态 status block, no host-policy block, no subagentPolicy state', async () => {
    const { view } = await mountCard({ config: v2Config() })
    expect(view.container.querySelector('[data-status-block]')).toBeNull()
    expect(view.container.textContent).not.toContain(en['status.title'] ?? '运行状态')
    expect(view.container.textContent).not.toContain('宿主子代理模型策略')
    expect(view.queryAllByText(/FallbacksChain\/Auto（?自动/).length).toBe(0)
  })

  it('no role-rules editor and no per-role chain entries editor', async () => {
    const { view } = await mountCard({ config: v2Config() })
    expect(view.container.textContent).not.toContain(en['roles.rules'])
    // The role card body carries NO provider/model selector lists (only the
    // single chain-pointer select).
    const card = view.container.querySelector('[data-role-card="coder"]')!
    expect(card.querySelectorAll('select')).toHaveLength(1)
  })

  it('the legacy migration banner renders for v1 keys', async () => {
    const { view } = await mountCard({ config: v2Config(), legacyKeys: ['rootChain'] })
    expect(view.container.textContent).toContain('Legacy config fields detected')
  })
})

describe('read-only mode', () => {
  it('disables the tab affordances and forces the cards open', async () => {
    const { view } = await mountCard({ config: v2Config(), writable: false })
    expect((view.container.querySelector('[data-tab-add]') as HTMLButtonElement).disabled).toBe(true)
    // The role card is expanded (read-only forces content disclosures open).
    const card = view.container.querySelector('[data-role-card="coder"]')!
    expect(card.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
  })
})
