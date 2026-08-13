/**
 * Role resolution unit tests (plan fallbacks-role-runtime Task 1).
 *
 * Covers spec §7.1 — first matching `roles.rules` entry (order matters) →
 * built-in `'inherit'`, including origin / provider / model pattern
 * matching. A matched rule must target a declared role id (`roleIds`) or
 * `'inherit'`; an undeclared target warns and resolves to `'inherit'`
 * (defensive — startup validation already flagged the reference).
 * `roleIds` is the canonical trimmed-id map (`trimmed id → declared raw
 * id`, qc2 F-001): a matched rule returns the DECLARED RAW id.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLike, FallbacksRoleRule } from '../src/roles.ts'
import { resolveRole } from '../src/roles.ts'

const RULES: FallbacksRoleRule[] = [
  { origin: 'subagent', role: 'code-review' },
  { origin: 'root', provider: 'openai', role: 'root-openai' },
  { provider: 'anthropic', role: 'anthropic-only' },
  { model: 'gpt-4o', role: 'gpt4o-only' },
]

/**
 * Declared ids: everything RULES targets (the warn case declares its own).
 * Trimmed id → declared raw id (identical here; padded cases are pinned by
 * dedicated tests below).
 */
const ROLE_IDS = new Map([
  ['code-review', 'code-review'],
  ['root-openai', 'root-openai'],
  ['anthropic-only', 'anthropic-only'],
  ['gpt4o-only', 'gpt4o-only'],
])

describe('resolveRole', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('matches an origin-only rule for a subagent', () => {
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('code-review')
  })

  it('treats a missing origin as root (root agents carry no origin)', () => {
    const rules: FallbacksRoleRule[] = [{ origin: 'root', role: 'root-chain' }]
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, rules, new Map([['root-chain', 'root-chain']]))).toBe('root-chain')
  })

  it('matches an origin+provider rule for a root agent', () => {
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('root-openai')
  })

  it('matches a provider-only rule (later rule, no earlier match)', () => {
    // origin 'root' skips the first rule; provider 'anthropic' skips the
    // second ({origin:'root', provider:'openai'}) → third rule matches.
    const agent: AgentLike = {
      options: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      session: { header: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('anthropic-only')
  })

  it('matches a model-only rule', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gpt-4o' },
      session: { header: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('gpt4o-only')
  })

  it('matches an origin+provider+model combo rule when all patterns fit', () => {
    const rules: FallbacksRoleRule[] = [
      { origin: 'subagent', provider: 'openai', model: 'gpt-4o', role: 'subagent-openai-gpt4o' },
    ]
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, rules, new Map([['subagent-openai-gpt4o', 'subagent-openai-gpt4o']]))).toBe('subagent-openai-gpt4o')
  })

  it('skips a combo rule when any one pattern differs', () => {
    const rules: FallbacksRoleRule[] = [
      { origin: 'subagent', provider: 'openai', model: 'gpt-4o', role: 'subagent-openai-gpt4o' },
    ]
    // provider differs → no rule matches → inherit.
    const agent: AgentLike = {
      options: { provider: 'anthropic', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, rules, new Map([['subagent-openai-gpt4o', 'subagent-openai-gpt4o']]))).toBe('inherit')
  })

  it('returns the built-in inherit role when nothing matches', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gemini-1.5-pro' },
      session: { header: { origin: 'root' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('inherit')
  })

  it('honors an explicit inherit target (catch-all rule)', () => {
    const rules: FallbacksRoleRule[] = [{ role: 'inherit' }]
    const agent: AgentLike = { options: { provider: 'x', model: 'y' }, session: { header: { origin: 'subagent' } } }
    expect(resolveRole(agent, rules, ROLE_IDS)).toBe('inherit')
  })

  it('respects rule order: first match wins', () => {
    const rules: FallbacksRoleRule[] = [
      { model: 'gpt-4o', role: 'first' },
      { model: 'gpt-4o', role: 'second' },
    ]
    const agent: AgentLike = { options: { model: 'gpt-4o' } }
    expect(resolveRole(agent, rules, new Map([['first', 'first'], ['second', 'second']]))).toBe('first')
  })

  it('warns and falls back to inherit when a rule targets an undeclared role', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rules: FallbacksRoleRule[] = [{ origin: 'subagent', role: 'ghost' }]
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, rules, ROLE_IDS)).toBe('inherit')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('undeclared role "ghost"'))
  })

  it('handles a completely bare agent shape', () => {
    expect(resolveRole({}, RULES, ROLE_IDS)).toBe('inherit')
  })

  it('canonicalizes a padded declared id (qc2 F-001): trimmed rule reference returns the declared raw id', () => {
    // roles.list: [{ id: ' coder ' }] + roles.rules: [{ role: 'coder' }] —
    // the validator accepts this (both sides trimmed); the runtime must
    // resolve to the DECLARED role (raw id), never silently 'inherit'.
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    const roleIds = new Map([['coder', ' coder ']])
    expect(resolveRole(agent, [{ provider: 'openai', role: 'coder' }], roleIds)).toBe(' coder ')
  })

  it('canonicalizes a padded rule reference (qc2 F-001): raw declared id returned for the reverse padding', () => {
    // Reverse asymmetry: list id 'coder' (unpadded), rule role ' coder '.
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    const roleIds = new Map([['coder', 'coder']])
    expect(resolveRole(agent, [{ provider: 'openai', role: ' coder ' }], roleIds)).toBe('coder')
  })

  it('still falls back to inherit when a padded rule reference is genuinely undeclared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    const roleIds = new Map([['coder', 'coder']])
    expect(resolveRole(agent, [{ provider: 'openai', role: ' ghost ' }], roleIds)).toBe('inherit')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('undeclared role " ghost "'))
  })
})
