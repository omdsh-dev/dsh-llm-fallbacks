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
 * dropped: such a log stays unrepairable. The run reports the legacy-row
 * population of the source log, the dropped-event and renumbered-event counts per
 * log (`legacyEventCount` / `droppedEventCount` / `renumberedEventCount` in
 * `--json`) and warns loudly on stderr; the post-drop restore and the published
 * read-back are still the proof of success.
 *
 * WHY THE SURVIVORS ARE RENUMBERED: the same V0→V1 edge requires every event's
 * `seq` to equal its running event count (packed Assistant runs are checked by
 * `seq0` and advance the count by their payload length), so removing a row is
 * loadable only when the removed rows are the LAST events of the generation.
 * A legacy row in the middle leaves the survivors with a gap, so the opt-in mode
 * renumbers every surviving event to its position in the surviving event stream
 * and shifts each surviving Session-seq reference (`seq`, packed `seq0`,
 * `sourceEventSeqs`, `surfaceOp`, and the payload references the released
 * remappers audit) by the same monotone shift. Content is otherwise byte-identical.
 *
 * REFERENCE INTEGRITY IS A HARD GATE: when a surviving row's reference names a
 * dropped seq (a delivery-independent reference to one of the removed events),
 * renumbering it would silently point it at a different event. The gate therefore
 * refuses the whole file, writes nothing, and reports the offending row + field —
 * a correct fail-closed outcome, never a renumbering failure. The same gate
 * refuses a file whose source rows are not densely numbered, and one whose drop
 * would renumber across the header's seed cut.
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
 * DISCOVERY IS NOT ALLOWED TO FAIL OPEN: a namespace/session directory the walk
 * cannot read, and a canonical generation that is a symlink or not a regular
 * file, are collected with their errno into `skipped` (text report AND `--json`),
 * folded into the non-zero exit code, and they suppress the "no session log …"
 * line, which otherwise describes an empty root. An unreadable ROOT is fatal
 * (exit 2) rather than an empty report — it is the one input whose failure hides
 * every log at once. Symlinked entries are reported, never followed: writes must
 * stay inside `--root`. A stale `session.repair.*.jsonl.zstd.tmp` (the residue of
 * an interrupted run) is reported too, and never deleted by this tool.
 *
 * `--class NAME` restricts RULE APPLICATION to one class (default: all rules),
 * which is what `--apply` will repair. It never narrows the listing, the class
 * table or the exit code: the report's `repairable` verdict is always computed
 * over the FULL policy, and a log the filtered chain cannot repair on its own is
 * reported as such — so the flag can never hide a refusal, and the report never
 * promises a repair the same invocation would fail to perform.
 *
 * TWO POLICIES, AND THE REPORT SAYS WHICH ONE SAID `ok`: a log's class and its
 * `ok` come from the host loader's policy (`recovery: 'recoverable'`), which is
 * what decides whether the GUI opens the session — but that policy can swallow a
 * refusal and drop the rows after it. Every `ok` log is therefore cross-checked
 * with the SAME loader policy under STRICT recovery (one axis apart, so a refusal
 * there means rows were dropped rather than "not current-shaped"): when it refuses,
 * the log is reported
 * as `ok-truncated` (a distinct token, an `okTruncated` summary count and a
 * `strictRefusal` reason in `--json`) because the session opens WITHOUT the rows
 * the strict policy rejects. Its exit code stays `0`: those sessions do load.
 *
 * PRECONDITION for `--apply` (printed loudly, never enforced): run it only while
 * NO dsh instance is writing the sessions under `--root`. The publisher links
 * the successor into the session directory without observing the host's flock
 * lease (`lease.ts:40` in `@deepseek-ai/dsh-session-persistence-jsonl`; the
 * flock addon is host-internal, so this repo cannot take it), which means a
 * still-running older dsh would keep appending to a generation the host stops
 * preferring. The publisher compares the digest of the revision this run
 * DECODED with the file before staging anything, so a concurrent append is
 * refused before the first write instead of being published as a verified
 * successor; if the source moves after a publication this run CREATED, that
 * successor is unlinked again, and if it moves after accepting a pre-existing
 * identical one the failure names that file and says to delete it. Rollback is
 * `rm` of the successor generation — the original is authoritative and
 * byte-identical.
 *
 * RUNTIME FLOOR: reading and writing need `node:zlib` zstd, added in Node 22.15
 * (`engines.node` says `>= 22`). Availability is PROBED before the zstd-
 * dependent module is imported, so an older runtime gets an actionable message
 * and exit 2 instead of a module-link stack trace (see `zstdRuntimeProblem`).
 *
 * EXIT CODES: 0 = every log loads (a session that opens with rows dropped under
 * the strict policy is reported `ok-truncated` and still exits 0); 1 = at least
 * one log is still refused/unrepairable, a repair failed, a log was left
 * unpublished (including one `--class` excluded), an input could not be inspected
 * at all (`skipped`), or a stale `session.repair.*.jsonl.zstd.tmp` was found under
 * the root; 2 = fatal (bad arguments, missing/unreadable
 * `--root`, `--apply` without a resolved catalog, a catalog below the required
 * format version, `--apply --drop-legacy-events` without `--backup`, or a runtime
 * without zstd).
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classifyRows } from './session-logs/classify.ts'
import {
  CATALOG_ENV_VAR,
  REQUIRED_CATALOG_VERSION,
  catalogVersionRefusal,
  classifyWithCatalog,
  resolveCatalog,
  restoreRows,
} from './session-logs/catalog.ts'
import type { CatalogHandle, CatalogResolvedBy } from './session-logs/catalog.ts'
import {
  BUILT_IN_RULES,
  REFUSAL_CLASSES,
  dropLegacyEventsRule,
  droppedEventCount,
  fallbacksSwitchRule,
  legacyDropSplit,
  lossyRefusalReason,
  renumberSurvivingEvents,
} from './session-logs/rules.ts'
import type { Finding, LogRule, LossyRefusalReason, ParsedRow, RefusalClass } from './session-logs/rules.ts'

/** Program name used in every diagnostic line. */
const PROGRAM = 'repair-session-logs'

