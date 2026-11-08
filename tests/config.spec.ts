/**
 * Config v2 invariants (named virtual chains, plan named-virtual-chains
 * T1): no-op defaults (empty `chains`), chain id format/uniqueness
 * (case-sensitive), per-chain tail conformance + selector legality +
 * slot-row guards, role id checks (format/uniqueness/reserved word),
 * the role chain POINTER unknown-id warn, and `detectLegacyKeys` over
 * both legacy generations (older removals + v1 two-block keys).
 *
 * `validateFallbacksConfig` is warn-only by contract (warn, never throw,
 * never take effect); every case asserts the exact warning text so the
 * message surface is pinned.
 */

import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/schema.ts'
import { unwrapConfig } from './support/unwrap-config.ts'
import {
  defaultFallbacksConfig,
  detectLegacyKeys,
  MIGRATED_CHAIN_ID,
  MIGRATED_CHAIN_LABEL,
  migrateLegacyConfig,
  isFallbackActive,
  validateFallbacksConfig,
  type FallbacksConfig,
  type NamedChain,
} from '../src/config.ts'
import { ESCALATION_CAP_MS } from '../src/recovery.ts'
import { OFFICIAL_FLASH, OFFICIAL_PRO, type SlotRowConfig } from '../src/time-slots.ts'

/** Warn-only logger double: collects every `llm-fallbacks: ...` warn. */
function warnLogger() {
  const warn = vi.fn()
  return { warn, logger: { warn } }
}

function messagesOf(logger: { warn: ReturnType<typeof vi.fn> }): string[] {
  return logger.warn.mock.calls.map((call) => String(call[0]))
}

function chain(overrides: Partial<NamedChain> = {}): NamedChain {
  return { id: 'daily', label: '日常', entries: [OFFICIAL_FLASH], timeSlots: [], ...overrides }
}

function slotRow(overrides: Partial<SlotRowConfig> = {}): SlotRowConfig {
  return { kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_PRO], ...overrides }
}

describe('fallbacks Config schema (named virtual chains)', () => {
  it('resolves the empty section to the spec defaults (no-op invariant)', () => {
    expect(unwrapConfig(Config({} as FallbacksConfig))).toEqual(defaultFallbacksConfig)
  })

  it('layers partial input over the spec defaults', () => {
    const resolved = unwrapConfig(Config({
      cooldownMs: 1_000,
      chains: [{ id: 'daily', label: '日常', entries: [OFFICIAL_FLASH], timeSlots: [] }],
      roles: { list: [{ id: 'reviewer', persona: '', chain: 'daily' }] },
    } as unknown as FallbacksConfig))
    expect(resolved.cooldownMs).toBe(1_000)
    expect(resolved.chains).toEqual([
      { id: 'daily', label: '日常', entries: [OFFICIAL_FLASH], timeSlots: [] },
    ])
    expect(resolved.roles.list).toEqual([{
      id: 'reviewer',
      persona: '',
      // schemastery fills absent object fields with empty defaults —
      // semantically "no permissions", same as absent.
      permissions: { allow: [], deny: [] },
      chain: 'daily',
    }])
    expect('enabled' in resolved).toBe(false)
    expect(resolved.triggerCodes).toEqual(['AUTH', 'QUOTA', 'RATE_LIMIT'])
    expect(isFallbackActive(resolved)).toBe(true)
  })

  it('composed role entities keep string-optional fields absent (prompt, chain)', () => {
    const resolved = unwrapConfig(Config({
      roles: { list: [{ id: 'coder', persona: 'd' }] },
    } as unknown as FallbacksConfig))
    expect(resolved.roles.list[0]).toEqual({
      id: 'coder',
      persona: 'd',
      permissions: { allow: [], deny: [] },
    })
    expect('prompt' in resolved.roles.list[0]).toBe(false)
    expect('chain' in resolved.roles.list[0]).toBe(false)
  })

  it('keeps chain id/label and role id mandatory in the schema', () => {
    expect(() => Config({ chains: [{ label: 'x' }] } as unknown as FallbacksConfig)).toThrow(/id/)
    expect(() => Config({ chains: [{ id: 'x' }] } as unknown as FallbacksConfig)).toThrow(/label/)
    expect(() => Config({ roles: { list: [{ persona: 'x' }] } } as unknown as FallbacksConfig))
      .toThrow(/id/)
  })

  it('defaults the presets switch to bundled', () => {
    const resolved = unwrapConfig(Config({} as FallbacksConfig))
    expect(resolved.presets).toBe('bundled')
  })

  it('rejects a presets value outside the bundled|none union at schema resolve', () => {
    expect(() => Config({ presets: 'sometimes' } as unknown as FallbacksConfig)).toThrow(TypeError)
    expect(() => Config({ presets: 'sometimes' } as unknown as FallbacksConfig)).toThrow(
      /presets expected "bundled" \| "none"/,
    )
  })

  it('rejects a recovery value outside the timer|half-open union at schema resolve', () => {
    expect(() => Config({ recovery: 'sometimes' } as unknown as FallbacksConfig)).toThrow(TypeError)
    expect(() => Config({ recovery: 'sometimes' } as unknown as FallbacksConfig)).toThrow(
      /recovery expected "timer" \| "half-open"/,
    )
  })
})

