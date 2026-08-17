/**
 * Host-native baseline matrix (plan llm-fallbacks-runtime-depatch T2).
 *
 * This file started as the W1 no-patch-host suite: it pinned the degrade
 * path for a host running WITHOUT the local dsh-agent patch (the
 * fallback-routing marker). T2 removes the marker runtime dependency
 * entirely — the patch-free plugin IS the deliverable — so the suite
 * becomes the standard host-native baseline: the real
 * `@deepseek-ai/dsh-agent` module is the only truth and no mock exists
 * anywhere in the test tree.
 *
 * The cases themselves were always the plugin's core contract and remain
 * valid unchanged:
 * - a trigger-code switch applies at the next request and routes to the
 *   chain target,
 * - the always-cap switch applies at the second return point,
 * - the no-op invariant (AC-8) holds with the default config.
 *
 * Composition with an active model-selection (the only observable behavioral
 * difference of the patch removal) is pinned in `tests/plugin.spec.ts`
 * (registration-order dependence) and documented as a documented degradation
 * in docs/verification.md (§4.7) — the card status block no longer carries a
 * one-line note (plan fallbacks-settings-visibility, AC-2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  appendLlmRetry,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  makeAgent,
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

describe('host-native baseline (patch-free plugin)', () => {
  it('switches on a trigger code and routes the next request to the chain target', async () => {
    const { agent } = makeAgent('native-trigger', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    // The decision path (request-error) and the switch apply (request) both
    // run against the real dsh-agent module — no marker, no patch, no mock.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('applies the always-cap switch (second return point)', async () => {
    const { agent } = makeAgent('native-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 1 }))

    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('always-cap')
  })

  it('keeps the no-op invariant (AC-8)', async () => {
    const { agent } = makeAgent('native-noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
    const seed = { provider: 'mock', model: 'gpt-4o', temperature: 0.7 }
    expect(await dispatchRequest(ctx, agent, seed)).toEqual(seed)
  })
})
