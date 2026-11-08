/**
 * End-to-end plugin contract under direction C (plan dsh-022-rc1-upgrade).
 *
 * The plugin registers NO listener on the loop's waterfails: fallback lives
 * inside the virtual `FallbacksChain/Auto` adapter's `stream()` (see
 * `tests/chain-walk.spec.ts`, `tests/dispatch-integration.spec.ts`). What this
 * suite pins is the composition surface left behind:
 * - `apply()` still registers the virtual row exactly when something is
 *   configured, and an unconfigured install is a true no-op (AC-8);
 * - both loop waterfalls pass through untouched, so nothing competes with
 *   llm-retry or with the host's model-selection listener (registration order
 *   no longer decides anything);
 * - a real-route failure produces no plugin switch: real-model sessions have no
 *   fallback (the headline of direction C);
 * - per-agent state leaves no residual after `agent/disposed` / plugin dispose;
 * - the host's model-selection notice stays quiet on a steady virtual-route
 *   session (plan model-change-notice-loop).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, stateStore } from '../src/index.ts'
import { FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  CHAIN_ID, chainOf,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  makeAgent,
  switchEvents,
} from './support/harness.ts'
import { installModelSelectionStub, type ModelSelection } from './support/model-selection-stub.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

describe('the loop waterfalls pass through untouched (direction C)', () => {
  it('does not handle a trigger-code failure: llm-retry / the loop own it', async () => {
    const { agent } = makeAgent('pass-through-error', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } }))
      .toBeUndefined()
    // No plugin decision, no bookkeeping, no durable event.
    expect(stateStore(ctx)?.size).toBe(0)
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('returns the request seed unchanged (no override, no role-inject)', async () => {
    const { agent } = makeAgent('pass-through-request', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent', agentPreset: 'coder' })
    apply(ctx, cfg({
      chains: [chainOf(['other/gpt-4o'])],
      // The role POINTS at a declared chain; it carries no chain of its own.
      roles: { list: [{ id: 'coder', persona: '', chain: CHAIN_ID }] },
    }))

    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(0)
  })
})

describe('no-op regression (AC-8)', () => {
  it('an unconfigured install registers no virtual row and leaves the request untouched', async () => {
    new LlmRuntime(ctx)
    const { agent } = makeAgent('noop-unconfigured', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: [], roles: { list: [] } }))

    const listed = await ctx.llm.listModels(FALLBACKS_PROVIDER).then(rows => rows, () => 'unregistered')
    expect(listed).toBe('unregistered')
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('the legacy enabled: line is inert — content presence decides', async () => {
    new LlmRuntime(ctx)
    apply(ctx, cfg({ chains: [chainOf([OFFICIAL_FLASH])], ...({ enabled: false } as object) }))

    // Content present ⇒ the row registers even with a stored `enabled: false`.
    // (Registration settles one macrotask after apply — the inject child.)
    const rows = await vi.waitFor(async () => {
      const listed = await ctx.llm.listModels(FALLBACKS_PROVIDER)
      expect(listed.map(row => row.id)).toEqual([CHAIN_ID])
      return listed
    })
    expect(rows).toHaveLength(1)
  })
})

describe('per-agent state leaves no residual (spec §6)', () => {
  it('drops one agent’s state on agent/disposed and everything on plugin dispose', async () => {
    apply(ctx, cfg({ chains: [chainOf([OFFICIAL_FLASH])] }))
    const states = stateStore(ctx)!

    states.get('residual-agent')
    expect(states.has('residual-agent')).toBe(true)
    ctx.emit('agent/disposed', { agent: { id: 'residual-agent' } })
    expect(states.has('residual-agent')).toBe(false)

    states.get('residual-agent-2')
    await ctx.fiber.dispose()
    expect(states.size).toBe(0)
  })
})

describe('model-selection composition is order-independent (no plugin listener)', () => {
  it('passes the request through when model-selection is registered FIRST', async () => {
    const { agent } = makeAgent('ms-first', { provider: 'mock', model: 'gpt-4o' })
    installModelSelectionStub(ctx)
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } }))
      .toBeUndefined()
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('passes the request through when the plugin is registered FIRST', async () => {
    const { agent } = makeAgent('ms-last', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))
    installModelSelectionStub(ctx)

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } }))
      .toBeUndefined()
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('never switches a real-model route on repeated failures (no fallback outside the virtual row)', async () => {
    const { agent } = makeAgent('real-route-failure', { provider: 'mock', model: 'gpt-4o' })
    installModelSelectionStub(ctx)
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))

    // The failure is reported twice (the llm-retry loop shape): the plugin
    // still never routes the request off its real model.
    for (const _ of [1, 2]) {
      expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } }))
        .toBeUndefined()
      expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
        .toEqual({ provider: 'mock', model: 'gpt-4o' })
    }
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
 * selection-vs-`requestHeader().config` comparison holds:
 * zero notices on a steady session. A genuine selection change still produces
 * exactly one, and it retires once the logged route follows the selection.
 */
