/**
 * repair-session-logs.spec.ts — the generic session-log triage/repair CLI
 * (`scripts/repair-session-logs.ts`).
 *
 * Layers:
 *   - pure units: argument parsing, canonical generation names, the
 *     `node:zlib` zstd runtime floor, row decoding, discovery;
 *   - fixture-directory-tree runs of the real CLI core (`runRepair` / `execute`
 *     / `main`) over synthesized `<root>/<namespace>/<session>/session*.jsonl.zstd`
 *     trees, with a FAKE released catalog package (hermetic: no DSH install
 *     needed) and without any catalog (structural-only mode);
 *   - one catalog-gated integration run that repairs a synthesized pre-V3 log
 *     through the REAL released catalog and reads the successor back with
 *     `validation: 'current'` (skipped with a reason when nothing resolves);
 *   - child-process runs of the real entry point (`tsx scripts/repair-session-logs.ts`)
 *     proving the process exit codes and the `--help` precondition text.
 *
 * Carried coverage from the retired `repair-fallbacks-switch-logs.spec.ts`: a
 * legacy `fallbacks/switch` row must still be DETECTED and reported as the
 * unrepairable `unknown-event-type` class (the dead `markFallbacksSwitchIgnorable`
 * transform is deliberately not ported — the new tool never writes that flag).
 *
 * No real session content is used anywhere: every fixture is invented here, and
 * the real-log smoke run lives outside this suite.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FatalError,
  canonicalGeneration,
  decodeRows,
  execute,
  findGenerations,
  main,
  parseArgs,
  runRepair,
  successorFilename,
  usage,
  zstdRuntimeProblem,
  type CliIO,
  type CliOptions,
  type RunResult,
} from '../scripts/repair-session-logs.ts'
import { resolveCatalog, type CatalogHandle } from '../scripts/session-logs/catalog.ts'
import { decodeZstdFrames, encodeZstdFrames } from '../scripts/session-logs/publish.ts'

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

/** A capturing pair of output sinks. */
function captureIO(): { io: CliIO; out: () => string; err: () => string } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    io: {
      out: (text) => outLines.push(text),
      err: (text) => errLines.push(text),
    },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
  }
}

/** An environment that cannot resolve a catalog (no PATH, an empty home). */
function bareEnv(home = tempDir('rsl-empty-home-')): NodeJS.ProcessEnv {
  return { PATH: '', HOME: home }
}

/** Parsed options with every default, plus overrides. */
function optionsFor(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    help: false,
    root: tempDir('rsl-root-'),
    apply: false,
    classFilter: null,
    catalogPath: undefined,
    backup: false,
    json: false,
    quiet: false,
    ...overrides,
  }
}

const V0_HEADER: Record<string, unknown> = {
  type: 'session',
  version: 0,
  id: 'session-11111111-1111-4111-8111-111111111111',
  createdAt: 1786864997347,
  cwd: '/tmp/session-log-repair-fixture',
  delegationDepth: 0,
}

/** A descriptor row written by an older release (`version: 2`). */
const DESCRIPTOR_V2: Record<string, unknown> = {
  type: 'subagent/descriptor',
  seq: 5,
  time: 1786865067791,
  data: { version: 2, mode: 'one-shot', provider: 'example-provider', label: 'probe' },
}

/** A descriptor row whose payload no version-3 key set admits (proof must refuse). */
const DESCRIPTOR_UNPROVABLE: Record<string, unknown> = {
  type: 'subagent/descriptor',
  seq: 5,
  time: 1786865067791,
  data: { version: 2, mode: 'one-shot', provider: 'example-provider', label: 'probe', extra: 'not-admitted' },
}

/** A message whose `source.kind` is outside the released vocabulary. */
const SOURCE_KIND: Record<string, unknown> = {
  type: 'user/message',
  seq: 6,
  time: 1786865067792,
  data: {
    source: { kind: 'example-plugin-status', form: 'catalog' },
    content: [{ type: 'text', text: '<example_plugin_status>ok</example_plugin_status>' }],
    role: 'user',
    id: '21c3c5e2-e6d7-4d21-9cb9-0fba3df4f21c',
  },
  // The released v2→v3 edge requires the surface operation on this event.
  surfaceOp: 'append',
}

/** The legacy plugin event the retired detector covered: never repairable. */
const FALLBACKS_SWITCH: Record<string, unknown> = {
  type: 'fallbacks/switch',
  seq: 7,
  time: 1786865067793,
  data: { turn: 4, step: 30, reason: 'trigger-code' },
}

/** A row the released chain refuses for a reason no rule models. */
const ODD_ROW: Record<string, unknown> = { type: 'example/odd', seq: 8, time: 1786865067794, data: {} }

/** A harmless row (carried over from the retired spec: a log with no refusal). */
const PLAIN_ROW: Record<string, unknown> = {
  type: 'user/message',
  seq: 1,
  time: 1786865067800,
  data: { text: 'hello', role: 'user' },
}

