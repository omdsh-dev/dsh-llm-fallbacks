/**
 * Client bundle build: emits the closure-factory CJS artifact the dsh web
 * loader consumes — `window.__ModuleLoader__.load({ id: 'dsh-llm-fallbacks',
 * factory: (require) => { … return module.exports; } })`. Externals resolve
 * through the loader module table (platform seed entries + the documented
 * `@deepseek-ai/dsh-client-runtime/client` exemption); everything else
 * inlines.
 *
 * Build tool: `bun build` (the mstar client-bundle recipe; no tsdown needed).
 * `dist/client/index.js` is a build artifact (gitignored like the rest of
 * `dist/`); the matching `dist/client/index.d.ts` is emitted by `tsc`
 * (`emitDeclarationOnly`) from `src/client/index.ts`.
 *
 * One build plugin enforces the bundle contract (Task 5 upgrade of the Task 1
 * `simplify:` marker, mirroring mstar build-client-bundle.ts):
 * - CSS Modules (`*.module.css`) are compiled to a hashed class map plus an
 *   inline `<style data-plugin>` injection that runs when the factory
 *   materializes (the loader removes plugin-owned tags on unload).
 *
 * The `@deepseek-ai/*` purity gate stays deferred: the client half's only
 * runtime `@deepseek-ai/*` import is `@deepseek-ai/dsh-client-runtime/client`
 * (a documented CLIENT_EXTERNALS platform module) — every other
 * `@deepseek-ai/*` import is type-only and erased before resolution.
 */

import { build } from 'bun'
import { basename, join } from 'node:path'
import { readFileSync } from 'node:fs'

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
 * `8hex_local` (mirrors the mstar recipe's `[hash]_[local]` pattern; the hash
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
 * export (mirror of the mstar CSS plugin).
 *
 * simplify: the css text is emitted as-is (comment-stripped, not minified);
 * the snapshot recipe runs lightningcss. If bundle size ever matters, switch
 * the devDep path (tsdown + the clientBundle recipe) or add a minifier here.
 */
function cssModuleContents(fileId: string): { contents: string; loader: 'js' } {
  const source = readFileSync(fileId, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const classMap: Record<string, string> = {}
  const css = source.replace(/\.[A-Za-z_][A-Za-z0-9_-]*/g, (match) => {
    const local = match.slice(1)
    const hashed = hashClass(local)
    classMap[local] = hashed
    return `.${hashed}`
  })
  const tagId = `${ID}/${basename(fileId)}`
  const contents = [
    styleInjectionContents(css, tagId),
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
  return { contents, loader: 'js' }
}

const result = await build({
  entrypoints: [ENTRY],
  outdir: OUT_DIR,
  target: 'browser',
  format: 'cjs',
  external: [...CLIENT_EXTERNALS],
  // react/zustand-style deps read process.env.NODE_ENV; honor the build env
  // like the mstar recipe (artifacts default to production). No `import.meta`
  // define needed: nothing inlined reads it (the store engine is external),
  // and a literal `import.meta` would be a SyntaxError under the classic
  // <script> loader anyway.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  loader: { '.css': 'text' },
  // Closure-factory handoff: `module`/`exports` are declared inside the
  // factory body because bun's cjs emission assigns module.exports itself;
  // the factory returns that surface to the loader.
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  footer: 'return module.exports; } });',
  naming: { entry: OUT_FILE },
  plugins: [
    {
      name: 'dsh-css-modules-inline',
      setup(build) {
        build.onLoad({ filter: /\.module\.css$/ }, (args) => cssModuleContents(args.path))
      },
    },
  ],
})

if (!result.success) {
  const detail = result.logs.map((log) => (typeof log === 'string' ? log : log.message)).join('\n')
  throw new Error(`client bundle build failed:\n${detail}`)
}
if (result.outputs.length !== 1 || !result.outputs[0]!.path.endsWith(join(OUT_DIR, OUT_FILE))) {
  throw new Error(
    `client bundle build: expected exactly one ${join(OUT_DIR, OUT_FILE)} output, got ${result.outputs.map((o) => o.path).join(', ')}`,
  )
}

// Inline bundle-contract assertions: the emitted text must carry the inlined
// css-module class map (the transform ran), must NOT contain `import.meta` /
// ESM statements (the classic-script loader would fail to parse them), and
// the only `@deepseek-ai/*` value import must be the documented external
// runtime/client exemption.
const bundleText = readFileSync(result.outputs[0]!.path, 'utf8')
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

console.log(`build-client: ${ENTRY} -> ${result.outputs[0]!.path} (closure-factory CJS, ${result.outputs[0]!.kind})`)
