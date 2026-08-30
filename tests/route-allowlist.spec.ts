/**
 * Route-allowlist pure-module tests (plan dsh-012-subagent-routing T2; spec
 * D1 ∩ D2).
 *
 * `src/route-allowlist.ts` owns route identity (exact provider+model — no
 * aliasing, no case-folding) and allowlist containment / intersection on
 * RESOLVED candidates. These tests pin the identities the wiring depends on:
 * order-preserving intersection (the chain's first in-allowlist entry wins),
 * fail-closed emptiness (`undefined`, never a fallback route), and detached
 * route normalization.
 */

import { describe, expect, it } from 'vitest'
import { firstAllowedCandidate, resolvedRoutes, routeOnAllowlist } from '../src/route-allowlist.ts'

describe('routeOnAllowlist (exact route identity)', () => {
  const allowlist = [
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'openai', model: 'gpt-5' },
  ]

  it('matches an exact provider+model route', () => {
    expect(routeOnAllowlist({ provider: 'deepseek', model: 'deepseek-chat' }, allowlist)).toBe(true)
    expect(routeOnAllowlist({ provider: 'openai', model: 'gpt-5' }, allowlist)).toBe(true)
  })

  it('rejects a provider mismatch, a model mismatch, and a swapped pair', () => {
    expect(routeOnAllowlist({ provider: 'other', model: 'deepseek-chat' }, allowlist)).toBe(false)
    expect(routeOnAllowlist({ provider: 'deepseek', model: 'gpt-5' }, allowlist)).toBe(false)
    expect(routeOnAllowlist({ provider: 'openai', model: 'deepseek-chat' }, allowlist)).toBe(false)
  })

  it('is case-sensitive (no case-folding, no aliasing)', () => {
    expect(routeOnAllowlist({ provider: 'DeepSeek', model: 'deepseek-chat' }, allowlist)).toBe(false)
    expect(routeOnAllowlist({ provider: 'deepseek', model: 'DeepSeek-Chat' }, allowlist)).toBe(false)
  })

  it('rejects everything on an empty allowlist (fail-closed)', () => {
    expect(routeOnAllowlist({ provider: 'deepseek', model: 'deepseek-chat' }, [])).toBe(false)
  })
})

describe('firstAllowedCandidate (order-preserving intersection)', () => {
  const allowlist = [{ provider: 'deepseek', model: 'deepseek-chat' }]

  it('returns the first resolved candidate on the allowlist', () => {
    expect(firstAllowedCandidate([
      { provider: 'deepseek', model: 'deepseek-reasoner' },
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ], allowlist)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('skips out-of-allowlist heads and takes the next in-allowlist entry', () => {
    expect(firstAllowedCandidate([
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ], allowlist)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('returns undefined on an empty intersection (skip, never a fallback route)', () => {
    expect(firstAllowedCandidate([
      { provider: 'anthropic', model: 'claude-sonnet-4' },
    ], allowlist)).toBeUndefined()
    expect(firstAllowedCandidate([], allowlist)).toBeUndefined()
  })
})

describe('resolvedRoutes (resolved-candidate normalization)', () => {
  it('drops candidates without a concrete model id and detaches the rest', () => {
    const candidates = [
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'wildcard-origin' },
    ]
    const routes = resolvedRoutes(candidates)
    expect(routes).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    // Detached: mutating the result never aliases the caller's candidates.
    routes.push({ provider: 'x', model: 'y' })
    expect(candidates).toHaveLength(2)
  })
})
