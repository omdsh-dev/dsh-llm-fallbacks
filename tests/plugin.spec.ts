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
 *   both registration orders, with and without an active selection — cordis
 *   waterfall semantics: the FIRST-registered listener is outer and has the
 *   final say after `next()`),
 * - the host-native degradation under an active selection (plan
 *   llm-fallbacks-runtime-depatch T2: the marker coordination shipped with
 *   the local dsh-agent patch is removed — when the model-selection listener
 *   composes outer, the selection re-applies over the switched step; when
 *   the plugin composes outer, the switch wins).
 *
 * The dual-plugin matrix with the llm-retry semantic double lives in
 * `tests/coexist-llm-retry.spec.ts`; the always-mode cap matrix lives in
 * `tests/always-mode.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId, UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, stateStore } from '../src/index.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
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
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'quota exceeded', code: 'QUOTA' },
      undefined,
    ])
    expect(result.outcome).toBe('success')
    expect(result.requests.map((request) => request.provider)).toEqual(['mock', 'other'])
    // Stop-write (issue #52): the switch happens but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('drops an inherited reasoningEffort when applying a switch (withoutInheritedEffort pattern)', async () => {
    const { agent } = makeAgent('loop-effort', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

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
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

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
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('applies a chain decision B→C at the same (turn, step) after A→B (fresh decision supersedes)', async () => {
    const { agent, setRoute } = makeAgent('sm-chain', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['b/x', 'c/x'] }))

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
    // Stop-write: the A→B→C chain decisions apply but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('resets the failed set when the step advances (revert to main on a later step)', async () => {
    const { agent, setRoute } = makeAgent('sm-step-reset', { provider: 'mock', model: 'gpt-4o' })
    // cooldownMs 0: the cooldown expires immediately, isolating the failed-set
    // reset as the deciding mechanism at the new step.
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'], cooldownMs: 0 }))

    // Step 1: mock fails → switch to other (mock is step-failed at step 1).
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Step 2 (advanced): other fails → mock is re-eligible — syncStep reset the
    // failed set for (1, 2) → revert to the main model.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 2, provider: 'other' })).toEqual({ kind: 'retry' })
    // Stop-write: no durable event; the revert still routes back to mock/gpt-4o.
    expect(switchEvents(agent)).toHaveLength(0)
    expect(await dispatchRequest(ctx, agent, { provider: 'other', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('leaves no residual state after agent/disposed and plugin dispose (spec §6)', async () => {
    const { agent, setRoute } = makeAgent('sm-residual', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const store = stateStore(ctx)
    expect(store?.size).toBe(1)

    // agent/disposed removes the agent's state: the cooldown no longer suppresses.
    ctx.emit('agent/disposed', { agent })
    expect(store?.size).toBe(0)
    setRoute('other', 'gpt-4o')
    expect(await dispatchRequestError(ctx, agent, { provider: 'other' })).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Plugin dispose (the effect cleanup runs with the fiber) clears everything.
    await ctx.fiber.dispose()
    expect(store?.size).toBe(0)
  })
})

describe('cooldown / revert integration (US-4)', () => {
  it('excludes a cooled model until its cooldown expires', async () => {
    const { agent, setRoute } = makeAgent('cooldown-cooled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'], cooldownMs: 60_000 }))

    // mock fails → switch to other; mock is cooled for 60s.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Same step, other fails: mock is cooled AND step-failed → no candidate.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1, provider: 'other' })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('reverts to the main model once the cooldown expires (cooldown-expiry, positive case)', async () => {
    vi.useFakeTimers()
    const { agent, setRoute } = makeAgent('revert-expiry', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'], cooldownMs: 10_000 }))

    // Step 1: mock fails → switch to other (mock cooled until T0 + 10s).
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Still inside the cooldown: mock is excluded → passthrough.
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1, provider: 'other' })).toBeUndefined()

    // Cooldown expires → step 2: other fails → mock re-eligible → revert to main.
    vi.advanceTimersByTime(10_001)
    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 2, provider: 'other' })).toEqual({ kind: 'retry' })
    // Stop-write: no durable event; the cooldown-expiry revert still routes
    // back to mock/gpt-4o.
    expect(switchEvents(agent)).toHaveLength(0)
    expect(await dispatchRequest(ctx, agent, { provider: 'other', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('never keeps the session on the fallback (no revert within the session)', async () => {
    const { agent, setRoute } = makeAgent('revert-never', { provider: 'mock', model: 'gpt-4o' })
    // Even with an instantly expiring cooldown, `revertPolicy: 'never'` means
    // Infinity TTL — mock never comes back within the session.
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'], revertPolicy: 'never', cooldownMs: 0 }))

    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 1 })).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    expect(await dispatchRequestError(ctx, agent, { turn: 1, step: 2, provider: 'other' })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('safety valve (spec §2 clause 4)', () => {
  it('stops switching after maxSwitchesPerStep and keeps the original LlmError code/message', async () => {
    const { agent, setRoute } = makeAgent('valve', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['b/x', 'c/x', 'd/x'], maxSwitchesPerStep: 2 }))

    const result = await runAgentStep(ctx, { agent, setRoute }, [
      { message: 'quota exceeded', code: 'QUOTA' },
      { message: 'quota exceeded', code: 'QUOTA' },
      { message: 'quota exceeded', code: 'QUOTA' },
    ])
    // Two switches (mock→b, b→c), then the valve trips: d/x is available but
    // switchCount 2 ≥ maxSwitchesPerStep 2 → passthrough → terminal error.
    expect(result.outcome).toBe('error')
    expect(result.requests.map((request) => request.provider)).toEqual(['mock', 'b', 'c'])
    expect(switchEvents(agent)).toHaveLength(0)
    expect(result.error).toBeInstanceOf(LlmError)
    expect(result.error?.code).toBe('QUOTA')
    expect(result.error?.message).toBe('quota exceeded')
  })
})

describe('decision-path failure defense (F-005)', () => {
  it('never calls session.append during a switch (F-005 decision path no longer touches the durable log)', async () => {
    const { agent } = makeAgent('defensive', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    // The durable append is gone — commit() never touches session.append, so
    // even a hostile append that would throw cannot break the switch: the
    // decision still applies and the retry action survives (spec §6).
    const session = agent.session as unknown as { append: (type: string, data: unknown) => unknown }
    const originalAppend = session.append
    const append = vi.fn(() => { throw new Error('append exploded') })
    session.append = append
    try {
      const action = await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })
      expect(action).toEqual({ kind: 'retry' })
      // The pending switch still applies at the next request.
      expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
        .toEqual({ provider: 'other', model: 'gpt-4o' })
    } finally {
      session.append = originalAppend
    }
    // append was never invoked — and no fallbacks/switch entry reached the stream.
    expect(append).not.toHaveBeenCalled()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('no-op regression (AC-8)', () => {
  it('unconfigured rootChain: zero events, request path unchanged', async () => {
    const { agent } = makeAgent('noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    // Failure path: no chain candidates → no decision → passthrough, no events.
    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })).toBeUndefined()
    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'no quota', code: 'QUOTA' } })).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)

    // Request path: no pending switch, no cap → the seed passes through.
    const seed = { provider: 'mock', model: 'gpt-4o', temperature: 0.7 }
    expect(await dispatchRequest(ctx, agent, seed)).toEqual(seed)
  })

  it('disabled: zero events even with a rootChain configured', async () => {
    const { agent } = makeAgent('noop-disabled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ enabled: false, rootChain: ['other/gpt-4o'] }))

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

  it('keeps fallback switching intact when model-selection is registered first and no selection is active', async () => {
    const { agent } = makeAgent('ms-first', { provider: 'mock', model: 'gpt-4o' })
    // Model-selection composes OUTER (registered first). With no active
    // selection its listener passes the resolved config through, so the
    // fallback switch must survive the composition.
    installModelSelectionStub(ctx, noSelection())
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    // Stop-write: the switch survives the composition but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('keeps the always-cap path intact under the same composition (model-selection first)', async () => {
    const { agent } = makeAgent('ms-first-cap', { provider: 'mock', model: 'gpt-4o' })
    installModelSelectionStub(ctx, noSelection())
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 1 }))

    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', retry: 1 })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    // Stop-write: the always-cap switch applies but no durable event is written.
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('keeps fallback switching intact when model-selection is registered after the plugin', async () => {
    const { agent } = makeAgent('ms-last', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))
    installModelSelectionStub(ctx, noSelection())

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('re-applies the user selection over a fallback-switched step when model-selection composes outer (host-native degradation)', async () => {
    const { agent } = makeAgent('ms-active', { provider: 'mock', model: 'gpt-4o' })
    // Plan llm-fallbacks-runtime-depatch T2 (degradation): the marker
    // coordination (spec §2.5 D-1) shipped with the local dsh-agent patch is
    // removed. When the model-selection listener composes OUTER (registered
    // first — the composition the old marker-handoff test modeled), its
    // post-`next()` re-apply is the final say: the switched step routes to
    // the user's selection, NOT the chain target. The switch decision is
    // still applied (no durable event, issue #52) — the coordination loss is
    // observable only in the served route, and the settings page documents it.
    const selection: ModelSelectionRef = {
      current: undefined,
      assembled: { provider: 'sel', model: 'm' },
    }
    installModelSelectionStub(ctx, selection)
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'sel', model: 'm' })
  })

  it('keeps the user selection on every request under an active outer selection (no per-step marker)', async () => {
    const { agent } = makeAgent('ms-restore', { provider: 'mock', model: 'gpt-4o' })
    const selection: ModelSelectionRef = {
      current: undefined,
      assembled: { provider: 'sel', model: 'm' },
    }
    installModelSelectionStub(ctx, selection)
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    // Without the marker there is no per-step yield: every request under the
    // active selection routes to the selection — the switched step AND the
    // next one.
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })).toEqual({
      provider: 'sel',
      model: 'm',
    })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })).toEqual({
      provider: 'sel',
      model: 'm',
    })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('lets the switch win when the plugin listener composes outer (registration-order dependence)', async () => {
    const { agent } = makeAgent('ms-plugin-outer', { provider: 'mock', model: 'gpt-4o' })
    // Cordis waterfall: the FIRST-registered listener is outer and its
    // post-`next()` override is final. When the plugin registers at bundle
    // load before the agent's model-selection (the default web-profile
    // composition), the switch survives even an active selection — the
    // degradation only bites when model-selection composes outer.
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))
    const selection: ModelSelectionRef = {
      current: undefined,
      assembled: { provider: 'sel', model: 'm' },
    }
    installModelSelectionStub(ctx, selection)

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

/**
 * Plan model-change-notice-loop Task 4: the host's `agent/pre-step` notice
 * listener (evidence E21). The harness double used to install only
 * `agent/request`, so nothing in the suite ever ran the listener that appends
 * the durable `[model changed: …]` notice — the suite stayed green while a live
 * session injected one on every admitted step.
 *
 * Post-T1 a root-origin `FallbacksChain/Auto` seed is served unchanged, so the
 * route the loop logs IS the selected pair and the host's
 * `sameRoute(selection.assembled, requestHeader().config)` comparison holds:
 * zero notices on a steady session. A genuine selection change still produces
 * exactly one, and it retires once the logged route follows the selection.
 */
describe('model-selection notice on the virtual route (Task 4)', () => {
  /** The virtual picker row, exact strings (spec lock). */
  const virtualPair = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL }

  /**
   * Drive one `agent/pre-step` the way the loop does: the offered inbox batch
   * goes in and the default decision admits exactly those messages
   * (`{ kind: 'enter', messages }`), so anything else in `decision.messages`
   * was appended by a listener.
   */
  function dispatchPreStep(agent: Agent, step: number): Promise<PreStepDecision> {
    const messages: UserMessage[] = [
      createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
    ]
    return ctx.waterfall('agent/pre-step', {
      agent,
      messages,
      turn: 1,
      step,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages }))
  }

  /** The messages one decision would commit (`[]` for a reject). */
  function admitted(decision: PreStepDecision): UserMessage[] {
    return decision.kind === 'enter' ? [...decision.messages] : []
  }

  /** The notices the host listener appended — source-tagged, so a plain message can never count. */
  function notices(decision: PreStepDecision): UserMessage[] {
    return admitted(decision).filter(
      (message) => message.source.kind === 'plugin' && message.source.plugin === 'model-selection',
    )
  }

  /** The default web-profile composition: the plugin registers at bundle load, model-selection after it. */
  function compose(agentId: string, selection: ModelSelectionRef): Agent {
    const { agent } = makeAgent(agentId, { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    installModelSelectionStub(ctx, selection)
    return agent
  }

  it('records the virtual pair as the request route, so the selection can match it', async () => {
    const agent = compose('t4-route', { current: virtualPair, assembled: virtualPair })

    expect(await dispatchRequest(ctx, agent, virtualPair)).toEqual(virtualPair)
    expect(agent.session.requestHeader()?.config).toMatchObject(virtualPair)
  })

  it('appends no notice while the selection keeps matching the logged route (the loop case)', async () => {
    const agent = compose('t4-steady', { current: virtualPair, assembled: virtualPair })
    await dispatchRequest(ctx, agent, virtualPair)

    // Two further admitted steps on an unchanged selection. Pre-fix each step
    // carried a fresh notice (the live measurement: 10 notices / 10 steps).
    const second = await dispatchPreStep(agent, 2)
    const third = await dispatchPreStep(agent, 3)
    expect(notices(second)).toEqual([])
    expect(notices(third)).toEqual([])
    // The decision is exactly the inbox batch — nothing was appended at all.
    expect(admitted(second)).toHaveLength(1)
  })

  it('appends exactly one notice for a genuine selection change, then retires', async () => {
    const selection: ModelSelectionRef = { current: virtualPair, assembled: virtualPair }
    const agent = compose('t4-change', selection)
    await dispatchRequest(ctx, agent, virtualPair)

    // The user picks a real model: the step's assembly snapshots it.
    const flashed = { provider: 'deepseek-official', model: 'deepseek-flash' }
    selection.current = flashed
    selection.assembled = flashed
    const changed = await dispatchPreStep(agent, 2)

    const appended = notices(changed)
    expect(appended).toHaveLength(1)
    // Exactly the chip the user reported: source `model-selection`, summary `from → to`.
    expect(appended[0]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'model-selection',
      form: 'notice',
      summary: 'FallbacksChain/Auto → deepseek-official/deepseek-flash',
    })
    expect(appended[0]?.content.some((block) => block.type === 'text' && block.text.includes('[model changed:'))).toBe(true)

    // The next request is served on the new selection and logged as such, so
    // the notice does not repeat — the divergence the loop was made of is gone.
    expect(await dispatchRequest(ctx, agent, flashed)).toEqual(flashed)
    expect(notices(await dispatchPreStep(agent, 3))).toEqual([])
  })
})
