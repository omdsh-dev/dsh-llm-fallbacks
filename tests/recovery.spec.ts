/**
 * Half-open recovery state machine unit tests (plan fallbacks-half-open-recovery
 * Task 2, P5). Pure — imports `../src/recovery.ts` directly (the cooldown.spec.ts
 * seam), no host.
 *
 * Covers the escalation formula (rule 2), recordFailure (rule 1), markHalfOpen
 * (rule 3), tryMarkProbeLogged (rule 4), isHalfOpen (rule 5b gate), and close
 * (rule 6).
 */

import { describe, expect, it } from 'vitest'
import {
  ESCALATION_CAP_MS,
  ESCALATION_MULTIPLIER,
  RecoveryStore,
  escalatedCooldownMs,
} from '../src/recovery.ts'

describe('escalatedCooldownMs', () => {
  it('n = 1 is flat cooldownMs (PM lock)', () => {
    expect(escalatedCooldownMs(300_000, 1)).toBe(300_000)
  })

  it('escalates geometrically by the multiplier', () => {
    expect(escalatedCooldownMs(300_000, 2)).toBe(600_000)
    expect(escalatedCooldownMs(300_000, 3)).toBe(1_200_000)
    expect(escalatedCooldownMs(300_000, 4)).toBe(2_400_000)
  })

  it('caps at 1 hour', () => {
    expect(ESCALATION_CAP_MS).toBe(3_600_000)
    expect(escalatedCooldownMs(300_000, 5)).toBe(3_600_000)
    expect(escalatedCooldownMs(300_000, 6)).toBe(3_600_000)
    expect(escalatedCooldownMs(300_000, 100)).toBe(3_600_000)
  })

  it('never shortens below the configured flat cooldown when cooldownMs >= cap', () => {
    expect(escalatedCooldownMs(3_600_000, 1)).toBe(3_600_000)
    expect(escalatedCooldownMs(3_600_000, 2)).toBe(3_600_000)
    expect(escalatedCooldownMs(7_200_000, 2)).toBe(7_200_000)
  })

  it('cooldownMs = 0 degenerates to today flat-0 semantics', () => {
    expect(escalatedCooldownMs(0, 1)).toBe(0)
    expect(escalatedCooldownMs(0, 2)).toBe(0)
    expect(escalatedCooldownMs(0, 10)).toBe(0)
  })
})

describe('RecoveryStore — recordFailure (rule 1)', () => {
  it('increments the consecutive-failure counter from 1', () => {
    const store = new RecoveryStore()
    expect(store.recordFailure('openai/gpt-4o')).toBe(1)
    expect(store.recordFailure('openai/gpt-4o')).toBe(2)
    expect(store.recordFailure('openai/gpt-4o')).toBe(3)
  })

  it('clears an in-progress half-open episode (failure while half-open re-suppresses)', () => {
    const store = new RecoveryStore()
    store.markHalfOpen('openai/gpt-4o', 1_000)
    expect(store.isHalfOpen('openai/gpt-4o')).toBe(true)
    store.recordFailure('openai/gpt-4o')
    expect(store.isHalfOpen('openai/gpt-4o')).toBe(false)
    expect(store.halfOpenEntries()).toEqual([])
  })

  it('clears the probe marker so a new episode logs again', () => {
    const store = new RecoveryStore()
    store.markHalfOpen('openai/gpt-4o', 1_000)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(true)
    store.recordFailure('openai/gpt-4o')
    store.markHalfOpen('openai/gpt-4o', 2_000)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(true)
  })
})

describe('RecoveryStore — markHalfOpen (rule 3)', () => {
  it('opens an episode and records the lapsed expiry epoch', () => {
    const store = new RecoveryStore()
    store.markHalfOpen('openai/gpt-4o', 1_000)
    expect(store.isHalfOpen('openai/gpt-4o')).toBe(true)
    expect(store.halfOpenEntries()).toEqual([{ key: 'openai/gpt-4o', untilEpochMs: 1_000 }])
  })

  it('resets probeLogged per episode', () => {
    const store = new RecoveryStore()
    store.markHalfOpen('openai/gpt-4o', 1_000)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(true)
    // a second episode (e.g. re-suppression expired again) must log again
    store.markHalfOpen('openai/gpt-4o', 2_000)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(true)
  })

  it('keeps the consecutive-failure counter across episodes (probe failure escalates to n+1)', () => {
    const store = new RecoveryStore()
    store.recordFailure('openai/gpt-4o')
    store.recordFailure('openai/gpt-4o')
    store.markHalfOpen('openai/gpt-4o', 1_000)
    expect(store.recordFailure('openai/gpt-4o')).toBe(3)
  })
})

describe('RecoveryStore — tryMarkProbeLogged (rule 4)', () => {
  it('logs once per episode', () => {
    const store = new RecoveryStore()
    store.markHalfOpen('openai/gpt-4o', 1_000)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(true)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(false)
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(false)
  })

  it('two requests admitted before any resolution: both admitted, only the first logs', () => {
    const store = new RecoveryStore()
    store.markHalfOpen('openai/gpt-4o', 1_000)
    // first admission — the logged probe
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(true)
    // second admission while the episode is unresolved — routed, no log
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(false)
    // the episode is still open (no resolution yet)
    expect(store.isHalfOpen('openai/gpt-4o')).toBe(true)
  })

  it('is a no-op for unknown keys and non-half-open entries', () => {
    const store = new RecoveryStore()
    expect(store.tryMarkProbeLogged('ghost/model')).toBe(false)
    store.recordFailure('openai/gpt-4o')
    expect(store.tryMarkProbeLogged('openai/gpt-4o')).toBe(false)
  })
})

describe('RecoveryStore — close (rule 6)', () => {
  it('closes only from half-open and deletes the entry (counter reset)', () => {
    const store = new RecoveryStore()
    store.recordFailure('openai/gpt-4o')
    store.recordFailure('openai/gpt-4o')
    store.markHalfOpen('openai/gpt-4o', 1_000)
    store.close('openai/gpt-4o')
    expect(store.isHalfOpen('openai/gpt-4o')).toBe(false)
    expect(store.halfOpenEntries()).toEqual([])
    // counter reset by deletion: the next failure is a flat first cooldown
    expect(store.recordFailure('openai/gpt-4o')).toBe(1)
  })

  it('is a no-op for a suppressed (non-half-open) entry', () => {
    const store = new RecoveryStore()
    store.recordFailure('openai/gpt-4o')
    store.close('openai/gpt-4o')
    expect(store.isHalfOpen('openai/gpt-4o')).toBe(false)
    // the counter survives — a stale success must not cancel a fresher
    // escalated re-suppression
    expect(store.recordFailure('openai/gpt-4o')).toBe(2)
  })

  it('is a no-op with no entry', () => {
    const store = new RecoveryStore()
    store.close('ghost/model')
    expect(store.halfOpenEntries()).toEqual([])
  })
})
