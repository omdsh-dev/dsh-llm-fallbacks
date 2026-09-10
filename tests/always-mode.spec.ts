/**
 * Always-mode cap matrix (plan Task 4, Step 2; spec §2 clause 5 / ADR-2).
 *
 * The cap lives at the `agent/request` boundary: count durable `llm/retry`
 * events for the current (turn, step, provider) with `mode: 'always'`, and
 * switch once the count reaches `alwaysModeRetryCap` (0 disables). The
 * request-error listener must NOT preempt the always backoff — llm-retry's
 * always mode delegates downstream first, so non-triggerCode failures pass
 * through (the fallback only acts on trigger codes there).
 *
 * Task 4 appends `llm/retry` events in the **real** event shape (retryId /
 * policyKey / retry / delayMs / failure …) so the counting is exercised
 * against the real bundle's payload — the `mode` discriminator must survive
 * the full shape (T3 fix review ⚠️2), and normal-mode retries must never
 * count toward the cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { apply, stateStore } from '../src/index.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import { selectorKey } from '../src/selectors.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { installLlmRetryStub } from './support/llm-retry-stub.ts'
import {
  alwaysPolicy,
  appendLlmRetry,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  llmRetryEvents,
  makeAgent,
  runAgentStep,
  switchEvents,
} from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

describe('always-mode cap at the agent/request boundary (spec §2 clause 5 / ADR-2)', () => {
  it('switches only once always-mode retries reach the cap; below the cap the request passes unchanged and request-error is not preempted', async () => {
    const { agent } = makeAgent('cap-gate', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 3 }))

    // Below the cap (2 always retries): the request passes unchanged, effort
    // and all; a non-trigger request-error (the always backoff path) is NOT
    // preempted by the fallback.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 2 })
    const below = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(below).toEqual({ provider: 'mock', model: 'gpt-4o', reasoningEffort: 'high' as ReasoningEffortId })
    expect(switchEvents(agent)).toHaveLength(0)
    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'busy', code: 'SERVER' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)

    // At the cap (3rd always retry): the next buildRequest switches — and the
    // inherited reasoningEffort is dropped with the override.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 3 })
    const switched = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(switched).toEqual({ provider: 'other', model: 'gpt-4o' })
    // Stop-write (issue #52): the cap switch applies but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('counts only always-mode events under the real llm/retry event shape (T3 fix review ⚠️2)', async () => {
    const { agent } = makeAgent('cap-shape', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 3 }))

    // Full-shape normal-mode retries (a bounded RATE_LIMIT budget): they
    // belong to llm-retry and must never count toward the cap.
    for (let retry = 1; retry <= 3; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'normal', retry, maxRetries: 5 })
    }
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Two full-shape always-mode retries — still below cap 3.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 2 })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)

    // The third always-mode retry reaches the cap → switch.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 3 })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'other', model: 'gpt-4o' })
    // Stop-write: the cap switch applies but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('scopes the count to the current (turn, step, provider)', async () => {
    const { agent } = makeAgent('cap-scope', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 3 }))

    // Retries for other (turn, step) pairs and other providers must not trip
    // the cap at (1, 1, mock) — appended in chronological order (older first).
    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 2, provider: 'other', mode: 'always', retry })
      appendLlmRetry(agent, { turn: 2, step: 1, provider: 'mock', mode: 'always', retry })
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'other', mode: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('disables the mechanism when alwaysModeRetryCap is 0', async () => {
    const { agent } = makeAgent('cap-zero', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 0 }))

    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('end to end: the llm-retry stub retries always-mode failures until the cap trips at the next build', async () => {
    // Full composition: the stub (always policy, registered first) backoffs on
    // every non-trigger failure; the fallback passes each through (ADR-2); the
    // durable always-mode llm/retry events accumulate until the cap trips at
    // the next buildRequest — then the switch applies and the step succeeds.
    installLlmRetryStub(ctx)
    const { agent, setRoute } = makeAgent('cap-e2e', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 3 }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'busy', code: 'SERVER' },
      { message: 'busy', code: 'SERVER' },
      { message: 'busy', code: 'SERVER' },
      undefined,
    ], { retryPolicy: alwaysPolicy() })

    expect(result.outcome).toBe('success')
    expect(result.requests.map((request) => request.provider)).toEqual(['mock', 'mock', 'mock', 'other'])
    expect(llmRetryEvents(agent)).toHaveLength(3)
    expect(llmRetryEvents(agent).every((event) => event.data.mode === 'always')).toBe(true)
    // Stop-write: the end-to-end cap switch applies but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

/**
 * Plan model-change-notice-loop Task 2 follow-up (implementer concern C-1):
 * the always-cap caller must start its walk at the head the virtual picker row
 * was SERVED by, exactly like the trigger-code caller does.
 *
 * Post-T1 a root-origin `FallbacksChain/Auto` seed is served unchanged, so the
 * loop records the virtual pair while `FallbacksChainAdapter.stream()` really
 * dispatches the effective chain's first dispatchable exact head. A cap-tripped
 * decision handed the raw seed pair would therefore commit
 * `FallbacksChain/Auto → <head>` — "switching" straight back into the route
 * that was just being retried — and would key the cooldown / step-failed
 * bookkeeping on the picker key instead of the failing route (plan Decision 3).
 */
