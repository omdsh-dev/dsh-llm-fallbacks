/**
 * Per-agent fallback state (direction C, plan dsh-022-rc1-upgrade).
 *
 * The store is the walk's CROSS-CALL memory: cooldown lazy expiry, the
 * half-open transition on read, the bulk display transition, and success
 * observation. Per-request bookkeeping (failed set / switch cap) is walk-local
 * and has no state here.
 */

import { describe, expect, it } from 'vitest'
import { FallbackStateStore } from '../src/state.ts'

describe('FallbackStateStore — map lifecycle', () => {
  it('creates an empty state on first get and reports size/has', () => {
    const store = new FallbackStateStore()
    expect(store.size).toBe(0)
    expect(store.has('a')).toBe(false)
    const state = store.get('a')
    expect(store.has('a')).toBe(true)
    expect(store.size).toBe(1)
    // The retained surface: cooldown + recovery, nothing else.
    expect(Object.keys(state).sort()).toEqual(['cooldown', 'recovery'])
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
    store.observeSuccess(state, 'mock/gpt-4o', 500)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    // actively suppressed (non-half-open) — no-op, counter survives
    state.recovery.recordFailure('mock/gpt-4o')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    store.observeSuccess(state, 'mock/gpt-4o', 500)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.recordFailure('mock/gpt-4o')).toBe(2)
    // half-open — closes and resets the counter
    store.isSuppressed(state, 'mock/gpt-4o', 2_000, 'half-open')
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(true)
    store.observeSuccess(state, 'mock/gpt-4o', 2_000)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.halfOpenEntries()).toEqual([])
  })

  it('observeSuccess applies the lazy expiry first: a completion after the cooldown lapsed closes without a prior read', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    // What commit() writes: n = 1 and a finite suppression. No isSuppressed
    // read follows — the current route kept succeeding, so no walk consulted
    // this key — and the suppression lapses unobserved.
    state.recovery.recordFailure('mock/gpt-4o')
    store.suppress(state, 'mock/gpt-4o', 1_000)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    // A completion observed AFTER expiry is post-expiry evidence: the entry
    // transitions and closes in one read — cooldown key dropped, recovery
    // entry deleted, counter reset.
    store.observeSuccess(state, 'mock/gpt-4o', 2_000)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.halfOpenEntries()).toEqual([])
    expect(state.cooldown.peek('mock/gpt-4o')).toBeUndefined()
    expect(state.recovery.recordFailure('mock/gpt-4o')).toBe(1)
  })

  it('observeSuccess leaves an Infinity suppression (revertPolicy never) untouched', () => {
    const store = new FallbackStateStore()
    const state = store.get('a')
    state.recovery.recordFailure('mock/gpt-4o')
    store.suppress(state, 'mock/gpt-4o', Number.POSITIVE_INFINITY)
    store.observeSuccess(state, 'mock/gpt-4o', Number.MAX_SAFE_INTEGER)
    expect(state.cooldown.peek('mock/gpt-4o')).toBe(Number.POSITIVE_INFINITY)
    expect(state.recovery.isHalfOpen('mock/gpt-4o')).toBe(false)
    expect(state.recovery.recordFailure('mock/gpt-4o')).toBe(2)
  })

})
