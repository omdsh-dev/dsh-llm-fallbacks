/**
 * Config schema invariants for the two-block config model (plan
 * fallbacks-role-config-model Task 1): no-op defaults (AC-8), role id
 * format/uniqueness/reserved-word warnings, rule role reference warnings
 * (declared ids + built-in 'inherit'), the `fallback` enum, selector
 * legality, and `detectLegacyKeys` over the three legacy classes
 * (`chains` / `roles.default` / undeclared `roles.rules[].role`).
 *
 * `validateFallbacksConfig` is warn-only by contract (spec §4 / AC-4 —
 * warn, never throw, never take effect); every case asserts the exact
 * warning text so the message surface is pinned.
 */

import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/schema.ts'
import {
  INHERIT_ROLE_ID,
  defaultFallbacksConfig,
  detectLegacyKeys,
  validateFallbacksConfig,
  type FallbacksConfig,
  type FallbacksRole,
} from '../src/config.ts'

/** Warn-only logger double: collects every `llm-fallbacks: ...` warn. */
function warnLogger() {
  const warn = vi.fn()
  return { warn, logger: { warn } }
}

function messagesOf(logger: { warn: ReturnType<typeof vi.fn> }): string[] {
  return logger.warn.mock.calls.map((call) => String(call[0]))
}

function role(overrides: Partial<FallbacksRole> = {}): FallbacksRole {
  return { id: 'coder', persona: 'Coding subagent', ...overrides }
}

describe('fallbacks Config schema (two-block model)', () => {
  it('resolves the empty section to the spec defaults (AC-8 no-op invariant)', () => {
    expect(Config({} as FallbacksConfig)).toEqual(defaultFallbacksConfig)
  })

  it('layers partial input over the spec defaults', () => {
    const resolved = Config({
      cooldownMs: 1_000,
      rootChain: ['other/gpt-4o'],
      roles: {
        list: [{ id: 'reviewer', persona: '' }],
        rules: [{ role: 'reviewer' }],
      },
    } as unknown as FallbacksConfig)
    expect(resolved.cooldownMs).toBe(1_000)
    expect(resolved.rootChain).toEqual(['other/gpt-4o'])
    expect(resolved.roles.list).toEqual([{
      id: 'reviewer',
      persona: '',
      // schemastery fills absent object/array fields with empty defaults —
      // semantically "no own chain / no permissions", same as absent.
      permissions: { allow: [], deny: [] },
      chain: [],
      fallback: 'inherit-root',
    }])
    expect(resolved.roles.rules).toEqual([{ role: 'reviewer' }])
    // The feature switch defaults OFF (readme-settings spec §1.2); a partial
    // input inherits the new default.
    expect(resolved.enabled).toBe(false)
    expect(resolved.triggerCodes).toEqual(['AUTH', 'QUOTA', 'RATE_LIMIT'])
  })

  it('composed role entities carry the fallback default and keep string-optional fields absent', () => {
    const resolved = Config({
      roles: { list: [{ id: 'coder', persona: 'd' }] },
    } as unknown as FallbacksConfig)
    expect(resolved.roles.list[0]).toEqual({
      id: 'coder',
      persona: 'd',
      // absent object/array fields compose to empty defaults (schemastery);
      // a string-optional field (prompt) stays absent.
      permissions: { allow: [], deny: [] },
      chain: [],
      fallback: 'inherit-root',
    })
    expect('prompt' in resolved.roles.list[0]).toBe(false)
  })

  it('keeps role id mandatory and rule role mandatory in the schema', () => {
    expect(() => Config({ roles: { list: [{ persona: 'x' }] } } as unknown as FallbacksConfig))
      .toThrow(/id/)
    expect(() => Config({ roles: { rules: [{ provider: 'openai' }] } } as unknown as FallbacksConfig))
      .toThrow(/role/)
  })

  it('defaults the presets switch to bundled (spec §9.4 config key)', () => {
    // The 9th field rides the schema default exactly like the other
    // optional fields — `Config({})` must carry `presets: 'bundled'`.
    const resolved = Config({} as FallbacksConfig)
    expect(resolved.presets).toBe('bundled')
  })

  it('rejects a presets value outside the bundled|none union at schema resolve', () => {
    // Same semantics as the revertPolicy union (spec §9.4): the value
    // domain is guarded by the schema — NOT by validateFallbacksConfig.
    // The matcher pins the rejecting stage AND the exact union, so a
    // subset-list regression (e.g. a single-const union) fails here.
    expect(() => Config({ presets: 'sometimes' } as unknown as FallbacksConfig)).toThrow(TypeError)
    expect(() => Config({ presets: 'sometimes' } as unknown as FallbacksConfig)).toThrow(
      /presets expected "bundled" \| "none"/,
    )
  })
})

