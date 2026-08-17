/**
 * Dispatch-time role injection tests (plan fallbacks-role-automatch Task 4).
 *
 * At a subagent-origin agent's FIRST `agent/request`, the runtime resolves the
 * role (explicit → rules → auto-match hook) and injects the resolved role's
 * chain head — the first exact (non-wildcard) candidate of the concatenated
 * chain — when it differs from the request's current model: via
 * `overrideConfig` + a `fallbacks/switch` event (`reason: 'role-inject'`,
 * `from`/`to`/`role` populated) + an explicit `role → model` log line.
 *
 * This is NOT a failure decision: no `commit()`, no pending switch, no
 * cooldown, no failure bookkeeping (agent state untouched). Evaluation is
 * gated to the `applied === undefined` branch (a failure-path pending switch
 * always wins), subagent-origin only, and a per-agent once-marker makes it
 * first-request-only (cleaned on `agent/disposed`). The resolved `'inherit'`
 * role ("no specific role") NEVER injects — with `roleAutoMatch: false` and
 * no explicit/rules role the outcome is identical to today. Any throw in the
 * resolution/injection path warns and the request proceeds unchanged
 * (defensive, mirroring the `agent/request-error` pattern).
 *
 * Uses the real plugin `apply()` against the harness fake agent/session (no
 * real dsh runtime); the auto-match LLM is always a stub (never a network
 * call).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, stateStore } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, dispatchRequestError, makeAgent, switchEvents } from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/**
 * Capture every ctx.logger export (info/warn/...) from this point on.
 * The exporter threshold defaults to the logger level (INFO), which would
 * drop warn records — `levels.default` = DEBUG (3) lets warn (2) flow.
 */
function captureLogs(): Array<{ type: string; args: unknown[] }> {
  const logs: Array<{ type: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
}

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

describe('dispatch-time role injection', () => {
  it('injects the resolved role chain head on a subagent first request + appends role-inject + logs', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t4-inject', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    const events = switchEvents(agent)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({
      turn: 1,
      step: 1,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'anthropic', model: 'claude-sonnet-4' },
      role: 'coder',
      reason: 'role-inject',
    })
    // Direction-3 visibility: the explicit role → model log line. The exporter
    // keeps the format string in args[0] and the interpolated values after it.
    expect(logs.some((message) => message.type === 'info'
      && String(message.args[0]).includes('role-inject role=%s model=%s/%s')
      && message.args[2] === 'coder'
      && message.args[3] === 'anthropic'
      && message.args[4] === 'claude-sonnet-4')).toBe(true)
  })

  it('injects the chain head of a rules-resolved role', async () => {
    const { agent } = makeAgent('t4-rules', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({
      rootChain: ['third/x'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4'] }],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)[0]?.data.role).toBe('coder')
  })

  it('does not inject when the chain head equals the current model', async () => {
    const { agent } = makeAgent('t4-same', { provider: 'anthropic', model: 'claude-sonnet-4' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('does not re-inject on later requests (once-marker)', async () => {
    const { agent } = makeAgent('t4-once', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const first = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(first).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // A second request (route already folded back) is not re-evaluated.
    const second = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(second).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('never re-evaluates after a first request that did not inject (marker set regardless)', async () => {
    const { agent } = makeAgent('t4-once-noop', { provider: 'anthropic', model: 'claude-sonnet-4' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    // First request: head === current → no injection, but the marker is set.
    const first = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(first).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // Route now differs from the head — still no re-injection (first-request-only).
    const second = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(second).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('writes no pending/cooldown/failure bookkeeping (agent state untouched)', async () => {
    const { agent } = makeAgent('t4-nobooks', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // The state store is only grown on a real switch intent — untouched here.
    expect(stateStore(ctx)?.has(agent.id)).toBe(false)
    expect(stateStore(ctx)?.size).toBe(0)
    // And no pending switch lingers: a later request is not overridden.
    const again = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(again).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('never injects for root-origin agents', async () => {
    const { agent } = makeAgent('t4-root', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('never injects for an agent with no origin header (treated as root)', async () => {
    const { agent } = makeAgent('t4-noheader', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('does not inject when the resolved chain has no exact candidate (wildcard-only)', async () => {
    const { agent } = makeAgent('t4-wild', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: '', chain: ['other/*'] }], rules: [] } }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('reproduces today with roleAutoMatch:false and no explicit/rules role (inherit never injects)', async () => {
    const { agent } = makeAgent('t4-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roleAutoMatch: false }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('is a no-op when disabled (AC-8)', async () => {
    const { agent } = makeAgent('t4-disabled', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ enabled: false, roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('a failure-path pending switch wins over dispatch injection (applied branch)', async () => {
    const { agent } = makeAgent('t4-pending', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roles: coderRoles() }))

    // Failure-time switch → pending trigger-code switch to other/gpt-4o.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    // First request: the pending switch applies and wins over the role-inject.
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    const events = switchEvents(agent)
    expect(events).toHaveLength(1)
    expect(events[0]?.data.reason).toBe('trigger-code')
  })

  it('clears the once-marker on agent/disposed (a re-created agent re-evaluates)', async () => {
    const { agent } = makeAgent('t4-recreate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)

    ctx.emit('agent/disposed', { agent })
    const { agent: second } = makeAgent('t4-recreate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    await dispatchRequest(ctx, second, { provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(second)).toHaveLength(1)
  })

  it('proceeds with the request unchanged when injection fails (defensive)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t4-defensive', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))
    // A session.append failure (the defensive pattern's example throw source):
    // the whole injection path must degrade to a warn + unchanged request.
    ;(agent as unknown as { session: { append: () => never } }).session.append = () => {
      throw new Error('session log refused')
    }

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('dispatch role-injection failed'))).toBe(true)
  })
})

describe('dispatch auto-match stage (wired through pickRoleByLlm)', () => {
  it('auto-matches a role when no explicit/rules role resolves and injects its head', async () => {
    ctx.provide('llm', {
      stream: () => asyncIter([
        { type: 'text-delta', index: 0, text: 'coder' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    })
    const { agent } = makeAgent('t4-auto', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)[0]?.data.role).toBe('coder')
  })

  it('does not inject when no llm service is available for auto-match (inherit)', async () => {
    // Absent ctx.llm → pickRoleByLlm returns null → 'inherit' → no injection.
    const { agent } = makeAgent('t4-nollm', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })
})
