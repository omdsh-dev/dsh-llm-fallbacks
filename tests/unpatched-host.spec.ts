/**
 * Unpatched-host degrade matrix (QC fix wave W1).
 *
 * The plugin ships four dsh patches (patches/); a host that runs WITHOUT
 * them — AUTOPATCH=0, a link install, or a dsh upgrade that reset the tree
 * without re-running apply-dsh-patch.sh — has NO `markFallbackRouted` export
 * on `@deepseek-ai/dsh-agent`. Before W1 the plugin value-imported it, so the
 * ESM link failed (whole plugin failed to load) or the switch point threw a
 * TypeError. W1 changed the plugin to a namespace import with an optional-call
 * guard (`agentNs.markFallbackRouted?.(routed) ?? routed`): the switch still
 * happens and the request still routes to the chain target — pre-branch
 * semantics (docs/dsh-patch.md「未打补丁宿主降级」: under an active
 * model-selection the unmarked step lets the outer selection re-apply).
 *
 * This file mocks `@deepseek-ai/dsh-agent` as the REAL module with NO added
 * exports (importOriginal, nothing appended) — the deliberate contrast to
 * tests/plugin.spec.ts / runtime.spec.ts / always-mode.spec.ts, whose mocks
 * SIMULATE the patched module (shared WeakSet registry). Vitest mocks are
 * per-file, so the two mock shapes never collide.
 *
 * Note: `tests/support/model-selection-stub.ts` imports `isFallbackRouted`
 * from `@deepseek-ai/dsh-agent`; it is NOT used here (the unpatched mock has
 * no such export) — the marker-handoff composition cases live in
 * tests/plugin.spec.ts under the patched-module mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
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

/**
 * The UNPATCHED host module: the real exports, nothing appended — no
 * `markFallbackRouted`, no `isFallbackRouted`. The key is defined as
 * `undefined` (vitest 4's mock proxy throws on accessing an export the mock
 * does not define — a test artifact, not host behavior) so the namespace
 * access models a real unpatched ESM namespace: a missing named export reads
 * `undefined`, and the plugin's optional-call guard short-circuits.
 */
vi.mock('@deepseek-ai/dsh-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-agent')>()
  return {
    ...original,
    markFallbackRouted: undefined,
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

describe('unpatched host degrade (W1): no markFallbackRouted export', () => {
  it('switches on a trigger code without throwing and routes the request to the chain target', async () => {
    const { agent } = makeAgent('unpatched-trigger', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    // The decision path (request-error) and the switch apply (request) both
    // run without the marker function — nothing throws.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('applies the always-cap switch without throwing (second return point)', async () => {
    const { agent } = makeAgent('unpatched-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 1 }))

    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('always-cap')
  })

  it('keeps the no-op invariant on an unpatched host (AC-8)', async () => {
    const { agent } = makeAgent('unpatched-noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
    const seed = { provider: 'mock', model: 'gpt-4o', temperature: 0.7 }
    expect(await dispatchRequest(ctx, agent, seed)).toEqual(seed)
  })
})
