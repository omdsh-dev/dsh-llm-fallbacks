/**
 * Chain resolution unit tests (plan fallbacks-role-runtime Task 1).
 *
 * Covers spec §7.2 concatenation semantics — `[...role.chain,
 * ...(fallback === 'none' ? [] : rootChain)]` (append-not-replace: role
 * entries first, rootChain tail), the built-in `inherit` role (rootChain,
 * silent), the unknown-role defense (rootChain + warn), wildcard entries
 * (keep failing model id, swap provider only),
 * entry-level skip logic (`resolveCandidate` with `modelExists`),
 * malformed-entry resilience, the caller-side candidate filter (cooldown /
 * failed-set / same-as-current / absent model id), and the
 * `hasWildcardEntry` probe on the same concatenated candidates.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FallbacksRole } from '../src/config.ts'
import { INHERIT_ROLE_ID } from '../src/config.ts'
import { CooldownStore, StepFailureSet } from '../src/cooldown.ts'
import type { Selector } from '../src/selectors.ts'
import {
  annotateCandidates,
  createCandidateFilter,
  hasWildcardEntry,
  resolveCandidate,
  resolveChain,
} from '../src/chains.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Declared-role fixture: defaults fill the required FallbacksRole fields. */
function role(id: string, overrides: Omit<Partial<FallbacksRole>, 'id'> = {}): FallbacksRole {
  return { id, persona: '', ...overrides }
}

describe('resolveChain — concatenation semantics (spec §7.2)', () => {
  const rootChain = ['local/*']

  it('uses rootChain when the role declares no chain (roleDef exists)', () => {
    const roles = [role('coder')]
    expect(resolveChain(roles, rootChain, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'local/gpt-4o',
    ])
  })

  it('appends rootChain after the role chain (inherit-root default): role entries first', () => {
    const roles = [role('coder', { chain: ['mistral/*'] })]
    expect(resolveChain(roles, rootChain, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'mistral/gpt-4o',
      'local/gpt-4o',
    ])
  })

  it('uses only the role chain when fallback is "none"', () => {
    const roles = [role('coder', { chain: ['mistral/*'], fallback: 'none' })]
    expect(resolveChain(roles, rootChain, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'mistral/gpt-4o',
    ])
  })

  it('keeps entry order within the concatenation', () => {
    const roles = [role('coder', { chain: ['a/x', 'b/y', 'c/z'] })]
    expect(resolveChain(roles, rootChain, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'a/x',
      'b/y',
      'c/z',
      'local/gpt-4o',
    ])
  })

  it('resolves wildcard entries to concrete selectors keeping the failing model id', () => {
    const roles = [role('coder', { chain: ['anthropic/*'] })]
    expect(resolveChain(roles, rootChain, 'coder', 'openai', 'gpt-4o')[0]).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
      raw: 'anthropic/gpt-4o',
    })
  })

  it('keeps a multi-slash model id entry as an exact candidate (regression pin, issue #74)', () => {
    // Downstream chain matching treats the model id as an opaque string:
    // a multi-slash model id must resolve as an exact candidate with the
    // raw entry preserved, and must not be existence-filtered as an exact
    // entry (only provider/*-origin candidates consult modelExists).
    const roles = [role('coder', { chain: ['nvidia/minimaxai/minimax-m3'] })]
    const candidates = resolveChain(roles, [], 'coder', 'openai', 'gpt-4o', undefined, () => false)
    expect(candidates.map((c) => c.raw)).toEqual(['nvidia/minimaxai/minimax-m3'])
    expect(candidates[0]).toEqual({
      provider: 'nvidia',
      model: 'minimaxai/minimax-m3',
      raw: 'nvidia/minimaxai/minimax-m3',
    })
  })

  it('skips malformed entries without throwing (they do not take effect)', () => {
    const roles = [role('coder', { chain: ['bogus', 'provider/', 'openai/gpt-4o', ''] })]
    expect(resolveChain(roles, rootChain, 'coder', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'openai/gpt-4o',
      'local/gpt-4o',
    ])
  })

  it('returns an empty list when the concatenation is empty', () => {
    // roleDef exists with an empty effective chain (fallback none, no root).
    const roles = [role('coder', { fallback: 'none' })]
    expect(resolveChain(roles, [], 'coder', 'openai', 'gpt-4o')).toEqual([])
  })

  it('forwards modelExists to wildcard entries (absent model ids skipped)', () => {
    const roles = [role('coder', { chain: ['anthropic/*', 'local/*'] })]
    const candidates = resolveChain(roles, [], 'coder', 'openai', 'gpt-4o', undefined, (provider) => provider === 'local')
    expect(candidates.map((c) => c.raw)).toEqual(['local/gpt-4o'])
  })
})

