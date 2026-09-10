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
 *   3. the `dsh` binary on `PATH` (its `node_modules`);
 *   4. `~/.npm/_npx/ *\/node_modules` (the npx cache `dsh` runs from).
 * An explicitly configured catalog that does not resolve is NOT silently
 * replaced by a different release: `resolveCatalog` returns `null` instead of
 * falling through to step 3/4.
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
  /** The released catalog module's `sessionFormatCatalog` export. */
  readonly catalog: ReleasedCatalog
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
    return { modulePath, resolvedBy, catalog: loaded.sessionFormatCatalog }
  } catch {
    return null
  }
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
 */
function resolveCatalogEntry(candidate: string, env: NodeJS.ProcessEnv): string | null {
  const path = resolveCandidate(candidate, env)
  if (!existsSync(path)) return null
  if (statSync(path).isFile()) return path
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

/** Step 3: the `dsh` binary on `PATH` and the `node_modules` tree that owns it. */
function resolveFromDshBinary(env: NodeJS.ProcessEnv): string | null {
  const found = findOnPath('dsh', env)
  if (found === null) return null
  const binary = realpath(found)
  let dir = dirname(binary)
  for (;;) {
    const nested = join(dir, 'node_modules', CATALOG_PACKAGE)
    if (existsSync(nested)) return nested
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // A global install may keep the binary outside the tree that owns its
  // dependencies (pnpm's global layout); resolve as if requiring from it.
  try {
    return createRequire(binary).resolve(CATALOG_PACKAGE)
  } catch {
    return null
  }
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

/** The class of one refusal thrown by the released catalog restore. */
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
