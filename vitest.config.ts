/**
 * Vitest configuration (plan Global Constraints; pm-note-type-access.md).
 *
 * The plugin's only runtime `@deepseek-ai/*` import is
 * `@deepseek-ai/dsh-settings` (bun build keeps it external for the host to
 * resolve in-box); every other `@deepseek-ai/*` import is type-only and is
 * erased by the transform. Tests therefore alias just the settings seam to an
 * instrumented double. Type-level access flows through `peer-stubs/` +
 * tsconfig `paths` (skipLibCheck, so stub completeness is not enforced).
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-settings': resolve(import.meta.dirname, 'tests/support/settings-stub.ts'),
    },
  },
})
