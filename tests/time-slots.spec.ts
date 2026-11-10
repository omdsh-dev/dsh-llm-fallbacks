/**
 * Time-slot resolver unit tests (per named chain, plan named-virtual-chains
 * T2): first-match ordering, custom overnight windows, frozen preset windows,
 * all-day-last (the chain's own `entries`), the official Flash / Pro tail
 * conformance gate, preset-row immutability, duplicate-preset rejection,
 * warn-once malformed-row skipping, per-chain isolation, and the
 * never-throws contract. The resolver warns through `console.warn` (its
 * 3-argument contract has no logger parameter); every warn message is
 * asserted. Validator-level slot guards live in `tests/config.spec.ts`.
 */

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Config } from '../src/schema.ts'
import { unwrapConfig } from './support/unwrap-config.ts'
import {
  OFFICIAL_ACCOUNT_FLASH,
  OFFICIAL_ALL_DAY_IDS,
  OFFICIAL_FLASH,
  OFFICIAL_PRO,
  isAllDayConforming,
  resolveEffectiveChain,
  resolveSlotState,
  type PresetId,
  type SlotRowConfig,
} from '../src/time-slots.ts'
import type { FallbacksConfig, NamedChain } from '../src/config.ts'

const ALL_DAY = OFFICIAL_FLASH

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

/** A named chain with a conforming all-day tail by default. */
function chainOf(overrides: Partial<NamedChain> = {}): NamedChain {
  return { id: 'daily', label: '日常', entries: [ALL_DAY], timeSlots: [], ...overrides }
}

function custom(start: string, end: string, chain: string[], days?: number[]): SlotRowConfig {
  return days === undefined
    ? { kind: 'custom', start, end, chain }
    : { kind: 'custom', start, end, days, chain }
}

