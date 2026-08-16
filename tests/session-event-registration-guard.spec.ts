/**
 * issue #52 guard pin — when the runtime registration is unavailable,
 * `commit()` must skip the durable `fallbacks/switch` append: never write an
 * event the host read path would refuse, never throw, and leave the switch
 * decision / cooldown / step bookkeeping untouched.
 *
 * The plugin's ONLY runtime use of `@deepseek-ai/dsh-session` is the
 * namespace read of `KNOWN_SESSION_EVENT_TYPES` in `apply()` (src/index.ts;
 * every other import is type-only, erased at runtime). Mocking the package
 * with the export unavailable therefore drives the REAL `apply()`
 * registration block into the failure branch — the same decision path an
 * out-of-repo consumer hits, end to end, with no production test seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, dispatchRequestError, makeAgent, switchEvents } from './support/harness.ts'

// Simulate the catalog export being unavailable (a future dsh may drop it,
// or replace it with a real registration surface): `KNOWN_SESSION_EVENT_TYPES`
// reads as `undefined`, so apply()'s registration block records
// `sessionEventRegistered === false` and the commit() guard must engage.
vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return { ...actual, KNOWN_SESSION_EVENT_TYPES: undefined }
})

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('commit() append guard when registration is unavailable (issue #52)', () => {
  it('skips the durable event, does not throw, keeps the switch, and warns once', async () => {
    const logs: Array<{ type: string; args: unknown[] }> = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    const first = makeAgent('guard-a', { provider: 'mock', model: 'gpt-4o' })
    const second = makeAgent('guard-b', { provider: 'mock', model: 'gpt-4o' })

    // Two switches on two agents: both commit() runs hit the guard, but the
    // warn is rate-limited to once per apply. The decision path still claims
    // recovery ({ kind: 'retry' }) — only the durable event is skipped.
    await expect(dispatchRequestError(ctx, first.agent, {
      provider: 'mock',
      failure: { message: 'quota exceeded', code: 'QUOTA' },
    })).resolves.toEqual({ kind: 'retry' })
    await expect(dispatchRequestError(ctx, second.agent, {
      provider: 'mock',
      failure: { message: 'quota exceeded', code: 'QUOTA' },
    })).resolves.toEqual({ kind: 'retry' })

    // The session event stream gains no fallbacks/switch entry.
    expect(switchEvents(first.agent)).toHaveLength(0)
    expect(switchEvents(second.agent)).toHaveLength(0)

    // The switch bookkeeping is unaffected: the pending switch still applies
    // at the next request of the same (turn, step).
    const next = await dispatchRequest(ctx, first.agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 1, step: 1 })
    expect(next).toEqual({ provider: 'other', model: 'gpt-4o' })

    // Exactly one warn naming the skipped event type (rate-limited per apply).
    const warns = logs.filter((message) => message.type === 'warn' && String(message.args[0]).includes('fallbacks/switch'))
    expect(warns).toHaveLength(1)
  })
})