/** Write one `<root>/<namespace>/<session>/<name>` generation. */
function writeGeneration(
  root: string,
  namespace: string,
  session: string,
  name: string,
  header: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
): { dir: string; path: string } {
  const dir = join(root, namespace, session)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, encodeZstdFrames(header, events))
  return { dir, path }
}

/** Names inside one directory, sorted. */
function listing(dir: string): string[] {
  return readdirSync(dir).sort()
}

/** The outcome of one log, addressed by its session directory name. */
function outcomeFor(result: RunResult, session: string): RunResult['logs'][number] {
  const found = result.logs.find((log) => basename(dirname(log.path)) === session)
  if (found === undefined) throw new Error(`no outcome for session ${session}`)
  return found
}

/* ------------------------------------------------------------------ */
/* the fake released catalog                                           */
/* ------------------------------------------------------------------ */

/**
 * A loadable fake `@deepseek-ai/dsh-session-format-catalog` package with the
 * released SHAPE and the released REFUSAL MESSAGES (the strings
 * `catalog.ts` maps to classes), so the CLI's oracle path is exercised
 * hermetically — no DSH install, no npx cache, no PATH lookup.
 *
 * It accepts everything once it has been normalized: `plugin` is a released
 * kind, `version: 3` is the released descriptor version.
 */
const FAKE_CATALOG_BODY = `const RELEASED_KINDS = new Set(['user', 'plugin', 'model', 'tool'])
export const sessionFormatCatalog = {
  currentVersion: 3,
  createRestore(header, options) {
    return {
      header: { version: 3 },
      decodeRow(row) {
        if (row && row.type === 'subagent/descriptor') {
          const version = row.data && row.data.version
          if (version !== 3) {
            throw new Error('subagent/descriptor ' + row.seq + ' uses unsupported descriptor version ' + version)
          }
        }
        if (row && row.type === 'fallbacks/switch') {
          throw new Error(
            'format v0 contains unknown historical event type "fallbacks/switch" at seq ' + row.seq +
              '; migration refuses unknown historical events even when ignorable',
          )
        }
        if (row && row.type === 'example/odd') throw new Error('released Session row is malformed')
        const source = row && row.data && row.data.source
        if (source && typeof source.kind === 'string' && !RELEASED_KINDS.has(source.kind)) {
          throw new Error('cannot safely transform unclassified message source')
        }
      },
      finish() {
        return { header: { version: 3 }, inheritedEventCount: 0, events: [] }
      },
    }
  },
  encodeCurrentHeader: (header) => ({ ...header }),
  encodeCurrentEvent: (event) => ({ ...event }),
}
`

/** Write a fake catalog package under one root; returns its package directory. */
function writeFakeCatalog(root = tempDir('rsl-fake-catalog-')): string {
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh-session-format-catalog',
      version: '0.1.5-rc.1',
      type: 'module',
      main: 'lib/index.js',
      exports: { '.': { default: './lib/index.js' } },
    }),
  )
  writeFileSync(join(packageDir, 'lib', 'index.js'), FAKE_CATALOG_BODY)
  return packageDir
}

/** Read one published generation back through a catalog with the current policy. */
function readBackGeneration(
  catalog: CatalogHandle,
  path: string,
): { version: number; events: readonly unknown[] } {
  const frames = decodeZstdFrames(readFileSync(path))
  const headerFrame = frames[0] as string
  expect(headerFrame.indexOf('\n')).toBe(headerFrame.length - 1)
  const restore = catalog.catalog.createRestore(JSON.parse(headerFrame.slice(0, -1)), {
    recovery: 'strict',
    validation: 'current',
  })
  for (const line of frames.slice(1).join('').split('\n')) {
    if (line.length > 0) restore.decodeRow(JSON.parse(line))
  }
  const artifact = restore.finish()
  return { version: artifact.header.version, events: artifact.events }
}

/* ------------------------------------------------------------------ */
/* parseArgs                                                           */
/* ------------------------------------------------------------------ */

