/**
 * Select-is-primary routing tests (plan fallbacks-virtual-chain Task 2, P3).
 *
 * At `agent/request` — after `await next()` and AFTER pending-switch
 * application (a failure decision always wins) — a ROOT-origin seed of
 * `fallbacks/FallbacksChain` (the virtual picker row) overrides to the
 * FIRST EXACT head of the effective chain, via the existing
 * `overrideConfig` path. The effective chain comes from
 * `resolveEffectiveChain` (src/time-slots.ts) — the single source: the
 * winning slot row's chain replaces the all-day chain, and there is NO
 * `rootChain[0]` fallback branch here. `provider/*` wildcards are never
 * seeds; a wildcard-only (or empty) effective chain yields one warn and no
 * override. Any real catalog model selection keeps v0.2.2 fallback-only
 * semantics (no override). Subagent-origin seeds that still carry the
 * virtual pair are NOT overridden here — P1's thin `stream()` delegate
 * handles them.
 *
 * Uses the real plugin `apply()` against the harness fake agent/session —
 * no LLM runtime needed (this override is pure routing; the virtual
 * adapter contract lives in tests/virtual-adapter.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { OFFICIAL_V4_FLASH } from '../src/time-slots.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, dispatchRequestError, makeAgent } from './support/harness.ts'

/** The virtual picker row as a request seed (exact strings, spec lock). */
const virtualSeed = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL }

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  vi.useRealTimers()
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

describe('select-is-primary routing (P3)', () => {
  it('overrides a root-origin FallbacksChain seed to the effective head', async () => {
    const { agent } = makeAgent('t2-root', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('does not override a real catalog selection (fallback-only semantics kept)', async () => {
    const { agent } = makeAgent('t2-real', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))

    const config = await dispatchRequest(ctx, agent, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(config).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('never overrides a subagent-origin FallbacksChain seed (P1 delegate handles it)', async () => {
    const { agent } = makeAgent('t2-sub', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
  })

  it('treats a missing origin header as root (overrides)', async () => {
    const { agent } = makeAgent('t2-noheader', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('does not override when the plugin is disabled', async () => {
    const { agent } = makeAgent('t2-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ enabled: false, rootChain: [OFFICIAL_V4_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
  })

  it('overrides to the winning slot row head, not rootChain[0] (resolver is the single source)', async () => {
    const { agent } = makeAgent('t2-slot', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_V4_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['anthropic/claude-sonnet-4'] }],
      }),
    )
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('picks the FIRST exact head, skipping earlier wildcard entries', async () => {
    const { agent } = makeAgent('t2-first', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_V4_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'anthropic/claude-sonnet-4'] }],
      }),
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('warns once and skips when the effective chain is wildcard-only (no exact head)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t2-wild', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_V4_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*'] }],
      }),
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('no exact head'))).toBe(true)
  })

  it('warns once and skips when the effective chain is empty', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t2-empty', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('no exact head'))).toBe(true)
  })

  it('a pending failure switch wins over the FallbacksChain primary (detection after pending-switch application)', async () => {
    const { agent } = makeAgent('t2-pending', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_V4_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'] }],
      }),
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    // P7 (plan fallbacks-timeslots Task 2): the root-origin failure walk
    // walks the SLOT-effective chain (replaces the rootChain argument of the
    // root role's resolveChainViews) → the first failure switches to the
    // slot head (anthropic), not the all-day head.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, virtualSeed))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

    // Second failure on the slot head: the walk progresses past it (same
    // model filtered) → the pending switch targets the NEXT effective-chain
    // candidate — which the select-is-primary override would never pick.
    expect(await dispatchRequestError(ctx, agent, { provider: 'anthropic' })).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })
})