describe('validateFallbacksConfig — role ids (format / uniqueness / reserved word)', () => {
  it('accepts valid ids and free-text persona without a single warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [
          // Roles carry a chain so the role model-config requirement (T2)
          // does not fire — the zero-warn assertion pins id/persona.
          role({ id: 'coder', persona: '任意 persona，含特殊字符 !@#', chain: ['openai/gpt-4o'] }),
          role({ id: 'a1-b2', persona: '', chain: ['other/gpt-4o-mini'] }),
        ],
        rules: [],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on invalid id formats (uppercase, underscore, too long, empty)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [
          // Chains ride every role so the count pins the format warns only
          // (the role model-config warn fires on chain-less roles — T2).
          role({ id: 'Bad-Id', chain: ['openai/gpt-4o'] }),
          role({ id: 'under_score', chain: ['openai/gpt-4o'] }),
          role({ id: 'x'.repeat(33), chain: ['openai/gpt-4o'] }),
          role({ id: '', chain: ['openai/gpt-4o'] }),
          role({ id: 'a'.repeat(32), chain: ['openai/gpt-4o'] }), // boundary: exactly 32 chars is legal
        ],
        rules: [],
      },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(4)
    for (const bad of ['Bad-Id', 'under_score', 'x'.repeat(33)]) {
      expect(messages).toContain(`llm-fallbacks: invalid role id "${bad}" — must match /^[a-z0-9-]{1,32}$/`)
    }
    expect(messages.some((m) => m.includes('"a'.repeat(32) + '"'))).toBe(false)
  })

  it('warns on duplicate role ids', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: { list: [role({ id: 'coder' }), role({ id: 'coder' })], rules: [] },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toContain('llm-fallbacks: duplicate role id "coder" — role ids must be unique')
  })

  it('warns when the reserved id "inherit" is declared as a list id', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: { list: [role({ id: INHERIT_ROLE_ID })], rules: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toContain(
      'llm-fallbacks: role id "inherit" is reserved — "inherit" cannot be declared in roles.list',
    )
  })

  it('trims role ids before validation, matching the client canonical pipeline (qc2 S-3)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [
          // A padded-but-valid id trims to the canonical form the UI
          // rebuilds (row.id.trim()): no format warn, and a rule
          // referencing the canonical id resolves — no undeclared warn.
          // Chains ride both roles so the count pins the format warn only
          // (the role model-config warn fires on chain-less roles — T2).
          role({ id: ' coder ', chain: ['openai/gpt-4o'] }),
          // Whitespace that survives trim (internal space) is still a
          // format violation — the raw stored id names the offending value.
          role({ id: 'bad id', chain: ['openai/gpt-4o'] }),
        ],
        rules: [{ role: 'coder' }],
      },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    // The whitespace id warns as FORMAT (not duplicate/undeclared).
    expect(messages).toContain('llm-fallbacks: invalid role id "bad id" — must match /^[a-z0-9-]{1,32}$/')
    expect(messages).toHaveLength(1)
    expect(messages.some((m) => m.includes('duplicate role id'))).toBe(false)
    expect(messages.some((m) => m.includes('undeclared role'))).toBe(false)
  })

  it('a padded id and its canonical twin are duplicates (trimmed dedup set)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [role({ id: 'coder ' }), role({ id: 'coder' })],
        rules: [],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toContain(
      'llm-fallbacks: duplicate role id "coder" — role ids must be unique',
    )
  })
})

describe('validateFallbacksConfig — rule role references', () => {
  it('accepts declared ids and the built-in "inherit" as rule targets', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        // A chain rides the declared role so the role model-config warn
        // (T2) does not fire — the zero-warn pins the rule targets.
        list: [role({ id: 'coder', chain: ['openai/gpt-4o'] })],
        rules: [{ role: 'coder' }, { role: 'inherit' }],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on an undeclared rule role reference (the rule does not take effect)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [role({ id: 'coder' })],
        rules: [{ role: 'ghost' }],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toContain(
      'llm-fallbacks: rule references undeclared role "ghost" — expected one of roles.list ids or "inherit"',
    )
  })
})

