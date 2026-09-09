/**
 * Dispatch-resolved subagent role records (plan subagent-role-badge T1 + T4
 * cases a–d, g): the per-apply `subagentRoleRecordMap` the role-inject block
 * writes, observed through the `subagentRoleRecords(ctx)` test seam (the
 * `chainHeads` pattern — never the closure).
 *
 * Pinned recording semantics (plan Global Constraints, cases a–d with case
 * (c)'s two skip paths pinned separately — five cases total):
 *
 * - (a) policy-off dispatch with a resolved role records `{ role, model, at }`
 *   where `model` is the route the subagent actually runs: the override
 *   target when one applies, else the seed route (both "no applicable
 *   override" flavors — no exact head, and head-equals-seed).
 * - (b) policy-on inject within the allowlist records the injected model.
 * - (c) the two skip paths diverge: the authorized-route branch NEVER records
 *   (the role is never resolved — the authorized head keeps its existing
 *   `chainHeadMap` card duty), while an empty allowlist intersection records
 *   the effective (seed) route. `'unprovable'` (fail-closed skip before
 *   resolution) never records either.
 * - (d) `inherit` is never recorded (matching the inject rule).
 * - (g) cleanup mirrors `slotWinners`: `agent/disposed` deletes the record
 *   (a re-created agent re-records — last-wins per session id), and the
 *   plugin dispose effect clears the map.
 *
 * Uses the real plugin `apply()` against the harness fake agent/session (no
 * real dsh runtime); the auto-match LLM is always a stub (never a network
 * call).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, chainHeads, subagentRoleRecords } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, makeAgent } from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** Declared taxonomy under test: role `coder` with chain head `anthropic/claude-sonnet-4`. */
function coderRoles() {
  return { list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4'] }], rules: [] }
}

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

describe('subagent role records — recording semantics (plan subagent-role-badge T4 a–d)', () => {
  it('(a) policy-off dispatch, override applied → records the override target', async () => {
    const { agent } = makeAgent('badge-a-override', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    const record = subagentRoleRecords(ctx)?.get('badge-a-override')
    expect(record).toBeDefined()
    expect(record!.role).toBe('coder')
    expect(record!.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // The record time is a real epoch stamp (the badge readback carries it).
    expect(Number.isFinite(record!.at)).toBe(true)
  })

  it('(a) policy-off dispatch, no applicable override (wildcard-only chain) → records the seed route', async () => {
    const { agent } = makeAgent('badge-a-wild', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: '', chain: ['other/*'] }], rules: [] } }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })

    const record = subagentRoleRecords(ctx)?.get('badge-a-wild')
    expect(record).toBeDefined()
    expect(record!.role).toBe('coder')
    expect(record!.model).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('(a) policy-off dispatch, head equals the seed → records the seed route (no phantom override)', async () => {
    const { agent } = makeAgent('badge-a-same', { provider: 'anthropic', model: 'claude-sonnet-4' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    const record = subagentRoleRecords(ctx)?.get('badge-a-same')
    expect(record).toBeDefined()
    expect(record!.role).toBe('coder')
    expect(record!.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('(b) policy-on inject within the allowlist → records the injected model', async () => {
    const { agent: parent } = makeAgent('badge-b-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('badge-b', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 'badge-b-parent')
    provideSubagentPolicy([{ provider: 'anthropic', model: 'claude-sonnet-4' }])
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    const record = subagentRoleRecords(ctx)?.get('badge-b')
    expect(record).toBeDefined()
    expect(record!.role).toBe('coder')
    expect(record!.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('(c) authorized-route branch → NO record (role never resolved); the authorized head keeps its card duty', async () => {
    provideSubagentPolicy([{ provider: 'deepseek', model: 'deepseek-chat' }])
    const { agent } = makeAgent('badge-c-auth', { provider: 'deepseek', model: 'deepseek-chat' }, { origin: 'subagent', agentPreset: 'coder' })
    agent.session.append('model/selection', { provider: 'deepseek', model: 'deepseek-chat' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // The badge record map stays empty — nothing was resolved, nothing to show.
    expect(subagentRoleRecords(ctx)?.size).toBe(0)
    // The authorized head keeps its EXISTING duty: the Subagents card map.
    expect(chainHeads(ctx)?.get('badge-c-auth')?.source).toBe('authorized')
  })

  it('(c) empty allowlist intersection → records the effective (seed) route', async () => {
    const { agent: parent } = makeAgent('badge-c-empty-parent', { provider: 'mock', model: 'gpt-4o' })
    provideParentAgent(parent)
    const { agent } = makeAgent('badge-c-empty', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    stampParentSession(agent, 'badge-c-empty-parent')
    provideSubagentPolicy([{ provider: 'unrelated', model: 'unrelated-model' }])
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })

    // Inject skipped, but the role WAS resolved — the badge shows the role
    // running on the effective (seed) route.
    const record = subagentRoleRecords(ctx)?.get('badge-c-empty')
    expect(record).toBeDefined()
    expect(record!.role).toBe('coder')
    expect(record!.model).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it("(c) 'unprovable' policy → NO record (fail-closed skip precedes resolution)", async () => {
    const { agent } = makeAgent('badge-c-unprovable', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    agent.session.append('subagent/model-selection-policy', { allowedModels: 'not-a-list' })
    apply(ctx, cfg({ roles: coderRoles() }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(subagentRoleRecords(ctx)?.size).toBe(0)
  })

  it('(d) inherit → NO record (never recorded, matching the inject rule)', async () => {
    const { agent } = makeAgent('badge-d-inherit', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roleAutoMatch: false }))

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(subagentRoleRecords(ctx)?.size).toBe(0)
  })
})

describe('subagent role records — cleanup on dispose (plan subagent-role-badge T4 g)', () => {
  it('(g) agent/disposed deletes the record; a re-created agent re-records (last-wins per session id)', async () => {
    const { agent } = makeAgent('badge-g-dispose', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({ roles: coderRoles() }))

    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(subagentRoleRecords(ctx)?.has('badge-g-dispose')).toBe(true)

    ctx.emit('agent/disposed', { agent })
    expect(subagentRoleRecords(ctx)?.has('badge-g-dispose')).toBe(false)

    // The session id is the badge key: a re-created agent for the SAME id
    // re-evaluates (once-marker cleaned) and its record overwrites the slot —
    // the honest "current role" semantics for a session-scoped badge.
    const { agent: second } = makeAgent('badge-g-dispose', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    await dispatchRequest(ctx, second, { provider: 'mock', model: 'gpt-4o' })
    expect(subagentRoleRecords(ctx)?.get('badge-g-dispose')).toMatchObject({
      role: 'coder',
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    })
  })

  it('(g) the plugin dispose effect clears the map (mirror of slotWinners)', async () => {
    // Separate context: this case owns its disposal (afterEach handles the
    // module-level ctx only).
    const local = new Context()
    local.plugin(MemorySettings)
    const { agent } = makeAgent('badge-g-effect', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(local, cfg({ roles: coderRoles() }))

    await dispatchRequest(local, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(subagentRoleRecords(local)?.size).toBe(1)

    await local.fiber.dispose()
    expect(subagentRoleRecords(local)?.size).toBe(0)
  })
})
