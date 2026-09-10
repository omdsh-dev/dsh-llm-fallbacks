/**
 * session-log-publish.spec.ts — the released-catalog oracle and the successor
 * publisher (`scripts/session-logs/{catalog,publish}.ts`).
 *
 * Two layers of evidence:
 *   - catalog-free unit tests (framing, row/record conversion, refusal mapping,
 *     resolution order, the no-write failure modes) run everywhere, including
 *     CI without a DSH install;
 *   - one catalog-gated integration test repairs a SYNTHESIZED pre-V3 fixture
 *     (v0 header + an unclassified `source.kind` + a `subagent/descriptor`
 *     `version: 2`) and reads the published generation back through the
 *     released catalog with `validation: 'current'`. It skips, with a reason,
 *     when no catalog resolves.
 *
 * No real session content is used anywhere: every fixture is invented here.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyRows } from '../scripts/session-logs/classify.ts'
import { BUILT_IN_RULES, type ParsedRow } from '../scripts/session-logs/rules.ts'
import {
  CATALOG_ENV_VAR,
  classifyWithCatalog,
  resolveCatalog,
  restoreRows,
  rowRecord,
  type CatalogHandle,
  type ReleasedCatalog,
  type RestoreOptions,
} from '../scripts/session-logs/catalog.ts'
import { assertCatalog, decodeZstdFrames, encodeZstdFrames, publishSuccessor } from '../scripts/session-logs/publish.ts'

/* ------------------------------------------------------------------ */
/* fixture helpers                                                     */
/* ------------------------------------------------------------------ */

const temporaryDirs: string[] = []

/** One fresh temporary directory, removed when the file finishes. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true })
})

/** Hex sha256 of one file. */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Body of a loadable fake catalog package (released shape, no behavior needed). */
const FAKE_CATALOG_BODY = `export const sessionFormatCatalog = {
  currentVersion: 3,
  createRestore: () => ({
    header: { version: 3 },
    decodeRow() {},
    finish: () => ({ header: { version: 3 }, inheritedEventCount: 0, events: [] }),
  }),
  encodeCurrentHeader: (header) => ({ ...header }),
  encodeCurrentEvent: (event) => ({ ...event }),
}
`

/** Write a fake `@deepseek-ai/dsh-session-format-catalog` package under one root. */
function writeFakeCatalog(root: string, body = FAKE_CATALOG_BODY): string {
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-session-format-catalog',
    version: '0.1.5-rc.1',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': { default: './lib/index.js' } },
  }))
  writeFileSync(join(packageDir, 'lib', 'index.js'), body)
  return packageDir
}

/**
 * One synthesized physical record: an event row is exactly `ParsedRow`; the
 * header row additionally carries the header payload at the top level.
 */
type FixtureRow = ParsedRow & Record<string, unknown>

/** An environment that cannot resolve a catalog: no PATH, an empty home. */
function bareEnv(home = tempDir('slr-empty-home-')): NodeJS.ProcessEnv {
  return { PATH: '', HOME: home }
}

/** The released writer's checksummed frame options, built independently here. */
const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/* ------------------------------------------------------------------ */
/* resolveCatalog — resolution order                                   */
/* ------------------------------------------------------------------ */

