/**
 * Vitest configuration (plan Global Constraints; pm-note-type-access.md).
 *
 * Type-level access flows through the REAL `@deepseek-ai/*` packages, linked
 * into `node_modules/` from the dsh source tree by `scripts/setup-dsh-links.mjs`
 * (`$DSH_SOURCE_DIR`, default `${DSH_HOME}/source/current`, then
 * `~/.dsh/source/current`) — no hand-maintained stubs (peer-stubs/ removed).
 * The same tree provides the in-box cordis via a generated shim, so tests run
 * the real framework the host ships.
 *
 * Two runtime seams need no aliases:
 * - `@deepseek-ai/dsh-settings`: the REAL implementation runs in tests over a
 *   thin in-memory provider (`tests/support/memory-settings.ts`, extends the
 *   real abstract `Settings` base class) — namespace registration, watchers
 *   and revisions are the real semantics.
 * - The client half's other runtime `@deepseek-ai/*` import is
 *   `@deepseek-ai/dsh-client-runtime/client` (the snapshot-store engine);
 *   the tsdown client build keeps it external for the host to resolve
 *   in-box, and its built `./client` entry is a browser loader artifact — so
 *   tests alias the subpath to the tree's SOURCE store engine instead.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * Resolve the dsh source tree the dev-time link farm was built from — the
 * same order as scripts/setup-dsh-links.mjs ($DSH_SOURCE_DIR first, then
 * $DSH_HOME/source/current, then the default home location).
 */
function resolveSourceRoot(): string {
  const candidates = [
    process.env.DSH_SOURCE_DIR,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

const sourceRoot = resolveSourceRoot()

export default defineConfig({
  resolve: {
    alias: sourceRoot
      ? [
          // The real packages' `./client` entries are browser loader artifacts
          // (`window.__ModuleLoader__.load(...)` — served to the web shell at
          // runtime); dev-time tests resolve the snapshot-store engine to its
          // SOURCE instead. Its value import graph (zustand/immer) resolves
          // from the tree, and cross-package imports are type-only.
          {
            find: '@deepseek-ai/dsh-client-runtime/client',
            replacement: join(sourceRoot, 'packages', 'client', 'runtime', 'src', 'client', 'contract', 'store.ts'),
          },
        ]
      : [],
  },
})
