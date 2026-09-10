/**
 * repair-session-logs.ts — triage and repair pre-V3 dsh session logs.
 *
 * WHY: a session log is only readable through the FROZEN released migration
 * chain. A log written by an older release (or by a plugin that merged a custom
 * `MessageSource.kind`) makes that chain throw at the FIRST refused row, so the
 * GUI reports a failed session load and the session can no longer be opened.
 * This CLI names the refusal class of every pre-V3 log under a session root
 * and — only for the classes whose normalization is provably shape-preserving
 * (the rule registry in `./session-logs/rules.ts`) and only with a resolved
 * released catalog as the oracle (`./session-logs/catalog.ts`) — publishes a
 * current-generation successor beside the original
 * (`./session-logs/publish.ts`). The original generation is never modified.
 *
 * This module CONSUMES the frozen Task 1/2 modules; it re-implements none of
 * them. The refusal vocabulary, the rule registry, the oracle resolution and
 * the publication order live there.
 *
 * USAGE (via the `repair:session-logs` npm script):
 *   pnpm repair:session-logs -- [--root DIR] [--apply] [--class NAME]
 *                              [--catalog PATH] [--backup] [--drop-legacy-events]
 *                              [--json] [--quiet]
 *
 * LOSSY MODE (`--drop-legacy-events`, off by default): the legacy
 * `fallbacks/switch` event type this repo's own pre-`#52` plugin wrote is refused
 * by the frozen V0→V1 edge even with `ignorable: true`, so no rewrite can make
 * such a row load — the row can only be removed, which loses the provider/model
 * switch audit entry it carries. That removal is the ONLY lossy operation this
 * tool can perform, it needs the explicit opt-in, and `--apply` with it REQUIRES
 * `--backup` (the original generation is the only copy of the dropped rows once
 * a successor is published). A row of any other unknown event type is never
 * dropped: such a log stays unrepairable. The run reports the dropped-event count
 * per log (`droppedEventCount` in `--json`) and warns loudly on stderr; the
 * post-drop restore and the published read-back are still the proof of success.
 *
 * WHAT THE DROP CAN AND CANNOT FIX: the same V0→V1 edge requires every event's
 * `seq` to equal its running event count, so removing a row is loadable only when
 * the removed rows are the LAST events of the generation — a legacy row in the
 * middle leaves the survivors with a gap (`expected N, got N+1`) and the
 * pre-write proof refuses the log, writing nothing. That is the measured shape of
 * every legacy-blocked log in this repository's own namespace (25/25 sit
 * mid-sequence), so the flag is currently an opt-in that fails closed rather than
 * a repair for them; closing that gap needs a seq-renumbering mechanism this tool
 * deliberately does not have (it would rewrite survivors that `sourceEventSeqs`
 * rows reference).
 *
 * DISCOVERY: `<root>/<namespace>/<session>/` — exactly two directory levels —
 * and inside each session directory the newest CANONICAL generation whose
 * version is below the current-format floor, i.e. the newest of
 * `session.jsonl.zstd` (v0) and `session.v<N>.jsonl.zstd` (N >= 1). Canonical
 * means what the released `parseGenerationLogFilename` accepts: lowercase `v`,
 * no leading zeros, and no version-zero-tagged name, so a staged
 * `session.repair.<hex>.jsonl.zstd.tmp` or a `--backup` copy is ignored. A
 * session directory that already carries a v3+ successor is still triaged when
 * a pre-V3 generation is present, so a re-run reports `already published`
 * instead of silently skipping: report mode reads that successor back through
 * the oracle before calling it loadable, and `--apply` never replaces one
 * holding different bytes (the publisher refuses).
 *
 * `--class NAME` restricts RULE APPLICATION to one class (default: all rules),
 * which is what `--apply` will repair. It never narrows the report or the exit
 * code: every log under `--root` is classified and a refusal always exits
 * non-zero, so the flag can never hide a refusal.
 *
 * PRECONDITION for `--apply` (printed loudly, never enforced): run it only while
 * NO dsh instance is writing the sessions under `--root`. The publisher links
 * the successor into the session directory without observing the host's flock
 * lease (`lease.ts:40` in `@deepseek-ai/dsh-session-persistence-jsonl`; the
 * flock addon is host-internal, so this repo cannot take it), which means a
 * still-running older dsh would keep appending to a generation the host stops
 * preferring. Rollback is `rm` of the successor generation — the original is
 * authoritative and byte-identical.
 *
 * RUNTIME FLOOR: reading and writing need `node:zlib` zstd, added in Node 22.15
 * (`engines.node` says `>= 22`). Availability is PROBED before the zstd-
 * dependent module is imported, so an older runtime gets an actionable message
 * and exit 2 instead of a module-link stack trace (see `zstdRuntimeProblem`).
 *
 * EXIT CODES: 0 = nothing refused, or every refusal repaired; 1 = completed with
 * at least one log still refused/unrepairable (or a repair failed); 2 = fatal
 * (bad arguments, missing `--root`, `--apply` without a resolved catalog,
 * `--apply --drop-legacy-events` without `--backup`, or a runtime without zstd).
 */
import { constants as fsConstants } from 'node:fs'
import { copyFile, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classifyRows } from './session-logs/classify.ts'
import { CATALOG_ENV_VAR, classifyWithCatalog, resolveCatalog, restoreRows } from './session-logs/catalog.ts'
import type { CatalogHandle, CatalogResolvedBy } from './session-logs/catalog.ts'
import { BUILT_IN_RULES, dropLegacyEventsRule, droppedEventCount, fallbacksSwitchRule } from './session-logs/rules.ts'
import type { Finding, LogRule, ParsedRow, RefusalClass } from './session-logs/rules.ts'

