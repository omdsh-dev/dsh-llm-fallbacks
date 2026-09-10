/**
 * Tests for scripts/repair-fallbacks-switch-logs.ts:
 *   - unit tests for the pure transform `markFallbacksSwitchIgnorable` and
 *     the fail-closed classifier `countFallbacksSwitchRows`;
 *   - unit tests for the CLI arg parsing (`parseArgs`): `--root` plus the
 *     legacy `--dry-run` / `--backup` / `--apply` flags accepted as no-ops;
 *   - fixture-based tests for `processFile` and the real CLI (gated on a
 *     system `zstd` binary): a log containing `fallbacks/switch` events is
 *     REFUSED (never written, never reported as a repair, exit 1), a
 *     corrupt log is an error (exit 1), and a log without them is unchanged
 *     (exit 0).
 *
 * The transform marks session logs poisoned by the old plugin's durable
 * `fallbacks/switch` events (no `ignorable` marker), but the released
 * session-format chain (v0→v1) refuses unknown event types even with
 * `ignorable: true` — so the script fails closed and never writes. Contract:
 *   - `type === 'session'` header lines are skipped untouched;
 *   - `type === 'fallbacks/switch'` events without an `ignorable` field get
 *     `ignorable: true`;
 *   - every other line (non-switch events, malformed JSON, empty lines,
 *     switch events that already carry `ignorable`) passes through
 *     byte-identical;
 *   - `changed` counts only lines that were modified.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  countFallbacksSwitchRows,
  markFallbacksSwitchIgnorable,
  parseArgs,
  processFile,
} from '../scripts/repair-fallbacks-switch-logs.ts'

const HEADER = '{"type":"session","version":0,"id":"session-8505afff","createdAt":1786936372682}'

const SWITCH_NO_IGNORABLE =
  '{"type":"fallbacks/switch","seq":114513,"time":1786949105470,"data":{"turn":4,"step":30,"from":{"provider":"ark-plan","model":"deepseek-v4-flash"},"to":{"provider":"opencode-go","model":"deepseek-v4-flash"},"role":"inherit","reason":"trigger-code"}}'

const SWITCH_NO_IGNORABLE_2 =
  '{"type":"fallbacks/switch","seq":148239,"time":1786953585310,"data":{"turn":6,"step":4,"from":{"provider":"opencode-go","model":"deepseek-v4-flash"},"to":{"provider":"ark-plan","model":"deepseek-v4-flash"},"role":"inherit","reason":"trigger-code"}}'

const SWITCH_ALREADY_IGNORABLE =
  '{"type":"fallbacks/switch","seq":114513,"time":1786949105470,"ignorable":true,"data":{"turn":4,"step":30,"from":{"provider":"ark-plan","model":"deepseek-v4-flash"},"to":{"provider":"opencode-go","model":"deepseek-v4-flash"},"role":"inherit","reason":"trigger-code"}}'

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

describe('countFallbacksSwitchRows', () => {
  it('counts every parsed fallbacks/switch row, marked or not', () => {
    expect(countFallbacksSwitchRows([HEADER, SWITCH_NO_IGNORABLE, SWITCH_ALREADY_IGNORABLE])).toBe(2)
    expect(countFallbacksSwitchRows([SWITCH_NO_IGNORABLE])).toBe(1)
    expect(countFallbacksSwitchRows([SWITCH_ALREADY_IGNORABLE])).toBe(1)
  })

  it('ignores non-switch rows, malformed JSON, and empty lines', () => {
    const other = '{"type":"user/message","seq":0,"time":1,"data":{"text":"fallbacks/switch string noise"}}'
    expect(countFallbacksSwitchRows([HEADER, other, '{"type":"fallbacks/switch","seq":5,oops', ''])).toBe(0)
  })
})

describe('parseArgs', () => {
  it('defaults to ~/.dsh/sessions', () => {
    expect(parseArgs([])).toEqual({ root: join(homedir(), '.dsh', 'sessions') })
  })

  it('parses --root and accepts every legacy flag as a no-op', () => {
    expect(parseArgs(['--root', '/tmp/x', '--dry-run', '--backup', '--apply'])).toEqual({ root: '/tmp/x' })
  })

  it('accepts --apply alone (no-op — the tool never writes)', () => {
    expect(parseArgs(['--apply'])).toEqual({ root: join(homedir(), '.dsh', 'sessions') })
  })

  it('accepts --backup alone (no-op — the tool never writes)', () => {
    expect(parseArgs(['--backup'])).toEqual({ root: join(homedir(), '.dsh', 'sessions') })
  })

  it('accepts --dry-run alone (no-op — report is the only mode)', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ root: join(homedir(), '.dsh', 'sessions') })
  })

  it('skips the pnpm `--` separator', () => {
    expect(parseArgs(['--', '--dry-run'])).toEqual({ root: join(homedir(), '.dsh', 'sessions') })
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
})

// `processFile` and the CLI shell out to the system `zstd` binary (same as
// the script at runtime). The fixture suites skip when the binary is absent
// (lenient local dev), but in CI the fail-closed contract must not silently
// skip — a dedicated gate test fails instead.
const zstdBin = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
    return 'zstd'
  } catch {
    return null
  }
})()
const zstdMissing = zstdBin === null
const zstdRequiredInCi = zstdMissing && Boolean(process.env.CI)

describe.skipIf(!zstdRequiredInCi)('zstd availability (CI gate)', () => {
  it('fails when the zstd binary is missing in CI — the fail-closed contract must not silently skip', () => {
    throw new Error(
      'zstd binary not found on PATH — install zstd (e.g. `sudo apt-get install -y zstd`) so the fail-closed repair contract is exercised in CI',
    )
  })
})

describe.skipIf(zstdMissing)('processFile (fixture; skipped without system zstd)', () => {
  const ZSTD = zstdBin as string

  /** Build a fake `<ns>/<session-id>/session.jsonl.zstd` (0600) under `root`. */
  function makeFixture(root: string): { sessionFile: string; original: Buffer } {
    const dir = join(root, 'default', 'session-8505afff')
    mkdirSync(dir, { recursive: true })
    const sessionFile = join(dir, 'session.jsonl.zstd')
    const plain =
      [HEADER, SWITCH_NO_IGNORABLE, SWITCH_NO_IGNORABLE_2, '{"type":"user","seq":9,"time":1,"data":{"text":"fallbacks/switch string noise"}}'].join(
        '\n',
      ) + '\n'
    execFileSync(ZSTD, ['-f', '-o', sessionFile], { input: plain, stdio: ['pipe', 'ignore', 'ignore'] })
    chmodSync(sessionFile, 0o600)
    return { sessionFile, original: readFileSync(sessionFile) }
  }

  it('report/dry-run: returns refused and never touches the filesystem', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-logs-'))
    try {
      const { sessionFile, original } = makeFixture(root)
      const outcome = processFile(ZSTD, sessionFile, { root })
      expect(outcome.action).toBe('refused')
      expect(outcome.changed).toBe(2)
      expect(outcome.error).toContain('cannot be repaired by an ignorable flag')
      // no scratch tmp files next to the log, and the log is byte-identical
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
      expect(readFileSync(sessionFile)).toEqual(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('apply: refuses and never writes (no .bak, no replacement)', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-logs-'))
    try {
      const { sessionFile, original } = makeFixture(root)
      const outcome = processFile(ZSTD, sessionFile, { root })
      expect(outcome.action).toBe('refused')
      expect(outcome.changed).toBe(2)
      expect(outcome.error).toContain('cannot be repaired by an ignorable flag')

      // nothing was written: no backup, no replacement, no tmp leftovers
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(original)
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a log without fallbacks/switch events is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-logs-'))
    try {
      const dir = join(root, 'default', 'session-8505afff')
      mkdirSync(dir, { recursive: true })
      const sessionFile = join(dir, 'session.jsonl.zstd')
      const plain = [HEADER, '{"type":"user/message","seq":0,"time":1,"data":{"text":"hi"}}'].join('\n') + '\n'
      execFileSync(ZSTD, ['-f', '-o', sessionFile], { input: plain, stdio: ['pipe', 'ignore', 'ignore'] })
      const original = readFileSync(sessionFile)
      const outcome = processFile(ZSTD, sessionFile, { root })
      expect(outcome.action).toBe('unchanged')
      expect(outcome.changed).toBe(0)
      expect(readFileSync(sessionFile)).toEqual(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an already-ignorable switch row is still refused (the released chain refuses the unknown type regardless of the flag)', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-logs-'))
    try {
      const dir = join(root, 'default', 'session-8505afff')
      mkdirSync(dir, { recursive: true })
      const sessionFile = join(dir, 'session.jsonl.zstd')
      const plain = [HEADER, SWITCH_ALREADY_IGNORABLE].join('\n') + '\n'
      execFileSync(ZSTD, ['-f', '-o', sessionFile], { input: plain, stdio: ['pipe', 'ignore', 'ignore'] })
      const original = readFileSync(sessionFile)
      const outcome = processFile(ZSTD, sessionFile, { root })
      expect(outcome.action).toBe('refused')
      expect(outcome.changed).toBe(1)
      expect(outcome.error).toContain('cannot be repaired by an ignorable flag')
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(original)
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a corrupt (non-zstd) file is reported as error and left untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-logs-'))
    try {
      const dir = join(root, 'default', 'session-8505afff')
      mkdirSync(dir, { recursive: true })
      const sessionFile = join(dir, 'session.jsonl.zstd')
      const garbage = Buffer.from('this is not zstd data at all')
      writeFileSync(sessionFile, garbage)
      const outcome = processFile(ZSTD, sessionFile, { root })
      expect(outcome.action).toBe('error')
      expect(outcome.changed).toBe(0)
      expect(outcome.error).toContain('zstd -d -c failed')
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(garbage)
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(zstdMissing)('CLI (child-process; skipped without system zstd)', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const SCRIPT = join(REPO_ROOT, 'scripts', 'repair-fallbacks-switch-logs.ts')

  /** Run the real CLI against a fixture root; returns status + combined output. */
  function runCli(root: string): { status: number; output: string } {
    const result = spawnSync(TSX_BIN, [SCRIPT, '--root', root, '--dry-run'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      // Bound the child: a wedged tsx spawn must fail the test, not hang it.
      timeout: 15_000,
    })
    return { status: result.status ?? -1, output: `${result.stdout}\n${result.stderr}` }
  }

  /** Build a fixture with the given plaintext lines as a zstd log. */
  function makeLog(root: string, lines: string[]): { sessionFile: string; original: Buffer } {
    const dir = join(root, 'default', 'session-8505afff')
    mkdirSync(dir, { recursive: true })
    const sessionFile = join(dir, 'session.jsonl.zstd')
    const plain = lines.join('\n') + '\n'
    execFileSync('zstd', ['-f', '-o', sessionFile], { input: plain, stdio: ['pipe', 'ignore', 'ignore'] })
    return { sessionFile, original: readFileSync(sessionFile) }
  }

  it('refuses an unmarked switch log: refusal text, exit 1, no writes', { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-cli-'))
    try {
      const { sessionFile, original } = makeLog(root, [HEADER, SWITCH_NO_IGNORABLE, SWITCH_NO_IGNORABLE_2])
      const { status, output } = runCli(root)
      expect(status).toBe(1)
      expect(output).toContain('refused')
      expect(output).toContain('cannot be repaired by an ignorable flag')
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(original)
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses an already-marked switch log: refusal text, exit 1, no writes', { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-cli-'))
    try {
      const { sessionFile, original } = makeLog(root, [HEADER, SWITCH_ALREADY_IGNORABLE])
      const { status, output } = runCli(root)
      expect(status).toBe(1)
      expect(output).toContain('refused')
      expect(output).toContain('cannot be repaired by an ignorable flag')
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(original)
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a corrupt log as error: exit 1, no writes', { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-cli-'))
    try {
      const dir = join(root, 'default', 'session-8505afff')
      mkdirSync(dir, { recursive: true })
      const sessionFile = join(dir, 'session.jsonl.zstd')
      const garbage = Buffer.from('this is not zstd data at all')
      writeFileSync(sessionFile, garbage)
      const { status, output } = runCli(root)
      expect(status).toBe(1)
      expect(output).toContain('error')
      expect(output).toContain('zstd -d -c failed')
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(garbage)
      const leftovers = readdirSync(dirname(sessionFile)).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exits 0 and writes nothing for a log without switch events', { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-switch-cli-'))
    try {
      const { sessionFile, original } = makeLog(root, [HEADER, '{"type":"user/message","seq":0,"time":1,"data":{"text":"hi"}}'])
      const { status, output } = runCli(root)
      expect(status).toBe(0)
      expect(output).toContain('unchanged')
      expect(output).toContain('0 file(s) refused')
      expect(output).not.toContain('  refused')
      expect(existsSync(`${sessionFile}.bak`)).toBe(false)
      expect(readFileSync(sessionFile)).toEqual(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
