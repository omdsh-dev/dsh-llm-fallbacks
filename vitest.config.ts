/**
 * Vitest configuration.
 *
 * Type-level access flows through the REAL `@deepseek-ai/*` packages (the
 * `peerDependencies`; this dev tree links them to the local 0.1.2-alpha.1
 * sources). The linked packages are tsc-built into `lib/types/` only — the
 * tsdown bundle step that would produce the exports-mapped `lib/index.js`
 * entries has not been run — so the test graph's VALUE imports (client and
 * host half) cannot resolve through the packages' exports maps. The config
 * below points those specifiers at the real implementations in the linked
 * tree:
 * `resolve.alias` rewrites the specifier and `server.deps.inline` keeps
 * vitest from handing it to Node's loader (which would reject the subpath
 * through the exports map). Dev/test tooling ONLY: product imports keep the
 * bare specifiers, and both blocks can be dropped once the peers resolve
 * from a registry/bundled tree again.
 * - `@deepseek-ai/cordis` + `@deepseek-ai/cosmokit` (cordis' one runtime
 *   dep): the real `Context` the fiber-backed specs drive (compiled
 *   `lib/types/index.js`).
 * - `@deepseek-ai/dsh-client-store`: the real snapshot-store engine the
 *   client half value-imports (sync flush default; zustand/immer resolve
 *   from the upstream package's own node_modules).
 * - `@deepseek-ai/dsh-client-ui-primitives`: Button/icons/Tooltip the card
 *   value-imports — aliased to the package's TS SOURCE because its
 *   css-module imports only resolve next to the sources (the tsc emit drops
 *   the sibling `.module.css` files).
 * - Host-half VALUE imports (`@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-llm`,
 *   `@deepseek-ai/dsh-llm-retry`, `@deepseek-ai/dsh-api-gateway`,
 *   `@deepseek-ai/dsh-typert-registry`, `@deepseek-ai/dsh-typert-protocol`,
 *   plus their transitive VALUE deps `@deepseek-ai/dsh-timeout` +
 *   `@deepseek-ai/dsh-util-crypto`): the host specs drive the real linked
 *   implementations the same way (found by the first full-suite run in the
 *   linked tree). `dsh-llm` keeps its compiled emit (its sources use standard
 *   decorators esbuild cannot transform); the attribution version hook below
 *   papers over the emit's one relative `../package.json` read.
 * Everything else `@deepseek-ai/*` in the test graph is type-only (erased at
 * runtime). `@deepseek-ai/dsh-settings` runs the REAL implementation in tests
 * over a thin in-memory provider (`tests/support/memory-settings.ts`,
 * extends the real abstract `SettingsProvider` base class).
 */
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

// Node_modules live once per plan: the worktree's node_modules is a symlink
// to the control checkout's, and vite bundles this config into THAT tree's
// .vite-temp — so import.meta.url lies about the checkout. Run root (the
// worktree when vitest is invoked there) is the honest anchor.
const here = process.cwd()
// A linked peer's compiled implementation: `<pkg>/lib/types/index.js` — the
// tsc emit the 0.1.2 tree ships instead of the exports-mapped `lib/index.js`.
// realpathSync walks the node_modules symlink out to the upstream tree so the
// resolved id no longer sits under this checkout's node_modules.
const linked = (pkgPath: string): string =>
  realpathSync(resolve(here, 'node_modules', pkgPath, 'lib', 'types', 'index.js'))
// TS-source variant — for packages whose runtime graph needs files the tsc
// emit does not carry (ui-primitives' css-module siblings).
const linkedSrc = (pkgPath: string): string =>
  realpathSync(resolve(here, 'node_modules', pkgPath, 'src', 'index.ts'))