/**
 * Format version at which the released chain is current: generations BELOW it are
 * triaged (the "pre-V3" scope of the plan) and it is also the floor the resolved
 * catalog must satisfy to be trusted as this run's oracle — one constant, so the
 * scope and the oracle pin cannot drift (`REQUIRED_CATALOG_VERSION`).
 */
const CURRENT_VERSION_FLOOR = REQUIRED_CATALOG_VERSION

/**
 * What "repairable" means for one log, derived from the RUN'S OWN RULE SET rather
 * than from a literal: the classes of the rules that can make a log of their class
 * load at all (a detector that only reports answers `false`, and the lossy rule
 * answers per log, which is what this tool used to special-case by hand). Adding a
 * rule is therefore enough to make its class repairable.
 */
function repairableClasses(rules: readonly LogRule[], rows: readonly ParsedRow[]): ReadonlySet<RefusalClass> {
  return new Set(rules.filter((rule) => rule.repairable(rows)).map((rule) => rule.class))
}

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
  const match = REFUSAL_CLASSES.find((name) => name === value)
  if (match === undefined) throw new Error(`unknown --class ${value}; expected one of ${REFUSAL_CLASSES.join(', ')}`)
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

/** One input the walk could not inspect, with the reason it could not. */
export interface SkippedEntry {
  /** Path of the unreadable/irregular entry (or of the directory that failed). */
  path: string
  /** The errno (or the shape) that stopped the walk, e.g. `EACCES: …` or `symlink`. */
  reason: string
}

/** Everything one walk of a session root found. */
export interface DiscoveryResult {
  /** The triage candidates, sorted by path so a report is reproducible. */
  generations: LogGeneration[]
  /** Entries that could not be inspected: reported, counted, and non-zero. */
  skipped: SkippedEntry[]
  /** Residue of an interrupted run (`session.repair.*.jsonl.zstd.tmp`); never deleted here. */
  staleStagingFiles: string[]
  /**
   * Why the ROOT itself could not be read, or `null`. The caller turns this into a
   * fatal (exit 2): an unreadable root hides every log at once, which must not read
   * as an empty store.
   */
  rootFailure: string | null
}

/** One error's short reason: its errno when it has one, else its message. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && code.length > 0 ? `${code}: ${messageOf(error)}` : messageOf(error)
}

/** Whether one name is the residue of an interrupted publication. */
function isStaleStagingName(name: string): boolean {
  return name.startsWith('session.repair.') && name.endsWith('.jsonl.zstd.tmp')
}

/**
 * Every immediate subdirectory of one directory, sorted.
 *
 * A `readdir` failure is REPORTED (the directory's own path + errno), never
 * swallowed into an empty list, and a symlinked directory is reported rather than
 * followed: this tool writes beside the generation it repairs, so following a link
 * could place a successor or a `.bak` outside `--root`.
 */
async function subdirectories(dir: string, skipped: SkippedEntry[]): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    skipped.push({ path: dir, reason: reasonOf(error) })
    return []
  }
  const directories: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      directories.push(path)
      continue
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ path, reason: 'symlink (not followed: a repair would write beside its target, outside --root)' })
    }
  }
  return directories.sort()
}

/**
 * The newest canonical generation of one session directory below the
 * current-format floor, or `null` when the directory holds none.
 *
 * A generation at or above the floor is deliberately ignored *when selecting*
 * (the host already prefers it), but its presence does not hide a pre-V3
 * generation: the caller reports such a log as already published instead of
 * silently skipping the session. A canonical NAME that is a symlink or not a
 * regular file is reported as skipped — never silently dropped — while
 * noncanonical names (`.tmp`, `.bak`, uppercase) are not candidates at all; the
 * staged-publication residue is collected separately so an interrupted run is
 * visible instead of forgotten.
 */
async function newestPreCurrentGeneration(
  sessionDir: string,
  skipped: SkippedEntry[],
  staleStagingFiles: string[],
): Promise<LogGeneration | null> {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (error) {
    skipped.push({ path: sessionDir, reason: reasonOf(error) })
    return null
  }
  let best: LogGeneration | null = null
  for (const entry of entries) {
    if (isStaleStagingName(entry.name)) staleStagingFiles.push(join(sessionDir, entry.name))
    const generation = canonicalGeneration(entry.name)
    if (generation === null || generation >= CURRENT_VERSION_FLOOR) continue
    const path = join(sessionDir, entry.name)
    if (!entry.isFile()) {
      skipped.push({
        path,
        reason: entry.isSymbolicLink()
          ? 'symlink (not followed: a repair would write beside its target, outside --root)'
          : 'not a regular file',
      })
      continue
    }
    if (best === null || generation > best.generation) {
      best = { path, generation, sessionDir }
    }
  }
  return best
}

/**
 * Every triage candidate under one session root (see the module docblock), plus
 * everything the walk could not inspect and the reason it could not.
 *
 * @param root session root (`<root>/<namespace>/<session>/<generation>`).
 */
export async function findGenerations(root: string): Promise<DiscoveryResult> {
  const skipped: SkippedEntry[] = []
  const staleStagingFiles: string[] = []
  const found: LogGeneration[] = []
  const rootFailure = await readableDirectoryProblem(root)
  if (rootFailure !== null) return { generations: [], skipped, staleStagingFiles, rootFailure }
  for (const namespace of await subdirectories(root, skipped)) {
    for (const session of await subdirectories(namespace, skipped)) {
      const generation = await newestPreCurrentGeneration(session, skipped, staleStagingFiles)
      if (generation !== null) found.push(generation)
    }
  }
  return {
    generations: found.sort((left, right) => left.path.localeCompare(right.path)),
    skipped,
    staleStagingFiles: staleStagingFiles.sort(),
    rootFailure: null,
  }
}

