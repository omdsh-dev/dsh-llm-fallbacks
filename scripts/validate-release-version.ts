/**
 * validate-release-version.ts — gate: the package version matches the release
 * tag and the tag is not already released.
 *
 * Usage (from the repo root, via tsx — the package.json `release:validate`
 * script):
 *   pnpm release:validate -- v<version>    # e.g. v0.1.0-alpha.2
 *
 * Checks (single-package repo — one version surface):
 *   1. Tag format: `v` prefix + /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.
 *   2. package.json `version` equals the tag version (v prefix stripped).
 *   3. Git tag `v<version>` does not exist yet (`git rev-parse` probe; exit 1
 *      with "already released" when it does). Outside a git repository the
 *      tag check is skipped with a note (fixture verification scenario).
 *
 * All paths are resolved relative to the current working directory, so the
 * script works both from the repo root (`pnpm release:validate`) and from a
 * throwaway fixture directory.
 *
 * The pure validation logic is exported (`validateReleaseVersion`,
 * `tagExists`) so the committed vitest suite can cover the positive and
 * negative cases; `main()` only runs when the file is executed directly.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { VERSION_RE } from './release-version.ts'

/**
 * @returns true when the tag exists, false when it does not, null when the
 * directory is not inside a git work tree.
 */
export function tagExists(version: string, cwd = process.cwd()): boolean | null {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore', cwd })
  } catch {
    return null
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], { stdio: 'ignore', cwd })
    return true
  } catch {
    return false
  }
}

export type ValidationResult = {
  ok: boolean
  errors: string[]
  notes: string[]
}

/**
 * Pure gate used by `main()` and by the test suite: the version matches
 * package.json and the git tag is free. `tagState` is the result of
 * `tagExists` (true / false / null when not a git repo).
 */
export function validateReleaseVersion(
  version: string,
  pkgVersion: string | undefined,
  tagState: boolean | null,
): ValidationResult {
  const errors: string[] = []
  const notes: string[] = []

  if (pkgVersion !== version) {
    errors.push(`MISMATCH package.json: tag v${version} => ${version}, package.json has ${pkgVersion ?? '<missing>'}`)
  } else {
    notes.push(`OK package.json: ${pkgVersion}`)
  }

  if (tagState === null) {
    notes.push('note: not a git repository — skipping tag-exists check')
  } else if (tagState) {
    errors.push(`FAIL already released: git tag v${version} already exists`)
  } else {
    notes.push(`OK git tag v${version} does not exist`)
  }

  return { ok: errors.length === 0, errors, notes }
}

function main(): void {
  // Strip a leading `--` (pnpm forwards `pnpm release:validate -- vX.Y.Z`
  // as argv [`tsx`, `scripts/validate-release-version.ts`, `--`, `vX.Y.Z`])
  // so direct `tsx scripts/validate-release-version.ts -- vX.Y.Z` matches the
  // prepare-release argument handling.
  const tag = process.argv.slice(2).find((a) => a !== '--')
  if (!tag) {
    console.error('Usage: tsx scripts/validate-release-version.ts v<version>')
    console.error('Example: pnpm release:validate -- v0.1.0-alpha.2')
    process.exit(1)
  }

  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (!VERSION_RE.test(version)) {
    console.error(`Invalid release tag "${tag}". Expected vX.Y.Z or vX.Y.Z-pre.N (e.g. v0.1.0-alpha.2).`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
  const result = validateReleaseVersion(version, pkg.version, tagExists(version))

  for (const note of result.notes) console.log(note)
  for (const error of result.errors) console.error(error)
  if (!result.ok) {
    console.error(`\nRelease tag ${tag} failed validation.`)
    process.exit(1)
  }
  console.log(`\nAll checks passed for ${tag}.`)
}

// Run only when executed directly (tsx scripts/validate-release-version.ts) —
// importing the module (the committed test suite) must not run the gate.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  main()
}
