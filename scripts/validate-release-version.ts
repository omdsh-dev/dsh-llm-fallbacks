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
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** @returns true when the tag exists, false when it does not, null when not a git repo. */
function tagExists(version: string): boolean | null {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
  } catch {
    return null
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function main(): void {
  const tag = process.argv[2]
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

  let failed = false

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
  if (pkg.version !== version) {
    console.error(
      `MISMATCH package.json: tag ${tag} => ${version}, package.json has ${pkg.version ?? '<missing>'}`,
    )
    failed = true
  } else {
    console.log(`OK package.json: ${pkg.version}`)
  }

  const tagState = tagExists(version)
  if (tagState === null) {
    console.log('note: not a git repository — skipping tag-exists check')
  } else if (tagState) {
    console.error(`FAIL already released: git tag v${version} already exists`)
    failed = true
  } else {
    console.log(`OK git tag v${version} does not exist`)
  }

  if (failed) {
    console.error(`\nRelease tag ${tag} failed validation.`)
    process.exit(1)
  }
  console.log(`\nAll checks passed for ${tag}.`)
}

main()