describe('isFallbackActive (v2 content presence)', () => {
  it('is false for the empty default — empty chains is the only first-run state', () => {
    expect(isFallbackActive(defaultFallbacksConfig)).toBe(false)
  })

  it('is true with one chain, even with empty entries (picker row registers, walk refuses)', () => {
    expect(isFallbackActive({ ...defaultFallbacksConfig, chains: [chain({ entries: [] })] })).toBe(true)
  })

  it('roles alone no longer activate (a role without a chain is pure identity)', () => {
    expect(isFallbackActive({ ...defaultFallbacksConfig, roles: { list: [{ id: 'coder', persona: '' }] } })).toBe(false)
  })
})

describe('validateFallbacksConfig — chain ids (format / case-sensitive uniqueness)', () => {
  it('accepts valid ids (uppercase allowed) and free-text labels without a single warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [
        chain({ id: 'Auto', label: '默认链' }),
        chain({ id: 'a1-B2', label: '任意 label，含特殊字符 !@#' }),
        chain({ id: 'a'.repeat(32) }), // boundary: exactly 32 chars is legal
      ],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on invalid id formats (leading dash, underscore, too long, empty)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [
        chain({ id: '-bad' }),
        chain({ id: 'under_score' }),
        chain({ id: 'x'.repeat(33) }),
        chain({ id: '' }),
      ],
      roles: { list: [] },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(4)
    for (const bad of ['-bad', 'under_score', 'x'.repeat(33)]) {
      expect(messages).toContain(
        `llm-fallbacks: invalid chain id "${bad}" — must match /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/`,
      )
    }
  })

  it('warns on duplicate chain ids (case-sensitive set)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ id: 'daily' }), chain({ id: 'daily', label: '另一条' })],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toContain(
      'llm-fallbacks: duplicate chain id "daily" — chain ids must be unique (case-sensitive)',
    )
  })
})

describe('validateFallbacksConfig — per-chain entries (tail conformance + selector legality)', () => {
  it('warns when a non-empty chain tail is not exactly one official model', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ entries: [OFFICIAL_PRO, 'other/gpt-4o'] })],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([
      `llm-fallbacks: chain "daily" must end with exactly one official model (deepseek-official/deepseek-flash or deepseek-official/deepseek-v4-pro) — its time-slot rows and the virtual picker delegate stay inert until the tail conforms`,
    ])
  })

  it('an empty chain stays quiet (registers the picker row, refuses to delegate)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({ ...defaultFallbacksConfig, chains: [chain({ entries: [] })], roles: { list: [] } }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on invalid entries per chain, naming the chain id', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ entries: ['bogus', OFFICIAL_FLASH] }), chain({ id: 'other', label: 'o', entries: ['provider/', OFFICIAL_PRO] })],
      roles: { list: [] },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toEqual([
      'llm-fallbacks: ignoring invalid chain "daily" entry "bogus": invalid selector "bogus": expected "provider/model" or "provider/*"',
      'llm-fallbacks: ignoring invalid chain "other" entry "provider/": invalid selector "provider/": expected "provider/model" or "provider/*"',
    ])
  })

  it('never throws — every violation is a warn (warn-not-crash semantics)', () => {
    const { logger } = warnLogger()
    expect(() => validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ id: 'bad id', entries: ['garbage'] })],
      roles: { list: [{ id: 'Bad Id', persona: '', chain: 'ghost' }] },
    }, logger)).not.toThrow()
    expect(messagesOf({ warn: logger.warn }).length).toBeGreaterThan(0)
  })
})

