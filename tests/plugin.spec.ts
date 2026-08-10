/**
 * End-to-end re-integration tests for the real plugin `apply()` (plan Task 4 —
 * Task 3's "small integration" upgraded to full composition coverage).
 *
 * Covers, through real waterfall dispatches against a mock ctx:
 * - the request-error → request closed loop (spec §5 table / ADR-4),
 * - the per-agent state machine (spec §5.1): pendingSwitch apply → clear →
 *   anti-replay, fresh-decision-supersedes, step-advance reset,
 *   `agent/disposed` + plugin dispose no-residual (spec §6),
 * - cooldown / revert integration (US-4): cooled-out exclusion,
 *   `cooldown-expiry` revert to the main model, `never` no-revert,
 * - the safety valve (spec §2 clause 4): the terminal `LlmError` keeps the
 *   original code and message (spec §6),
 * - the AC-8 no-op regression (unconfigured / disabled → zero events),
 * - the composition order with a model-selection listener (T3 review ⚠️3:
 *   the real bundle registers agent-default-model's `installModelSelection`
 *   before this plugin — both orders must keep fallback switching intact),
 * - the marker handoff under an active selection (Task 2 / spec §2.5 D-1:
 *   the switched step routes to the chain target, the next step reverts to
 *   the user selection).
 *
 * The dual-plugin matrix with the llm-retry semantic double lives in
 * `tests/coexist-llm-retry.spec.ts`; the always-mode cap matrix lives in
 * `tests/always-mode.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { apply, stateStore } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  appendLlmRetry,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  LlmError,
  makeAgent,
  runAgentStep,
  switchEvents,
} from './support/harness.ts'
import { installModelSelectionStub, type ModelSelectionRef } from './support/model-selection-stub.ts'

/**
 * Task 2 (spec §2.5 D-1): the plugin value-imports `markFallbackRouted` from
 * `@deepseek-ai/dsh-agent`, but the link farm resolves the UNPATCHED dsh-agent
 * (dsh-private tree), which does not export the marker functions — so the
 * import would be `undefined` at runtime. This mock simulates the patched
 * module: the plugin's `markFallbackRouted` and the stub's `isFallbackRouted`
 * (both resolved through this mock) share ONE WeakSet registry, exactly like
 * the patched real module's single-process module-level WeakSet.
 */
vi.mock('@deepseek-ai/dsh-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-agent')>()
  const fallbackRouted = new WeakSet<object>()
  return {
    ...original,
    markFallbackRouted: (config: object) => { fallbackRouted.add(config); return config },
    isFallbackRouted: (config: object) => fallbackRouted.has(config),
  }
})

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

describe('closed loop through the request boundary (real apply, ADR-4)', () => {
  it('switches on a trigger code and continues the same step on the target model', async () => {
    const { agent, setRoute } = makeAgent('loop-quota', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'quota exceeded', code: 'QUOTA' },
      undefined,
    ])
    expect(result.outcome).toBe('success')
    expect(result.requests.map((request) => request.provider)).toEqual(['mock', 'other'])
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data).toEqual({
      turn: 1,
      step: 1,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'default',
      reason: 'trigger-code',
    })
  })

  it('drops an inherited reasoningEffort when applying a switch (withoutInheritedEffort pattern)', async () => {
    const { agent } = makeAgent('loop-effort', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
      temperature: 0.7,
    })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o', temperature: 0.7 })
  })
})

