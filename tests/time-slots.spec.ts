/**
 * Time-slot resolver unit tests (plan fallbacks-timeslots Task 1, pins
 * P4–P6): first-match ordering, custom overnight windows, frozen preset
 * windows (liang-peak = ONE row covering both clocks; glm-peak Mon–Fri;
 * valleys derive from their peaks), all-day-last, the official V4
 * Flash-XOR-Pro all-day guard, preset-row immutability, duplicate-preset
 * rejection, warn-once malformed-row skipping, and the never-throws
 * contract. The resolver warns through `console.warn` (its 3-argument
 * contract has no logger parameter); every warn message is asserted.
 */

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Config } from '../src/schema.ts'
import {
  defaultFallbacksConfig,
  validateFallbacksConfig,
  type FallbacksConfig,
} from '../src/config.ts'
import {
  OFFICIAL_V4_FLASH,
  OFFICIAL_V4_PRO,
  isAllDayConforming,
  resolveEffectiveChain,
  resolveSlotState,
  type PresetId,
  type SlotRowConfig,
} from '../src/time-slots.ts'

const ALL_DAY = OFFICIAL_V4_FLASH

/** Spy on the resolver's warn channel and collect messages. */
function spyWarn(): MockInstance {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

function warnMessages(warn: MockInstance): string[] {
  return warn.mock.calls.map((call) => String(call[0]))
}

/** `hh:mm` (UTC+8 wall clock) on 2026-08-18 (a Tuesday) unless dated. */
function at(hhmm: string, date = '2026-08-18'): Date {
  return new Date(`${date}T${hhmm}:00+08:00`)
}

function slotConfig(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return { ...defaultFallbacksConfig, rootChain: [ALL_DAY], ...overrides }
}

function custom(start: string, end: string, chain: string[], days?: number[]): SlotRowConfig {
  return days === undefined
    ? { kind: 'custom', start, end, chain }
    : { kind: 'custom', start, end, days, chain }
}

function presetRow(id: PresetId, chain: string[], extra: Partial<SlotRowConfig> = {}): SlotRowConfig {
  return { kind: 'preset', preset: id, chain, ...extra }
}

function warnLogger() {
  const warn = vi.fn()
  return { warn, logger: { warn } }
}

function messagesOf(logger: { warn: MockInstance }): string[] {
  return logger.warn.mock.calls.map((call) => String(call[0]))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveEffectiveChain — first matching row wins (stored order)', () => {
  it('returns the chain of the first row whose window contains now', () => {
    const cfg = slotConfig({
      timeSlots: [
        custom('06:00', '08:00', ['openai/gpt-4o']),
        custom('07:00', '09:00', ['anthropic/claude-3-5-sonnet']),
      ],
    })
    // 07:30 sits inside BOTH windows — the first stored row wins.
    expect(resolveEffectiveChain(cfg, at('07:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
  })

  it('the winning row REPLACES the all-day chain (no concatenation)', () => {
    const cfg = slotConfig({
      rootChain: [ALL_DAY],
      timeSlots: [custom('09:00', '10:00', ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'])],
    })
    expect(resolveEffectiveChain(cfg, at('09:30'), 'Asia/Shanghai')).toEqual([
      'openai/gpt-4o',
      'anthropic/claude-3-5-sonnet',
    ])
  })
})

describe('resolveEffectiveChain — custom overnight wrap (start > end)', () => {
  const cfg = slotConfig({ timeSlots: [custom('22:00', '02:00', ['openai/gpt-4o'])] })

  it('matches after midnight (wrap)', () => {
    expect(resolveEffectiveChain(cfg, at('23:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(cfg, at('01:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
  })

  it('does not match before start or at/after end (end exclusive)', () => {
    expect(resolveEffectiveChain(cfg, at('21:59'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(cfg, at('02:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })
})

describe('resolveEffectiveChain — glm-peak is Monday–Friday 14:00–18:00 only', () => {
  const cfg = slotConfig({ timeSlots: [presetRow('glm-peak', ['openai/gpt-4o'])] })

  it('matches Mon–Fri inside the window', () => {
    // 2026-08-18 = Tue, 2026-08-21 = Fri, 2026-08-24 = Mon.
    expect(resolveEffectiveChain(cfg, at('15:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-21'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-24'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
  })

  it('does not match weekends, the exclusive end, or before start', () => {
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-22'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sat
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-23'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sun
    expect(resolveEffectiveChain(cfg, at('18:00'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // end exclusive
    expect(resolveEffectiveChain(cfg, at('13:59'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // before start
  })
})

describe('resolveEffectiveChain — valley complements derive from their peak', () => {
  it('liang-valley matches every time liang-peak does not, including weekends', () => {
    const cfg = slotConfig({ timeSlots: [presetRow('liang-valley', ['openai/gpt-4o'])] })
    // Liang peak is Mon–Fri only, so weekend peak-hours are valley too.
    expect(resolveEffectiveChain(cfg, at('10:30', '2026-08-22'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    // …and a weekend off-peak time IS valley.
    expect(resolveEffectiveChain(cfg, at('20:00', '2026-08-22'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    // Weekday off-peak: the 12:00–14:00 gap and the night.
    expect(resolveEffectiveChain(cfg, at('13:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(cfg, at('21:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    // Weekday peak times themselves are excluded.
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })

  it('glm-valley matches weekends (glm-peak is Mon–Fri only)', () => {
    const cfg = slotConfig({ timeSlots: [presetRow('glm-valley', ['openai/gpt-4o'])] })
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-22'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o']) // Sat
    expect(resolveEffectiveChain(cfg, at('15:00'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Tue = peak
  })
})

describe('resolveEffectiveChain — all-day last', () => {
  it('falls back to rootChain when no extra row matches', () => {
    const cfg = slotConfig({
      rootChain: [OFFICIAL_V4_PRO],
      timeSlots: [custom('06:00', '07:00', ['openai/gpt-4o'])],
    })
    expect(resolveEffectiveChain(cfg, at('12:00'), 'Asia/Shanghai')).toEqual([OFFICIAL_V4_PRO])
  })
})

describe('isAllDayConforming — official V4 Flash XOR Pro tail', () => {
  it('accepts an official V4 tail, with or without leading fallback entries', () => {
    expect(isAllDayConforming([OFFICIAL_V4_FLASH])).toBe(true)
    expect(isAllDayConforming([OFFICIAL_V4_PRO])).toBe(true)
    expect(isAllDayConforming(['openai/gpt-4o', OFFICIAL_V4_FLASH])).toBe(true)
    expect(isAllDayConforming(['openai/gpt-4o', OFFICIAL_V4_FLASH, OFFICIAL_V4_PRO])).toBe(true)
  })

  it('rejects empty chains and chains whose last entry is not an official V4 model', () => {
    expect(isAllDayConforming([])).toBe(false)
    expect(isAllDayConforming(['openai/gpt-4o'])).toBe(false)
    expect(isAllDayConforming(['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'])).toBe(false)
    expect(isAllDayConforming(['deepseek-official/deepseek-v4-ultra'])).toBe(false)
    expect(isAllDayConforming([OFFICIAL_V4_FLASH, 'openai/gpt-4o'])).toBe(false)
  })
})

describe('preset rows — windows are fixed code constants (P4)', () => {
  it('skips a preset row carrying its own window fields, warn exactly once', () => {
    const warn = spyWarn()
    const dirty = presetRow('liang-peak', ['openai/gpt-4o'], { start: '10:00', end: '11:00' })
    const cfg = slotConfig({ timeSlots: [dirty] })
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    const messages = warnMessages(warn)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('preset windows are fixed')
  })

  it('skips a preset row carrying a day mask, with a warn', () => {
    const warn = spyWarn()
    const cfg = slotConfig({ timeSlots: [presetRow('liang-peak', ['openai/gpt-4o'], { days: [1, 2, 3] })] })
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('resolveEffectiveChain — liang-peak is ONE row covering both windows', () => {
  // The stored row carries NO windows — both clocks live in PRESETS.
  const cfg = slotConfig({ timeSlots: [presetRow('liang-peak', [OFFICIAL_V4_PRO])] })

  it('matches 09:00–12:00', () => {
    expect(resolveEffectiveChain(cfg, at('09:00'), 'Asia/Shanghai')).toEqual([OFFICIAL_V4_PRO])
    expect(resolveEffectiveChain(cfg, at('11:59'), 'Asia/Shanghai')).toEqual([OFFICIAL_V4_PRO])
  })

  it('matches 14:00–18:00', () => {
    expect(resolveEffectiveChain(cfg, at('14:00'), 'Asia/Shanghai')).toEqual([OFFICIAL_V4_PRO])
    expect(resolveEffectiveChain(cfg, at('17:59'), 'Asia/Shanghai')).toEqual([OFFICIAL_V4_PRO])
  })

  it('does not match the gaps (12:00–13:59) or the exclusive ends', () => {
    expect(resolveEffectiveChain(cfg, at('12:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(cfg, at('13:59'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(cfg, at('18:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })

  it('does not match weekends (day mask is Monday–Friday only)', () => {
    expect(resolveEffectiveChain(cfg, at('10:30', '2026-08-22'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sat
    expect(resolveEffectiveChain(cfg, at('10:30', '2026-08-23'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sun
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-22'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sat
    expect(resolveEffectiveChain(cfg, at('15:00', '2026-08-23'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sun
  })
})

describe('duplicate preset rows (P4 guard)', () => {
  it('the first occurrence wins; a reached duplicate is skipped with one warn', () => {
    const warn = spyWarn()
    const first = presetRow('liang-peak', ['openai/gpt-4o'])
    const second = presetRow('liang-peak', [OFFICIAL_V4_PRO])
    const cfg = slotConfig({ timeSlots: [first, second] })
    // At peak time the FIRST row wins outright — the duplicate is never
    // reached, so no resolver warn (the load-time validator still warns).
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(warn).not.toHaveBeenCalled()
    // Off-peak: iteration passes the non-matching first row and reaches the
    // duplicate → skipped with exactly one warn; all-day stays last.
    expect(resolveEffectiveChain(cfg, at('13:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    const messages = warnMessages(warn)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('duplicate preset "liang-peak"')
    // Same config object → still exactly one warn.
    expect(resolveEffectiveChain(cfg, at('13:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)).toHaveLength(1)
  })
})

describe('malformed rows — skipped with warn, resolver never throws', () => {
  it('skips custom rows with a bad HH:mm window', () => {
    const warn = spyWarn()
    const cfg = slotConfig({
      timeSlots: [
        custom('9:00', '10:00', ['openai/gpt-4o']), // no leading zero
        custom('25:00', '26:00', ['openai/gpt-4o']), // hours out of range
        custom('09:00', '09:60', ['openai/gpt-4o']), // minutes out of range
      ],
    })
    expect(resolveEffectiveChain(cfg, at('09:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('skips rows with an empty chain', () => {
    const warn = spyWarn()
    const cfg = slotConfig({ timeSlots: [custom('09:00', '10:00', [])] })
    expect(resolveEffectiveChain(cfg, at('09:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)[0]).toContain('empty chain')
  })

  it('skips rows with an unknown preset id', () => {
    const warn = spyWarn()
    const cfg = slotConfig({
      timeSlots: [{ kind: 'preset', preset: 'bogus-peak', chain: ['openai/gpt-4o'] }],
    })
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)[0]).toContain('unknown preset')
  })

  it('skips rows with an unknown kind', () => {
    const warn = spyWarn()
    const cfg = slotConfig({ timeSlots: [{ kind: 'hybrid', chain: ['openai/gpt-4o'] }] })
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)[0]).toContain('unknown kind')
  })

  it('never throws — garbage rows, non-array timeSlots, and invalid tz resolve to rootChain', () => {
    const warn = spyWarn()
    const cfg = slotConfig({ timeSlots: 'garbage' as unknown as SlotRowConfig[] })
    expect(() => resolveEffectiveChain(cfg, at('10:30'), 'Mars/Olympus')).not.toThrow()
    expect(resolveEffectiveChain(cfg, at('10:30'), 'Mars/Olympus')).toEqual([ALL_DAY])
    const tzWarns = warnMessages(warn).filter((message) => message.includes('invalid timezone'))
    expect(tzWarns).toHaveLength(1)
    expect(tzWarns[0]).toContain('Mars/Olympus')
  })
})

describe('warn-once contract (P5: malformed rows warn once and are skipped)', () => {
  it('warns exactly once per malformed row object across calls', () => {
    const warn = spyWarn()
    const bad = custom('oops', '10:00', ['openai/gpt-4o'])
    const cfg = slotConfig({ timeSlots: [bad] })
    resolveEffectiveChain(cfg, at('09:30'), 'Asia/Shanghai')
    resolveEffectiveChain(cfg, at('09:30'), 'Asia/Shanghai')
    expect(warnMessages(warn)).toHaveLength(1)
  })

  it('a fresh row object warns again (per-instance, not per-shape)', () => {
    const warn = spyWarn()
    resolveEffectiveChain(slotConfig({ timeSlots: [custom('oops', '10:00', ['openai/gpt-4o'])] }), at('09:30'), 'Asia/Shanghai')
    resolveEffectiveChain(slotConfig({ timeSlots: [custom('oops', '10:00', ['openai/gpt-4o'])] }), at('09:30'), 'Asia/Shanghai')
    expect(warnMessages(warn)).toHaveLength(2)
  })
})

describe('resolveSlotState — winner + label for the status strip (P5)', () => {
  it('reports the all-day row when nothing matches', () => {
    const cfg = slotConfig({ rootChain: [OFFICIAL_V4_PRO], timeSlots: [custom('06:00', '07:00', ['openai/gpt-4o'])] })
    expect(resolveSlotState(cfg, at('12:00'), 'Asia/Shanghai')).toEqual({ winner: 'all-day', label: 'all-day' })
  })

  it('labels a custom winner with its window', () => {
    const row = custom('09:00', '12:00', ['openai/gpt-4o'])
    const cfg = slotConfig({ timeSlots: [row] })
    expect(resolveSlotState(cfg, at('10:00'), 'Asia/Shanghai')).toEqual({ winner: row, label: 'custom 09:00-12:00' })
  })

  it('labels a preset winner with the frozen display label', () => {
    const row = presetRow('glm-peak', ['openai/gpt-4o'])
    const cfg = slotConfig({ timeSlots: [row] })
    expect(resolveSlotState(cfg, at('15:00'), 'Asia/Shanghai')).toEqual({ winner: row, label: 'GLM Peak' })
  })
})

describe('resolveEffectiveChain — tz interpreted with Intl rules', () => {
  // 2026-08-18T02:00:00Z = Tue 10:00 in Asia/Shanghai, Mon 22:00 in
  // America/New_York (EDT, UTC−4).
  const instant = new Date('2026-08-18T02:00:00Z')

  it('matches the same instant in the configured timezone only', () => {
    const cfg = slotConfig({ timeSlots: [custom('09:00', '12:00', ['openai/gpt-4o'])] })
    expect(resolveEffectiveChain(cfg, instant, 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(cfg, instant, 'America/New_York')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(cfg, instant, 'UTC')).toEqual([ALL_DAY])
  })

  it('a custom overnight window follows the timezone too', () => {
    const cfg = slotConfig({ timeSlots: [custom('21:00', '23:00', ['openai/gpt-4o'])] })
    expect(resolveEffectiveChain(cfg, instant, 'America/New_York')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(cfg, instant, 'Asia/Shanghai')).toEqual([ALL_DAY])
  })
})

describe('config schema — timeSlots and tz (P5)', () => {
  it('defaults timeSlots to [] and tz to Asia/Shanghai', () => {
    const resolved = Config({} as FallbacksConfig)
    expect(resolved.timeSlots).toEqual([])
    expect(resolved.tz).toBe('Asia/Shanghai')
    expect(Config({} as FallbacksConfig)).toEqual(defaultFallbacksConfig)
  })

  it('composes row shapes; absent array fields become empty defaults', () => {
    const resolved = Config({
      timeSlots: [{ kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_V4_FLASH] }],
    } as unknown as FallbacksConfig)
    const row = resolved.timeSlots[0]
    expect(row.kind).toBe('preset')
    expect(row.preset).toBe('liang-peak')
    expect(row.chain).toEqual([OFFICIAL_V4_FLASH])
    // schemastery fills absent array fields with [] — the resolver reads
    // []/absent days as "all days", so a composed preset row is NOT dirty.
    expect(row.days).toEqual([])
  })

  it('round-trips an explicit tz', () => {
    expect(Config({ tz: 'UTC' } as unknown as FallbacksConfig).tz).toBe('UTC')
  })

  it('defaultFallbacksConfig carries timeSlots: [] and tz: Asia/Shanghai', () => {
    expect(defaultFallbacksConfig.timeSlots).toEqual([])
    expect(defaultFallbacksConfig.tz).toBe('Asia/Shanghai')
  })

  it('a FallbacksConfig literal without timeSlots/tz still type-checks (optional-on-type)', () => {
    const minimal: FallbacksConfig = {
      enabled: false,
      triggerCodes: ['AUTH', 'QUOTA', 'RATE_LIMIT'],
      rootChain: [],
      roles: { list: [], rules: [] },
      cooldownMs: 300_000,
      revertPolicy: 'cooldown-expiry',
      maxSwitchesPerStep: 8,
      alwaysModeRetryCap: 5,
    }
    expect(minimal.timeSlots).toBeUndefined()
    expect(minimal.tz).toBeUndefined()
  })
})

describe('validateFallbacksConfig — time-slot guards (P4/P6)', () => {
  it('warns once for a non-conforming non-empty all-day chain (P6)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'],
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('rootChain must end with exactly one official V4 model')
  })

  it('does not warn for a conforming all-day chain or the empty default', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({ ...defaultFallbacksConfig, rootChain: [OFFICIAL_V4_FLASH] }, logger)
    validateFallbacksConfig(defaultFallbacksConfig, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })

  it('warns on duplicate preset rows (P4)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: [ALL_DAY],
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_V4_FLASH] },
        { kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_V4_PRO] },
      ],
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('duplicate time-slot preset "liang-peak"')
  })

  it('warns on an unknown preset id (P4)', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: [ALL_DAY],
      timeSlots: [{ kind: 'preset', preset: 'bogus', chain: [ALL_DAY] }],
    }, logger)
    expect(messagesOf({ warn: logger.warn })[0]).toContain('unknown time-slot preset')
  })

  it('warns when a preset row carries its own window/day fields', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: [ALL_DAY],
      timeSlots: [
        { kind: 'preset', preset: 'glm-peak', start: '09:00', end: '10:00', chain: [ALL_DAY] },
        { kind: 'preset', preset: 'glm-valley', days: [1], chain: [ALL_DAY] },
      ],
    }, logger)
    const messages = messagesOf({ warn: logger.warn })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('preset windows are fixed')
    expect(messages[1]).toContain('preset windows are fixed')
  })

  it('does not warn for a valid custom row or a clean preset row', () => {
    const { logger } = warnLogger()
    validateFallbacksConfig({
      ...defaultFallbacksConfig,
      rootChain: [ALL_DAY],
      timeSlots: [
        { kind: 'custom', start: '09:00', end: '10:00', days: [1, 2, 3], chain: ['openai/gpt-4o'] },
        { kind: 'preset', preset: 'liang-peak', chain: [ALL_DAY] },
      ],
    }, logger)
    expect(messagesOf({ warn: logger.warn })).toEqual([])
  })
})
