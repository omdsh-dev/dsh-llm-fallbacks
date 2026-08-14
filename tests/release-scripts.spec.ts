/**
 * Committed regression suite for the release scripts (W-3 / F-005 fix wave).
 *
 * Covers the riskiest release logic that previously only had ephemeral
 * one-off fixture evidence:
 *   - autoBumpPatch: the anti-mstar prerelease bump contract (alpha.N stays
 *     in the prerelease line; never silently jumps to a stable release);
 *   - insertSection placement under `## [Unreleased]`;
 *   - parseArgs: explicit version vs `--patch` vs bare (bare must NOT
 *     auto-bump — main() exits 1 with a usage hint);
 *   - validateReleaseVersion / tagExists: consistent, mismatch, and
 *     already-released-tag cases (tag probe against a real temp git repo).
 *
 * The scripts export their logic (import via relative path); the entry-point
 * guards (`import.meta.url === entry`) keep module import side-effect free.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoBumpPatch, insertSection, parseArgs } from '../scripts/prepare-release.ts'
import { tagExists, validateReleaseVersion } from '../scripts/validate-release-version.ts'

describe('autoBumpPatch (prerelease stays in its prerelease line)', () => {
  it('numeric prerelease tail: bump N only, keep the prerelease prefix', () => {
    expect(autoBumpPatch('0.1.0-alpha.1')).toBe('0.1.0-alpha.2')
    expect(autoBumpPatch('1.2.3-rc.9')).toBe('1.2.3-rc.10')
    expect(autoBumpPatch('2.0.0-beta.0')).toBe('2.0.0-beta.1')
    // multi-dot tail (pre.n.n) keeps every dot component except the last
    expect(autoBumpPatch('0.1.0-alpha.1.7')).toBe('0.1.0-alpha.1.8')
  })

  it('no prerelease: patch + 1 (stable line)', () => {
    expect(autoBumpPatch('0.1.0')).toBe('0.1.1')
    expect(autoBumpPatch('1.2.3')).toBe('1.2.4')
  })

  it('non-numeric prerelease tail throws instead of guessing', () => {
    expect(() => autoBumpPatch('0.1.0-alpha')).toThrow(/not numeric/)
    expect(() => autoBumpPatch('0.1.0-alpha.beta')).toThrow(/not numeric/)
    // the mstar bug: a naive parseInt split would silently turn this into
    // 0.1.1 (a stable release) — the whole point of this function is to
    // refuse instead.
    expect(() => autoBumpPatch('0.1.0-alpha.1.7')).not.toThrow()
  })

  it('unparseable version throws', () => {
    expect(() => autoBumpPatch('banana')).toThrow(/not a parseable/)
    expect(() => autoBumpPatch('')).toThrow(/not a parseable/)
  })
})

describe('insertSection (placement under ## [Unreleased])', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0-alpha.1] - 2026-08-13\n'

  it('inserts the new section directly under the Unreleased header, above the previous section', () => {
    const out = insertSection(changelog, '0.1.0-alpha.2', '2026-08-14', '### Added\n\n- Foo')
    expect(out).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0-alpha.2] - 2026-08-14\n\n### Added\n\n- Foo\n\n## [0.1.0-alpha.1] - 2026-08-13\n',
    )
  })

  it('omits the body when it is empty (header-only section)', () => {
    const out = insertSection('## [Unreleased]\n', '1.0.0', '2026-08-14', '')
    expect(out).toBe('## [Unreleased]\n\n## [1.0.0] - 2026-08-14\n\n')
  })

  it('throws when CHANGELOG has no Unreleased header', () => {
    expect(() => insertSection('# Changelog\n\n## [0.1.0] - 2026-01-01\n', '1.0.0', '2026-08-14', 'x')).toThrow(
      /Unreleased/,
    )
  })
})

describe('parseArgs (explicit vs --patch vs bare)', () => {
  it('accepts an explicit version', () => {
    expect(parseArgs(['node', 'prepare-release', '--', '0.1.0-alpha.2'])).toEqual({
      version: '0.1.0-alpha.2',
      autoBump: false,
    })
  })

  it('accepts --patch as the auto-bump switch', () => {
    expect(parseArgs(['node', 'prepare-release', '--', '--patch'])).toEqual({ version: undefined, autoBump: true })
  })

  it('bare invocation selects neither — main() must exit 1 with a usage hint', () => {
    expect(parseArgs(['node', 'prepare-release'])).toEqual({ version: undefined, autoBump: false })
  })

  it('rejects version + --patch together', () => {
    expect(() => parseArgs(['node', 'prepare-release', '--', '0.1.0', '--patch'])).toThrow(/not both/)
  })

  it('rejects invalid versions and unknown flags', () => {
    expect(() => parseArgs(['node', 'prepare-release', '--', 'banana'])).toThrow(/Invalid version/)
    expect(() => parseArgs(['node', 'prepare-release', '--', '--bogus'])).toThrow(/Unknown argument/)
  })
})

describe('validateReleaseVersion (pure gate)', () => {
  it('passes when package.json matches and the tag does not exist', () => {
    const r = validateReleaseVersion('0.1.0-alpha.2', '0.1.0-alpha.2', false)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('fails on package.json mismatch', () => {
    const r = validateReleaseVersion('0.1.0-alpha.2', '0.1.0-alpha.1', false)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/MISMATCH package.json/)
  })

  it('fails when the git tag already exists', () => {
    const r = validateReleaseVersion('0.1.0-alpha.2', '0.1.0-alpha.2', true)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/already released/)
  })

  it('skips the tag check outside a git repo (tagState null) with a note', () => {
    const r = validateReleaseVersion('0.1.0-alpha.2', '0.1.0-alpha.2', null)
    expect(r.ok).toBe(true)
    expect(r.notes.join('\n')).toMatch(/not a git repository/)
  })
})

describe('tagExists (real git probe in a temp repo)', () => {
  it('detects an existing tag, its absence, and a non-git directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'release-validate-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, stdio: 'ignore' })
      // a tag needs a commit to point at in a fresh repo
      writeFileSync(join(repo, 'placeholder.txt'), 'x')
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

      expect(tagExists('9.9.9', repo)).toBe(false)
      // git >= 2.55 requires a message even for tags
      execFileSync('git', ['tag', '-a', '-m', 'test', 'v9.9.9'], { cwd: repo, stdio: 'ignore' })
      expect(tagExists('9.9.9', repo)).toBe(true)
      // a different version's tag is still absent
      expect(tagExists('9.9.10', repo)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }

    const outside = mkdtempSync(join(tmpdir(), 'release-validate-nogit-'))
    try {
      expect(tagExists('9.9.9', outside)).toBe(null)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