describe('parseArgs', () => {
  it('defaults to $HOME/.dsh/sessions and every flag off', () => {
    expect(parseArgs([], { HOME: '/tmp/example-home' })).toEqual({
      help: false,
      root: '/tmp/example-home/.dsh/sessions',
      apply: false,
      classFilter: null,
      catalogPath: undefined,
      backup: false,
      json: false,
      quiet: false,
    })
  })

  it('prefers $DSH_HOME over $HOME for the default root', () => {
    expect(parseArgs([], { HOME: '/tmp/example-home', DSH_HOME: '/tmp/example-dsh' }).root).toBe(
      '/tmp/example-dsh/sessions',
    )
  })

  it('parses every documented flag and skips the pnpm `--` separator', () => {
    const options = parseArgs(
      ['--', '--root', '/tmp/example-root', '--apply', '--class', 'source-kind', '--catalog', '/tmp/cat', '--backup', '--json', '--quiet'],
      bareEnv(),
    )

    expect(options).toEqual({
      help: false,
      root: '/tmp/example-root',
      apply: true,
      classFilter: 'source-kind',
      catalogPath: '/tmp/cat',
      backup: true,
      json: true,
      quiet: true,
    })
  })

  it('expands a leading ~ in --root and --catalog against the environment home', () => {
    const env = { HOME: '/tmp/example-home' }
    expect(parseArgs(['--root', '~' ], env).root).toBe('/tmp/example-home')
    expect(parseArgs(['--root', '~/sessions'], env).root).toBe('/tmp/example-home/sessions')
    expect(parseArgs(['--catalog', '~/cat'], env).catalogPath).toBe('/tmp/example-home/cat')
  })

  it('recognises --help and -h', () => {
    expect(parseArgs(['--help'], bareEnv()).help).toBe(true)
    expect(parseArgs(['-h'], bareEnv()).help).toBe(true)
  })

  it('rejects a missing flag value', () => {
    expect(() => parseArgs(['--root'], bareEnv())).toThrow(/--root requires a value/)
    expect(() => parseArgs(['--catalog'], bareEnv())).toThrow(/--catalog requires a value/)
    expect(() => parseArgs(['--class'], bareEnv())).toThrow(/--class requires a value/)
  })

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--nope'], bareEnv())).toThrow(/unknown argument: --nope/)
  })

  it('rejects a --class outside the refusal vocabulary', () => {
    expect(() => parseArgs(['--class', 'fallbacks-switch'], bareEnv())).toThrow(
      /unknown --class fallbacks-switch; expected one of ok, source-kind, subagent-descriptor-version, unknown-event-type, other-refusal, decompress-failed/,
    )
    expect(parseArgs(['--class', 'unknown-event-type'], bareEnv()).classFilter).toBe('unknown-event-type')
  })
})

/* ------------------------------------------------------------------ */
/* names, floor, rows, discovery                                       */
/* ------------------------------------------------------------------ */

describe('canonicalGeneration', () => {
  it('accepts the canonical names the released reader accepts', () => {
    expect(canonicalGeneration('session.jsonl.zstd')).toBe(0)
    expect(canonicalGeneration('session.v1.jsonl.zstd')).toBe(1)
    expect(canonicalGeneration('session.v3.jsonl.zstd')).toBe(3)
    expect(canonicalGeneration('session.v10.jsonl.zstd')).toBe(10)
  })

  it('rejects every noncanonical name (staged temps, backups, v0-tagged, uppercase, leading zeros)', () => {
    for (const name of [
      'session.repair.deadbeef.jsonl.zstd.tmp',
      'session.jsonl.zstd.bak',
      'session.v0.jsonl.zstd',
      'session.V3.jsonl.zstd',
      'session.v03.jsonl.zstd',
      'session.v3.jsonl.zstd.tmp',
      'other.jsonl.zstd',
      'session.v3.zstd',
      'session.v3.jsonl.zstd.bak',
    ]) {
      expect(canonicalGeneration(name), name).toBeNull()
    }
  })
})

describe('successorFilename', () => {
  it('keeps the suffix-only name for version 0 and tags later generations', () => {
    expect(successorFilename(0)).toBe('session.jsonl.zstd')
    expect(successorFilename(3)).toBe('session.v3.jsonl.zstd')
  })
})

describe('zstdRuntimeProblem', () => {
  it('accepts a runtime with both zstd functions', () => {
    expect(zstdRuntimeProblem({ zstdCompressSync: () => {}, zstdDecompressSync: () => {} })).toBeNull()
  })

  it('fails closed with an actionable Node floor message instead of a stack trace', () => {
    const message = zstdRuntimeProblem({})
    expect(message).toContain('node:zlib zstd')
    expect(message).toContain('zstdCompressSync, zstdDecompressSync missing')
    expect(message).toContain('Node >= 22.15')
    expect(zstdRuntimeProblem({ zstdDecompressSync: () => {} })).toContain('zstdCompressSync')
  })
})

describe('decodeRows', () => {
  it('synthesizes seq 0 for the header record and keeps the event envelopes', () => {
    const rows = decodeRows(['{"type":"session","version":0,"id":"session-x"}\n{"type":"turn/start","seq":1,"data":{}}\n'])

    expect(rows).toEqual([
      { seq: 0, type: 'session', version: 0, id: 'session-x' },
      { type: 'turn/start', seq: 1, data: {} },
    ])
  })

  it('skips blank lines and joins concatenated frames', () => {
    const rows = decodeRows(['{"type":"session","version":0,"id":"session-x"}\n', '\n', '{"type":"turn/start","seq":1}\n'])
    expect(rows).toHaveLength(2)
  })

  it('fails loudly on a malformed row instead of truncating the log', () => {
    expect(() => decodeRows(['{"type":"session","version":0,"id":"session-x"}\n', 'not json\n'])).toThrow(/row 2 is not JSON/)
    expect(() => decodeRows(['{"type":"session","version":0,"id":"session-x"}\n', '[1,2]\n'])).toThrow(
      /row 2 is not a JSON object/,
    )
    expect(() => decodeRows(['{"type":"session","version":0,"id":"session-x"}\n', '{"seq":1}\n'])).toThrow(
      /row 2 has no string "type"/,
    )
    expect(() => decodeRows([''])).toThrow(/no JSONL record/)
  })
})

