/**
 * Role resolution unit tests (plan fallbacks-role-runtime Task 1; PR #62
 * feedback round).
 *
 * Covers spec §7.1 — first matching `roles.rules` entry (order matters) →
 * built-in `'inherit'`, with provider / model pattern matching. Rules are
 * SUBAGENT-ONLY (PR #62 feedback): root requests never match rules, and
 * the legacy per-rule `origin` field is ignored at match time. A matched
 * rule must target a declared role id (`roleIds`) or `'inherit'`; an
 * undeclared target warns and resolves to `'inherit'` (defensive —
 * startup validation already flagged the reference). `roleIds` is the
 * canonical trimmed-id map (`trimmed id → declared raw id`, qc2 F-001): a
 * matched rule returns the DECLARED RAW id.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLike, FallbacksRoleRule } from '../src/roles.ts'
import { resolveRole } from '../src/roles.ts'

const RULES: FallbacksRoleRule[] = [
  // PR #62 feedback: legacy `origin` fields are IGNORED at match time —
  // every rule below applies to subagents regardless of the stored value
  // (rule 1 deliberately carries `origin: 'root'` to pin that semantics).
  { origin: 'root', provider: 'openai', role: 'openai-any' },
  { provider: 'anthropic', role: 'anthropic-only' },
  { model: 'gpt-4o', role: 'gpt4o-only' },
]

/**
 * Declared ids: everything RULES targets (the warn case declares its own).
 * Trimmed id → declared raw id (identical here; padded cases are pinned by
 * dedicated tests below).
 */
const ROLE_IDS = new Map([
  ['openai-any', 'openai-any'],
  ['anthropic-only', 'anthropic-only'],
  ['gpt4o-only', 'gpt4o-only'],
])

describe('resolveRole', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('matches the first provider-scoped rule for a subagent (persisted origin ignored)', () => {
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('openai-any')
  })

  it('treats a missing origin as root — root requests never match rules', () => {
    // PR #62 feedback: rules are subagent-only — even an `origin: root`
    // rule cannot match a root agent (the field is ignored entirely).
    const rules: FallbacksRoleRule[] = [{ origin: 'root', role: 'root-chain' }]
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, rules, new Map([['root-chain', 'root-chain']]))).toBe('inherit')
  })

  it('never matches a rule for a root agent even when provider/model fit (subagent-only)', () => {
    // The second fixture rule is `{ origin: 'root', provider: 'openai' }` —
    // previously it routed root openai agents; now root resolves to
    // 'inherit' unconditionally.
    const agent: AgentLike = { options: { provider: 'openai', model: 'gpt-4o' } }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('inherit')
  })

  it('matches a provider-only rule for a subagent (later rule, no earlier match)', () => {
    // First rule (role-only) matches ANY subagent — so this fixture walks
    // past it only when the subagent is matched by an earlier rule; here
    // 'anthropic' skips rules 1-2 → third rule matches.
    const agent: AgentLike = {
      options: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('anthropic-only')
  })

  it('matches a model-only rule', () => {
    const agent: AgentLike = {
      options: { provider: 'google', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, RULES, ROLE_IDS)).toBe('gpt4o-only')
  })

  it('matches an origin+provider+model combo rule when all patterns fit (persisted origin ignored)', () => {
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
    const agent: AgentLike = { options: { model: 'gpt-4o' }, session: { header: { origin: 'subagent' } } }
    expect(resolveRole(agent, rules, new Map([['first', 'first'], ['second', 'second']]))).toBe('first')
  })

  it('a persisted origin: root rule still matches a subagent (origin ignored)', () => {
    // PR #62 feedback: the legacy `origin` field is ignored at match time —
    // a pre-feedback rule written as `{ origin: 'root', provider: 'openai' }`
    // applies to subagents exactly like any other rule.
    const rules: FallbacksRoleRule[] = [{ origin: 'root', provider: 'openai', role: 'coder' }]
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveRole(agent, rules, new Map([['coder', 'coder']]))).toBe('coder')
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
    // No origin → root → rules never match → inherit.
    expect(resolveRole({}, RULES, ROLE_IDS)).toBe('inherit')
  })

  it('canonicalizes a padded declared id (qc2 F-001): trimmed rule reference returns the declared raw id', () => {
    // roles.list: [{ id: ' coder ' }] + roles.rules: [{ role: 'coder' }] —
    // the validator accepts this (both sides trimmed); the runtime must
    // resolve to the DECLARED role (raw id), never silently 'inherit'.
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    const roleIds = new Map([['coder', ' coder ']])
    expect(resolveRole(agent, [{ provider: 'openai', role: 'coder' }], roleIds)).toBe(' coder ')
  })

  it('canonicalizes a padded rule reference (qc2 F-001): raw declared id returned for the reverse padding', () => {
    // Reverse asymmetry: list id 'coder' (unpadded), rule role ' coder '.
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    const roleIds = new Map([['coder', 'coder']])
    expect(resolveRole(agent, [{ provider: 'openai', role: ' coder ' }], roleIds)).toBe('coder')
  })

  it('still falls back to inherit when a padded rule reference is genuinely undeclared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent: AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    const roleIds = new Map([['coder', 'coder']])
    expect(resolveRole(agent, [{ provider: 'openai', role: ' ghost ' }], roleIds)).toBe('inherit')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('undeclared role " ghost "'))
  })
})
