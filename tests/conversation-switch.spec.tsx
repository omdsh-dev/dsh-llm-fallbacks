// @vitest-environment jsdom
/**
 * Conversation-level fallback-switch visibility (plan fallbacks-aux-seams,
 * task 2): D1 node-definition spec + D2 keyed-seat registration spec +
 * rendered transcript-line spec.
 *
 * Registration surface: the fake slots runtime runs the inject callbacks
 * (both generator and plain-disposer shapes) and records every register
 * call; the fake conversationEvents runtime records the node definition.
 * Pins the contract: the `conversation.chat.node` ledger holds one entry
 * with key 'fallbacks-switch' + locale 'fallbacks' rendering
 * ConversationFallbackSwitch, the events ledger holds the
 * 'fallbacks-switch' Definition (kind/target/match/start/update/
 * buildViewNode), and the two settings registrations (plugin card +
 * general row) are untouched.
 *
 * Definition behavior: match accepts only `fallbacks/switch` (id = event
 * seq, role start), start snapshots the event payload, update is a
 * passthrough, and buildViewNode materializes the chat node at the event's
 * anchor seq — the non-surface event the `unknown-surface` fallback never
 * picked up becomes visible.
 *
 * Rendered states: one compact system-style line — dim title + separator +
 * ellipsized summary (`{from} → {to} ({role} · {reason})`), role="status";
 * an unknown reason value renders raw (forward-compatible durable log); a
 * malformed/partial payload degrades to the title-only line (no throw);
 * the zh dictionary renders through the same seat (parity smoke).
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatConversationViewNode, ConversationMatch,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  ConversationFallbackSwitch, fallbackSwitchDefinition,
} from '../src/client/ConversationFallbackSwitch.tsx'
import type { ConversationFallbackSwitchProps } from '../src/client/ConversationFallbackSwitch.tsx'
import { apply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'

afterEach(cleanup)

/** The `fallbacks-switch` kind string (must match the node definition). */
const KIND = 'fallbacks-switch'

/**
 * The synthesized `t` seat's key domain is the namespace dictionary union
 * plus the shared `common` vocabulary; the specs only ever call the node's
 * own keys. The test seat performs the framework's `{name}` interpolation
 * (the real `t` synthesizes it from the dictionary's declared placeholders).
 */
function makeT(dict: Record<string, string>): ConversationFallbackSwitchProps['t'] {
  return ((key, params) => {
    let text: string = dict[key]
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value))
      }
    }
    return text
  }) as ConversationFallbackSwitchProps['t']
}

/** English seat (primary render assertions). */
const t = makeT(en)
/** Simplified-Chinese seat (parity smoke, zh is the copy source of truth). */
const tZh = makeT(zh)

/**
 * A non-switch event fixture (the Definition's `match` only reads `type`;
 * the payload is intentionally minimal — it must never match).
 */
function unrelatedEvent(type: string, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data: {} } as unknown as SessionEvent
}

/** One `fallbacks/switch` session event with a deterministic seq/time. */
function switchEvent(
  seq: number,
  overrides: Partial<FallbacksSwitchEventData> = {},
): SessionEvent<'fallbacks/switch'> {
  return {
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
  }
}

/** The engine-owned Context key for one switch (conversationContextKey shape). */
function contextKey(seq: number): string {
  return `${KIND.length}:${KIND}${seq}`
}

/** Full renderer props the keyed seat would compose (the renderer only reads `node` + `t`; the standard-kit members are `as never` — same pattern as the card/row specs). */
function switchProps(
  node: ChatNode<'fallbacks-switch'>,
  localeT: ConversationFallbackSwitchProps['t'] = t,
): ConversationFallbackSwitchProps {
  return {
    node,
    t: localeT,
    useSessions: undefined as never,
    useWorkspaces: undefined as never,
    useSession: undefined as never,
    sessionId: undefined as never,
    useProjection: undefined as never,
    useInput: undefined as never,
    inputActions: undefined as never,
    useTurnData: undefined as never,
    openFile: undefined as never,
    inspectCall: undefined as never,
    forkAt: undefined as never,
    loadImage: undefined as never,
    fileMentions: undefined as never,
  }
}

/** Drive the Definition end-to-end (match → start → buildViewNode) for one event. */
function nodeFor(event: SessionEvent<'fallbacks/switch'>): ChatNode<'fallbacks-switch'> {
  const result = fallbackSwitchDefinition.match(event)
  expect(result).toEqual({ id: String(event.seq), role: 'start' })
  const match: ConversationMatch = {
    event,
    view: undefined,
    role: 'start',
    location: { kind: 'session' },
  }
  const state = fallbackSwitchDefinition.start(
    {
      key: contextKey(event.seq), kind: KIND, id: String(event.seq),
      matches: [match], start: match, state: undefined, current: new Map(),
    },
    match,
    {} as never,
  )
  const view = fallbackSwitchDefinition.buildViewNode?.({
    key: contextKey(event.seq), kind: KIND, id: String(event.seq),
    matches: [match], start: match, state, current: new Map(),
  })
  expect(view).not.toBeNull()
  return view as ChatNode<'fallbacks-switch'>
}

