/**
 * catalog.ts — resolve the released session-format catalog (the refusal ORACLE)
 * and classify one parsed log against it.
 *
 * Why a resolved host artifact and not a constant table: the migration truth of
 * an old session log is the migration chain of the RELEASE that must read it.
 * This repo may not duplicate those constants (Task 1's rules encode only the
 * classes they can prove), and it may not declare `@deepseek-ai/*` as a
 * dependency (AGENTS.md: peers only, and this is a host artifact, not a plugin
 * peer). The catalog is therefore located at run time and imported
 * DYNAMICALLY — no static import, so the repo builds and its tests run without
 * a DSH install.
 *
 * Resolution order (first hit wins; every miss yields `null` — the caller fails
 * closed and writes nothing):
 *   1. explicit `catalogPath` (the CLI's `--catalog <path>`);
 *   2. `$DSH_SESSION_FORMAT_CATALOG`;
 *   3. the catalog the `dsh` binary on `PATH` itself resolves (its own
 *      `createRequire` resolution first, then the nearest ancestor
 *      `node_modules` that carries it);
 *   4. `~/.npm/_npx/ *\/node_modules` (the npx cache `dsh` runs from).
 * An explicitly configured catalog that does not resolve is NOT silently
 * replaced by a different release: `resolveCatalog` returns `null` instead of
 * falling through to step 3/4.
 *
 * TRUST BOUNDARY: every step *imports* the resolved module — a catalog is
 * EXECUTED code, not a data file, and the same privilege the user already grants
 * by running this tool as `tsx`. A directory candidate is accepted only when its
 * `package.json` names the catalog package; a **file** candidate is accepted when
 * no owning `package.json` is found (a bare module, e.g. a test fixture) or when
 * the nearest owning one names the catalog package, and is rejected when it
 * belongs to a different package. That check is a guard rail, not a sandbox:
 * `--catalog` and the environment variable still execute what they name.
 *
 * RELEASE PIN: a resolved catalog is only trusted when its own
 * `currentVersion` is at least {@link REQUIRED_CATALOG_VERSION} — the caller
 * asserts it with {@link catalogVersionRefusal} — because this tool encodes a
 * successor with that module and then reads it back with the SAME module, so
 * "it accepts its own output" is not evidence about the release the GUI runs.
 * The handle also carries the catalog's own package version so a report can name
 * the build it trusted.
 *
 * A candidate path may be the catalog package directory, a directory that
 * contains it (`node_modules/...`), or the module entry file itself.
 *
 * Row contract (`ParsedRow`): a row is one physical JSONL record. Event records
 * are exactly `{ type, seq, time, data }`; the FIRST record of a log is the
 * session header, which carries `version` / `id` / `createdAt` / ... at the top
 * level and has no `seq`, so a reader synthesizes the `seq` member `ParsedRow`
 * requires and {@link rowRecord} drops it again. A caller that prefers to keep
 * the header payload under `data` (a wrapped row) is also accepted.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ParsedRow, RefusalClass } from './rules.ts'

/** Released catalog package this tool resolves (never a `package.json` peer). */
const CATALOG_PACKAGE = '@deepseek-ai/dsh-session-format-catalog'

/** Short package name, used when a caller points at a directory holding it. */
const CATALOG_PACKAGE_DIR = 'dsh-session-format-catalog'

/** Environment override honoured as resolution step 2. */
export const CATALOG_ENV_VAR = 'DSH_SESSION_FORMAT_CATALOG'

/**
 * The oldest released catalog this tool accepts as its oracle: the format
 * generation it repairs TO (`CURRENT_VERSION_FLOOR`, the pre-V3 scope). A catalog
 * below it cannot read a successor this tool would write, so `--apply` must
 * refuse rather than verify its own output against a build the GUI does not run.
 * One constant for both the selection scope and the oracle floor: they are the
 * same number and must not drift.
 */
export const REQUIRED_CATALOG_VERSION = 3

/** Recovery policy of one catalog restore (released `SessionFormatRecovery`). */
export type RestoreRecovery = 'strict' | 'recoverable'