describe('resolveChain — unknown role defense', () => {
  it('falls back to rootChain and warns once for an unknown role id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rootChain = ['local/*']
    expect(resolveChain([], rootChain, 'ghost', 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'local/gpt-4o',
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown role "ghost"'))
  })

  it('does not warn for a declared role (even with no chain)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const roles = [role('coder')]
    resolveChain(roles, ['local/*'], 'coder', 'openai', 'gpt-4o')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('resolveChain — built-in inherit role (T1 review Minor 1)', () => {
  it('resolves inherit to rootChain without warning (legal built-in role, not a typo)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rootChain = ['local/*']
    expect(resolveChain([], rootChain, INHERIT_ROLE_ID, 'openai', 'gpt-4o').map((c) => c.raw)).toEqual([
      'local/gpt-4o',
    ])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('resolveChain — filter', () => {
  it('applies an optional caller filter to the ordered candidates', () => {
    const roles = [role('coder', { chain: ['a/x', 'b/y', 'c/z'] })]
    const filtered = resolveChain(roles, [], 'coder', 'openai', 'gpt-4o', (c) => c.provider !== 'b')
    expect(filtered.map((c) => c.raw)).toEqual(['a/x', 'c/z'])
  })
})

describe('hasWildcardEntry — probe on the concatenated candidates', () => {
  const rootChain = ['local/*']

  it('is true when the role chain has a provider/* entry', () => {
    const roles = [role('coder', { chain: ['mistral/*'] })]
    expect(hasWildcardEntry(roles, rootChain, 'coder')).toBe(true)
  })

  it('is true when only rootChain has a provider/* entry', () => {
    const roles = [role('coder', { chain: ['anthropic/claude-3-5-sonnet'] })]
    expect(hasWildcardEntry(roles, rootChain, 'coder')).toBe(true)
  })

  it('is false for exact-only entries (role chain + rootChain)', () => {
    const roles = [role('coder', { chain: ['anthropic/claude-3-5-sonnet'] })]
    expect(hasWildcardEntry(roles, ['local/gemini-1.5-pro'], 'coder')).toBe(false)
  })

  it('probes rootChain for an unknown role (defense)', () => {
    expect(hasWildcardEntry([], rootChain, 'ghost')).toBe(true)
    expect(hasWildcardEntry([], ['local/gemini-1.5-pro'], 'ghost')).toBe(false)
  })

  it('is false for a fallback-none role with an exact-only chain even when rootChain carries a wildcard (qc2 F-003)', () => {
    // F-003/S-1 exactness: `fallback: 'none'` excludes rootChain from the
    // concatenation, so a wildcard that can never reach the candidate list
    // must not build a catalog probe — the probe is exact, not an
    // over-approximation.
    const roles = [role('coder', { chain: ['anthropic/claude-3-5-sonnet'], fallback: 'none' })]
    expect(hasWildcardEntry(roles, rootChain, 'coder')).toBe(false)
  })

  it('is true for a fallback-none role whose own chain carries a wildcard', () => {
    const roles = [role('coder', { chain: ['mistral/*'], fallback: 'none' })]
    expect(hasWildcardEntry(roles, rootChain, 'coder')).toBe(true)
  })

  it('skips malformed entries without throwing', () => {
    const roles = [role('coder', { chain: ['bogus', 'mistral/*'] })]
    expect(hasWildcardEntry(roles, [], 'coder')).toBe(true)
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
    expect(makeFilter()({ provider: 'anthropic', model: 'claude-3-5-sonnet', raw: 'anthropic/claude-3-5-sonnet' })).toBe(true)
  })

  it('skips a candidate equal to the current model', () => {
    expect(makeFilter()({ provider: 'openai', model: 'gpt-4o', raw: 'openai/gpt-4o' })).toBe(false)
  })

  it('keeps a candidate that shares only the provider with the current model', () => {
    expect(makeFilter()({ provider: 'openai', model: 'gpt-4-turbo', raw: 'openai/gpt-4-turbo' })).toBe(true)
  })

  it('skips cooldown-suppressed candidates (keyed provider/model)', () => {
    const cooldown = new CooldownStore()
    cooldown.suppress('anthropic/claude-3-5-sonnet', Infinity)
    const filter = makeFilter({ cooldown })
    expect(filter({ provider: 'anthropic', model: 'claude-3-5-sonnet', raw: 'anthropic/claude-3-5-sonnet' })).toBe(false)
    expect(filter({ provider: 'google', model: 'gemini-1.5-pro', raw: 'google/gemini-1.5-pro' })).toBe(true)
  })

  it('skips candidates already failed in this step', () => {
    const failed = new StepFailureSet()
    failed.add('anthropic/claude-3-5-sonnet')
    const filter = makeFilter({ failed })
    expect(filter({ provider: 'anthropic', model: 'claude-3-5-sonnet', raw: 'anthropic/claude-3-5-sonnet' })).toBe(false)
    expect(filter({ provider: 'google', model: 'gemini-1.5-pro', raw: 'google/gemini-1.5-pro' })).toBe(true)
  })

  it('skips candidates whose model id is absent on the target provider', () => {
    const filter = makeFilter({ modelExists: (_p, m) => m !== 'gpt-4o' })
    expect(filter({ provider: 'anthropic', model: 'gpt-4o', raw: 'anthropic/gpt-4o' })).toBe(false)
    expect(filter({ provider: 'anthropic', model: 'claude-3-5-sonnet', raw: 'anthropic/claude-3-5-sonnet' })).toBe(true)
  })

  it('does not require modelExists (wildcard absence decided by caller)', () => {
    const cooldown = new CooldownStore()
    const failed = new StepFailureSet()
    const filter = createCandidateFilter({ current: failing, cooldown, failed })
    const candidate: Selector = { provider: 'anthropic', model: 'gpt-4o', raw: 'anthropic/gpt-4o' }
    expect(filter(candidate)).toBe(true)
  })
})

describe('annotateCandidates — per-candidate skip reasons (T3 review Minor 1)', () => {
  const failing = { provider: 'openai', model: 'gpt-4o' }

  function makeBase() {
    const cooldown = new CooldownStore()
    const failed = new StepFailureSet()
    return {
      options: { current: failing, cooldown, failed },
      cooldown,
      failed,
    }
  }

  it('labels each skipped candidate with its concrete reason and leaves survivors unlabelled', () => {
    const { options, cooldown, failed } = makeBase()
    cooldown.suppress('google/gemini-1.5-pro', Infinity)
    failed.add('anthropic/claude-3-5-sonnet')
    const candidates: Selector[] = [
      { provider: 'openai', model: 'gpt-4o', raw: 'openai/gpt-4o' },
      { provider: 'google', model: 'gemini-1.5-pro', raw: 'google/gemini-1.5-pro' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet', raw: 'anthropic/claude-3-5-sonnet' },
      { provider: 'mistral', model: 'mistral-large', raw: 'mistral/mistral-large' },
    ]
    const annotated = annotateCandidates(candidates, [candidates[3]!], options)
    expect(annotated.map(({ candidate, skip }) => [candidate.raw, skip])).toEqual([
      ['openai/gpt-4o', 'same-as-current'],
      ['google/gemini-1.5-pro', 'cooldown'],
      ['anthropic/claude-3-5-sonnet', 'step-failed'],
      ['mistral/mistral-large', undefined],
    ])
  })

  it('labels a wildcard entry dropped only by the existence probe as missing-id', () => {
    const { options } = makeBase()
    // The caller resolved with modelExists, so the wildcard entry whose target
    // provider lacks the id is absent from `surviving` (exact entries are
    // never existence-probed — T2 contract; they stay in `surviving`).
    const candidates: Selector[] = [
      { provider: 'anthropic', model: 'gpt-4o', raw: 'anthropic/gpt-4o' },
      { provider: 'local', model: 'gpt-4o', raw: 'local/gpt-4o' },
    ]
    const annotated = annotateCandidates(candidates, [candidates[1]!], options)
    expect(annotated[0]?.skip).toBe('missing-id')
    expect(annotated[1]?.skip).toBeUndefined()
  })

  it('keeps the considered order and preserves duplicates', () => {
    const { options, cooldown } = makeBase()
    cooldown.suppress('a/x', Infinity)
    const candidates: Selector[] = [
      { provider: 'a', model: 'x', raw: 'a/x' },
      { provider: 'b', model: 'y', raw: 'b/y' },
      { provider: 'a', model: 'x', raw: 'a/x' },
    ]
    const annotated = annotateCandidates(candidates, [candidates[1]!], options)
    expect(annotated.map(({ candidate, skip }) => [candidate.raw, skip])).toEqual([
      ['a/x', 'cooldown'],
      ['b/y', undefined],
      ['a/x', 'cooldown'],
    ])
  })
})
