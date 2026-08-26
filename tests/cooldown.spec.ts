/**
 * Cooldown store + step-failure-set unit tests (Task 2).
 *
 * Covers lazy expiry (cooldown-expiry revert), the `revertPolicy: 'never'`
 * infinite-TTL path, and the StepFailureSet add/has/reset contract. The
 * switchCount / maxSwitchesPerStep judgement belongs to the caller (Task 3).
 */

import { describe, expect, it } from 'vitest'
import { CooldownStore, StepFailureSet } from '../src/cooldown.ts'

describe('CooldownStore', () => {
  it('reports a freshly suppressed key as suppressed', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1000)
    expect(store.isSuppressed('openai/gpt-4o', 500)).toBe(true)
  })

  it('reverts when the cooldown expires (until <= now)', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1000)
    expect(store.isSuppressed('openai/gpt-4o', 999)).toBe(true)
    expect(store.isSuppressed('openai/gpt-4o', 1000)).toBe(false)
    expect(store.isSuppressed('openai/gpt-4o', 2000)).toBe(false)
  })

  it('lazily drops expired entries on read', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1000)
    store.suppress('anthropic/claude-3-5-sonnet', 5000)
    expect(store.size).toBe(2)
    store.isSuppressed('openai/gpt-4o', 2000) // expired → removed
    expect(store.size).toBe(1)
    expect(store.isSuppressed('anthropic/claude-3-5-sonnet', 2000)).toBe(true)
  })

  it('never reverts with an infinite TTL (revertPolicy "never")', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', Infinity)
    expect(store.isSuppressed('openai/gpt-4o', 0)).toBe(true)
    expect(store.isSuppressed('openai/gpt-4o', Date.now() + 1000 * 60 * 60 * 24 * 365)).toBe(true)
    expect(store.isSuppressed('openai/gpt-4o', Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('keeps keys independent of each other', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1000)
    expect(store.isSuppressed('anthropic/claude-3-5-sonnet', 500)).toBe(false)
  })

  it('is not suppressed for unknown keys', () => {
    const store = new CooldownStore()
    expect(store.isSuppressed('openai/gpt-4o', Date.now())).toBe(false)
  })

  it('uses Date.now() when no explicit now is given', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', Date.now() + 10_000)
    expect(store.isSuppressed('openai/gpt-4o')).toBe(true)
  })

  it('snapshot filters expired entries without mutating the store (pure read)', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1000) // expired at now = 2000
    store.suppress('anthropic/claude-3-5-sonnet', 5000)
    expect(store.size).toBe(2)
    const active = store.snapshot(2000)
    expect(active).toEqual([{ key: 'anthropic/claude-3-5-sonnet', untilEpochMs: 5000 }])
    // Pure read: the expired entry is still present after snapshot() —
    // the lazy delete happens only on the decision path (isSuppressed).
    expect(store.size).toBe(2)
    expect(store.isSuppressed('openai/gpt-4o', 2000)).toBe(false)
    expect(store.size).toBe(1)
    expect(store.isSuppressed('anthropic/claude-3-5-sonnet', 2000)).toBe(true)
  })

  it('snapshot keeps infinite-TTL entries always active', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', Infinity)
    expect(store.snapshot(0)).toEqual([{ key: 'openai/gpt-4o', untilEpochMs: Infinity }])
    expect(store.snapshot(Number.MAX_SAFE_INTEGER)).toEqual([
      { key: 'openai/gpt-4o', untilEpochMs: Infinity },
    ])
  })

  it('snapshot uses Date.now() when no explicit now is given', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', Date.now() + 10_000)
    expect(store.snapshot()).toEqual([{ key: 'openai/gpt-4o', untilEpochMs: expect.any(Number) }])
  })

  it('peek reads the raw expiry without dropping (pure read)', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1_000)
    expect(store.peek('openai/gpt-4o')).toBe(1_000)
    // expired at now = 2000, but peek does not drop
    expect(store.peek('openai/gpt-4o')).toBe(1_000)
    expect(store.size).toBe(1)
    // the decision path still drops on read
    expect(store.isSuppressed('openai/gpt-4o', 2_000)).toBe(false)
    expect(store.size).toBe(0)
  })

  it('peek returns undefined for unknown keys and Infinity for never-TTL entries', () => {
    const store = new CooldownStore()
    expect(store.peek('ghost/model')).toBeUndefined()
    store.suppress('openai/gpt-4o', Infinity)
    expect(store.peek('openai/gpt-4o')).toBe(Infinity)
  })

  it('keys yields the unfiltered map keys in insertion order (pure read)', () => {
    const store = new CooldownStore()
    store.suppress('openai/gpt-4o', 1_000) // expired at now = 2000
    store.suppress('anthropic/claude-3-5-sonnet', 5_000)
    expect([...store.keys()]).toEqual(['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'])
    // pure read: expired entries are still present
    expect(store.size).toBe(2)
  })
})

describe('StepFailureSet', () => {
  it('adds, reports, and resets keys', () => {
    const set = new StepFailureSet()
    expect(set.has('openai/gpt-4o')).toBe(false)
    set.add('openai/gpt-4o')
    expect(set.has('openai/gpt-4o')).toBe(true)
    expect(set.has('anthropic/claude-3-5-sonnet')).toBe(false)
    set.reset()
    expect(set.has('openai/gpt-4o')).toBe(false)
  })

  it('tracks its size', () => {
    const set = new StepFailureSet()
    set.add('a/x')
    set.add('b/y')
    set.add('a/x') // duplicate is idempotent
    expect(set.size).toBe(2)
    set.reset()
    expect(set.size).toBe(0)
  })
})
