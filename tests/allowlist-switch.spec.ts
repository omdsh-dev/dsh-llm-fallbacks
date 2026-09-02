/**
 * Allowlist-constrained failure switching (plan dsh-012-subagent-routing T3;
 * spec D1). At a subagent-origin agent's failure decision (`decide()`), the
 * RESOLVED candidates — after the existing cooldown / step-failed /
 * same-as-current filters — are intersected with the effective host allowlist
 * in candidate order (first resolved in-allowlist candidate wins). Empty
 * intersection ⇒ no switch, no request, warn log + in-memory blocked-attempt
 * record (issue #52: no session write). Policy off/absent ⇒ selection
 * identical to 0.3.5; `unprovable` ⇒ fail-closed switch skip (host seed
 * stands). Root-origin walks are untouched (spec non-goal: root behavior).
 *
 * Roles resolve to `'inherit'` (no rules, `roleAutoMatch: false`), so the
 * failure walk uses the raw rootChain and the dispatch-inject path stays
 * inert. Uses the real plugin `apply()` against the harness fake
 * agent/session (no real dsh runtime, no network).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, blockedAttempts, stateStore } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { appendLlmRetry, cfg, dispatchRequest, dispatchRequestError, makeAgent, switchEvents } from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/**
 * Capture every ctx.logger export (info/warn/...) from this point on. The
 * exporter threshold defaults to the logger level (INFO), which would drop
 * warn records — `levels.default` = DEBUG (3) lets warn (2) flow.
 */
function captureLogs(): Array<{ type: string; args: unknown[] }> {
  const logs: Array<{ type: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
}

/** Policy-on `subagentModelSelection` settings-service double (host composition stand-in). */
function provideSubagentPolicy(allowed: readonly { provider: string; model: string }[]): void {
  ctx.provide('subagentModelSelection', {
    current: () => ({ enabled: true, allowedModels: allowed.map((route) => ({ ...route })) }),
  })
}

/** Policy-off double: the service exists but is disabled (0.3.5 selection). */
function providePolicyOff(): void {
  ctx.provide('subagentModelSelection', { current: () => ({ enabled: false, allowedModels: [] }) })
}


describe('allowlist-constrained failure switching (spec D1, plan dsh-012 T3)', () => {
  it('intersects in candidate order: the first resolved in-allowlist candidate wins the switch', async () => {
    provideSubagentPolicy([{ provider: 'deepseek', model: 'deepseek-chat' }])
    const { agent } = makeAgent('t3-order', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'] }))

    // The chain head (anthropic) is OFF-allowlist; the switch must skip it and
    // take the first IN-allowlist candidate (deepseek), preserving order.
    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // Stop-write (issue #52): the switch applies but no durable event.
    expect(switchEvents(agent)).toHaveLength(0)
    // A successful switch is not a blocked attempt.
    expect(blockedAttempts(ctx)?.size).toBe(0)
  })

  it('blocks the switch on an empty intersection: no request, warn log, blocked-attempt record, no store growth', async () => {
    const logs = captureLogs()
    provideSubagentPolicy([{ provider: 'unrelated', model: 'unrelated-model' }])
    const { agent } = makeAgent('t3-empty', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4'] }))

    // 0.3.5 would switch to anthropic/claude-sonnet-4 — the allowlist empties
    // the intersection: no switch, no retry.
    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()

    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('outside the subagent allowlist'))).toBe(true)
    // Blocked-attempt record (T5 consumes; in-memory only — no session write).
    const record = blockedAttempts(ctx)?.get('t3-empty')
    expect(record?.route).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(record?.reason).toBe('trigger-code')
    expect(typeof record?.at).toBe('number')
    expect(agent.session.snapshotEvents().some((event) => event.type === 'fallbacks/switch')).toBe(false)
    // F-004 preserved: the blocked decision did not grow the fallback store.
    expect(stateStore(ctx)?.peek('t3-empty')).toBeUndefined()

    // No switch means the next request still routes the host seed — the
    // out-of-allowlist candidate is never sent.
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('switches exactly as 0.3.5 when the policy is disabled (no allowlist filter, no blocked record)', async () => {
    const logs = captureLogs()
    providePolicyOff()
    const { agent } = makeAgent('t3-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4'] }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })

    // Policy off: the chain head applies even though it is on no allowlist —
    // 0.3.5 selection unchanged.
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(blockedAttempts(ctx)?.size).toBe(0)
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('allowlist'))).toBe(false)
  })

  it('applies cooldown/step-failed filters BEFORE the allowlist intersect: a cooled in-allowlist route is never re-entered', async () => {
    provideSubagentPolicy([
      { provider: 'mock', model: 'gpt-4o' },
      { provider: 'other', model: 'gpt-4o' },
    ])
    const { agent } = makeAgent('t3-filters', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['mock/gpt-4o', 'other/gpt-4o', 'anthropic/claude-sonnet-4'] }))

    // Step 1: mock fails → same-as-current drops mock, anthropic is
    // off-allowlist → switch to other/gpt-4o (first in-allowlist survivor).
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'other', model: 'gpt-4o' })

    // Step 2: other fails → mock is in cooldown (committed at step 1) and
    // on-allowlist, other is same-as-current, anthropic is off-allowlist →
    // the intersection is EMPTY: no switch. An implementation that let the
    // allowlist bypass the cooldown filter would switch back to mock here.
    const second = await dispatchRequestError(ctx, agent, { provider: 'other', step: 2 })
    expect(second).toBeUndefined()
    expect(blockedAttempts(ctx)?.get('t3-filters')?.route).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    const config = await dispatchRequest(ctx, agent, { provider: 'other', model: 'gpt-4o' }, { step: 2 })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('skips the switch fail-closed when the policy event is malformed (unprovable), without a blocked record', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t3-unprovable', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    agent.session.append('subagent/model-selection-policy', { allowedModels: 'not-a-list' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4'] }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('unreadable'))).toBe(true)

    // Only the switch is blocked — the host seed stands and no blocked
    // record is written (unprovable is not an empty intersection; the card
    // shows the unprovable state itself, T5).
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(blockedAttempts(ctx)?.size).toBe(0)
    expect(stateStore(ctx)?.peek('t3-unprovable')).toBeUndefined()
  })

  it('leaves ROOT-origin failure switching untouched while the policy is on (non-goal: root behavior)', async () => {
    provideSubagentPolicy([{ provider: 'unrelated', model: 'unrelated-model' }])
    const { agent } = makeAgent('t3-root', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4'] }))

    // Root origin: the allowlist does not constrain the walk — 0.3.5 switch
    // to the chain head even though it is off-allowlist.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(blockedAttempts(ctx)?.size).toBe(0)
  })
})