/** Why `dir` cannot be walked, or `null` when it can be read. */
async function readableDirectoryProblem(dir: string): Promise<string | null> {
  try {
    await readdir(dir)
    return null
  } catch (error) {
    return `--root cannot be read: ${dir} (${reasonOf(error)}). Refusing to report an empty store for a root this `
      + 'process cannot inspect.'
  }
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
  /**
   * Why the released chain with STRICT recovery (the host loader's own validation
   * axis) refuses this log while the loader's lenient policy called it `ok`, or
   * `null` when that stricter attempt accepts the log — and also `null` when NO
   * oracle resolved, because then there is no strict verdict to report at all (the
   * report says STRUCTURAL ONLY). The two policies differ exactly by `recovery`, so
   * a refusal here means the session opens with the rows after it dropped; that is
   * why `token()` prints `ok-truncated` for it instead of a clean `ok`.
   */
  strictRefusal: string | null
  /** Human-facing one-line explanation. */
  detail: string
  /** Structural findings collected over the rows (may be empty). */
  findings: Finding[]
  /**
   * The parsed legacy `fallbacks/switch` rows of the SOURCE log — the drop's
   * candidate population, reported whether or not the flag is on and whether or
   * not the drop was accepted (`dropLegacyEventsRule.detect(rows).length`, never
   * derived from {@link droppedEventCount}). `0` therefore means "this log
   * carries no legacy row at all"; a non-zero population with
   * `droppedEventCount === 0` means the drop was refused or not requested.
   *
   * It stays `0` for the two states where the population is NOT measured, and both
   * are reported as such in `detail` (never presented as a measured zero): a log
   * that could not be decoded, and a log whose analysis threw before the count was
   * taken (`analysisFailureOutcome`).
   */
  legacyEventCount: number
  /**
   * Legacy rows removed from the successor this run published (in apply mode) or
   * would publish (in report mode). Always `0` when nothing is published for this
   * log — the default path is strictly non-lossy and a refused drop publishes
   * nothing — so it is NOT the log's legacy-row population.
   */
  droppedEventCount: number
  /**
   * Surviving events whose `seq` the renumber of the same successor changed (a
   * packed Assistant run counts its payload length). `0` unless a drop was
   * accepted.
   */
  renumberedEventCount: number
  /**
   * Why the opt-in lossy recovery did not apply to this log, when it did not:
   * `reference-integrity` (a surviving row names a dropped seq — the fail-closed
   * gate), `seed-cut` (the renumber would cross the header's seed cut), `other`
   * (the drop or the renumber could not be proven). `null` when the gate did not
   * stop this log.
   */
  lossyRefusal: LossyRefusalReason | null
  /** Whether `--class` let this run repair this log. */
  selected: boolean
  /** Basename of the successor generation this run published, else `null`. */
  published: string | null
  /**
   * Absolute path of a successor that IS on disk and was published from a stale
   * snapshot this run did not create, else `null`. Structured on purpose: with
   * `published: null` and `alreadyPublished: false` the free-text `detail` would be
   * the only thing distinguishing "nothing was published" from "a file is there and
   * must be deleted", which is exactly the reading C-2 forbids.
   */
  stalePublicationPath: string | null
  /**
   * A successor generation was ALREADY published and is proven to load: in
   * report mode by reading it back through the oracle, in apply mode by the
   * publisher accepting it as byte-identical to this repair's own output.
   */
  alreadyPublished: boolean
  /** A repair was attempted and threw (never a silent failure). */
  failed: boolean
}

/**
 * Aggregate counts of one run: the exit code is derived from `refused` — which
 * counts every log still not loadable after this run, including a repairable one
 * this invocation left unpublished — and from `skipped` (an input the walk could
 * not inspect at all).
 */