/**
 * A minimal fake of the client slots + conversationEvents services for the
 * registration ledger test (the card/general-row spec pattern, extended
 * with the events registry): `inject(name, callback)` runs the callback and
 * records every `register` call (both the generator shape — settings slots —
 * and the plain-disposer shape — the chat-node seat, matching
 * `ctx.slots.inject`'s accepted callback forms); `conversationEvents
 * .register(definition)` records the Definition; `ctx.get('connection')`
 * serves an inert wire face; everything else apply() touches is recorded
 * but inert.
 */
function fakeRuntime() {
  const slotsLedger: Record<string, Array<{ name: string; options: Record<string, unknown>; component: unknown }>> = {}
  const eventsLedger: unknown[] = []
  const disposers: Array<() => void> = []
  const locales: Record<string, unknown> = {}
  const slots = {
    register: (options: Record<string, unknown>, component: unknown): (() => void) => {
      const name = options.name as string
      ;(slotsLedger[name] ??= []).push({ name, options, component })
      return () => {}
    },
    inject: (name: string, callback: () => unknown): (() => void) => {
      const result = callback()
      if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
        for (const dispose of result as Iterable<() => void>) disposers.push(dispose)
      } else if (typeof result === 'function') {
        disposers.push(result as () => void)
      }
      return () => { for (const dispose of disposers.splice(0)) dispose() }
    },
  }
  const ctx = {
    slots,
    conversationEvents: {
      register: (definition: unknown): (() => void) => {
        eventsLedger.push(definition)
        return () => {}
      },
    },
    locale: {
      register: (ns: string, dict: unknown): (() => void) => {
        locales[ns] = dict
        return () => { delete locales[ns] }
      },
      bind: (): never => { throw new Error('test: apply must not bind t — the node t seat comes from PropsLocale') },
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
    },
  }
  return { ctx, slotsLedger, eventsLedger, locales }
}

describe('conversation switch registration (D1 definition + D2 keyed seat)', () => {
  it('registers the fallbacks-switch Definition and keyed chat renderer', () => {
    const { ctx, slotsLedger, eventsLedger, locales } = fakeRuntime()
    apply(ctx as unknown as Parameters<typeof apply>[0])

    // D1: exactly one Definition, the fallbacks-switch node.
    expect(eventsLedger).toHaveLength(1)
    const definition = eventsLedger[0] as {
      kind: string
      target?: string
      match: (event: unknown) => unknown
      start: (context: unknown, match: unknown) => unknown
      update: (context: { state: unknown }) => unknown
      buildViewNode?: (context: unknown) => unknown
    }
    expect(definition.kind).toBe('fallbacks-switch')
    expect(definition.target).toBe('chat')
    expect(typeof definition.match).toBe('function')
    expect(typeof definition.start).toBe('function')
    expect(typeof definition.update).toBe('function')
    expect(typeof definition.buildViewNode).toBe('function')

    // D2: the chat.node ledger holds exactly one fallbacks keyed renderer.
    const nodes = slotsLedger['conversation.chat.node'] ?? []
    expect(nodes).toHaveLength(1)
    expect(nodes[0].options.key).toBe('fallbacks-switch')
    expect(nodes[0].options.locale).toBe('fallbacks')
    expect(nodes[0].component).toBe(ConversationFallbackSwitch)

    // The two settings registrations are untouched.
    const cards = slotsLedger['settings.plugin.item'] ?? []
    expect(cards).toHaveLength(1)
    expect(cards[0].options.id).toBe('fallbacks')
    const rows = slotsLedger['settings.general.item'] ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0].options.id).toBe('fallbacks')

    // The dictionary namespace registers with the en/zh pair.
    expect(locales['fallbacks']).toEqual({ zh, en })
  })
})