/** Program name used in every diagnostic line. */
const PROGRAM = 'repair-session-logs'

/**
 * Format version at which the released chain is current. Only generations BELOW
 * it are triaged (the pinned `currentVersion` of the released catalog is the
 * publisher's business; this floor is the "pre-V3" scope of the plan).
 */
const CURRENT_VERSION_FLOOR = 3

/** The classes whose normalization the rule registry can prove. */
const REPAIRABLE_CLASSES: ReadonlySet<RefusalClass> = new Set<RefusalClass>([
  'source-kind',
  'subagent-descriptor-version',
])

/** The full refusal vocabulary, in report order. */
const CLASS_NAMES: readonly RefusalClass[] = [
  'ok',
  'source-kind',
  'subagent-descriptor-version',
  'unknown-event-type',
  'other-refusal',
  'decompress-failed',
]

/** Exit codes (see the module docblock). */
const EXIT_CLEAN = 0
const EXIT_REFUSED = 1
const EXIT_FATAL = 2

/** Suffix of the `--backup` copy (noncanonical, so discovery ignores it). */
const BACKUP_SUFFIX = '.bak'

/** Column width of the per-log status token. */
const TOKEN_WIDTH = 28

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

/** Parsed command line. */
export interface CliOptions {
  /** `--help`: print the usage text and exit 0 without touching anything. */
  help: boolean
  /** Session root to walk (`--root`, default `$DSH_HOME|~/.dsh` + `/sessions`). */
  root: string
  /** `--apply`: run the proofs and publish successors (default: read-only report). */
  apply: boolean
  /** `--class`: restrict rule application to one class (default: all rules). */
  classFilter: RefusalClass | null
  /** `--catalog`: explicit released-catalog path, forwarded to `resolveCatalog`. */
  catalogPath: string | undefined
  /** `--backup`: copy the original generation to `<name>.bak` before publishing. */
  backup: boolean
  /**
   * `--drop-legacy-events`: LOSSY recovery — remove the legacy
   * `fallbacks/switch` rows instead of refusing the log (default: off). Report
   * mode only counts what it would drop; `--apply` additionally requires
   * `--backup`.
   */
  dropLegacyEvents: boolean
  /** `--json`: emit one machine-readable JSON document instead of the text report. */
  json: boolean
  /** `--quiet`: suppress the per-log lines and the by-class table. */
  quiet: boolean
}

/** The home directory one environment names, falling back to the OS. */
function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env['HOME'] ?? env['USERPROFILE'] ?? homedir()
}

/** Expand a leading `~` against one environment's home directory. */
function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === '~') return homeDirectory(env)
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDirectory(env), path.slice(2))
  return path
}

/** Default session root: `$DSH_HOME/sessions`, else `~/.dsh/sessions`. */
function defaultRoot(env: NodeJS.ProcessEnv): string {
  const dshHome = env['DSH_HOME']
  const base = dshHome !== undefined && dshHome.length > 0 ? expandHome(dshHome, env) : join(homeDirectory(env), '.dsh')
  return join(base, 'sessions')
}

/** One flag's value, or a clear "missing value" failure. */
function argument(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined) throw new Error(`${flag} requires a value`)
  return value
}

/** One `--class` value, validated against the refusal vocabulary. */
function parseClass(value: string): RefusalClass {
  const match = CLASS_NAMES.find((name) => name === value)
  if (match === undefined) throw new Error(`unknown --class ${value}; expected one of ${CLASS_NAMES.join(', ')}`)
  return match
}

/**
 * Parse the CLI arguments.
 *
 * @param argv arguments after the script name (`pnpm run <script> -- <args>`'s
 *   separator is skipped).
 * @param env environment the default root and `~` expansion read.
 * @throws Error on a malformed command line (the caller prints usage, exit 2).
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    help: false,
    root: defaultRoot(env),
    apply: false,
    classFilter: null,
    catalogPath: undefined,
    backup: false,
    dropLegacyEvents: false,
    json: false,
    quiet: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // `pnpm run <script> -- <args>` forwards the separator; skip it.
    if (arg === '--') continue
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break
      case '--apply':
        options.apply = true
        break
      case '--backup':
        options.backup = true
        break
      case '--drop-legacy-events':
        options.dropLegacyEvents = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--root':
        options.root = expandHome(argument(argv, (index += 1), '--root'), env)
        break
      case '--catalog':
        options.catalogPath = expandHome(argument(argv, (index += 1), '--catalog'), env)
        break
      case '--class':
        options.classFilter = parseClass(argument(argv, (index += 1), '--class'))
        break
      default:
        throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
  return options
}

/* ------------------------------------------------------------------ */
/* runtime floor                                                       */
/* ------------------------------------------------------------------ */

/**
 * Why this runtime cannot run the tool, or `null` when it can.
 *
 * Kept catalog- and host-independent on purpose: it only looks at the two
 * `node:zlib` zstd functions the publisher needs (`zstdCompressSync`,
 * `zstdDecompressSync`, added in Node 22.15), so an old runtime fails closed
 * with an actionable message before any module that imports them is loaded.
 *
 * @param zlib the `node:zlib` namespace (or any object, for tests).
 */
export function zstdRuntimeProblem(zlib: object): string | null {
  const missing = ['zstdCompressSync', 'zstdDecompressSync'].filter(
    (name) => typeof (zlib as Record<string, unknown>)[name] !== 'function',
  )
  if (missing.length === 0) return null
  return (
    `${PROGRAM}: this Node runtime (${process.version}) has no node:zlib zstd support `
    + `(${missing.join(', ')} missing). Session logs are concatenated Zstandard frames, so the tool can `
    + 'neither read nor publish them. Upgrade to Node >= 22.15 (the release that added node:zlib zstd) and retry.'
  )
}

