/**
 * Context-window-aware fallback tests (request-scoped switching + the
 * context-window candidate filter).
 *
 * Two behaviors, both entered only when the operator lists
 * `CONTEXT_WINDOW_EXCEEDED` in `triggerCodes` (dsh core's canonical code for a
 * provider 400 "maximum context length"; not retryable, so llm-retry never
 * owns it, and once listed this plugin handles the rejection before the
 * harness's compaction plugin compacts anything):
 *
 * - **commit scope**: a context-window rejection is a REQUEST failure on a
 *   healthy route, so `commit()` keeps the step-scoped bookkeeping (failed set
 *   + switch count) but writes no cooldown and no half-open recovery failure.
 *   Every other trigger code stays route-scoped, byte-identical to 0.4.2 —
 *   pinned here alongside the request-scoped case.
 * - **candidate filter**: candidates whose advertised context window is not
 *   LARGER than the failing model's cannot fit the request either and are
 *   skipped (`skipped: context-window` in the candidates log); an undisclosed
 *   window keeps the candidate, and the catalog is probed only for this
 *   trigger. Windows are read from the advertised catalog row when it carries
 *   one, else from `resolveModelInfo(provider, model)`'s
 *   `context.contextWindow` (where dsh 0.1.5-rc.1 puts it).
 *
 * Drives the real plugin `apply()` against the shared harness fake
 * agent/session (`tests/support/harness.ts`), like `tests/runtime.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, stateStore } from '../src/index.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, dispatchRequestError, makeAgent } from './support/harness.ts'

/** The dsh failure the provider 400 "maximum context length" maps to. */
const overflow = { message: "This model's maximum context length is 8192 tokens", code: 'CONTEXT_WINDOW_EXCEEDED' }

/** Trigger list with the context-window code added (the docs' example). */
const triggerCodes = ['AUTH', 'QUOTA', 'RATE_LIMIT', 'CONTEXT_WINDOW_EXCEEDED']

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

/** The `candidates=%o` array arg of the nth switch info log line. */
function switchLogCandidates(logs: Array<{ type: string; args: unknown[] }>, index: number): unknown[] {
  const switchLogs = logs.filter((message) => message.type === 'info' && String(message.args[0]).includes('switch'))
  const candidates = switchLogs[index]?.args.find((arg) => Array.isArray(arg))
  return (candidates ?? []) as unknown[]
}

