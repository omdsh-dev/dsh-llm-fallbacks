/**
 * End-to-end dispatch resolution + injection integration and regression tests
 * (plan fallbacks-role-automatch Task 6).
 *
 * Wires the REAL resolver (`resolveRoleAtDispatch`), the REAL bounded
 * auto-match hook (`pickRoleByLlm`, over a stubbed `ctx.llm` — never a network
 * call) and the REAL `agent/request` listener together through the shared
 * cordis-waterfall harness (`tests/support/harness.ts`, the same seam
 * `tests/dispatch-injection.spec.ts` uses). Covers:
 *
 * - the three-stage path on ONE subagent first request: explicit preset miss →
 *   rules miss → auto-match picks a declared role → injects its chain head →
 *   the role-inject override (NO durable `fallbacks/switch` event, issue #52 —
 *   the plugin fully stopped writing it), plus
 *   the stage-precedence wiring (explicit > rules > auto-match; the hook is not
 *   invoked when an earlier stage resolves);
 * - `roleAutoMatch: false` reproduces today's behavior (no auto-match, no
 *   injection, no event), even when the llm would answer;
 * - dedicated regression assertions that the failure-time fallback path
 *   (trigger-code / always-cap) stays intact AFTER a dispatch injection
 *   has occurred on the same agent: the dispatch path writes no pending /
 *   cooldown / failure bookkeeping, never re-evaluates (once-marker), and so
 *   failure decisions keep their exact pre-feature override semantics (no
 *   durable event, issue #52).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
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

function asyncIter(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Declared taxonomy under test: role `coder` with chain head `anthropic/claude-sonnet-4`. */
function coderRoles() {
  return { list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4'] }], rules: [] }
}

/** Stub `ctx.llm` whose `stream` answers the auto-match judgment call with one role id. */
function llmAnswering(id: string) {
  return {
    stream: () => asyncIter([
      { type: 'text-delta', index: 0, text: id },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
  }
}

describe('end-to-end dispatch resolution + injection (three-stage path)', () => {
  it('walks explicit → rules → auto-match on one subagent first request and injects the matched role head + role-inject event', async () => {
    // Stage 1 (explicit): the preset names no declared role id → falls through.
    // Stage 2 (rules): no rules → 'inherit'.
    // Stage 3 (auto-match): the stub llm picks the declared 'coder' role.
    ctx.provide('llm', llmAnswering('coder'))
    const { agent } = makeAgent('t6-three', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'qa-preset' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    // Stop-write (issue #52): no durable fallbacks/switch event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('lets a rules match win before the auto-match stage (hook not invoked)', async () => {
    const automatch = vi.fn(() => llmAnswering('coder').stream())
    ctx.provide('llm', { stream: automatch })
    const { agent } = makeAgent('t6-rules-first', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'qa-preset' })
    apply(ctx, cfg({
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4'] }],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)).toHaveLength(0)
    // Stage 2 short-circuited before the auto-match stage — the stub was never streamed.
    expect(automatch).not.toHaveBeenCalled()
  })

  it('lets an explicit preset win before rules and auto-match (hook not invoked)', async () => {
    const automatch = vi.fn(() => llmAnswering('code-review').stream())
    ctx.provide('llm', { stream: automatch })
    const { agent } = makeAgent('t6-explicit-first', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({
      roles: {
        list: [
          { id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4'] },
          { id: 'code-review', persona: '', chain: ['openai/gpt-4o'] },
        ],
        rules: [{ provider: 'mock', role: 'code-review' }],
      },
    }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)).toHaveLength(0)
    // Stage 1 resolved the declared preset — rules and auto-match never ran.
    expect(automatch).not.toHaveBeenCalled()
  })
})

describe('roleAutoMatch:false reproduces today (regression)', () => {
  it('never auto-matches and never injects, even when the llm would answer', async () => {
    ctx.provide('llm', llmAnswering('coder'))
    const { agent } = makeAgent('t6-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'qa-preset' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roleAutoMatch: false, roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('failure-time fallback path byte-identical after dispatch injection (regression)', () => {
  it('trigger-code closed loop keeps its exact pre-feature shape after a role-inject', async () => {
    const { agent } = makeAgent('t6-trigger', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roles: coderRoles() }))

    // First request: role-inject applies (explicit 'coder' → its chain head).
    const injected = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(injected).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    // Failure on the injected route: the trigger-code decision still applies
    // (no durable event, issue #52), and the dispatch block does not
    // re-evaluate (once-marker).
    const action = await dispatchRequestError(ctx, agent, { provider: 'anthropic' })
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)

    // The pending switch still applies at the next request (failure path intact).
    const retried = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(retried).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('always-cap still trips with its exact pre-feature shape after a role-inject', async () => {
    const { agent } = makeAgent('t6-cap', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roles: coderRoles(), alwaysModeRetryCap: 3 }))

    // First request: role-inject to anthropic/claude-sonnet-4.
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })

    // Always-mode retries accumulate on the injected route → the cap trips at
    // the next request boundary and routes to the rootChain target.
    for (let retry = 1; retry <= 3; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'anthropic', mode: 'always', policyKey: 'always', retry })
    }
    const switched = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switched).toEqual({ provider: 'other', model: 'gpt-4o' })
    // Stop-write: the always-cap switch applies with no durable event.
    expect(switchEvents(agent)).toHaveLength(0)
  })
})
