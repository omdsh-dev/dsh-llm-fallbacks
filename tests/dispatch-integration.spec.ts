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
 * - the four-stage path on ONE subagent first request: explicit preset miss →
 *   dispatch-role miss → rules miss → auto-match picks a declared role →
 *   injects its chain head →
 *   the role-inject override (NO durable `fallbacks/switch` event, issue #52 —
 *   the plugin fully stopped writing it), plus
 *   the stage-precedence wiring (explicit > rules > auto-match; the hook is not
 *   invoked when an earlier stage resolves);
 * - `roleAutoMatch: false` reproduces today's behavior (no auto-match, no
 *   injection, no event), even when the llm would answer;
 * - dedicated regression assertions on the failure-time fallback path
 *   (trigger-code / always-cap) AFTER a dispatch injection on the same agent:
 *   the dispatch path writes no pending / cooldown / failure bookkeeping and
 *   never re-evaluates (once-marker); root/inherit children keep their
 *   pre-feature `rootChain` shape, while an injected child follows the
 *   dispatch-resolved role's chain (I-000078). No durable event either way
 *   (issue #52).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { FALLBACKS_PROFILE_ENTRY } from '../src/gateway.ts'
import { subagentSeamOf } from '../src/subagents-seam.ts'
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

/** Capture every ctx.logger export (mirrors `dispatch-injection.spec.ts`; DEBUG lets warn through). */
function captureLogs(): Array<{ type: string; args: unknown[] }> {
  const logs: Array<{ type: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
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

describe('end-to-end dispatch resolution + injection (four-stage path)', () => {
  it('walks explicit → dispatch role → rules → auto-match on one subagent first request and injects the matched role head + role-inject event', async () => {
    // Stage 1 (explicit): the preset names no declared role id → falls through.
    // Stage 2 (dispatch role): no seam record → falls through.
    // Stage 3 (rules): no rules → 'inherit'.
    // Stage 4 (auto-match): the stub llm picks the declared 'coder' role.
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

describe('failure-time fallback path after dispatch injection (regression + I-000078)', () => {
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

  it('walks the dispatch-resolved role chain on the failure path, never the bare rootChain (I-000078)', async () => {
    // `fallback: 'none'` role: its chain alone, concatenation order preserved.
    // The second entry deliberately differs from `rootChain[0]`.
    const { agent } = makeAgent('t6-role-chain', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({
      rootChain: ['root/zero'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['first/one', 'second/two'], fallback: 'none' }],
        rules: [],
      },
    }))
    const seam = subagentSeamOf(ctx)
    if (seam === undefined) throw new Error('subagent seam not installed — cannot seed a dispatch role')
    seam.records.set(agent.id, { role: 'coder', at: Date.now(), firstNoticePending: true })

    // First request: injected with the role's chain head.
    const injected = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(injected).toEqual({ provider: 'first', model: 'one' })

    // The injected route fails: the switch must stay on the role's chain.
    const action = await dispatchRequestError(ctx, agent, { provider: 'first' })
    expect(action).toEqual({ kind: 'retry' })
    const switched = await dispatchRequest(ctx, agent, { provider: 'first', model: 'one' })
    expect(switched).toEqual({ provider: 'second', model: 'two' })

    // The chain's LAST entry fails too: `fallback: 'none'` appends no
    // rootChain tail, so there is no switch target left — `root/zero` must
    // never leak into this role's walk.
    const exhausted = await dispatchRequestError(ctx, agent, { provider: 'second' })
    expect(exhausted).toBeUndefined()
    const still = await dispatchRequest(ctx, agent, { provider: 'second', model: 'two' })
    expect(still).toEqual({ provider: 'second', model: 'two' })
  })

  it('keeps the bare rootChain for a root-origin agent (unchanged)', async () => {
    const { agent } = makeAgent('t6-root-chain', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({
      rootChain: ['root/zero'],
      roles: { list: [{ id: 'coder', persona: '', chain: ['first/one', 'second/two'], fallback: 'none' }], rules: [] },
    }))

    const action = await dispatchRequestError(ctx, agent, { provider: 'mock' })
    expect(action).toEqual({ kind: 'retry' })
    const switched = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(switched).toEqual({ provider: 'root', model: 'zero' })
  })

  it('falls back to rules-only resolution once the settings edit removes the remembered role (BUG-01 guard)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t6-role-removed', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({
      rootChain: ['root/zero'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['first/one', 'second/two'], fallback: 'none' }],
        rules: [],
      },
    }))
    const seam = subagentSeamOf(ctx)
    if (seam === undefined) throw new Error('subagent seam not installed — cannot seed a dispatch role')
    seam.records.set(agent.id, { role: 'coder', at: Date.now(), firstNoticePending: true })

    // First request records the dispatch role and injects its chain head.
    const injected = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(injected).toEqual({ provider: 'first', model: 'one' })
    // Positive control: capture is live, so the absence assertion below cannot
    // pass vacuously (the inject path logs the role→model line).
    expect(logs.length).toBeGreaterThan(0)

    // The role disappears mid-session (the real settings write path). The
    // remembered id must stop resolving: no rule matches, so the decision is
    // `inherit` → the bare rootChain target, not the removed role's chain.
    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, { roles: { list: [], rules: [] } })
    const action = await dispatchRequestError(ctx, agent, { provider: 'first' })
    expect(action).toEqual({ kind: 'retry' })
    const switched = await dispatchRequest(ctx, agent, { provider: 'first', model: 'one' })
    expect(switched).toEqual({ provider: 'root', model: 'zero' })

    // The stale id is not handed to resolveChainViews any more. (An undeclared
    // role ALSO resolves to rootChain, so the routing above cannot separate the
    // two paths — this warn is the observable difference.)
    const unknownRole = logs.filter((message) => String(message.args[0]).includes('unknown role'))
    expect(unknownRole).toHaveLength(0)
  })

  it('keeps the remembered dispatch role across an unrelated settings write (RET-01)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t6-role-kept', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({
      rootChain: ['root/zero'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['first/one', 'second/two'], fallback: 'none' }],
        rules: [],
      },
    }))
    const seam = subagentSeamOf(ctx)
    if (seam === undefined) throw new Error('subagent seam not installed — cannot seed a dispatch role')
    seam.records.set(agent.id, { role: 'coder', at: Date.now(), firstNoticePending: true })

    // First request records the dispatch role and injects its chain head.
    const injected = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(injected).toEqual({ provider: 'first', model: 'one' })
    expect(logs.length).toBeGreaterThan(0)

    // An UNRELATED write: `roles` stays declared, only rootChain moves. The
    // role is recorded once per agent (never re-recorded), so a blanket map
    // clear here would drop this child to `inherit` → the NEW rootChain entry.
    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, { rootChain: ['other/root'] })
    const action = await dispatchRequestError(ctx, agent, { provider: 'first' })
    expect(action).toEqual({ kind: 'retry' })
    const switched = await dispatchRequest(ctx, agent, { provider: 'first', model: 'one' })
    expect(switched).toEqual({ provider: 'second', model: 'two' })

    const unknownRole = logs.filter((message) => String(message.args[0]).includes('unknown role'))
    expect(unknownRole).toHaveLength(0)
  })
})