describe('findGenerations', () => {
  it('selects the newest canonical generation below the current-format floor', async () => {
    const root = tempDir('rsl-find-')
    writeGeneration(root, 'ns', 'a', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    writeGeneration(root, 'ns', 'a', 'session.v2.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    writeGeneration(root, 'ns', 'b', 'session.v3.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    writeGeneration(root, 'ns', 'c', 'session.v1.jsonl.zstd', V0_HEADER, [PLAIN_ROW])

    const found = await findGenerations(root)

    expect(found.map((entry) => `${basename(dirname(entry.path))}/${basename(entry.path)}`)).toEqual([
      'a/session.v2.jsonl.zstd',
      'c/session.v1.jsonl.zstd',
    ])
    expect(found.map((entry) => entry.generation)).toEqual([2, 1])
  })

  it('ignores noncanonical names and anything deeper than <namespace>/<session>', async () => {
    const root = tempDir('rsl-find-noncanonical-')
    const { dir } = writeGeneration(root, 'ns', 'a', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    writeFileSync(join(dir, 'session.repair.deadbeef.jsonl.zstd.tmp'), 'staged bytes, not zstd')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd.tmp'), 'staged bytes, not zstd')
    writeFileSync(join(dir, 'session.v0.jsonl.zstd'), 'not canonical')
    // A generation deeper than `<root>/<namespace>/<session>/` is out of scope.
    const deeper = join(dir, 'nested', 'deep')
    mkdirSync(deeper, { recursive: true })
    writeFileSync(join(deeper, 'session.jsonl.zstd'), encodeZstdFrames(V0_HEADER, [PLAIN_ROW]))

    const found = await findGenerations(root)

    expect(found).toHaveLength(1)
    expect(basename(found[0]?.path ?? '')).toBe('session.jsonl.zstd')
  })

  it('returns nothing for an empty root or a root with only current generations', async () => {
    const root = tempDir('rsl-find-empty-')
    expect(await findGenerations(root)).toEqual([])
    writeGeneration(root, 'ns', 'a', 'session.v3.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    expect(await findGenerations(root)).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* dry run, no catalog (structural mode)                               */
/* ------------------------------------------------------------------ */

/** The four-log fixture tree the report suites share. */
function writeMixedTree(): string {
  const root = tempDir('rsl-mixed-')
  writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
  writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
  writeGeneration(root, 'example-ns', 'session-source', 'session.jsonl.zstd', V0_HEADER, [SOURCE_KIND])
  writeGeneration(root, 'example-ns', 'session-switch', 'session.jsonl.zstd', V0_HEADER, [FALLBACKS_SWITCH])
  return root
}

describe('runRepair — report mode without a catalog', () => {
  it('classifies every log structurally, counts per class, and exits 1 while refusals remain', async () => {
    const root = writeMixedTree()

    const result = await runRepair(optionsFor({ root }), bareEnv())

    expect(result.catalog).toEqual({ resolved: false })
    expect(result.mode).toBe('report')
    expect(result.logs).toHaveLength(4)
    expect(outcomeFor(result, 'session-ok').status).toBe('ok')
    expect(outcomeFor(result, 'session-descriptor')).toMatchObject({
      class: 'subagent-descriptor-version',
      status: 'repairable',
      generation: 0,
    })
    expect(outcomeFor(result, 'session-source')).toMatchObject({ class: 'source-kind', status: 'repairable' })
    // Carried coverage from the retired spec: the legacy plugin event is still
    // DETECTED, reported, never repairable, and never written.
    expect(outcomeFor(result, 'session-switch')).toMatchObject({
      class: 'unknown-event-type',
      status: 'unrepairable',
      published: null,
    })
    expect(outcomeFor(result, 'session-switch').findings[0]?.ruleId).toBe('fallbacks-switch')
    expect(result.summary.byClass).toEqual({
      ok: 1,
      'source-kind': 1,
      'subagent-descriptor-version': 1,
      'unknown-event-type': 1,
      'other-refusal': 0,
      'decompress-failed': 0,
    })
    expect(result.summary).toMatchObject({ total: 4, ok: 1, repairable: 2, unrepairable: 1, repaired: 0, refused: 3 })
    expect(result.exitCode).toBe(1)
  })

  it('prints one line per log, a per-class table and the summary via execute', async () => {
    const root = writeMixedTree()
    const sink = captureIO()

    const code = await execute(optionsFor({ root }), sink.io, bareEnv())

    expect(code).toBe(1)
    const out = sink.out()
    expect(out).toContain('report only (no write)')
    expect(out).toContain('catalog: none resolved — classification is STRUCTURAL ONLY')
    expect(out).toContain('session-descriptor/session.jsonl.zstd (v0)')
    expect(out).toMatch(/^ {2}subagent-descriptor-version {2,}/m)
    // An unrepairable log is tokenised `unrepairable`; its class follows in the detail.
    expect(out).toMatch(/^ {2}unrepairable {2,}.*session-switch.*: unknown-event-type/m)
    expect(out).toMatch(/^ {2}ok {2,}/m)
    expect(out).toContain('class                        logs')
    expect(out).toContain('summary: 4 log(s) | ok 1 | repairable 2 | unrepairable 1')
    expect(sink.err()).toBe('')
    expect(listing(join(root, 'example-ns', 'session-descriptor'))).toEqual(['session.jsonl.zstd'])
  })

  it('emits the same data as JSON with --json', async () => {
    const root = writeMixedTree()
    const sink = captureIO()

    const code = await execute(optionsFor({ root, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult

    expect(code).toBe(1)
    expect(document.catalog).toEqual({ resolved: false })
    expect(document.logs).toHaveLength(4)
    expect(document.summary.byClass['subagent-descriptor-version']).toBe(1)
    expect(document.exitCode).toBe(1)
  })

  it('exits 0 when nothing is refused', async () => {
    const root = tempDir('rsl-clean-')
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    const sink = captureIO()

    const code = await execute(optionsFor({ root }), sink.io, bareEnv())

    expect(code).toBe(0)
    expect(sink.out()).toContain('summary: 1 log(s) | ok 1 | repairable 0 | unrepairable 0')
  })

  it('reports the empty root instead of pretending to have repaired something', async () => {
    const sink = captureIO()
    const code = await execute(optionsFor({ root: tempDir('rsl-empty-root-') }), sink.io, bareEnv())

    expect(code).toBe(0)
    expect(sink.out()).toContain('no session log with a canonical generation below v3 under this root')
  })

  it('reports an undecodable generation as unrepairable decompress-failed, never truncated', async () => {
    const root = tempDir('rsl-torn-')
    const torn = join(root, 'example-ns', 'session-torn')
    mkdirSync(torn, { recursive: true })
    const whole = encodeZstdFrames(V0_HEADER, [PLAIN_ROW])
    writeFileSync(join(torn, 'session.jsonl.zstd'), whole.subarray(0, whole.length - 6))
    const garbage = join(root, 'example-ns', 'session-garbage')
    mkdirSync(garbage, { recursive: true })
    writeFileSync(join(garbage, 'session.jsonl.zstd'), Buffer.from('this is not zstd at all'))

    const result = await runRepair(optionsFor({ root }), bareEnv())

    expect(result.logs.map((log) => log.class)).toEqual(['decompress-failed', 'decompress-failed'])
    for (const log of result.logs) {
      expect(log.status).toBe('unrepairable')
      expect(log.published).toBeNull()
    }
    expect(result.exitCode).toBe(1)
    // No truncation, no replacement, no leftover staging.
    expect(listing(torn)).toEqual(['session.jsonl.zstd'])
    expect(listing(garbage)).toEqual(['session.jsonl.zstd'])
  })

  it('ignores noncanonical temp names and does not read them', async () => {
    const root = tempDir('rsl-tempname-')
    const { dir } = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    writeFileSync(join(dir, 'session.repair.deadbeef.jsonl.zstd.tmp'), 'staged bytes, not zstd')

    const result = await runRepair(optionsFor({ root }), bareEnv())

    expect(result.logs).toHaveLength(1)
    expect(result.logs[0]?.class).toBe('subagent-descriptor-version')
    expect(result.summary.byClass['decompress-failed']).toBe(0)
    expect(listing(dir)).toEqual(['session.jsonl.zstd', 'session.repair.deadbeef.jsonl.zstd.tmp'])
  })
})

/* ------------------------------------------------------------------ */
/* dry run with the (fake) released catalog                            */
/* ------------------------------------------------------------------ */

describe('runRepair — report mode with a catalog', () => {
  it('reports the catalog first-refusal class and never writes in report mode', async () => {
    const root = writeMixedTree()
    const catalogPath = writeFakeCatalog()
    const before = listing(join(root, 'example-ns', 'session-descriptor'))

    const result = await runRepair(optionsFor({ root, catalogPath }), bareEnv())

    expect(result.catalog.resolved).toBe(true)
    expect(result.catalog).toMatchObject({ resolvedBy: 'option' })
    expect(outcomeFor(result, 'session-descriptor').class).toBe('subagent-descriptor-version')
    expect(outcomeFor(result, 'session-source').class).toBe('source-kind')
    expect(outcomeFor(result, 'session-switch').class).toBe('unknown-event-type')
    expect(outcomeFor(result, 'session-ok').class).toBe('ok')
    expect(result.exitCode).toBe(1)
    expect(listing(join(root, 'example-ns', 'session-descriptor'))).toEqual(before)
  })

  it('obeys the oracle over the structural pass (other-refusal wins)', async () => {
    const root = tempDir('rsl-oracle-')
    writeGeneration(root, 'example-ns', 'session-odd', 'session.jsonl.zstd', V0_HEADER, [ODD_ROW])

    const result = await runRepair(optionsFor({ root, catalogPath: writeFakeCatalog() }), bareEnv())

    expect(outcomeFor(result, 'session-odd')).toMatchObject({ class: 'other-refusal', status: 'unrepairable' })
    expect(result.exitCode).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* apply with the (fake) released catalog                              */
/* ------------------------------------------------------------------ */

describe('apply', () => {
  it('publishes a successor per repairable log, verifies it, and never touches the original', async () => {
    const root = tempDir('rsl-apply-')
    const catalogPath = writeFakeCatalog()
    const descriptor = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    const source = writeGeneration(root, 'example-ns', 'session-source', 'session.jsonl.zstd', V0_HEADER, [SOURCE_KIND])
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    const descriptorDigest = sha256(descriptor.path)
    const sourceDigest = sha256(source.path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true }), sink.io, bareEnv())

    expect(code).toBe(0)
    expect(sink.err()).toContain('--apply PRECONDITION')
    expect(sink.err()).toContain('flock')
    expect(sink.out()).toContain('published session.v3.jsonl.zstd')
    // The originals are byte-identical and no staging file survives.
    expect(sha256(descriptor.path)).toBe(descriptorDigest)
    expect(sha256(source.path)).toBe(sourceDigest)
    expect(listing(descriptor.dir)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    expect(listing(source.dir)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])

    // Read the published generations back through the catalog with the host's
    // current-generation policy.
    const catalog = (await resolveCatalog({ catalogPath, env: bareEnv() })) as CatalogHandle
    expect(readBackGeneration(catalog, join(descriptor.dir, 'session.v3.jsonl.zstd')).version).toBe(3)
    expect(readBackGeneration(catalog, join(source.dir, 'session.v3.jsonl.zstd')).version).toBe(3)
  })

  it('is idempotent: a second --apply reports already published and keeps the successor bytes', async () => {
    const root = tempDir('rsl-apply-twice-')
    const catalogPath = writeFakeCatalog()
    const descriptor = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])

    const first = captureIO()
    expect(await execute(optionsFor({ root, catalogPath, apply: true }), first.io, bareEnv())).toBe(0)
    const publishedDigest = sha256(join(descriptor.dir, 'session.v3.jsonl.zstd'))

    const second = captureIO()
    expect(await execute(optionsFor({ root, catalogPath, apply: true }), second.io, bareEnv())).toBe(0)

    expect(second.out()).toContain('already published session.v3.jsonl.zstd')
    expect(sha256(join(descriptor.dir, 'session.v3.jsonl.zstd'))).toBe(publishedDigest)
    expect(listing(descriptor.dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('proves an already-published successor in report mode and then reports nothing refused', async () => {
    const root = tempDir('rsl-report-published-')
    const catalogPath = writeFakeCatalog()
    writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    const applySink = captureIO()
    await execute(optionsFor({ root, catalogPath, apply: true }), applySink.io, bareEnv())

    const result = await runRepair(optionsFor({ root, catalogPath }), bareEnv())

    const outcome = outcomeFor(result, 'session-descriptor')
    expect(outcome.alreadyPublished).toBe(true)
    expect(outcome.class).toBe('subagent-descriptor-version')
    expect(outcome.detail).toContain('is already published and loadable')
    expect(result.summary.alreadyPublished).toBe(1)
    expect(result.summary.refused).toBe(0)
    expect(result.exitCode).toBe(0)
  })

  it('never claims an existing successor that is itself refused (report mode, exit 1)', async () => {
    const root = tempDir('rsl-report-broken-successor-')
    const catalogPath = writeFakeCatalog()
    // A successor that exists but does not load: a v3 header with a v2 descriptor.
    writeGeneration(
      root,
      'example-ns',
      'session-descriptor',
      'session.jsonl.zstd',
      V0_HEADER,
      [DESCRIPTOR_V2],
    )
    writeGeneration(
      root,
      'example-ns',
      'session-descriptor',
      'session.v3.jsonl.zstd',
      { ...V0_HEADER, version: 3 },
      [DESCRIPTOR_V2],
    )

    const result = await runRepair(optionsFor({ root, catalogPath }), bareEnv())

    const outcome = outcomeFor(result, 'session-descriptor')
    expect(outcome.alreadyPublished).toBe(false)
    expect(outcome.detail).toContain('WARNING the existing session.v3.jsonl.zstd generation is itself refused')
    expect(result.summary.refused).toBe(1)
    expect(result.exitCode).toBe(1)
  })

  it('never replaces an existing successor holding different bytes', async () => {
    const root = tempDir('rsl-apply-different-successor-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    // A successor produced from a DIFFERENT pre-V3 log: same name, other bytes.
    writeGeneration(
      root,
      'example-ns',
      'session-descriptor',
      'session.v3.jsonl.zstd',
      { ...V0_HEADER, createdAt: 1786864997348 },
      [],
    )
    const foreign = readFileSync(join(log.dir, 'session.v3.jsonl.zstd'))
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true }), sink.io, bareEnv())

    expect(code).toBe(1)
    expect(sink.out()).toContain('repair failed, nothing was published')
    expect(sink.out()).toContain('refusing to replace the existing successor generation')
    expect(readFileSync(join(log.dir, 'session.v3.jsonl.zstd'))).toEqual(foreign)
  })

  it('copies the original aside with --backup', async () => {
    const root = tempDir('rsl-backup-')
    const catalogPath = writeFakeCatalog()
    const descriptor = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    const original = readFileSync(descriptor.path)

    const code = await execute(optionsFor({ root, catalogPath, apply: true, backup: true }), captureIO().io, bareEnv())

    expect(code).toBe(0)
    expect(readFileSync(`${descriptor.path}.bak`)).toEqual(original)
    expect(listing(descriptor.dir)).toEqual(['session.jsonl.zstd', 'session.jsonl.zstd.bak', 'session.v3.jsonl.zstd'])
  })

  it('never writes for an unrepairable class (legacy fallbacks/switch) and exits 1', async () => {
    const root = tempDir('rsl-apply-switch-')
    const catalogPath = writeFakeCatalog()
    const legacy = writeGeneration(root, 'example-ns', 'session-switch', 'session.jsonl.zstd', V0_HEADER, [FALLBACKS_SWITCH])
    const digest = sha256(legacy.path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true, backup: true }), sink.io, bareEnv())

    expect(code).toBe(1)
    expect(sink.out()).toContain('unknown-event-type')
    expect(sink.out()).toContain('unrepairable')
    expect(sha256(legacy.path)).toBe(digest)
    // Not even a backup: nothing may be written for a refused log.
    expect(listing(legacy.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('never writes when the repair proof refuses a repairable class', async () => {
    const root = tempDir('rsl-apply-unprovable-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_UNPROVABLE])
    const digest = sha256(log.path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true }), sink.io, bareEnv())

    expect(code).toBe(1)
    expect(sink.out()).toContain('the repair proof refused')
    expect(sink.out()).toContain('outside the version-3 admitted set')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('restricts rule application with --class without hiding the other logs', async () => {
    const root = tempDir('rsl-class-filter-')
    const catalogPath = writeFakeCatalog()
    const descriptor = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    const source = writeGeneration(root, 'example-ns', 'session-source', 'session.jsonl.zstd', V0_HEADER, [SOURCE_KIND])
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, classFilter: 'source-kind' }),
      sink.io,
      bareEnv(),
    )

    // Only the source-kind log is repaired; the descriptor log stays refused and
    // is still reported (the filter never hides a refusal).
    expect(code).toBe(1)
    expect(listing(source.dir)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    expect(listing(descriptor.dir)).toEqual(['session.jsonl.zstd'])
    expect(sink.out()).toContain('session-descriptor/session.jsonl.zstd')
    expect(sink.out()).toContain('class filter: source-kind')
    expect(sink.out()).toContain('not selected 1')
  })

  it('fails closed with exit 2 and writes nothing when --apply has no catalog', async () => {
    const root = tempDir('rsl-apply-nocatalog-')
    const descriptor = writeGeneration(root, 'example-ns', 'session-descriptor', 'session.jsonl.zstd', V0_HEADER, [DESCRIPTOR_V2])
    const digest = sha256(descriptor.path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, apply: true }), sink.io, bareEnv())

    expect(code).toBe(2)
    expect(sink.err()).toContain('no released session-format catalog resolved')
    expect(sink.err()).toContain('refusing to write a successor generation')
    expect(sink.err()).toContain('--apply PRECONDITION')
    expect(sink.out()).toBe('')
    expect(sha256(descriptor.path)).toBe(digest)
    expect(listing(descriptor.dir)).toEqual(['session.jsonl.zstd'])

    await expect(runRepair(optionsFor({ root, apply: true }), bareEnv())).rejects.toBeInstanceOf(FatalError)
  })
})

/* ------------------------------------------------------------------ */
/* fatal arguments / help                                              */
/* ------------------------------------------------------------------ */

describe('main — fatal arguments and help', () => {
  it('exits 2 with usage for an unknown argument', async () => {
    const sink = captureIO()

    const code = await main(['--nope'], bareEnv(), sink.io)

    expect(code).toBe(2)
    expect(sink.err()).toContain('unknown argument: --nope')
    expect(sink.err()).toContain('usage: pnpm repair:session-logs')
    expect(sink.out()).toBe('')
  })

  it('exits 2 for a missing --root', async () => {
    const sink = captureIO()

    const code = await main(['--root', join(tempDir('rsl-missing-'), 'nope')], bareEnv(), sink.io)

    expect(code).toBe(2)
    expect(sink.err()).toContain('--root directory not found')
  })

  it('exits 0 and states the --apply precondition plus the Node floor in --help', async () => {
    const sink = captureIO()

    const code = await main(['--help'], bareEnv(), sink.io)

    expect(code).toBe(0)
    expect(sink.out()).toContain('usage: pnpm repair:session-logs')
    expect(sink.out()).toContain('PRECONDITION for --apply')
    expect(sink.out()).toContain('NO dsh instance is writing the sessions')
    expect(sink.out()).toContain('flock lease')
    expect(sink.out()).toContain('Node >= 22.15')
    expect(sink.out()).toContain('Rollback: delete the successor generation')
    expect(sink.err()).toBe('')
    expect(usage()).toBe(sink.out())
  })

  it('prints the loud precondition line for --apply even under --quiet', async () => {
    const root = tempDir('rsl-quiet-')
    const catalogPath = writeFakeCatalog()
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true, quiet: true }), sink.io, bareEnv())

    expect(code).toBe(0)
    expect(sink.err()).toContain('--apply PRECONDITION')
    expect(sink.err()).toContain('while NO dsh instance is writing the sessions')
    // --quiet drops the per-log lines and the by-class table, not the summary.
    expect(sink.out()).not.toContain('class                        logs')
    expect(sink.out()).not.toContain('session-ok/session.jsonl.zstd')
    expect(sink.out()).toContain('summary: 1 log(s)')
  })
})

/* ------------------------------------------------------------------ */
/* the real entry point (child process)                                */
/* ------------------------------------------------------------------ */

describe('CLI entry point (child process)', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const SCRIPT = join(REPO_ROOT, 'scripts', 'repair-session-logs.ts')

  /** Run the real CLI; returns status + combined output. */
  function runCli(args: string[]): { status: number; output: string } {
    const result = spawnSync(TSX_BIN, [SCRIPT, ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      // Bound the child: a wedged tsx spawn must fail the test, not hang it.
      timeout: 30_000,
    })
    return { status: result.status ?? -1, output: `${result.stdout}\n${result.stderr}` }
  }

  it('prints the help text and exits 0', { timeout: 40_000 }, () => {
    const { status, output } = runCli(['--help'])

    expect(status).toBe(0)
    expect(output).toContain('usage: pnpm repair:session-logs')
    expect(output).toContain('NO dsh instance is writing the sessions')
  })

  it('exits 2 on a bad argument', { timeout: 40_000 }, () => {
    const { status, output } = runCli(['--dry-run'])

    expect(status).toBe(2)
    expect(output).toContain('unknown argument: --dry-run')
    expect(output).toContain('usage: pnpm repair:session-logs')
  })

  it('reports a fixture tree as JSON with the documented exit code', { timeout: 40_000 }, () => {
    const root = writeMixedTree()
    const catalogPath = writeFakeCatalog()

    const { status, output } = runCli(['--root', root, '--catalog', catalogPath, '--json'])

    expect(status).toBe(1)
    const document = JSON.parse(output.slice(output.indexOf('{'))) as RunResult
    expect(document.catalog.resolved).toBe(true)
    expect(document.logs).toHaveLength(4)
    expect(document.summary.byClass).toMatchObject({ ok: 1, 'source-kind': 1, 'subagent-descriptor-version': 1 })
    expect(document.exitCode).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* integration: the REAL released catalog                              */
/* ------------------------------------------------------------------ */

const realCatalog = await resolveCatalog()
if (realCatalog === null) {
  console.warn(
    'repair-session-logs.spec.ts: no released session-format catalog resolved in this environment '
    + '(no --catalog, no DSH_SESSION_FORMAT_CATALOG, no dsh on PATH, no npx cache) — '
    + 'the catalog-gated CLI integration test is skipped; the fixture suites above still ran.',
  )
}

/** A synthesized v0 log: one descriptor v2 plus one unclassified source kind. */
const REAL_FIXTURE_EVENTS: readonly Record<string, unknown>[] = [
  { type: 'permission/preset', seq: 0, time: 1786864997350, data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', seq: 1, time: 1786864997350, data: { mode: 'workspace-write' } },
  { type: 'approval/policy', seq: 2, time: 1786864997351, data: { policy: 'ask' } },
  { type: 'turn/start', seq: 3, time: 1786865067773, data: { turn: 1 } },
  { type: 'step/start', seq: 4, time: 1786865067790, data: { turn: 1, step: 1 } },
  DESCRIPTOR_V2,
  SOURCE_KIND,
  { type: 'step/end', seq: 7, time: 1786865070943, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 8, time: 1786865237513, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe.skipIf(realCatalog === null)('CLI against the real released catalog', () => {
  it('repairs a synthesized pre-V3 log and publishes a v3 successor the catalog reads back as current', async () => {
    const oracle = realCatalog as CatalogHandle
    const root = tempDir('rsl-real-')
    const log = writeGeneration(
      root,
      '--example-namespace--',
      'session-11111111-1111-4111-8111-111111111111',
      'session.jsonl.zstd',
      V0_HEADER,
      REAL_FIXTURE_EVENTS,
    )
    const digest = sha256(log.path)
    const sink = captureIO()

    // Report mode first: the refusal class must be the descriptor version.
    const report = await runRepair(optionsFor({ root, catalogPath: oracle.modulePath }), process.env)
    expect(outcomeFor(report, 'session-11111111-1111-4111-8111-111111111111')).toMatchObject({
      class: 'subagent-descriptor-version',
      status: 'repairable',
    })

    const code = await execute(
      optionsFor({ root, catalogPath: oracle.modulePath, apply: true }),
      sink.io,
      process.env,
    )

    expect(code).toBe(0)
    expect(sink.out()).toContain('published session.v3.jsonl.zstd')
    expect(sha256(log.path)).toBe(digest)
    const successor = join(log.dir, 'session.v3.jsonl.zstd')
    expect(existsSync(successor)).toBe(true)
    expect(readBackGeneration(oracle, successor).version).toBe(3)
    expect(listing(log.dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
