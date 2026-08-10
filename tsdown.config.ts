/**
 * Host-half bundle (tsdown — the same build tool the dsh host itself uses,
 * pnpm stack, no bun).
 *
 * Replaces the previous `bun build src/index.ts --target node --outdir dist
 * --external cordis --external '@deepseek-ai/*'`:
 * - ESM bundle, node platform, target matches tsconfig (ES2022).
 * - Only `cordis` and `@deepseek-ai/*` stay external (`deps.neverBundle`;
 *   tsdown also auto-externalizes `peerDependencies`): the host resolves
 *   them from its in-box bundles at runtime, never from this bundle.
 * - Everything else (e.g. schemastery) inlines, exactly like the bun build
 *   (`onlyBundle: false` marks that intentional — it is a devDep, not a
 *   runtime peer).
 * - `clean: true` wipes `dist/` (including stale client output) before the
 *   host build; the client bundle (`pnpm run build-client`, clean: false)
 *   and the `tsc` declaration emit follow in the `build` pipeline.
 * - `dts: false`: declarations come from `tsc` (tsconfig
 *   `emitDeclarationOnly`), keeping the `dist/*.d.ts` layout stable.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-llm-fallbacks',
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  deps: {
    neverBundle: ['cordis', /^@deepseek-ai\//],
    onlyBundle: false,
  },
  dts: false,
  clean: true,
})
