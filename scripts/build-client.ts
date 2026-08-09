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
 * simplify: no CSS-modules transform or `@deepseek-ai/*` purity gate yet —
 * the Task 1 client entry imports nothing but types, so neither has any input
 * to act on. Task 5 (Fallbacks settings section) adds the CSS-module inliner
 * and the purity gate together with the first value imports.
 */

import { build } from 'bun'
import { join } from 'node:path'

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

const result = await build({
  entrypoints: [ENTRY],
  outdir: OUT_DIR,
  target: 'browser',
  format: 'cjs',
  external: [...CLIENT_EXTERNALS],
  // Closure-factory handoff: `module`/`exports` are declared inside the
  // factory body because bun's cjs emission assigns module.exports itself;
  // the factory returns that surface to the loader.
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  footer: 'return module.exports; } });',
  naming: { entry: OUT_FILE },
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

console.log(`build-client: ${ENTRY} -> ${result.outputs[0]!.path} (closure-factory CJS, ${result.outputs[0]!.kind})`)
