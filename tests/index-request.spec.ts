/**
 * Virtual-route pass-through tests (plan model-change-notice-loop Task 1;
 * this file previously pinned the select-is-primary rewrite of plan
 * fallbacks-virtual-chain Task 2, P3).
 *
 * At `agent/request` a ROOT-origin seed of `FallbacksChain/Auto` (the virtual
 * picker row) is returned UNCHANGED — the plugin does not rewrite the route,
 * so the route the loop serves and records equals the session selection and
 * the host `model-selection` notice cannot loop (`.mstar/plans/
 * model-change-notice-loop.md` § Intent). The virtual row keeps its meaning
 * through `FallbacksChainAdapter.stream()`, which delegates the request to the
 * effective chain's first dispatchable exact head — that contract, on the
 * exact route this file asserts, lives in `tests/virtual-adapter.spec.ts`.
 *
 * Consequently the chain configuration is irrelevant on this path: a
 * slot-winning chain, a wildcard-first chain, a wildcard-only chain, an empty
 * all-day chain and a legacy multi-model chain all pass through with no
 * routing change and no warn. A real catalog selection keeps v0.2.2
 * fallback-only semantics, a subagent-origin seed behaves as before (P1's thin
 * `stream()` delegate handles it), and a pending failure switch — applied
 * before this point — still wins.
 *
 * Uses the real plugin `apply()` against the harness fake agent/session —
 * no LLM runtime needed (this path is pure routing; the virtual adapter
 * contract lives in tests/virtual-adapter.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, stateStore } from '../src/index.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import { selectorKey } from '../src/selectors.ts'
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

describe('virtual-route pass-through (root agent/request never rewrites)', () => {
  it('serves a root-origin FallbacksChain seed unchanged and records the virtual pair', async () => {
    const { agent } = makeAgent('t2-root', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    // The loop folds the SERVED config into the request header (harness
    // `dispatchRequest` mirrors that). The host's notice listener compares the
    // selection against this value, so a rewritten route here is what made the
    // notice fire on every step.
    expect(agent.session.requestHeader()?.config).toEqual(virtualSeed)
  })

  it('passes a real catalog selection through untouched (fallback-only semantics kept)', async () => {
    const { agent } = makeAgent('t2-real', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))

    const config = await dispatchRequest(ctx, agent, { provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('never overrides a subagent-origin FallbacksChain seed (P1 delegate handles it)', async () => {
    const { agent } = makeAgent('t2-sub', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
  })

  it('treats a missing origin header as root and serves the seed unchanged', async () => {
    const { agent } = makeAgent('t2-noheader', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(agent.session.requestHeader()?.config).toEqual(virtualSeed)
  })

  it('does not override when the plugin is disabled', async () => {
    const { agent } = makeAgent('t2-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ enabled: false, rootChain: [OFFICIAL_FLASH] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
  })

  it('serves the seed unchanged when a slot row wins (the slot only steers the failure walk)', async () => {
    const { agent } = makeAgent('t2-slot', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['anthropic/claude-sonnet-4'] }],
      }),
    )
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(agent.session.requestHeader()?.config).toEqual(virtualSeed)
  })

  it('serves the seed unchanged for a wildcard-first chain (no head is picked on this path)', async () => {
    const { agent } = makeAgent('t2-first', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'anthropic/claude-sonnet-4'] }],
      }),
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
  })

  it('does not warn for a wildcard-only chain (the head walk belongs to the adapter)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t2-wild', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*'] }],
      }),
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('no exact head'))).toBe(false)
  })

  it('does not warn for an empty all-day chain (conformance is the adapter gate, not a routing gate)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t2-empty', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('not conforming'))).toBe(false)
  })

  it('does not warn for a legacy multi-model all-day chain (PR #62 feedback)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('t2-legacy', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o', 'other/gpt-5'] }))

    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual(virtualSeed)
    expect(logs.some((message) => message.type === 'warn' && String(message.args[0]).includes('not conforming'))).toBe(false)
  })

  it('a pending failure switch still wins over the virtual seed (applied before this point)', async () => {
    const { agent } = makeAgent('t2-pending', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
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
    // candidate.
    expect(await dispatchRequestError(ctx, agent, { provider: 'anthropic' })).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, virtualSeed)
    expect(config).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })
})

/**
 * Failure walk on the virtual route (plan model-change-notice-loop Task 2).
 *
 * Post-T1 the plugin serves a root-origin `FallbacksChain/Auto` seed unchanged,
 * so `agent/request-error` reports the VIRTUAL pair while the request was
 * really dispatched by `FallbacksChainAdapter.stream()` to the effective
 * chain's first dispatchable exact head. The walk must therefore start from
 * that head: anchored on the virtual pair it would treat the head that just
 * failed as a fresh candidate (switching straight back into the failure) and
 * would cool down the picker key instead of the failing route.
 */
describe('failure walk anchored at the served head (root virtual route)', () => {
  it('attributes the failure to the head the virtual row was served by, not to the virtual pair', async () => {
    const { agent } = makeAgent('t2-anchor', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    // A conforming all-day chain (official tail) whose FIRST dispatchable exact
    // head is a real route: the adapter serves the virtual row by delegating
    // there, and the walk has a target past it.
    apply(ctx, cfg({ rootChain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', OFFICIAL_FLASH] }))

    // Serve the virtual route: the plugin rewrites nothing, the loop records the
    // virtual pair, and the delegate dispatches to anthropic.
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual(virtualSeed)

    expect(await dispatchRequestError(ctx, agent, { provider: FALLBACKS_PROVIDER })).toEqual({ kind: 'retry' })

    const state = stateStore(ctx)?.peek(agent.id)
    // The decision starts at the route that really failed (the head) — so the
    // walk moves PAST it instead of re-targeting the model that just rejected
    // the request.
    expect(state?.pendingSwitch?.from).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(state?.pendingSwitch?.to).toEqual({ provider: 'openai', model: 'gpt-4o' })
    // Route-scoped bookkeeping (AUTH) belongs to the failing ROUTE: the head is
    // suppressed and step-failed, the virtual picker key is untouched.
    expect(state?.cooldown.peek('anthropic/claude-sonnet-4')).toBeDefined()
    expect(state?.cooldown.peek(selectorKey(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL))).toBeUndefined()
    expect(state?.stepFailures.failed.has('anthropic/claude-sonnet-4')).toBe(true)
    expect(state?.stepFailures.failed.has(selectorKey(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL))).toBe(false)
  })
})
