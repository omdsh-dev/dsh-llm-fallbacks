/**
 * Time-slot rows for `fallbacks` (plan fallbacks-timeslots Task 1, pins
 * P4–P6): frozen preset windows, the official-V4 all-day conformance
 * guard, and the pure `resolveEffectiveChain` / `resolveSlotState`
 * resolver.
 *
 * Pure module — no `@deepseek-ai/*` runtime imports: the client card
 * imports the row types type-only (mirroring `config.ts`) and the runtime
 * wires these helpers at request time (Task 2). Malformed rows NEVER
 * throw: they warn ONCE per row instance (through `console.warn` — the
 * resolver's 3-argument contract has no logger parameter) and are
 * skipped; a legacy non-empty non-conforming `rootChain` keeps the
 * v0.2.2 failure walk verbatim (P6).
 *
 * @module dsh-llm-fallbacks/time-slots
 */

import type { FallbacksConfig } from './config.ts'

/** Official V4 models — the ONLY legal all-day selectors (length 1, XOR). */
export const OFFICIAL_V4_FLASH = 'deepseek-official/deepseek-v4-flash'
export const OFFICIAL_V4_PRO = 'deepseek-official/deepseek-v4-pro'

/** The four frozen preset ids (exact strings, spec lock). */
export const PRESET_IDS = ['liang-peak', 'liang-valley', 'glm-peak', 'glm-valley'] as const

export type PresetId = (typeof PRESET_IDS)[number]

/** A frozen UTC+8 window: `start ≤ t < end`, wrap-midnight when `start > end`. */
export interface SlotWindow {
  /** Window start, `HH:mm` (24h). */
  start: string
  /** Window end, `HH:mm` — EXCLUSIVE (a window contains `t` iff the day
   * matches AND (`start ≤ end` ? `start ≤ t < end` : `start ≤ t || t < end`)). */
  end: string
  /** Day mask: 0=Sunday … 6=Saturday. Omitted/empty = every day. */
  days?: number[]
}

/** One extra time-slot row (P4 storage shape; `chain` is always editable). */
export interface SlotRowConfig {
  kind: 'preset' | 'custom'
  /** Preset id — required for `kind: 'preset'`; windows live in
   * {@link PRESETS}, never stored. */
  preset?: PresetId
  /** Custom-only: window start `HH:mm`. */
  start?: string
  /** Custom-only: window end `HH:mm` (exclusive; may wrap midnight). */
  end?: string
  /** Custom-only: day mask 0=Sunday…6=Saturday; omitted/empty = all days. */
  days?: number[]
  /** Models for this row (editable even on preset rows). */
  chain: string[]
}

/** Frozen preset definition (P4): windows are code constants, never stored. */
export interface PresetDefinition {
  windows: readonly SlotWindow[]
  /** `true` = matches iff the peak windows do NOT match (valley derives
   * from its peak — no duplicated window enumerations that can drift). */
  complement: boolean
  /** Display label for the status strip / settings card. */
  label: string
}

/**
 * Frozen preset windows (UTC+8). `liang-*` presets have NO day mask (they
 * apply every day, weekends included); `glm-peak` is Monday–Friday only.
 * The two valleys are `complement: true` of their peak.
 */
