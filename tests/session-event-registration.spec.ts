/**
 * issue #52 stop-write pins (commit path) — the plugin NO LONGER writes the
 * durable `fallbacks/switch` session event.
 *
 * RCA (verified): `fallbacks/switch` is a type-only augmentation
 * (`src/events.ts`), erased at runtime. The persistence read path
 * (`dsh-session-persistence` `assertEventsSupported`) refuses a log whose
 * event type is outside the host's baked `KNOWN_SESSION_EVENT_TYPES` catalog
 * unless the event carries the envelope's `ignorable` marker — which
 * `Session.append` can never write (seed-only field). The previous fix
 * registered the type into the host's catalog from `apply()`, but that
 * registration was PROVEN INEFFECTIVE at runtime: the plugin's
 * `@deepseek-ai/dsh-session` resolves to its own node_modules copy, a
 * DIFFERENT module instance from the host's pnpm-store copy, so the `.add()`
 * mutated a private Set the read path never consults — a session containing
 * `fallbacks/switch` still refused to load after a dsh restart.
 *
 * Decision: the plugin fully stops writing durable `fallbacks/switch` events.
 * Switch decisions / cooldown / failure bookkeeping / switchCount / info
 * logs remain; only the durable event is gone. These pins freeze the commit
 * path (`agent/request-error`): after `commit()` fires a switch,
 * `agent.session.append` is NOT called and the session event stream
 * (`agent.session.events`) contains no `fallbacks/switch` entry — while
 * pending/cooldown/failure/switchCount bookkeeping and the
 * `{ kind: 'retry' }` action behave exactly as before. The role-inject
 * append site is pinned in `session-event-registration-guard.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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

describe('does not write durable fallbacks/switch (commit path, issue #52)', () => {
  it('fires a trigger-code switch WITHOUT calling agent.session.append and writes no event', async () => {
    const { agent } = makeAgent('stop-write-commit', { provider: 'mock', model: 'gpt-4o' })
    const session = agent.session as unknown as { append: (type: string, data: Record<string, unknown>) => unknown }
    const originalAppend = session.append
    const append = vi.fn((type: string, data: Record<string, unknown>) => originalAppend(type, data))
    session.append = append
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    try {
      const action = await dispatchRequestError(ctx, agent, {
        failure: { message: 'quota exceeded', code: 'QUOTA' },
      })
      expect(action).toEqual({ kind: 'retry' })
    } finally {
      session.append = originalAppend
    }

    // `agent.session.append` is NOT called — no durable event is ever written.
    expect(append).not.toHaveBeenCalled()
    // And the session event stream gains no fallbacks/switch entry.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('keeps pending/cooldown/failure/switchCount bookkeeping and the retry action', async () => {
    const { agent, setRoute } = makeAgent('stop-write-books', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    const action = await dispatchRequestError(ctx, agent, {
      failure: { message: 'quota exceeded', code: 'QUOTA' },
    })
    expect(action).toEqual({ kind: 'retry' })

    // The switch bookkeeping is untouched by the removal: the pending switch
    // is written, the failed model is recorded, switchCount is bumped, and
    // cooldown/suppression is applied.
    const state = stateStore(ctx)?.peek(agent.id)
    expect(state?.pendingSwitch).toEqual({
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'inherit',
      reason: 'trigger-code',
    })
    expect(state?.stepFailures.failed.has('mock/gpt-4o')).toBe(true)
    expect(state?.stepFailures.switchCount).toBe(1)
    expect(state?.cooldown.isSuppressed('mock/gpt-4o')).toBe(true)

    // The pending switch still applies at the next request of the same
    // (turn, step) — the decision path is unchanged.
    const next = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(next).toEqual({ provider: 'other', model: 'gpt-4o' })

    // Cooldown + step-failed still double-suppress the failed model: a failure
    // on the target cannot switch back to the cooled mock (no candidate →
    // passthrough) — and still no event is written.
    setRoute('other', 'gpt-4o')
    expect(await dispatchRequestError(ctx, agent, {
      provider: 'other',
      failure: { message: 'boom', code: 'AUTH' },
    })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})