function presetRow(id: PresetId, chain: string[], extra: Partial<SlotRowConfig> = {}): SlotRowConfig {
  return { kind: 'preset', preset: id, chain, ...extra }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveEffectiveChain — first matching row wins (stored order)', () => {
  it('returns the chain of the first row whose window contains now', () => {
    const chain = chainOf({
      timeSlots: [
        custom('06:00', '08:00', ['openai/gpt-4o']),
        custom('07:00', '09:00', ['anthropic/claude-3-5-sonnet']),
      ],
    })
    // 07:30 sits inside BOTH windows — the first stored row wins.
    expect(resolveEffectiveChain(chain, at('07:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
  })

  it('the winning row REPLACES the chain entries (no concatenation)', () => {
    const chain = chainOf({
      timeSlots: [custom('09:00', '10:00', ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'])],
    })
    expect(resolveEffectiveChain(chain, at('09:30'), 'Asia/Shanghai')).toEqual([
      'openai/gpt-4o',
      'anthropic/claude-3-5-sonnet',
    ])
  })

  it('slot rows replace entries per chain only — other chains are unaffected', () => {
    const scoped = chainOf({ id: 'scoped', timeSlots: [custom('09:00', '10:00', ['openai/gpt-4o'])] })
    const other = chainOf({ id: 'other', timeSlots: [custom('09:00', '10:00', ['b/2'])] })
    // Same instant: each chain resolves against its OWN rows/entries only.
    expect(resolveEffectiveChain(scoped, at('09:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(other, at('09:30'), 'Asia/Shanghai')).toEqual(['b/2'])
    expect(resolveEffectiveChain(chainOf(), at('09:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })
})

describe('resolveEffectiveChain — custom overnight wrap (start > end)', () => {
  const chain = chainOf({ timeSlots: [custom('22:00', '02:00', ['openai/gpt-4o'])] })

  it('matches after midnight (wrap)', () => {
    expect(resolveEffectiveChain(chain, at('23:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(chain, at('01:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
  })

  it('does not match before start or at/after end (end exclusive)', () => {
    expect(resolveEffectiveChain(chain, at('21:59'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(chain, at('02:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })
})

describe('resolveEffectiveChain — glm-peak is Monday–Friday 14:00–18:00 only', () => {
  const chain = chainOf({ timeSlots: [presetRow('glm-peak', ['openai/gpt-4o'])] })

  it('matches Mon–Fri inside the window', () => {
    // 2026-08-18 = Tue, 2026-08-21 = Fri, 2026-08-24 = Mon.
    expect(resolveEffectiveChain(chain, at('15:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-21'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-24'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
  })

  it('does not match weekends, the exclusive end, or before start', () => {
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-22'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sat
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-23'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sun
    expect(resolveEffectiveChain(chain, at('18:00'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // end exclusive
    expect(resolveEffectiveChain(chain, at('13:59'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // before start
  })
})

describe('resolveEffectiveChain — valley complements derive from their peak', () => {
  it('liang-valley matches every time liang-peak does not, including weekends', () => {
    const chain = chainOf({ timeSlots: [presetRow('liang-valley', ['openai/gpt-4o'])] })
    // Liang peak is Mon–Fri only, so weekend peak-hours are valley too.
    expect(resolveEffectiveChain(chain, at('10:30', '2026-08-22'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    // …and a weekend off-peak time IS valley.
    expect(resolveEffectiveChain(chain, at('20:00', '2026-08-22'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    // Weekday off-peak: the 12:00–14:00 gap and the night.
    expect(resolveEffectiveChain(chain, at('13:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(chain, at('21:00'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    // Weekday peak times themselves are excluded.
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })

  it('glm-valley matches weekends (glm-peak is Mon–Fri only)', () => {
    const chain = chainOf({ timeSlots: [presetRow('glm-valley', ['openai/gpt-4o'])] })
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-22'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o']) // Sat
    expect(resolveEffectiveChain(chain, at('15:00'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Tue = peak
  })
})

describe('resolveEffectiveChain — all-day last', () => {
  it('falls back to the chain entries when no extra row matches', () => {
    const chain = chainOf({
      entries: [OFFICIAL_PRO],
      timeSlots: [custom('06:00', '07:00', ['openai/gpt-4o'])],
    })
    expect(resolveEffectiveChain(chain, at('12:00'), 'Asia/Shanghai')).toEqual([OFFICIAL_PRO])
  })
})

describe('isAllDayConforming — the four legal official tails', () => {
  it('exposes the ids in card order: the account pair first', () => {
    expect(OFFICIAL_ALL_DAY_IDS).toEqual([
      'deepseek-account/deepseek-flash',
      'deepseek-account/deepseek-v4-pro',
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
    ])
  })

  it('accepts each of the four ids alone as the last entry', () => {
    for (const id of OFFICIAL_ALL_DAY_IDS) {
      expect(isAllDayConforming([id])).toBe(true)
      expect(isAllDayConforming(['openai/gpt-4o', id])).toBe(true)
    }
  })

  it('accepts a suffixed tail: a pinned reasoning effort leaves the route official', () => {
    // `provider/model@effort` (Task 1 grammar) pins the HOP, not the route —
    // the tail is still one official model.
    expect(isAllDayConforming([`${OFFICIAL_FLASH}@high`])).toBe(true)
    expect(isAllDayConforming([`${OFFICIAL_ACCOUNT_FLASH}@max`])).toBe(true)
    expect(isAllDayConforming(['openai/gpt-4o', `${OFFICIAL_PRO}@low`])).toBe(true)
    // A pinned NON-official tail still refuses.
    expect(isAllDayConforming(['openai/gpt-4o@high'])).toBe(false)
  })

  it('accepts an official tail, with or without leading fallback entries', () => {
    expect(isAllDayConforming([OFFICIAL_FLASH])).toBe(true)
    expect(isAllDayConforming([OFFICIAL_PRO])).toBe(true)
    // OFFICIAL_PRO verbatim: the 0.1.7-rc.1 catalog id.
    expect(isAllDayConforming(['deepseek-official/deepseek-v4-pro'])).toBe(true)
    expect(isAllDayConforming(['openai/gpt-4o', OFFICIAL_FLASH])).toBe(true)
    expect(isAllDayConforming(['openai/gpt-4o', OFFICIAL_PRO])).toBe(true)
    expect(isAllDayConforming(['openai/gpt-4o', OFFICIAL_FLASH, OFFICIAL_PRO])).toBe(true)
  })

  it('rejects empty chains, non-official tails, and the retired v4-flash', () => {
    expect(isAllDayConforming([])).toBe(false)
    expect(isAllDayConforming(['openai/gpt-4o'])).toBe(false)
    expect(isAllDayConforming(['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'])).toBe(false)
    expect(isAllDayConforming(['deepseek-official/deepseek-v4-flash'])).toBe(false)
    expect(isAllDayConforming(['deepseek-official/deepseek-v4-ultra'])).toBe(false)
    // Tail-position rule: an official id in a non-tail position with a
    // non-official tail is still non-conforming (XOR is about the tail).
    expect(isAllDayConforming([OFFICIAL_FLASH, 'openai/gpt-4o'])).toBe(false)
    expect(isAllDayConforming([OFFICIAL_PRO, 'openai/gpt-4o'])).toBe(false)
    expect(isAllDayConforming(['deepseek-official/deepseek-v4-flash', 'openai/gpt-4o'])).toBe(false)
  })
})

describe('preset rows — windows are fixed code constants', () => {
  it('skips a preset row carrying its own window fields, warn exactly once', () => {
    const warn = spyWarn()
    const dirty = presetRow('liang-peak', ['openai/gpt-4o'], { start: '10:00', end: '11:00' })
    const chain = chainOf({ timeSlots: [dirty] })
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    const messages = warnMessages(warn)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('preset windows are fixed')
  })

  it('skips a preset row carrying a day mask, with a warn', () => {
    const warn = spyWarn()
    const chain = chainOf({ timeSlots: [presetRow('liang-peak', ['openai/gpt-4o'], { days: [1, 2, 3] })] })
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('resolveEffectiveChain — liang-peak is ONE row covering both windows', () => {
  // The stored row carries NO windows — both clocks live in PRESETS.
  const chain = chainOf({ timeSlots: [presetRow('liang-peak', [OFFICIAL_PRO])] })

  it('matches 09:00–12:00', () => {
    expect(resolveEffectiveChain(chain, at('09:00'), 'Asia/Shanghai')).toEqual([OFFICIAL_PRO])
    expect(resolveEffectiveChain(chain, at('11:59'), 'Asia/Shanghai')).toEqual([OFFICIAL_PRO])
  })

  it('matches 14:00–18:00', () => {
    expect(resolveEffectiveChain(chain, at('14:00'), 'Asia/Shanghai')).toEqual([OFFICIAL_PRO])
    expect(resolveEffectiveChain(chain, at('17:59'), 'Asia/Shanghai')).toEqual([OFFICIAL_PRO])
  })

  it('does not match the gaps (12:00–13:59) or the exclusive ends', () => {
    expect(resolveEffectiveChain(chain, at('12:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(chain, at('13:59'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(chain, at('18:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
  })

  it('does not match weekends (day mask is Monday–Friday only)', () => {
    expect(resolveEffectiveChain(chain, at('10:30', '2026-08-22'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sat
    expect(resolveEffectiveChain(chain, at('10:30', '2026-08-23'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sun
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-22'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sat
    expect(resolveEffectiveChain(chain, at('15:00', '2026-08-23'), 'Asia/Shanghai')).toEqual([ALL_DAY]) // Sun
  })
})

describe('duplicate preset rows (per chain)', () => {
  it('the first occurrence wins; a reached duplicate is skipped with one warn', () => {
    const warn = spyWarn()
    const first = presetRow('liang-peak', ['openai/gpt-4o'])
    const second = presetRow('liang-peak', [OFFICIAL_PRO])
    const chain = chainOf({ timeSlots: [first, second] })
    // At peak time the FIRST row wins outright — the duplicate is never
    // reached, so no resolver warn (the load-time validator still warns).
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(warn).not.toHaveBeenCalled()
    // Off-peak: iteration passes the non-matching first row and reaches the
    // duplicate → skipped with exactly one warn; all-day stays last.
    expect(resolveEffectiveChain(chain, at('13:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    const messages = warnMessages(warn)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('duplicate preset "liang-peak"')
    // Same config object → still exactly one warn.
    expect(resolveEffectiveChain(chain, at('13:00'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)).toHaveLength(1)
  })

  it('the same preset on DIFFERENT chains is not a duplicate', () => {
    const warn = spyWarn()
    const a = chainOf({ id: 'a', timeSlots: [presetRow('liang-peak', [OFFICIAL_PRO])] })
    const b = chainOf({ id: 'b', timeSlots: [presetRow('liang-peak', [OFFICIAL_FLASH])] })
    expect(resolveEffectiveChain(a, at('10:30'), 'Asia/Shanghai')).toEqual([OFFICIAL_PRO])
    expect(resolveEffectiveChain(b, at('10:30'), 'Asia/Shanghai')).toEqual([OFFICIAL_FLASH])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('malformed rows — skipped with warn, resolver never throws', () => {
  it('skips custom rows with a bad HH:mm window', () => {
    const warn = spyWarn()
    const chain = chainOf({
      timeSlots: [
        custom('9:00', '10:00', ['openai/gpt-4o']), // no leading zero
        custom('25:00', '26:00', ['openai/gpt-4o']), // hours out of range
        custom('09:00', '09:60', ['openai/gpt-4o']), // minutes out of range
      ],
    })
    expect(resolveEffectiveChain(chain, at('09:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('skips rows with an empty chain', () => {
    const warn = spyWarn()
    const chain = chainOf({ timeSlots: [custom('09:00', '10:00', [])] })
    expect(resolveEffectiveChain(chain, at('09:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)[0]).toContain('empty chain')
  })

  it('skips rows with an unknown preset id', () => {
    const warn = spyWarn()
    const chain = chainOf({
      timeSlots: [{ kind: 'preset', preset: 'bogus-peak', chain: ['openai/gpt-4o'] }],
    })
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)[0]).toContain('unknown preset')
  })

  it('skips rows with an unknown kind', () => {
    const warn = spyWarn()
    const chain = chainOf({ timeSlots: [{ kind: 'hybrid', chain: ['openai/gpt-4o'] }] })
    expect(resolveEffectiveChain(chain, at('10:30'), 'Asia/Shanghai')).toEqual([ALL_DAY])
    expect(warnMessages(warn)[0]).toContain('unknown kind')
  })

  it('never throws — garbage rows and invalid tz resolve to the chain entries', () => {
    const warn = spyWarn()
    const chain = chainOf({ timeSlots: 'garbage' as unknown as SlotRowConfig[] })
    expect(() => resolveEffectiveChain(chain, at('10:30'), 'Mars/Olympus')).not.toThrow()
    expect(resolveEffectiveChain(chain, at('10:30'), 'Mars/Olympus')).toEqual([ALL_DAY])
    const tzWarns = warnMessages(warn).filter((message) => message.includes('invalid timezone'))
    expect(tzWarns).toHaveLength(1)
    expect(tzWarns[0]).toContain('Mars/Olympus')
  })
})

describe('warn-once contract (malformed rows warn once and are skipped)', () => {
  it('warns exactly once per malformed row object across calls', () => {
    const warn = spyWarn()
    const bad = custom('oops', '10:00', ['openai/gpt-4o'])
    const chain = chainOf({ timeSlots: [bad] })
    resolveEffectiveChain(chain, at('09:30'), 'Asia/Shanghai')
    resolveEffectiveChain(chain, at('09:30'), 'Asia/Shanghai')
    expect(warnMessages(warn)).toHaveLength(1)
  })

  it('a fresh row object warns again (per-instance, not per-shape)', () => {
    const warn = spyWarn()
    resolveEffectiveChain(chainOf({ timeSlots: [custom('oops', '10:00', ['openai/gpt-4o'])] }), at('09:30'), 'Asia/Shanghai')
    resolveEffectiveChain(chainOf({ timeSlots: [custom('oops', '10:00', ['openai/gpt-4o'])] }), at('09:30'), 'Asia/Shanghai')
    expect(warnMessages(warn)).toHaveLength(2)
  })
})

describe('resolveSlotState — winner + label for the status strip', () => {
  it('reports the all-day row when nothing matches', () => {
    const chain = chainOf({ entries: [OFFICIAL_PRO], timeSlots: [custom('06:00', '07:00', ['openai/gpt-4o'])] })
    expect(resolveSlotState(chain, at('12:00'), 'Asia/Shanghai')).toEqual({ winner: 'all-day', label: 'all-day' })
  })

  it('labels a custom winner with its window', () => {
    const row = custom('09:00', '12:00', ['openai/gpt-4o'])
    const chain = chainOf({ timeSlots: [row] })
    expect(resolveSlotState(chain, at('10:00'), 'Asia/Shanghai')).toEqual({ winner: row, label: 'custom 09:00-12:00' })
  })

  it('labels a preset winner with the frozen display label', () => {
    const row = presetRow('glm-peak', ['openai/gpt-4o'])
    const chain = chainOf({ timeSlots: [row] })
    expect(resolveSlotState(chain, at('15:00'), 'Asia/Shanghai')).toEqual({ winner: row, label: 'GLM Peak' })
  })

  it('keeps slot rows inert when the entries tail is not an official model', () => {
    const row = custom('09:00', '12:00', ['openai/gpt-4o'])
    const chain = chainOf({ entries: ['openai/gpt-4o'], timeSlots: [row] })
    expect(resolveSlotState(chain, at('10:00'), 'Asia/Shanghai')).toEqual({ winner: 'all-day', label: 'all-day' })
  })

  it('treats the Flash tail as conforming: a matching slot row wins', () => {
    const row = custom('09:00', '12:00', ['openai/gpt-4o'])
    const chain = chainOf({ entries: [OFFICIAL_FLASH], timeSlots: [row] })
    expect(resolveSlotState(chain, at('10:00'), 'Asia/Shanghai')).toEqual({ winner: row, label: 'custom 09:00-12:00' })
  })
})

describe('resolveEffectiveChain — tz interpreted with Intl rules', () => {
  // 2026-08-18T02:00:00Z = Tue 10:00 in Asia/Shanghai, Mon 22:00 in
  // America/New_York (EDT, UTC−4).
  const instant = new Date('2026-08-18T02:00:00Z')

  it('matches the same instant in the configured timezone only', () => {
    const chain = chainOf({ timeSlots: [custom('09:00', '12:00', ['openai/gpt-4o'])] })
    expect(resolveEffectiveChain(chain, instant, 'Asia/Shanghai')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(chain, instant, 'America/New_York')).toEqual([ALL_DAY])
    expect(resolveEffectiveChain(chain, instant, 'UTC')).toEqual([ALL_DAY])
  })

  it('a custom overnight window follows the timezone too', () => {
    const chain = chainOf({ timeSlots: [custom('21:00', '23:00', ['openai/gpt-4o'])] })
    expect(resolveEffectiveChain(chain, instant, 'America/New_York')).toEqual(['openai/gpt-4o'])
    expect(resolveEffectiveChain(chain, instant, 'Asia/Shanghai')).toEqual([ALL_DAY])
  })
})

describe('config schema — chains[].timeSlots and tz', () => {
  it('defaults chains to [] and tz to Asia/Shanghai', () => {
    const resolved = unwrapConfig(Config({} as FallbacksConfig))
    expect(resolved.chains).toEqual([])
    expect(resolved.tz).toBe('Asia/Shanghai')
  })

  it('composes per-chain row shapes; absent array fields become empty defaults', () => {
    const resolved = unwrapConfig(Config({
      chains: [{ id: 'daily', label: '日常', timeSlots: [{ kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_FLASH] }] }],
    } as unknown as FallbacksConfig))
    const chain = resolved.chains[0]
    expect(chain.entries).toEqual([])
    const row = chain.timeSlots[0]
    expect(row.kind).toBe('preset')
    expect(row.preset).toBe('liang-peak')
    expect(row.chain).toEqual([OFFICIAL_FLASH])
    // schemastery fills absent array fields with [] — the resolver reads
    // []/absent days as "all days", so a composed preset row is NOT dirty.
    expect(row.days).toEqual([])
  })

  it('round-trips an explicit tz', () => {
    expect(unwrapConfig(Config({ tz: 'UTC' } as unknown as FallbacksConfig)).tz).toBe('UTC')
  })
})
