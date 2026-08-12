/**
 * Dual-plugin coexistence matrix (plan Task 4, Step 1): the llm-retry
 * semantic double (`tests/support/llm-retry-stub.ts`) registered on the same
 * ctx BEFORE the real fallback plugin `apply()` — the bundle composition
 * order (`bundle/cordis.patch.yml` inserts `llm-fallbacks` after
 * `llm-retry`).
 *
 * Asserts (spec §2 clause 1, §5 waterfall order, ADR-2):
 * - retryable codes are owned by llm-retry first (`llm/retry` events appear)
 *   until its budget is exhausted, then the fallback switches;
 * - never-retryable codes (AUTH/QUOTA) delegate immediately and switch
 *   directly;
 * - `mode: 'always'` delegates downstream first (`next()`), so the fallback
 *   passes non-triggerCode failures through and only trigger codes switch;
 * - the reverse registration order (fallback first) is pinned as the
 *   bundle-order risk: the fallback then owns trigger codes outright.
 *
 * > Note (plan llm-fallbacks-runtime-depatch T2): no `vi.mock('@deepseek-ai/
 * > dsh-agent')` exists anymore — the local dsh-agent patch (and its
 * > fallback-routing marker) is removed, so the real module is the only
 * > truth. These cases only drive `agent/request-error` (the decision path);
 * > a future case that dispatches `agent/request` (the switch-apply path)
 * > must keep the host-native semantics pinned in `tests/host-native.spec.ts`
 * > and `tests/plugin.spec.ts` in sync.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { installLlmRetryStub } from './support/llm-retry-stub.ts'
import {
  alwaysPolicy,
  cfg,
  dispatchRequestError,
  llmRetryEvents,
  makeAgent,
  normalPolicy,
  switchEvents,
} from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('dual-plugin coexistence: llm-retry stub registered first (bundle order)', () => {
  it('normal mode: llm-retry owns retryable codes until its budget is exhausted, then fallback switches', async () => {
    const { agent } = makeAgent('coexist-normal', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    const policy = normalPolicy({ maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'SERVER'] })

    // Retry 1 and 2: within budget → llm-retry owns recovery (durable
    // llm/retry events), the fallback never runs.
    for (let retry = 1; retry <= 2; retry += 1) {
      const action = await dispatchRequestError(ctx, agent, {
        failure: { message: '429', code: 'RATE_LIMIT' },
        retryPolicy: policy,
      })
      expect(action).toEqual({ kind: 'retry' })
    }
    expect(llmRetryEvents(agent)).toHaveLength(2)
    expect(llmRetryEvents(agent).every((event) => event.data.mode === 'normal')).toBe(true)
    expect(switchEvents(agent)).toHaveLength(0)

    // Retry 3: budget exhausted → llm-retry delegates (next()) → the trigger
    // code reaches the fallback → switch.
    const delegated = await dispatchRequestError(ctx, agent, {
      failure: { message: '429', code: 'RATE_LIMIT' },
      retryPolicy: policy,
    })
    expect(delegated).toEqual({ kind: 'retry' })
    expect(llmRetryEvents(agent)).toHaveLength(2)
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('trigger-code')
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('never-retryable codes (AUTH/QUOTA) bypass llm-retry and switch directly', async () => {
    const { agent } = makeAgent('coexist-auth', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    const policy = normalPolicy({ maxRetries: 2, retryableCodes: ['RATE_LIMIT'] })

    for (const code of ['AUTH', 'QUOTA'] as const) {
      const action = await dispatchRequestError(ctx, agent, {
        failure: { message: `${code.toLowerCase()} failure`, code },
        retryPolicy: policy,
      })
      expect(action).toEqual({ kind: 'retry' })
    }
    // Neither code is retryable → the stub never scheduled a backoff; both
    // failures switched directly through the fallback.
    expect(llmRetryEvents(agent)).toHaveLength(0)
    expect(switchEvents(agent)).toHaveLength(2)
    expect(switchEvents(agent).every((event) => event.data.reason === 'trigger-code')).toBe(true)
  })

  it('always mode: llm-retry delegates downstream first — non-trigger failures backoff, trigger codes switch (ADR-2)', async () => {
    const { agent } = makeAgent('coexist-always', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    const policy = alwaysPolicy()

    // Non-trigger failure (SERVER): the stub calls next() first → the fallback
    // passes it through (SERVER ∉ triggerCodes) → the stub backoffs
    // (llm/retry, always) and owns the retry. No fallbacks/switch — the
    // fallback did NOT preempt the always backoff.
    const nonTrigger = await dispatchRequestError(ctx, agent, {
      failure: { message: 'busy', code: 'SERVER' },
      retryPolicy: policy,
    })
    expect(nonTrigger).toEqual({ kind: 'retry' })
    expect(llmRetryEvents(agent)).toHaveLength(1)
    expect(llmRetryEvents(agent)[0]?.data.mode).toBe('always')
    expect(switchEvents(agent)).toHaveLength(0)

    // Trigger code (AUTH): the stub delegates first → the fallback decides →
    // the stub honors the downstream retry (downstream priority) — no extra
    // llm/retry event, the switch happens.
    const trigger = await dispatchRequestError(ctx, agent, {
      failure: { message: 'bad key', code: 'AUTH' },
      retryPolicy: policy,
    })
    expect(trigger).toEqual({ kind: 'retry' })
    expect(llmRetryEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('trigger-code')
  })

  it('pins the reverse order: fallback registered first owns trigger codes (bundle-order risk)', async () => {
    const { agent } = makeAgent('coexist-reversed', { provider: 'mock', model: 'gpt-4o' })
    // Wrong composition order (the risk the patch insert position guards
    // against): the fallback now runs before llm-retry, so a retryable trigger
    // code reaches it first and it owns the switch — llm-retry never backoffs.
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    installLlmRetryStub(ctx)
    const policy = normalPolicy({ maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'SERVER'] })

    const action = await dispatchRequestError(ctx, agent, {
      failure: { message: '429', code: 'RATE_LIMIT' },
      retryPolicy: policy,
    })
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(llmRetryEvents(agent)).toHaveLength(0)
  })
})