describe('always-mode cap anchored at the served head (root virtual route)', () => {
  /** The virtual picker row as a request seed (exact strings, spec lock). */
  const virtualSeed = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL }

  it('starts a cap-tripped walk at the served head and keeps the picker key out of the bookkeeping', async () => {
    const { agent } = makeAgent('cap-anchor', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    // A conforming all-day chain (official tail) whose first dispatchable exact
    // head is a real route: the adapter serves the virtual row from there, and
    // the walk has a target past it.
    apply(ctx, cfg({
      rootChain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', OFFICIAL_FLASH],
      alwaysModeRetryCap: 3,
    }))

    // The virtual row is served unchanged, so llm-retry accounts its retries to
    // the served route — which post-T1 IS the virtual pair.
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual(virtualSeed)

    for (let retry = 1; retry <= 3; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: FALLBACKS_PROVIDER, mode: 'always', retry })
    }

    // Cap tripped: the walk must move PAST the served head, not re-target it.
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual({ provider: 'openai', model: 'gpt-4o' })

    const state = stateStore(ctx)?.peek(agent.id)
    // Route-scoped bookkeeping belongs to the route the walk STARTED at — the
    // head the virtual row was served by. (The cap applies its pending switch
    // inside the same call, so the surviving evidence of `from` is the cooldown
    // / step-failed keys `commit` wrote for it; pre-fix both landed on the
    // picker key and neither landed on the head.)
    expect(state?.cooldown.peek('anthropic/claude-sonnet-4')).toBeDefined()
    expect(state?.cooldown.peek(selectorKey(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL))).toBeUndefined()
    expect(state?.stepFailures.failed.has('anthropic/claude-sonnet-4')).toBe(true)
    expect(state?.stepFailures.failed.has(selectorKey(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL))).toBe(false)
  })
})

/**
 * Plan model-change-notice-loop Task 4 (PM-added items). The T2 case above
 * proves WHERE a cap-tripped walk starts; these two close the two remaining
 * gaps that only exist on the root VIRTUAL route:
 *
 * - **E24 reachability (boundary)**: the cap counts `llm/retry` events by
 *   `seed.provider`. Pre-T1 the seed was rewritten to the head, so the cap
 *   counted the virtual pair while llm-retry recorded the head — the count
 *   could never reach the cap. Post-T1 the served route IS the virtual pair, so
 *   the count key and the recorded key coincide; pinned here at the boundary
 *   (below the cap: no switch; at the cap: switch).
 * - **half-open probe anchoring**: with no surviving candidate the cap path
 *   hands `failHalfOpenProbe` the ANCHORED route. Keyed on the picker pair it
 *   would look up a half-open episode for `FallbacksChain/Auto` — never the
 *   route that actually failed — and go silently inert (rule 5b never fires).
 */
describe('always-mode cap and half-open probe on the virtual route (Task 4)', () => {
  /** The virtual picker row as a request seed (exact strings, spec lock). */
  const virtualSeed = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL }

  it('trips the cap on the virtual route: the served pair is the count key', async () => {
    const { agent } = makeAgent('cap-virtual-trip', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    // A conforming all-day chain (the official row LAST — `isAllDayConforming`
    // reads the tail) whose first dispatchable exact head is a real route with
    // one candidate behind it, so a cap switch has somewhere to go.
    apply(ctx, cfg({ rootChain: ['openai/gpt-4o', OFFICIAL_FLASH], alwaysModeRetryCap: 3 }))

    // Served unchanged, so llm-retry accounts its always retries to the SAME
    // key the cap counts (the post-T1 premise).
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual(virtualSeed)
    for (let retry = 1; retry <= 2; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: FALLBACKS_PROVIDER, mode: 'always', retry })
    }
    // Below the cap: still served on the virtual route, unchanged.
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual(virtualSeed)

    appendLlmRetry(agent, { turn: 1, step: 1, provider: FALLBACKS_PROVIDER, mode: 'always', retry: 3 })
    // The cap-th always retry trips it: the walk starts at the SERVED head
    // (openai/gpt-4o) and moves past it.
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('re-suppresses the SERVED HEAD when a cap-tripped virtual-route walk has no target (half-open probe)', async () => {
    const { agent } = makeAgent('cap-virtual-half-open', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    // A conforming all-day with NO candidate past the head: the cap-trip
    // decision is null, the single path that reaches the half-open probe writer.
    apply(ctx, cfg({
      rootChain: [OFFICIAL_FLASH],
      recovery: 'half-open',
      cooldownMs: 300_000,
      alwaysModeRetryCap: 3,
    }))
    vi.useFakeTimers()
    const t0 = Date.now()

    // Seed the live episode the P2 way: one prior suppression (n = 1) and then a
    // lapsed cooldown the read path leaves half-open (rule 1 → rule 3), so a
    // probe failure must escalate to n = 2.
    const store = stateStore(ctx)!
    const state = store.get(agent.id)
    expect(state.recovery.recordFailure(OFFICIAL_FLASH)).toBe(1)
    state.recovery.markHalfOpen(OFFICIAL_FLASH, t0)
    expect(state.recovery.isHalfOpen(OFFICIAL_FLASH)).toBe(true)

    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual(virtualSeed)
    for (let retry = 1; retry <= 3; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: FALLBACKS_PROVIDER, mode: 'always', retry })
    }
    // Cap tripped, no candidate survives the walk → the probe writer runs on
    // the anchored route.
    expect(await dispatchRequest(ctx, agent, virtualSeed)).toEqual(virtualSeed)

    // Rule 5b lands on the SERVED HEAD: re-suppressed escalated (n = 2).
    expect(state.cooldown.peek(OFFICIAL_FLASH)).toBe(t0 + 600_000)
    expect(state.recovery.isHalfOpen(OFFICIAL_FLASH)).toBe(false)
    // The picker pair is not a route that failed: nothing is keyed on it.
    const pickerKey = selectorKey(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)
    expect(state.cooldown.peek(pickerKey)).toBeUndefined()
    expect(state.recovery.isHalfOpen(pickerKey)).toBe(false)
  })
})
