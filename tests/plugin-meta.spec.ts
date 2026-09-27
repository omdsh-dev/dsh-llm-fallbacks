/**
 * Plugin meta + icon smoke (plan fallbacks-web-ux-alignment T1): the package
 * root now declares `locale/{en,zh}.json` (localized bundle detail title /
 * description) and an `icon.svg`, wired through package.json (`icon`,
 * `exports["./locale/*.json"]`, `files`). The host's `readPluginMeta` chain
 * (dsh app-boot `package-meta.ts`) reads them through the Node ESM resolver +
 * the manifest, so this spec pins the same three facts against the real
 * layout — no host code involved:
 *
 * 1. `./locale/*.json` is covered by the `exports` map — proven via Node
 *    self-reference resolution (`require.resolve('dsh-llm-fallbacks/locale/
 *    en.json')` from inside the package resolves ONLY when `exports` carries
 *    the subpath; self-reference requires an `exports` field).
 * 2. The `icon` manifest entry points at a real file inside the package
 *    directory, ≤ 256 KiB (the host's icon guard), SVG by extension.
 * 3. The locale files carry the `{ meta: { title, description } }` shape the
 *    host parses (non-empty strings), and both paths are inside the `files`
 *    publish whitelist.
 */

import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  icon?: string
  exports?: Record<string, unknown>
  files?: string[]
}

const requireSelf = createRequire(join(REPO_ROOT, 'package.json'))

/** The host's icon cap: SVG/PNG/JPEG/WebP, ≤ 256 KiB, realpath-confined. */
const ICON_MAX_BYTES = 256 * 1024

describe('plugin meta + icon (readPluginMeta contract)', () => {
  it('resolves ./locale/en.json and ./locale/zh.json through the exports map (self-reference)', () => {
    // Self-reference resolution consults `exports` — a missing
    // `./locale/*.json` entry throws ERR_PACKAGE_PATH_NOT_EXPORTED here,
    // which is exactly the host-side resolution failure this pin guards.
    for (const locale of ['en', 'zh']) {
      const resolved = requireSelf.resolve(`dsh-llm-fallbacks/locale/${locale}.json`)
      expect(resolved).toBe(join(REPO_ROOT, 'locale', `${locale}.json`))
    }
  })

  it('carries the { meta: { title, description } } shape with non-empty strings', () => {
    for (const locale of ['en', 'zh']) {
      const data = JSON.parse(readFileSync(join(REPO_ROOT, 'locale', `${locale}.json`), 'utf8')) as {
        meta?: { title?: unknown; description?: unknown }
      }
      expect(typeof data.meta?.title).toBe('string')
      expect((data.meta?.title ?? '').length).toBeGreaterThan(0)
      expect(typeof data.meta?.description).toBe('string')
      expect((data.meta?.description ?? '').length).toBeGreaterThan(0)
    }
  })

  it('declares an icon under 256 KiB inside the manifest directory', () => {
    expect(typeof manifest.icon).toBe('string')
    const iconPath = join(REPO_ROOT, manifest.icon ?? '')
    const real = statSync(iconPath, { throwIfNoEntry: false })
    expect(real?.isFile()).toBe(true)
    // realpath confinement (the host resolves + stats the real path and
    // rejects anything escaping the manifest directory): the icon lives at
    // the package root, so the containment check is the root prefix.
    expect(resolve(iconPath).startsWith(REPO_ROOT + '/')).toBe(true)
    expect(real!.size).toBeLessThanOrEqual(ICON_MAX_BYTES)
    expect(iconPath.endsWith('.svg')).toBe(true)
  })

  it('whitelists locale/ and icon.svg in the publish files list', () => {
    expect(manifest.files).toContain('locale')
    expect(manifest.files).toContain('icon.svg')
    expect(manifest.exports && Object.hasOwn(manifest.exports, './locale/*.json')).toBe(true)
    expect(manifest.icon).toBe('./icon.svg')
  })
})
