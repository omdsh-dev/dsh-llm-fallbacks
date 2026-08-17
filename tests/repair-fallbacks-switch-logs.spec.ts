/**
 * Unit tests for the pure transform `markFallbacksSwitchIgnorable`
 * (scripts/repair-fallbacks-switch-logs.ts).
 *
 * The transform repairs session logs poisoned by the old plugin's durable
 * `fallbacks/switch` events (no `ignorable` marker), so the host read path
 * (`KNOWN_SESSION_EVENT_TYPES.has(t) || event.ignorable === true`) accepts
 * them again after a dsh restart. Contract:
 *   - `type === 'session'` header lines are skipped untouched;
 *   - `type === 'fallbacks/switch'` events without an `ignorable` field get
 *     `ignorable: true`;
 *   - every other line (non-switch events, malformed JSON, empty lines,
 *     switch events that already carry `ignorable`) passes through
 *     byte-identical;
 *   - `changed` counts only lines that were modified.
 */
import { describe, expect, it } from 'vitest'
import { markFallbacksSwitchIgnorable } from '../scripts/repair-fallbacks-switch-logs.ts'

const HEADER = '{"type":"session","version":0,"id":"session-8505afff","createdAt":1786936372682}'

const SWITCH_NO_IGNORABLE =
  '{"type":"fallbacks/switch","seq":114513,"time":1786949105470,"data":{"turn":4,"step":30,"from":{"provider":"ark-plan","model":"deepseek-v4-flash"},"to":{"provider":"opencode-go","model":"deepseek-v4-flash"},"role":"inherit","reason":"trigger-code"}}'

const SWITCH_NO_IGNORABLE_2 =
  '{"type":"fallbacks/switch","seq":148239,"time":1786953585310,"data":{"turn":6,"step":4,"from":{"provider":"opencode-go","model":"deepseek-v4-flash"},"to":{"provider":"ark-plan","model":"deepseek-v4-flash"},"role":"inherit","reason":"trigger-code"}}'

describe('markFallbacksSwitchIgnorable', () => {
  it('skips the session header line untouched', () => {
    const { lines, changed } = markFallbacksSwitchIgnorable([HEADER])
    expect(lines).toEqual([HEADER])
    expect(changed).toBe(0)
  })

  it('marks a fallbacks/switch event without ignorable (added field, changed=1)', () => {
    const { lines, changed } = markFallbacksSwitchIgnorable([SWITCH_NO_IGNORABLE])
    expect(changed).toBe(1)
    const out = JSON.parse(lines[0])
    expect(out.type).toBe('fallbacks/switch')
    expect(out.ignorable).toBe(true)
  })

  it('preserves seq/time/data on a marked switch event', () => {
    const original = JSON.parse(SWITCH_NO_IGNORABLE)
    const { lines } = markFallbacksSwitchIgnorable([SWITCH_NO_IGNORABLE])
    const out = JSON.parse(lines[0])
    expect(out.seq).toBe(original.seq)
    expect(out.time).toBe(original.time)
    expect(out.data).toEqual(original.data)
    expect(out.type).toBe('fallbacks/switch')
  })

  it('is idempotent: second call changes nothing (changed=0)', () => {
    const first = markFallbacksSwitchIgnorable([SWITCH_NO_IGNORABLE, SWITCH_NO_IGNORABLE_2])
    expect(first.changed).toBe(2)
    const second = markFallbacksSwitchIgnorable(first.lines)
    expect(second.changed).toBe(0)
    expect(second.lines).toEqual(first.lines)
  })

  it('leaves non-switch events byte-identical', () => {
    const other = '{"type":"agent/message","seq":7,"time":1786949105470,"data":{"text":"hi"}}'
    const { lines, changed } = markFallbacksSwitchIgnorable([other])
    expect(lines).toEqual([other])
    expect(changed).toBe(0)
  })

  it('does not match the string fallbacks/switch inside other event data', () => {
    // The "138 string noise" case: the substring appears inside user/message
    // data, but the parsed `type` is not fallbacks/switch — must stay untouched.
    const noise = '{"type":"user","seq":9,"time":1,"data":{"text":"fallbacks/switch is now off"}}'
    const { lines, changed } = markFallbacksSwitchIgnorable([noise])
    expect(lines).toEqual([noise])
    expect(changed).toBe(0)
  })

  it('leaves a switch event that already carries ignorable untouched', () => {
    const withIgnorable = '{"type":"fallbacks/switch","seq":3,"time":2,"ignorable":true,"data":{}}'
    const { lines, changed } = markFallbacksSwitchIgnorable([withIgnorable])
    expect(lines).toEqual([withIgnorable])
    expect(changed).toBe(0)
  })

  it('passes malformed JSON lines through untouched', () => {
    const malformed = '{"type":"fallbacks/switch","seq":5,oops'
    const { lines, changed } = markFallbacksSwitchIgnorable([malformed])
    expect(lines).toEqual([malformed])
    expect(changed).toBe(0)
  })

  it('preserves empty lines', () => {
    const { lines, changed } = markFallbacksSwitchIgnorable(['', SWITCH_NO_IGNORABLE, ''])
    expect(lines[0]).toBe('')
    expect(lines[2]).toBe('')
    expect(changed).toBe(1)
  })

  it('marks only the real switch events in a mixed log', () => {
    const { lines, changed } = markFallbacksSwitchIgnorable([
      HEADER,
      '{"type":"agent/message","seq":1,"data":{}}',
      SWITCH_NO_IGNORABLE,
      SWITCH_NO_IGNORABLE_2,
      '{"type":"user","data":{"text":"fallbacks/switch string noise"}}',
      '{"type":"fallbacks/switch","seq":9,"time":8,"ignorable":true,"data":{}}',
    ])
    expect(changed).toBe(2)
    expect(lines[0]).toBe(HEADER)
    expect(lines[1]).toBe('{"type":"agent/message","seq":1,"data":{}}')
    expect(lines[4]).toBe('{"type":"user","data":{"text":"fallbacks/switch string noise"}}')
    expect(lines[5]).toBe('{"type":"fallbacks/switch","seq":9,"time":8,"ignorable":true,"data":{}}')
    expect(JSON.parse(lines[2]).ignorable).toBe(true)
    expect(JSON.parse(lines[3]).ignorable).toBe(true)
  })
})
