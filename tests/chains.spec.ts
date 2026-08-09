/**
 * Chain resolution unit tests (Task 2).
 *
 * Covers specificity ordering (exact `provider/model` → `provider/*` → role
 * → `default`), wildcard keys and wildcard entries (keep failing model id,
 * swap provider only), entry-level skip logic (`resolveCandidate` with
 * `modelExists`), malformed-entry resilience, and the caller-side candidate
 * filter (cooldown / failed-set / same-as-current / absent model id).
 */

import { describe, expect, it } from 'vitest'
import { CooldownStore, StepFailureSet } from '../src/cooldown.ts'
import type { Selector } from '../src/selectors.ts'
import {
  createCandidateFilter,
  resolveCandidate,
  resolveChain,
} from '../src/chains.ts'

describe('resolveChain — specificity ordering', () => {
  const chains = {
    'openai/gpt-4o': ['anthropic/claude-3-5-sonnet'],
    'openai/*': ['google/*'],
    coder: ['mistral/*'],
    default: ['local/*'],
  }

  it('orders candidates exact → provider/* → role → default', () => {
    const candidates = resolveChain(chains, 'coder', 'openai', 'gpt-4o')
    expect(candidates.map((c) => c.raw)).toEqual([
      'anthropic/claude-3-5-sonnet', // exact key
      'google/gpt-4o', // provider/* key, failing model kept
      'mistral/gpt-4o', // role key
      'local/gpt-4o', // default key
    ])
  })

  it('keeps entry order within a key', () => {
    const multi = { default: ['a/x', 'b/y', 'c/z'] }
    expect(resolveChain(multi, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'a/x',
      'b/y',
      'c/z',
    ])
  })

  it('falls back to the role key when no provider-specific key exists', () => {
    const chains = { coder: ['mistral/*'], default: ['local/*'] }
    expect(resolveChain(chains, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'mistral/gpt-4o',
      'local/gpt-4o',
    ])
  })

  it('falls back to default when no role key exists', () => {
    const chains = { default: ['local/*'] }
    expect(resolveChain(chains, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'local/gpt-4o',
    ])
  })

  it('returns an empty list when nothing matches', () => {
    expect(resolveChain({}, 'coder', 'openai', 'gpt-4o')).toEqual([])
  })

  it('does not duplicate the default key when the role is "default"', () => {
    const chains = { default: ['local/*'] }
    expect(resolveChain(chains, 'default', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'local/gpt-4o',
    ])
  })
})

describe('resolveChain — wildcard keys and entries', () => {
  it('matches the provider/* key for any model of that provider', () => {
    const chains = { 'openai/*': ['anthropic/*'] }
    for (const model of ['gpt-4o', 'gpt-4-turbo']) {
      const candidates = resolveChain(chains, 'coder', 'openai', model)
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toEqual({
        provider: 'anthropic',
        model,
        raw: `anthropic/${model}`,
      })
    }
  })

  it('does not match the provider/* key for another provider', () => {
    const chains = { 'openai/*': ['anthropic/*'] }
    expect(resolveChain(chains, 'coder', 'anthropic', 'claude-3-5-sonnet')).toEqual([])
  })

  it('resolves wildcard entries to concrete selectors keeping the failing model id', () => {
    const chains = { 'openai/gpt-4o': ['anthropic/*'] }
    expect(resolveChain(chains, 'coder', 'openai', 'gpt-4o')[0]).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
      raw: 'anthropic/gpt-4o',
    })
  })

  it('skips malformed entries without throwing (they do not take effect)', () => {
    const chains = { default: ['bogus', 'provider/', 'openai/gpt-4o', ''] }
    expect(resolveChain(chains, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'openai/gpt-4o',
    ])
  })
})

describe('resolveChain — filter', () => {
  it('applies an optional caller filter to the ordered candidates', () => {
    const chains = { default: ['a/x', 'b/y', 'c/z'] }
    const filtered = resolveChain(chains, 'coder', 'openai', 'gpt-4o', (c) => c.provider !== 'b')
    expect(filtered.map((c) => c.raw)).toEqual(['a/x', 'c/z'])
  })
})