export interface RunSummary {
  total: number
  /** Logs the host loader's policy reads without refusal. */
  ok: number
  /**
   * Subset of `ok` that the STRICT current policy still refuses: those sessions
   * open with the rows after the swallowed refusal silently dropped. Counted
   * apart so `ok` is never read as "loads intact"; their exit code stays 0 because
   * they do load.
   */
  okTruncated: number
  /** Inputs the walk could not inspect (unreadable dir, symlink, irregular file). */
  skipped: number
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
    | {
      resolved: true
      modulePath: string
      resolvedBy: CatalogResolvedBy
      /** The catalog package's own version, when its manifest was readable. */
      packageVersion: string | null
      /** The format version that catalog declares as current. */
      currentVersion: number
    }
    | { resolved: false }
  logs: LogOutcome[]
  summary: RunSummary
  /** Every input the walk could not inspect, with its errno — never silent. */
  skipped: SkippedEntry[]
  /**
   * `session.repair.*.jsonl.zstd.tmp` residue found under the root (an interrupted
   * publication). Reported so it can be deleted; this tool never removes it.
   */
  staleStagingFiles: string[]
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

/** Hex sha256 of one byte buffer. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Why the released chain with STRICT recovery — the loader's own validation axis —
 * refuses these rows, or `null` when it accepts them (or when no oracle resolved:
 * without one there is no strict verdict to report, and the structural class
 * already says what this run knows).
 *
 * The defensive copy matters: the released restore normalizes some rows in place
 * (`publish.ts` step 3), and these rows are still the ones the run may publish.
 */
function strictRefusalOf(rows: readonly ParsedRow[], catalog: CatalogHandle | null): string | null {
  if (catalog === null) return null
  try {
    // STRICT RECOVERY, the host loader's own validation axis: the lenient policy
    // differs from this one exactly by `recovery`, so a refusal found here can only
    // mean the rows after it are dropped — not merely that the session is not
    // current-shaped. Using the publisher's `validation: 'current'` axis here would
    // over-claim truncation for a log that loses no rows at all.
    restoreRows(catalog.catalog, structuredClone(rows), { recovery: 'strict', validation: 'transformed' })
    return null
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    return cause === undefined ? messageOf(error) : `${messageOf(error)} (cause: ${messageOf(cause)})`
  }
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
  /** The rules the WRITE decision applies: `reportRules` narrowed by `--class`. */
  rules: readonly LogRule[]
  dropLegacyEvents: boolean
  catalog: CatalogHandle | null
  decodeZstdFrames(bytes: Buffer): string[]
  publishSuccessor: (
    logPath: string,
    rows: readonly ParsedRow[],
    catalog: CatalogHandle | null,
    sourceDigest: string,
  ) => Promise<{ generation: number; verified: true; targetPath: string; outcome: 'created' | 'accepted' }>
  /**
   * The successor path of a publication that happened from a stale snapshot, or
   * `null` for any other error. Lets this layer avoid reporting "nothing was
   * published" after a publication (the publisher classifies it).
   */
  stalePublicationPath(error: unknown): string | null
}

/**
 * Copy the original generation aside, idempotently.
 *
 * @returns the backup path and whether THIS call created it (a byte-identical
 *   copy that already existed is accepted but is not this run's to delete).
 * @throws when a pre-existing copy holds different bytes: that copy is the only
 *   pre-publication snapshot of some other revision, so this run cannot claim the
 *   guarantee `--backup` exists for — and the refusal names the file and the way
 *   out, because nothing else will.
 */
async function writeBackup(logPath: string): Promise<{ path: string; created: boolean }> {
  const backupPath = `${logPath}${BACKUP_SUFFIX}`
  try {
    await copyFile(logPath, backupPath, fsConstants.COPYFILE_EXCL)
    return { path: backupPath, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const [original, existing] = await Promise.all([readFile(logPath), readFile(backupPath)])
    if (!original.equals(existing)) {
      throw new Error(
        `a backup already exists at ${backupPath} and holds DIFFERENT bytes than the current original, so it is not `
        + 'a restorable copy of the revision this run would publish. Inspect it and delete it (or move it aside) to '
        + 'unblock the repair — until then every --apply --backup run for this session fails here and publishes '
        + 'nothing.',
      )
    }
    return { path: backupPath, created: false }
  }
}

/**
 * Undo the `.bak` copy THIS run created after its publication failed.
 *
 * A failed run must leave the session directory as it found it, which is what its
 * detail says ("nothing was published"). A backup that already existed before the
 * run is NOT this run's to delete and is left alone.
 *
 * @param backup the copy this run made (or `null` when `--backup` was off).
 * @returns a clause for the failure detail, or `''` when there is nothing to say.
 */
async function discardCreatedBackup(
  backup: { path: string; created: boolean } | null,
): Promise<string> {
  if (backup === null || !backup.created) return ''
  try {
    await rm(backup.path, { force: true })
    // "as it was" holds on every path that reaches here: a successor that
    // pre-existed was accepted (never written by this run), and one this run created
    // is unlinked by the publisher before this point.
    return '; the .bak copy this run created was removed again, so the session directory is as it was'
  } catch (error) {
    return `; WARNING the .bak copy this run created at ${backup.path} could NOT be removed (${messageOf(error)})`
  }
}

/** The lossy evidence one log's detail line carries, or `''` in the non-lossy path. */
function lossyNote(dropped: number, renumbered: number, applied: boolean): string {
  if (dropped === 0) return ''
  const events = `${dropped} legacy fallbacks/switch event(s)`
  const renumber = renumbered === 0 ? '' : ` and renumbered ${renumbered} surviving event(s)`
  return applied
    ? `; LOSSY: removed ${events}${renumber} from the published successor`
    : `; LOSSY: ${events} would be removed${renumber ? ` and ${renumbered} surviving event(s) renumbered` : ''} by --apply`
}

/** The lossy mode's own pre-write verdict for one log. */
type LossyVerdict =
  | { ok: true; renumberedEventCount: number }
  | { ok: false; refused: string; reason: LossyRefusalReason }

/**
 * The lossy mode's own PRE-WRITE proof: nothing is trusted, least of all the
 * count the chain reported.
 *
 *   (a) the reported count must be the number of PARSED legacy rows in the source
 *       log AND the real row-count delta of the repair, and no parsed legacy row
 *       may survive it. Byte-identity of every survivor is proven by the drop
 *       rule itself, over the same unmodified input (the drop rule runs first in
 *       a lossy chain) — see `legacyDropRefusal`;
 *   (b) the renumber must be reproducible over the drop's OWN survivors (`legacyDropSplit`,
 *       the one place the drop policy lives), re-deriving the gate (`reference integrity`,
 *       seed cut, dense numbering) and the renumbered count reported for this log;
 *   (c) the repaired rows must restore through the released catalog under the
 *       publisher's own STRICT policy, so a differently-unknown or unparseable
 *       row cannot hide behind the drop.
 *
 * @returns the verdict: the renumbered-event count, or the reason plus its
 *   category (which is what lets a refusal be counted by reason).
 */
function lossyDropRefusal(
  rows: readonly ParsedRow[],
  repaired: readonly ParsedRow[],
  reported: number,
  catalog: CatalogHandle | null,
): LossyVerdict {
  const removable = dropLegacyEventsRule.detect(rows).length
  if (reported !== removable) {
    return {
      ok: false,
      reason: 'other',
      refused: `the reported dropped count ${reported} is not the ${removable} parsed legacy fallbacks/switch row(s) of the source log`,
    }
  }
  const delta = rows.length - repaired.length
  if (delta !== removable) {
    return {
      ok: false,
      reason: 'other',
      refused: `the repair removed ${delta} row(s), while the source log carries ${removable} parsed legacy fallbacks/switch row(s)`,
    }
  }
  if (dropLegacyEventsRule.detect(repaired).length !== 0) {
    return { ok: false, reason: 'other', refused: 'a parsed legacy fallbacks/switch row survived the drop' }
  }
  // Re-derivation, NOT an independent oracle: the renumber is recomputed over the
  // drop's own survivors through the SAME gate (`legacyDropSplit` +
  // `renumberSurvivingEvents`), so a bug shared by the two would agree with itself
  // here — the rule's output-side dense-`seq` check and this re-derivation live in
  // the same function and therefore add input-walk-vs-output-rows evidence, not
  // independent evidence. What this buys is that the reported count and refusal
  // reason are properties of the ROWS rather than of the report; the genuinely
  // independent gate is the released strict restore below. The later rules
  // legitimately rewrite rows, so only the drop's own row count is compared.
  const { survivors } = legacyDropSplit(rows)
  if (survivors.length !== repaired.length) {
    return {
      ok: false,
      reason: 'other',
      refused: `the drop keeps ${survivors.length} row(s), while the repair chain normalized ${repaired.length}`,
    }
  }
  const renumber = renumberSurvivingEvents(rows, survivors)
  if ('refused' in renumber) {
    return { ok: false, reason: lossyRefusalReason(renumber.refused), refused: renumber.refused }
  }
  if (catalog === null) {
    return {
      ok: false,
      reason: 'other',
      refused: 'no released catalog resolved, so the post-drop restore cannot be proven — pass --catalog '
        + `(or set ${CATALOG_ENV_VAR}); nothing was written`,
    }
  }
  try {
    // A defensive copy: the released restore normalizes a packed Assistant run's
    // stream IN PLACE, and `repaired` is what the publisher is about to write.
    restoreRows(catalog.catalog, structuredClone(repaired), { recovery: 'strict', validation: 'transformed' })
  } catch (error) {
    return {
      ok: false,
      reason: 'other',
      refused: 'the repaired rows do not restore through the released catalog '
        + `(${messageOf(error)}), so a differently-unknown or unparseable row would remain; nothing was written`,
    }
  }
  return { ok: true, renumberedEventCount: renumber.renumberedEventCount }
}

/**
 * Classify one log, prove its repair, and publish it when `--apply` asks.
 *
 * One unexpected throw anywhere in here must not void the whole corpus run, so the
 * analysis is delegated and a throw becomes THIS log's failure (`failed: true`,
 * which the exit code counts as refused) with the walk continuing.
 */
async function inspectLog(candidate: LogGeneration, context: InspectContext): Promise<LogOutcome> {
  try {
    return await analyzeLog(candidate, context)
  } catch (error) {
    return analysisFailureOutcome(candidate, error)
  }
}

/**
 * What one log reports when its analysis throws unexpectedly: `failed: true`
 * (which the exit code counts as refused) with the reason, so one bad log cannot
 * void the report for every other log in the run. Exported for the pin, since the
 * guard's reachability is by definition an unexpected condition.
 */
export function analysisFailureOutcome(candidate: LogGeneration, error: unknown): LogOutcome {
  return {
    path: candidate.path,
    generation: candidate.generation,
    // `other-refusal` is the vocabulary's own "no class could be established"
    // bucket: the failure happened before the refusal was known, so no measured
    // class is being claimed (and `failed: true` is what counts it).
    class: 'other-refusal',
    status: 'unrepairable',
    strictRefusal: null,
    detail: `analysis failed before this log's counts were known, nothing was written for this log: ${messageOf(error)}`,
    findings: [],
    legacyEventCount: 0,
    droppedEventCount: 0,
    renumberedEventCount: 0,
    lossyRefusal: null,
    selected: true,
    published: null,
    alreadyPublished: false,
    stalePublicationPath: null,
    failed: true,
  }
}

/** The body of {@link inspectLog}: classify, prove, and (with `--apply`) publish. */
async function analyzeLog(candidate: LogGeneration, context: InspectContext): Promise<LogOutcome> {
  const base = {
    path: candidate.path,
    generation: candidate.generation,
    selected: true,
    published: null,
    alreadyPublished: false,
    failed: false,
    findings: [] as Finding[],
    legacyEventCount: 0,
    droppedEventCount: 0,
    renumberedEventCount: 0,
    lossyRefusal: null as LossyRefusalReason | null,
    strictRefusal: null as string | null,
    stalePublicationPath: null as string | null,
  }

  let rows: ParsedRow[]
  let sourceDigest: string
  try {
    const sourceBytes = await readFile(candidate.path)
    // The digest of THIS read travels to the publisher, which refuses to write a
    // successor from any other revision (C-2): decoding and publishing must be
    // about the same bytes.
    sourceDigest = sha256(sourceBytes)
    rows = decodeRows(context.decodeZstdFrames(sourceBytes))
  } catch (error) {
    return {
      ...base,
      class: 'decompress-failed',
      status: 'unrepairable',
      detail: `cannot decode the generation: ${messageOf(error)}`,
    }
  }

  // The drop's candidate population, independent of the flag, of the verdict and
  // of the chain: `0` here means the log carries no legacy row at all (I1).
  const legacy = dropLegacyEventsRule.detect(rows).length

  // Structural pass over the FULL policy rule set is the report's evidence even
  // when the oracle (the released chain) is the authority on the class.
  const structural = classifyRows(rows, context.reportRules)
  // The oracle restore MUTATES the rows it validates (a packed Assistant run's
  // stream is normalized in place, `publish.ts` step 3), and these are the rows
  // the repair chain then renumbers and the publisher writes. It therefore gets a
  // defensive copy — the same one the publisher takes of its own input.
  const refusal =
    context.catalog === null ? structural.class : classifyWithCatalog(structuredClone(rows), context.catalog)

  if (refusal === 'ok') {
    // The lenient policy is the host loader's, so it decides "the GUI opens it" —
    // but it can swallow a refusal and silently drop the rows after it. Cross-check
    // the same policy under STRICT recovery and report the difference: a log that
    // opens with rows missing must never be printed as a clean `ok`. The legacy-row
    // population is measured here too, because such a log can carry one.
    const strictRefusal = strictRefusalOf(rows, context.catalog)
    return {
      ...base,
      class: 'ok',
      status: 'ok',
      strictRefusal,
      legacyEventCount: legacy,
      detail: strictRefusal === null
        ? 'no refusal'
        : "the host loader's policy reads no refusal, but the same loader policy with STRICT recovery refuses this "
          + `session, so it opens with the rows after that refusal silently dropped: ${strictRefusal}`,
      findings: structural.findings,
    }
  }

  // The report's repairable verdict is a property of the log under the run's FULL
  // policy — `--class` narrows what this invocation REPAIRS, never what the report
  // claims — and the repairable classes come from the REGISTRY (each rule answers
  // for its own class, and the lossy rule only for a log it can actually drop
  // from), so adding a rule is enough to make its class repairable.
  if (!repairableClasses(context.reportRules, rows).has(refusal)) {
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      legacyEventCount: legacy,
      detail: `${refusal}: no registered normalize step can make this log load`,
      findings: structural.findings,
    }
  }

  const fullProof = runProof(rows, context.reportRules)
  if ('refused' in fullProof) {
    const reason = lossyRefusalReason(fullProof.refused)
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      legacyEventCount: legacy,
      // Only the lossy rule's own refusal is a lossy verdict; another rule's
      // refusal is not this mode's doing (`runProof` prefixes the rule id).
      lossyRefusal: fullProof.refused.startsWith(`${dropLegacyEventsRule.id}: `) ? reason : null,
      detail: `${refusal}: the repair proof refused — ${fullProof.refused}`,
      findings: structural.findings,
    }
  }

