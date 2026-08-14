/**
 * prepare-release.ts — resolve the next version, assemble changelog fragments,
 * insert the changelog section, bump package.json, archive fragments.
 *
 * Usage (from the repo root, via tsx — the package.json `release:prepare`
 * script):
 *   pnpm release:prepare -- <version>    # explicit version, used as-is
 *   pnpm release:prepare -- --patch      # auto patch bump
 *
 * Version resolution:
 *   - Explicit version must match /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ and
 *     is used as-is (prerelease suffixes allowed, e.g. 0.1.0-alpha.2).
 *   - `--patch` auto bump:
 *       * current has a numeric prerelease tail (`X.Y.Z-pre.N`) -> bump only N
 *         (0.1.0-alpha.1 -> 0.1.0-alpha.2; never jumps to a stable release);
 *       * no prerelease -> patch + 1 (0.1.0 -> 0.1.1);
 *       * prerelease with a non-numeric tail -> exit 1, use an explicit
 *         version instead.
 *
 * What it does:
 *   1. Reads `.changes/unreleased/*.md` fragments (README.md / .gitkeep are
 *      skipped). Optional frontmatter `category:` groups bullets under a
 *      `### <category>` heading (default: `Changed`); the body is one or more
 *      English bullet lines, rendered verbatim.
 *   2. Inserts a `## [<version>] - <date>` section into CHANGELOG.md directly
 *      under `## [Unreleased]`.
 *   3. Bumps the `version` field in package.json.
 *   4. Moves consumed fragments to `.changes/archive/<version>/`.
 *
 * All paths are resolved relative to the current working directory, so the
 * script works both from the repo root (`pnpm release:prepare`) and from a
 * throwaway fixture directory (used by the release tooling verification).
 *
 * This script only edits the working tree. Commit + PR is the caller's job
 * (the `release-prep` workflow commits and opens the `release vX.Y.Z` PR).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Architect-approved loose semver: numeric core, optional prerelease suffix. */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const CHANGES_DIR = '.changes'
const UNRELEASED_DIR = join(CHANGES_DIR, 'unreleased')
const ARCHIVE_DIR = join(CHANGES_DIR, 'archive')

const DEFAULT_CATEGORY = 'Changed'

type Fragment = {
  file: string
  category?: string
  bullets: string[]
}

