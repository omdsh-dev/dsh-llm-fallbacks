/**
 * repair-fallbacks-switch-logs.ts — repair session logs poisoned by the old
 * plugin's durable `fallbacks/switch` events.
 *
 * Background: until Task 1 of `fallbacks-session-event-stop-write`, the
 * plugin wrote durable `fallbacks/switch` session events. Host persistence
 * (`assertEventsSupported`) refuses to load any session log whose event type
 * is outside its baked catalog unless the event carries `ignorable: true`.
 * `Session.append` cannot write `ignorable`, and runtime registration proved
 * ineffective (module-instance mismatch). Session logs written while the old
 * plugin was active therefore fail to load after a dsh restart. This script
 * marks those events `ignorable: true` so the read path accepts them again.
 *
 * Session log format (`~/.dsh/sessions/<namespace>/<session-id>/session.jsonl.zstd`):
 *   - concatenated-zstd-frame container: line 1 is the `session` header,
 *     subsequent lines are events, each append batch its own zstd frame;
 *   - `node:zlib.zstdDecompress` only decodes the FIRST frame, so this script
 *     shells out to the `zstd` CLI (`zstd -d -c` decodes every concatenated
 *     frame); re-encoding as a single checksummed frame is accepted by the
 *     host read path (`scanZstdFrames` walks any complete frame set).
 *
 * IMPORTANT: stop dsh before running with `--apply`. The script replaces a
 * session log via read → transform → atomic rename; a live dsh that appends
 * a new zstd frame between the read and the rename would have that frame
 * lost (read-modify-write race). Report / `--dry-run` runs are safe any
 * time — they never write files.
 *
 * Usage (from the repo root, via tsx — the package.json
 * `repair:fallbacks-switch-logs` script):
 *   pnpm repair:fallbacks-switch-logs -- --dry-run
 *   pnpm repair:fallbacks-switch-logs -- --apply --backup
 *   pnpm repair:fallbacks-switch-logs -- --root /tmp/repair-fixture --dry-run
 *
 * Flags:
 *   --root <dir>   session root to walk (default: ~/.dsh/sessions)
 *   --dry-run      report only — never write files
 *   --backup       required with --apply: copy the original to <file>.bak
 *                  before replacing (apply is refused without it)
 *   --apply        actually replace repaired files; requires --backup and a
 *                  stopped dsh; without it (or with --dry-run) the run only
 *                  reports would-change
 *
 * Safe by construction: a file is only replaced after its re-encoded form
 * passes `zstd -t` and carries the original file's permission bits; a file
 * that fails to decompress or re-encode is reported and skipped (never
 * corrupted); the replace is an atomic rename of a temp file in the same
 * directory. Report/dry-run mode performs no filesystem writes at all.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
 *   order — the read path only reads `event.ignorable`, so field position is
 *   irrelevant); `seq`/`time`/`data` are preserved verbatim;
 * - `changed` counts only lines that were modified.
 *
 * Matching is on the parsed `type` field, never on the raw string — the
 * substring `fallbacks/switch` legitimately appears inside user/message data
 * and must not be treated as an event.
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

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

interface CliOptions {
  root: string
  dryRun: boolean
  backup: boolean
  apply: boolean
}

function usage(): string {
  return `usage: tsx scripts/repair-fallbacks-switch-logs.ts [--root DIR] [--dry-run] [--backup] [--apply]

  --root DIR    session root to walk (default: ~/.dsh/sessions)
  --dry-run     report only — never write files
  --backup      required with --apply: copy the original to <file>.bak before
                replacing
  --apply       actually replace repaired files (requires --backup; stop dsh
                before applying)`
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function parseArgs(argv: string[]): CliOptions {
  let root = join(homedir(), '.dsh', 'sessions')
  let dryRun = false
  let backup = false
  let apply = false
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
        dryRun = true
        break
      case '--backup':
        backup = true
        break
      case '--apply':
        apply = true
        break
      default:
        throw new Error(`${usage()}\n\nunknown argument: ${arg}`)
    }
  }
  if (apply && !backup) {
    throw new Error(
      `${usage()}\n\n--apply requires --backup: real modification must keep a .bak copy of every replaced session log (run with --dry-run first to review)`,
    )
  }
  return { root, dryRun, backup, apply }
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
  | { action: 'would-change'; changed: number }
  | { action: 'changed'; changed: number }
  | { action: 'error'; changed: number; error: string }

/**
 * Decompress all frames of one log, transform it, and (only when actually
 * applying) atomically replace it with a single-frame re-encode that passed
 * `zstd -t` and carries the original file's permission bits. Report/dry-run
 * returns would-change WITHOUT touching the filesystem (no tmp files, no
 * encode, no `zstd -t`). Returns the per-file outcome; never throws for
 * per-file failures (they become `error` outcomes so the walk continues).
 */
export function processFile(zstd: string, file: string, opts: CliOptions): FileOutcome {
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

  const { lines, changed } = markFallbacksSwitchIgnorable(plain.split('\n'))
  if (changed === 0) return { action: 'unchanged', changed: 0 }

  // Report / dry-run: nothing to write — return would-change right after the
  // transform (parseArgs refuses `--apply` without `--backup`, so any run
  // reaching here without `write` is a report-only invocation).
  const write = opts.apply && !opts.dryRun
  if (!write) return { action: 'would-change', changed }

  // Apply: temp files live next to the target so the final rename is atomic
  // (same filesystem) and the walker never mistakes them for session logs.
  const dir = dirname(file)
  const tmpPlain = join(dir, `.${basename(file)}.${process.pid}.plain.tmp`)
  const tmpZstd = join(dir, `.${basename(file)}.${process.pid}.zstd.tmp`)
  const mode = statSync(file).mode & 0o7777
  try {
    writeFileSync(tmpPlain, lines.join('\n'), 'utf8')
    execFileSync(zstd, ['-f', '-o', tmpZstd, tmpPlain], { stdio: 'ignore' })
    execFileSync(zstd, ['-t', tmpZstd], { stdio: 'ignore' })
    copyFileSync(file, `${file}.bak`)
    chmodSync(tmpZstd, mode)
    renameSync(tmpZstd, file)
  } catch (err) {
    return {
      action: 'error',
      changed,
      error: `re-encode/validate failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    rmSync(tmpPlain, { force: true })
    rmSync(tmpZstd, { force: true })
  }
  return { action: 'changed', changed }
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

  const mode = opts.dryRun ? 'dry-run' : opts.apply ? 'apply' : 'report'
  console.log(`root: ${opts.root}`)
  console.log(`mode: ${mode}${opts.backup ? ' (backup .bak before replace)' : ''}`)
  console.log(`zstd: ${zstd}`)
  console.log(`files: ${files.length}`)

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
      case 'would-change':
        totalFiles++
        totalEvents += outcome.changed
        console.log(`  would-change ${outcome.changed}  ${file}`)
        break
      case 'changed':
        totalFiles++
        totalEvents += outcome.changed
        console.log(`  changed      ${outcome.changed}  ${file}`)
        break
      case 'error':
        errors++
        console.error(`  error        ${file}: ${outcome.error}`)
        break
    }
  }

  console.log(
    `\nsummary: ${totalFiles} file(s), ${totalEvents} fallbacks/switch event(s) ` +
      `${mode === 'dry-run' || mode === 'report' ? 'to be marked' : 'marked'}, ` +
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
