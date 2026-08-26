/**
 * Per-agent fallback state machine (spec §5.1; plan Task 3 Step 5/6).
 *
 * Covers the contract the plugin runtime relies on: pendingSwitch
 * produce → apply → clear, appliedTurnStep anti-replay (including chain
 * supersession at the same (turn, step)), step-advance reset of
 * stepFailures, cooldown lazy expiry, and disposed/idle cleanup.
 */

import { describe, expect, it } from 'vitest'
import { FallbackStateStore, type PendingSwitch } from '../src/state.ts'
import { StepFailureSet } from '../src/cooldown.ts'

const pending = (overrides: Partial<PendingSwitch> = {}): PendingSwitch => ({
  from: { provider: 'mock', model: 'gpt-4o' },
  to: { provider: 'other', model: 'gpt-4o' },
  role: 'inherit',
  reason: 'trigger-code',
  ...overrides,
})

describe('FallbackStateStore — map lifecycle', () => {
  it('creates an empty state on first get and reports size/has', () => {
    const store = new FallbackStateStore()
    expect(store.size).toBe(0)
    expect(store.has('a')).toBe(false)
    const state = store.get('a')
    expect(store.has('a')).toBe(true)
    expect(store.size).toBe(1)
    expect(state.stepFailures).toEqual({
      turn: 0,
      step: 0,
      failed: expect.any(StepFailureSet),
      switchCount: 0,
    })
    expect(state.pendingSwitch).toBeUndefined()
    expect(state.appliedTurnStep).toBeUndefined()
  })

  it('peek reads without creating', () => {
    const store = new FallbackStateStore()
    expect(store.peek('ghost')).toBeUndefined()
    expect(store.size).toBe(0)
    store.get('ghost')
    expect(store.peek('ghost')).toBeDefined()
  })

  it('delete removes one agent and clear empties the store', () => {
    const store = new FallbackStateStore()
    store.get('a')
    store.get('b')
    store.delete('a')
    expect(store.has('a')).toBe(false)
    expect(store.size).toBe(1)
    store.clear()
    expect(store.size).toBe(0)
  })
})

describe('FallbackStateStore — pendingSwitch lifecycle', () => {
  it('writePending stores the decision and clears any applied marker', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.writePending(state, pending())
    expect(state.pendingSwitch?.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    // simulate a previously applied switch at the same (turn, step)
    state.appliedTurnStep = { turn: 1, step: 1 }
    store.writePending(state, pending({ to: { provider: 'third', model: 'x' } }))
    expect(state.appliedTurnStep).toBeUndefined()
  })

  it('applyPending applies at a fresh (turn, step), records the marker, and clears the pending switch', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.writePending(state, pending())
    const applied = store.applyPending(state, 1, 1)
    expect(applied).toEqual(pending())
    expect(state.pendingSwitch).toBeUndefined()
    expect(state.appliedTurnStep).toEqual({ turn: 1, step: 1 })
    // no pending switch remains → nothing to re-apply
    expect(store.applyPending(state, 1, 1)).toBeUndefined()
  })

  it('applyPending refuses a switch already applied at the same (turn, step) (anti-replay)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    state.pendingSwitch = pending()
    state.appliedTurnStep = { turn: 1, step: 1 }
    expect(store.applyPending(state, 1, 1)).toBeUndefined()
    expect(state.pendingSwitch).toBeDefined()
    // a later step applies it
    expect(store.applyPending(state, 1, 2)?.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('a fresh decision supersedes an applied one at the same (turn, step) (chains)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.writePending(state, pending({ to: { provider: 'b', model: 'm' } }))
    store.applyPending(state, 1, 1)
    // B fails again in the same step → new decision B→C must still apply
    store.writePending(state, pending({
      from: { provider: 'b', model: 'm' },
      to: { provider: 'c', model: 'm' },
    }))
    expect(store.applyPending(state, 1, 1)?.to).toEqual({ provider: 'c', model: 'm' })
  })

  it('clearStepState drops pending + step bookkeeping but keeps the cooldown', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.syncStep(state, 1, 1)
    store.writePending(state, pending())
    store.suppress(state, 'mock/gpt-4o', Date.now() + 60_000)
    store.recordFailure(state, 'mock/gpt-4o')
    store.recordSwitch(state)
    store.clearStepState(state)
    expect(state.pendingSwitch).toBeUndefined()
    expect(state.appliedTurnStep).toBeUndefined()
    expect(state.stepFailures.failed.size).toBe(0)
    expect(state.stepFailures.switchCount).toBe(0)
    expect(store.isSuppressed(state, 'mock/gpt-4o')).toBe(true)
  })
})

