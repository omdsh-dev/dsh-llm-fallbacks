/**
 * Vitest configuration.
 *
 * Type-level access flows through the REAL `@deepseek-ai/*` packages (the
 * `peerDependencies`; this dev tree links them to the local 0.1.2-alpha.1
 * sources). The linked packages are tsc-built into `lib/types/` only — the
 * tsdown bundle step that would produce the exports-mapped `lib/index.js`
 * entries has not been run — so the client-half graph's VALUE imports cannot
 * resolve through the packages' exports maps. The config below points those
 * specifiers at the real implementations in the linked tree:
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
 * Everything else `@deepseek-ai/*` in the test graph is type-only (erased at
 * runtime). `@deepseek-ai/dsh-settings` runs the REAL implementation in tests
 * over a thin in-memory provider (`tests/support/memory-settings.ts`,
 * extends the real abstract `SettingsProvider` base class).
 */
import { realpathSync } from 'node:fs'
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

export default defineConfig({
  test: {
    // Feature worktrees under `.worktrees/` carry duplicate copies of
    // tests/; the default include glob picks them up (gitignore does not
    // filter it), which makes `pnpm test` counts non-deterministic and
    // drifts from the documented baseline.
    exclude: [...defaultExclude, '**/.worktrees/**'],
    server: {
      deps: {
        // Inline the linked peers whose VALUE imports the client-half graph
        // needs (see the header note): vitest externalizes node_modules
        // specifiers before aliases apply, so without inlining Node's loader
        // rejects them through their exports maps.
        inline: [
          /@deepseek-ai\/cordis/,
          /@deepseek-ai\/cosmokit/,
          /@deepseek-ai\/dsh-client-store/,
          /@deepseek-ai\/dsh-client-ui-primitives/,
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
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: linkedSrc('@deepseek-ai/dsh-client-ui-primitives') },
    ],
  },
})
