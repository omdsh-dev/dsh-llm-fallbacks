/**
 * P4 runtime integration tests (plan fallbacks-half-open-recovery Task 4,
 * P5): decide/commit integration, the once-per-episode probe log, and the
 * no-surviving-target probe-failure escalation (P2 rule 5b) — driven over
 * the real plugin `apply()` with the shared harness waterfalls.
 *
 * The observation side (close on observed completion, interrupted neutrality,
 * timer/`never` inertness at the listener) is covered by
 * `tests/success-observation.spec.ts` (Task 3). This file covers the
 * failure/admission side of the same state machine: rule 1 (escalated commit
 * write under half-open), rule 4 (one logged probe per expiry episode; both
 * admissions routed), rule 5b (both the trigger-code and always-cap
 * null-decision paths), the end-to-end probe → observed-completion close,
 * and the timer-mode flat-cooldown invariant (no escalation, recovery
 * untouched).
 *
 * Step discipline: the cooldown (300_000 ms default) lapsing takes wall-clock
 * time, so the probe phase always runs on a LATER (turn, step) than the
 * suppression that created it — the step-failed set resets on (turn, step)
 * advance, exactly as in a real conversation where the next user turn arrives
 * after the cooldown window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, stateStore } from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  appendLlmRetry,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  emitAssistantMessage,
  makeAgent,
  type AgentHarness,
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

/** The pinned half-open probe log format (plan P2 rule 4). */
const PROBE_LOG = 'llm-fallbacks: agent "%s" half-open probe %s/%s (role=%s, reason=%s)'

/** All `half-open probe` info lines captured so far. */
function probeLogs(logs: Array<{ type: string; args: unknown[] }>) {
  return logs.filter((message) => message.type === 'info' && String(message.args[0]) === PROBE_LOG)
}

/**
 * Walk `mock/gpt-4o` into a half-open episode: at (1, 1) the first failure
 * suppresses it flat (n=1, `cooldownMs`) and the pending switch applies to
 * `anthropic/claude-3-5-sonnet`; the clock advances past expiry; at (2, 1)
 * the claude failure admits mock as the probe (the episode's one log line,
 * asserted here).
 */
async function walkIntoHalfOpen(
  handle: AgentHarness,
  logs: Array<{ type: string; args: unknown[] }>,
  t0: number,
): Promise<void> {
  const { agent, setRoute } = handle
  let config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
  setRoute(config.provider, config.model)
  const action = await dispatchRequestError(ctx, agent, {
    turn: 1,
    step: 1,
    failure: { message: 'boom', code: 'AUTH' },
  })
  expect(action).toEqual({ kind: 'retry' })
  config = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-3-5-sonnet' }, { turn: 1, step: 1 })
  expect(config).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet' })
  setRoute(config.provider, config.model)
  // mock's cooldown lapses → half-open (lazy, at the next decision read).
  vi.setSystemTime(t0 + 301_000)
  const probe = await dispatchRequestError(ctx, agent, {
    turn: 2,
    step: 1,
    provider: 'anthropic',
    failure: { message: 'boom', code: 'AUTH' },
  })
  expect(probe).toEqual({ kind: 'retry' })
  const logged = probeLogs(logs)
  expect(logged).toHaveLength(1)
  expect(String(logged[0]?.args[1])).toBe(agent.id)
  expect(String(logged[0]?.args[2])).toBe('mock')
  expect(String(logged[0]?.args[3])).toBe('gpt-4o')
}