export function parseArgs(argv: string[]): { version?: string; autoBump: boolean } {
  const rest = argv.slice(2).filter((a) => a !== '--')
  let version: string | undefined
  let autoBump = false
  for (const arg of rest) {
    if (VERSION_RE.test(arg)) version = arg
    else if (arg === '--patch') autoBump = true
    else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg} (expected <version> or --patch)`)
    else
      throw new Error(
        `Invalid version "${arg}". Expected X.Y.Z or X.Y.Z-pre.N (e.g. 0.1.0-alpha.2)`,
      )
  }
  if (version !== undefined && autoBump) {
    throw new Error('Pass either an explicit <version> or --patch, not both')
  }
  return { version, autoBump }
}

/**
 * Auto patch bump. Deliberately NOT the naive split+parseInt mstar approach
 * (which turns `0.1.0-alpha.1 --patch` into stable `0.1.1`): a prerelease
 * version stays in its prerelease line, bumping only the numeric tail.
 */
export function autoBumpPatch(current: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(current)
  if (!m) throw new Error(`Cannot auto-bump "${current}": not a parseable X.Y.Z[-pre] version`)
  const [, major, minor, patch, pre] = m
  if (pre === undefined) return `${major}.${minor}.${Number(patch) + 1}`
  const tail = pre.split('.').at(-1)
  if (tail === undefined || !/^\d+$/.test(tail)) {
    throw new Error(
      `Cannot auto-bump "${current}": prerelease tail "${pre}" is not numeric. ` +
        'Pass an explicit version instead (e.g. `pnpm release:prepare -- <version>`).',
    )
  }
  const prefix = pre.slice(0, pre.length - tail.length) // "alpha." for "alpha.1"
  return `${major}.${minor}.${patch}-${prefix}${Number(tail) + 1}`
}

export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {}
  if (!text.startsWith('---')) return { fm, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { fm, body: text }
  const fmText = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n/, '')
  for (const line of fmText.split('\n')) {
    const m = line.match(/^([A-Za-z0-9 _-]+):\s*(.*)$/)
    if (m) fm[m[1].trim()] = m[2].trim()
  }
  return { fm, body }
}

export function parseFragment(file: string, text: string): Fragment {
  const { fm, body } = parseFrontmatter(text)
  const bullets = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  return {
    file,
    category: fm.category?.trim() || undefined,
    bullets,
  }
}

export function readFragments(): Fragment[] {
  if (!existsSync(UNRELEASED_DIR)) return []
  return readdirSync(UNRELEASED_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => parseFragment(f, readFileSync(join(UNRELEASED_DIR, f), 'utf8')))
}

/** Bullets between the version header and the next section, grouped by category. */
export function buildSectionBody(frags: Fragment[]): string {
  const groups: { category: string; bullets: string[] }[] = []
  for (const frag of frags) {
    const category = frag.category ?? DEFAULT_CATEGORY
    let group = groups.find((g) => g.category === category)
    if (!group) {
      group = { category, bullets: [] }
      groups.push(group)
    }
    group.bullets.push(...frag.bullets)
  }
  const lines: string[] = []
  for (const group of groups) {
    lines.push(`### ${group.category}`, '', ...group.bullets, '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Insert `## [<version>] - <date>` directly under the `## [Unreleased]` header. */
export function insertSection(changelog: string, version: string, date: string, body: string): string {
  const unreleased = changelog.indexOf('## [Unreleased]')
  if (unreleased === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" header')
  const afterLine = changelog.indexOf('\n', unreleased) + 1
  const tail = changelog.slice(afterLine).replace(/^\n+/, '')
  const section = [`## [${version}] - ${date}`]
  if (body.trim()) section.push('', body)
  return `${changelog.slice(0, afterLine)}\n${section.join('\n')}\n\n${tail}`
}

export function bumpPackageJson(oldVersion: string, newVersion: string): void {
  const path = 'package.json'
  const text = readFileSync(path, 'utf8')
  const re = new RegExp(`("version"\\s*:\\s*")${oldVersion.replace(/\./g, '\\.')}(")`)
  if (!re.test(text)) throw new Error(`${path}: could not find version field "${oldVersion}"`)
  writeFileSync(path, text.replace(re, `$1${newVersion}$2`))
}

export function archiveFragments(version: string, frags: Fragment[]): void {
  if (!frags.length) return
  const dest = join(ARCHIVE_DIR, version)
  mkdirSync(dest, { recursive: true })
  for (const frag of frags) {
    renameSync(join(UNRELEASED_DIR, frag.file), join(dest, frag.file))
  }
}

export function main(): void {
  const { version: explicit, autoBump } = parseArgs(process.argv)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
  const current = pkg.version
  if (!current) throw new Error('package.json has no version')

  const version = explicit ?? autoBumpPatch(current)
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z or X.Y.Z-pre.N (e.g. 0.1.0-alpha.2)`)
  }
  const date = new Date().toISOString().slice(0, 10)

  console.log(`Preparing release ${current} -> ${version}\n`)

  const frags = readFragments()
  console.log(`Fragments: ${frags.length}`)
  for (const frag of frags) {
    console.log(`  - ${frag.file}${frag.category ? `  [category: ${frag.category}]` : ''}`)
  }
  if (!frags.length) console.log('  (no fragments — section will be empty)')

  const body = buildSectionBody(frags)
  const changelogPath = 'CHANGELOG.md'
  const changelog = readFileSync(changelogPath, 'utf8')
  writeFileSync(changelogPath, insertSection(changelog, version, date, body))
  console.log(`changelog: ${changelogPath} (## [${version}] - ${date})`)

  bumpPackageJson(current, version)
  console.log('bump: package.json')

  archiveFragments(version, frags)
  console.log(`archive: ${frags.length} fragment(s) -> ${join(ARCHIVE_DIR, version)}`)

  console.log(`\nDone. Next: commit and open PR "release v${version}".`)
  console.log(`Validate with: pnpm release:validate -- v${version}`)
}

// Run only when executed directly (tsx scripts/prepare-release.ts) —
// importing the module (verification fixtures) must not start the release flow.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  try {
    main()
  } catch (err) {
    console.error(`\nprepare-release failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
