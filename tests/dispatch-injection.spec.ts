/**
 * Dispatch-time role injection tests (plan fallbacks-role-automatch Task 4).
 *
 * At a subagent-origin agent's FIRST `agent/request`, the runtime resolves the
 * role (explicit → rules → auto-match hook) and injects the resolved role's
 * chain head — the first exact (non-wildcard) candidate of the concatenated
 * chain — when it differs from the request's current model: via
 * `overrideConfig` + an explicit `role → model` log line. No durable
 * `fallbacks/switch` session event is written (issue #52 — the plugin fully
 * stopped writing it; see `tests/session-event-registration-guard.spec.ts`).
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { detectAuthorizedRoute } from '../src/authorized-route.ts'
import { apply, chainHeads, stateStore } from '../src/index.ts'
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

    // Stop-write (issue #52): no durable fallbacks/switch event is written.
    expect(switchEvents(agent)).toHaveLength(0)
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
    expect(switchEvents(agent)).toHaveLength(0)
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
    expect(switchEvents(agent)).toHaveLength(0)
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

  it('still resolves and injects a declared explicit preset when roleAutoMatch:false (the toggle gates only the auto-match stage)', async () => {
    // qc2 F-001: `roleAutoMatch` disables ONLY stage 3 (the LLM auto-match);
    // the explicit `agentPreset` stage is independent new behavior and is NOT
    // gated by the toggle — a declared preset still resolves and injects
    // under `false` (dual-path contrast to t4-off above: same `false` toggle,
    // but with a declared explicit preset the role-inject fires).
    const { agent } = makeAgent('t4-off-explicit', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles(), roleAutoMatch: false }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // Stop-write: the explicit-preset role-inject applies with no durable event.
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
    // Stop-write: the trigger-code switch wins with no durable event.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('clears the once-marker on agent/disposed (a re-created agent re-evaluates)', async () => {
    const { agent } = makeAgent('t4-recreate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)

    ctx.emit('agent/disposed', { agent })
    const { agent: second } = makeAgent('t4-recreate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    await dispatchRequest(ctx, second, { provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(second)).toHaveLength(0)
  })

  it('applies the injection even when session.append would throw (never called — stop-write, issue #52)', async () => {
    const { agent } = makeAgent('t4-defensive', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))
    // The durable append is gone — the injection path never touches
    // session.append, so a hostile append cannot degrade the request.
    ;(agent as unknown as { session: { append: () => never } }).session.append = () => {
      throw new Error('session log refused')
    }

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)).toHaveLength(0)
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
    // Stop-write: the auto-match injection applies with no durable event.
    expect(switchEvents(agent)).toHaveLength(0)
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


/** Policy-on `subagentModelSelection` settings-service double (host composition stand-in). */
function provideSubagentPolicy(allowed: readonly { provider: string; model: string }[]): void {
  ctx.provide('subagentModelSelection', {
    current: () => ({ enabled: true, allowedModels: allowed.map((route) => ({ ...route })) }),
  })
}

/** `agents` registry double exposing one delegating parent agent (the lineage the child view reads). */
function provideParentAgent(parent: Agent): void {
  ctx.provide('agents', { get: () => parent })
}

/** Stamp the fake session header with a delegating parent (spawn lineage). */
function stampParentSession(child: Agent, parentId: string): void {
  ;(child.session as unknown as { header: { parentSession?: string } }).header.parentSession = parentId
}

