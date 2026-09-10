/**
 * repair-fallbacks-switch-logs.ts — detect session logs poisoned by the old
 * plugin's durable `fallbacks/switch` events.
 *
 * Background: until Task 1 of `fallbacks-session-event-stop-write`, the
 * plugin wrote durable `fallbacks/switch` session events. Host persistence
 * (`assertEventsSupported`) refuses to load any session log whose event type
 * is outside its baked catalog unless the event carries `ignorable: true`.
 * `Session.append` cannot write `ignorable`, and runtime registration proved
 * ineffective (module-instance mismatch). Session logs written while the old
 * plugin was active therefore fail to load after a dsh restart.
 *
 * FAIL-CLOSED (measured against the published 0.1.5-rc.1 packages): the
 * released session-format migration chain refuses unknown event types even
 * with `ignorable: true` — the v0→v1 stage's `assertReleasedEventPayload`
 * throws `format v0 contains unknown historical event type
 * "fallbacks/switch" ... migration refuses unknown historical events even
 * when ignorable` before any later edge runs (v1→v2 refuses unknown types
 * the same way). A log whose `fallbacks/switch` events are marked
 * `ignorable` therefore still fails to load, so this script NEVER writes a
 * "repaired" file and never reports a repair: it detects such logs, reports
 * them, and exits non-zero. The durable fix belongs upstream at the
 * migration edges, not in this script.
 *
 * Session log format (`~/.dsh/sessions/<namespace>/<session-id>/session.jsonl.zstd`):
 *   - concatenated-zstd-frame container: **first frame MUST decode to
 *     exactly one header line** (0.1.5-rc.1 `assertZstdHeaderFrame`:
 *     `indexOf(10) === length-1` — the framing invariant is unchanged
 *     since rc.7). Subsequent frames hold events.
 *   - `node:zlib.zstdDecompress` only decodes the FIRST frame, so this
 *     script shells out to the `zstd` CLI (`zstd -d -c` decodes every
 *     concatenated frame).
 *
 * Usage (from the repo root, via tsx — the package.json
 * `repair:fallbacks-switch-logs` script):
 *   pnpm repair:fallbacks-switch-logs -- --dry-run
 *   pnpm repair:fallbacks-switch-logs -- --root /tmp/repair-fixture
 *
 * Flags:
 *   --root <dir>   session root to walk (default: ~/.dsh/sessions)
 *   --dry-run      report only (the only mode — no write is ever performed)
 *   --backup       accepted for backward compatibility (no write is ever
 *                  performed)
 *   --apply        accepted for backward compatibility (no write is ever
 *                  performed)
 *
 * Safe by construction: the script never writes files. A log that fails to
 * decompress is reported and skipped; a log containing `fallbacks/switch`
 * events is reported as unrepairable and counts as an error (exit non-zero).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Decoded plaintext cap for one session log (512 MB; logs can be large). */
const MAX_BUFFER = 512 * 1024 * 1024

/** A line matched only when the PARSED type is exactly `fallbacks/switch`. */
const SWITCH_TYPE = 'fallbacks/switch'

export interface MarkFallbacksSwitchIgnorableResult {
  lines: string[]
  changed: number
}

/**
 * Pure transform: mark `fallbacks/switch` events without an `ignorable` field
 * as `ignorable: true`.
 *
 * - `type === 'session'` header lines are skipped untouched;
 * - every other line (non-switch events, malformed JSON, empty lines, switch
 *   events that already carry `ignorable`) passes through byte-identical;
 * - switch events are re-serialized with `ignorable` appended (insertion
 *   order — the released read path only reads `event.ignorable`, so field
 *   position is irrelevant); `seq`/`time`/`data` are preserved verbatim;
 * - `changed` counts only lines that were modified.
 *
 * Matching is on the parsed `type` field, never on the raw string — the
 * substring `fallbacks/switch` legitimately appears inside user/message data
 * and must not be treated as an event.
 *
 * NOTE: this transform is retained as the pure boundary the regression tests
 * pin, but its output is REFUSED by the released session-format chain (see
 * the module docblock) — the CLI never writes it.
 */
export function markFallbacksSwitchIgnorable(lines: string[]): MarkFallbacksSwitchIgnorableResult {
  const out = new Array<string>(lines.length)
  let changed = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') {
      out[i] = line
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Malformed JSON — pass through untouched, never corrupt.
      out[i] = line
      continue
    }
    if (parsed === null || typeof parsed !== 'object') {
      out[i] = line
      continue
    }
    const event = parsed as Record<string, unknown>
    if (event.type === 'session') {
      out[i] = line
      continue
    }
    if (
      event.type === SWITCH_TYPE &&
      !Object.prototype.hasOwnProperty.call(event, 'ignorable')
    ) {
      out[i] = JSON.stringify({ ...event, ignorable: true })
      changed++
      continue
    }
    out[i] = line
  }
  return { lines: out, changed }
}

/**
 * Count every parsed `fallbacks/switch` row in a log, regardless of whether
 * it already carries an `ignorable` field or what its value is. The released
 * session-format chain refuses the unknown event type even when `ignorable`
 * is present, so ANY such row makes the log unrepairable — this is the
 * fail-closed detection, separate from the pure transform's `changed` count
 * (which only counts rows the transform would modify).
 *
 * Detection is valid-JSON-only: an unparseable line (e.g. a truncated row)
 * is skipped, so a log whose switch row is itself malformed classifies as
 * `unchanged` — the raw-substring alternative is deliberately rejected
 * because `fallbacks/switch` legitimately appears inside user data.
 */
