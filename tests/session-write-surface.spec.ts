/**
 * Session write-surface guard — a static LINT over this repo's own `src/**`.
 *
 * WHAT IT PINS. issue #52 was a session-log poisoning incident with two halves:
 * this plugin declared a durable `fallbacks/switch` session event
 * (`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap … }`)
 * AND appended it with `agent.session.append('fallbacks/switch', …)`. The plugin
 * and the host resolved different module instances, so the appends still landed
 * in the persisted log while the event type was never registered — and because
 * the released session-format chain refuses an unknown event type even when the
 * row carries `ignorable: true`, every session that carried one became
 * unopenable. That incident is why the triage/repair tool in
 * `scripts/session-logs/` exists. Format edges are FROZEN, so this is a one-way
 * door; this test is the tripwire that keeps it shut:
 *
 *   1. no durable session-event append in `src/**` (`session.append(…)`);
 *   2. no `MessageSourceMap` augmentation/merge in `src/**` — the persisted
 *      message-source vocabulary is frozen per format edge
 *      (`packages/session/session-format-v2-to-v3/src/payload.ts` `SOURCE_KINDS`
 *      in the `deepseek-harness` checkout), so a merged custom kind poisons
 *      every log that carries it;
 *   3. no `MessageSource.kind` literal in `src/**` outside that released
 *      vocabulary, checked through `isReleasedSourceKind` from
 *      `scripts/session-logs/rules.ts` so "released" has ONE definition shared
 *      with the repair tool (that set is itself pinned by exact equality in
 *      `tests/session-log-rules.spec.ts`).
 *
 * LIMITS — this is a LINT, NOT A PROOF, and it must not be read as one:
 *   - it matches literal SYNTAX. A write path built at runtime
 *     (`session[method](…)`, a `kind` held in a variable or produced by a
 *     computed property, a destructured `append`) is invisible to it;
 *   - `MessageSourceMap` is searched for in a DECLARATION position
 *     (`interface MessageSourceMap` — the only merge form TypeScript offers for
 *     it, bare or inside a `declare module`). A bare type READ
 *     (`MessageSourceMap['plugin']`) is allowed on purpose;
 *   - the `source: { … }` scan is brace-counted, not parsed: braces inside
 *     string literals or comments are not understood, so a pathological literal
 *     could hide (or falsely expose) a `kind`;
 *   - it covers `src/**` of THIS repository only. It says nothing about a
 *     third-party plugin, about dsh itself, or about what is already persisted
 *     on disk — the byte-level proof lives in the repair tool and its tests.
 * Its value is that a REINTRODUCED write path has to look like the original
 * incident to pass. The self-test below proves the checker fires on exactly
 * those shapes instead of passing vacuously.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isReleasedSourceKind } from '../scripts/session-logs/rules.ts'

/** Repository `src/` — the whole plugin write surface (host half + `client/`). */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Extensions the walker reads. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx']

type ViolationRule = 'durable-session-append' | 'message-source-map-merge' | 'unreleased-source-kind'

/** One finding, before the file that produced it is attached. */
interface Violation {
  rule: ViolationRule
  line: number
  evidence: string
}

/** One finding plus the file it came from. */
interface FileViolation extends Violation {
  file: string
}

