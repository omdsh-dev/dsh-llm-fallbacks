/**
 * Half-open recovery under direction C (plan dsh-022-rc1-upgrade §3.3): the
 * circuit is observed and written by the CHAIN WALK — success closes it at
 * attempt level (no `session/event` observer exists any more), failures cool
 * the route with bounded geometric escalation, and an exhausted chain on a
 * half-open episode re-suppresses the probe (rule 5b) because the walk's single
 * suppression write IS the escalation write.
 *
 * Walk-level: real `LlmRuntime`, one scripted adapter, a shared
 * `FallbackStateStore`.
 *
 * @module tests/runtime-recovery
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { walkChain } from '../src/chain-walk.ts'
import { ESCALATION_CAP_MS, escalatedCooldownMs } from '../src/recovery.ts'
import { FallbackStateStore } from '../src/state.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { cfg, walkDeps } from './support/harness.ts'

const COOLDOWN_MS = 60_000

/** Scripted adapter: every attempt fails with a route-scoped trigger code. */
class FailingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  failure: { code: string; message?: string } | undefined = { code: 'AUTH', message: 'down' }

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override listModels() {
    return Promise.resolve([])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.failure !== undefined) throw new LlmError(this.failure.message ?? this.failure.code, this.failure.code)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Drain a chunk stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

let ctx: Context
let adapter: FailingAdapter

beforeEach(() => {
  // Pin the wall clock INSIDE the fixture's 00:00–23:59 slot row: `end` is
  // exclusive, so under the real clock the 23:59 minute would route to the
  // official all-day tail this suite never registers (QC1-F3). Only `Date` is
  // faked — the runtime and the fiber teardown keep real timers.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-18T04:00:00Z') })
  ctx = new Context()
  new LlmRuntime(ctx)
  adapter = new FailingAdapter()
  ctx.llm.registerAdapter(['a', 'b'], adapter)
})

afterEach(async () => {
  // Back to the real clock BEFORE disposal so teardown never runs faked.
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

/**
 * One walk over the chain under test. The chain rides a full-day slot row so
 * the all-day tail stays conforming (the picker row's documented gate).
 */
function walkOnce(states: FallbackStateStore, chain: readonly string[], recovery: 'timer' | 'half-open', info?: (message: string, ...args: unknown[]) => void) {
  const config = cfg({
    rootChain: ['deepseek-official/deepseek-flash'],
    timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: [...chain] }],
    cooldownMs: COOLDOWN_MS,
    recovery,
  })
  return collect(walkChain(
    walkDeps({
      readConfig: () => config,
      getLlm: () => ctx.llm,
      states,
      ...(info === undefined ? {} : { log: { info, warn: () => {} } }),
    }),
    { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [], sessionId: SessionId('s1') },
  ))
}

describe('half-open: attempt-level success closes the circuit', () => {
  it('closes a served route’s episode on a normal finish', async () => {
    const states = new FallbackStateStore()
    const state = states.get('s1')
    state.recovery.markHalfOpen('a/1', Date.now())
    expect(state.recovery.isHalfOpen('a/1')).toBe(true)

    adapter.failure = undefined
    await walkOnce(states, ['a/1'], 'half-open')

    expect(state.recovery.isHalfOpen('a/1')).toBe(false)
  })

  it('logs the probe admission line on the walk’s admission', async () => {
    const states = new FallbackStateStore()
    // The store is only grown by a real write; a session with cross-call
    // memory (a cooled route) is the shape an admission happens in.
    const state = states.get('s1')
    state.cooldown.suppress('a/1', Date.now() - 1)
    const info = vi.fn()

    adapter.failure = undefined
    await walkOnce(states, ['a/1'], 'half-open', info)

    const probes = info.mock.calls.filter((call) => String(call[0]).includes('half-open probe'))
    // Rule 4: the marker is an admission log, not a gate — one line for the
    // episode's first admission.
    expect(probes).toHaveLength(1)
  })
})

describe('half-open: failure escalation (rules 1/2/5b)', () => {
  it('escalates the suppression by the consecutive-failure counter', async () => {
    const states = new FallbackStateStore()
    const before = Date.now()
    await walkOnce(states, ['a/1'], 'half-open')

    const until = states.peek('s1')?.cooldown.peek('a/1') ?? 0
    // n = 1 is the flat cooldown; the write is bounded and future-dated.
    expect(until - before).toBeGreaterThanOrEqual(COOLDOWN_MS)
    expect(until).toBeLessThanOrEqual(Date.now() + escalatedCooldownMs(COOLDOWN_MS, 2))
    expect(states.peek('s1')?.recovery.isHalfOpen('a/1')).toBe(false)
  })

  it('re-suppresses an exhausted probe with the escalated duration (rule 5b)', async () => {
    const states = new FallbackStateStore()
    const state = states.get('s1')
    // Two prior failures: the next write must use the ×2 exponent.
    state.recovery.recordFailure('a/1')
    state.recovery.recordFailure('a/1')

    await walkOnce(states, ['a/1'], 'half-open')

    const until = state.cooldown.peek('a/1') ?? 0
    const escalated = escalatedCooldownMs(COOLDOWN_MS, 3)
    // The single-route chain has no surviving target, so the walk's write IS
    // rule 5b's re-suppression: the escalated duration, not the flat one.
    expect(until - Date.now()).toBeGreaterThan(COOLDOWN_MS)
    expect(until - Date.now()).toBeLessThanOrEqual(escalated)
  })

  it('caps escalation at one hour', () => {
    expect(escalatedCooldownMs(COOLDOWN_MS, 1)).toBe(COOLDOWN_MS)
    expect(escalatedCooldownMs(COOLDOWN_MS, 2)).toBe(COOLDOWN_MS * 2)
    expect(escalatedCooldownMs(COOLDOWN_MS, 99)).toBe(ESCALATION_CAP_MS)
  })
})

describe('timer mode stays flat and inert', () => {
  it('writes a flat cooldown and no half-open marker', async () => {
    const states = new FallbackStateStore()
    const before = Date.now()

    await walkOnce(states, ['a/1'], 'timer')

    const state = states.peek('s1')!
    const until = state.cooldown.peek('a/1') ?? 0
    expect(until - before).toBeGreaterThanOrEqual(COOLDOWN_MS)
    expect(until - before).toBeLessThan(COOLDOWN_MS * 3)
    expect(state.recovery.isHalfOpen('a/1')).toBe(false)
  })

  it('never logs a probe line', async () => {
    const states = new FallbackStateStore()
    const info = vi.fn()
    await walkOnce(states, ['a/1'], 'timer', info)
    expect(info.mock.calls.filter((call) => String(call[0]).includes('half-open probe'))).toHaveLength(0)
  })
})

describe('revertPolicy: never is structural', () => {
  it('writes an infinite suppression (the never short-circuit lives on the read side)', async () => {
    const states = new FallbackStateStore()
    const config = cfg({
      rootChain: ['deepseek-official/deepseek-flash'],
      timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['a/1'] }],
      revertPolicy: 'never',
      recovery: 'half-open',
    })
    await collect(walkChain(
      walkDeps({ readConfig: () => config, getLlm: () => ctx.llm, states }),
      { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [], sessionId: SessionId('s1') },
    ))

    expect(states.peek('s1')?.cooldown.peek('a/1')).toBe(Number.POSITIVE_INFINITY)
  })
})