describe('half-open runtime integration (plan fallbacks-half-open-recovery P4)', () => {
  it('logs the half-open probe once per expiry episode; a second admission before resolution routes silently', async () => {
    const logs = captureLogs()
    const handle = makeAgent('probe-once', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'anthropic/claude-3-5-sonnet'], recovery: 'half-open' }))
    vi.useFakeTimers()
    const t0 = Date.now()
    try {
      await walkIntoHalfOpen(handle, logs, t0)
      // Second admission at the same (2, 1) before any resolution: the
      // episode is still unresolved (no mock failure, no observed
      // completion), so the walk routes to mock again — but the episode's
      // one log line is not repeated (the marker is not a gate; both
      // requests are admitted).
      const { agent } = handle
      const again = await dispatchRequestError(ctx, agent, {
        turn: 2,
        step: 1,
        provider: 'anthropic',
        failure: { message: 'boom', code: 'AUTH' },
      })
      expect(again).toEqual({ kind: 'retry' })
      expect(probeLogs(logs)).toHaveLength(1)
      // Both admissions were routed: two pending switches to mock were
      // committed at this step.
      const state = stateStore(ctx)!.peek('probe-once')!
      expect(state.stepFailures.switchCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a probe failure with a surviving switch target re-suppresses escalated via commit (rule 1)', async () => {
    const logs = captureLogs()
    const { agent, setRoute } = makeAgent('probe-escalate', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['mock/gpt-4o', 'anthropic/claude-3-5-sonnet', 'other/gpt-4o'],
      recovery: 'half-open',
    }))
    vi.useFakeTimers()
    const t0 = Date.now()
    try {
      await walkIntoHalfOpen({ agent, setRoute }, logs, t0)
      // The probe request routes to mock (pending switch applied) and fails;
      // a surviving target exists (other/gpt-4o), so the user's request falls
      // over per the existing switch-away path and commit re-suppresses mock
      // with the ESCALATED duration (n=2 → 2 × cooldownMs).
      let config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 2, step: 2 })
      setRoute(config.provider, config.model)
      const store = stateStore(ctx)!
      const state = store.peek('probe-escalate')!
      // Half-open: the lapsed entry was dropped from the cooldown store.
      expect(state.cooldown.peek('mock/gpt-4o')).toBeUndefined()
      const action = await dispatchRequestError(ctx, agent, {
        turn: 2,
        step: 2,
        failure: { message: 'boom', code: 'AUTH' },
      })
      expect(action).toEqual({ kind: 'retry' })
      expect(state.cooldown.peek('mock/gpt-4o')).toBe(t0 + 301_000 + 600_000)
      expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
      // The surviving target was picked (pending switch mock → other).
      expect(state.pendingSwitch).toEqual({
        from: { provider: 'mock', model: 'gpt-4o' },
        to: { provider: 'other', model: 'gpt-4o' },
        role: 'inherit',
        reason: 'trigger-code',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a probe failure with no surviving target re-suppresses escalated without a pending switch (rule 5b, trigger-code)', async () => {
    const logs = captureLogs()
    const { agent, setRoute } = makeAgent('probe-5b', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'anthropic/claude-3-5-sonnet'], recovery: 'half-open' }))
    vi.useFakeTimers()
    const t0 = Date.now()
    try {
      await walkIntoHalfOpen({ agent, setRoute }, logs, t0)
      // The probe routes to mock and fails; claude is still suppressed, so no
      // surviving target exists → decide returns null → rule 5b re-suppresses
      // mock escalated WITHOUT a pending switch and WITHOUT recordSwitch.
      let config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 2, step: 2 })
      setRoute(config.provider, config.model)
      const store = stateStore(ctx)!
      const state = store.peek('probe-5b')!
      const action = await dispatchRequestError(ctx, agent, {
        turn: 2,
        step: 2,
        failure: { message: 'boom', code: 'AUTH' },
      })
      // Null decision → the original failure passes through (the request falls over).
      expect(action).toBeUndefined()
      expect(state.pendingSwitch).toBeUndefined()
      // No recordSwitch: the fresh (2, 2) step's counter stayed at 0 — the 5b
      // write changed suppression duration only, never the switch count.
      expect(state.stepFailures.switchCount).toBe(0)
      expect(state.cooldown.peek('mock/gpt-4o')).toBe(t0 + 301_000 + 600_000)
      expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a probe failure with no surviving target also escalates on the always-cap null decision (rule 5b, always-cap)', async () => {
    const logs = captureLogs()
    const { agent, setRoute } = makeAgent('probe-5b-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['mock/gpt-4o', 'anthropic/claude-3-5-sonnet'],
      recovery: 'half-open',
      alwaysModeRetryCap: 3,
    }))
    vi.useFakeTimers()
    const t0 = Date.now()
    try {
      await walkIntoHalfOpen({ agent, setRoute }, logs, t0)
      // The probe routes to mock (pending switch applied). A new turn: the
      // always-mode retries trip the cap at the request boundary; the
      // decision finds no surviving target (mock is current, claude
      // suppressed) → the always-cap null fall-through fires rule 5b.
      await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 2, step: 2 })
      for (let retry = 1; retry <= 3; retry += 1) {
        appendLlmRetry(agent, { turn: 3, step: 1, provider: 'mock', mode: 'always', retry })
      }
      const store = stateStore(ctx)!
      const state = store.peek('probe-5b-cap')!
      const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 3, step: 1 })
      // No surviving target → no switch; the request passes unchanged.
      expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
      expect(state.pendingSwitch).toBeUndefined()
      // No recordSwitch: the fresh (3, 1) step's counter stayed at 0 — the 5b
      // write changed suppression duration only, never the switch count.
      expect(state.stepFailures.switchCount).toBe(0)
      expect(state.cooldown.peek('mock/gpt-4o')).toBe(t0 + 301_000 + 600_000)
      expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an observed completion closes the circuit after a walk-admitted probe (T3 listener × T4 decide)', async () => {
    const logs = captureLogs()
    const { agent, setRoute } = makeAgent('probe-close', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'anthropic/claude-3-5-sonnet'], recovery: 'half-open' }))
    vi.useFakeTimers()
    const t0 = Date.now()
    try {
      await walkIntoHalfOpen({ agent, setRoute }, logs, t0)
      const store = stateStore(ctx)!
      const state = store.peek('probe-close')!
      expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
      // The probe request completes: an observed assistant/message from the
      // producing route closes the circuit — entry deleted, counter reset by
      // deletion, preference fully restored.
      emitAssistantMessage(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
      expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
      expect(state.recovery.halfOpenEntries()).toEqual([])
      // A later failure starts a fresh flat episode (the counter was reset by
      // the close). claude's suppression has lapsed by then, so the walk has
      // a surviving target and commit writes mock's FIRST suppression of the
      // new episode — flat cooldownMs, not the pre-close n=2 escalation.
      vi.setSystemTime(t0 + 602_000)
      let config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 3, step: 1 })
      setRoute(config.provider, config.model)
      const action = await dispatchRequestError(ctx, agent, {
        turn: 3,
        step: 1,
        failure: { message: 'boom', code: 'AUTH' },
      })
      expect(action).toEqual({ kind: 'retry' })
      expect(state.cooldown.peek('mock/gpt-4o')).toBe(t0 + 602_000 + 300_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timer mode keeps a flat cooldown forever (no escalation, recovery untouched)', async () => {
    const logs = captureLogs()
    const { agent, setRoute } = makeAgent('timer-flat', { provider: 'mock', model: 'gpt-4o' })
    // `recovery` defaults to 'timer' — the byte-identical default.
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'anthropic/claude-3-5-sonnet'] }))
    vi.useFakeTimers()
    const t0 = Date.now()
    try {
      // (1,1): mock fails → mock suppressed flat; switch to claude.
      let config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
      setRoute(config.provider, config.model)
      await dispatchRequestError(ctx, agent, { turn: 1, step: 1, failure: { message: 'boom', code: 'AUTH' } })
      config = await dispatchRequest(ctx, agent, { provider: 'anthropic', model: 'claude-3-5-sonnet' }, { turn: 1, step: 1 })
      setRoute(config.provider, config.model)
      // mock's cooldown lapses → restored as the preferred candidate (timer).
      vi.setSystemTime(t0 + 301_000)
      // (2,1): claude fails → mock restored; claude suppressed flat.
      await dispatchRequestError(ctx, agent, {
        turn: 2,
        step: 1,
        provider: 'anthropic',
        failure: { message: 'boom', code: 'AUTH' },
      })
      config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }, { turn: 2, step: 1 })
      setRoute(config.provider, config.model)
      // claude's cooldown lapses → mock fails again: its SECOND suppression
      // is still FLAT (300_000), never escalated (600_000) — and no recovery
      // entry or probe log was ever produced.
      vi.setSystemTime(t0 + 602_000)
      await dispatchRequestError(ctx, agent, { turn: 3, step: 1, failure: { message: 'boom', code: 'AUTH' } })
      const state = stateStore(ctx)!.peek('timer-flat')!
      expect(state.cooldown.peek('mock/gpt-4o')).toBe(t0 + 602_000 + 300_000)
      expect(state.recovery.halfOpenEntries()).toEqual([])
      expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
      expect(probeLogs(logs)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