describe('fallbackSwitchDefinition (D1 node state machine)', () => {
  it('matches only fallbacks/switch events, id = event seq, role start', () => {
    const event = switchEvent(42)
    expect(fallbackSwitchDefinition.match(event)).toEqual({ id: '42', role: 'start' })
    // Unrelated events (surface and non-surface alike) are rejected.
    expect(fallbackSwitchDefinition.match(unrelatedEvent('user/message', 1))).toBeNull()
    expect(fallbackSwitchDefinition.match(unrelatedEvent('turn/end', 2))).toBeNull()
  })

  it('start snapshots the switch payload; update is a passthrough', () => {
    const event = switchEvent(7, { reason: 'always-cap', role: 'research' })
    const node = nodeFor(event)
    const data = node.data
    expect(data.seq).toBe(7)
    expect(data.time).toBe(event.time)
    expect(data.turn).toBe(1)
    expect(data.step).toBe(1)
    expect(data.from).toEqual({ provider: 'openai', model: 'gpt-4o' })
    expect(data.to).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet' })
    expect(data.role).toBe('research')
    expect(data.reason).toBe('always-cap')

    const context = {
      key: contextKey(7), kind: KIND, id: '7',
      matches: [] as ConversationMatch[], start: undefined,
      state: data, current: new Map(),
    }
    expect(fallbackSwitchDefinition.update(context, {} as never)).toBe(data)
  })

  it('start refuses a non-switch event (defensive invariant)', () => {
    const match = {
      event: { type: 'user/message', seq: 1, time: 1, data: {} },
      view: undefined,
      role: 'start' as const,
      location: { kind: 'session' as const },
    }
    expect(() => fallbackSwitchDefinition.start({
      key: 'x', kind: KIND, id: '1',
      matches: [], start: undefined, state: undefined, current: new Map(),
    }, match as unknown as ConversationMatch, {} as never)).toThrow(/fallbacks\/switch/)
  })

  it('buildViewNode materializes the chat node at the event anchor seq', () => {
    const node = nodeFor(switchEvent(9))
    expect(node.kind).toBe('fallbacks-switch')
    expect(node.target).toBe('chat')
    expect(node.id).toBe('9')
    expect(node.anchorSeq).toBe(9)
    expect(node.visibility).toBe('visible')
    expect(node.location).toEqual({ kind: 'session' })
    expect(node.key).toBe(contextKey(9))
    // The node is a valid ChatConversationViewNode shape.
    const view = node as unknown as ChatConversationViewNode
    expect(view.data).toBe(node.data)
  })

  it('buildViewNode returns null while the Context has no start/state', () => {
    expect(fallbackSwitchDefinition.buildViewNode?.({
      key: contextKey(1), kind: KIND, id: '1',
      matches: [], start: undefined, state: undefined, current: new Map(),
    })).toBeNull()
  })
})

describe('ConversationFallbackSwitch rendered line', () => {
  it('renders the compact system line from a switch payload', () => {
    render(<ConversationFallbackSwitch {...switchProps(nodeFor(switchEvent(5)))} />)
    expect(screen.getByText(en['chat.switch.title'])).toBeTruthy()
    expect(screen.getByText(
      'openai/gpt-4o → anthropic/claude-3-5-sonnet (default · trigger code)',
    )).toBeTruthy()
    // The line is announced as a status row (non-interactive system notice).
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })

  it('renders the always-cap reason through the shared reason map', () => {
    render(<ConversationFallbackSwitch {...switchProps(nodeFor(switchEvent(5, { reason: 'always-cap' })))} />)
    expect(screen.getByText(
      'openai/gpt-4o → anthropic/claude-3-5-sonnet (default · always-mode cap)',
    )).toBeTruthy()
  })

  it('renders an unknown reason value raw (forward-compatible log)', () => {
    render(<ConversationFallbackSwitch {...switchProps(nodeFor(switchEvent(3, { reason: 'future-reason' as never })))} />)
    expect(screen.getByText(
      'openai/gpt-4o → anthropic/claude-3-5-sonnet (default · future-reason)',
    )).toBeTruthy()
  })

  it('renders the zh copy through the shared dictionary (parity smoke)', () => {
    render(<ConversationFallbackSwitch {...switchProps(nodeFor(switchEvent(4)), tZh)} />)
    expect(screen.getByText(zh['chat.switch.title'])).toBeTruthy()
    expect(screen.getByText(
      'openai/gpt-4o → anthropic/claude-3-5-sonnet（default · 触发失败码）',
    )).toBeTruthy()
  })

  it('degrades to a title-only line on a malformed payload (no throw)', () => {
    // Version skew: the durable session log is append-only, so a node may
    // carry a partial/corrupted payload snapshot (e.g. missing from/to).
    // Interpolation must not throw; the slot renders a truthful title only.
    const node = nodeFor(switchEvent(2))
    const malformed = {
      ...node,
      data: { seq: 2, time: node.data.time, turn: 1, step: 1 },
    }
    expect(() => render(
      <ConversationFallbackSwitch {...switchProps(malformed as ChatNode<'fallbacks-switch'>)} />,
    )).not.toThrow()
    expect(screen.getByText(en['chat.switch.title'])).toBeTruthy()
  })
})