/* ------------------------------------------------------------------ */
/* discovery                                                           */
/* ------------------------------------------------------------------ */

/** One candidate: the newest pre-current canonical generation of one session. */
export interface LogGeneration {
  /** Absolute or root-relative path of the generation file. */
  path: string
  /** Version the generation's filename pins (0 for `session.jsonl.zstd`). */
  generation: number
  /** The `<namespace>/<session>/` directory the generation sits in. */
  sessionDir: string
}

/**
 * The version one canonical generation filename pins, or `null` when the name is
 * not canonical.
 *
 * Mirrors the released `parseGenerationLogFilename`: version zero keeps the
 * suffix-only name, later generations carry a lowercase numeric `v<N>` with no
 * leading zeros. Everything else (uppercase, `v0`, `v01`, `.tmp`, `.bak`) is
 * noncanonical and therefore invisible to both the host and this tool.
 */
export function canonicalGeneration(name: string): number | null {
  if (name === 'session.jsonl.zstd') return 0
  const match = /^session\.v([1-9][0-9]*)\.jsonl\.zstd$/.exec(name)
  if (match === null) return null
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : null
}

/** Every immediate subdirectory of one directory, sorted; `[]` when unreadable. */
async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)).sort()
  } catch {
    return []
  }
}

/**
 * The newest canonical generation of one session directory below the
 * current-format floor, or `null` when the directory holds none.
 *
 * A generation at or above the floor is deliberately ignored *when selecting*
 * (the host already prefers it), but its presence does not hide a pre-V3
 * generation: the caller reports such a log as already published instead of
 * silently skipping the session.
 */
async function newestPreCurrentGeneration(sessionDir: string): Promise<LogGeneration | null> {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch {
    return null
  }
  let best: LogGeneration | null = null
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const generation = canonicalGeneration(entry.name)
    if (generation === null || generation >= CURRENT_VERSION_FLOOR) continue
    if (best === null || generation > best.generation) {
      best = { path: join(sessionDir, entry.name), generation, sessionDir }
    }
  }
  return best
}

/**
 * Every triage candidate under one session root (see the module docblock),
 * sorted by path so a report is reproducible.
 *
 * @param root session root (`<root>/<namespace>/<session>/<generation>`).
 */
export async function findGenerations(root: string): Promise<LogGeneration[]> {
  const found: LogGeneration[] = []
  for (const namespace of await subdirectories(root)) {
    for (const session of await subdirectories(namespace)) {
      const generation = await newestPreCurrentGeneration(session)
      if (generation !== null) found.push(generation)
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path))
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn one decoded container into parsed rows.
 *
 * The first physical record is the session header, which carries no `seq` on the
 * wire, so a synthesized `seq: 0` is added — the frozen row contract
 * (`rowRecord`) drops it again. Blank lines are skipped; any other malformed
 * row fails loudly (the log is then reported as `decompress-failed`, never
 * silently truncated).
 *
 * @param frames decoded frame plaintexts, in file order.
 */
export function decodeRows(frames: readonly string[]): ParsedRow[] {
  const rows: ParsedRow[] = []
  for (const line of frames.join('').split('\n')) {
    if (line.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`row ${rows.length + 1} is not JSON`, { cause: error })
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new Error(`row ${rows.length + 1} is not a JSON object`)
    }
    if (rows.length === 0) {
      rows.push({ seq: 0, ...(record as Record<string, unknown>) } as unknown as ParsedRow)
      continue
    }
    if (typeof (record as Record<string, unknown>)['type'] !== 'string') {
      throw new Error(`row ${rows.length + 1} has no string "type"`)
    }
    rows.push(record as unknown as ParsedRow)
  }
  if (rows.length === 0) throw new Error('the log carries no JSONL record')
  return rows
}

/**
 * Canonical successor filename for one generation.
 *
 * Mirrors the released `generationLogFilename` (and `publish.ts`'s private
 * `successorFilename`, which is not exported): version 0 keeps the suffix-only
 * name, later generations carry `v<N>`.
 */
export function successorFilename(generation: number): string {
  return generation === 0 ? 'session.jsonl.zstd' : `session.v${generation}.jsonl.zstd`
}

/* ------------------------------------------------------------------ */
/* per-log work                                                        */
/* ------------------------------------------------------------------ */

/** What this run can say about one log. */
export type LogStatus = 'ok' | 'repairable' | 'unrepairable'

/** The outcome of one log. */
export interface LogOutcome {
  path: string
  /** Version of the generation this run inspected. */
  generation: number
  /** First-refusal class (the catalog's truth when an oracle resolved). */
  class: RefusalClass
  status: LogStatus
  /** Human-facing one-line explanation. */
  detail: string
  /** Structural findings collected over the rows (may be empty). */
  findings: Finding[]
  /**
   * Legacy `fallbacks/switch` events this run removes (in apply mode, from the
   * published successor) or would remove (report mode). Always `0` unless
   * `--drop-legacy-events` is on — the default path is strictly non-lossy.
   */
  droppedEventCount: number
  /** Whether `--class` let this run repair this log. */
  selected: boolean
  /** Basename of the successor generation this run published, else `null`. */
  published: string | null
  /**
   * A successor generation was ALREADY published and is proven to load: in
   * report mode by reading it back through the oracle, in apply mode by the
   * publisher accepting it as byte-identical to this repair's own output.
   */
  alreadyPublished: boolean
  /** A repair was attempted and threw (never a silent failure). */
  failed: boolean
}