// The compiled dsh-llm emit cannot be TS source here: its files use standard
// (stage-3) decorators (`@Remote`), which esbuild cannot transform. The tsc
// emit is decorator-free, but its attribution.js reads its version via a
// RELATIVE `createRequire(import.meta.url)('../package.json')` — valid for
// the published lib/ bundle layout, broken under lib/types/ (it would need a
// nonexistent lib/package.json). Serve the real package.json version as a
// literal at transform time instead of patching the linked checkout.
const dshLlmAttribution = {
  name: 'linked-dsh-llm-attribution-version',
  transform(code: string, id: string) {
    if (!id.endsWith('packages/llm/llm/lib/types/attribution.js')) return null
    const pkg = JSON.parse(
      readFileSync(realpathSync(resolve(here, 'node_modules/@deepseek-ai/dsh-llm/package.json')), 'utf8'),
    ) as { version: string }
    return code.replace(
      "createRequire(import.meta.url)('../package.json')",
      `({ version: ${JSON.stringify(pkg.version)} })`,
    )
  },
}

export default defineConfig({
  plugins: [dshLlmAttribution],
  test: {
    // Feature worktrees under `.worktrees/` carry duplicate copies of
    // tests/; the default include glob picks them up (gitignore does not
    // filter it), which makes `pnpm test` counts non-deterministic and
    // drifts from the documented baseline.
    exclude: [...defaultExclude, '**/.worktrees/**'],
    server: {
      deps: {
        // Inline the linked peers whose VALUE imports the test graph
        // needs (see the header note): vitest externalizes node_modules
        // specifiers before aliases apply, so without inlining Node's loader
        // rejects them through their exports maps.
        inline: [
          /@deepseek-ai\/cordis/,
          /@deepseek-ai\/cosmokit/,
          /@deepseek-ai\/dsh-client-store/,
          /@deepseek-ai\/dsh-client-ui-primitives/,
          /@deepseek-ai\/dsh-settings/,
          /@deepseek-ai\/dsh-llm/,
          /@deepseek-ai\/dsh-llm-retry/,
          /@deepseek-ai\/dsh-api-gateway/,
          /@deepseek-ai\/dsh-typert-registry/,
          /@deepseek-ai\/dsh-typert-protocol/,
          /@deepseek-ai\/dsh-timeout/,
          /@deepseek-ai\/dsh-util-crypto/,
        ],
      },
    },
  },
  resolve: {
    // The aliased ui-primitives source resolves `react` from its own
    // node_modules — a second React instance next to the tests' one (hooks
    // crash with "reading 'useRef'"). Pin the React pair to this root's
    // single copy.
    dedupe: ['react', 'react-dom'],
    alias: [
      // $-anchored so a subpath specifier never shadows. See the header note
      // for what each target is.
      { find: /^@deepseek-ai\/cordis$/, replacement: linked('@deepseek-ai/cordis') },
      {
        find: /^@deepseek-ai\/cosmokit$/,
        replacement: linked('@deepseek-ai/cordis/node_modules/@deepseek-ai/cosmokit'),
      },
      { find: /^@deepseek-ai\/dsh-client-store$/, replacement: linked('@deepseek-ai/dsh-client-store') },
      { find: /^@deepseek-ai\/dsh-settings$/, replacement: linked('@deepseek-ai/dsh-settings') },
      { find: /^@deepseek-ai\/dsh-llm$/, replacement: linked('@deepseek-ai/dsh-llm') },
      { find: /^@deepseek-ai\/dsh-llm-retry$/, replacement: linked('@deepseek-ai/dsh-llm-retry') },
      { find: /^@deepseek-ai\/dsh-api-gateway$/, replacement: linked('@deepseek-ai/dsh-api-gateway') },
      { find: /^@deepseek-ai\/dsh-typert-registry$/, replacement: linked('@deepseek-ai/dsh-typert-registry') },
      { find: /^@deepseek-ai\/dsh-typert-protocol$/, replacement: linked('@deepseek-ai/dsh-typert-protocol') },
      { find: /^@deepseek-ai\/dsh-timeout$/, replacement: linked('@deepseek-ai/dsh-timeout') },
      { find: /^@deepseek-ai\/dsh-util-crypto$/, replacement: linked('@deepseek-ai/dsh-util-crypto') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: linkedSrc('@deepseek-ai/dsh-client-ui-primitives') },
    ],
  },
})