describe('validateFallbacksConfig — per-chain slot-row guards', () => {
  it('warns on an unknown preset, naming the chain', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ timeSlots: [slotRow({ preset: 'nope' as SlotRowConfig['preset'] })] })],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([
      'llm-fallbacks: chain "daily" has an unknown time-slot preset "nope" — row ignored',
    ])
  })

  it('warns on a duplicate preset within one chain but not across chains', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [
        chain({ timeSlots: [slotRow(), slotRow()] }),
        chain({ id: 'other', label: 'o', timeSlots: [slotRow()] }),
      ],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([
      'llm-fallbacks: chain "daily" has a duplicate time-slot preset "liang-peak" — only the first row takes effect',
    ])
  })

  it('warns when a preset row carries its own window/day fields', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ timeSlots: [slotRow({ start: '09:00', end: '12:00', days: [1] })] })],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([
      'llm-fallbacks: chain "daily" preset "liang-peak" carries its own window/day fields — preset windows are fixed code constants; the row is ignored',
    ])
  })

  it('accepts custom rows and one preset row per chain without a warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ timeSlots: [slotRow(), slotRow({ kind: 'custom', start: '22:00', end: '06:00', days: [], chain: [OFFICIAL_FLASH] })] })],
      roles: { list: [] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })
})

describe('validateFallbacksConfig — role ids (format / uniqueness / reserved word)', () => {
  it('accepts valid ids and free-text persona without a single warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: {
        list: [
          { id: 'coder', persona: '任意 persona，含特殊字符 !@#', chain: 'daily' },
          { id: 'a1-b2', persona: '' },
        ],
      },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on invalid id formats (uppercase, underscore, too long, empty)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: {
        list: [
          { id: 'Bad-Id', persona: '' },
          { id: 'under_score', persona: '' },
          { id: 'x'.repeat(33), persona: '' },
          { id: '', persona: '' },
          { id: 'a'.repeat(32), persona: '' }, // boundary: exactly 32 chars is legal
        ],
      },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(4)
    for (const bad of ['Bad-Id', 'under_score', 'x'.repeat(33)]) {
      expect(messages).toContain(`llm-fallbacks: invalid role id "${bad}" — must match /^[a-z0-9-]{1,32}$/`)
    }
  })

  it('warns on duplicate role ids and the reserved id "inherit"', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: { list: [{ id: 'coder', persona: '' }, { id: 'coder', persona: '' }, { id: 'inherit', persona: '' }] },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toContain('llm-fallbacks: duplicate role id "coder" — role ids must be unique')
    expect(messages).toContain(
      'llm-fallbacks: role id "inherit" is reserved — "inherit" cannot be declared in roles.list',
    )
  })

  it('trims role ids before validation, matching the client canonical pipeline (qc2 S-3)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: {
        list: [
          { id: ' coder ', persona: '' },
          { id: 'bad id', persona: '' },
        ],
      },
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toContain('llm-fallbacks: invalid role id "bad id" — must match /^[a-z0-9-]{1,32}$/')
    expect(messages).toHaveLength(1)
    expect(messages.some((m) => m.includes('duplicate role id'))).toBe(false)
  })
})

describe('validateFallbacksConfig — role chain POINTER', () => {
  it('accepts a role chain naming a declared chain id without a warn', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: { list: [{ id: 'coder', persona: '', chain: 'daily' }] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns exactly once when the pointer names no declared chain (behaves as NOT SPECIFIED)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: { list: [{ id: 'coder', persona: '', chain: 'ghost' }] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([
      'llm-fallbacks: role "coder" specifies unknown chain "ghost" — the child inherits the delegating agent\'s route',
    ])
  })

  it('absent or empty pointer stays quiet (NOT SPECIFIED)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain()],
      roles: { list: [{ id: 'a', persona: '' }, { id: 'b', persona: '', chain: '' }] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('resolves pointers declared AFTER the referencing role (chain loop first)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      chains: [chain({ id: 'late' })],
      roles: { list: [{ id: 'coder', persona: '', chain: 'late' }] },
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })
})

describe('validateFallbacksConfig — half-open escalation inertness (PR #87 review point 3)', () => {
  it('warns once when recovery is half-open and cooldownMs is at/above the 1h escalation cap', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      recovery: 'half-open',
      cooldownMs: ESCALATION_CAP_MS,
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([
      `llm-fallbacks: recovery "half-open" escalation is inert — cooldownMs (${ESCALATION_CAP_MS} ms) is at or above the 1-hour escalation cap (${ESCALATION_CAP_MS} ms), so every suppression stays flat at cooldownMs`,
    ])
  })

  it('is silent below the cap, and for timer mode at/above the cap', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      recovery: 'half-open',
      cooldownMs: ESCALATION_CAP_MS - 1,
    }, logger)
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      recovery: 'timer',
      cooldownMs: ESCALATION_CAP_MS,
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })
})