/** Validation policy of one catalog restore (released `SessionFormatRestoreOptions`). */
export type RestoreValidation = 'transformed' | 'current'

/** One restore request, mirroring the released `SessionFormatRestoreOptions`. */
export interface RestoreOptions {
  recovery: RestoreRecovery
  validation: RestoreValidation
}

/** The released current artifact a restore settles on (structural view). */
export interface ReleasedArtifact {
  readonly header: { readonly version: number; readonly [member: string]: unknown }
  readonly inheritedEventCount: number
  readonly events: readonly unknown[]
}

/** The released single-pass restore (structural view). */
export interface ReleasedRestore {
  readonly header: ReleasedArtifact['header']
  decodeRow(rowValue: unknown): void
  finish(): ReleasedArtifact
}

/**
 * The catalog members this tool uses, as a STRUCTURAL view of the released
 * `SessionFormatCatalog`. Only these four members are relied upon; a module
 * that does not expose them is not accepted as an oracle.
 */
export interface ReleasedCatalog {
  readonly currentVersion: number
  createRestore(headerValue: unknown, options: RestoreOptions): ReleasedRestore
  encodeCurrentHeader(header: unknown, inheritedEventCount: number): Record<string, unknown>
  encodeCurrentEvent(event: unknown): Record<string, unknown>
}

/** Which resolution step produced a handle (diagnostics for the CLI report). */
export type CatalogResolvedBy = 'option' | 'env' | 'dsh-path' | 'npx-store'

/** A resolved, loadable released catalog. Opaque to callers but for diagnostics. */
export interface CatalogHandle {
  /** Absolute path of the resolved catalog module entry file. */
  readonly modulePath: string
  /** Resolution step that produced this handle. */
  readonly resolvedBy: CatalogResolvedBy
  /**
   * The catalog package's OWN `version` from its `package.json`, or `null` when
   * no owning manifest could be read. Diagnostic: the report names the build it
   * trusted, not just the path.
   */
  readonly packageVersion: string | null
  /** The released catalog module's `sessionFormatCatalog` export. */
  readonly catalog: ReleasedCatalog
}

/**
 * Why a resolved catalog may not be used as this run's oracle, or `null` when it
 * may. The caller turns a non-`null` reason into a fatal (exit 2) refusal: a
 * below-floor catalog would encode a successor this tool's own read-back cannot
 * vouch for, and the GUI would not run it either.
 */
export function catalogVersionRefusal(handle: CatalogHandle): string | null {
  const version = handle.catalog.currentVersion
  if (typeof version === 'number' && Number.isSafeInteger(version) && version >= REQUIRED_CATALOG_VERSION) {
    return null
  }
  return `the resolved released catalog at ${handle.modulePath}`
    + `${handle.packageVersion === null ? '' : ` (package version ${handle.packageVersion})`}`
    + ` declares currentVersion ${JSON.stringify(version)}, but this tool requires at least `
    + `${REQUIRED_CATALOG_VERSION}: it would publish a successor that build cannot read. `
    + 'Point --catalog (or DSH_SESSION_FORMAT_CATALOG) at the catalog of the release the GUI runs.'
}