describe('resolveCatalog', () => {
  it('resolves an explicit package directory', async () => {
    const root = tempDir('slr-option-')
    const packageDir = writeFakeCatalog(root)

    const handle = await resolveCatalog({ catalogPath: packageDir, env: bareEnv() })

    expect(handle?.resolvedBy).toBe('option')
    expect(handle?.modulePath).toBe(join(packageDir, 'lib', 'index.js'))
    expect(handle?.catalog.currentVersion).toBe(3)
  })

  it('resolves an explicit directory that merely contains the package tree', async () => {
    const root = tempDir('slr-option-nm-')
    const packageDir = writeFakeCatalog(root)

    const handle = await resolveCatalog({ catalogPath: join(root, 'node_modules'), env: bareEnv() })

    expect(handle?.modulePath).toBe(join(packageDir, 'lib', 'index.js'))
  })

  it('resolves an explicit module entry file', async () => {
    const root = tempDir('slr-option-file-')
    const packageDir = writeFakeCatalog(root)

    const handle = await resolveCatalog({
      catalogPath: join(packageDir, 'lib', 'index.js'),
      env: bareEnv(),
    })

    expect(handle?.modulePath).toBe(join(packageDir, 'lib', 'index.js'))
  })

  it('resolves $DSH_SESSION_FORMAT_CATALOG', async () => {
    const root = tempDir('slr-env-')
    const packageDir = writeFakeCatalog(root)

    const handle = await resolveCatalog({
      env: { ...bareEnv(), [CATALOG_ENV_VAR]: packageDir },
    })

    expect(handle?.resolvedBy).toBe('env')
    expect(handle?.modulePath).toBe(join(packageDir, 'lib', 'index.js'))
  })

  it('prefers the explicit path over the environment variable', async () => {
    const optionRoot = tempDir('slr-prefer-option-')
    const envRoot = tempDir('slr-prefer-env-')
    const optionPackage = writeFakeCatalog(optionRoot)
    const envPackage = writeFakeCatalog(envRoot)

    const handle = await resolveCatalog({
      catalogPath: optionPackage,
      env: { ...bareEnv(), [CATALOG_ENV_VAR]: envPackage },
    })

    expect(handle?.resolvedBy).toBe('option')
    expect(handle?.modulePath).toBe(join(optionPackage, 'lib', 'index.js'))
  })

  it('resolves the catalog owned by the dsh binary on PATH', async () => {
    const root = tempDir('slr-dsh-path-')
    const packageDir = writeFakeCatalog(root)
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'dsh'), '#!/usr/bin/env node\n')

    const handle = await resolveCatalog({ env: { ...bareEnv(), PATH: join(root, 'bin') } })

    expect(handle?.resolvedBy).toBe('dsh-path')
    // The binary is resolved through its realpath (macOS `/var` -> `/private/var`).
    expect(handle?.modulePath).toBe(realpathSync(join(packageDir, 'lib', 'index.js')))
  })

  it('falls back to the npx cache when no dsh binary is on PATH', async () => {
    const home = tempDir('slr-npx-home-')
    const packageDir = writeFakeCatalog(join(home, '.npm', '_npx', 'aaaa1111'))

    const handle = await resolveCatalog({ env: bareEnv(home) })

    expect(handle?.resolvedBy).toBe('npx-store')
    expect(handle?.modulePath).toBe(join(packageDir, 'lib', 'index.js'))
  })

  it('prefers the newest npx install when the cache holds several', async () => {
    const home = tempDir('slr-npx-newest-')
    const oldPackage = writeFakeCatalog(join(home, '.npm', '_npx', 'old'), FAKE_CATALOG_BODY)
    const newPackage = writeFakeCatalog(join(home, '.npm', '_npx', 'new'), FAKE_CATALOG_BODY)
    const epoch = 1_700_000_000
    utimesSync(oldPackage, epoch, epoch)
    utimesSync(newPackage, epoch + 600, epoch + 600)

    const handle = await resolveCatalog({ env: bareEnv(home) })

    expect(handle?.modulePath).toBe(join(newPackage, 'lib', 'index.js'))
  })

  it('returns null when nothing resolves', async () => {
    await expect(resolveCatalog({ env: bareEnv() })).resolves.toBeNull()
  })

  it('returns null for an explicit path that does not resolve, without falling through', async () => {
    const home = tempDir('slr-no-fallthrough-')
    writeFakeCatalog(join(home, '.npm', '_npx', 'aaaa1111'))

    await expect(resolveCatalog({ catalogPath: join(home, 'missing'), env: bareEnv(home) })).resolves.toBeNull()
    await expect(
      resolveCatalog({ env: { ...bareEnv(home), [CATALOG_ENV_VAR]: join(home, 'missing') } }),
    ).resolves.toBeNull()
  })

  it('rejects a module that does not expose the released catalog members', async () => {
    const root = tempDir('slr-wrong-shape-')
    const packageDir = writeFakeCatalog(root, 'export const somethingElse = 1\n')

    await expect(resolveCatalog({ catalogPath: packageDir, env: bareEnv() })).resolves.toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* rowRecord — the row/record contract                                 */
/* ------------------------------------------------------------------ */

describe('rowRecord', () => {
  it('drops the synthesized seq from a raw header record', () => {
    const row: FixtureRow = {
      seq: 0,
      type: 'session',
      version: 0,
      id: 'session-11111111-1111-4111-8111-111111111111',
      createdAt: 1786864997347,
      cwd: '/tmp/example-workspace',
      delegationDepth: 0,
    }

    expect(rowRecord(row)).toEqual({
      type: 'session',
      version: 0,
      id: 'session-11111111-1111-4111-8111-111111111111',
      createdAt: 1786864997347,
      cwd: '/tmp/example-workspace',
      delegationDepth: 0,
    })
  })

  it('accepts a header row that wraps the payload in data', () => {
    const row: ParsedRow = {
      type: 'session',
      seq: 0,
      data: { type: 'session', version: 3, id: 'session-x', createdAt: 1, isSeeded: false, delegationDepth: 0 },
    }

    expect(rowRecord(row)).toEqual({
      type: 'session',
      version: 3,
      id: 'session-x',
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    })
  })

  it('keeps an event envelope and drops undefined members', () => {
    const row: ParsedRow = { type: 'turn/start', seq: 3, time: undefined, data: { turn: 1 } }

    expect(rowRecord(row)).toEqual({ type: 'turn/start', seq: 3, data: { turn: 1 } })
  })
})

describe('restoreRows', () => {
  it('hands the header record first, then every event record, to the catalog', () => {
    const seen: unknown[] = []
    const artifact = { header: { version: 3 }, inheritedEventCount: 0, events: [] }
    const catalog: ReleasedCatalog = {
      currentVersion: 3,
      createRestore: (headerValue) => {
        seen.push(headerValue)
        return {
          header: { version: 3 },
          decodeRow: (rowValue) => {
            seen.push(rowValue)
          },
          finish: () => artifact,
        }
      },
      encodeCurrentHeader: (header) => ({ ...(header as Record<string, unknown>) }),
      encodeCurrentEvent: (event) => ({ ...(event as Record<string, unknown>) }),
    }

    expect(restoreRows(catalog, [HEADER_ROW, EVENT_ROW], { recovery: 'strict', validation: 'current' })).toBe(
      artifact,
    )
    expect(seen).toEqual([
      {
        type: 'session',
        version: 0,
        id: 'session-11111111-1111-4111-8111-111111111111',
        createdAt: 1786864997347,
        delegationDepth: 0,
      },
      { type: 'turn/start', seq: 3, time: 1786865067773, data: { turn: 1 } },
    ])
  })

  it('refuses an empty row list', () => {
    expect(() => restoreRows(okCatalog([]), [], { recovery: 'strict', validation: 'current' })).toThrow(
      /header row is missing/,
    )
  })
})

/* ------------------------------------------------------------------ */
/* classifyWithCatalog — first-refusal truth                           */
/* ------------------------------------------------------------------ */

/** A catalog whose restore completes successfully and records its restore options. */
function okCatalog(observed: RestoreOptions[]): ReleasedCatalog {
  return {
    currentVersion: 3,
    createRestore: (_headerValue, options) => {
      observed.push(options)
      return {
        header: { version: 3 },
        decodeRow() {},
        finish: () => ({ header: { version: 3 }, inheritedEventCount: 0, events: [] }),
      }
    },
    encodeCurrentHeader: (header) => ({ ...(header as Record<string, unknown>) }),
    encodeCurrentEvent: (event) => ({ ...(event as Record<string, unknown>) }),
  }
}

/** A catalog whose restore fails the way the caller asks it to. */
function refusingCatalog(
  refusal: Error,
  throwAt: 'create' | 'decodeRow' | 'finish' = 'decodeRow',
  observed?: RestoreOptions[],
): ReleasedCatalog {
  const fixed = { header: { version: 3 }, inheritedEventCount: 0, events: [] }
  return {
    currentVersion: 3,
    createRestore: (_headerValue, options) => {
      observed?.push(options)
      if (throwAt === 'create') throw refusal
      return {
        header: { version: 3 },
        decodeRow() {
          if (throwAt === 'decodeRow') throw refusal
        },
        finish() {
          if (throwAt === 'finish') throw refusal
          return fixed
        },
      }
    },
    encodeCurrentHeader: (header) => ({ ...(header as Record<string, unknown>) }),
    encodeCurrentEvent: (event) => ({ ...(event as Record<string, unknown>) }),
  }
}

/** Wrap one raw catalog in a handle, as `resolveCatalog` would. */
function handleOf(catalog: ReleasedCatalog): CatalogHandle {
  return { modulePath: '/fake/catalog/lib/index.js', resolvedBy: 'option', catalog }
}

const HEADER_ROW: FixtureRow = {
  seq: 0,
  type: 'session',
  version: 0,
  id: 'session-11111111-1111-4111-8111-111111111111',
  createdAt: 1786864997347,
  delegationDepth: 0,
}

const EVENT_ROW: FixtureRow = { type: 'turn/start', seq: 3, time: 1786865067773, data: { turn: 1 } }

describe('classifyWithCatalog', () => {
  it('reports ok when the restore completes', () => {
    const observed: RestoreOptions[] = []

    expect(classifyWithCatalog([HEADER_ROW, EVENT_ROW], handleOf(okCatalog(observed)))).toBe('ok')
    expect(observed).toEqual([{ recovery: 'recoverable', validation: 'transformed' }])
  })

  it('maps the unclassified-source guard to source-kind', () => {
    const catalog = refusingCatalog(new Error('cannot safely transform unclassified message source'))
    expect(classifyWithCatalog([HEADER_ROW, EVENT_ROW], handleOf(catalog))).toBe('source-kind')
  })

  it('maps the descriptor-version refusal to subagent-descriptor-version', () => {
    const catalog = refusingCatalog(
      new Error('subagent/descriptor 5 uses unsupported descriptor version 2'),
    )
    expect(classifyWithCatalog([HEADER_ROW, EVENT_ROW], handleOf(catalog))).toBe(
      'subagent-descriptor-version',
    )
  })

  it('maps an unknown historical event type to unknown-event-type', () => {
    const catalog = refusingCatalog(
      new Error(
        'format v0 contains unknown historical event type "fallbacks/switch" at seq 3; migration refuses unknown historical events even when ignorable',
      ),
    )
    expect(classifyWithCatalog([HEADER_ROW, EVENT_ROW], handleOf(catalog))).toBe('unknown-event-type')
  })

  it('maps any other refusal to other-refusal', () => {
    const catalog = refusingCatalog(new Error('released Session row 2 is malformed'))
    expect(classifyWithCatalog([HEADER_ROW, EVENT_ROW], handleOf(catalog))).toBe('other-refusal')
  })

  it('classifies through a wrapping error cause', () => {
    const cause = new Error('cannot safely transform unclassified message source')
    const wrapped = new Error(
      'Session migration from v0 to v3 refuses the transformed artifact: cannot safely transform unclassified message source',
      { cause },
    )
    expect(classifyWithCatalog([HEADER_ROW, EVENT_ROW], handleOf(refusingCatalog(wrapped, 'finish')))).toBe(
      'source-kind',
    )
  })

  it('reports other-refusal when the header itself is refused', () => {
    const catalog = refusingCatalog(new Error('corrupt session log: first line is not a session header'), 'create')
    expect(classifyWithCatalog([{ seq: 0, type: 'session' }], handleOf(catalog))).toBe('other-refusal')
  })

  it('reports other-refusal for an empty row list', () => {
    const catalog = refusingCatalog(new Error('unreachable'), 'decodeRow')
    expect(classifyWithCatalog([], handleOf(catalog))).toBe('other-refusal')
  })
})

/* ------------------------------------------------------------------ */
/* framing (catalog-free)                                              */
/* ------------------------------------------------------------------ */

const HEADER_RECORD = {
  type: 'session',
  version: 3,
  id: 'session-11111111-1111-4111-8111-111111111111',
  createdAt: 1786864997347,
  cwd: '/tmp/example-workspace',
  isSeeded: false,
  delegationDepth: 0,
}

const EVENT_RECORDS = [
  { type: 'turn/start', seq: 0, time: 1786865067773, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 1786865237513, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('generation framing', () => {
  it('writes exactly two frames: one header line, then the event batch', () => {
    const container = encodeZstdFrames(HEADER_RECORD, EVENT_RECORDS)

    // Independent byte-for-byte oracle: the released writer's own framing, built
    // from Node's public zstd API with the checksummed frame options.
    const expected = Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify(HEADER_RECORD)}\n`), ZSTD_CHECKSUM_OPTIONS),
      zstdCompressSync(
        Buffer.from(EVENT_RECORDS.map((record) => `${JSON.stringify(record)}\n`).join('')),
        ZSTD_CHECKSUM_OPTIONS,
      ),
    ])
    expect(container.equals(expected)).toBe(true)

    const frames = decodeZstdFrames(container)
    expect(frames).toHaveLength(2)
    const headerFrame = frames[0] as string
    expect(headerFrame).toBe(`${JSON.stringify(HEADER_RECORD)}\n`)
    // The released reader's own invariant for frame 1.
    expect(headerFrame.indexOf('\n')).toBe(headerFrame.length - 1)
    expect(frames[1]).toBe(EVENT_RECORDS.map((record) => `${JSON.stringify(record)}\n`).join(''))
    // Node's one-shot decompressor decodes exactly the first frame: it is an
    // independent witness for the frame-1 boundary found by the scanner.
    expect(zstdDecompressSync(container).toString('utf8')).toBe(headerFrame)
  })

  it('writes a single frame when the log has no events', () => {
    const frames = decodeZstdFrames(encodeZstdFrames(HEADER_RECORD, []))

    expect(frames).toHaveLength(1)
    expect(frames[0]).toBe(`${JSON.stringify(HEADER_RECORD)}\n`)
  })

  it('refuses a container that is not a Zstandard frame list', () => {
    expect(() => decodeZstdFrames(Buffer.from('not a zstd container'))).toThrow(/invalid frame magic/)
  })

  it('refuses a torn container', () => {
    const container = encodeZstdFrames(HEADER_RECORD, EVENT_RECORDS)
    expect(() => decodeZstdFrames(container.subarray(0, container.length - 8))).toThrow(/torn/)
  })
})

/* ------------------------------------------------------------------ */
/* publishSuccessor — the no-write failure modes (catalog-free)         */
/* ------------------------------------------------------------------ */

/** One synthesized pre-V3 fixture log on disk. */
function writeFixtureLog(dir = tempDir('slr-log-')): { dir: string; logPath: string } {
  const logPath = join(dir, 'session.jsonl.zstd')
  writeFileSync(logPath, encodeZstdFrames(HEADER_ROW, [EVENT_ROW]))
  return { dir, logPath }
}

describe('publishSuccessor failure modes', () => {
  it('refuses without a catalog and writes nothing', async () => {
    const { dir, logPath } = writeFixtureLog()
    const before = sha256(logPath)

    await expect(publishSuccessor(logPath, [HEADER_ROW, EVENT_ROW], null)).rejects.toThrow(
      /no released session-format catalog resolved/,
    )

    expect(sha256(logPath)).toBe(before)
    expect(readdirSync(dir)).toEqual(['session.jsonl.zstd'])
  })

  it('assertCatalog is the same guard for callers', () => {
    expect(() => assertCatalog(null)).toThrow(/no released session-format catalog resolved/)
    expect(() => assertCatalog(undefined)).toThrow(/refusing to write a successor generation/)
  })

  it('refuses a missing source log and writes nothing', async () => {
    const dir = tempDir('slr-missing-')
    const catalog = refusingCatalog(new Error('unreachable'))

    await expect(
      publishSuccessor(join(dir, 'session.jsonl.zstd'), [HEADER_ROW, EVENT_ROW], handleOf(catalog)),
    ).rejects.toThrow(/ENOENT/)

    expect(readdirSync(dir)).toEqual([])
  })

  it('re-verifies before writing, leaves no temporary, and never mutates the caller rows', async () => {
    const { dir, logPath } = writeFixtureLog()
    const before = sha256(logPath)
    const headerRow: ParsedRow = { ...HEADER_ROW }
    const eventRow: ParsedRow = { ...EVENT_ROW, data: { turn: 1 } }
    const rows: ParsedRow[] = [headerRow, eventRow]
    const snapshot = structuredClone(rows)

    const seen: unknown[] = []
    const catalog: ReleasedCatalog = {
      currentVersion: 3,
      createRestore: (headerValue) => {
        seen.push(headerValue)
        return {
          header: { version: 3 },
          decodeRow: (rowValue) => {
            seen.push(rowValue)
          },
          finish: () => {
            throw new Error('Session migration from v0 to v3 refuses the transformed artifact')
          },
        }
      },
      encodeCurrentHeader: (header) => ({ ...(header as Record<string, unknown>) }),
      encodeCurrentEvent: (event) => ({ ...(event as Record<string, unknown>) }),
    }

    await expect(publishSuccessor(logPath, rows, handleOf(catalog))).rejects.toThrow(
      /refuses the transformed artifact/,
    )

    expect(sha256(logPath)).toBe(before)
    expect(readdirSync(dir)).toEqual(['session.jsonl.zstd'])
    // Defensive copy: the restore never receives the caller's own objects.
    expect(seen[1]).not.toBe(eventRow)
    expect((seen[1] as { data: unknown }).data).not.toBe(eventRow.data)
    expect(rows).toEqual(snapshot)
  })
})

/* ------------------------------------------------------------------ */
/* integration (catalog-gated)                                         */
/* ------------------------------------------------------------------ */

const catalog = await resolveCatalog()
if (catalog === null) {
  console.warn(
    'session-log-publish.spec.ts: no released session-format catalog resolved in this environment '
    + '(no --catalog, no DSH_SESSION_FORMAT_CATALOG, no dsh on PATH, no npx cache) — '
    + 'the catalog-gated integration test is skipped; the unit tests above still ran.',
  )
}
const releaseOnly = describe.skipIf(catalog === null)

/** The synthesized pre-V3 header: a v0 log written before the format moved on. */
const V0_HEADER = {
  type: 'session',
  version: 0,
  id: 'session-11111111-1111-4111-8111-111111111111',
  createdAt: 1786864997347,
  cwd: '/tmp/session-log-repair-fixture',
  delegationDepth: 0,
  agentPreset: 'cordis',
}

/** Synthesized v0 events: one descriptor v2, one unclassified source kind. */
const V0_EVENTS: FixtureRow[] = [
  { type: 'permission/preset', seq: 0, time: 1786864997350, data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', seq: 1, time: 1786864997350, data: { mode: 'workspace-write' } },
  { type: 'approval/policy', seq: 2, time: 1786864997351, data: { policy: 'ask' } },
  { type: 'turn/start', seq: 3, time: 1786865067773, data: { turn: 1 } },
  { type: 'step/start', seq: 4, time: 1786865067790, data: { turn: 1, step: 1 } },
  {
    type: 'subagent/descriptor',
    seq: 5,
    time: 1786865067791,
    data: { version: 2, mode: 'one-shot', provider: 'example-provider', label: 'probe' },
  },
  {
    type: 'user/message',
    seq: 6,
    time: 1786865067792,
    data: {
      source: {
        kind: 'example-plugin-status',
        form: 'catalog',
        version: '1.0.0',
        harnessDir: '/tmp/session-log-repair-fixture/.agents',
        state: null,
      },
      content: [{ type: 'text', text: '<example_plugin_status>\nversion: 1.0.0\n</example_plugin_status>' }],
      role: 'user',
      id: '21c3c5e2-e6d7-4d21-9cb9-0fba3df4f21c',
    },
    surfaceOp: 'append',
  },
  { type: 'step/end', seq: 7, time: 1786865070943, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 8, time: 1786865237513, data: { turn: 1, reason: { kind: 'completed' } } },
]

releaseOnly('publishSuccessor (released catalog)', () => {
  it('repairs the two repairable classes and reads the successor back as current v3', async () => {
    const oracle = catalog as CatalogHandle
    const dir = tempDir('slr-integration-')
    const logPath = join(dir, 'session.jsonl.zstd')
    writeFileSync(logPath, encodeZstdFrames(V0_HEADER, V0_EVENTS))
    const originalDigest = sha256(logPath)

    // The reader's contract: raw records, with a synthesized seq for the header.
    const rows: FixtureRow[] = [{ seq: 0, ...V0_HEADER }, ...V0_EVENTS.map((event) => ({ ...event }))]

    // Structural classification sees the first refused row (the descriptor).
    expect(classifyRows(rows, BUILT_IN_RULES).class).toBe('subagent-descriptor-version')
    // The released oracle agrees, is refused before any repair, and is pure over
    // the rows it is handed (they alias rule-owned `form` / `summary` objects).
    const rawSnapshot = structuredClone(rows)
    expect(classifyWithCatalog(rows, oracle)).toBe('subagent-descriptor-version')
    expect(rows).toEqual(rawSnapshot)

    let normalized: readonly ParsedRow[] = rows
    for (const rule of BUILT_IN_RULES) {
      const outcome = rule.normalize(normalized)
      if ('refused' in outcome) throw new Error(`unexpected refusal from ${rule.id}: ${outcome.refused}`)
      normalized = outcome.rows
    }
    expect(normalized).not.toBe(rows)
    expect(classifyWithCatalog(normalized, oracle)).toBe('ok')

    const snapshot = structuredClone(normalized)
    const result = await publishSuccessor(logPath, normalized, oracle)

    expect(result).toEqual({ generation: 3, verified: true })
    const targetPath = join(dir, 'session.v3.jsonl.zstd')
    expect(existsSync(targetPath)).toBe(true)
    // AC-2: never modify the original.
    expect(sha256(logPath)).toBe(originalDigest)
    // The publish boundary must not mutate the rows it was handed.
    expect(structuredClone(normalized)).toEqual(snapshot)
    // No temporary is left behind.
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])

    // Independent read-back: decode the published container and restore it
    // through the same catalog with the host's current-generation policy.
    const frames = decodeZstdFrames(readFileSync(targetPath))
    expect(frames).toHaveLength(2)
    const headerFrame = frames[0] as string
    expect(headerFrame.indexOf('\n')).toBe(headerFrame.length - 1)
    const publishedHeader = JSON.parse(headerFrame.slice(0, -1)) as { version: number }
    expect(publishedHeader.version).toBe(3)
    const restore = oracle.catalog.createRestore(JSON.parse(headerFrame.slice(0, -1)), {
      recovery: 'strict',
      validation: 'current',
    })
    for (const line of (frames[1] as string).split('\n')) {
      if (line.length > 0) restore.decodeRow(JSON.parse(line))
    }
    const artifact = restore.finish()
    expect(artifact.header.version).toBe(3)
    expect(artifact.events.length).toBeGreaterThan(0)
    const descriptor = artifact.events.find(
      (event) => (event as { type: string }).type === 'subagent/descriptor',
    ) as { data: { version: number } }
    expect(descriptor.data.version).toBe(3)
    const rewritten = artifact.events.find(
      (event) => (event as { type: string }).type === 'user/message',
    ) as { data: { source: { kind: string; plugin?: string } } }
    expect(rewritten.data.source).toMatchObject({ kind: 'plugin', plugin: 'example-plugin-status' })

    // The original generation still holds the untouched pre-V3 rows.
    const originalFrames = decodeZstdFrames(readFileSync(logPath))
    const originalHeader = JSON.parse((originalFrames[0] as string).slice(0, -1)) as { version: number }
    expect(originalHeader.version).toBe(0)
    expect(originalFrames.join('')).toContain('"version":2')
  })

  it('re-publishes over an identical successor without replacing its bytes', async () => {
    const oracle = catalog as CatalogHandle
    const dir = tempDir('slr-republish-')
    const logPath = join(dir, 'session.jsonl.zstd')
    writeFileSync(logPath, encodeZstdFrames(V0_HEADER, V0_EVENTS))
    const rows: FixtureRow[] = [{ seq: 0, ...V0_HEADER }, ...V0_EVENTS.map((event) => ({ ...event }))]
    let normalized: readonly ParsedRow[] = rows
    for (const rule of BUILT_IN_RULES) {
      const outcome = rule.normalize(normalized)
      if ('refused' in outcome) throw new Error(`unexpected refusal from ${rule.id}: ${outcome.refused}`)
      normalized = outcome.rows
    }

    await publishSuccessor(logPath, normalized, oracle)
    const targetPath = join(dir, 'session.v3.jsonl.zstd')
    const publishedDigest = sha256(targetPath)

    await expect(publishSuccessor(logPath, normalized, oracle)).resolves.toEqual({
      generation: 3,
      verified: true,
    })
    expect(sha256(targetPath)).toBe(publishedDigest)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