describe('validateFallbacksConfig — fallback enum', () => {
  it('accepts inherit-root and none without a warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        // Chains ride both roles so the role model-config warn (T2) does
        // not fire — the zero-warn pins the fallback enum values.
        list: [
          role({ id: 'a', fallback: 'inherit-root', chain: ['openai/gpt-4o'] }),
          role({ id: 'b', fallback: 'none', chain: ['other/gpt-4o-mini'] }),
        ],
        rules: [],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on a fallback value outside the enum', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [{ ...role({ id: 'a' }), fallback: 'sometimes' as FallbacksRole['fallback'] }],
        rules: [],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toContain(
      'llm-fallbacks: role "a" has invalid fallback "sometimes" — expected "inherit-root" or "none"',
    )
  })
})

describe('validateFallbacksConfig — selector legality (rootChain + role chains)', () => {
  it('warns on invalid rootChain entries without throwing', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: ['other/gpt-4o', 'bogus', 'provider/', 'openai/gpt-4o'],
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('ignoring invalid rootChain entry "bogus"')
    expect(messages[1]).toContain('ignoring invalid rootChain entry "provider/"')
  })

  it('warns on invalid role chain entries, naming the role', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [role({ id: 'coder', chain: ['mistral/*', 'nope'] })],
        rules: [],
      },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('llm-fallbacks: ignoring invalid chain entry "nope" in role "coder"')
  })

  it('never throws — every violation is a warn (AC-4 warn-not-crash semantics)', () => {
    const { logger } = warnLogger()
    expect(() => validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: ['garbage'],
      roles: {
        list: [role({ id: 'Bad Id', chain: ['also-bad'] })],
        rules: [{ role: 'missing' }],
      },
    }, logger)).not.toThrow()
    expect(messagesOf({ warn: logger.warn }).length).toBeGreaterThan(0)
  })
})

describe('validateFallbacksConfig — role model config (chain required semantics, plan fallbacks-feedback-round T2)', () => {
  it('warns when a role declares no chain, naming the role, without throwing', () => {
    const { logger } = warnLogger()
    expect(() => validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: { list: [role({ id: 'coder' })], rules: [] },
    }, logger)).not.toThrow()
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe(
      'llm-fallbacks: role "coder" has no model config — declare at least one chain entry, or use the built-in "inherit" rule target instead',
    )
  })

  it('warns on an explicit empty chain array, naming the role', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: { list: [role({ id: 'coder', chain: [] })], rules: [] },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe(
      'llm-fallbacks: role "coder" has no model config — declare at least one chain entry, or use the built-in "inherit" rule target instead',
    )
  })

  it('does not warn when a role declares at least one chain entry', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: { list: [role({ id: 'coder', chain: ['openai/gpt-4o'] })], rules: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })
})

describe('detectLegacyKeys — three legacy classes', () => {
  it('returns [] for a clean two-block config (no legacy keys, declared rule roles)', () => {
    expect(detectLegacyKeys({
      enabled: true,
      rootChain: ['other/gpt-4o'],
      roles: { list: [{ id: 'coder' }], rules: [{ role: 'coder' }, { role: 'inherit' }] },
    })).toEqual([])
  })

  it('detects the removed chains key', () => {
    expect(detectLegacyKeys({ chains: { default: ['other/gpt-4o'] } })).toContain('chains')
  })

  it('detects the removed roles.default field', () => {
    expect(detectLegacyKeys({ roles: { default: 'default', rules: [] } })).toContain('roles.default')
  })

  it('detects undeclared rule role references (role names), in rule order', () => {
    expect(detectLegacyKeys({
      roles: {
        list: [{ id: 'coder' }],
        rules: [{ role: 'coder' }, { role: 'ghost' }, { role: 'inherit' }, { role: 'other-ghost' }],
      },
    })).toEqual(['roles.rules[].role: ghost', 'roles.rules[].role: other-ghost'])
  })

  it('collects all three classes from one legacy source, deduplicated by occurrence', () => {
    expect(detectLegacyKeys({
      chains: { default: ['a/b'] },
      roles: { default: 'reviewer', list: [], rules: [{ role: 'reviewer' }, { role: 'inherit' }] },
    })).toEqual(['chains', 'roles.default', 'roles.rules[].role: reviewer'])
  })

  it('detects the removed role-entity label / description fields (renamed to persona)', () => {
    expect(detectLegacyKeys({
      roles: {
        list: [
          { id: 'coder', label: 'Coder', description: 'Code review subagent' },
          { id: 'cheap', description: 'Cost first' },
        ],
        rules: [],
      },
    })).toEqual(['roles.list[].label', 'roles.list[].description', 'roles.list[].description'])
  })
})