describe('model-selection notice on the virtual route (Task 4)', () => {
  /** The virtual picker row, exact strings (spec lock). */
  const virtualPair = { provider: FALLBACKS_PROVIDER, model: CHAIN_ID }

  /**
   * Drive one `agent/pre-step` the way the loop does: the offered inbox batch
   * goes in and the default decision admits exactly those messages
   * (`{ kind: 'enter', messages }`), so anything else in `decision.messages`
   * was appended by a listener.
   */
  function dispatchPreStep(agent: Agent, step: number, modelSelection: ModelSelection): Promise<PreStepDecision> {
    const messages: UserMessage[] = [
      createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }),
    ]
    return ctx.waterfall('agent/pre-step', {
      agent,
      messages,
      turn: 1,
      step,
      signal: new AbortController().signal,
      modelSelection,
    }, () => Promise.resolve({ kind: 'enter', messages }))
  }

  /** The messages one decision would commit (`[]` for a reject). */
  function admitted(decision: PreStepDecision): UserMessage[] {
    return decision.kind === 'enter' ? [...decision.messages] : []
  }

  /** The notices the host listener appended — source-tagged, so a plain message can never count. */
  function notices(decision: PreStepDecision): UserMessage[] {
    // 0.1.7-rc.1: the model-selection producer declares its own source kind
    // (`{ kind: 'model-selection' }` — the shared `plugin` kind is gone).
    return admitted(decision).filter((message) => message.source.kind === 'model-selection')
  }

  /** The default web-profile composition: the plugin registers at bundle load, model-selection after it. */
  function compose(agentId: string): Agent {
    const { agent } = makeAgent(agentId, { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ chains: [chainOf([OFFICIAL_FLASH])] }))
    installModelSelectionStub(ctx)
    return agent
  }

  it('records the virtual pair as the request route, so the selection can match it', async () => {
    const agent = compose('t4-route')

    expect(await dispatchRequest(ctx, agent, virtualPair)).toEqual(virtualPair)
    expect(agent.session.requestHeader()?.config).toMatchObject(virtualPair)
  })

  it('appends no notice while the selection keeps matching the logged route (the loop case)', async () => {
    const agent = compose('t4-steady')
    await dispatchRequest(ctx, agent, virtualPair)

    // Two further admitted steps on an unchanged selection. Pre-fix each step
    // carried a fresh notice (the live measurement: 10 notices / 10 steps).
    const second = await dispatchPreStep(agent, 2, virtualPair)
    const third = await dispatchPreStep(agent, 3, virtualPair)
    expect(notices(second)).toEqual([])
    expect(notices(third)).toEqual([])
    // The decision is exactly the inbox batch — nothing was appended at all.
    expect(admitted(second)).toHaveLength(1)
  })

  it('appends exactly one notice for a genuine selection change, then retires', async () => {
    const agent = compose('t4-change')
    await dispatchRequest(ctx, agent, virtualPair)

    // The user picks a real model: the loop captures it for the step.
    const flashed = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const changed = await dispatchPreStep(agent, 2, flashed)

    const appended = notices(changed)
    expect(appended).toHaveLength(1)
    // Exactly the chip the user reported: source `model-selection`, summary `from → to`.
    expect(appended[0]?.source).toMatchObject({
      kind: 'model-selection',
      form: 'notice',
      summary: `FallbacksChain/${CHAIN_ID} → deepseek-official/deepseek-flash`,
    })
    expect(appended[0]?.content.some((block) => block.type === 'text' && block.text.includes('[model changed:'))).toBe(true)

    // The next request is served on the new selection and logged as such, so
    // the notice does not repeat — the divergence the loop was made of is gone.
    expect(await dispatchRequest(ctx, agent, flashed)).toEqual(flashed)
    expect(notices(await dispatchPreStep(agent, 3, flashed))).toEqual([])
  })
})