describe('authorized-route detection (pure module)', () => {
  it('prefers the model/selection event, even when it equals the inherited baseline', () => {
    expect(detectAuthorizedRoute({
      events: [{ type: 'model/selection', data: { provider: 'a', model: 'b' } }],
      requestHeader: { provider: 'x', model: 'y' },
      inherited: { provider: 'a', model: 'b' },
    })).toEqual({ provider: 'a', model: 'b' })
  })

  it('takes the latest complete selection and skips malformed entries', () => {
    expect(detectAuthorizedRoute({
      events: [
        { type: 'model/selection', data: { provider: 'a', model: 'b' } },
        { type: 'model/selection', data: { provider: 42 } },
        { type: 'other', data: {} },
        { type: 'model/selection', data: { provider: 'c', model: 'd', reasoningEffort: 'high' } },
      ],
    })).toEqual({ provider: 'c', model: 'd' })
  })

  it('falls back header → options and ignores an effort-only source (effort alone is not a route)', () => {
    expect(detectAuthorizedRoute({ options: { provider: 'p', model: 'm' } })).toEqual({ provider: 'p', model: 'm' })
    expect(detectAuthorizedRoute({
      requestHeader: { provider: 'p', model: 'm' },
      options: { provider: 'q', model: 'n' },
    })).toEqual({ provider: 'p', model: 'm' })
    expect(detectAuthorizedRoute({ options: { reasoningEffort: 'high' } })).toBeUndefined()
    expect(detectAuthorizedRoute({ options: { provider: 'p', model: '' } })).toBeUndefined()
  })

  it('treats a route equal to the provable inherited baseline as pure inheritance (not authorized)', () => {
    expect(detectAuthorizedRoute({
      requestHeader: { provider: 'mock', model: 'gpt-4o' },
      inherited: { provider: 'mock', model: 'gpt-4o' },
    })).toBeUndefined()
    expect(detectAuthorizedRoute({
      requestHeader: { provider: 'deepseek', model: 'deepseek-chat' },
      inherited: { provider: 'mock', model: 'gpt-4o' },
    })).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('treats an unprovable baseline as authorized (D2 keeps chain heads unoverwritten)', () => {
    expect(detectAuthorizedRoute({ requestHeader: { provider: 'a', model: 'b' } })).toEqual({ provider: 'a', model: 'b' })
    expect(detectAuthorizedRoute({})).toBeUndefined()
  })
})

describe('subagent routing policy (wiring, spec D1 ∩ D2)', () => {
  it('skips inject when the first request carries an explicit model/selection (authorized head, policy on)', async () => {
    const logs = captureLogs()
    provideSubagentPolicy([{ provider: 'deepseek', model: 'deepseek-chat' }])
    const { agent } = makeAgent('t2-authorized', { provider: 'deepseek', model: 'deepseek-chat' }, { origin: 'subagent', agentPreset: 'coder' })
    agent.session.append('model/selection', { provider: 'deepseek', model: 'deepseek-chat' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(switchEvents(agent)).toHaveLength(0)
    expect(logs.some((message) => message.type === 'info' && String(message.args[0]).includes('authorized child route'))).toBe(true)
  })

  it('uses the NEWEST model/selection occurrence for the authorized head (upstream newest-match, qc fix wave S-asym)', async () => {
    const logs = captureLogs()
    provideSubagentPolicy([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'anthropic', model: 'claude-sonnet-4' },
    ])
    const { agent } = makeAgent('t2-newest-sel', { provider: 'deepseek', model: 'deepseek-chat' }, { origin: 'subagent', agentPreset: 'coder' })
    // Two explicit selections: an OLDER anthropic one, then the newer deepseek
    // one. Upstream's selection projection folds to the newest entry — a
    // first-match read would authorize anthropic here.
    agent.session.append('model/selection', { provider: 'anthropic', model: 'claude-sonnet-4' })
    agent.session.append('model/selection', { provider: 'deepseek', model: 'deepseek-chat' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(switchEvents(agent)).toHaveLength(0)
    // The recorded authorized head is the NEWEST selection, not the first.
    const record = chainHeads(ctx)?.get('t2-newest-sel')
    expect(record?.source).toBe('authorized')
    expect(record?.route).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(logs.some((message) => message.type === 'info'
      && String(message.args[0]).includes('authorized child route %s/%s is the chain head — skipping role-inject')
      && message.args[2] === 'deepseek'
      && message.args[3] === 'deepseek-chat')).toBe(true)
  })

  it('skips inject for a spawn-selected route differing from the delegating parent route (authorized head, policy on)', async () => {
    const { agent: parent } = makeAgent('t2-spawn-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('t2-spawn', { provider: 'deepseek', model: 'deepseek-chat' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 't2-spawn-parent')
    provideSubagentPolicy([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'anthropic', model: 'claude-sonnet-4' },
    ])
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('injects an in-allowlist chain head for pure inheritance, explicit preset precedence unchanged (policy on)', async () => {
    const logs = captureLogs()
    const { agent: parent } = makeAgent('t2-inh-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('t2-inh', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 't2-inh-parent')
    provideSubagentPolicy([{ provider: 'anthropic', model: 'claude-sonnet-4' }])
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // agentPreset precedence unchanged: the explicit preset role still drives the inject.
    expect(logs.some((message) => message.type === 'info'
      && String(message.args[0]).includes('role-inject role=%s model=%s/%s')
      && message.args[2] === 'coder')).toBe(true)
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('skips inject when no resolved candidate is on the allowlist (empty intersection, host seed stands)', async () => {
    const logs = captureLogs()
    const { agent: parent } = makeAgent('t2-empty-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('t2-empty', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 't2-empty-parent')
    provideSubagentPolicy([{ provider: 'unrelated', model: 'unrelated-model' }])
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('outside the subagent allowlist'))).toBe(true)
  })

  it('intersects in candidate order: an out-of-allowlist head is skipped for the next in-allowlist entry (no force-apply)', async () => {
    const { agent: parent } = makeAgent('t2-force-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('t2-force', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 't2-force-parent')
    provideSubagentPolicy([{ provider: 'deepseek', model: 'deepseek-chat' }])
    apply(ctx, cfg({
      roles: { list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'] }], rules: [] },
    }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    // The out-of-allowlist head is never sent: the FIRST IN-ALLOWLIST entry wins.
    expect(config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('emits no override when the policy event is malformed (unprovable, fail-closed)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t2-unprovable', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    agent.session.append('subagent/model-selection-policy', { allowedModels: 'not-a-list' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('unreadable'))).toBe(true)
  })

  it('injects exactly as 0.3.5 when the policy is off (settings disabled, no event)', async () => {
    ctx.provide('subagentModelSelection', { current: () => ({ enabled: false, allowedModels: [] }) })
    const { agent } = makeAgent('t2-policy-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    // No allowlist filter, no authorized-route skip — the role head applies even
    // though it is not on the (inactive) allowlist: 0.3.5 selection unchanged.
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('chainHeads recording (plan dsh-012 T5 / T2 M3)', () => {
  it('records source authorized when the first request carries model/selection (policy on)', async () => {
    provideSubagentPolicy([{ provider: 'deepseek', model: 'deepseek-chat' }])
    const { agent } = makeAgent('t5-head-auth', { provider: 'deepseek', model: 'deepseek-chat' }, { origin: 'subagent', agentPreset: 'coder' })
    agent.session.append('model/selection', { provider: 'deepseek', model: 'deepseek-chat' })
    apply(ctx, cfg({ roles: coderRoles() }))

    await dispatchRequest(ctx, agent, { provider: 'deepseek', model: 'deepseek-chat' })
    const record = chainHeads(ctx)?.get('t5-head-auth')
    expect(record?.source).toBe('authorized')
    expect(record?.route).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(typeof record?.at).toBe('number')
  })

  it('records source injected when role-inject applies an in-allowlist head (policy on)', async () => {
    const { agent: parent } = makeAgent('t5-head-inj-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('t5-head-inj', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 't5-head-inj-parent')
    provideSubagentPolicy([{ provider: 'anthropic', model: 'claude-sonnet-4' }])
    apply(ctx, cfg({ roles: coderRoles() }))

    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    const record = chainHeads(ctx)?.get('t5-head-inj')
    expect(record?.source).toBe('injected')
    expect(record?.route).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('does not record an injected head when the policy is off (0.3.5 inject still happens)', async () => {
    ctx.provide('subagentModelSelection', { current: () => ({ enabled: false, allowedModels: [] }) })
    const { agent } = makeAgent('t5-head-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(chainHeads(ctx)?.get('t5-head-off')).toBeUndefined()
    expect(chainHeads(ctx)?.size).toBe(0)
  })
})