describe('commit scope — a context-window switch does not cool down the healthy route', () => {
  it('records the step failure and the switch but leaves the from-route unsuppressed', async () => {
    const { agent } = makeAgent('cw-request-scoped', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['other/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent, { failure: overflow })).toEqual({ kind: 'retry' })

    const state = stateStore(ctx)?.peek(agent.id)
    // The switch itself is unchanged — same target, same reason — and carries
    // the request scope that told commit() to skip the cooldown write.
    expect(state?.pendingSwitch).toEqual({
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'inherit',
      reason: 'trigger-code',
      scope: 'request',
    })
    // Step-scoped bookkeeping KEPT: this step must not bounce back to the
    // model that just rejected the request, and the valve still counts it.
    expect(state?.stepFailures.failed.has('mock/gpt-4o')).toBe(true)
    expect(state?.stepFailures.switchCount).toBe(1)
    // Route-scoped bookkeeping SKIPPED: the route is healthy — the request was
    // too big — so no suppression is written at all.
    expect(state?.cooldown.isSuppressed('mock/gpt-4o')).toBe(false)
    expect(state?.cooldown.peek('mock/gpt-4o')).toBeUndefined()
    // The switch still applies at the next request of the same (turn, step).
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('leaves a route-scoped switch (any other trigger code) exactly as before', async () => {
    const { agent } = makeAgent('cw-route-scoped', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['other/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })

    const state = stateStore(ctx)?.peek(agent.id)
    // No scope key on the pending switch: absent IS route-scoped (0.4.2 shape).
    expect(state?.pendingSwitch).toEqual({
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'inherit',
      reason: 'trigger-code',
    })
    expect(state?.stepFailures.failed.has('mock/gpt-4o')).toBe(true)
    expect(state?.stepFailures.switchCount).toBe(1)
    expect(state?.cooldown.isSuppressed('mock/gpt-4o')).toBe(true)
  })

  it('does not feed the half-open recovery counter (the next route failure is a FLAT cooldown)', async () => {
    const { agent, setRoute } = makeAgent('cw-recovery', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      triggerCodes,
      rootChain: ['other/gpt-4o'],
      recovery: 'half-open',
      cooldownMs: 300_000,
    }))
    vi.useFakeTimers()
    const t0 = Date.now()

    // A context-window rejection on mock: request-scoped, so the recovery
    // consecutive-failure counter for mock/gpt-4o stays at 0.
    expect(await dispatchRequestError(ctx, agent, { failure: overflow })).toEqual({ kind: 'retry' })
    const state = stateStore(ctx)?.peek(agent.id)
    expect(state?.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state?.cooldown.peek('mock/gpt-4o')).toBeUndefined()

    // A genuine route failure on mock at the next step now escalates from
    // n = 1 → FLAT cooldownMs. Had the context-window switch recorded a
    // recovery failure, this would be n = 2 → 600_000 (escalation ×2).
    setRoute('mock', 'gpt-4o')
    expect(await dispatchRequestError(ctx, agent, { turn: 2, step: 1 })).toEqual({ kind: 'retry' })
    expect(state?.cooldown.peek('mock/gpt-4o')).toBe(t0 + 300_000)
  })
})

describe('context-window candidate filter — skip what cannot fit either', () => {
  /** Catalog rows that disclose their window on the advertised entry. */
  function provideCatalogWithWindows(): void {
    ctx.provide('llm', {
      listModels: async (provider: string) => ({
        mock: [{ id: 'gpt-4o', contextWindow: 8_192 }],
        small: [{ id: 'tiny', contextWindow: 4_096 }],
        big: [{ id: 'wide', contextWindow: 200_000 }],
      }[provider] ?? []),
    })
  }

  it('picks the first candidate with a larger window and logs the skipped one', async () => {
    provideCatalogWithWindows()
    const logs = captureLogs()
    const { agent } = makeAgent('cw-filter', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['small/tiny', 'big/wide'] }))

    expect(await dispatchRequestError(ctx, agent, { failure: overflow })).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'big', model: 'wide' })
    expect(switchLogCandidates(logs, 0)).toEqual([
      'small/tiny (skipped: context-window)',
      'big/wide',
    ])
  })

  it('reads the window from resolveModelInfo when the catalog row does not carry one (dsh 0.1.5-rc.1)', async () => {
    const windows: Record<string, number> = { 'mock/gpt-4o': 8_192, 'small/tiny': 4_096, 'big/wide': 200_000 }
    ctx.provide('llm', {
      listModels: async (provider: string) => ({
        mock: [{ id: 'gpt-4o' }],
        small: [{ id: 'tiny' }],
        big: [{ id: 'wide' }],
      }[provider] ?? []),
      resolveModelInfo: async (provider: string, model: string) =>
        ({ context: { contextWindow: windows[`${provider}/${model}`] } }),
    })
    const logs = captureLogs()
    const { agent } = makeAgent('cw-resolve', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['small/tiny', 'big/wide'] }))

    expect(await dispatchRequestError(ctx, agent, { failure: overflow })).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'big', model: 'wide' })
    expect(switchLogCandidates(logs, 0)).toEqual([
      'small/tiny (skipped: context-window)',
      'big/wide',
    ])
  })

  it('keeps candidates whose window is undisclosed (a catalog without metadata never empties the chain)', async () => {
    ctx.provide('llm', { listModels: async () => [] })
    const { agent } = makeAgent('cw-unknown', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['small/tiny'] }))

    expect(await dispatchRequestError(ctx, agent, { failure: overflow })).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'small', model: 'tiny' })
  })

  it('passes the original failure through when no candidate can fit (F-004: no state grown)', async () => {
    provideCatalogWithWindows()
    const { agent } = makeAgent('cw-none-fit', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['small/tiny'] }))

    expect(await dispatchRequestError(ctx, agent, { failure: overflow })).toBeUndefined()
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('probes the catalog only for the context-window trigger (every other code stays zero-probe)', async () => {
    const listModels = vi.fn(async () => [])
    ctx.provide('llm', { listModels })
    const { agent } = makeAgent('cw-zero-probe', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ triggerCodes, rootChain: ['other/gpt-4o'] }))

    // An AUTH walk over an exact chain: neither the existence probe (F-002)
    // nor the window lookup has anything to do.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(listModels).not.toHaveBeenCalled()

    // The same chain under a context-window trigger builds the lookup once per
    // decision, over the failing provider plus every candidate provider.
    expect(await dispatchRequestError(ctx, agent, { turn: 2, step: 1, failure: overflow })).toEqual({ kind: 'retry' })
    expect(listModels.mock.calls.flat()).toEqual(['mock', 'other'])
  })

  /**
   * Virtual-route case (plan model-change-notice-loop Task 2): the failing
   * ROUTE is the head the adapter delegated to, so the window the candidates
   * are compared against is the HEAD's — not the virtual row's. Anchored, the
   * head's 4096 rejects the equally small sibling and the walk reaches the
   * 200 000 row; left on the virtual pair the comparison degenerates to
   * "unknown" and the walk stops at the first chain entry.
   */
  it('compares against the SERVED head window when the route is the virtual row', async () => {
    ctx.provide('llm', {
      listModels: async (provider: string) => ({
        small: [{ id: 'tiny', contextWindow: 4_096 }],
        mid: [{ id: 'narrow', contextWindow: 4_096 }],
        big: [{ id: 'wide', contextWindow: 200_000 }],
      }[provider] ?? []),
    })
    const logs = captureLogs()
    const { agent } = makeAgent('cw-virtual', {
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
    // Conforming all-day tail (the delegate gate) with a real head first: the
    // request stays on `FallbacksChain/Auto` and the adapter serves it with
    // `small/tiny`.
    apply(ctx, cfg({
      triggerCodes,
      rootChain: ['small/tiny', 'mid/narrow', 'big/wide', OFFICIAL_FLASH],
    }))

    expect(await dispatchRequestError(ctx, agent, {
      provider: FALLBACKS_PROVIDER,
      failure: overflow,
    })).toEqual({ kind: 'retry' })

    const state = stateStore(ctx)?.peek(agent.id)
    expect(state?.pendingSwitch?.from).toEqual({ provider: 'small', model: 'tiny' })
    expect(state?.pendingSwitch?.to).toEqual({ provider: 'big', model: 'wide' })
    expect(switchLogCandidates(logs, 0)).toContain('mid/narrow (skipped: context-window)')
  })
})