describe('FallbackStateStore — stepFailures', () => {
  it('syncStep resets failed set and switch count when (turn, step) advances', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.syncStep(state, 1, 1)
    store.recordFailure(state, 'mock/gpt-4o')
    store.recordSwitch(state)
    expect(state.stepFailures.failed.size).toBe(1)
    expect(state.stepFailures.switchCount).toBe(1)
    store.syncStep(state, 1, 2)
    expect(state.stepFailures.failed.size).toBe(0)
    expect(state.stepFailures.switchCount).toBe(0)
    expect(state.stepFailures.turn).toBe(1)
    expect(state.stepFailures.step).toBe(2)
  })

  it('syncStep is a no-op within the same (turn, step)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.syncStep(state, 3, 5)
    store.recordFailure(state, 'k')
    store.recordSwitch(state)
    store.syncStep(state, 3, 5)
    expect(state.stepFailures.failed.size).toBe(1)
    expect(state.stepFailures.switchCount).toBe(1)
  })

  it('tracks the failed set and the switch budget independently', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.syncStep(state, 1, 1)
    store.recordFailure(state, 'a/x')
    store.recordFailure(state, 'b/y')
    store.recordSwitch(state)
    store.recordSwitch(state)
    expect(state.stepFailures.failed.has('a/x')).toBe(true)
    expect(state.stepFailures.failed.has('b/y')).toBe(true)
    expect(state.stepFailures.failed.has('c/z')).toBe(false)
    expect(state.stepFailures.switchCount).toBe(2)
  })
})

describe('FallbackStateStore — cooldown', () => {
  it('suppress/isSuppressed with lazy expiry (expired entries dropped on read)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 999)).toBe(true)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 1_000)).toBe(false)
    // expired entry removed on read
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000)).toBe(false)
    expect(store.isSuppressed(state, 'unseen/model')).toBe(false)
  })

  it('Infinity TTL never expires within the session (revertPolicy: never)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', Number.POSITIVE_INFINITY)
    expect(store.isSuppressed(state, 'mock/gpt-4o', Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})

describe('FallbackStateStore — half-open recovery (plan fallbacks-half-open-recovery P2)', () => {
  it('timer mode drops expired entries on read (today behavior, verbatim)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 999, 'timer')).toBe(true)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 1_000, 'timer')).toBe(false)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    // expired entry removed on read
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'timer')).toBe(false)
  })

  it('half-open mode marks the route half-open at expiry instead of restoring it', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 999, 'half-open')).toBe(true)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 1_000, 'half-open')).toBe(false)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
    expect(state.recovery.halfOpenEntries()).toEqual([
      { key: 'mock/gpt-4o', untilEpochMs: 1_000 },
    ])
    // the entry was dropped from the cooldown store
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')).toBe(false)
  })

  it('half-open mode never transitions an Infinity TTL (revertPolicy: never)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', Number.POSITIVE_INFINITY)
    expect(store.isSuppressed(state, 'mock/gpt-4o', Number.MAX_SAFE_INTEGER, 'half-open')).toBe(true)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
  })

  it('syncRecovery bulk-transitions every expired cooldown key (display path)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', 1_000) // expired at now = 2000
    store.suppress(state, 'anthropic/claude-3-5-sonnet', 5_000) // still active
    store.syncRecovery(state, 2_000, 'half-open')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
    expect(state.recovery.isHalfOpen('anthropic/claude-3-5-sonnet')).toBe(false)
    expect(state.recovery.halfOpenEntries()).toEqual([
      { key: 'mock/gpt-4o', untilEpochMs: 1_000 },
    ])
  })

  it('syncRecovery is a pure no-op under timer mode', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    store.syncRecovery(state, 2_000, 'timer')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    // the expired entry is still in the cooldown store (no transition ran)
    expect(store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'timer')).toBe(false)
  })

  it('observeSuccess closes the circuit only from half-open', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    // no entry — no-op
    store.observeSuccess(state, 'mock/gpt-4o')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    // actively suppressed (non-half-open) — no-op, counter survives
    state.recovery.recordFailure('mock/gpt-4o')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    store.observeSuccess(state, 'mock/gpt-4o')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.recordFailure('mock/gpt-4o')).toBe(2)
    // half-open — closes and resets the counter
    store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
    store.observeSuccess(state, 'mock/gpt-4o')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.halfOpenEntries()).toEqual([])
  })

  it('clearStepState does not clear recovery (cooldown-survival rationale)', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
    store.clearStepState(state)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
  })
})
