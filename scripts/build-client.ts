/**
 * Client bundle build: emits the closure-factory CJS artifact the dsh web
 * loader consumes — `window.__ModuleLoader__.load({ id: 'dsh-llm-fallbacks',
 * factory: (require) => { … return module.exports; } })`. Externals resolve
 * through the loader module table (platform seed entries + the documented
 * `@deepseek-ai/dsh-client-runtime/client` exemption); everything else
 * inlines.
 *
 * Build tool: `tsdown` (rolldown) — the same tool the dsh host itself uses
 * for its client bundles (packages/client/tsdown.client.ts pattern), run via
 * `tsx`. Replaces the previous `bun build` recipe; no bun anywhere in the
 * pnpm stack. `dist/client/index.js` is a build artifact (gitignored like the
 * rest of `dist/`); the matching `dist/client/index.d.ts` is emitted by `tsc`
 * (`emitDeclarationOnly`) from `src/client/index.ts`.
 *
 * One build plugin enforces the bundle contract (mirroring the dsh tsdown
 * client recipe):
 * - CSS Modules (`*.module.css`) are compiled to a hashed class map plus an
 *   inline `<style data-plugin>` injection that runs when the factory
 *   materializes (the loader removes plugin-owned tags on unload). The
 *   transform itself (FNV-1a `8hex_local` hash, comment-stripped css) is
 *   unchanged from the bun recipe — only the plugin API moved from bun's
 *   `onLoad` to rolldown's `resolveId`/`load` over a virtual id (the virtual
 *   id must not end in `.css` so tsdown's own css pipeline never sees it).
 *
 * The `@deepseek-ai/*` purity gate stays deferred: the client half's only
 * runtime `@deepseek-ai/*` import is `@deepseek-ai/dsh-client-runtime/client`
 * (a documented CLIENT_EXTERNALS platform module) — every other
 * `@deepseek-ai/*` import is type-only and erased before resolution.
 */

import { build } from 'tsdown'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const ID = 'dsh-llm-fallbacks'
const ENTRY = 'src/client/index.ts'
const OUT_DIR = 'dist/client'
const OUT_FILE = 'index.js'

/** Loader module table (dsh mechanism-guide): platform seed entries plus the documented runtime/client exemption. */
export const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Deterministic CSS-module class hash: FNV-1a 32-bit over the local name →
 * `8hex_local` (mirrors the dsh recipe's `[hash]_[local]` pattern; the hash
 * only needs to be stable within the bundle — the class map and the rewritten
 * css text come from the same transform).
 */
function hashClass(local: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < local.length; i++) {
    h ^= local.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}_${local}`
}

/**
 * Inline `<style data-plugin>` injection source for a css text blob: the tag
 * is created once per factory materialization (the loader removes plugin-owned
 * tags on unload).
 */
function styleInjectionContents(cssText: string, tagId: string): string {
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/**
 * Compile one `*.module.css` file into a JS module: the css text (comments
 * stripped, class tokens hashed) plus a `<style data-plugin>` injection that
 * runs at factory materialization, and the hashed class map as the default
 * export (mirror of the dsh CSS plugin).
 *
 * simplify: the css text is emitted as-is (comment-stripped, not minified);
 * the dsh recipe runs lightningcss. If bundle size ever matters, switch the
 * transform to lightningcss or add a minifier here.
 */
function cssModuleContents(fileId: string): string {
  const source = readFileSync(fileId, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const classMap: Record<string, string> = {}
  const css = source.replace(/\.[A-Za-z_][A-Za-z0-9_-]*/g, (match) => {
    const local = match.slice(1)
    const hashed = hashClass(local)
    classMap[local] = hashed
    return `.${hashed}`
  })
  const tagId = `${ID}/${basename(fileId)}`
  return [
    styleInjectionContents(css, tagId),
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

// Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
// (mirror of the dsh tsdown.client.ts pattern): the suffix matters — tsdown's
// guard matches ids ending in `.css`, so the virtual id must not.
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

await build({
  // `config: false` — run this config standalone, never merge the root
  // tsdown.config.ts (which owns the host bundle + `clean: true`).
  config: false,
  name: `${ID}/client`,
  entry: { index: ENTRY },
  outDir: OUT_DIR,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: {
    // The loader module table is the rule: table entries stay external
    // (tsdown also auto-externalizes peerDependencies), everything else must
    // inline — the browser loader cannot answer a require() it does not
    // know. `onlyBundle: false` marks the inlining intentional.
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    onlyBundle: false,
  },
  // react/zustand-style deps read process.env.NODE_ENV; honor the build env
  // like the dsh recipe (artifacts default to production). No `import.meta`
  // define needed: nothing inlined reads it (the store engine is external),
  // and a literal `import.meta` would be a SyntaxError under the classic
  // <script> loader anyway.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: OUT_FILE,
    // Closure-factory handoff (mirror of the dsh tsdown recipe): `intro`
    // lands inside the factory body (after `banner`) and declares
    // `module`/`exports` because the bundler's cjs emission assigns
    // module.exports itself; the factory returns that surface to the loader.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
  plugins: [
    {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolve(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      load(id: string) {
        if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        return cssModuleContents(fileId)
      },
    },
  ],
})

const outFile = join(OUT_DIR, OUT_FILE)
if (!existsSync(outFile)) {
  throw new Error(`client bundle build: expected ${outFile} — check the tsdown config (entry/entryFileNames/outDir)`)
}

// Inline bundle-contract assertions: the emitted text must carry the inlined
// css-module class map (the transform ran), must NOT contain `import.meta` /
// ESM statements (the classic-script loader would fail to parse them), and
// the only `@deepseek-ai/*` value import must be the documented external
// runtime/client exemption.
const bundleText = readFileSync(outFile, 'utf8')
if (!bundleText.includes('data-plugin-css')) {
  throw new Error('client bundle contract: no inlined css-module style injection found — check the dsh-css-modules-inline plugin')
}
if (bundleText.includes('import.meta') || /(^|\n)\s*(import|export)\s/.test(bundleText)) {
  throw new Error('client bundle contract: emitted bundle contains import.meta / ESM statements — the classic-script loader would fail to parse it')
}
const deepseekRequires = [...bundleText.matchAll(/require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/g)].map(match => match[1])
const unexpected = deepseekRequires.filter(specifier => !CLIENT_EXTERNALS.includes(specifier))
if (unexpected.length > 0) {
  throw new Error(`client bundle contract: non-external @deepseek-ai/* value import(s) survived: ${unexpected.join(', ')}`)
}

console.log(`build-client: ${ENTRY} -> ${outFile} (closure-factory CJS, tsdown)`)
