/**
 * Small-integration runtime tests for the plugin `apply()` (plan Task 3
 * Step 6): real cordis waterfall dispatch + fake agent/session, the settings
 * seam aliased to `tests/support/settings-stub.ts`.
 *
 * Covers the request-error → request switch closed loop, coexistence order
 * with an llm-retry-like listener, always-mode downstream-first delegation
 * (ADR-2), always-cap at the request boundary, the no-op invariant (AC-8),
 * the T2-review Important #1 decision-path contract (wildcard
 * missing-id filtering, cooldown / step-failed exclusion), the per-step
 * safety valve, state lifecycle cleanup, live settings re-read, and the
 * illegal-selector warning path.
 *
 * The heavier coexistence/integration matrix (full llm-retry semantics, real
 * agent loop) is Task 4 (`tests/coexist-llm-retry.spec.ts` etc.).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, type Logger } from 'cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, normalizeChains } from '../src/index.ts'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { registrations, resetSettingsStub } from './support/settings-stub.ts'

/** Config helper: spec defaults + overrides (the plugin re-resolves through the schema). */
function cfg(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return { ...defaultFallbacksConfig, ...overrides }
}

/** Fake agent + session; `setRoute` simulates the loop logging a new request header after a switch. */
function makeAgent(id: string, options: { provider?: string; model?: string } = {}) {
  const route: { provider?: string; model?: string } = { ...options }
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    id,
    options,
    status: 'idle' as const,
    session: {
      id,
      events,
      append(type: string, data: Record<string, unknown>) {
        events.push({ type, data })
        return { seq: events.length, type, data }
      },
      requestHeader: () => (route.provider === undefined ? undefined : { config: route }),
    },
  }
  return {
    agent: agent as unknown as Agent,
    setRoute(provider: string, model: string): void {
      route.provider = provider
      route.model = model
    },
  }
}

/** Ordered `fallbacks/switch` events on an agent's session. */
function switchEvents(agent: Agent): SessionEvent<'fallbacks/switch'>[] {
  return agent.session.events.filter((event) => event.type === 'fallbacks/switch') as SessionEvent<'fallbacks/switch'>[]
}

