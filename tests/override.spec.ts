/**
 * RouteChanged effort rule tests (plan dsh-012-subagent-routing T4; spec D3).
 *
 * `src/override.ts` owns the pure rule: a route override preserves the seed
 * `reasoningEffort` when the provider+model route is unchanged, drops it on a
 * route change unless an effort is explicitly named, and lets an explicit
 * effort win over the seed effort on either route. The rule is
 * POLICY-INDEPENDENT — spec D3 applies it on every override path whether the
 * subagent routing policy is on or off — so every case runs under both
 * policy labels (the function takes no policy input; if it ever did, these
 * cases would diverge and fail).
 */

import { describe, expect, it } from 'vitest'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { overrideConfigWithRouteRule } from '../src/override.ts'

const seed = {
  provider: 'mock',
  model: 'gpt-4o',
  reasoningEffort: 'high' as ReasoningEffortId,
  temperature: 0.7,
  stop: ['END'],
}

describe.each([
  ['policy on'],
  ['policy off'],
])('overrideConfigWithRouteRule (subagent routing policy %s — the rule is policy-independent)', () => {
  it('keeps the seed effort on a same-route override', () => {
    expect(
      overrideConfigWithRouteRule(seed, { provider: 'mock', model: 'gpt-4o' }),
    ).toEqual({
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high',
      temperature: 0.7,
      stop: ['END'],
    })
  })

  it('keeps the seed effort when only the model object identity changes, not the route', () => {
    // Same provider+model STRINGS: route identity is value-based, so a
    // structurally equal target preserves the effort.
    const target = { provider: 'mock', model: 'gpt-4o' }
    expect(
      overrideConfigWithRouteRule(seed, { ...target }).reasoningEffort,
    ).toBe('high')
  })

  it('drops the seed effort on a cross-route override (no explicit effort)', () => {
    expect(
      overrideConfigWithRouteRule(seed, { provider: 'other', model: 'gpt-4o' }),
    ).toEqual({
      provider: 'other',
      model: 'gpt-4o',
      temperature: 0.7,
      stop: ['END'],
    })
  })

  it('drops the seed effort when the provider changes alone or the model alone', () => {
    expect(
      overrideConfigWithRouteRule(seed, { provider: 'other', model: 'gpt-4o' }).reasoningEffort,
    ).toBeUndefined()
    expect(
      overrideConfigWithRouteRule(seed, { provider: 'mock', model: 'gpt-5' }).reasoningEffort,
    ).toBeUndefined()
  })

  it('carries an explicitly named effort on a cross-route override', () => {
    expect(
      overrideConfigWithRouteRule(seed, { provider: 'other', model: 'gpt-4o' }, 'low' as ReasoningEffortId),
    ).toEqual({
      provider: 'other',
      model: 'gpt-4o',
      reasoningEffort: 'low',
      temperature: 0.7,
      stop: ['END'],
    })
  })

  it('lets an explicit effort win over the seed effort on a same-route override', () => {
    expect(
      overrideConfigWithRouteRule(seed, { provider: 'mock', model: 'gpt-4o' }, 'low' as ReasoningEffortId).reasoningEffort,
    ).toBe('low')
  })

  it('returns a fresh config and never mutates the seed', () => {
    const result = overrideConfigWithRouteRule(seed, { provider: 'other', model: 'gpt-4o' })
    expect(result).not.toBe(seed)
    expect(seed).toEqual({
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high',
      temperature: 0.7,
      stop: ['END'],
    })
  })
})
