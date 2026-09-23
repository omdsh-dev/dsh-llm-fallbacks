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
 *   1. no durable session-event append in `src/**` (`session.append(…)`) —
 *      the event-type vocabulary is still catalog-frozen, so an unknown
 *      custom event type remains a one-way door;
 *   2. no EMPTY `MessageSource.kind` literal in `src/**` — since 0.1.7-rc.1
 *      the source vocabulary is producer-declared ("each producer declares
 *      its own `kind` in its own module; there is no shared catch-all
 *      `plugin` kind" — dsh-llm message.d.ts) and the only admission rule a
 *      released edge applies to a direct kind is that it is non-empty
 *      (`session-format-v3-to-v4` "producer-owned source kind"); the old
 *      frozen-set half of this guard (no `MessageSourceMap` merge, kinds
 *      checked against the V2→V3 `SOURCE_KINDS` via `isReleasedSourceKind`)
 *      pinned a vocabulary that no longer exists and went away with it.
 *
 * LIMITS — this is a LINT, NOT A PROOF, and it must not be read as one:
 *   - it matches literal SYNTAX. A write path built at runtime
 *     (`session[method](…)`, a `kind` held in a variable or produced by a
 *     computed property, a destructured `append`) is invisible to it;
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

/** Repository `src/` — the whole plugin write surface (host half + `client/`). */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Extensions the walker reads. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx']

type ViolationRule = 'durable-session-append' | 'empty-source-kind'

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
 * The one admission rule a released edge applies to a direct source kind
 * (`session-format-v3-to-v4` "producer-owned source kind"): it must be
 * non-empty. Producer-declared kinds are the sanctioned 0.1.7-rc.1 mechanism
 * — this lint's predecessor enforced the retired frozen vocabulary instead.
 */
function isAdmissibleSourceKind(value: string): boolean {
  return value.length > 0
}

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

/** Check 2: an EMPTY `source.kind` literal (the V4 producer-owned-source-kind refusal). */
function checkEmptySourceKinds(source: string): Violation[] {
  const found: Violation[] = []
  for (const literal of matches(source, SOURCE_LITERAL_PATTERN)) {
    const open = literal.index + literal[0].length - 1
    const kind = KIND_LITERAL_PATTERN.exec(braceBody(source, open))
    if (kind === null || isAdmissibleSourceKind(kind[2])) continue
    found.push({
      rule: 'empty-source-kind',
      line: lineAt(source, open),
      evidence: `${literal[0].trim()} … ${kind[0]} — a source kind must be non-empty`,
    })
  }
  return found
}

/** Every check, over one file's text. */
function checkSource(file: string, source: string): FileViolation[] {
  const violations = [
    ...checkDurableSessionAppends(source),
    ...checkEmptySourceKinds(source),
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
  it('adds no durable session-event append and no empty source.kind', () => {
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

    // 2. the one residual refusal a released edge applies to a source kind:
    //    an EMPTY kind (the V4 "producer-owned source kind" admission).
    expect(checkSource('poison.ts', "const row = { source: { kind: '' } }")).toEqual([
      {
        file: 'poison.ts',
        rule: 'empty-source-kind',
        line: 1,
        evidence: "source: { … kind: '' — a source kind must be non-empty",
      },
    ])

    // Honest shapes stay quiet: the producer-declared kind this plugin writes
    // and declares (sanctioned since 0.1.7-rc.1 — "each producer declares its
    // own `kind` in its own module"), a source literal with no `kind` at all,
    // and a non-source `kind`.
    const honest = [
      "const notice = { source: { kind: 'llm-fallbacks-role-notice', form: 'notice' } }",
      "const user = { source: { kind: 'user' } }",
      'const other = { source: { messageId, seq } }',
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
