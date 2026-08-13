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
import {
  Config,
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
  return { id: 'coder', label: 'Coder', description: 'Coding subagent', ...overrides }
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
        list: [{ id: 'reviewer', label: 'Reviewer', description: '' }],
        rules: [{ role: 'reviewer' }],
      },
    } as unknown as FallbacksConfig)
    expect(resolved.cooldownMs).toBe(1_000)
    expect(resolved.rootChain).toEqual(['other/gpt-4o'])
    expect(resolved.roles.list).toEqual([{
      id: 'reviewer',
      label: 'Reviewer',
      description: '',
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
      roles: { list: [{ id: 'coder', label: 'Coder', description: 'd' }] },
    } as unknown as FallbacksConfig)
    expect(resolved.roles.list[0]).toEqual({
      id: 'coder',
      label: 'Coder',
      description: 'd',
      // absent object/array fields compose to empty defaults (schemastery);
      // a string-optional field (prompt) stays absent.
      permissions: { allow: [], deny: [] },
      chain: [],
      fallback: 'inherit-root',
    })
    expect('prompt' in resolved.roles.list[0]).toBe(false)
  })

  it('keeps role id mandatory and rule role mandatory in the schema', () => {
    expect(() => Config({ roles: { list: [{ label: 'x', description: '' }] } } as unknown as FallbacksConfig))
      .toThrow(/id/)
    expect(() => Config({ roles: { rules: [{ provider: 'openai' }] } } as unknown as FallbacksConfig))
      .toThrow(/role/)
  })
})

describe('validateFallbacksConfig — role ids (format / uniqueness / reserved word)', () => {
  it('accepts valid ids and free-text label/description without a single warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [
          role({ id: 'coder', label: '任意 label，含特殊字符 !@#', description: '自由文本' }),
          role({ id: 'a1-b2', label: '', description: '' }),
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
          role({ id: 'Bad-Id' }),
          role({ id: 'under_score' }),
          role({ id: 'x'.repeat(33) }),
          role({ id: '' }),
          role({ id: 'a'.repeat(32) }), // boundary: exactly 32 chars is legal
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
})

describe('validateFallbacksConfig — rule role references', () => {
  it('accepts declared ids and the built-in "inherit" as rule targets', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      roles: {
        list: [role({ id: 'coder' })],
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
        list: [role({ id: 'a', fallback: 'inherit-root' }), role({ id: 'b', fallback: 'none' })],
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
})
