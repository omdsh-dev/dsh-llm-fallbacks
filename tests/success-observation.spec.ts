/**
 * P3 success-observation integration tests (plan fallbacks-half-open-recovery
 * Task 3, P5): the plugin-scope `session/event` subscription that closes
 * half-open circuits on observed completions.
 *
 * Drives the REAL plugin `apply()` against the shared harness. The half-open
 * entry is seeded through the `stateStore(ctx)` seam (the decide/commit
 * half-open wiring is Task 4), then `session/event` is emitted through the
 * SAME context the listener is registered on — the P5 driver
 * (`ctx.emit('session/event', agent.session, event)`), mirroring the real
 * post-commit append firehose.
 *
 * Covers the P3 filter chain (type → mode → interrupted → source.kind), the
 * `session.id` agent-identity lookup (peek purity — F-004), and rule 6
 * (close only from half-open) at the listener level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, type AssistantMessage } from '@deepseek-ai/dsh-llm'
import { apply, stateStore } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, emitAssistantMessage, makeAgent } from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

/** Seed a half-open entry for `key` through the real store API (rule 3). */
function seedHalfOpen(agentId: string, key: string, until: number, now: number): void {
  const store = stateStore(ctx)
  expect(store).toBeDefined()
  const state = store!.get(agentId)
  store!.suppress(state, key, until)
  expect(store!.isSuppressed(state, key, now, 'half-open')).toBe(false)
  expect(state.recovery.isHalfOpen(key)).toBe(true)
}

describe('P3 success observation — session/event listener (plan fallbacks-half-open-recovery)', () => {
  it('closes a half-open circuit on an observed completion (rule 6)', () => {
    const { agent } = makeAgent('p3-close', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    const store = stateStore(ctx)!
    const state = store.get(agent.id)
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')).toBe(false)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o' })

    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.halfOpenEntries()).toEqual([])
  })

  it('ignores a completion from a different route (provenance match via selectorKey)', () => {
    const { agent } = makeAgent('p3-route', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    seedHalfOpen(agent.id, 'mock/gpt-4o', 1_000, 2_000)

    emitAssistantMessage(ctx, agent, { provider: 'other', model: 'gpt-4o' })

    expect(stateStore(ctx)!.peek(agent.id)!.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
  })

  it('ignores an interrupted completion (rule 7 — neither success nor failure)', () => {
    const { agent } = makeAgent('p3-interrupted', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    seedHalfOpen(agent.id, 'mock/gpt-4o', 1_000, 2_000)

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o', interrupted: true })

    expect(stateStore(ctx)!.peek(agent.id)!.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
  })
  it('an interrupted completion does not reset a nonzero escalation exponent (rule 7, PR #87 review point 2c)', () => {
    const { agent } = makeAgent('p3-interrupted-n', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    const store = stateStore(ctx)!
    const state = store.get(agent.id)
    // Seed a half-open episode carrying a nonzero consecutive-failure
    // counter (a probe failure escalates to n+1 — rule 5). NOT via the
    // markHalfOpen-from-clean path: recordFailure first, then the lapsed
    // suppression transitions the EXISTING entry to half-open, so the
    // counter survives the episode.
    state.recovery.recordFailure('mock/gpt-4o')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')).toBe(false)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o', interrupted: true })

    // The interrupted completion is neutral: close is not called, the entry
    // survives with its counter — the next failure still escalates to n+1.
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
    expect(state.recovery.recordFailure('mock/gpt-4o')).toBe(2)
  })

  it('ignores a non-model message source (source.kind filter)', () => {
    const { agent } = makeAgent('p3-source', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    seedHalfOpen(agent.id, 'mock/gpt-4o', 1_000, 2_000)

    // A plugin-produced assistant message (e.g. injected context) carries a
    // non-model source and must not close the circuit.
    const message = {
      ...createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], provider: 'mock', model: 'gpt-4o' }),
      source: { kind: 'plugin', plugin: 'test' },
    } as unknown as AssistantMessage
    ctx.emit('session/event', agent.session, {
      type: 'assistant/message',
      seq: agent.session.seq,
      time: Date.now(),
      data: { turn: 1, step: 1, message },
    })

    expect(stateStore(ctx)!.peek(agent.id)!.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
  })

  it('ignores non-assistant/message events (type filter)', () => {
    const { agent } = makeAgent('p3-type', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    seedHalfOpen(agent.id, 'mock/gpt-4o', 1_000, 2_000)

    ctx.emit('session/event', agent.session, {
      type: 'turn/start',
      seq: agent.session.seq,
      time: Date.now(),
      data: { turn: 1 },
    })

    expect(stateStore(ctx)!.peek(agent.id)!.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
  })

  it('timer mode: the listener is zero-effect (mode gate)', () => {
    const { agent } = makeAgent('p3-timer', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg()) // default recovery: 'timer'
    const store = stateStore(ctx)!
    const state = store.get(agent.id)
    // Seed a half-open entry through the store seam — under timer mode the
    // listener must early-out on the mode check and leave it untouched.
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')).toBe(false)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o' })

    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
  })

  it('revertPolicy never: the mechanism is inert (Infinity never transitions)', () => {
    const { agent } = makeAgent('p3-never', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open', revertPolicy: 'never' }))
    const store = stateStore(ctx)!
    const state = store.get(agent.id)
    store.suppress(state, 'mock/gpt-4o', Number.POSITIVE_INFINITY)
    expect(store.isSuppressed(state, 'mock/gpt-4o', Number.MAX_SAFE_INTEGER, 'half-open')).toBe(true)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o' })

    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
  })

  it('does not close an actively suppressed entry (stale success no-op)', () => {
    const { agent } = makeAgent('p3-suppressed', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    const store = stateStore(ctx)!
    const state = store.get(agent.id)
    state.recovery.recordFailure('mock/gpt-4o')
    store.suppress(state, 'mock/gpt-4o', 10_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 5_000, 'half-open')).toBe(true)

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o' })

    // The entry survives with its counter — a stale in-flight success must
    // not cancel a fresher escalated re-suppression.
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.recordFailure('mock/gpt-4o')).toBe(2)
  })

  it('ignores events for sessions with no tracked state (peek purity, F-004)', () => {
    const { agent } = makeAgent('p3-unknown', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ recovery: 'half-open' }))
    expect(stateStore(ctx)?.peek(agent.id)).toBeUndefined()

    emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o' })

    // The listener must not grow the store (peek, never create).
    expect(stateStore(ctx)?.peek(agent.id)).toBeUndefined()
  })
})
