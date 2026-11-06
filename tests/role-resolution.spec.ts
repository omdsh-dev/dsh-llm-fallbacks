/**
 * Dispatch role resolution — the three live stages (plan
 * fallbacks-role-automatch Task 2; dispatch stage added by plan
 * dsh-148-agent-team-role-delivery Task 1; auto-match stage deleted by
 * direction C, plan dsh-022-rc1-upgrade).
 *
 * `resolveDeclaredRole` orders explicit → dispatch → rules:
 * 1. explicit — `session.header.agentPreset` trimmed matches a declared role
 *    id → the declared RAW id (via the `roleIds` trimmed-id map, the same
 *    canonicalization the rules path uses); `'inherit'` and undeclared
 *    presets are never dispatchable explicit roles and fall through;
 * 2. dispatch — `opts.dispatchRole`, the role the dispatch seam resolved from
 *    the prompt, canonicalized the same way; absent / empty / `'inherit'` /
 *    no-longer-declared fall through silently (no warn);
 * 3. rules — the existing `resolveRole` passthrough (a declared role wins).
 *
 * There is no auto-match stage: the walk resolves the role synchronously before
 * its first chunk, and the only host point an LLM role pick ever had (the
 * deleted `agent/request` inject) is gone.
 *
 * `'inherit'` is the single "no specific role" outcome — reached by
 * no-rule-match OR an explicit rule targeting `'inherit'`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLike, FallbacksRoleRule } from '../src/roles.ts'
import { resolveDeclaredRole } from '../src/role-resolution.ts'

const RULES: FallbacksRoleRule[] = [
  // Provider-scoped rule first so the anthropic tests below can reach it;
  // the trailing role-only rule is the subagent catch-all (its legacy
  // `origin` is ignored — PR #62 feedback).
  { provider: 'anthropic', role: 'anthropic-only' },
  { origin: 'subagent', role: 'code-review' },
]

/**
 * Declared ids — trimmed id → declared raw id (qc2 F-001 canonicalization):
 * `coder` is declared PADDED (`' coder '`), so the RAW id the resolver must
 * return is `' coder '`; the other two are unpadded.
 */
const ROLE_IDS = new Map([
  ['code-review', 'code-review'],
  ['anthropic-only', 'anthropic-only'],
  ['coder', ' coder '],
])

/** An agent no rule matches (stage 3 → 'inherit') unless explicitly set. */
const NO_MATCH_AGENT: AgentLike = { options: { provider: 'google', model: 'gemini-1.5-pro' } }

describe('resolveDeclaredRole — stage 1 explicit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the declared RAW id when the preset matches a declared id, beating a rules match', () => {
    // The subagent would hit the rules stage — the explicit stage must
    // short-circuit before rules.
    const agent: AgentLike = { session: { header: { origin: 'subagent', agentPreset: 'coder' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn: () => {} })).toBe(' coder ')
  })

  it('canonicalizes a padded preset by trim before the roleIds lookup', () => {
    const agent: AgentLike = { session: { header: { agentPreset: ' coder ' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn: () => {} })).toBe(' coder ')
  })

  it('falls through to rules when the preset is undeclared (no warn)', () => {
    // PR #62 feedback: rules are subagent-only — the agent must carry a
    // subagent origin for the rules stage to match.
    const warn = vi.fn()
    const agent: AgentLike = {
      options: { provider: 'anthropic' },
      session: { header: { origin: 'subagent', agentPreset: 'ghost' } },
    }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn })).toBe('anthropic-only')
    expect(warn).not.toHaveBeenCalled()
  })

  it("falls through to rules when the preset is the reserved 'inherit'", () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent', agentPreset: 'inherit' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn: () => {} })).toBe('code-review')
  })

  it('falls through to rules when the preset is empty/whitespace-only', () => {
    const agent: AgentLike = {
      options: { provider: 'anthropic' },
      session: { header: { origin: 'subagent', agentPreset: '   ' } },
    }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn: () => {} })).toBe('anthropic-only')
  })
})

describe('resolveDeclaredRole — stage 2 dispatch-declared role', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the declared RAW id and beats a matching rule', () => {
    // The agent matches the `anthropic-only` rule — the dispatch stage must
    // win before rules, and canonicalize through roleIds (' coder ').
    const agent: AgentLike = {
      options: { provider: 'anthropic' },
      session: { header: { origin: 'subagent' } },
    }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { dispatchRole: 'coder', warn: () => {} })).toBe(' coder ')
  })

  it('loses to a declared explicit preset (stage 1 stays first)', () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent', agentPreset: 'anthropic-only' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { dispatchRole: 'coder', warn: () => {} })).toBe('anthropic-only')
  })

  it('canonicalizes a padded dispatch role by trim before the roleIds lookup', () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { dispatchRole: ' coder ', warn: () => {} })).toBe(' coder ')
  })

  it("falls through to rules for an absent, empty or reserved-inherit dispatch role", () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn: () => {} })).toBe('code-review')
    for (const dispatchRole of ['', '   ', 'inherit']) {
      expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { dispatchRole, warn: () => {} })).toBe('code-review')
    }
  })

  it('falls through silently (no warn) when the dispatch role is no longer declared', () => {
    const warn = vi.fn()
    const agent: AgentLike = { session: { header: { origin: 'subagent' } } }
    expect(
      resolveDeclaredRole(agent, RULES, ROLE_IDS, { dispatchRole: 'role-removed-after-dispatch', warn }),
    ).toBe('code-review')
    expect(warn).not.toHaveBeenCalled()
  })

  it("reaches 'inherit' when a stale dispatch role matches no rule", () => {
    expect(
      resolveDeclaredRole(NO_MATCH_AGENT, RULES, ROLE_IDS, {
        dispatchRole: 'role-removed-after-dispatch',
        warn: () => {},
      }),
    ).toBe('inherit')
  })
})

describe('resolveDeclaredRole — stage 3 rules', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the rules-resolved declared id when there is no explicit preset', () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent' } } }
    expect(resolveDeclaredRole(agent, RULES, ROLE_IDS, { warn: () => {} })).toBe('code-review')
  })

  it("returns 'inherit' when no rule matches", () => {
    expect(resolveDeclaredRole(NO_MATCH_AGENT, RULES, ROLE_IDS, { warn: () => {} })).toBe('inherit')
  })

  it('accepts the served route for head-keyed rule matching (QC1 I-1)', () => {
    // A child whose recorded pair is the virtual row keeps matching a rule
    // keyed on the real chain head it is served by.
    const agent: AgentLike = {
      options: { provider: 'FallbacksChain', model: 'Auto' },
      session: { header: { origin: 'subagent' } },
    }
    expect(
      resolveDeclaredRole(agent, RULES, ROLE_IDS, {
        servedRoute: { provider: 'anthropic', model: 'claude-sonnet-4' },
        warn: () => {},
      }),
    ).toBe('anthropic-only')
  })
})