export function countFallbacksSwitchRows(lines: string[]): number {
  let count = 0
  for (const line of lines) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    if ((parsed as Record<string, unknown>).type === SWITCH_TYPE) count++
  }
  return count
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

interface CliOptions {
  root: string
}

function usage(): string {
  return `usage: tsx scripts/repair-fallbacks-switch-logs.ts [--root DIR] [--dry-run] [--backup] [--apply]

  --root DIR    session root to walk (default: ~/.dsh/sessions)
  --dry-run     report only (the only mode — no write is ever performed)
  --backup      accepted for backward compatibility (no write is ever performed)
  --apply       accepted for backward compatibility (no write is ever performed)

The released session-format chain (v0→v1) refuses unknown event types even
when marked ignorable, so this script fails closed: it only reports logs
that contain fallbacks/switch events and never writes a "repaired" file.`
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function parseArgs(argv: string[]): CliOptions {
  let root = join(homedir(), '.dsh', 'sessions')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm run <script> -- <args> forwards the separator `--`; skip it.
    if (arg === '--') continue
    switch (arg) {
      case '--root':
        i++
        if (i >= argv.length) throw new Error(`${usage()}\n\n--root requires a directory argument`)
        root = expandHome(argv[i])
        break
      case '--dry-run':
      case '--backup':
      case '--apply':
        // Legacy mutation-era flags: accepted as no-ops — the tool never
        // writes, so no flag controls a write or a precondition.
        break
      default:
        throw new Error(`${usage()}\n\nunknown argument: ${arg}`)
    }
  }
  return { root }
}

/** Resolve the zstd CLI binary; throw a clear error when it is missing. */
function resolveZstd(): string {
  try {
    const resolved = execFileSync('which', ['zstd'], { encoding: 'utf8' }).trim()
    if (resolved) return resolved
  } catch {
    // fall through to the direct check below
  }
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
    return 'zstd'
  } catch {
    throw new Error(
      'zstd CLI not found on PATH. Install it (e.g. `brew install zstd`) and retry.',
    )
  }
}

/** Recursively find every `<namespace>/<session-id>/session.jsonl.zstd` under root. */
function findSessionLogs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name === 'session.jsonl.zstd') {
        found.push(full)
      }
    }
  }
  walk(root)
  return found.sort()
}

type FileOutcome =
  | { action: 'unchanged'; changed: 0 }
  | { action: 'refused'; changed: number; error: string }
  | { action: 'error'; changed: number; error: string }

/**
 * Decompress one log and classify it: `unchanged` when it carries no
 * `fallbacks/switch` rows, `refused` when it does (the released chain
 * rejects the unknown event type even when `ignorable` is present — see the
 * module docblock), or `error` when it cannot be decompressed. Never writes.
 */
export function processFile(zstd: string, file: string, _opts: CliOptions): FileOutcome {
  let plain: string
  try {
    plain = execFileSync(zstd, ['-d', '-c', file], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
  } catch (err) {
    return {
      action: 'error',
      changed: 0,
      error: `zstd -d -c failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const switchRows = countFallbacksSwitchRows(plain.split('\n'))
  if (switchRows === 0) return { action: 'unchanged', changed: 0 }

  // Fail closed (session format v3 — measured against the published
  // 0.1.5-rc.1 packages): the released migration chain refuses unknown
  // event types even with `ignorable: true` (the v0→v1 stage throws before
  // any later edge runs), so a "repaired" log would still be rejected on
  // load. Never report it as a repair and never write it.
  return {
    action: 'refused',
    changed: switchRows,
    error:
      'fallbacks/switch events cannot be repaired by an ignorable flag: the released session-format v0→v1 migration refuses unknown event types even when ignorable (session format v3)',
  }
}

export function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const zstd = resolveZstd()
  if (!existsSync(opts.root)) {
    console.error(`repair-fallbacks-switch-logs: root directory not found: ${opts.root}`)
    process.exit(1)
  }

  const files = findSessionLogs(opts.root)
  if (!files.length) {
    console.log(`repair-fallbacks-switch-logs: no session.jsonl.zstd files under ${opts.root}`)
    return
  }

  console.log(`root: ${opts.root}`)
  console.log(`zstd: ${zstd}`)
  console.log(`files: ${files.length}`)
  console.log('mode: report only — no write is ever performed (the released session-format chain refuses ignorable-marked unknown events)')

  let totalFiles = 0
  let totalEvents = 0
  let skipped = 0
  let errors = 0
  for (const file of files) {
    const outcome = processFile(zstd, file, opts)
    switch (outcome.action) {
      case 'unchanged':
        skipped++
        console.log(`  unchanged    ${file}`)
        break
      case 'refused':
        totalFiles++
        totalEvents += outcome.changed
        errors++
        console.error(`  refused      ${file}: ${outcome.error}`)
        break
      case 'error':
        errors++
        console.error(`  error        ${file}: ${outcome.error}`)
        break
    }
  }

  console.log(
    `\nsummary: ${totalFiles} file(s) refused (${totalEvents} fallbacks/switch event(s) cannot be repaired by an ignorable flag), ` +
      `${skipped} unchanged skipped, ${errors} error(s)`,
  )
  if (errors) process.exitCode = 1
}

// Run only when executed directly (tsx scripts/repair-fallbacks-switch-logs.ts)
// — importing the module (unit tests) must not start the CLI.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  try {
    main()
  } catch (err) {
    console.error(`\nrepair-fallbacks-switch-logs failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