/** Aggregate counts of one run (the exit code is derived from `refused`). */
export interface RunSummary {
  total: number
  ok: number
  /** Logs whose proof passes (whether or not this run applied it). */
  repairable: number
  /** Successors NEWLY published by this run (a re-run counts them as already published). */
  repaired: number
  /** Logs whose successor was already published and proven loadable. */
  alreadyPublished: number
  /** Logs no registered normalize step can repair. */
  unrepairable: number
  /** Repairs attempted and failed. */
  failed: number
  /** Repairable logs `--class` excluded from this run. */
  notSelected: number
  /** Logs still not loadable after this run — drives the exit code. */
  refused: number
  /** Log counts by first-refusal class. */
  byClass: Record<RefusalClass, number>
}

/** Whether one run writes (`apply`) or only reports (`report`). */
export type RunMode = 'report' | 'apply'

/** Everything one run produced. */
export interface RunResult {
  root: string
  mode: RunMode
  classFilter: RefusalClass | null
  catalog:
    | { resolved: true; modulePath: string; resolvedBy: CatalogResolvedBy }
    | { resolved: false }
  logs: LogOutcome[]
  summary: RunSummary
  exitCode: number
}

/** A fatal, non-per-log failure (bad input or unusable runtime/oracle). */
export class FatalError extends Error {}

/** One error's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run every selected rule's `normalize` over one log, chained in registry order.
 *
 * This is the PROOF gate: the chain is all-or-nothing, so a single unprovable
 * finding refuses the whole log and nothing is ever published for it. The input
 * rows are never mutated (each rule returns a new array).
 *
 * The chain runs in report mode too (it writes nothing), which is what lets a
 * dry run report the lossy drop count without touching a file.
 */
function runProof(
  rows: readonly ParsedRow[],
  rules: readonly LogRule[],
): { rows: ParsedRow[]; findings: Finding[] } | { refused: string } {
  let current: readonly ParsedRow[] = rows
  const findings: Finding[] = []
  for (const rule of rules) {
    const outcome = rule.normalize(current)
    if ('refused' in outcome) return { refused: `${rule.id}: ${outcome.refused}` }
    current = outcome.rows
    findings.push(...outcome.findings)
  }
  return { rows: [...current], findings }
}

/** What one log inspection needs from the surrounding run. */
interface InspectContext {
  apply: boolean
  backup: boolean
  classFilter: RefusalClass | null
  /**
   * Every rule this run's POLICY allows, unfiltered: the default registry, plus
   * the opt-in lossy rule when `--drop-legacy-events` is on. The structural
   * report pass uses this set (the report always covers every log, whatever
   * `--class` selected).
   */
  reportRules: readonly LogRule[]
  /** The rules the proof chain applies: `reportRules` narrowed by `--class`. */
  rules: readonly LogRule[]
  dropLegacyEvents: boolean
  catalog: CatalogHandle | null
  decodeZstdFrames(bytes: Buffer): string[]
  publishSuccessor: (
    logPath: string,
    rows: readonly ParsedRow[],
    catalog: CatalogHandle | null,
  ) => Promise<{ generation: number; verified: true }>
}