describe('resolveCandidate — wildcard skip by absent model id', () => {
  const failing = { provider: 'openai', model: 'gpt-4o' }

  it('returns the exact entry untouched, ignoring modelExists', () => {
    const candidate = resolveCandidate('anthropic/claude-3-5-sonnet', failing, () => false)
    expect(candidate).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet', raw: 'anthropic/claude-3-5-sonnet' })
  })

  it('resolves a wildcard entry when the target provider has the model id', () => {
    const candidate = resolveCandidate('anthropic/*', failing, (provider, model) => provider === 'anthropic' && model === 'gpt-4o')
    expect(candidate).toEqual({ provider: 'anthropic', model: 'gpt-4o', raw: 'anthropic/gpt-4o' })
  })

  it('returns null when the target provider has no such model id', () => {
    expect(resolveCandidate('anthropic/*', failing, () => false)).toBeNull()
  })

  it('resolves wildcard entries without modelExists (caller decides)', () => {
    expect(resolveCandidate('anthropic/*', failing)).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
      raw: 'anthropic/gpt-4o',
    })
  })

  it('returns null for malformed entries', () => {
    expect(resolveCandidate('bogus', failing)).toBeNull()
    expect(resolveCandidate('', failing)).toBeNull()
  })
})

describe('createCandidateFilter — caller-side candidate filtering', () => {
  const failing = { provider: 'openai', model: 'gpt-4o' }

  function makeFilter(overrides: Partial<Parameters<typeof createCandidateFilter>[0]> = {}) {
    const cooldown = new CooldownStore()
    const failed = new StepFailureSet()
    return createCandidateFilter({
      current: failing,
      cooldown,
      failed,
      modelExists: () => true,
      ...overrides,
    })
  }

  it('accepts a usable candidate', () => {
    expect(makeFilter()({ provider: 'anthropic', model: 'claude-3-5-sonnet' })).toBe(true)
  })

  it('skips a candidate equal to the current model', () => {
    expect(makeFilter()({ provider: 'openai', model: 'gpt-4o' })).toBe(false)
  })

  it('keeps a candidate that shares only the provider with the current model', () => {
    expect(makeFilter()({ provider: 'openai', model: 'gpt-4-turbo' })).toBe(true)
  })

  it('skips cooldown-suppressed candidates (keyed provider/model)', () => {
    const cooldown = new CooldownStore()
    cooldown.suppress('anthropic/claude-3-5-sonnet', Infinity)
    const filter = makeFilter({ cooldown })
    expect(filter({ provider: 'anthropic', model: 'claude-3-5-sonnet' })).toBe(false)
    expect(filter({ provider: 'google', model: 'gemini-1.5-pro' })).toBe(true)
  })

  it('skips candidates already failed in this step', () => {
    const failed = new StepFailureSet()
    failed.add('anthropic/claude-3-5-sonnet')
    const filter = makeFilter({ failed })
    expect(filter({ provider: 'anthropic', model: 'claude-3-5-sonnet' })).toBe(false)
    expect(filter({ provider: 'google', model: 'gemini-1.5-pro' })).toBe(true)
  })

  it('skips candidates whose model id is absent on the target provider', () => {
    const filter = makeFilter({ modelExists: (_p, m) => m !== 'gpt-4o' })
    expect(filter({ provider: 'anthropic', model: 'gpt-4o' })).toBe(false)
    expect(filter({ provider: 'anthropic', model: 'claude-3-5-sonnet' })).toBe(true)
  })

  it('does not require modelExists (wildcard absence decided by caller)', () => {
    const cooldown = new CooldownStore()
    const failed = new StepFailureSet()
    const filter = createCandidateFilter({ current: failing, cooldown, failed })
    const candidate: Selector = { provider: 'anthropic', model: 'gpt-4o', raw: 'anthropic/gpt-4o' }
    expect(filter(candidate)).toBe(true)
  })
})
