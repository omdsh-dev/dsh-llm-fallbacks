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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FatalError,
  analysisFailureOutcome,
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
import { REFUSAL_CLASSES } from '../scripts/session-logs/rules.ts'
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
    dropLegacyEvents: false,
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

/**
 * An unknown event type of a DIFFERENT name: the lossy opt-in must never drop it,
 * so a log blocked by this row stays unrepairable whatever the flag says.
 */
const OTHER_UNKNOWN: Record<string, unknown> = {
  type: 'legacy/unknown-note',
  seq: 10,
  time: 1786865067796,
  data: { note: 'synthesized' },
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
 * kind, `version: 3` is the released descriptor version. Two unknown historical
 * event types are refused (`fallbacks/switch` — the one the lossy opt-in drops —
 * and `legacy/unknown-note`, which may never be dropped), and the events it
 * accepted are ECHOED by `finish()`, so a test can assert what a published
 * successor actually carries.
 */
const FAKE_CATALOG_BODY = `const RELEASED_KINDS = new Set(['user', 'plugin', 'model', 'tool'])
export const sessionFormatCatalog = {
  currentVersion: 3,
  createRestore(header, options) {
    const events = []
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
        if (row && row.type === 'legacy/unknown-note') {
          throw new Error(
            'format v0 contains unknown historical event type "legacy/unknown-note" at seq ' + row.seq +
              '; migration refuses unknown historical events even when ignorable',
          )
        }
        if (row && row.type === 'example/odd') throw new Error('released Session row is malformed')
        const source = row && row.data && row.data.source
        if (source && typeof source.kind === 'string' && !RELEASED_KINDS.has(source.kind)) {
          throw new Error('cannot safely transform unclassified message source')
        }
        events.push(row)
      },
      finish() {
        return { header: { version: 3 }, inheritedEventCount: 0, events }
      },
    }
  },
  encodeCurrentHeader: (header) => ({ ...header }),
  encodeCurrentEvent: (event) => ({ ...event }),
}
`

/** Write a fake catalog package under one root; returns its package directory. */
function writeFakeCatalog(
  root = tempDir('rsl-fake-catalog-'),
  body = FAKE_CATALOG_BODY,
): string {
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
  writeFileSync(join(packageDir, 'lib', 'index.js'), body)
  return packageDir
}

/**
 * The fake catalog above, but MUTATING the rows it validates the way the real
 * released restore does: it normalizes a nested object IN PLACE (`publish.ts`'s
 * docblock step 3 documents exactly this for a packed Assistant run's stream)
 * while the artifact it returns is built from copies, exactly like the released
 * migration (which emits the events it normalized rather than the input rows).
 * A caller that hands the oracle the rows it later publishes is caught by this.
 */
const FAKE_MUTATING_CATALOG_BODY = FAKE_CATALOG_BODY.replace(
  '        events.push(row)',
  `        events.push(structuredClone(row))
        if (row && row.type === 'sandbox/mode' && row.data && Array.isArray(row.data.modes)) {
          row.data.modes.push('oracle-normalized-in-place')
        }`,
)

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
      dropLegacyEvents: false,
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
      ['--', '--root', '/tmp/example-root', '--apply', '--class', 'source-kind', '--catalog', '/tmp/cat', '--backup', '--drop-legacy-events', '--json', '--quiet'],
      bareEnv(),
    )

    expect(options).toEqual({
      help: false,
      root: '/tmp/example-root',
      apply: true,
      classFilter: 'source-kind',
      catalogPath: '/tmp/cat',
      backup: true,
      dropLegacyEvents: true,
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

    const { generations: found, skipped, rootFailure } = await findGenerations(root)

    expect(found.map((entry) => `${basename(dirname(entry.path))}/${basename(entry.path)}`)).toEqual([
      'a/session.v2.jsonl.zstd',
      'c/session.v1.jsonl.zstd',
    ])
    expect(found.map((entry) => entry.generation)).toEqual([2, 1])
    expect(skipped).toEqual([])
    expect(rootFailure).toBeNull()
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

    const { generations: found, staleStagingFiles } = await findGenerations(root)

    expect(found).toHaveLength(1)
    expect(basename(found[0]?.path ?? '')).toBe('session.jsonl.zstd')
    // The staged-publication residue is REPORTED (never deleted here), while the
    // noncanonical `.tmp` of another shape stays a non-candidate with no notice.
    expect(staleStagingFiles.map((path) => basename(path))).toEqual(['session.repair.deadbeef.jsonl.zstd.tmp'])
  })

  it('returns nothing for an empty root or a root with only current generations', async () => {
    const root = tempDir('rsl-find-empty-')
    expect((await findGenerations(root)).generations).toEqual([])
    writeGeneration(root, 'ns', 'a', 'session.v3.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    expect((await findGenerations(root)).generations).toEqual([])
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
    expect(out).toContain('summary: 4 log(s) | ok 1 (ok-truncated 0) | repairable 2 | unrepairable 1')
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
    expect(sink.out()).toContain('summary: 1 log(s) | ok 1 (ok-truncated 0) | repairable 0 | unrepairable 0')
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

  it('reports a pre-V3 generation that reads ok beside a v3 successor as ok and rewrites nothing (AC-7 dual-generation shape)', async () => {
    const root = tempDir('rsl-dual-generation-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(root, 'example-ns', 'session-dual', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    // The released chain already migrated this session: a current generation sits
    // beside the pre-V3 one (AC-7's 7 extra namespace directories).
    writeGeneration(root, 'example-ns', 'session-dual', 'session.v3.jsonl.zstd', { ...V0_HEADER, version: 3 }, [PLAIN_ROW])
    const successorPath = join(log.dir, 'session.v3.jsonl.zstd')
    const successorDigest = sha256(successorPath)
    const sink = captureIO()

    // Report mode: the selected pre-V3 generation reads `ok`, so the directory is
    // an extra NON-refusal row — not a decompress failure, not `other-refusal`.
    const result = await runRepair(optionsFor({ root, catalogPath }), bareEnv())
    expect(outcomeFor(result, 'session-dual')).toMatchObject({
      class: 'ok',
      status: 'ok',
      generation: 0,
      published: null,
    })
    expect(result.summary).toMatchObject({ total: 1, ok: 1, repairable: 0, refused: 0 })
    expect(result.exitCode).toBe(0)

    // Apply mode: an `ok` log is never rewritten and the existing successor keeps
    // exactly its bytes.
    const code = await execute(optionsFor({ root, catalogPath, apply: true }), sink.io, bareEnv())
    expect(code).toBe(0)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    expect(sha256(successorPath)).toBe(successorDigest)
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
/* the lossy opt-in (--drop-legacy-events)                             */
/* ------------------------------------------------------------------ */

/**
 * The lossy fixtures below use CONTIGUOUS event seqs ending with the legacy rows
 * (`seq 1`, `seq 2`), which is the only shape in which removing rows leaves the
 * released v0→v1 edge's `seq === eventCount` invariant intact. The hermetic fake
 * catalog does NOT model that invariant (it mirrors the released SHAPE and the
 * released REFUSAL MESSAGES only), so the loadability of a lossy successor is
 * proven against the REAL released catalog at the bottom of this file; the
 * measured real-store shape (a legacy row MID-sequence) is pinned there too.
 */
const LOSSY_DESCRIPTOR: Record<string, unknown> = { ...DESCRIPTOR_V2, seq: 0 }
const LOSSY_SWITCH_A: Record<string, unknown> = { ...FALLBACKS_SWITCH, seq: 1 }
const LOSSY_SWITCH_B: Record<string, unknown> = {
  ...FALLBACKS_SWITCH,
  seq: 2,
  time: 1786865067795,
  data: { turn: 5, step: 31, reason: 'half-open' },
}

/** One log carrying a repairable descriptor AND two TRAILING legacy rows. */
function writeLossyTree(): { root: string; dir: string; path: string } {
  const root = tempDir('rsl-lossy-')
  const log = writeGeneration(
    root,
    'example-ns',
    'session-lossy',
    'session.jsonl.zstd',
    V0_HEADER,
    [LOSSY_DESCRIPTOR, LOSSY_SWITCH_A, LOSSY_SWITCH_B],
  )
  return { root, ...log }
}

describe('--drop-legacy-events', () => {
  it('is off by default: the same log stays unrepairable and nothing is written', async () => {
    const { root, dir, path } = writeLossyTree()
    const catalogPath = writeFakeCatalog()
    const digest = sha256(path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true, backup: true }), sink.io, bareEnv())

    // The all-or-nothing default chain refuses the legacy rows, so the descriptor
    // bump never reaches a file (this is the frozen pre-flag behaviour).
    expect(code).toBe(1)
    expect(sink.out()).toContain('the repair proof refused')
    expect(sink.out()).not.toContain('repaired-lossy')
    expect(sink.err()).toContain('--apply PRECONDITION')
    expect(sink.err()).not.toContain('LOSSY')
    expect(sha256(path)).toBe(digest)
    expect(listing(dir)).toEqual(['session.jsonl.zstd'])
  })

  it('reports what would be dropped and its count in a dry run, without writing', async () => {
    const { root, dir, path } = writeLossyTree()
    const catalogPath = writeFakeCatalog()
    const digest = sha256(path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, dropLegacyEvents: true }), sink.io, bareEnv())

    // Report mode still refuses (nothing was published), but the lossy plan is
    // named per log and counted loudly.
    expect(code).toBe(1)
    expect(sink.out()).toContain('lossy-repairable (2 events to drop)')
    expect(sink.out()).toContain('LOSSY: 2 legacy fallbacks/switch event(s) would be removed by --apply')
    expect(sink.err()).toContain('would drop 2 legacy fallbacks/switch event(s) in 1 log(s)')
    expect(sink.err()).toContain('nothing was written')
    expect(sha256(path)).toBe(digest)
    expect(listing(dir)).toEqual(['session.jsonl.zstd'])
  })

  it('carries droppedEventCount per log in --json', async () => {
    const { root } = writeLossyTree()
    const catalogPath = writeFakeCatalog()
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, dropLegacyEvents: true, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult

    expect(code).toBe(1)
    expect(document.logs[0]).toMatchObject({
      class: 'subagent-descriptor-version',
      status: 'repairable',
      // The three counts mean different things: the source population, what a
      // published successor loses, and how many survivors move. A TRAILING drop
      // renumbers nobody.
      legacyEventCount: 2,
      droppedEventCount: 2,
      renumberedEventCount: 0,
      lossyRefusal: null,
      published: null,
    })
  })

  it('renumbers the survivors of a MID-sequence drop and reports both counts (hermetic mechanics)', async () => {
    const root = tempDir('rsl-lossy-mid-hermetic-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(root, 'example-ns', 'session-mid', 'session.jsonl.zstd', V0_HEADER, [
      { ...DESCRIPTOR_V2, seq: 0 },
      { ...FALLBACKS_SWITCH, seq: 1 },
      { ...PLAIN_ROW, seq: 2 },
    ])
    const original = readFileSync(log.path)
    const digest = sha256(log.path)
    const sink = captureIO()

    // The hermetic fake catalog does not model seq contiguity, so this pins the
    // MECHANICS and the counts; the real-catalog test at the bottom of this file
    // pins that such a successor actually loads.
    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    expect(code).toBe(0)
    expect(sink.out()).toContain('repaired-lossy (1 events dropped, 1 renumbered)')
    expect(sink.err()).toContain('dropped 1 legacy fallbacks/switch event(s) in 1 log(s)')
    expect(sink.err()).toContain('1 surviving event(s) received a new seq')
    expect(sha256(log.path)).toBe(digest)
    expect(readFileSync(`${log.path}.bak`)).toEqual(original)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd', 'session.jsonl.zstd.bak', 'session.v3.jsonl.zstd'])

    const catalog = (await resolveCatalog({ catalogPath, env: bareEnv() })) as CatalogHandle
    const readBack = readBackGeneration(catalog, join(log.dir, 'session.v3.jsonl.zstd'))
    // The survivor moved from seq 2 to seq 1; its content is otherwise untouched.
    expect(readBack.events).toEqual([
      { ...DESCRIPTOR_V2, seq: 0, data: { ...(DESCRIPTOR_V2['data'] as object), version: 3 } },
      { ...PLAIN_ROW, seq: 1 },
    ])
  })

  it('REFUSES a log whose surviving row references a dropped seq, writing nothing (the integrity gate)', async () => {
    const root = tempDir('rsl-lossy-ref-gate-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(root, 'example-ns', 'session-ref-gate', 'session.jsonl.zstd', V0_HEADER, [
      { ...PLAIN_ROW, seq: 0 },
      { ...FALLBACKS_SWITCH, seq: 1 },
      {
        type: 'assistant/message',
        seq: 2,
        time: 1786865067801,
        sourceEventSeqs: [1],
        surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { id: 'm' } },
      },
    ])
    const digest = sha256(log.path)
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true, json: true }),
      sink.io,
      bareEnv(),
    )
    const document = JSON.parse(sink.out()) as RunResult

    // Fail closed BEFORE any write (not even the --backup copy), and say why.
    expect(code).toBe(1)
    expect(document.logs[0]).toMatchObject({
      status: 'unrepairable',
      legacyEventCount: 1,
      droppedEventCount: 0,
      renumberedEventCount: 0,
      lossyRefusal: 'reference-integrity',
      published: null,
    })
    expect(document.logs[0]?.detail).toContain('reference integrity:')
    expect(document.logs[0]?.detail).toContain('sourceEventSeqs.0 names the dropped fallbacks/switch seq 1')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('keeps the lossy counts unambiguous on the pre-write refusal path (I1)', async () => {
    const root = tempDir('rsl-lossy-counts-refused-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(root, 'example-ns', 'session-refused-counts', 'session.jsonl.zstd', V0_HEADER, [
      { ...FALLBACKS_SWITCH, seq: 0 },
      { ...OTHER_UNKNOWN, seq: 1 },
    ])
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, dropLegacyEvents: true, json: true }),
      sink.io,
      bareEnv(),
    )
    const document = JSON.parse(sink.out()) as RunResult

    // `droppedEventCount: 0` alone used to be ambiguous: the population is now a
    // separate field, and the refusal category names the cause.
    expect(code).toBe(1)
    expect(document.logs[0]).toMatchObject({
      status: 'unrepairable',
      legacyEventCount: 1,
      droppedEventCount: 0,
      renumberedEventCount: 0,
      lossyRefusal: 'other',
    })
    expect(document.logs[0]?.detail).toContain('1 legacy fallbacks/switch row(s) in the source log, nothing written')
    expect(sink.err()).not.toContain('!! LOSSY:')
  })

  it('never publishes rows the ORACLE normalized in place (the released restore mutates its input)', async () => {
    const root = tempDir('rsl-oracle-mutation-')
    const catalogPath = writeFakeCatalog(undefined, FAKE_MUTATING_CATALOG_BODY)
    const sandbox: Record<string, unknown> = {
      type: 'sandbox/mode',
      seq: 0,
      time: 1786865067790,
      data: { mode: 'workspace-write', modes: ['workspace-write'] },
    }
    const log = writeGeneration(root, 'example-ns', 'session-oracle-mutation', 'session.jsonl.zstd', V0_HEADER, [
      sandbox,
      { ...DESCRIPTOR_V2, seq: 1 },
      { ...FALLBACKS_SWITCH, seq: 2 },
      // The oracle refuses THIS row, so it has already normalized every earlier
      // one — and the released restore normalizes nested members in place.
      {
        type: 'user/message',
        seq: 3,
        time: 1786865067797,
        data: { role: 'user', id: 'm', content: [], source: { kind: 'example-plugin-status' } },
      },
    ])
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    expect(code).toBe(0)
    // Read the BYTES, not the mutating fake's echo: the published row must be the
    // source row, untouched, so the oracle's in-place normalization cannot leak
    // into what this run writes.
    const frames = decodeZstdFrames(readFileSync(join(log.dir, 'session.v3.jsonl.zstd')))
    const published = frames
      .slice(1)
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(published[0]).toEqual(sandbox)
    expect(published.map((row) => row['type'])).toEqual(['sandbox/mode', 'subagent/descriptor', 'user/message'])
  })

  it('refuses --apply without --backup (exit 2), naming the flag pair, and writes nothing', async () => {
    const { root, dir, path } = writeLossyTree()
    const catalogPath = writeFakeCatalog()
    const digest = sha256(path)
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    expect(code).toBe(2)
    expect(sink.err()).toContain('--drop-legacy-events with --apply requires --backup')
    expect(sink.err()).toContain('--drop-legacy-events is LOSSY')
    expect(sink.out()).toBe('')
    expect(sha256(path)).toBe(digest)
    expect(listing(dir)).toEqual(['session.jsonl.zstd'])

    await expect(
      runRepair(optionsFor({ root, catalogPath, apply: true, dropLegacyEvents: true }), bareEnv()),
    ).rejects.toBeInstanceOf(FatalError)
  })

  it('drops exactly the legacy rows with --apply --backup and reads the successor back as current', async () => {
    const { root, dir, path } = writeLossyTree()
    const catalogPath = writeFakeCatalog()
    const original = readFileSync(path)
    const digest = sha256(path)
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    expect(code).toBe(0)
    // The loud data-loss warning names the count and the kind of rows lost.
    expect(sink.err()).toContain('--drop-legacy-events is LOSSY')
    expect(sink.err()).toContain('dropped 2 legacy fallbacks/switch event(s) in 1 log(s)')
    expect(sink.err()).toContain('provider/model switch audit trail')
    expect(sink.out()).toContain('repaired-lossy (2 events dropped)')
    expect(sink.out()).toContain('published session.v3.jsonl.zstd')
    expect(sink.out()).toContain("validation: 'current'")

    // The original is byte-identical, the noncanonical backup holds those bytes,
    // and no staging file survives.
    expect(sha256(path)).toBe(digest)
    expect(readFileSync(`${path}.bak`)).toEqual(original)
    const successor = join(dir, 'session.v3.jsonl.zstd')
    expect(listing(dir)).toEqual(['session.jsonl.zstd', 'session.jsonl.zstd.bak', 'session.v3.jsonl.zstd'])

    // Read the published generation back with the host's current policy: the
    // switch rows are gone, the descriptor bump is in, nothing else was touched.
    const catalog = (await resolveCatalog({ catalogPath, env: bareEnv() })) as CatalogHandle
    const readBack = readBackGeneration(catalog, successor)
    expect(readBack.version).toBe(3)
    expect(readBack.events.map((event) => (event as { type: string }).type)).toEqual([
      'subagent/descriptor',
    ])
    expect(readBack.events[0]).toMatchObject({ data: { version: 3, mode: 'one-shot' } })
  })

  it('is idempotent: a second lossy --apply keeps the same successor bytes and drops nothing more', async () => {
    const { root, dir, path } = writeLossyTree()
    const catalogPath = writeFakeCatalog()
    const options = optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true })

    expect(await execute(options, captureIO().io, bareEnv())).toBe(0)
    const publishedDigest = sha256(join(dir, 'session.v3.jsonl.zstd'))

    const second = captureIO()
    expect(await execute(options, second.io, bareEnv())).toBe(0)

    // The publication path reports whether it CREATED the target or ACCEPTED an
    // already-identical one (C-2), so a re-run cannot read as a new publication.
    expect(second.out()).toContain(
      'already published session.v3.jsonl.zstd (verified byte-identical; accepted, not written by this run)',
    )
    expect(sha256(join(dir, 'session.v3.jsonl.zstd'))).toBe(publishedDigest)
    expect(sha256(path)).toBe(sha256(`${path}.bak`))
    expect(listing(dir)).toEqual(['session.jsonl.zstd', 'session.jsonl.zstd.bak', 'session.v3.jsonl.zstd'])
  })

  it('never drops an unknown event type of any other name', async () => {
    const root = tempDir('rsl-lossy-other-unknown-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(
      root,
      'example-ns',
      'session-other-unknown',
      'session.jsonl.zstd',
      V0_HEADER,
      [OTHER_UNKNOWN],
    )
    const digest = sha256(log.path)
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    // The log is refused for a row the lossy rule cannot remove, so the class gate
    // keeps the fail-closed verdict: unrepairable, nothing written, no drop.
    expect(code).toBe(1)
    expect(sink.out()).toContain('unrepairable')
    expect(sink.out()).toContain('unknown-event-type: no registered normalize step can make this log load')
    expect(sink.err()).not.toContain('!! LOSSY: dropped')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('does not rescue a log that additionally carries another unknown type: nothing is written at all', async () => {
    const root = tempDir('rsl-lossy-mixed-unknown-')
    const catalogPath = writeFakeCatalog()
    // DENSE seqs: the lossy mode renumbers the survivors, so its source log must be
    // densely numbered (the shared fixtures carry the raw seqs measured in a real
    // log, which are only dense inside that log).
    const log = writeGeneration(
      root,
      'example-ns',
      'session-mixed-unknown',
      'session.jsonl.zstd',
      V0_HEADER,
      [{ ...FALLBACKS_SWITCH, seq: 0 }, { ...OTHER_UNKNOWN, seq: 1 }],
    )
    const digest = sha256(log.path)
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    // The drop itself is provable, but the pre-write proof refuses it because the
    // repaired rows still do not restore: the other unknown row would remain, so
    // the log stays unrepairable and NOTHING is written — not even the --backup
    // copy — and no event is reported as dropped.
    expect(code).toBe(1)
    expect(sink.out()).toContain('unrepairable')
    expect(sink.out()).toContain('the lossy drop was refused before any write')
    expect(sink.out()).toContain('do not restore through the released catalog')
    expect(sink.out()).toContain('unknown historical event type "legacy/unknown-note"')
    expect(sink.err()).not.toContain('!! LOSSY: dropped')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('reports the same refusal in dry run: a differently-unknown neighbour is never dropped', async () => {
    const root = tempDir('rsl-lossy-mixed-unknown-report-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(
      root,
      'example-ns',
      'session-mixed-unknown',
      'session.jsonl.zstd',
      V0_HEADER,
      [{ ...FALLBACKS_SWITCH, seq: 0 }, { ...OTHER_UNKNOWN, seq: 1 }],
    )
    const digest = sha256(log.path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, dropLegacyEvents: true }), sink.io, bareEnv())

    expect(code).toBe(1)
    expect(sink.out()).toContain('unrepairable')
    expect(sink.out()).toContain('the lossy drop was refused before any write')
    expect(sink.out()).not.toContain('lossy-repairable')
    expect(sink.err()).not.toContain('!! LOSSY:')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('keeps an unparseable line fatal: a malformed row beside legacy rows is decompress-failed, never dropped', async () => {
    const root = tempDir('rsl-lossy-malformed-')
    const catalogPath = writeFakeCatalog()
    // A genuine legacy row, then a line that parses as JSON but is not a row.
    const log = writeGeneration(root, 'example-ns', 'session-malformed', 'session.jsonl.zstd', V0_HEADER, [
      FALLBACKS_SWITCH,
      'not-a-row' as unknown as Record<string, unknown>,
    ])
    const digest = sha256(log.path)
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    // The drop must never make a line it could not parse disappear, so the whole
    // log is refused as undecodable and nothing is written.
    expect(code).toBe(1)
    expect(sink.out()).toContain('decompress-failed')
    expect(sink.out()).toContain('unrepairable')
    expect(sink.out()).toContain('not a JSON object')
    expect(sink.out()).not.toContain('LOSSY')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('never drops a row that merely CONTAINS the legacy type name in its data', async () => {
    const root = tempDir('rsl-lossy-substring-')
    const catalogPath = writeFakeCatalog()
    const mentions: Record<string, unknown> = {
      type: 'user/message',
      seq: 0,
      time: 1786865067792,
      data: { text: 'the legacy "fallbacks/switch" row was dropped', role: 'user' },
    }
    const log = writeGeneration(
      root,
      'example-ns',
      'session-mentions',
      'session.jsonl.zstd',
      V0_HEADER,
      [mentions, { ...FALLBACKS_SWITCH, seq: 1 }],
    )
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      bareEnv(),
    )

    // Only the PARSED `type` decides: the mentioning message survives with its
    // bytes intact, exactly one event is dropped.
    expect(code).toBe(0)
    expect(sink.out()).toContain('repaired-lossy (1 events dropped)')
    const catalog = (await resolveCatalog({ catalogPath, env: bareEnv() })) as CatalogHandle
    const readBack = readBackGeneration(catalog, join(log.dir, 'session.v3.jsonl.zstd'))
    expect(readBack.events).toEqual([mentions])
  })

  it('fails closed in report mode without a catalog: the post-drop restore cannot be proven', async () => {
    const { root, dir, path } = writeLossyTree()
    const digest = sha256(path)
    const sink = captureIO()

    const code = await execute(optionsFor({ root, dropLegacyEvents: true }), sink.io, bareEnv())

    expect(code).toBe(1)
    expect(sink.out()).toContain('lossy drop was refused before any write')
    expect(sink.out()).toContain('no released catalog resolved')
    expect(sink.out()).not.toContain('lossy-repairable')
    expect(sha256(path)).toBe(digest)
    expect(listing(dir)).toEqual(['session.jsonl.zstd'])
  })

  it('keeps --class authoritative over the lossy rule', async () => {
    const root = tempDir('rsl-lossy-class-filter-')
    const catalogPath = writeFakeCatalog()
    const log = writeGeneration(
      root,
      'example-ns',
      'session-lossy',
      'session.jsonl.zstd',
      V0_HEADER,
      // Dense seq: the lossy renumber refuses a source log that is not densely
      // numbered, and this fixture must reach the `--class` decision instead.
      [{ ...FALLBACKS_SWITCH, seq: 0 }],
    )
    const digest = sha256(log.path)
    const sink = captureIO()

    // `--class source-kind` excludes the drop rule from this run's proof chain. The
    // full policy repairs the log, so it is reported `repairable`, but with the
    // filter the policy's only repair for the legacy rows is not applied — the
    // promise must say that instead of "run with --apply" (which would fail at the
    // publisher's strict restore), and nothing may be written.
    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, backup: true, dropLegacyEvents: true, classFilter: 'source-kind' }),
      sink.io,
      bareEnv(),
    )

    expect(code).toBe(1)
    expect(sink.out()).toContain(
      "--class source-kind excludes the rule that removes this log's legacy fallbacks/switch row(s)",
    )
    expect(sink.out()).toContain('so --apply with this filter cannot publish it')
    expect(sink.out()).not.toContain('run with --apply')
    expect(sink.out()).toContain('not selected 1')
    expect(sink.err()).not.toContain('!! LOSSY: dropped')
    expect(sha256(log.path)).toBe(digest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])

    // Report mode makes the same promise correction (no --apply involved).
    const report = captureIO()
    expect(
      await execute(
        optionsFor({ root, catalogPath, dropLegacyEvents: true, classFilter: 'source-kind' }),
        report.io,
        bareEnv(),
      ),
    ).toBe(1)
    expect(report.out()).toContain('so --apply with this filter cannot publish it')
    expect(report.out()).not.toContain('run with --apply')
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
    // The lossy opt-in is documented, including its --backup requirement, the
    // renumbering it performs and the semantics of its three counts.
    expect(sink.out()).toContain('--drop-legacy-events')
    expect(sink.out()).toContain('LOSSY, off by default')
    expect(sink.out()).toContain('REQUIRES --backup')
    expect(sink.out()).toContain('RENUMBERING: the same edge requires each event\'s seq')
    expect(sink.out()).toContain('refused with nothing written')
    expect(sink.out()).toContain('COUNTS (--json, per log): legacyEventCount is the parsed legacy row')
    expect(sink.out()).toContain('droppedEventCount counts rows removed from the successor')
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

/**
 * A synthesized v0 log: one descriptor v2 plus one unclassified source kind.
 */
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

/** One legacy `fallbacks/switch` event at the requested seq. */
function legacySwitch(seq: number): Record<string, unknown> {
  return { ...FALLBACKS_SWITCH, seq }
}

/**
 * The measured real-store shape that CAN be dropped: the legacy rows are the LAST
 * events, so removing them leaves the released edge's `seq === eventCount`
 * invariant intact (seqs 0..8, then the dropped 9 and 10).
 */
const REAL_LOSSY_TRAILING_EVENTS: readonly Record<string, unknown>[] = [
  ...REAL_FIXTURE_EVENTS,
  legacySwitch(9),
  legacySwitch(10),
]

/**
 * The measured real-store shape that CANNOT be dropped: the legacy row occupies a
 * seq slot in the MIDDLE of the log, so removing it leaves the survivors with a
 * gap (`expected 5, got 6`) and the frozen V0→V1 edge refuses the whole file.
 * This is the shape of all 25 blocked namespace logs.
 */
const REAL_LOSSY_MID_SEQUENCE_EVENTS: readonly Record<string, unknown>[] = [
  ...REAL_FIXTURE_EVENTS.slice(0, 5).map((row) => ({ ...row })),
  legacySwitch(5),
  ...REAL_FIXTURE_EVENTS.slice(5).map((row) => ({ ...row, seq: (row['seq'] as number) + 1 })),
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

  it('drop-legacy-events: recovers a log whose legacy rows are TRAILING (real catalog proof)', async () => {
    const oracle = realCatalog as CatalogHandle
    const root = tempDir('rsl-real-lossy-trailing-')
    const session = 'session-22222222-2222-4222-8222-222222222222'
    const log = writeGeneration(
      root,
      '--example-namespace--',
      session,
      'session.jsonl.zstd',
      V0_HEADER,
      REAL_LOSSY_TRAILING_EVENTS,
    )
    const original = readFileSync(log.path)
    const digest = sha256(log.path)
    const sink = captureIO()

    // Without the flag the legacy rows still block the default chain.
    const report = await runRepair(optionsFor({ root, catalogPath: oracle.modulePath }), process.env)
    expect(outcomeFor(report, session)).toMatchObject({ class: 'subagent-descriptor-version', status: 'unrepairable' })

    // With the opt-in + --backup the successor is published and read back.
    const code = await execute(
      optionsFor({ root, catalogPath: oracle.modulePath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      process.env,
    )

    expect(code).toBe(0)
    expect(sink.out()).toContain('repaired-lossy (2 events dropped)')
    expect(sink.err()).toContain('dropped 2 legacy fallbacks/switch event(s) in 1 log(s)')
    // The original is byte-identical, the backup holds those bytes, no temp remains.
    expect(sha256(log.path)).toBe(digest)
    expect(readFileSync(`${log.path}.bak`)).toEqual(original)
    const successor = join(log.dir, 'session.v3.jsonl.zstd')
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd', 'session.jsonl.zstd.bak', 'session.v3.jsonl.zstd'])
    // The published generation reads back as current through the REAL released
    // catalog, and its events are the survivors with no legacy row left. The
    // migration may synthesize events of its own, so the assertion is on content.
    const readBack = readBackGeneration(oracle, successor)
    expect(readBack.version).toBe(3)
    const types = readBack.events.map((event) => (event as { type?: string }).type)
    expect(types).not.toContain('fallbacks/switch')
    expect(types).toEqual(
      expect.arrayContaining(['sandbox/mode', 'subagent/descriptor', 'user/message', 'turn/end']),
    )
    // The descriptor bump the same run performed is inside the published artifact.
    expect(
      readBack.events.find((event) => (event as { type?: string }).type === 'subagent/descriptor'),
    ).toMatchObject({ data: { version: 3 } })
  })

  it('drop-legacy-events: RECOVERS the measured mid-sequence shape by renumbering the survivors (real catalog proof)', async () => {
    const oracle = realCatalog as CatalogHandle
    const root = tempDir('rsl-real-lossy-mid-')
    const session = 'session-33333333-3333-4333-8333-333333333333'
    const log = writeGeneration(
      root,
      '--example-namespace--',
      session,
      'session.jsonl.zstd',
      V0_HEADER,
      REAL_LOSSY_MID_SEQUENCE_EVENTS,
    )
    const original = readFileSync(log.path)
    const digest = sha256(log.path)
    const sink = captureIO()

    // Without the flag the mid-sequence legacy row still blocks the default chain.
    const report = await runRepair(optionsFor({ root, catalogPath: oracle.modulePath }), process.env)
    expect(outcomeFor(report, session)).toMatchObject({ status: 'unrepairable' })

    const code = await execute(
      optionsFor({ root, catalogPath: oracle.modulePath, apply: true, backup: true, dropLegacyEvents: true }),
      sink.io,
      process.env,
    )

    // Drop-only used to leave `expected 5, got 6` and write nothing; the renumber
    // moves every survivor after the dropped row down by one, so the successor loads.
    expect(code).toBe(0)
    expect(sink.out()).toContain('repaired-lossy (1 events dropped, ')
    expect(sink.out()).toContain('renumbered)')
    expect(sink.err()).toContain('dropped 1 legacy fallbacks/switch event(s) in 1 log(s)')
    expect(sink.err()).toContain('received a new seq')
    // The original is byte-identical, the backup holds those bytes, no temp remains.
    expect(sha256(log.path)).toBe(digest)
    expect(readFileSync(`${log.path}.bak`)).toEqual(original)
    const successor = join(log.dir, 'session.v3.jsonl.zstd')
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd', 'session.jsonl.zstd.bak', 'session.v3.jsonl.zstd'])

    // The published generation reads back as CURRENT through the REAL released
    // catalog — the loadability proof — with no legacy row and dense seqs.
    const readBack = readBackGeneration(oracle, successor)
    expect(readBack.version).toBe(3)
    expect(readBack.events.map((event) => (event as { type?: string }).type)).not.toContain('fallbacks/switch')
    expect(readBack.events.map((event) => (event as { seq: number }).seq)).toEqual(
      readBack.events.map((_event, index) => index),
    )
  })
})

/* ------------------------------------------------------------------ */
/* QC fix wave (C-1, C-2, C-3, C-4, C-6, S-10, S-11)                   */
/* ------------------------------------------------------------------ */

/** The current user id, or `null` where the platform does not expose one. */
const UID = process.getuid?.() ?? null

describe('discovery never fails open (C-1)', () => {
  it('reports symlinked and irregular entries as skipped instead of dropping them', async () => {
    const root = tempDir('rsl-skip-shapes-')
    const healthy = writeGeneration(root, 'good-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    // A symlinked namespace, session and generation, plus a DIRECTORY named like a
    // generation: none may disappear from the report without a word.
    const linkedTarget = join(root, 'linked-target')
    mkdirSync(linkedTarget, { recursive: true })
    symlinkSync(linkedTarget, join(root, 'linked-ns'))
    symlinkSync(healthy.dir, join(root, 'good-ns', 'session-linked'))
    mkdirSync(join(root, 'good-ns', 'session-linked-generation'), { recursive: true })
    symlinkSync(healthy.path, join(root, 'good-ns', 'session-linked-generation', 'session.jsonl.zstd'))
    mkdirSync(join(root, 'good-ns', 'session-dir-generation', 'session.jsonl.zstd'), { recursive: true })
    // Residue of an interrupted publication: reported, never deleted here.
    const staleName = 'session.repair.deadbeef.jsonl.zstd.tmp'
    writeFileSync(join(healthy.dir, staleName), 'staged bytes')
    const sink = captureIO()

    const code = await execute(optionsFor({ root, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult

    expect(code).toBe(1)
    expect(document.summary.skipped).toBe(4)
    const relative = document.skipped.map((entry) => entry.path.slice(root.length + 1)).sort()
    expect(relative).toEqual([
      'good-ns/session-dir-generation/session.jsonl.zstd',
      'good-ns/session-linked',
      'good-ns/session-linked-generation/session.jsonl.zstd',
      'linked-ns',
    ])
    const reasonOf = new Map(document.skipped.map((entry) => [entry.path.slice(root.length + 1), entry.reason]))
    expect(reasonOf.get('linked-ns')).toContain('symlink')
    expect(reasonOf.get('good-ns/session-linked')).toContain('symlink')
    expect(reasonOf.get('good-ns/session-linked-generation/session.jsonl.zstd')).toContain('symlink')
    expect(reasonOf.get('good-ns/session-dir-generation/session.jsonl.zstd')).toContain('not a regular file')
    // The healthy log is still triaged, and a skip suppresses the "no session log"
    // line that would otherwise describe an empty root.
    expect(document.logs).toHaveLength(1)
    expect(document.staleStagingFiles.map((path) => basename(path))).toEqual([staleName])

    const text = captureIO()
    expect(await execute(optionsFor({ root }), text.io, bareEnv())).toBe(1)
    expect(text.out()).toContain('skipped')
    expect(text.out()).toContain('linked-ns')
    expect(text.out()).toContain('stale staging')
    expect(text.out()).toContain('skipped 4')
  })

  it.skipIf(UID === 0)('reports an unreadable namespace with its errno and exits 1', async () => {
    const root = tempDir('rsl-skip-eacces-')
    writeGeneration(root, 'good-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [PLAIN_ROW])
    const blocked = join(root, 'blocked-ns')
    mkdirSync(blocked)
    chmodSync(blocked, 0o000)
    try {
      const sink = captureIO()
      const code = await execute(optionsFor({ root, json: true }), sink.io, bareEnv())
      const document = JSON.parse(sink.out()) as RunResult

      expect(code).toBe(1)
      expect(document.summary.skipped).toBe(1)
      expect(document.skipped[0]?.path).toBe(blocked)
      expect(document.skipped[0]?.reason).toContain('EACCES')
      expect(document.logs).toHaveLength(1)
    } finally {
      chmodSync(blocked, 0o755)
    }
  })

  it('folds stale staging and skips into the exit code, the empty-root line and --quiet', async () => {
    // A root whose ONLY content is the residue of an interrupted publication: no
    // candidate, no unreadable input — but the store is not "clean", so the run says
    // so everywhere the docs promise it does.
    const staleRoot = tempDir('rsl-stale-only-')
    const staleDir = join(staleRoot, 'example-ns', 'session-stale')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'session.repair.deadbeef.jsonl.zstd.tmp'), 'staged bytes')
    const stale = captureIO()

    expect(await execute(optionsFor({ root: staleRoot }), stale.io, bareEnv())).toBe(1)
    expect(stale.out()).toContain('stale staging')
    expect(stale.out()).toContain('session.repair.deadbeef.jsonl.zstd.tmp')
    expect(stale.out()).not.toContain('no session log with a canonical generation')
    expect(stale.out()).toContain('stale staging 1')

    // --quiet keeps the named diagnostics (only the per-log lines and the by-class
    // table are suppressed), which is what the README promises.
    const quiet = captureIO()
    expect(await execute(optionsFor({ root: staleRoot, quiet: true }), quiet.io, bareEnv())).toBe(1)
    expect(quiet.out()).toContain('stale staging')
    expect(quiet.out()).toContain('session.repair.deadbeef.jsonl.zstd.tmp')
    expect(quiet.out()).not.toContain('class                        logs')

    // The suppression branch with NO candidates and at least one SKIP (the C-1 tests
    // always keep a healthy log in the tree): a root with one symlinked session only.
    const skipRoot = tempDir('rsl-skip-only-')
    const target = join(skipRoot, 'target-session')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'session.jsonl.zstd'), encodeZstdFrames(V0_HEADER, [{ ...PLAIN_ROW, seq: 0 }]))
    const namespaceDir = join(skipRoot, 'example-ns')
    mkdirSync(namespaceDir, { recursive: true })
    symlinkSync(target, join(namespaceDir, 'session-linked'))
    const skippedOnly = captureIO()

    expect(await execute(optionsFor({ root: skipRoot }), skippedOnly.io, bareEnv())).toBe(1)
    expect(skippedOnly.out()).toContain('skipped')
    expect(skippedOnly.out()).toContain('session-linked')
    expect(skippedOnly.out()).not.toContain('no session log with a canonical generation')
    expect(skippedOnly.out()).toContain('skipped 1')
  })

  it.skipIf(UID === 0)('makes an unreadable --root fatal (exit 2) instead of an empty report', async () => {
    const root = tempDir('rsl-root-eacces-')
    chmodSync(root, 0o000)
    try {
      const sink = captureIO()
      const code = await execute(optionsFor({ root }), sink.io, bareEnv())

      expect(code).toBe(2)
      expect(sink.err()).toContain('--root cannot be read')
      expect(sink.err()).toContain('EACCES')
      expect(sink.out()).toBe('')
    } finally {
      chmodSync(root, 0o755)
    }
  })
})

describe('publication revision pin (C-2)', () => {
  /**
   * The fake catalog, but appending one row to the log the FIRST time it validates
   * it: a live writer appending between this run's decode read and its publication
   * read, which is the window the digest hand-off closes.
   */
  function concurrentAppendCatalogBody(target: string): string {
    return FAKE_CATALOG_BODY
      .replace(
        'export const sessionFormatCatalog = {',
        `import { appendFileSync } from 'node:fs'\nexport const sessionFormatCatalog = {`,
      )
      .replace(
        '    const events = []',
        `    const events = []
    let appended = false`,
      )
      .replace(
        '      decodeRow(row) {',
        `      decodeRow(row) {
        if (!appended) {
          appended = true
          appendFileSync(${JSON.stringify(target)}, '{"type":"turn/end","seq":1,"time":2,"data":{"turn":1,"reason":{"kind":"completed"}}}\\n')
        }`,
      )
  }

  it('refuses to publish a revision it did not decode, and writes nothing', async () => {
    const root = tempDir('rsl-stale-revision-')
    const log = writeGeneration(root, 'example-ns', 'session-concurrent', 'session.jsonl.zstd', V0_HEADER, [
      { ...PLAIN_ROW, seq: 0 },
      { ...DESCRIPTOR_V2, seq: 1 },
    ])
    const catalogPath = writeFakeCatalog(undefined, concurrentAppendCatalogBody(log.path))
    const sink = captureIO()

    const code = await execute(
      optionsFor({ root, catalogPath, apply: true, json: true }),
      sink.io,
      bareEnv(),
    )
    const document = JSON.parse(sink.out()) as RunResult

    // The append happened while the run was reading: the successor must not be
    // built from the stale revision, and nothing may be staged for it.
    expect(code).toBe(1)
    expect(document.logs[0]).toMatchObject({ status: 'unrepairable', failed: true, published: null })
    expect(document.logs[0]?.detail).toContain('the source generation changed since it was read')
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  /**
   * The fake catalog, but appending one row to the log while it ENCODES the
   * successor — i.e. after the pre-write revision check and after the publication
   * itself, which is the only window the post-publication settlement handles.
   */
  function appendOnEncodeCatalogBody(target: string): string {
    // `JSON.stringify` keeps the appended row a legal JS string literal inside the
    // generated module: a raw newline there would make the module fail to parse, and
    // the catalog would then simply not resolve.
    const appendedRow = JSON.stringify(
      '{"type":"turn/end","seq":1,"time":2,"data":{"turn":1,"reason":{"kind":"completed"}}}\n',
    )
    return FAKE_CATALOG_BODY
      .replace(
        'export const sessionFormatCatalog = {',
        `import { appendFileSync } from 'node:fs'
let appendedOnEncode = false
export const sessionFormatCatalog = {`,
      )
      .replace(
        '  encodeCurrentEvent: (event) => ({ ...event }),',
        `  encodeCurrentEvent: (event) => {
    if (!appendedOnEncode) {
      appendedOnEncode = true
      appendFileSync(${JSON.stringify(target)}, ${appendedRow})
    }
    return { ...event }
  },`,
      )
  }

  /** A repairable log (descriptor v2) the fake catalog can publish. */
  function writePublishableLog(root: string, session: string): { dir: string; path: string } {
    return writeGeneration(root, 'example-ns', session, 'session.jsonl.zstd', V0_HEADER, [
      { ...PLAIN_ROW, seq: 0 },
      { ...DESCRIPTOR_V2, seq: 1 },
    ])
  }

  it('removes a successor it created when the source moved after publication (end to end)', async () => {
    const root = tempDir('rsl-stale-after-created-')
    const log = writePublishableLog(root, 'session-stale-created')
    const catalogPath = writeFakeCatalog(undefined, appendOnEncodeCatalogBody(log.path))
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath, apply: true, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult

    // The created successor was unlinked again, so "nothing was published" is true
    // and there is no stale path to report.
    expect(code).toBe(1)
    expect(document.logs[0]).toMatchObject({ status: 'unrepairable', failed: true, published: null })
    expect(document.logs[0]?.stalePublicationPath).toBeNull()
    expect(document.logs[0]?.detail).toContain('nothing was published')
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })

  it('names an ACCEPTED successor left on disk when the source moved after publication (end to end)', async () => {
    const root = tempDir('rsl-stale-after-accepted-')
    const log = writePublishableLog(root, 'session-stale-accepted')
    // First publication (no race): this creates the canonical successor.
    expect(await execute(optionsFor({ root, catalogPath: writeFakeCatalog(), apply: true }), captureIO().io, bareEnv())).toBe(0)
    const successor = join(log.dir, 'session.v3.jsonl.zstd')
    const publishedDigest = sha256(successor)

    // Second run with the appending oracle: the identical target is ACCEPTED, then the
    // source is found changed — the file is NOT this run's to delete.
    const catalogPath = writeFakeCatalog(undefined, appendOnEncodeCatalogBody(log.path))
    const sink = captureIO()
    const code = await execute(optionsFor({ root, catalogPath, apply: true, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult

    expect(code).toBe(1)
    expect(document.logs[0]).toMatchObject({
      status: 'unrepairable',
      failed: true,
      published: null,
      alreadyPublished: false,
    })
    // Structured, not free text: a consumer cannot read this as "nothing was published".
    expect(document.logs[0]?.stalePublicationPath).toBe(successor)
    expect(document.logs[0]?.detail).toContain('a successor WAS published from a snapshot that is now stale')
    expect(document.logs[0]?.detail).toContain(successor)
    expect(existsSync(successor)).toBe(true)
    expect(sha256(successor)).toBe(publishedDigest)
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
  })

  it('keeps the "nothing was published" wording only when nothing was published', async () => {
    const candidate = { path: '/tmp/example/session.jsonl.zstd', generation: 0, sessionDir: '/tmp/example' }
    const outcome = analysisFailureOutcome(candidate, new Error('boom'))
    expect(outcome).toMatchObject({ status: 'unrepairable', failed: true, published: null })
    expect(outcome.detail).toContain("analysis failed before this log's counts were known")
    expect(outcome.detail).toContain('nothing was written for this log: boom')
    expect(outcome.stalePublicationPath).toBeNull()
  })
})

describe('ok-truncated cross-check axis (seat 2 N-3)', () => {
  /**
   * A catalog that refuses according to the policy it is asked for, so the axis the
   * cross-check uses is directly observable: `onCurrent` mirrors the old
   * `validation: 'current'` choice, `onStrictRecovery` mirrors the cross-check's.
   */
  function axisCatalogBody(mode: 'onCurrent' | 'onStrictRecovery'): string {
    return FAKE_CATALOG_BODY
      .replace(
        '  createRestore(header, options) {',
        `  createRestore(header, options) {
    if (options && options.validation === 'current' && ${mode === 'onCurrent'}) {
      throw new Error('refused by the current-format validation axis')
    }
    if (options && options.recovery === 'strict' && ${mode === 'onStrictRecovery'}) {
      throw new Error('refused by strict recovery at seq 2')
    }`,
      )
  }

  it('reports plain ok when only the current-VALIDATION axis would refuse', async () => {
    const root = tempDir('rsl-ok-axis-validation-')
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [{ ...PLAIN_ROW, seq: 0 }])
    const catalogPath = writeFakeCatalog(undefined, axisCatalogBody('onCurrent'))
    const sink = captureIO()

    expect(await execute(optionsFor({ root, catalogPath, json: true }), sink.io, bareEnv())).toBe(0)
    const document = JSON.parse(sink.out()) as RunResult

    // Same recovery policy as the loader: no rows are dropped, so the session is NOT
    // truncated and must not be tokenised `ok-truncated`.
    expect(document.logs[0]).toMatchObject({ status: 'ok', strictRefusal: null })
    expect(document.summary.okTruncated).toBe(0)
  })

  it('reports ok-truncated when the same policy with STRICT recovery refuses', async () => {
    const root = tempDir('rsl-ok-axis-recovery-')
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [{ ...PLAIN_ROW, seq: 0 }])
    const catalogPath = writeFakeCatalog(undefined, axisCatalogBody('onStrictRecovery'))
    const sink = captureIO()

    expect(await execute(optionsFor({ root, catalogPath, json: true }), sink.io, bareEnv())).toBe(0)
    const document = JSON.parse(sink.out()) as RunResult

    expect(document.logs[0]?.strictRefusal).toContain('refused by strict recovery at seq 2')
    expect(document.summary.okTruncated).toBe(1)
    expect(document.logs[0]?.detail).toContain('opens with the rows after that refusal silently dropped')
  })
})

describe('catalog release pin (C-3)', () => {
  it('refuses a catalog below the required format version with a fatal (exit 2)', async () => {
    const root = tempDir('rsl-catalog-floor-')
    writeGeneration(root, 'example-ns', 'session-x', 'session.jsonl.zstd', V0_HEADER, [{ ...PLAIN_ROW, seq: 0 }])
    const catalogPath = writeFakeCatalog(undefined, FAKE_CATALOG_BODY.replace('currentVersion: 3', 'currentVersion: 2'))
    const sink = captureIO()

    const code = await execute(optionsFor({ root, catalogPath }), sink.io, bareEnv())

    expect(code).toBe(2)
    expect(sink.err()).toContain('declares currentVersion 2')
    expect(sink.err()).toContain('requires at least 3')
    expect(sink.out()).toBe('')

    await expect(runRepair(optionsFor({ root, catalogPath }), bareEnv())).rejects.toBeInstanceOf(FatalError)
  })

  it('names the trusted catalog release in the text report and in --json', async () => {
    const root = tempDir('rsl-catalog-version-')
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [{ ...PLAIN_ROW, seq: 0 }])
    const catalogPath = writeFakeCatalog()

    const text = captureIO()
    expect(await execute(optionsFor({ root, catalogPath }), text.io, bareEnv())).toBe(0)
    expect(text.out()).toContain('(v3, package 0.1.5-rc.1, resolved by option)')

    const sink = captureIO()
    await execute(optionsFor({ root, catalogPath, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult
    expect(document.catalog).toMatchObject({ resolved: true, packageVersion: '0.1.5-rc.1', currentVersion: 3 })
  })

  it('keeps the by-class table exhaustive over the vocabulary (C-4 drift pin)', async () => {
    const root = tempDir('rsl-byclass-drift-')
    writeGeneration(root, 'example-ns', 'session-ok', 'session.jsonl.zstd', V0_HEADER, [{ ...PLAIN_ROW, seq: 0 }])
    const catalogPath = writeFakeCatalog()
    const sink = captureIO()

    await execute(optionsFor({ root, catalogPath, json: true }), sink.io, bareEnv())
    const document = JSON.parse(sink.out()) as RunResult

    // A class missing from the ordered vocabulary would seed `NaN` here and drop its
    // row from the table; the keys and the total keep that from being silent.
    expect(Object.keys(document.summary.byClass).sort()).toEqual([...REFUSAL_CLASSES].sort())
    expect(Object.values(document.summary.byClass).every((count) => Number.isFinite(count))).toBe(true)
    expect(Object.values(document.summary.byClass).reduce((sum, count) => sum + count, 0)).toBe(document.summary.total)
  })
})

/* ------------------------------------------------------------------ */
/* QC fix wave against the REAL released catalog (C-5, C-6)            */
/* ------------------------------------------------------------------ */

/** A v0 log whose FIRST refusal is a foreign `source.kind`. */
const REAL_SOURCE_KIND_FIRST_EVENTS: readonly Record<string, unknown>[] = [
  { ...SOURCE_KIND, seq: 0 },
  { type: 'turn/start', seq: 1, time: 1786865067774, data: { turn: 1 } },
  { type: 'turn/end', seq: 2, time: 1786865237514, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** A v0 log whose FIRST refusal is the legacy `fallbacks/switch` row. */
const REAL_LEGACY_FIRST_EVENTS: readonly Record<string, unknown>[] = [
  legacySwitch(0),
  { type: 'sandbox/mode', seq: 1, time: 1786864997350, data: { mode: 'workspace-write' } },
  { type: 'turn/start', seq: 2, time: 1786865067774, data: { turn: 1 } },
  { type: 'turn/end', seq: 3, time: 1786865237514, data: { turn: 1, reason: { kind: 'completed' } } },
]

/**
 * A v0 log the host loader's policy reads WITHOUT refusal while the strict,
 * current-format policy refuses it: the trailing row has a seq gap, and the
 * recoverable policy only rethrows a swallowed issue when a later `turn/end`
 * surfaces it — there is none, so those rows are silently dropped.
 */
const REAL_OK_TRUNCATED_EVENTS: readonly Record<string, unknown>[] = [
  { type: 'sandbox/mode', seq: 0, time: 1786864997350, data: { mode: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 1786865067774, data: { turn: 1 } },
  { type: 'turn/end', seq: 2, time: 1786865237514, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'sandbox/mode', seq: 9, time: 1786865237600, data: { mode: 'workspace-write' } },
]

describe.skipIf(realCatalog === null)('QC fixtures against the real released catalog', () => {
  it('maps a foreign source-kind-first refusal to `source-kind` (C-5)', async () => {
    const oracle = realCatalog as CatalogHandle
    const root = tempDir('rsl-real-source-first-')
    const session = 'session-44444444-4444-4444-8444-444444444444'
    writeGeneration(root, '--example-namespace--', session, 'session.jsonl.zstd', V0_HEADER, REAL_SOURCE_KIND_FIRST_EVENTS)

    const report = await runRepair(optionsFor({ root, catalogPath: oracle.modulePath }), process.env)

    expect(outcomeFor(report, session)).toMatchObject({ class: 'source-kind', status: 'repairable' })
  })

  it('maps a legacy-first refusal to `unknown-event-type` (C-5)', async () => {
    const oracle = realCatalog as CatalogHandle
    const root = tempDir('rsl-real-legacy-first-')
    const session = 'session-55555555-5555-4555-8555-555555555555'
    writeGeneration(root, '--example-namespace--', session, 'session.jsonl.zstd', V0_HEADER, REAL_LEGACY_FIRST_EVENTS)

    const report = await runRepair(optionsFor({ root, catalogPath: oracle.modulePath }), process.env)

    expect(outcomeFor(report, session)).toMatchObject({ class: 'unknown-event-type', status: 'unrepairable' })
  })

  it('reports `ok-truncated`, not a clean `ok`, when only the lenient policy accepts (C-6)', async () => {
    const oracle = realCatalog as CatalogHandle
    const root = tempDir('rsl-real-ok-truncated-')
    const session = 'session-66666666-6666-4666-8666-666666666666'
    const log = writeGeneration(root, '--example-namespace--', session, 'session.jsonl.zstd', V0_HEADER, REAL_OK_TRUNCATED_EVENTS)

    const report = await runRepair(optionsFor({ root, catalogPath: oracle.modulePath }), process.env)
    const outcome = outcomeFor(report, session)
    expect(outcome).toMatchObject({ class: 'ok', status: 'ok' })
    expect(outcome.strictRefusal).toContain('seq gap')
    expect(report.summary).toMatchObject({ ok: 1, okTruncated: 1 })

    const sink = captureIO()
    const code = await execute(optionsFor({ root, catalogPath: oracle.modulePath, json: true }), sink.io, process.env)
    const document = JSON.parse(sink.out()) as RunResult
    const printed = document.logs[0]

    // The session DOES load (exit 0), but the report may not claim it loads intact.
    expect(code).toBe(0)
    expect(document.summary).toMatchObject({ ok: 1, okTruncated: 1 })
    expect(printed?.strictRefusal).toContain('seq gap')
    expect(printed?.detail).toContain('opens with the rows after that refusal silently dropped')

    const text = captureIO()
    await execute(optionsFor({ root, catalogPath: oracle.modulePath }), text.io, process.env)
    expect(text.out()).toContain('ok-truncated')
    expect(text.out()).toContain('(ok-truncated 1)')
    expect(text.out()).not.toContain('  ok ')
    // Nothing was written for a log that needs no repair.
    expect(listing(log.dir)).toEqual(['session.jsonl.zstd'])
  })
})