describe('detectLegacyKeys — v1 two-block keys + older removals', () => {
  it('returns [] for a clean v2 config', () => {
    expect(detectLegacyKeys({
      triggerCodes: ['AUTH'],
      chains: [{ id: 'Auto', label: '默认链', entries: [OFFICIAL_FLASH] }],
      roles: { list: [{ id: 'coder', persona: '', chain: 'Auto' }] },
    })).toEqual([])
  })

  it('detects the v1 keys: rootChain, top-level timeSlots, roles.rules', () => {
    expect(detectLegacyKeys({
      rootChain: [OFFICIAL_FLASH],
      timeSlots: [],
      roles: { list: [], rules: [{ role: 'coder' }] },
    })).toEqual(['rootChain', 'timeSlots', 'roles.rules'])
  })

  it('detects roles.list[].fallback and the v1 ARRAY form of roles.list[].chain', () => {
    expect(detectLegacyKeys({
      roles: {
        list: [
          { id: 'a', fallback: 'inherit-root', chain: ['other/gpt-4o'] },
          { id: 'b', chain: 'Auto' }, // v2 string pointer — NOT flagged
        ],
      },
    })).toEqual(['roles.list[].fallback', 'roles.list[].chain'])
  })

  it('detects the older removals: alwaysModeRetryCap, roleAutoMatch, roles.default, renamed role fields', () => {
    expect(detectLegacyKeys({
      alwaysModeRetryCap: 5,
      roleAutoMatch: false,
      roles: {
        default: 'reviewer',
        list: [{ id: 'coder', label: 'Coder', description: 'Code review subagent' }],
      },
    })).toEqual([
      'alwaysModeRetryCap',
      'roleAutoMatch',
      'roles.default',
      'roles.list[].label',
      'roles.list[].description',
    ])
  })

  it('collects every class from one legacy source, in field order', () => {
    expect(detectLegacyKeys({
      rootChain: [OFFICIAL_FLASH],
      roles: { default: 'reviewer', list: [{ id: 'a', chain: ['x/y'] }], rules: [] },
    })).toEqual(['rootChain', 'roles.default', 'roles.rules', 'roles.list[].chain'])
  })
})