  // What THIS invocation would actually write: the same chain narrowed by `--class`.
  // When the full policy repairs the log but the selected class's rules alone do
  // not, the run says so and writes nothing for it — the report must not promise a
  // repair the same invocation cannot perform.
  const proof = context.classFilter === null ? fullProof : runProof(rows, context.rules)
  // A filtered chain can also succeed while performing LESS than the full policy:
  // with `--drop-legacy-events --class source-kind` the drop rule is out of the
  // selected chain, so the policy's only repair for the legacy rows is not applied
  // and `--apply` would hand rows the publisher then refuses. The promise must
  // account for the enabled policy, not only for the selected class.
  if (context.classFilter !== null
    && droppedEventCount(fullProof.findings) > 0
    && droppedEventCount('findings' in proof ? proof.findings : []) === 0) {
    return {
      ...base,
      class: refusal,
      status: 'repairable',
      selected: false,
      legacyEventCount: legacy,
      detail: `repairable by the full policy, but --class ${String(context.classFilter)} excludes the rule that `
        + 'removes this log\'s legacy fallbacks/switch row(s), so --apply with this filter cannot publish it',
      findings: structural.findings,
    }
  }
  if ('refused' in proof) {
    return {
      ...base,
      class: refusal,
      status: 'repairable',
      selected: false,
      legacyEventCount: legacy,
      detail: `repairable by the full rule chain; --class ${String(context.classFilter)} alone cannot repair this `
        + `log, so this run writes nothing for it (${proof.refused})`,
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
  const verdict = dropped === 0 ? null : lossyDropRefusal(rows, proof.rows, dropped, context.catalog)
  if (verdict !== null && !verdict.ok) {
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      legacyEventCount: legacy,
      lossyRefusal: verdict.reason,
      // `droppedEventCount` stays 0: nothing was published, so nothing readable
      // lost an event. The candidate population and the refusal reason above are
      // what make that 0 unambiguous.
      detail: `${refusal}: the lossy drop was refused before any write — ${verdict.refused} `
        + `(${legacy} legacy fallbacks/switch row(s) in the source log, nothing written)`,
      findings: structural.findings,
    }
  }
  const renumbered = verdict === null ? 0 : verdict.renumberedEventCount

  // The successor NAME needs the catalog's current version, so it is only known
  // with a resolved oracle: in report mode without one nothing is probed (the log
  // is still reported `repairable` from the rule registry alone), and `--apply`
  // was already refused as fatal by the caller — which is why the null case is
  // checked here rather than assumed away.
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
      legacyEventCount: legacy,
      droppedEventCount: dropped,
      renumberedEventCount: renumbered,
      detail: `${
        alreadyPublished
          ? `repairable; the successor ${String(expected)} is already published and loadable${successorNote}`
          : `repairable; run with --apply to publish the successor generation${successorNote}`
      }${lossyNote(dropped, renumbered, false)}`,
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
      legacyEventCount: legacy,
      detail: `repairable, but --class ${String(context.classFilter)} excludes this class from this run`,
      findings: structural.findings,
    }
  }

  let backup: { path: string; created: boolean } | null = null
  if (context.backup) {
    try {
      backup = await writeBackup(candidate.path)
    } catch (error) {
      return {
        ...base,
        class: refusal,
        status: 'unrepairable',
        failed: true,
        legacyEventCount: legacy,
        detail: `backup failed, nothing was published: ${messageOf(error)}`,
        findings: structural.findings,
      }
    }
  }

  try {
    const result = await context.publishSuccessor(candidate.path, proof.rows, context.catalog, sourceDigest)
    const published = basename(result.targetPath)
    const created = result.outcome === 'created'
    return {
      ...base,
      class: refusal,
      status: 'repairable',
      selected: true,
      published,
      alreadyPublished: !created,
      legacyEventCount: legacy,
      droppedEventCount: dropped,
      renumberedEventCount: renumbered,
      detail: `${
        created
          ? `published ${published} (created); read back through the catalog with validation: 'current'`
          : `already published ${published} (verified byte-identical; accepted, not written by this run)`
      }${lossyNote(dropped, renumbered, true)}`,
      findings: structural.findings,
    }
  } catch (error) {
    // A publication that HAPPENED and then found its snapshot stale must never be
    // reported as "nothing was published": name the file and how to roll it back.
    const stalePath = context.stalePublicationPath(error)
    // Whatever the failure was, the copy THIS run made must not outlive it: the
    // session directory has to be as the run found it for that claim to hold.
    const backupNote = await discardCreatedBackup(backup)
    return {
      ...base,
      class: refusal,
      status: 'unrepairable',
      failed: true,
      legacyEventCount: legacy,
      stalePublicationPath: stalePath,
      detail: `${
        stalePath === null
          ? `repair failed, nothing was published: ${messageOf(error)}`
          : `a successor WAS published from a snapshot that is now stale — DELETE ${stalePath} to roll the `
            + `publication back: ${messageOf(error)}`
      }${backupNote}`,
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
    // The report's structural pass uses the RUN'S policy rules (not the default
    // registry): an existing successor is judged by the same rule set this run was
    // invoked with. The catalog-null arm is DEFENSIVE — this function's only call
    // site sits behind `existingSuccessor !== null`, which already requires a
    // resolved oracle for the successor name — but it must not silently classify
    // with a different policy if a future caller reaches it.
    return context.catalog === null
      ? classifyRows(rows, context.reportRules).class
      : classifyWithCatalog(rows, context.catalog)
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
 * @throws FatalError on a missing or unreadable `--root`, a runtime without
 *   `node:zlib` zstd, `--apply` without a resolved catalog, a resolved catalog
 *   below {@link REQUIRED_CATALOG_VERSION}, or `--apply --drop-legacy-events`
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
  // The oracle is pinned to a RELEASE, in every mode: the same module encodes the
  // successor and reads it back, so "it accepts its own output" is only evidence
  // when the module is the build that will read the session. A catalog below the
  // floor is a fatal (exit 2), not a quieter classification.
  const catalogProblem = catalog === null ? null : catalogVersionRefusal(catalog)
  if (catalogProblem !== null) throw new FatalError(catalogProblem)

  const reportRules = policyRules(options.dropLegacyEvents)
  const rules =
    options.classFilter === null
      ? reportRules
      : reportRules.filter((rule) => rule.class === options.classFilter)
  const discovery = await findGenerations(options.root)
  if (discovery.rootFailure !== null) throw new FatalError(discovery.rootFailure)
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
    stalePublicationPath: (error) =>
      error instanceof publishing.PublishedFromStaleSourceError ? error.successorPath : null,
  }

  const logs: LogOutcome[] = []
  for (const candidate of discovery.generations) logs.push(await inspectLog(candidate, context))

  const summary = summarize(logs, discovery.skipped.length)
  return {
    root: options.root,
    mode: options.apply ? 'apply' : 'report',
    classFilter: options.classFilter,
    catalog:
      catalog === null
        ? { resolved: false }
        : {
          resolved: true,
          modulePath: catalog.modulePath,
          resolvedBy: catalog.resolvedBy,
          packageVersion: catalog.packageVersion,
          currentVersion: catalog.catalog.currentVersion,
        },
    logs,
    summary,
    skipped: discovery.skipped,
    staleStagingFiles: discovery.staleStagingFiles,
    // An input this run could not inspect is not a clean run, and neither is a log
    // still not loadable; a stranded staging file is the residue of an interrupted
    // publication this run cannot vouch for either (it never deletes it). All three
    // exit 1 (a fatal input problem exits 2 above).
    exitCode: summary.refused > 0 || discovery.skipped.length > 0 || discovery.staleStagingFiles.length > 0
      ? EXIT_REFUSED
      : EXIT_CLEAN,
  }
}