function dispatchRequestError(
  ctx: Context,
  agent: Agent,
  overrides: { turn?: number; step?: number; provider?: string; failure?: LlmFailure } = {},
): Promise<RequestErrorAction> {
  return ctx.waterfall('agent/request-error', {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    provider: overrides.provider ?? 'mock',
    failure: overrides.failure ?? { message: 'boom', code: 'AUTH' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, () => Promise.resolve(undefined))
}

function dispatchRequest(
  ctx: Context,
  agent: Agent,
  seed: LlmCallConfig,
  overrides: { turn?: number; step?: number } = {},
): Promise<LlmCallConfig> {
  return ctx.waterfall('agent/request', {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve(seed))
}

let ctx: Context

beforeEach(() => {
  resetSettingsStub()
  ctx = new Context()
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('request-error → request switch closed loop', () => {
  it('decides on a trigger code, records the switch, and applies it at the next request', async () => {
    const { agent } = makeAgent('agent-loop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data).toEqual({
      turn: 1,
      step: 1,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'default',
      reason: 'trigger-code',
    })

    // Retry buildRequest: the pending switch overrides provider/model and
    // drops any inherited reasoningEffort (installModelSelection pattern).
    const config = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })

    // Applied + cleared: a later request at the same (turn, step) is untouched.
    const again = await dispatchRequest(ctx, agent, { provider: 'other', model: 'gpt-4o' })
    expect(again).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('passes through non-trigger codes (retryable codes stay with llm-retry)', async () => {
    const { agent } = makeAgent('agent-nontrigger', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'busy', code: 'SERVER' } })
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('is a no-op without chains (AC-8 regression invariant)', async () => {
    const { agent } = makeAgent('agent-noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('passes through when disabled', async () => {
    const { agent } = makeAgent('agent-disabled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ enabled: false, chains: { default: ['other/gpt-4o'] } }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('coexistence order with llm-retry (registered first)', () => {
  it('lets llm-retry own retryable failures until its budget is exhausted', async () => {
    const { agent } = makeAgent('agent-coexist', { provider: 'mock', model: 'gpt-4o' })
    let budget = 1
    ctx.on('agent/request-error', async (payload, next) => {
      if (payload.failure.code === 'RATE_LIMIT' && budget > 0) {
        budget -= 1
        return { kind: 'retry' }
      }
      return next()
    })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    // Retryable code within budget: llm-retry owns recovery, fallback never runs.
    const owned = await dispatchRequestError(ctx, agent, { failure: { message: '429', code: 'RATE_LIMIT' } })
    expect(owned).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Budget exhausted: llm-retry delegates; the trigger code reaches fallback.
    const delegated = await dispatchRequestError(ctx, agent, { failure: { message: '429', code: 'RATE_LIMIT' } })
    expect(delegated).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('trigger-code')

    // Never-retryable code (AUTH): llm-retry delegates immediately.
    const auth = await dispatchRequestError(ctx, agent, { failure: { message: 'bad key', code: 'AUTH' } })
    expect(auth).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(2)
  })
})

describe('always mode: downstream first, cap at agent/request (ADR-2)', () => {
  it('passes non-trigger failures through (llm-retry always backoff owns them)', async () => {
    const { agent } = makeAgent('agent-always', { provider: 'mock', model: 'gpt-4o' })
    ctx.on('agent/request-error', async (payload, next) => {
      const downstream = await next()
      if (downstream?.kind === 'retry') return downstream
      agent.session.append('llm/retry', {
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        policyKey: 'always',
        retry: 1,
      })
      return { kind: 'retry' }
    })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    // Non-trigger code under always mode: fallback must NOT preempt the backoff.
    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'busy', code: 'SERVER' } })
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Trigger code: the downstream (fallback) decision wins, llm-retry honors it.
    const auth = await dispatchRequestError(ctx, agent, { failure: { message: 'bad key', code: 'AUTH' } })
    expect(auth).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('switches at the request boundary once llm/retry events reach the cap', async () => {
    const { agent } = makeAgent('agent-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 5 }))

    for (let retry = 1; retry <= 4; retry += 1) {
      agent.session.append('llm/retry', { turn: 1, step: 1, provider: 'mock', policyKey: 'always', retry })
    }
    const below = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(below).toEqual({ provider: 'mock', model: 'gpt-4o', reasoningEffort: 'high' as ReasoningEffortId })
    expect(switchEvents(agent)).toHaveLength(0)

    agent.session.append('llm/retry', { turn: 1, step: 1, provider: 'mock', policyKey: 'always', retry: 5 })
    const switched = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(switched).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data).toMatchObject({
      turn: 1,
      step: 1,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      reason: 'always-cap',
    })
  })

  it('counts retries scoped to (turn, step, provider)', async () => {
    const { agent } = makeAgent('agent-cap-scope', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 3 }))

    // Five retries but for a different step/provider — cap must not trip.
    for (let retry = 1; retry <= 5; retry += 1) {
      agent.session.append('llm/retry', { turn: 1, step: 2, provider: 'other', policyKey: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('disables the cap when alwaysModeRetryCap is 0', async () => {
    const { agent } = makeAgent('agent-cap-zero', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 0 }))

    for (let retry = 1; retry <= 5; retry += 1) {
      agent.session.append('llm/retry', { turn: 1, step: 1, provider: 'mock', policyKey: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('decision-path candidate filtering (T2 review Important #1)', () => {
  it('filters provider/* entries whose target provider lacks the failing model id', async () => {
    ctx.provide('llm', {
      listModels: async (provider: string) =>
        (provider === 'other' ? [] : [{ provider, id: 'gpt-4o', name: 'gpt-4o' }]),
    })
    const { agent } = makeAgent('agent-wild-missing', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { 'mock/*': ['other/*'] } }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('resolves provider/* entries when the target provider has the model id', async () => {
    ctx.provide('llm', {
      listModels: async (provider: string) =>
        (provider === 'other' ? [{ provider, id: 'gpt-4o', name: 'gpt-4o' }] : []),
    })
    const { agent } = makeAgent('agent-wild-present', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { 'mock/*': ['other/*'] } }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('never existence-filters explicitly listed exact entries (spec §2 clause 2)', async () => {
    ctx.provide('llm', { listModels: async () => [] })
    const { agent } = makeAgent('agent-exact', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { 'mock/*': ['other/gpt-4o'] } }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('excludes cooldown-suppressed and step-failed candidates (double suppression)', async () => {
    const { agent, setRoute } = makeAgent('agent-suppress', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] } }))

    // Failure 1: mock/gpt-4o → other/gpt-4o (mock is now cooled AND step-failed).
    const first = await dispatchRequestError(ctx, agent)
    expect(first).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Failure 2 in the same step: mock (cooldown + failed) and other (== current)
    // are both excluded → no candidate → passthrough, original error semantics.
    const second = await dispatchRequestError(ctx, agent, { provider: 'other' })
    expect(second).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('keeps cooldown suppression across a step advance (failed set resets, cooldown persists)', async () => {
    const { agent, setRoute } = makeAgent('agent-cooldown', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] } }))

    const first = await dispatchRequestError(ctx, agent)
    expect(first).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // New step: the failed set reset, but mock is still in cooldown → still no
    // switch back (revert waits for cooldown expiry — US-4).
    const second = await dispatchRequestError(ctx, agent, { provider: 'other', step: 2 })
    expect(second).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('stops switching once the per-step safety valve is exceeded', async () => {
    const { agent, setRoute } = makeAgent('agent-valve', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['b/x', 'c/x', 'd/x'] }, maxSwitchesPerStep: 2 }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    setRoute('b', 'x')
    expect((await dispatchRequestError(ctx, agent, { provider: 'b' }))).toEqual({ kind: 'retry' })
    setRoute('c', 'x')
    // switchCount is 2 ≥ 2 → no decision even though d/x is available.
    const third = await dispatchRequestError(ctx, agent, { provider: 'c' })
    expect(third).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(2)
  })
})

describe('per-agent state lifecycle', () => {
  it('clears state on agent/disposed (cooldown no longer suppresses)', async () => {
    const { agent, setRoute } = makeAgent('agent-disposed', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] } }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    ctx.emit('agent/disposed', { agent })
    setRoute('other', 'gpt-4o')

    // State gone: mock is no longer cooled/failed → switch back is possible.
    const after = await dispatchRequestError(ctx, agent, { provider: 'other' })
    expect(after).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(2)
  })

  it('prunes a pending switch on agent/status idle (defensive)', async () => {
    const { agent } = makeAgent('agent-idle', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    ctx.emit('agent/status', { agent, status: 'idle' })

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })
})

describe('settings live re-read', () => {
  it('re-reads chains and enabled from the settings source on change', async () => {
    const { agent } = makeAgent('agent-settings', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    const registration = registrations[0]
    expect(registration).toBeDefined()
    expect(registration?.ns).toBe('fallbacks')

    registration?.hooks.setSource(() => cfg({ chains: { default: ['third/x'] } }))
    registration?.hooks.onChange()

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'third', model: 'x' })

    registration?.hooks.setSource(() => cfg({ enabled: false, chains: { default: ['third/x'] } }))
    registration?.hooks.onChange()

    const disabled = await dispatchRequestError(ctx, agent)
    expect(disabled).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })
})

describe('illegal selector warnings (spec §4: warn, never crash)', () => {
  it('normalizes whitespace-padded selector keys and warns on illegal ones', () => {
    const warns: string[] = []
    const fakeLogger = { warn: (message: string) => warns.push(message) } as unknown as Logger
    const normalized = normalizeChains({
      default: ['other/gpt-4o'],
      'openai/': ['openai/gpt-4o'],
      'openai/ gpt-4o': ['nope', 'openai/gpt-4o'],
    }, fakeLogger)
    expect(normalized).toEqual({
      default: ['other/gpt-4o'],
      'openai/gpt-4o': ['nope', 'openai/gpt-4o'],
    })
    expect(warns.some((message) => message.includes('openai/'))).toBe(true)
    expect(warns.some((message) => message.includes('nope'))).toBe(true)
  })

  it('does not crash at startup with illegal selectors and treats them as inert', async () => {
    const { agent } = makeAgent('agent-invalid', { provider: 'mock', model: 'gpt-4o' })
    expect(() => apply(ctx, cfg({ chains: { 'openai/': ['nope'] } }))).not.toThrow()

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})
