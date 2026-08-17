/**
 * Dispatch-time three-stage role resolution unit tests (plan
 * fallbacks-role-automatch Task 2).
 *
 * `resolveRoleAtDispatch` orders explicit → rules → auto-match hook:
 * 1. explicit — `session.header.agentPreset` trimmed matches a declared role
 *    id → the declared RAW id (via the `roleIds` trimmed-id map, the same
 *    canonicalization the rules path uses); `'inherit'` and undeclared
 *    presets are never dispatchable explicit roles and fall through to rules;
 * 2. rules — the existing `resolveRole` passthrough (a declared role wins);
 * 3. auto-match — only when stage 2 resolved to `'inherit'` AND
 *    `automatchEnabled`; the hook MUST return a declared raw id or `null`,
 *    and the resolver defensively validates the return against `roleIds` —
 *    an unknown id warns and resolves to `'inherit'`, never an undeclared
 *    role. When `automatch` is undefined or `automatchEnabled` is false the
 *    hook is skipped.
 *
 * `'inherit'` is the single "no specific role" outcome — reached by
 * no-rule-match OR an explicit rule targeting `'inherit'` — and both are
 * auto-match eligible when enabled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLike, FallbacksRoleRule } from '../src/roles.ts'
import { firstExactCandidate, resolveRoleAtDispatch } from '../src/role-resolution.ts'

const RULES: FallbacksRoleRule[] = [
  { origin: 'subagent', role: 'code-review' },
  { provider: 'anthropic', role: 'anthropic-only' },
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

/** An agent no rule matches (stage 2 → 'inherit') unless explicitly set. */
const NO_MATCH_AGENT: AgentLike = { options: { provider: 'google', model: 'gemini-1.5-pro' } }

describe('resolveRoleAtDispatch — stage 1 explicit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the declared RAW id when the preset matches a declared id, beating a rules match', async () => {
    // origin 'subagent' would hit the first rule — the explicit stage must
    // short-circuit before rules.
    const agent: AgentLike = { session: { header: { origin: 'subagent', agentPreset: 'coder' } } }
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, warn: () => {} }),
    ).resolves.toBe(' coder ')
  })

  it('canonicalizes a padded preset by trim before the roleIds lookup', async () => {
    const agent: AgentLike = { session: { header: { agentPreset: ' coder ' } } }
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, warn: () => {} }),
    ).resolves.toBe(' coder ')
  })

  it('falls through to rules when the preset is undeclared (no warn)', async () => {
    const warn = vi.fn()
    const agent: AgentLike = { options: { provider: 'anthropic' }, session: { header: { agentPreset: 'ghost' } } }
    await expect(resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, warn })).resolves.toBe('anthropic-only')
    expect(warn).not.toHaveBeenCalled()
  })

  it("falls through to rules when the preset is the reserved 'inherit'", async () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent', agentPreset: 'inherit' } } }
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, warn: () => {} }),
    ).resolves.toBe('code-review')
  })

  it('falls through to rules when the preset is empty/whitespace-only', async () => {
    const agent: AgentLike = { options: { provider: 'anthropic' }, session: { header: { agentPreset: '   ' } } }
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, warn: () => {} }),
    ).resolves.toBe('anthropic-only')
  })
})

describe('resolveRoleAtDispatch — stage 2 rules', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the rules-resolved declared id when there is no explicit preset', async () => {
    const agent: AgentLike = { session: { header: { origin: 'subagent' } } }
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, warn: () => {} }),
    ).resolves.toBe('code-review')
  })

  it("returns 'inherit' when no rule matches and auto-match is disabled (today's behavior)", async () => {
    const automatch = vi.fn(async () => 'anthropic-only')
    await expect(
      resolveRoleAtDispatch(NO_MATCH_AGENT, RULES, ROLE_IDS, { automatchEnabled: false, automatch, warn: () => {} }),
    ).resolves.toBe('inherit')
    expect(automatch).not.toHaveBeenCalled()
  })
})

