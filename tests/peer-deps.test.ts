/**
 * Registry peer contract: the private `@deepseek-ai/*` packages are
 * peerDependencies ONLY (never devDependencies / dependencies), resolved from
 * the npm registry at dev time via `autoInstallPeers` + the `.npmrc` auth
 * token — no local link farm. Data-driven over the ACTUAL package.json, so
 * the peer set can grow without this test silently going stale.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const root = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  keywords?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const deepseekKeys = (field: Record<string, string> | undefined): string[] =>
  Object.keys(field ?? {}).filter((name) => name.startsWith('@deepseek-ai/')).sort()

describe('registry peer contract (rc.7 from npm, no link farm)', () => {
  it('every @deepseek-ai/* entry is a peerDependency and appears in no other dependency field', () => {
    const peers = deepseekKeys(root.peerDependencies)
    expect(peers.length).toBeGreaterThan(0)
    for (const name of peers) {
      expect(root.dependencies?.[name], `${name} in dependencies`).toBeUndefined()
      expect(root.devDependencies?.[name], `${name} in devDependencies`).toBeUndefined()
      expect(root.optionalDependencies?.[name], `${name} in optionalDependencies`).toBeUndefined()
    }
  })

  it('every @deepseek-ai/dsh-* peer is pinned to ^0.1.0-rc.7', () => {
    for (const [name, range] of Object.entries(root.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(range, name).toBe('^0.1.0-rc.7')
      }
    }
  })

  it('autoInstallPeers is enabled (registry resolution, no link farm)', () => {
    const workspace = readFileSync(resolve(repo, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/autoInstallPeers\s*:\s*true/)
  })

  it('prepare is build-only; dsh:link scripts and the link-farm script are gone', () => {
    expect(root.scripts.prepare).toBe('pnpm run build')
    expect(root.scripts['dsh:link']).toBeUndefined()
    expect(root.scripts['dsh:link:check']).toBeUndefined()
    expect(existsSync(resolve(repo, 'scripts', 'setup-dsh-links.mjs'))).toBe(false)
  })

  it('package is tagged dsh / dsh-plugin for npm discovery', () => {
    expect(root.keywords).toContain('dsh')
    expect(root.keywords).toContain('dsh-plugin')
  })
})