/** Copy the original generation aside, idempotently. */
async function writeBackup(logPath: string): Promise<string> {
  const backupPath = `${logPath}${BACKUP_SUFFIX}`
  try {
    await copyFile(logPath, backupPath, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const [original, existing] = await Promise.all([readFile(logPath), readFile(backupPath)])
    if (!original.equals(existing)) {
      throw new Error(`a backup already exists at ${backupPath} with different bytes`)
    }
  }
  return backupPath
}

/** The lossy evidence one log's detail line carries, or `''` in the non-lossy path. */
function lossyNote(count: number, applied: boolean): string {
  if (count === 0) return ''
  return applied
    ? `; LOSSY: ${count} legacy fallbacks/switch event(s) removed from the published successor`
    : `; LOSSY: ${count} legacy fallbacks/switch event(s) would be removed by --apply`
}

/**
 * The lossy drop's own PRE-WRITE proof: nothing is trusted, least of all the
 * count the chain reported.
 *
 *   (a) the reported count must be the number of PARSED legacy rows in the source
 *       log AND the real row-count delta of the repair, and no parsed legacy row
 *       may survive it. Byte-identity of every survivor is proven by the drop
 *       rule itself, over the same unmodified input (the drop rule runs first in
 *       a lossy chain) — see `legacyDropRefusal`;
 *   (b) the repaired rows must restore through the released catalog under the
 *       publisher's own STRICT policy, so a differently-unknown or unparseable
 *       row cannot hide behind the drop.
 *
 * @returns the reason the drop must not be written, or `null` when it is proven.
 */
function lossyDropRefusal(
  rows: readonly ParsedRow[],
  repaired: readonly ParsedRow[],
  reported: number,
  catalog: CatalogHandle | null,
): string | null {
  const removable = dropLegacyEventsRule.detect(rows).length
  if (reported !== removable) {
    return `the reported dropped count ${reported} is not the ${removable} parsed legacy fallbacks/switch row(s) of the source log`
  }
  const delta = rows.length - repaired.length
  if (delta !== removable) {
    return `the repair removed ${delta} row(s), while the source log carries ${removable} parsed legacy fallbacks/switch row(s)`
  }
  if (dropLegacyEventsRule.detect(repaired).length !== 0) {
    return 'a parsed legacy fallbacks/switch row survived the drop'
  }
  if (catalog === null) {
    return 'no released catalog resolved, so the post-drop restore cannot be proven — pass --catalog '
      + `(or set ${CATALOG_ENV_VAR}); nothing was written`
  }
  try {
    restoreRows(catalog.catalog, repaired, { recovery: 'strict', validation: 'transformed' })
  } catch (error) {
    return 'the repaired rows do not restore through the released catalog '
      + `(${messageOf(error)}), so a differently-unknown or unparseable row would remain; nothing was written`
  }
  return null
}

/** Classify one log, prove its repair, and publish it when `--apply` asks. */
async function inspectLog(candidate: LogGeneration, context: InspectContext): Promise<LogOutcome> {
  const base = {
    path: candidate.path,
    generation: candidate.generation,
    selected: true,
    published: null,
    alreadyPublished: false,
    failed: false,
    findings: [] as Finding[],
    droppedEventCount: 0,
  }

  let rows: ParsedRow[]
  try {
    rows = decodeRows(context.decodeZstdFrames(await readFile(candidate.path)))
  } catch (error) {
    return {
      ...base,
      class: 'decompress-failed',
      status: 'unrepairable',
      detail: `cannot decode the generation: ${messageOf(error)}`,
    }
  }

  // Structural pass over the FULL policy rule set is the report's evidence even
  // when the oracle (the released chain) is the authority on the class.
  const structural = classifyRows(rows, context.reportRules)
  const refusal =
    context.catalog === null ? structural.class : classifyWithCatalog(rows, context.catalog)

  if (refusal === 'ok') {
    return { ...base, class: 'ok', status: 'ok', detail: 'no refusal', findings: structural.findings }
  }

  // The lossy opt-in is the ONLY way `unknown-event-type` becomes repairable, and
  // only for a log that actually carries a legacy row to remove: a log refused for
  // any OTHER unknown event type keeps the fail-closed verdict, because no
  // registered rule removes that row (and nothing may ever drop it).
  const droppable = context.dropLegacyEvents ? dropLegacyEventsRule.detect(rows).length : 0
  const repairableClass =
    REPAIRABLE_CLASSES.has(refusal) || (refusal === 'unknown-event-type' && droppable > 0)

  if (!repairableClass) {
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      detail: `${refusal}: no registered normalize step can make this log load`,
      findings: structural.findings,
    }
  }

  const proof = runProof(rows, context.rules)
  if ('refused' in proof) {
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      detail: `${refusal}: the repair proof refused — ${proof.refused}`,
      findings: structural.findings,
    }
  }

  // Reported only when the run actually removes those rows from a published
  // successor (apply) or would remove them from one (report): a repair that
  // published nothing has dropped nothing.
  const dropped = droppedEventCount(proof.findings)

  // The lossy path's own PRE-WRITE proof. It gates BOTH modes, so a log whose drop
  // would leave another unknown event type (or an unparseable row) behind is
  // reported unrepairable instead of being repaired on hope; in apply mode nothing
  // is written — not even the --backup copy — before it passes.
  const lossyRefusal = dropped === 0 ? null : lossyDropRefusal(rows, proof.rows, dropped, context.catalog)
  if (lossyRefusal !== null) {
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      detail: `${refusal}: the lossy drop was refused before any write — ${lossyRefusal}`,
      findings: structural.findings,
    }
  }

  // The catalog is guaranteed here: a repairable class can only come from the
  // rule registry when no oracle resolved, and the publisher needs the oracle
  // anyway. Without an oracle the successor name is unknown, so nothing is
  // probed and `--apply` was already refused as fatal by the caller.
  const catalog = context.catalog
  const expected = catalog === null ? null : successorFilename(catalog.catalog.currentVersion)
  const successorPath = expected === null ? null : join(candidate.sessionDir, expected)
  const existingSuccessor =
    successorPath !== null && (await fileExists(successorPath)) ? successorPath : null
  // "Already published" is a POSITIVE, proven claim, never an existence claim:
  // report mode proves it by reading the existing generation back through the
  // oracle, apply mode by letting the publisher succeed (it only accepts an
  // existing successor holding exactly the bytes this repair would write).
  let alreadyPublished = false
  let successorNote = ''
  if (existingSuccessor !== null && !context.apply) {
    const successorClass = await classifyFile(existingSuccessor, context)
    alreadyPublished = successorClass === 'ok'
    successorNote = alreadyPublished
      ? `; the existing ${String(expected)} generation reads back with no refusal`
      : `; WARNING the existing ${String(expected)} generation is itself refused (${successorClass})`
  }
  const selected = context.classFilter === null || context.classFilter === refusal

  if (!context.apply) {
    return {
      ...base,
      class: refusal,
      status: 'repairable',
      selected,
      alreadyPublished,
      droppedEventCount: dropped,
      detail: `${
        alreadyPublished
          ? `repairable; the successor ${String(expected)} is already published and loadable${successorNote}`
          : `repairable; run with --apply to publish the successor generation${successorNote}`
      }${lossyNote(dropped, false)}`,
      findings: structural.findings,
    }
  }

  if (!selected) {
    return {
      ...base,
      class: refusal,
      status: 'repairable',
      selected: false,
      alreadyPublished: false,
      detail: `repairable, but --class ${String(context.classFilter)} excludes this class from this run`,
      findings: structural.findings,
    }
  }

  if (context.backup) {
    try {
      await writeBackup(candidate.path)
    } catch (error) {
      return {
        ...base,
        class: refusal,
        status: 'unrepairable',
        failed: true,
        detail: `backup failed, nothing was published: ${messageOf(error)}`,
        findings: structural.findings,
      }
    }
  }

  try {
    const result = await context.publishSuccessor(candidate.path, proof.rows, context.catalog)
    const published = successorFilename(result.generation)
    return {
      ...base,
      class: refusal,
      status: 'repairable',
      selected: true,
      published,
      alreadyPublished: existingSuccessor !== null,
      droppedEventCount: dropped,
      detail: `${
        existingSuccessor !== null
          ? `already published ${published} (verified byte-identical)`
          : `published ${published}; read back through the catalog with validation: 'current'`
      }${lossyNote(dropped, true)}`,
      findings: structural.findings,
    }
  } catch (error) {
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      failed: true,
      detail: `repair failed, nothing was published: ${messageOf(error)}`,
      findings: structural.findings,
    }
  }
}