describe('resolveRoleAtDispatch — stage 3 auto-match hook', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('invokes the hook with the agent context and returns its declared id', async () => {
    const agent: AgentLike = { options: { provider: 'google' }, session: { header: { agentPreset: 'ghost' } } }
    const automatch = vi.fn(async () => 'anthropic-only')
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, automatch, warn: () => {} }),
    ).resolves.toBe('anthropic-only')
    expect(automatch).toHaveBeenCalledTimes(1)
    expect(automatch).toHaveBeenCalledWith(agent)
  })

  it('canonicalizes a hook return by trim to the declared RAW id', async () => {
    // Hook returns the trimmed key; the resolver must still land on the
    // declared raw id (`' coder '`), mirroring the rules-path canonicalization.
    const automatch = vi.fn(async () => 'coder')
    await expect(
      resolveRoleAtDispatch(NO_MATCH_AGENT, RULES, ROLE_IDS, { automatchEnabled: true, automatch, warn: () => {} }),
    ).resolves.toBe(' coder ')
  })

  it("returns 'inherit' when the hook returns null", async () => {
    const automatch = vi.fn(async () => null)
    await expect(
      resolveRoleAtDispatch(NO_MATCH_AGENT, RULES, ROLE_IDS, { automatchEnabled: true, automatch, warn: () => {} }),
    ).resolves.toBe('inherit')
    expect(automatch).toHaveBeenCalledTimes(1)
  })

  it('warns and returns inherit when the hook returns an undeclared id (never an undeclared role)', async () => {
    const warn = vi.fn()
    const automatch = vi.fn(async () => 'ghost')
    await expect(
      resolveRoleAtDispatch(NO_MATCH_AGENT, RULES, ROLE_IDS, { automatchEnabled: true, automatch, warn }),
    ).resolves.toBe('inherit')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('undeclared role "ghost"'))
  })

  it("warns and returns inherit when the hook returns the reserved 'inherit' id (not a declared id)", async () => {
    const warn = vi.fn()
    const automatch = vi.fn(async () => 'inherit')
    await expect(
      resolveRoleAtDispatch(NO_MATCH_AGENT, RULES, ROLE_IDS, { automatchEnabled: true, automatch, warn }),
    ).resolves.toBe('inherit')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("does not invoke the hook when automatch is undefined even if enabled", async () => {
    await expect(
      resolveRoleAtDispatch(NO_MATCH_AGENT, RULES, ROLE_IDS, { automatchEnabled: true, warn: () => {} }),
    ).resolves.toBe('inherit')
  })

  it("an explicit 'inherit' preset with a rules miss is still auto-match eligible", async () => {
    // 'inherit' is the single "no specific role" outcome; both a no-rule-match
    // and an explicit 'inherit' preset reach it and both may auto-match.
    const agent: AgentLike = { options: { provider: 'google' }, session: { header: { agentPreset: 'inherit' } } }
    const automatch = vi.fn(async () => 'code-review')
    await expect(
      resolveRoleAtDispatch(agent, RULES, ROLE_IDS, { automatchEnabled: true, automatch, warn: () => {} }),
    ).resolves.toBe('code-review')
    expect(automatch).toHaveBeenCalledTimes(1)
  })

  it('handles a completely bare agent shape (no preset, no rules hit, disabled)', async () => {
    await expect(
      resolveRoleAtDispatch({}, RULES, ROLE_IDS, { automatchEnabled: false, warn: () => {} }),
    ).resolves.toBe('inherit')
  })
})

describe('firstExactCandidate (Task 4 dispatch chain-head helper)', () => {
  it('returns the first candidate whose wildcard flag is false', () => {
    const all = [
      { provider: 'a', model: 'm1', raw: 'a/*' },
      { provider: 'b', model: 'm2', raw: 'b/m2' },
      { provider: 'c', model: 'm3', raw: 'c/m3' },
    ]
    expect(firstExactCandidate(all, [true, false, false])).toEqual({ provider: 'b', model: 'm2', raw: 'b/m2' })
  })

  it('returns undefined when every candidate is wildcard', () => {
    const all = [
      { provider: 'a', model: 'm1', raw: 'a/*' },
      { provider: 'b', model: 'm2', raw: 'b/*' },
    ]
    expect(firstExactCandidate(all, [true, true])).toBeUndefined()
  })

  it('returns undefined on an empty chain', () => {
    expect(firstExactCandidate([], [])).toBeUndefined()
  })
})