describe('per-agent state machine integration (spec §5.1)', () => {
  it('clears the pending switch after application and never replays it at the same (turn, step)', async () => {
    const { agent } = makeAgent('sm-replay', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const store = stateStore(ctx)
    expect(store?.peek(agent.id)?.pendingSwitch).toBeDefined()

    const applied = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(applied).toEqual({ provider: 'other', model: 'gpt-4o' })
    // Applied → cleared, with the (turn, step) recorded (anti-replay).
    expect(store?.peek(agent.id)?.pendingSwitch).toBeUndefined()
    expect(store?.peek(agent.id)?.appliedTurnStep).toEqual({ turn: 1, step: 1 })

    // Same (turn, step) again: no replay — the seed passes through untouched.
    const again = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(again).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('applies a chain decision B→C at the same (turn, step) after A→B (fresh decision supersedes)', async () => {
    const { agent, setRoute } = makeAgent('sm-chain', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['b/x', 'c/x'] } }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'auth one', code: 'AUTH' },
      { message: 'auth two', code: 'AUTH' },
      undefined,
    ])
    expect(result.outcome).toBe('success')
    expect(result.requests.map((request) => `${request.provider}/${request.model}`)).toEqual([
      'mock/gpt-4o',
      'b/x',
      'c/x',
    ])
    expect(switchEvents(agent).map((event) => event.data.to)).toEqual([
      { provider: 'b', model: 'x' },
      { provider: 'c', model: 'x' },
    ])
  })

  it('resets the failed set when the step advances (revert to main on a later step)', async () => {
    const { agent, setRoute } = makeAgent('sm-step-reset', { provider: 'mock', model: 'gpt-4o' })
    // cooldownMs 0: the cooldown expires immediately, isolating the failed-set
    // reset as the deciding mechanism at the new step.
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] }, cooldownMs: 0 }))

    // Step 1: mock fails → switch to other (mock is step-failed at step 1).
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Step 2 (advanced): other fails → mock is re-eligible — syncStep reset the
    // failed set for (1, 2) → revert to the main model.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 2, provider: 'other' })).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[1]?.data.to).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('leaves no residual state after agent/disposed and plugin dispose (spec §6)', async () => {
    const { agent, setRoute } = makeAgent('sm-residual', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const store = stateStore(ctx)
    expect(store?.size).toBe(1)

    // agent/disposed removes the agent's state: the cooldown no longer suppresses.
    ctx.emit('agent/disposed', { agent })
    expect(store?.size).toBe(0)
    setRoute('other', 'gpt-4o')
    expect(await dispatchRequestError(ctx, agent, { provider: 'other' })).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(2)

    // Plugin dispose (the effect cleanup runs with the fiber) clears everything.
    await ctx.fiber.dispose()
    expect(store?.size).toBe(0)
  })
})

describe('cooldown / revert integration (US-4)', () => {
  it('excludes a cooled model until its cooldown expires', async () => {
    const { agent, setRoute } = makeAgent('cooldown-cooled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] }, cooldownMs: 60_000 }))

    // mock fails → switch to other; mock is cooled for 60s.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Same step, other fails: mock is cooled AND step-failed → no candidate.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1, provider: 'other' })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('reverts to the main model once the cooldown expires (cooldown-expiry, positive case)', async () => {
    vi.useFakeTimers()
    const { agent, setRoute } = makeAgent('revert-expiry', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] }, cooldownMs: 10_000 }))

    // Step 1: mock fails → switch to other (mock cooled until T0 + 10s).
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Still inside the cooldown: mock is excluded → passthrough.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1, provider: 'other' })).toBeUndefined()

    // Cooldown expires → step 2: other fails → mock re-eligible → revert to main.
    vi.advanceTimersByTime(10_001)
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 2, provider: 'other' })).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[1]?.data.to).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)[1]?.data.reason).toBe('trigger-code')
  })

  it('never keeps the session on the fallback (no revert within the session)', async () => {
    const { agent, setRoute } = makeAgent('revert-never', { provider: 'mock', model: 'gpt-4o' })
    // Even with an instantly expiring cooldown, `revertPolicy: 'never'` means
    // Infinity TTL — mock never comes back within the session.
    apply(ctx, cfg({ chains: { default: ['mock/gpt-4o', 'other/gpt-4o'] }, revertPolicy: 'never', cooldownMs: 0 }))

    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 2, provider: 'other' })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })
})

describe('safety valve (spec §2 clause 4)', () => {
  it('stops switching after maxSwitchesPerStep and keeps the original LlmError code/message', async () => {
    const { agent, setRoute } = makeAgent('valve', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['b/x', 'c/x', 'd/x'] }, maxSwitchesPerStep: 2 }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'quota exceeded', code: 'QUOTA' },
      { message: 'quota exceeded', code: 'QUOTA' },
      { message: 'quota exceeded', code: 'QUOTA' },
    ])
    // Two switches (mock→b, b→c), then the valve trips: d/x is available but
    // switchCount 2 ≥ maxSwitchesPerStep 2 → passthrough → terminal error.
    expect(result.outcome).toBe('error')
    expect(result.requests.map((request) => request.provider)).toEqual(['mock', 'b', 'c'])
    expect(switchEvents(agent)).toHaveLength(2)
    expect(result.error).toBeInstanceOf(LlmError)
    expect(result.error?.code).toBe('QUOTA')
    expect(result.error?.message).toBe('quota exceeded')
  })
})

