/**
 * Vitest configuration (plan Global Constraints; pm-note-type-access.md).
 *
 * The plugin's only runtime `@deepseek-ai/*` imports are
 * `@deepseek-ai/dsh-settings` (host half) and
 * `@deepseek-ai/dsh-client-runtime/client` (client half, the snapshot-store
 * engine); bun keeps both external for the host to resolve in-box. Every
 * other `@deepseek-ai/*` import is type-only and is erased by the transform.
 * Tests therefore alias just those two seams to instrumented doubles.
 * Type-level access flows through `peer-stubs/` + tsconfig `paths`
 * (skipLibCheck, so stub completeness is not enforced).
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-settings': resolve(import.meta.dirname, 'tests/support/settings-stub.ts'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(import.meta.dirname, 'tests/support/runtime-stub.ts'),
    },
  },
})