/**
 * The refusal class of one EXISTING generation, read through the same oracle as
 * a candidate (report mode's proof that an already-published successor loads).
 */
async function classifyFile(path: string, context: InspectContext): Promise<RefusalClass> {
  try {
    const rows = decodeRows(context.decodeZstdFrames(await readFile(path)))
    return context.catalog === null ? classifyRows(rows, BUILT_IN_RULES).class : classifyWithCatalog(rows, context.catalog)
  } catch {
    return 'decompress-failed'
  }
}

/** Whether one path is a file (never throws). */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Whether one path is a directory (never throws). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The rules one run's POLICY allows, in check order.
 *
 * The default is the strictly non-lossy registry. With `--drop-legacy-events` the
 * never-repairable `fallbacks-switch` detector is REPLACED by the lossy
 * `drop-legacy-events` rule: both cover exactly the legacy rows, one refuses what
 * the other removes, and only one of them may sit in a chain.
 *
 * The drop rule runs FIRST so its input is the UNMODIFIED log: that is what lets
 * the rule prove every survivor byte-identical to its source row (any later
 * position would see the other rules' legitimate rewrites).
 */
function policyRules(dropLegacyEvents: boolean): readonly LogRule[] {
  if (!dropLegacyEvents) return BUILT_IN_RULES
  return [
    dropLegacyEventsRule,
    ...BUILT_IN_RULES.filter((rule) => rule.id !== fallbacksSwitchRule.id),
  ]
}

/**
 * Do the work: resolve the oracle, triage every candidate, and publish when
 * `--apply` asks for it.
 *
 * @throws FatalError on a missing `--root`, a runtime without `node:zlib` zstd,
 *   `--apply` without a resolved catalog, or `--apply --drop-legacy-events`
 *   without `--backup` (no write happens in those cases).
 */
export async function runRepair(
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  // The lossy opt-in is the one write that removes data from the readable
  // session, so an `--apply` run must not proceed without a byte copy of the only
  // generation that still holds those bytes. Checked before anything is read.
  if (options.apply && options.dropLegacyEvents && !options.backup) {
    throw new FatalError(
      '--drop-legacy-events with --apply requires --backup: the dropped rows are the provider/model '
      + 'switch audit trail of the session, and the original generation is the only place those bytes '
      + 'survive. Re-run with --backup (the original is copied to <name>.bak before publication), or '
      + 'drop --apply for a read-only report of what would be dropped.',
    )
  }

  if (!(await isDirectory(options.root))) {
    throw new FatalError(`--root directory not found: ${options.root}`)
  }

  // Probe BEFORE importing the publisher: its `node:zlib` zstd named imports do
  // not exist on Node < 22.15, so an old runtime would die with a module-link
  // stack trace instead of an actionable message.
  const problem = zstdRuntimeProblem(await import('node:zlib'))
  if (problem !== null) throw new FatalError(problem)

  const publishing = await import('./session-logs/publish.ts')
  const catalog = await resolveCatalog({ catalogPath: options.catalogPath, env })
  if (options.apply) {
    // Reuse the publisher's own guard: the same refusal and the same message.
    try {
      publishing.assertCatalog(catalog)
    } catch (error) {
      throw new FatalError(messageOf(error))
    }
  }

  const reportRules = policyRules(options.dropLegacyEvents)
  const rules =
    options.classFilter === null
      ? reportRules
      : reportRules.filter((rule) => rule.class === options.classFilter)
  const candidates = await findGenerations(options.root)
  const context: InspectContext = {
    apply: options.apply,
    backup: options.backup,
    classFilter: options.classFilter,
    reportRules,
    rules,
    dropLegacyEvents: options.dropLegacyEvents,
    catalog,
    decodeZstdFrames: publishing.decodeZstdFrames,
    publishSuccessor: publishing.publishSuccessor,
  }

  const logs: LogOutcome[] = []
  for (const candidate of candidates) logs.push(await inspectLog(candidate, context))

  const summary = summarize(logs)
  return {
    root: options.root,
    mode: options.apply ? 'apply' : 'report',
    classFilter: options.classFilter,
    catalog:
      catalog === null
        ? { resolved: false }
        : { resolved: true, modulePath: catalog.modulePath, resolvedBy: catalog.resolvedBy },
    logs,
    summary,
    exitCode: summary.refused > 0 ? EXIT_REFUSED : EXIT_CLEAN,
  }
}

/** Count one run's outcomes. */
function summarize(logs: readonly LogOutcome[]): RunSummary {
  const byClass = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0])) as Record<RefusalClass, number>
  const summary: RunSummary = {
    total: logs.length,
    ok: 0,
    repairable: 0,
    repaired: 0,
    alreadyPublished: 0,
    unrepairable: 0,
    failed: 0,
    notSelected: 0,
    refused: 0,
    byClass,
  }
  for (const log of logs) {
    summary.byClass[log.class] += 1
    if (log.status === 'ok') summary.ok += 1
    if (log.status === 'repairable') summary.repairable += 1
    if (log.status === 'unrepairable') summary.unrepairable += 1
    if (log.published !== null && !log.alreadyPublished) summary.repaired += 1
    if (log.alreadyPublished) summary.alreadyPublished += 1
    if (log.failed) summary.failed += 1
    if (log.status === 'repairable' && !log.selected) summary.notSelected += 1
    // A proven already-published successor means the session loads again, so the
    // refusal is not open any more; anything else without a published successor
    // still counts against the run.
    if (log.status !== 'ok' && log.published === null && !log.alreadyPublished) summary.refused += 1
  }
  return summary
}