export const PRESETS: Record<PresetId, PresetDefinition> = {
  'liang-peak': {
    windows: [
      { start: '09:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ],
    complement: false,
    label: 'Liang Peak',
  },
  'liang-valley': {
    windows: [
      { start: '09:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ],
    complement: true,
    label: 'Liang Valley',
  },
  'glm-peak': {
    windows: [{ start: '14:00', end: '18:00', days: [1, 2, 3, 4, 5] }],
    complement: false,
    label: 'GLM Peak',
  },
  'glm-valley': {
    windows: [{ start: '14:00', end: '18:00', days: [1, 2, 3, 4, 5] }],
    complement: true,
    label: 'GLM Valley',
  },
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Malformed rows warn once per row INSTANCE (config snapshots are stable
 * across requests — this is what keeps "warn once" from becoming spam). */
const warnedMalformedRows = new WeakSet<SlotRowConfig>()
/** Invalid `tz` values warn once per distinct value. */
const warnedTimeZones = new Set<string>()

function warnMalformed(row: unknown, reason: string): void {
  if (typeof row !== 'object' || row === null) {
    // Pathological non-object rows cannot be WeakSet keys — warn each call.
    console.warn(`llm-fallbacks: skipping malformed time-slot row (${reason})`)
    return
  }
  if (warnedMalformedRows.has(row as SlotRowConfig)) return
  warnedMalformedRows.add(row as SlotRowConfig)
  console.warn(`llm-fallbacks: skipping malformed time-slot row (${reason}): ${JSON.stringify(row)}`)
}

/** Wall-clock weekday (0=Sunday) + minutes-since-midnight of `now` in `tz`
 * (standard `Intl` timezone rules, DST-safe). */
function wallClock(now: Date, tz: string): { weekday: number; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    let weekday = 0
    let minutes = 0
    for (const part of parts) {
      if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0
      else if (part.type === 'hour') minutes += Number(part.value) * 60
      else if (part.type === 'minute') minutes += Number(part.value)
    }
    return { weekday, minutes }
  } catch (error) {
    // Invalid timezone: warn once per value and fall back to UTC — the
    // resolver never throws (P5).
    if (!warnedTimeZones.has(tz)) {
      warnedTimeZones.add(tz)
      console.warn(
        `llm-fallbacks: invalid timezone "${tz}" (${(error as Error).message}) — slot matching falls back to UTC`,
      )
    }
    return { weekday: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() }
  }
}

/** `HH:mm` → minutes-since-midnight (inputs are regex-validated or frozen
 * constants — this never sees garbage). */
function minutesOf(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number)
  return hour * 60 + minute
}

/** P4 containment rule: day mask matches AND the window contains `t`
 * (`end` exclusive; `start > end` wraps midnight — custom rows only). */
function containsWindow(window: SlotWindow, clock: { weekday: number; minutes: number }): boolean {
  const dayOk = window.days === undefined || window.days.length === 0 || window.days.includes(clock.weekday)
  if (!dayOk) return false
  const start = minutesOf(window.start)
  const end = minutesOf(window.end)
  return start <= end
    ? start <= clock.minutes && clock.minutes < end
    : start <= clock.minutes || clock.minutes < end
}

function matchesAnyWindow(windows: readonly SlotWindow[], clock: { weekday: number; minutes: number }): boolean {
  return windows.some((window) => containsWindow(window, clock))
}

interface RowDescriptor {
  windows: readonly SlotWindow[]
  complement: boolean
}

/** Validate one stored row → frozen windows, or `undefined` (warn once +
 * skip). Preset rows reject stored windows/day masks (P4); custom rows
 * require strict `HH:mm` bounds; chains must be non-empty. */
function describeRow(row: SlotRowConfig): RowDescriptor | undefined {
  if (!Array.isArray(row.chain) || row.chain.length === 0) {
    warnMalformed(row, 'empty chain')
    return undefined
  }
  if (row.kind === 'preset') {
    const preset = row.preset
    if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) {
      warnMalformed(row, `unknown preset ${JSON.stringify(preset)}`)
      return undefined
    }
    if (row.start !== undefined || row.end !== undefined || (row.days !== undefined && row.days.length > 0)) {
      warnMalformed(row, `preset windows are fixed — row "${preset}" cannot carry start/end/days`)
      return undefined
    }
    return PRESETS[preset as PresetId]
  }
  if (row.kind === 'custom') {
    const { start, end } = row
    if (typeof start !== 'string' || typeof end !== 'string' || !HHMM_RE.test(start) || !HHMM_RE.test(end)) {
      warnMalformed(row, `invalid custom window ${JSON.stringify(start)}-${JSON.stringify(end)} (expected HH:mm)`)
      return undefined
    }
    return { windows: [{ start, end, days: row.days }], complement: false }
  }
  warnMalformed(row, `unknown kind ${JSON.stringify(row.kind)}`)
  return undefined
}

/** Display label for a winning row (preset rows use the frozen label). */
function labelOf(row: SlotRowConfig): string {
  if (row.kind === 'preset' && typeof row.preset === 'string' && Object.hasOwn(PRESETS, row.preset)) {
    return PRESETS[row.preset as PresetId].label
  }
  return `custom ${row.start}-${row.end}`
}

/**
 * All-day conformance (P6): exactly ONE official V4 model — Flash XOR Pro.
 * A legacy multi-model (or otherwise non-conforming) `rootChain` earns no
 * virtual picker row and keeps slot rows inert; the v0.2.2 failure walk
 * over the raw chain stays verbatim.
 */
export function isAllDayConforming(chain: readonly string[]): boolean {
  return chain.length === 1 && (chain[0] === OFFICIAL_V4_FLASH || chain[0] === OFFICIAL_V4_PRO)
}

/**
 * Effective chain for a root request at `now` (P5): the FIRST extra row
 * whose descriptor contains `now` (stored order) — that row's `chain`
 * REPLACES the all-day chain (never concatenated); no match ⇒ `rootChain`
 * (the all-day row, always last and required). Malformed rows warn once
 * and are skipped; never throws.
 */
export function resolveEffectiveChain(config: FallbacksConfig, now: Date, tz: string): string[] {
  const state = resolveSlotState(config, now, tz)
  return state.winner === 'all-day' ? config.rootChain : state.winner.chain
}

/**
 * Slot winner + display label (P5): drives 分时切换 detection (per-root-agent
 * last-winner marker, in-process only) and the card / `/fallbacks` status
 * strip. `winner` is the matching row or `'all-day'`; `label` names the
 * slot (frozen preset label or `custom HH:mm-HH:mm`).
 */
export function resolveSlotState(
  config: FallbacksConfig,
  now: Date,
  tz: string,
): { winner: SlotRowConfig | 'all-day'; label: string } {
  const clock = wallClock(now, tz)
  const seenPresets = new Set<string>()
  const rows = Array.isArray(config.timeSlots) ? config.timeSlots : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      warnMalformed(row, 'row is not an object')
      continue
    }
    if (row.kind === 'preset' && typeof row.preset === 'string') {
      if (seenPresets.has(row.preset)) {
        warnMalformed(row, `duplicate preset "${row.preset}" — only the first row takes effect`)
        continue
      }
      seenPresets.add(row.preset)
    }
    const descriptor = describeRow(row)
    if (descriptor === undefined) continue
    const matches = descriptor.complement
      ? !matchesAnyWindow(descriptor.windows, clock)
      : matchesAnyWindow(descriptor.windows, clock)
    if (matches) return { winner: row, label: labelOf(row) }
  }
  return { winner: 'all-day', label: 'all-day' }
}
