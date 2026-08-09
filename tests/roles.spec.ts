/**
 * Role resolution unit tests (Task 2).
 *
 * Covers the spec §3 / ADR-3 precedence — `agent.options.role` (explicit,
 * after the dsh patch) → first matching `roles.rules` entry (order matters)
 * → `roles.default` — including origin / provider / model pattern matching.
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
  it('prefers the explicit agent.options.role over rules and default', () => {
    const agent: AgentLike = {
      options: { role: 'explicit-role', provider: 'openai', model: 'gpt-4o' },
      session: { meta: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('explicit-role')
  })

  it('matches the first rule in listed order for a subagent', () => {
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { meta: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('code-review')
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
      session: { meta: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('anthropic-only')
  })

  it('matches a model-only rule', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gpt-4o' },
      session: { meta: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('gpt4o-only')
  })

  it('treats a missing origin as root (root agents carry no origin)', () => {
    const rules: RoleRule[] = [{ origin: 'root', role: 'root-chain' }]
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, rules, 'default')).toBe('root-chain')
  })

  it('returns the default role when nothing matches', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gemini-1.5-pro' },
      session: { meta: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, 'default')).toBe('default')
  })

  it('matches an unconstrained rule (catch-all) for any agent', () => {
    const rules: RoleRule[] = [{ role: 'catch-all' }]
    const agent: AgentLike = { options: { provider: 'x', model: 'y' }, session: { meta: { origin: 'subagent' } } }
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