/** Count one run's outcomes (plus the inputs the walk could not inspect). */
function summarize(logs: readonly LogOutcome[], skipped: number): RunSummary {
  const byClass = Object.fromEntries(REFUSAL_CLASSES.map((name) => [name, 0])) as Record<RefusalClass, number>
  const summary: RunSummary = {
    total: logs.length,
    ok: 0,
    okTruncated: 0,
    skipped,
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
    if (log.strictRefusal !== null) summary.okTruncated += 1
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
  if (log.status === 'ok') return log.strictRefusal === null ? 'ok' : 'ok-truncated'
  if (log.status === 'unrepairable') return 'unrepairable'
  if (log.droppedEventCount === 0) return log.class
  const renumber = log.renumberedEventCount === 0 ? '' : `, ${log.renumberedEventCount} renumbered`
  return mode === 'apply'
    ? `repaired-lossy (${log.droppedEventCount} events dropped${renumber})`
    : `lossy-repairable (${log.droppedEventCount} events to drop${renumber})`
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
    '!! The surviving events of a successor are RENUMBERED: each one receives the seq of its position',
    '!! in the surviving event stream (and every Session-seq reference it carries is shifted with it).',
    '!! Their content is otherwise unchanged, byte for byte.',
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
  const renumbered = logs.reduce((total, log) => total + log.renumberedEventCount, 0)
  const effect = result.mode === 'apply'
    ? 'those audit rows are gone from the published successor(s); the original generations and their '
      + '--backup copies keep the bytes'
    : 'nothing was written: an --apply run with --backup is what removes them'
  return [
    `!! LOSSY: ${result.mode === 'apply' ? 'dropped' : 'would drop'} ${dropped} legacy fallbacks/switch `
    + `event(s) in ${logs.length} log(s) —`,
    `!! ${effect}. ${renumbered} surviving event(s) ${result.mode === 'apply' ? 'received' : 'would receive'} `
    + 'a new seq (content otherwise unchanged).',
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
      ? `catalog: ${result.catalog.modulePath} (v${result.catalog.currentVersion},`
        + ` package ${result.catalog.packageVersion ?? 'version unknown'}, resolved by ${result.catalog.resolvedBy})`
      : `catalog: none resolved — classification is STRUCTURAL ONLY and --apply would refuse `
        + `(no --catalog, no ${CATALOG_ENV_VAR}, no dsh on PATH, no npx install)`,
  )
  if (result.classFilter !== null) {
    io.out(
      `class filter: ${result.classFilter} (rule application only; the listing, the class table and the exit code `
      + 'still cover every log, and the repairable verdict is always computed over the full policy)',
    )
  }

  // Never silent, and never hidden by --quiet: an input the walk could not inspect
  // (named with its errno) and the residue of an interrupted publication. These are
  // diagnostics about the ROOT, not per-log report rows, and each of them makes the
  // run exit 1 — which is what the README promises.
  if (result.logs.length === 0 && result.skipped.length === 0 && result.staleStagingFiles.length === 0) {
    io.out(`  no session log with a canonical generation below v${CURRENT_VERSION_FLOOR} under this root`)
  }
  for (const entry of result.skipped) {
    io.out(`  ${'skipped'.padEnd(TOKEN_WIDTH)} ${entry.path}: ${entry.reason}`)
  }
  for (const path of result.staleStagingFiles) {
    io.out(
      `  ${'stale staging'.padEnd(TOKEN_WIDTH)} ${path}: residue of an interrupted publication; `
      + 'this tool never removes it, delete it once no run is active',
    )
  }

  if (!quiet) {
    for (const log of result.logs) {
      io.out(`  ${token(log, result.mode).padEnd(TOKEN_WIDTH)} ${log.path} (v${log.generation}): ${log.detail}`)
    }
    io.out('')
    io.out('class                        logs')
    for (const name of REFUSAL_CLASSES) {
      io.out(`${name.padEnd(TOKEN_WIDTH)} ${String(result.summary.byClass[name]).padStart(4)}`)
    }
  }

  const summary = result.summary
  io.out(
    `summary: ${summary.total} log(s) | ok ${summary.ok} (ok-truncated ${summary.okTruncated}) `
    + `| repairable ${summary.repairable} `
    + `| unrepairable ${summary.unrepairable} | repaired ${summary.repaired} `
    + `| already published ${summary.alreadyPublished} | failed ${summary.failed} `
    + `| not selected ${summary.notSelected} | refused ${summary.refused} `
    + `| skipped ${summary.skipped} | stale staging ${result.staleStagingFiles.length}`,
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
                 A namespace/session directory that cannot be read, a canonical
                 generation BELOW the format floor that is a symlink or not a regular
                 file, and a stale session.repair.*.jsonl.zstd.tmp are REPORTED (a
                 skipped/stale entry, always printed, not hidden by --quiet) and make the
                 run exit 1; they suppress the "no session log ..." line. An unreadable
                 ROOT is fatal (exit 2). Above the floor a name is not a candidate at
                 all, so its shape is not inspected.
                 Symlinks are reported, never followed: a repair writes beside the
                 generation it repairs, which must stay inside --root.
  --apply        run the rules' proofs and publish a successor generation per repaired
                 log. Requires a resolved catalog. Default: read-only report.
                 The revision this run DECODED is digest-checked against the file before
                 anything is staged, so a concurrent append is refused before the first
                 write; if the source moves after a publication this run CREATED, that
                 successor is removed again, and if it moves after accepting a
                 pre-existing identical successor the failure names that file and says
                 to delete it (never "nothing was published").
  --class NAME   restrict RULE APPLICATION to one class (default: all rules). Names:
                 ${REFUSAL_CLASSES.join(' | ')}.
                 The listing, the class table and the exit code still cover every log
                 under --root, and the repairable verdict is always computed over the
                 FULL policy, so --class never hides a refusal and never promises a
                 repair this invocation cannot perform; it only decides what --apply
                 repairs (a log the filtered chain alone cannot repair is reported as
                 such and left unpublished).
  --catalog PATH explicit released catalog path (package directory, a directory holding
                 it, or its module entry file). Default resolution order:
                 $${CATALOG_ENV_VAR}, the catalog the dsh binary on PATH itself
                 resolves, then the newest ~/.npm/_npx install. The resolved module is
                 EXECUTED, not parsed (the same privilege as running this tool), and it
                 must declare currentVersion >= ${CURRENT_VERSION_FLOOR}: a below-floor catalog is
                 refused with exit 2 rather than trusted to verify its own output. A file
                 candidate whose owning package.json names a different package is
                 refused too. The report names the module path, its format version and
                 its package version.
  --backup       copy the original generation to <name>.bak before publishing. A run
                 that ends up publishing nothing removes the copy IT created again,
                 so a failed run leaves the directory as it found it; a copy that
                 already existed is never touched, and one holding different bytes
                 than the current original blocks the repair with a message naming
                 it until you inspect and delete it.
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
                 RENUMBERING: the same edge requires each event's seq to equal its
                 running event count, so the surviving events are renumbered to their
                 position in the surviving event stream and every surviving Session-seq
                 reference (sourceEventSeqs, surfaceOp, and the payload references the
                 released remappers audit) is shifted with them. Content is otherwise
                 unchanged, byte for byte. A log whose surviving rows reference a
                 DROPPED seq, whose rows are not densely numbered, or whose drop would
                 renumber across the header's seed cut is refused with nothing written.
                 COUNTS (--json, per log): legacyEventCount is the parsed legacy row
                 population of the SOURCE log (0 means the log carries no legacy row);
                 droppedEventCount counts rows removed from the successor this run
                 published or would publish (0 when nothing is published, including a
                 refused drop); renumberedEventCount counts surviving events given a new
                 seq in that successor (a packed Assistant run counts its payload length).
  --json         emit one machine-readable JSON document instead of the text report.
  --quiet        suppress the per-log lines and the by-class table (the header and the
                 summary line still print; warnings and errors are never suppressed).
  --help, -h     show this help and exit 0.

POLICIES: a log's class and its "ok" come from the host loader's policy (what decides
whether the GUI opens the session), but that policy can swallow a refusal and drop the
rows after it. Every ok log is therefore cross-checked with the SAME loader policy under
STRICT recovery — one axis apart, so a refusal there means rows were dropped, not merely
that the session is not current-shaped. When it refuses, the log is reported
"ok-truncated" (with a strictRefusal reason in --json and an ok-truncated count in the
summary) because the session opens WITHOUT the rows that refusal swallowed. Such logs
still exit 0 — they do load.

PRECONDITION for --apply: run it only while NO dsh instance is writing the sessions
under --root. The successor is linked into the session directory without observing the
host's flock lease (that lease is host-internal and cannot be taken from this repo), so
a dsh that is still appending to the old generation would be orphaned once the host
prefers the successor. Stop dsh first. Rollback: delete the successor generation.

RUNTIME: reading and writing session logs needs node:zlib zstd (Node >= 22.15, while
engines.node allows >= 22); a runtime without it fails closed with exit 2. A frame whose
declared plaintext exceeds the tool's frame ceiling is refused as decompress-failed.

EXIT CODES: 0 = every log loads (a session that opens with rows dropped under the strict
policy is reported ok-truncated and still exits 0); 1 = at least one log is still
refused/unrepairable, a repair failed, a log was left unpublished (including one --class
excluded), an input could not be inspected (a skipped path), or a stale
session.repair.*.jsonl.zstd.tmp was found under the root; 2 = fatal (bad arguments,
a missing or unreadable --root, --apply without a resolved catalog, a catalog below
format v${CURRENT_VERSION_FLOOR}, --apply --drop-legacy-events without --backup, or a runtime
without node:zlib zstd).`
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
