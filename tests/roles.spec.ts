/**
 * Role resolution unit tests (Plan B / T1).
 *
 * Covers the spec §3 / ADR-3 rules-only precedence — first matching
 * `roles.rules` entry (order matters) → `roles.default` — including
 * origin / provider / model pattern matching. An explicit-role field is
 * intentionally absent from `AgentLike`: it existed only via the
 * dsh-agent patch (removed in Plan B), so it is not part of resolution.
 */

import { describe, expect, it } from 'vitest'
import type { AgentLike, RoleRule } from '../src/roles.ts'
import { resolveRole } from '../src/roles.ts'

const RULES: RoleRule[] = [
  { origin: 'subagent', role: 'code-review' },
  { origin: 'root', provider: 'openai', role: 'root-openai' },
  { provider: 'anthropic', role: 'anthropic-only' },
  { model: 'gpt-4o', role: 'gpt4o-only' },
]

describe('resolveRole', () => {
  it('matches an origin-only rule for a subagent', () => {
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('code-review')
  })

  it('treats a missing origin as root (root agents carry no origin)', () => {
    const rules: RoleRule[] = [{ origin: 'root', role: 'root-chain' }]
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, rules, 'default')).toBe('root-chain')
  })

  it('matches an origin+provider rule for a root agent', () => {
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, RULES, 'default')).toBe('root-openai')
  })

  it('matches a provider-only rule (later rule, no earlier match)', () => {
    // origin 'root' skips the first rule; provider 'anthropic' skips the
    // second ({origin:'root', provider:'openai'}) → third rule matches.
    const agent: AgentLike = {
      options: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      session: { header: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('anthropic-only')
  })

  it('matches a model-only rule', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gpt-4o' },
      session: { header: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('gpt4o-only')
  })

  it('matches an origin+provider+model combo rule when all patterns fit', () => {
    const rules: RoleRule[] = [
      { origin: 'subagent', provider: 'openai', model: 'gpt-4o', role: 'subagent-openai-gpt4o' },
    ]
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, rules, 'default')).toBe('subagent-openai-gpt4o')
  })

  it('skips a combo rule when any one pattern differs', () => {
    const rules: RoleRule[] = [
      { origin: 'subagent', provider: 'openai', model: 'gpt-4o', role: 'subagent-openai-gpt4o' },
    ]
    // provider differs → no rule matches → default.
    const agent: AgentLike = {
      options: { provider: 'anthropic', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, rules, 'default')).toBe('default')
  })

  it('returns the default role when nothing matches', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gemini-1.5-pro' },
      session: { header: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('default')
  })

  it('matches an unconstrained rule (catch-all) for any agent', () => {
    const rules: RoleRule[] = [{ role: 'catch-all' }]
    const agent: AgentLike = { options: { provider: 'x', model: 'y' }, session: { header: { origin: 'subagent' } } }
    expect(resolveRole(agent, rules, 'default')).toBe('catch-all')
  })

  it('respects rule order: first match wins', () => {
    const rules: RoleRule[] = [
      { model: 'gpt-4o', role: 'first' },
      { model: 'gpt-4o', role: 'second' },
    ]
    const agent: AgentLike = { options: { model: 'gpt-4o' } }
    expect(resolveRole(agent, rules, 'default')).toBe('first')
  })

  it('handles a completely bare agent shape', () => {
    expect(resolveRole({}, RULES, 'fallback')).toBe('fallback')
  })
})