/**
 * Guarded policy settings read (qc fix wave W-002 + S-hard): the
 * `subagentModelSelection` read is throw-safe on every request path (the
 * always-cap site had no local catch) and retains the freshest successful
 * snapshot per agent, so a mid-session service disappearance keeps a
 * proven-enabled policy constraining (fail-closed) instead of reverting to
 * unconstrained 0.3.5 switching. Agents never proven enabled stay disabled —
 * 0.3.5 selection unchanged.
 */
describe('guarded policy settings read (qc fix wave W-002 + S-hard)', () => {
  it('W-002: a throwing settings read warns and the always-cap request listener survives (host seed stands)', async () => {
    const logs = captureLogs()
    const unprovide = ctx.provide('subagentModelSelection', {
      current: () => {
        throw new Error('settings service exploded')
      },
    })
    const { agent } = makeAgent('w002-throw', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 1 }))
    // Trip the always-cap: one always-mode retry for (1, 1, mock) reaches cap 1.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })

    // Without the guard the decide() read escapes the `agent/request`
    // listener and the waterfall rejects; with it the request proceeds.
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('settings read failed')
      && String(message.args[2]).includes('settings service exploded'))).toBe(true)
    // A read failure is not an empty intersection — no blocked record.
    expect(blockedAttempts(ctx)?.size).toBe(0)
    expect(stateStore(ctx)?.peek('w002-throw')).toBeUndefined()
    unprovide()
  })

  it('S-hard: after the service disappears mid-session the last-known enabled policy still constrains (fail-closed)', async () => {
    const unprovide = ctx.provide('subagentModelSelection', {
      current: () => ({ enabled: true, allowedModels: [{ provider: 'deepseek', model: 'deepseek-chat' }] }),
    })
    const { agent } = makeAgent('s-hard-vanish', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'] }))

    // Step 1 — live read proves enabled and retains the snapshot; the switch
    // lands on the first in-allowlist candidate (deepseek), not the head.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })

    // The service disappears mid-session.
    unprovide()

    // Step 2 — a fail-open read (settings undefined → disabled) would switch
    // 0.3.5-style to the off-allowlist head anthropic; the last-known
    // snapshot keeps the allowlist blocking it instead.
    const second = await dispatchRequestError(ctx, agent, { step: 2, provider: 'deepseek' })
    expect(second).toBeUndefined()
    expect(blockedAttempts(ctx)?.get('s-hard-vanish')?.route)
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    const kept = await dispatchRequest(ctx, agent, { provider: 'deepseek', model: 'deepseek-chat' }, { step: 2 })
    expect(kept).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('S-hard: a later THROWING read falls back to the last-known enabled allowlist (still constrains)', async () => {
    let explode = false
    const unprovide = ctx.provide('subagentModelSelection', {
      current: () => {
        if (explode) throw new Error('settings service exploded')
        return { enabled: true, allowedModels: [{ provider: 'deepseek', model: 'deepseek-chat' }] }
      },
    })
    const logs = captureLogs()
    const { agent } = makeAgent('s-hard-throw', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'] }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })

    explode = true
    // The decision read throws, the warn fires, and the retained enabled
    // allowlist still keeps the off-allowlist head unsent.
    const second = await dispatchRequestError(ctx, agent, { step: 2, provider: 'deepseek' })
    expect(second).toBeUndefined()
    expect(blockedAttempts(ctx)?.get('s-hard-throw')?.route)
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('settings read failed'))).toBe(true)
    unprovide()
  })

  it('S-hard: never-enabled (disabled snapshot, then service removed) stays disabled — 0.3.5 selection unchanged', async () => {
    const unprovide = ctx.provide('subagentModelSelection', {
      current: () => ({ enabled: false, allowedModels: [] }),
    })
    const { agent } = makeAgent('s-hard-never', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roleAutoMatch: false, rootChain: ['anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'] }))

    // Step 1 — the disabled snapshot is retained as the last-known truth and
    // resolves disabled: the head switches exactly as 0.3.5.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    unprovide()
    // Step 2 — still disabled (not fail-closed): the walk takes the next
    // surviving candidate with no allowlist filter.
    expect(await dispatchRequestError(ctx, agent, { step: 2, provider: 'anthropic' })).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' }, { step: 2 }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(blockedAttempts(ctx)?.size).toBe(0)
  })
})