/** Inputs for {@link resolveCatalog}. */
export interface ResolveCatalogOptions {
  /** Explicit catalog path (CLI `--catalog`); highest precedence when given. */
  catalogPath?: string
  /** Environment to read (`DSH_SESSION_FORMAT_CATALOG`, `PATH`, home); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

/* ------------------------------------------------------------------ */
/* resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the released catalog, or `null` when no usable catalog exists.
 *
 * Never throws for a missing/broken oracle: the caller fails closed. A catalog
 * that resolves but does not load (or does not expose the released members) is
 * also reported as `null`.
 *
 * @param opts explicit path and/or environment to resolve against.
 * @returns a handle wrapping the released catalog, or `null`.
 */
export async function resolveCatalog(opts: ResolveCatalogOptions = {}): Promise<CatalogHandle | null> {
  const env = opts.env ?? process.env
  const explicit = opts.catalogPath
  if (explicit !== undefined && explicit.length > 0) return loadCatalog(explicit, 'option', env)
  const fromEnv = env[CATALOG_ENV_VAR]
  if (fromEnv !== undefined && fromEnv.length > 0) return loadCatalog(fromEnv, 'env', env)
  return (
    (await loadCatalog(resolveFromDshBinary(env), 'dsh-path', env))
    ?? (await loadCatalog(resolveFromNpxStore(env), 'npx-store', env))
  )
}

/** Import the fixed member of a resolved candidate path, or reject the candidate. */
async function loadCatalog(
  candidate: string | null,
  resolvedBy: CatalogResolvedBy,
  env: NodeJS.ProcessEnv,
): Promise<CatalogHandle | null> {
  if (candidate === null) return null
  const modulePath = resolveCatalogEntry(candidate, env)
  if (modulePath === null) return null
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as { sessionFormatCatalog?: unknown }
    if (!isReleasedCatalog(loaded.sessionFormatCatalog)) return null
    return {
      modulePath,
      resolvedBy,
      packageVersion: catalogPackageVersion(modulePath),
      catalog: loaded.sessionFormatCatalog,
    }
  } catch {
    return null
  }
}

/**
 * The owning catalog package's own `version`, walking up from a module entry to
 * the nearest `package.json` that names the catalog package; `null` when none is
 * found or it carries no string `version`.
 */
function catalogPackageVersion(modulePath: string): string | null {
  const owner = owningPackageDirectory(modulePath)
  if (owner === null) return null
  const manifest = readManifest(owner)
  const version = manifest === null ? undefined : manifest['version']
  return typeof version === 'string' && version.length > 0 ? version : null
}

/**
 * The nearest ancestor directory of `modulePath` whose `package.json` names the
 * catalog package, or `null`. Bounded: a module entry sits at most a few levels
 * below its package root.
 */