/* ------------------------------------------------------------------ */
/* reporting                                                           */
/* ------------------------------------------------------------------ */

/** Output sinks (injectable so tests read the report without a child process). */
export interface CliIO {
  out(text: string): void
  err(text: string): void
}

/** The default sinks: one line per call on stdout / stderr. */
export function consoleIO(): CliIO {
  return {
    out: (text) => {
      process.stdout.write(`${text}\n`)
    },
    err: (text) => {
      process.stderr.write(`${text}\n`)
    },
  }
}

/**
 * The per-log status token: `ok`, the class, `unrepairable`, or — when the lossy
 * opt-in removes (or would remove) legacy events — a distinct `lossy` token.
 */
function token(log: LogOutcome, mode: RunMode): string {
  if (log.status === 'ok') return 'ok'
  if (log.status === 'unrepairable') return 'unrepairable'
  if (log.droppedEventCount === 0) return log.class
  return mode === 'apply'
    ? `repaired-lossy (${log.droppedEventCount} events dropped)`
    : `lossy-repairable (${log.droppedEventCount} events to drop)`
}

/** The loud `--apply` precondition line (never suppressed, not even by --quiet). */
export function preconditionNotice(): string {
  return [
    '!! --apply PRECONDITION: run this only while NO dsh instance is writing the sessions under --root.',
    '!! The successor generation is linked beside the original WITHOUT observing the host flock lease,',
    "!! so a dsh that is still appending to the old generation would be orphaned once the host prefers",
    '!! the successor. Stop dsh first. Rollback = delete the successor generation (the original stays).',
  ].join('\n')
}

/**
 * The loud static data-loss warning for a lossy `--apply` run, printed BEFORE the
 * run (never suppressed, not even by --quiet): the counts are only known once the
 * logs are decoded, so they follow in {@link lossyResultNotice}.
 */
export function lossyApplyNotice(): string {
  return [
    '!! --drop-legacy-events is LOSSY: every published successor leaves out its legacy',
    '!! fallbacks/switch events. Those rows are the provider/model switch audit trail of the',
    '!! session. The original generation is never modified and --backup keeps a byte copy of it,',
    '!! so the successor is the only readable generation that lacks them. An unknown event type of',
    '!! any OTHER name is never dropped: such a log stays unrepairable and nothing is written for it.',
  ].join('\n')
}

/**
 * The count-bearing lossy report of one finished run, or `null` when this run
 * drops nothing (every non-lossy run, and any lossy run that published nothing).
 */
export function lossyResultNotice(result: RunResult): string | null {
  const logs = result.logs.filter((log) => log.droppedEventCount > 0)
  if (logs.length === 0) return null
  const dropped = logs.reduce((total, log) => total + log.droppedEventCount, 0)
  const effect = result.mode === 'apply'
    ? 'those audit rows are gone from the published successor(s); the original generations and their '
      + '--backup copies keep the bytes'
    : 'nothing was written: an --apply run with --backup is what removes them'
  return [
    `!! LOSSY: ${result.mode === 'apply' ? 'dropped' : 'would drop'} ${dropped} legacy fallbacks/switch `
    + `event(s) in ${logs.length} log(s) —`,
    `!! ${effect}.`,
  ].join('\n')
}

/** The text report (per-log lines + per-class table + summary line). */
function reportText(result: RunResult, io: CliIO, quiet: boolean): void {
  io.out(
    `${PROGRAM}: ${
      result.mode === 'apply' ? 'apply (publishes successor generations; originals are never modified)' : 'report only (no write)'
    }`,
  )
  io.out(`root: ${result.root}`)
  io.out(
    result.catalog.resolved
      ? `catalog: ${result.catalog.modulePath} (resolved by ${result.catalog.resolvedBy})`
      : `catalog: none resolved — classification is STRUCTURAL ONLY and --apply would refuse `
        + `(no --catalog, no ${CATALOG_ENV_VAR}, no dsh on PATH, no npx install)`,
  )
  if (result.classFilter !== null) {
    io.out(`class filter: ${result.classFilter} (rules restricted; the report and the exit code still cover every log)`)
  }

  if (!quiet) {
    if (result.logs.length === 0) {
      io.out(`  no session log with a canonical generation below v${CURRENT_VERSION_FLOOR} under this root`)
    }
    for (const log of result.logs) {
      io.out(`  ${token(log, result.mode).padEnd(TOKEN_WIDTH)} ${log.path} (v${log.generation}): ${log.detail}`)
    }
    io.out('')
    io.out('class                        logs')
    for (const name of CLASS_NAMES) {
      io.out(`${name.padEnd(TOKEN_WIDTH)} ${String(result.summary.byClass[name]).padStart(4)}`)
    }
  }

  const summary = result.summary
  io.out(
    `summary: ${summary.total} log(s) | ok ${summary.ok} | repairable ${summary.repairable} `
    + `| unrepairable ${summary.unrepairable} | repaired ${summary.repaired} `
    + `| already published ${summary.alreadyPublished} | failed ${summary.failed} `
    + `| not selected ${summary.notSelected} | refused ${summary.refused}`,
  )
}

