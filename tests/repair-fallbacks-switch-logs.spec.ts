/**
 * Tests for scripts/repair-fallbacks-switch-logs.ts:
 *   - unit tests for the pure transform `markFallbacksSwitchIgnorable`;
 *   - unit tests for the CLI arg parsing (`parseArgs`), incl. the
 *     `--apply`-requires-`--backup` refusal;
 *   - fixture-based tests for `processFile` (gated on a system `zstd`
 *     binary): dry-run/report never touch the filesystem, apply keeps a
 *     `.bak`, preserves the original file mode and leaves no tmp files.
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
import { execFileSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  markFallbacksSwitchIgnorable,
  parseArgs,
  processFile,
} from '../scripts/repair-fallbacks-switch-logs.ts'

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

describe('parseArgs', () => {
  it('defaults to ~/.dsh/sessions with every flag off', () => {
    expect(parseArgs([])).toEqual({
      root: join(homedir(), '.dsh', 'sessions'),
      dryRun: false,
      backup: false,
      apply: false,
    })
  })

  it('parses every flag', () => {
    expect(parseArgs(['--root', '/tmp/x', '--dry-run', '--backup', '--apply'])).toEqual({
      root: '/tmp/x',
      dryRun: true,
      backup: true,
      apply: true,
    })
  })

  it('skips the pnpm `--` separator', () => {
    expect(parseArgs(['--', '--dry-run']).dryRun).toBe(true)
  })

  it('expands a leading ~ in --root', () => {
    expect(parseArgs(['--root', '~']).root).toBe(homedir())
    expect(parseArgs(['--root', '~/x']).root).toBe(join(homedir(), 'x'))
  })

  it('throws when --root is missing its argument', () => {
    expect(() => parseArgs(['--root'])).toThrow(/--root requires a directory argument/)
  })

  it('throws on unknown arguments', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument: --nope/)
  })

  it('refuses --apply without --backup', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/--apply requires --backup/)
  })

  it('accepts --apply together with --backup', () => {
    expect(() => parseArgs(['--apply', '--backup'])).not.toThrow()
  })
})

// `processFile` shells out to the system `zstd` binary (same as the script
// at runtime); skip the fixture suite when the binary is not installed.
const zstdBin = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
    return 'zstd'
  } catch {
    return null
  }
})()

describe.skipIf(zstdBin === null)('processFile (fixture; skipped without system zstd)', () => {
  const ZSTD = zstdBin as string

  /** Build a fake `<ns>/<session-id>/session.jsonl.zstd` (0600) in a tmp dir. */
  function makeFixture(): { root: string; sessionFile: string; original: Buffer } {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-logs-'))
    const dir = join(root, 'default', 'session-8505afff')
    mkdirSync(dir, { recursive: true })
    const sessionFile = join(dir, 'session.jsonl.zstd')
    const plain =
      [HEADER, SWITCH_NO_IGNORABLE, SWITCH_NO_IGNORABLE_2, '{"type":"user","seq":9,"time":1,"data":{"text":"fallbacks/switch string noise"}}'].join(
        '\n',
      ) + '\n'
    execFileSync(ZSTD, ['-f', '-o', sessionFile], { input: plain, stdio: ['pipe', 'ignore', 'ignore'] })
    chmodSync(sessionFile, 0o600)
    return { root, sessionFile, original: readFileSync(sessionFile) }
  }

  it('report/dry-run: returns would-change and never touches the filesystem', () => {
    const { root, sessionFile, original } = makeFixture()
    try {
      for (const opts of [
        { root, dryRun: true, backup: false, apply: false },
        { root, dryRun: false, backup: false, apply: false },
      ]) {
        const outcome = processFile(ZSTD, sessionFile, opts)
        expect(outcome.action).toBe('would-change')
        expect(outcome.changed).toBe(2)
      }
      // no scratch tmp files next to the log, and the log is byte-identical
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
      expect(readFileSync(sessionFile)).toEqual(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('apply: keeps a .bak, preserves the original mode, no tmp leftovers', () => {
    const { root, sessionFile, original } = makeFixture()
    try {
      const outcome = processFile(ZSTD, sessionFile, {
        root,
        dryRun: false,
        backup: true,
        apply: true,
      })
      expect(outcome.action).toBe('changed')
      expect(outcome.changed).toBe(2)

      // backup copy carries the pre-repair bytes
      expect(existsSync(`${sessionFile}.bak`)).toBe(true)
      expect(readFileSync(`${sessionFile}.bak`)).toEqual(original)

      // replacement keeps the original 0600 permission bits (fixture default)
      expect(statSync(sessionFile).mode & 0o7777).toBe(0o600)

      execFileSync(ZSTD, ['-t', sessionFile], { stdio: 'ignore' })
      // rc.7 assertZstdHeaderFrame: first frame is exactly one header line.
      const firstFrame = zstdDecompressSync(readFileSync(sessionFile))
      expect(firstFrame.indexOf(10)).toBe(firstFrame.length - 1)
      expect(JSON.parse(firstFrame.toString('utf8').trim()).type).toBe('session')
      const repaired = execFileSync(ZSTD, ['-d', '-c', sessionFile], { encoding: 'utf8' })
      const switches = repaired
        .split('\n')
        .filter(Boolean)
        .filter((line) => JSON.parse(line).type === 'fallbacks/switch')
      expect(switches).toHaveLength(2)
      for (const line of switches) expect(JSON.parse(line).ignorable).toBe(true)

      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