describe('migrateLegacyConfig (plan fallbacks-v1-auto-migration)', () => {
  /** The LIVE profile shape, with the ids/personas replaced by synthetic ones. */
  const liveShape = () => ({
    triggerCodes: ['QUOTA', 'RATE_LIMIT', 'AUTH'],
    rootChain: ['a/one', 'b/two', 'c/three', 'd/four', OFFICIAL_FLASH],
    timeSlots: [],
    roles: {
      rules: [{ role: 'alpha' }],
      default: 'alpha',
      list: [
        { id: 'alpha', persona: 'Alpha persona', permissions: { allow: [], deny: [] }, chain: ['c/three', 'b/two'], fallback: 'inherit-root' },
        { id: 'beta', persona: 'Beta persona', chain: ['a/one'], fallback: 'inherit-root' },
      ],
    },
  })

  it('turns a v1 rootChain + top-level timeSlots into chain #0 Auto', () => {
    const migrated = migrateLegacyConfig(liveShape())
    expect(migrated.chains).toEqual([{
      id: MIGRATED_CHAIN_ID,
      label: MIGRATED_CHAIN_LABEL,
      entries: ['a/one', 'b/two', 'c/three', 'd/four', OFFICIAL_FLASH],
      timeSlots: [],
    }])
    // The route the user already selected keeps resolving.
    expect(migrated.chains[0]!.id).toBe('Auto')
    expect(migrated.chains[0]!.entries.at(-1)).toBe(OFFICIAL_FLASH)
  })

  it('keeps roles as identity rows and drops their v1 array chain + fallback', () => {
    const migrated = migrateLegacyConfig(liveShape())
    expect(migrated.roles.list).toEqual([
      { id: 'alpha', persona: 'Alpha persona', permissions: { allow: [], deny: [] } },
      { id: 'beta', persona: 'Beta persona' },
    ])
    expect(migrated.roles.list.every(role => role.chain === undefined)).toBe(true)
    expect(migrated.roles.list.some(role => 'fallback' in role)).toBe(false)
  })

  it('drops roles.rules / roles.default / enabled', () => {
    const migrated = migrateLegacyConfig({ ...liveShape(), enabled: false })
    expect('rules' in migrated.roles).toBe(false)
    expect('default' in migrated.roles).toBe(false)
    expect('enabled' in migrated).toBe(false)
  })

  it('is idempotent: a v2 config passes through untouched', () => {
    const v2: FallbacksConfig = {
      ...defaultFallbacksConfig,
      chains: [{ id: 'Auto', label: '默认链', entries: [OFFICIAL_FLASH], timeSlots: [] }],
      roles: { list: [{ id: 'alpha', persona: 'Alpha', chain: 'Auto' }] },
    }
    expect(migrateLegacyConfig(v2)).toEqual(v2)
    // …and migrating the migration changes nothing either.
    expect(migrateLegacyConfig(migrateLegacyConfig(liveShape()))).toEqual(migrateLegacyConfig(liveShape()))
  })

  it('keeps a v2 chains list and only strips the v1 leftovers (mixed shape)', () => {
    const migrated = migrateLegacyConfig({
      ...liveShape(),
      chains: [{ id: 'Coding', label: 'Coding', entries: ['x/1', OFFICIAL_FLASH], timeSlots: [] }],
    })
    expect(migrated.chains.map(chain => chain.id)).toEqual(['Coding'])
    expect(migrated.roles.list.map(role => role.id)).toEqual(['alpha', 'beta'])
    expect(migrated.roles.list.every(role => role.chain === undefined && !('fallback' in role))).toBe(true)
  })

  it('migrates a rootChain even when an EMPTY chains list is present', () => {
    // The boundary the guard protects: a profile that never had v2 content
    // (`chains: []` from the schema default) keeps its v1 chain.
    const migrated = migrateLegacyConfig({
      chains: [],
      rootChain: ['a/one', 'b/two', OFFICIAL_FLASH],
      timeSlots: [],
    })
    expect(migrated.chains).toEqual([{
      id: MIGRATED_CHAIN_ID,
      label: MIGRATED_CHAIN_LABEL,
      entries: ['a/one', 'b/two', OFFICIAL_FLASH],
      timeSlots: [],
    }])
  })

  it('passes every scalar through (it runs on every read)', () => {
    const migrated = migrateLegacyConfig({
      triggerCodes: ['QUOTA', 'CONTEXT_WINDOW_EXCEEDED'],
      cooldownMs: 42_000,
      revertPolicy: 'never',
      maxSwitchesPerStep: 3,
      presets: 'none',
      tz: 'Europe/Berlin',
      recovery: 'half-open',
    })
    expect(migrated.triggerCodes).toEqual(['QUOTA', 'CONTEXT_WINDOW_EXCEEDED'])
    expect(migrated.cooldownMs).toBe(42_000)
    expect(migrated.revertPolicy).toBe('never')
    expect(migrated.maxSwitchesPerStep).toBe(3)
    expect(migrated.presets).toBe('none')
    expect(migrated.tz).toBe('Europe/Berlin')
    expect(migrated.recovery).toBe('half-open')
  })

  it('never throws on malformed input and degrades to the defaults', () => {
    for (const junk of [undefined, null, 'nope', 42, [], { chains: 'nope', roles: 'nope', rootChain: 'nope' }]) {
      const migrated = migrateLegacyConfig(junk)
      expect(migrated.chains).toEqual([])
      expect(migrated.roles).toEqual({ list: [] })
      expect(migrated.triggerCodes).toEqual(defaultFallbacksConfig.triggerCodes)
    }
  })

  it('does not migrate a rootChain when the v2 chains list already has entries', () => {
    const migrated = migrateLegacyConfig({
      chains: [{ id: 'Auto', label: '默认链', entries: [OFFICIAL_FLASH], timeSlots: [] }],
      rootChain: ['a/one', OFFICIAL_FLASH],
    })
    expect(migrated.chains.map(chain => chain.id)).toEqual(['Auto'])
    expect(migrated.chains[0]!.entries).toEqual([OFFICIAL_FLASH])
  })

  it('reports the RAW keys so the banner stays honest while the config is v2', () => {
    const raw = liveShape()
    expect(detectLegacyKeys(raw)).toEqual([
      'rootChain',
      'timeSlots',
      'roles.default',
      'roles.rules',
      'roles.list[].fallback',
      'roles.list[].chain',
    ])
    // …and the MIGRATED object carries none of them.
    expect(detectLegacyKeys(migrateLegacyConfig(raw) as unknown as Record<string, unknown>)).toEqual([])
  })
})