/** The durable-append shapes: `session.append(…)`, `session?.append(…)`, `session['append'](…)`. */
const DURABLE_APPEND_PATTERNS: readonly RegExp[] = [
  /\bsession\s*\??\.\s*append\s*\(/g,
  /\bsession\s*\[\s*(['"])append\1\s*\]\s*\(/g,
]

/** A message-source object literal (`source: {`), whatever follows it. */
const SOURCE_LITERAL_PATTERN = /\bsource\s*:\s*\{/g

/** A `kind` member of such a literal (single or double quoted). */
const KIND_LITERAL_PATTERN = /\bkind\s*:\s*(['"])([^'"]*)\1/

/**
 * The only merge form TypeScript offers for the released map: an
 * `interface MessageSourceMap` declaration (bare, inside `declare module`, or
 * `extends`-ing) — the exact syntax that lets a plugin add a custom kind.
 */
const MESSAGE_SOURCE_MAP_MERGE_PATTERN = /\binterface\s+MessageSourceMap\b/g

/** Every match of `pattern`, as a fresh clone so `lastIndex` is never shared. */
function matches(source: string, pattern: RegExp): RegExpExecArray[] {
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const found: RegExpExecArray[] = []
  let match = scanner.exec(source)
  while (match !== null) {
    found.push(match)
    match = scanner.exec(source)
  }
  return found
}

/** 1-based line number of a character offset. */
function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/**
 * The `{…}` body that starts at `open` (brace-counted, not parsed — see the
 * LIMITS note in the module docblock), or the rest of the source when the
 * literal is unbalanced.
 */
function braceBody(source: string, open: number): string {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return source.slice(open)
}

/** Check 1: a durable session-event append (the committing half of issue #52). */
function checkDurableSessionAppends(source: string): Violation[] {
  return DURABLE_APPEND_PATTERNS.flatMap((pattern) =>
    matches(source, pattern).map((match) => ({
      rule: 'durable-session-append' as const,
      line: lineAt(source, match.index),
      evidence: match[0].trim(),
    })),
  )
}

/** Check 2: a `MessageSourceMap` augmentation/merge (the vocabulary half). */
function checkMessageSourceMapMerges(source: string): Violation[] {
  return matches(source, MESSAGE_SOURCE_MAP_MERGE_PATTERN).map((match) => ({
    rule: 'message-source-map-merge' as const,
    line: lineAt(source, match.index),
    evidence: match[0],
  }))
}

/** Check 3: a `source.kind` literal outside the released vocabulary. */
function checkReleasedSourceKinds(source: string): Violation[] {
  const found: Violation[] = []
  for (const literal of matches(source, SOURCE_LITERAL_PATTERN)) {
    const open = literal.index + literal[0].length - 1
    const kind = KIND_LITERAL_PATTERN.exec(braceBody(source, open))
    if (kind === null || isReleasedSourceKind(kind[2])) continue
    found.push({
      rule: 'unreleased-source-kind',
      line: lineAt(source, open),
      evidence: `${literal[0].trim()} … ${kind[0]} — outside the released vocabulary`,
    })
  }
  return found
}

/** Every check, over one file's text. */
function checkSource(file: string, source: string): FileViolation[] {
  const violations = [
    ...checkDurableSessionAppends(source),
    ...checkMessageSourceMapMerges(source),
    ...checkReleasedSourceKinds(source),
  ]
  return violations.map((violation) => ({ file, ...violation }))
}

/** Every `src/**` source file, depth-first and stable. */
function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found.sort()
}

/** The real scan: the walker and the three checks over this repo's `src/**`. */
function scanSourceTree(directory: string): { files: string[]; violations: FileViolation[] } {
  const files = sourceFiles(directory)
  return {
    files,
    violations: files.flatMap((file) => checkSource(file, readFileSync(file, 'utf8'))),
  }
}

/** Render a finding for an assertion message (path relative to the repo root). */
function describeViolation(repoRoot: string, violation: FileViolation): string {
  const file = violation.file.startsWith(repoRoot) ? violation.file.slice(repoRoot.length + 1) : violation.file
  return `${file}:${violation.line} [${violation.rule}] ${violation.evidence}`
}

const REPO_ROOT = join(SRC_DIR, '..')

describe('session write surface (lint over src/**)', () => {
  it('adds no durable session-event append, no MessageSourceMap merge and no unreleased source.kind', () => {
    const { files, violations } = scanSourceTree(SRC_DIR)
    // A vacuous pass would be worse than a false alarm: prove the walker read the
    // real source tree before trusting an empty finding list.
    expect(files.length).toBeGreaterThan(20)
    expect(violations.map((violation) => describeViolation(REPO_ROOT, violation))).toEqual([])
  })

  it('self-test: the checker fires on each poisoning shape and stays quiet on honest ones', () => {
    // 1. the incident's committing half — a durable append.
    expect(checkSource('poison.ts', "agent.session.append('fallbacks/switch', { from, to })")).toEqual([
      {
        file: 'poison.ts',
        rule: 'durable-session-append',
        line: 1,
        evidence: 'session.append(',
      },
    ])
    expect(checkSource('poison.ts', "session['append']('fallbacks/switch', {})")).toEqual([
      { file: 'poison.ts', rule: 'durable-session-append', line: 1, evidence: "session['append'](" },
    ])

    // 2. the incident's declaring half — a custom message-source kind map.
    const merge = [
      "declare module '@deepseek-ai/dsh-llm' {",
      '  interface MessageSourceMap {',
      "    'mstar-role': { role: string }",
      '  }',
      '}',
    ].join('\n')
    expect(checkSource('poison.ts', merge)).toEqual([
      {
        file: 'poison.ts',
        rule: 'message-source-map-merge',
        line: 2,
        evidence: 'interface MessageSourceMap',
      },
    ])
    expect(checkSource('poison.ts', "interface MessageSourceMap { 'x': unknown }")).toEqual([
      { file: 'poison.ts', rule: 'message-source-map-merge', line: 1, evidence: 'interface MessageSourceMap' },
    ])

    // 3. a foreign kind at a message-source position.
    const foreign = ['const message = {', "  source: { kind: 'mstar-role' },", '}'].join('\n')
    expect(checkSource('poison.ts', foreign)).toEqual([
      {
        file: 'poison.ts',
        rule: 'unreleased-source-kind',
        line: 2,
        evidence: 'source: { … kind: \'mstar-role\' — outside the released vocabulary',
      },
    ])

    // Honest shapes stay quiet: the released `plugin` arm, the released `user`
    // kind this plugin actually writes, a source literal with no `kind` at all,
    // a bare type READ of the map, and a non-source `kind`.
    const honest = [
      "const notice = { source: { kind: 'plugin', plugin: 'dsh-advisor', form: 'notice' } }",
      "const user = { source: { kind: 'user' } }",
      'const other = { source: { messageId, seq } }',
      "type Local = MessageSourceMap['plugin']",
      "const result = { kind: 'success' }",
    ].join('\n')
    expect(checkSource('honest.ts', honest)).toEqual([])
  })

  it('self-test: the walker reaches the real source tree', () => {
    const files = sourceFiles(SRC_DIR)
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((file) => file.endsWith(join('src', 'events.ts')))).toBe(true)
    expect(files.some((file) => file.endsWith(join('client', 'locales.ts')))).toBe(true)
  })
})
