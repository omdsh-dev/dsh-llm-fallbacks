/**
 * Always-mode cap matrix (plan Task 4, Step 2; spec §2 clause 5 / ADR-2).
 *
 * The cap lives at the `agent/request` boundary: count durable `llm/retry`
 * events for the current (turn, step, provider) with `mode: 'always'`, and
 * switch once the count reaches `alwaysModeRetryCap` (0 disables). The
 * request-error listener must NOT preempt the always backoff — llm-retry's
 * always mode delegates downstream first, so non-triggerCode failures pass
 * through (the fallback only acts on trigger codes there).
 *
 * Task 4 appends `llm/retry` events in the **real** event shape (retryId /
 * policyKey / retry / delayMs / failure …) so the counting is exercised
 * against the real bundle's payload — the `mode` discriminator must survive
 * the full shape (T3 fix review ⚠️2), and normal-mode retries must never
 * count toward the cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { installLlmRetryStub } from './support/llm-retry-stub.ts'
import {
  alwaysPolicy,
  appendLlmRetry,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  llmRetryEvents,
  makeAgent,
  runAgentStep,
  switchEvents,
} from './support/harness.ts'

/**
 * Task 2 (spec §2.5 D-1): the plugin value-imports `markFallbackRouted` from
 * `@deepseek-ai/dsh-agent`, but the link farm resolves the UNPATCHED dsh-agent
 * (dsh-private tree) which does not export it — see `tests/plugin.spec.ts` for
 * the full rationale. This mock simulates the patched module so the switch
 * apply path (`agent/request` → `markFallbackRouted`) can run here.
 */
vi.mock('@deepseek-ai/dsh-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-agent')>()
  const fallbackRouted = new WeakSet<object>()
  return {
    ...original,
    markFallbackRouted: (config: object) => { fallbackRouted.add(config); return config },
    isFallbackRouted: (config: object) => fallbackRouted.has(config),
  }
})

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('always-mode cap at the agent/request boundary (spec §2 clause 5 / ADR-2)', () => {
  it('switches only once always-mode retries reach the cap; below the cap the request passes unchanged and request-error is not preempted', async () => {
    const { agent } = makeAgent('cap-gate', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 3 }))

    // Below the cap (2 always retries): the request passes unchanged, effort
    // and all; a non-trigger request-error (the always backoff path) is NOT
    // preempted by the fallback.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 2 })
    const below = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(below).toEqual({ provider: 'mock', model: 'gpt-4o', reasoningEffort: 'high' as ReasoningEffortId })
    expect(switchEvents(agent)).toHaveLength(0)
    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'busy', code: 'SERVER' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)

    // At the cap (3rd always retry): the next buildRequest switches — and the
    // inherited reasoningEffort is dropped with the override.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 3 })
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

  it('counts only always-mode events under the real llm/retry event shape (T3 fix review ⚠️2)', async () => {
    const { agent } = makeAgent('cap-shape', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 3 }))

    // Full-shape normal-mode retries (a bounded RATE_LIMIT budget): they
    // belong to llm-retry and must never count toward the cap.
    for (let retry = 1; retry <= 3; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'normal', retry, maxRetries: 5 })
    }
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Two full-shape always-mode retries — still below cap 3.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 2 })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)

    // The third always-mode retry reaches the cap → switch.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 3 })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('always-cap')
  })

  it('scopes the count to the current (turn, step, provider)', async () => {
    const { agent } = makeAgent('cap-scope', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 3 }))

    // Retries for other (turn, step) pairs and other providers must not trip
    // the cap at (1, 1, mock) — appended in chronological order (older first).
    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 2, provider: 'other', mode: 'always', retry })
      appendLlmRetry(agent, { turn: 2, step: 1, provider: 'mock', mode: 'always', retry })
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'other', mode: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('disables the mechanism when alwaysModeRetryCap is 0', async () => {
    const { agent } = makeAgent('cap-zero', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 0 }))

    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('end to end: the llm-retry stub retries always-mode failures until the cap trips at the next build', async () => {
    // Full composition: the stub (always policy, registered first) backoffs on
    // every non-trigger failure; the fallback passes each through (ADR-2); the
    // durable always-mode llm/retry events accumulate until the cap trips at
    // the next buildRequest — then the switch applies and the step succeeds.
    installLlmRetryStub(ctx)
    const { agent, setRoute } = makeAgent('cap-e2e', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 3 }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'busy', code: 'SERVER' },
      { message: 'busy', code: 'SERVER' },
      { message: 'busy', code: 'SERVER' },
      undefined,
    ], { retryPolicy: alwaysPolicy() })

    expect(result.outcome).toBe('success')
    expect(result.requests.map((request) => request.provider)).toEqual(['mock', 'mock', 'mock', 'other'])
    expect(llmRetryEvents(agent)).toHaveLength(3)
    expect(llmRetryEvents(agent).every((event) => event.data.mode === 'always')).toBe(true)
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('always-cap')
  })
})