/** The machine-readable report: the same data the text report prints. */
function reportJson(result: RunResult, io: CliIO): void {
  io.out(JSON.stringify(result, null, 2))
}

/**
 * Print one run's report and return its exit code.
 *
 * @param options parsed command line.
 * @param io output sinks.
 * @param env environment the oracle resolution and the default root read.
 */
export async function execute(
  options: CliOptions,
  io: CliIO = consoleIO(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (options.apply) io.err(preconditionNotice())
  if (options.apply && options.dropLegacyEvents) io.err(lossyApplyNotice())
  let result: RunResult
  try {
    result = await runRepair(options, env)
  } catch (error) {
    if (error instanceof FatalError) {
      io.err(`${PROGRAM}: ${error.message}`)
      return EXIT_FATAL
    }
    throw error
  }
  if (options.json) reportJson(result, io)
  else reportText(result, io, options.quiet)
  const lossy = lossyResultNotice(result)
  if (lossy !== null) io.err(lossy)
  return result.exitCode
}

/* ------------------------------------------------------------------ */
/* usage                                                               */
/* ------------------------------------------------------------------ */

/** The full usage text (`--help`), including the `--apply` precondition. */
export function usage(): string {
  return `usage: pnpm repair:session-logs -- [--root DIR] [--apply] [--class NAME]
                         [--catalog PATH] [--backup] [--drop-legacy-events]
                         [--json] [--quiet]

Triage (default, read-only) and repair (--apply) pre-V3 dsh session logs. A log is
refused when the FROZEN released migration chain cannot classify it; this tool names
the refusal class and, for the classes whose normalization is provably
shape-preserving, publishes a current-generation successor beside the original. The
original generation is never modified and never truncated.

  --root DIR     session root to walk (default: $DSH_HOME or ~/.dsh, then /sessions).
                 Every <namespace>/<session>/ directory's newest canonical generation
                 below format v${CURRENT_VERSION_FLOOR} is considered; noncanonical names (staged
                 .tmp files, .bak copies) are ignored, and a current generation already
                 present beside it is reported as an already published successor (proven
                 by a read-back) instead of being a repair target.
  --apply        run the rules' proofs and publish a successor generation per repaired
                 log. Requires a resolved catalog. Default: read-only report.
  --class NAME   restrict RULE APPLICATION to one class (default: all rules). Names:
                 ${CLASS_NAMES.join(' | ')}.
                 The report and the exit code still cover every log under --root, so
                 --class never hides a refusal; it only decides what --apply repairs.
  --catalog PATH explicit released catalog path (package directory, a directory holding
                 it, or its module entry file). Default resolution order:
                 $${CATALOG_ENV_VAR}, the dsh binary on PATH, newest ~/.npm/_npx install.
  --backup       copy the original generation to <name>.bak before publishing.
  --drop-legacy-events
                 LOSSY, off by default: remove the legacy fallbacks/switch rows (the
                 provider/model switch audit trail this repo's own pre-#52 plugin wrote)
                 instead of refusing the log. The frozen V0->V1 edge refuses that event
                 type even with "ignorable: true", so no rewrite can keep it: removal is
                 the only in-repo recovery, and the rows survive only in the original
                 .zstd (hence the --backup requirement below). Report mode writes
                 nothing and only counts what would be dropped; with --apply this flag
                 REQUIRES --backup (exit 2 without it). An unknown event type of any
                 other name is never dropped.
                 LIMIT (measured): the same edge requires each event's seq to equal its
                 running event count, so a removed row leaves a seq gap unless it is the
                 LAST event of the generation. A mid-sequence legacy row therefore makes
                 the run refuse the log and write nothing (the shape of every
                 legacy-blocked log in this repo's own store).
  --json         emit one machine-readable JSON document instead of the text report.
  --quiet        suppress the per-log lines and the by-class table (the header and the
                 summary line still print; warnings and errors are never suppressed).
  --help, -h     show this help and exit 0.

PRECONDITION for --apply: run it only while NO dsh instance is writing the sessions
under --root. The successor is linked into the session directory without observing the
host's flock lease (that lease is host-internal and cannot be taken from this repo), so
a dsh that is still appending to the old generation would be orphaned once the host
prefers the successor. Stop dsh first. Rollback: delete the successor generation.

RUNTIME: reading and writing session logs needs node:zlib zstd (Node >= 22.15, while
engines.node allows >= 22); a runtime without it fails closed with exit 2.

EXIT CODES: 0 = nothing refused, or every refusal repaired; 1 = completed with at least
one log still refused/unrepairable (or a repair failed); 2 = fatal (bad arguments,
missing --root, --apply without a resolved catalog, --apply --drop-legacy-events without
--backup, or a runtime without node:zlib zstd).`
}

/**
 * The CLI entry point: parse, print usage on a malformed command line, else run.
 *
 * @returns the process exit code (see the module docblock).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: CliIO = consoleIO(),
): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv, env)
  } catch (error) {
    io.err(`${PROGRAM}: ${messageOf(error)}`)
    io.err('')
    io.err(usage())
    return EXIT_FATAL
  }
  if (options.help) {
    io.out(usage())
    return EXIT_CLEAN
  }
  return execute(options, io, env)
}

// Run only when executed directly (tsx scripts/repair-session-logs.ts) —
// importing the module (unit tests) must not start the CLI.
const entry = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entry) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`${PROGRAM} failed: ${messageOf(error)}\n`)
      process.exitCode = EXIT_FATAL
    },
  )
}