function owningPackageDirectory(modulePath: string): string | null {
  let dir = dirname(modulePath)
  for (let depth = 0; depth < 8; depth += 1) {
    if (isCatalogPackage(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Whether a candidate path exposes the released catalog members this tool relies on. */
function isReleasedCatalog(value: unknown): value is ReleasedCatalog {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ReleasedCatalog>
  return (
    typeof candidate.currentVersion === 'number'
    && typeof candidate.createRestore === 'function'
    && typeof candidate.encodeCurrentHeader === 'function'
    && typeof candidate.encodeCurrentEvent === 'function'
  )
}

/** Expand `~` and make a caller-supplied path absolute. */
function resolveCandidate(candidate: string, env: NodeJS.ProcessEnv): string {
  const home = homeDirectory(env)
  if (candidate === '~') return home
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) return join(home, candidate.slice(2))
  return isAbsolute(candidate) ? candidate : resolve(candidate)
}

/** The home directory the given environment names, falling back to the OS. */
function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env['HOME'] ?? env['USERPROFILE'] ?? homedir()
}

/**
 * Normalize a candidate (package dir, a dir containing it, or a module file)
 * to the catalog module entry file that can be imported.
 *
 * A FILE candidate is accepted when no owning `package.json` names a different
 * package: a bare module (a fixture, a hand-written shim) has no owner and is
 * taken at face value, while a module that provably belongs to another package is
 * refused — the documented trust boundary of an executed, not parsed, input.
 */
function resolveCatalogEntry(candidate: string, env: NodeJS.ProcessEnv): string | null {
  const path = resolveCandidate(candidate, env)
  if (!existsSync(path)) return null
  if (statSync(path).isFile()) return fileCandidate(path)
  if (isCatalogPackage(path)) return packageEntry(path)
  for (const nested of [
    join(path, CATALOG_PACKAGE),
    join(path, 'node_modules', CATALOG_PACKAGE),
    join(path, CATALOG_PACKAGE_DIR),
  ]) {
    if (isCatalogPackage(nested)) return packageEntry(nested)
  }
  return null
}

/** One explicit FILE candidate: refuse it when it belongs to another package. */
function fileCandidate(path: string): string | null {
  let dir = dirname(path)
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = readManifest(dir)
    if (manifest !== null) {
      // The nearest owning manifest decides: the catalog package, or nothing.
      return manifest['name'] === CATALOG_PACKAGE ? path : null
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path
}

/** Whether a directory's own `package.json` names the released catalog package. */
function isCatalogPackage(dir: string): boolean {
  const manifest = readManifest(dir)
  return manifest !== null && manifest['name'] === CATALOG_PACKAGE
}

/** Read one package directory's `package.json` as a record, or `null`. */
function readManifest(dir: string): Record<string, unknown> | null {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Resolve one package directory's ESM entry file (`exports['.']` then `main`). */
function packageEntry(packageDir: string): string | null {
  const manifest = readManifest(packageDir)
  if (manifest === null) return null
  const exports = manifest['exports']
  const root = typeof exports === 'object' && exports !== null
    ? (exports as Record<string, unknown>)['.']
    : undefined
  const entry = typeof root === 'string'
    ? root
    : typeof root === 'object' && root !== null
      ? (root as Record<string, unknown>)['default']
      : manifest['main']
  if (typeof entry !== 'string') return null
  const entryPath = join(packageDir, entry)
  return existsSync(entryPath) ? entryPath : null
}

/**
 * Step 3: the catalog the `dsh` binary on `PATH` itself resolves.
 *
 * The binary's OWN `createRequire` resolution comes first, because that is the
 * resolution the running dsh package performs (it follows the package's real
 * dependency layout, including pnpm's global layout where the binary sits outside
 * the tree that owns its dependencies) — a nearer ancestor `node_modules` that
 * merely *contains* a catalog is not necessarily the one the user's dsh runs, so
 * it is only a fallback.
 */
function resolveFromDshBinary(env: NodeJS.ProcessEnv): string | null {
  const found = findOnPath('dsh', env)
  if (found === null) return null
  const binary = realpath(found)
  try {
    return createRequire(binary).resolve(CATALOG_PACKAGE)
  } catch {
    // Fall through to the ancestor walk below.
  }
  let dir = dirname(binary)
  for (;;) {
    const nested = join(dir, 'node_modules', CATALOG_PACKAGE)
    if (existsSync(nested)) return nested
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Absolute path of one executable name on the environment's `PATH`, or `null`. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    if (entry.length === 0) continue
    for (const candidate of [name, `${name}.cmd`, `${name}.exe`]) {
      const full = join(entry, candidate)
      try {
        if (statSync(full).isFile()) return full
      } catch {
        continue
      }
    }
  }
  return null
}

/** Follow a symlink to its target, falling back to the path itself. */
function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Step 4: the npx cache (`~/.npm/_npx/<hash>/node_modules`), newest install first. */
function resolveFromNpxStore(env: NodeJS.ProcessEnv): string | null {
  const npxDir = join(homeDirectory(env), '.npm', '_npx')
  if (!existsSync(npxDir)) return null
  let entries: string[]
  try {
    entries = readdirSync(npxDir)
  } catch {
    return null
  }
  const candidates = entries
    .map((entry) => join(npxDir, entry, 'node_modules', CATALOG_PACKAGE))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ candidate, mtime: modificationTime(candidate) }))
    .sort((left, right) => right.mtime - left.mtime)
  return candidates[0]?.candidate ?? null
}

/** Modification time of one path in ms, or 0 when it cannot be read. */
function modificationTime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------ */
/* row / record conversion and restore                                 */
/* ------------------------------------------------------------------ */

/** Plain-object guard for the physical records handed to the catalog. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copy own enumerable members, dropping `undefined` (JSON has no `undefined`). */
function withoutUndefined(record: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * The physical JSON record of one parsed row (see the module docblock).
 *
 * Event rows are their own record. The header record carries no `seq` on the
 * wire, so the reader-synthesized `seq` is dropped for `type: 'session'`; a row
 * that keeps the header payload under `data` is resolved to that payload.
 */
export function rowRecord(row: ParsedRow): Record<string, unknown> {
  if (row.type !== 'session') return withoutUndefined(row)
  const data = row.data
  if (isRecord(data) && typeof data['version'] === 'number' && typeof data['id'] === 'string') {
    return withoutUndefined(data)
  }
  const { seq: _seq, time: _time, data: _data, ...rest } = row
  return withoutUndefined(rest)
}

/**
 * Restore parsed rows through the released catalog and return the current
 * artifact. Throws the FIRST refusal (released chain order) unchanged, so the
 * caller can classify it; no partial artifact escapes.
 *
 * @param catalog released catalog to restore through.
 * @param rows parsed log rows in log order (header first).
 * @param options recovery and validation policy of the restore.
 */
export function restoreRows(
  catalog: ReleasedCatalog,
  rows: readonly ParsedRow[],
  options: RestoreOptions,
): ReleasedArtifact {
  const [header, ...events] = rows
  if (header === undefined) throw new Error('cannot restore an empty session log: the header row is missing')
  const restore = catalog.createRestore(rowRecord(header), options)
  for (const row of events) restore.decodeRow(rowRecord(row))
  return restore.finish()
}

/** Concatenated message text of an error and its `cause` chain. */
function errorChainText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current))
      break
    }
    parts.push(current.message)
    current = current.cause
  }
  return parts.join('\n')
}

