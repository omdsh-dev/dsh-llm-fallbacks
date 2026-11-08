/**
 * Dispatch role resolution — the TWO live stages (named virtual chains,
 * plan named-virtual-chains T3; the rules stage is DELETED with
 * `roles.rules`).
 *
 * `resolveDeclaredRole` orders explicit → dispatch and returns
 * `undefined` = NOT SPECIFIED when neither resolves (the plugin does not
 * intervene; the child inherits the delegating agent's route):
 * 1. explicit — `session.header.agentPreset` trimmed matches a declared role
 *    id → the declared RAW id (via the `roleIds` trimmed-id map); `'inherit'`
 *    and undeclared presets are never dispatchable explicit roles;
 * 2. dispatch — `opts.dispatchRole`, the role the dispatch seam resolved from
 *    the prompt, canonicalized the same way; absent / empty / `'inherit'` /
 *    no-longer-declared fall through silently (no warn).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDeclaredRole } from '../src/role-resolution.ts'

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

describe('resolveDeclaredRole — stage 1 explicit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the declared RAW id when the preset matches a declared id', () => {
    expect(resolveDeclaredRole('coder', ROLE_IDS, {})).toBe(' coder ')
  })

  it('canonicalizes a padded preset by trim before the roleIds lookup', () => {
    expect(resolveDeclaredRole(' coder ', ROLE_IDS, {})).toBe(' coder ')
  })

  it('an undeclared preset resolves to nothing (no warn, never a guess)', () => {
    const warn = vi.fn()
    expect(resolveDeclaredRole('ghost', ROLE_IDS, { dispatchRole: 'code-review' })).toBe('code-review')
    expect(warn).not.toHaveBeenCalled()
  })

  it("the reserved 'inherit' preset is never an explicit role", () => {
    expect(resolveDeclaredRole('inherit', ROLE_IDS, { dispatchRole: 'code-review' })).toBe('code-review')
    expect(resolveDeclaredRole('inherit', ROLE_IDS, {})).toBeUndefined()
  })

  it('an empty/whitespace-only preset falls through', () => {
    expect(resolveDeclaredRole('   ', ROLE_IDS, { dispatchRole: 'code-review' })).toBe('code-review')
  })
})

describe('resolveDeclaredRole — stage 2 dispatch-declared role', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the declared RAW id', () => {
    expect(resolveDeclaredRole(undefined, ROLE_IDS, { dispatchRole: 'coder' })).toBe(' coder ')
  })

  it('loses to a declared explicit preset (stage 1 stays first)', () => {
    expect(resolveDeclaredRole('anthropic-only', ROLE_IDS, { dispatchRole: 'coder' })).toBe('anthropic-only')
  })

  it('canonicalizes a padded dispatch role by trim before the roleIds lookup', () => {
    expect(resolveDeclaredRole(undefined, ROLE_IDS, { dispatchRole: ' coder ' })).toBe(' coder ')
  })

  it('absent, empty or reserved-inherit dispatch roles resolve to nothing', () => {
    expect(resolveDeclaredRole(undefined, ROLE_IDS, {})).toBeUndefined()
    for (const dispatchRole of ['', '   ', 'inherit']) {
      expect(resolveDeclaredRole(undefined, ROLE_IDS, { dispatchRole })).toBeUndefined()
    }
  })

  it('resolves to nothing silently (no warn) when the dispatch role is no longer declared', () => {
    const warn = vi.fn()
    expect(resolveDeclaredRole(undefined, ROLE_IDS, { dispatchRole: 'role-removed-after-dispatch' })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