describe('decision-path failure defense (F-005)', () => {
  it('passes the original failure through when the decision path throws', async () => {
    const { agent } = makeAgent('defensive', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    // The durable append inside commit() explodes: the request-error listener
    // must catch, log, and delegate — the original failure semantics (spec §6)
    // survive and no switch event is recorded.
    const session = agent.session as unknown as { append: (type: string, data: unknown) => unknown }
    const originalAppend = session.append
    session.append = () => { throw new Error('append exploded') }
    try {
      const action = await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })
      expect(action).toBeUndefined()
    } finally {
      session.append = originalAppend
    }
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('no-op regression (AC-8)', () => {
  it('unconfigured chains: zero events, request path unchanged', async () => {
    const { agent } = makeAgent('noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    // Failure path: no chains → no decision → passthrough, no events.
    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })).toBeUndefined()
    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'no quota', code: 'QUOTA' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)

    // Request path: no pending switch, no cap → the seed passes through.
    const seed = { provider: 'mock', model: 'gpt-4o', temperature: 0.7 }
    expect(await dispatchRequest(ctx, agent, seed)).toEqual(seed)
  })

  it('disabled: zero events even with chains configured', async () => {
    const { agent } = makeAgent('noop-disabled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ enabled: false, chains: { default: ['other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })).toBeUndefined()
    expect(await dispatchRequestError(ctx, agent, { failure: { message: '429', code: 'RATE_LIMIT' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('composition order with model-selection (T3 review ⚠️3)', () => {
  /** The default composition: an active selection exists only when the user picked one. */
  function noSelection(): ModelSelectionRef {
    return { current: undefined, assembled: undefined }
  }

  it('keeps fallback switching intact when model-selection is registered first (real bundle order)', async () => {
    const { agent } = makeAgent('ms-first', { provider: 'mock', model: 'gpt-4o' })
    // Real bundle: agent-default-model's installModelSelection runs before the
    // fallback plugin (bundle insert after llm-retry). With no active
    // selection the model-selection listener passes the resolved config
    // through, so the fallback switch must survive the composition.
    installModelSelectionStub(ctx, noSelection())
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('keeps the always-cap path intact under the same composition (model-selection first)', async () => {
    const { agent } = makeAgent('ms-first-cap', { provider: 'mock', model: 'gpt-4o' })
    installModelSelectionStub(ctx, noSelection())
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] }, alwaysModeRetryCap: 1 }))

    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('always-cap')
  })

  it('keeps fallback switching intact when model-selection is registered after the plugin', async () => {
    const { agent } = makeAgent('ms-last', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    installModelSelectionStub(ctx, noSelection())

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('routes a fallback-switched step to the chain target even under an active selection (marker handoff)', async () => {
    const { agent } = makeAgent('ms-active', { provider: 'mock', model: 'gpt-4o' })
    // Task 2 (spec §2.5 D-1): the patched model-selection yields the step when
    // the plugin marks its override as fallback-routed — the chain target wins
    // routing on the switched step (previously the selection re-applied on
    // top). The switch decision is still recorded and the pending state is
    // still applied/cleared, exactly as before.
    const selection: ModelSelectionRef = {
      current: undefined,
      assembled: { provider: 'sel', model: 'm' },
    }
    installModelSelectionStub(ctx, selection)
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('restores the user selection on the next request (the marker is per-step)', async () => {
    const { agent } = makeAgent('ms-restore', { provider: 'mock', model: 'gpt-4o' })
    const selection: ModelSelectionRef = {
      current: undefined,
      assembled: { provider: 'sel', model: 'm' },
    }
    installModelSelectionStub(ctx, selection)
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    // The switched step routes to the chain target…
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })).toEqual({
      provider: 'other',
      model: 'gpt-4o',
    })
    // …but the next request has no pending switch → no marker on its config →
    // the stub applies the user selection again (only the switched step yields).
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })).toEqual({
      provider: 'sel',
      model: 'm',
    })
    expect(switchEvents(agent)).toHaveLength(1)
  })
})
