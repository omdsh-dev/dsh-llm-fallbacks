/**
 * Vitest configuration.
 *
 * Type-level access flows through the REAL `@deepseek-ai/*` packages resolved
 * from the npm registry (peerDependencies via `autoInstallPeers`) — no local
 * link farm. One runtime seam needs an alias:
 * - The client half's runtime `@deepseek-ai/*` VALUE import is
 *   `@deepseek-ai/dsh-client-runtime/client` (the snapshot-store engine). The
 *   published `./client` entry is a browser loader artifact (not a
 *   node-importable module, and the tarball carries no `src/`), so tests
 *   resolve it to a local node-safe double
 *   (`tests/support/snapshot-store.ts`).
 * - `@deepseek-ai/dsh-settings` runs the REAL implementation in tests over a
 *   thin in-memory provider (`tests/support/memory-settings.ts`, extends the
 *   real abstract `SettingsProvider` base class).
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Transform standard TypeScript decorators before Vite's SSR pipeline sees
 * source files (the same pattern dsh-private ships in `vitest.shared.ts`):
 * vitest 4's module evaluator runs transformed code through `node:vm`'s
 * `Script`, which cannot parse decorator syntax, and vite's SSR transform
 * preserves decorators (the `esbuild.target` option does not reach it). The
 * `@Remote` markers in src/gateway.ts are the first decorators in this repo's
 * test surface.
 * @returns a pre-transform Vite plugin shared by source-mode test configurations.
 */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    // Feature worktrees under `.worktrees/` carry duplicate copies of
    // tests/; the default include glob picks them up (gitignore does not
    // filter it), which makes `pnpm test` counts non-deterministic and
    // drifts from the documented baseline.
    exclude: [...defaultExclude, '**/.worktrees/**'],
    server: {
      deps: {
        // dsh-client-ui-primitives (registry) does `import "katex/dist/katex.min.css"`
        // as a side effect; inline it so vite stubs the CSS import instead of
        // handing the .css path to Node's ESM loader (Unknown file extension).
        inline: [/dsh-client-ui-primitives/],
      },
    },
  },
  resolve: {
    alias: [
      // The published @deepseek-ai/dsh-client-runtime `./client` entry is a
      // browser loader artifact — not a node-importable module, and the
      // tarball carries no `src/`. Dev-time tests resolve the one VALUE import
      // the client store makes (`createSnapshotStore`) to a node-safe local
      // double; every other `@deepseek-ai/*` import is type-only (erased at
      // runtime) and resolves from the registry package.
      {
        find: '@deepseek-ai/dsh-client-runtime/client',
        replacement: resolve(here, 'tests', 'support', 'snapshot-store.ts'),
      },
    ],
  },
})
