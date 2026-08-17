/**
 * issue #52 stop-write pins (role-inject + multi-agent) — the plugin NO
 * LONGER writes the durable `fallbacks/switch` session event on ANY path.
 *
 * The RCA is summarized in `session-event-registration.spec.ts`. This file
 * pins the OTHER append site — dispatch-time role injection (`agent/request`,
 * plan fallbacks-role-automatch): the override still applies, but
 * `agent.session.append` is NOT called and no `fallbacks/switch` entry
 * reaches the session event stream. It also pins the multi-agent guarantee
 * (no event on any agent) and the fact that the old "skipping the durable
 * event" warn / `KNOWN_SESSION_EVENT_TYPES` registration seam are GONE — the
 * stop-write behavior is unconditional, not a guarded fallback, so no module
 * mock exists here (the old file mocked `@deepseek-ai/dsh-session`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
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

/** Declared taxonomy under test: role `coder` with chain head `anthropic/claude-sonnet-4`. */
function coderRoles() {
  return { list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4'] }], rules: [] }
}

describe('does not write durable fallbacks/switch (role-inject path, issue #52)', () => {
  it('applies the role-inject override WITHOUT calling agent.session.append and writes no event', async () => {
    const { agent } = makeAgent(
      'stop-write-inject',
      { provider: 'mock', model: 'gpt-4o' },
      { origin: 'subagent', agentPreset: 'coder' },
    )
    const session = agent.session as unknown as { append: (type: string, data: Record<string, unknown>) => unknown }
    const originalAppend = session.append
    const append = vi.fn((type: string, data: Record<string, unknown>) => originalAppend(type, data))
    session.append = append
    apply(ctx, cfg({ roles: coderRoles() }))

    try {
      const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
      expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    } finally {
      session.append = originalAppend
    }

    expect(append).not.toHaveBeenCalled()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('writes no fallbacks/switch on any agent across commit() and role-inject', async () => {
    const first = makeAgent(
      'stop-write-a',
      { provider: 'mock', model: 'gpt-4o' },
      { origin: 'subagent', agentPreset: 'coder' },
    )
    const second = makeAgent('stop-write-b', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], roles: coderRoles() }))

    // Agent A: role-inject on the first request (override applies).
    expect(await dispatchRequest(ctx, first.agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // Agent B: trigger-code commit (retry action applies).
    expect(await dispatchRequestError(ctx, second.agent, {
      failure: { message: 'quota exceeded', code: 'QUOTA' },
    })).toEqual({ kind: 'retry' })

    // No fallbacks/switch entry anywhere — the switch decisions still applied.
    expect(switchEvents(first.agent)).toHaveLength(0)
    expect(switchEvents(second.agent)).toHaveLength(0)
    expect(await dispatchRequest(ctx, second.agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'other', model: 'gpt-4o' })
  })
})