/**
 * The class of one refusal thrown by the released catalog restore.
 *
 * The mapping is over the released build's OWN prose, so every entry cites the
 * raise site that produces it (pinned checkout; the installed `0.1.5-rc.1`
 * build's line is given for the same statement). A released reword therefore
 * degrades these logs to `other-refusal` (unrepairable, nothing written) until
 * this table is updated — which is exactly what the two real-catalog fixtures in
 * `tests/repair-session-logs.spec.ts` (`describe.skipIf(realCatalog === null)`,
 * foreign-`source.kind`-first and legacy-first) exist to catch:
 *   - `cannot safely transform unclassified message source` —
 *     `session-format-v2-to-v3/src/payload.ts:113` (`assertSource`; installed
 *     `dsh-session-format-v2-to-v3/lib/index.js:125`);
 *   - `uses unsupported descriptor version` —
 *     `session-format-v0-to-v1/src/validation.ts:202`
 *     (`assertReleasedEventPayload`; installed `…-v0-to-v1/lib/index.js:1586`);
 *   - `unknown historical event type` —
 *     `session-format-v0-to-v1/src/validation.ts:120` and `:194` (installed
 *     `…-v0-to-v1/lib/index.js:1530`, `:1582`).
 */
function refusalClass(error: unknown): RefusalClass {
  const text = errorChainText(error)
  if (text.includes('unclassified message source')) return 'source-kind'
  if (text.includes('unsupported descriptor version')) return 'subagent-descriptor-version'
  if (text.includes('unknown historical event type')) return 'unknown-event-type'
  return 'other-refusal'
}

/**
 * Classify parsed rows against the released catalog: the truthful first-refusal
 * class, not the structural approximation `classifyRows` reports.
 *
 * The restore runs under the pinned policy
 * `createRestore(header, { recovery: 'recoverable', validation: 'transformed' })`
 * and every row is decoded before `finish()`, so the class is the one the
 * released chain raises first for this log.
 *
 * Returned classes: `'ok'` when the restore completes, `'source-kind'`,
 * `'subagent-descriptor-version'`, `'unknown-event-type'` for the three released
 * refusals this tool repairs or reports, and `'other-refusal'` for everything
 * else. `'decompress-failed'` is not produced here: the caller passes rows that
 * already decoded.
 *
 * @param rows parsed log rows in log order (header first).
 * @param catalog resolved released catalog oracle.
 */
export function classifyWithCatalog(rows: readonly ParsedRow[], catalog: CatalogHandle): RefusalClass {
  try {
    restoreRows(catalog.catalog, rows, { recovery: 'recoverable', validation: 'transformed' })
    return 'ok'
  } catch (error) {
    return refusalClass(error)
  }
}
