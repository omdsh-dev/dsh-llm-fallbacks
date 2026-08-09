/**
 * dsh-llm-fallbacks client half (skeleton).
 *
 * Bundled to the closure-factory artifact `dist/client/index.js` consumed by
 * the dsh web loader (`dshClient` metadata declares the injected platform
 * modules). Task 1 ships the empty entry only: the Fallbacks settings
 * section (`settings.section` slot, id `fallbacks`) lands in Task 5.
 *
 * @module dsh-llm-fallbacks/client
 */

import type { Context } from 'cordis'

export function apply(ctx: Context): void {
  // Placeholder client entry — the Fallbacks settings section lands in Task 5.
  ctx.logger('llm-fallbacks/client').info('dsh-llm-fallbacks client skeleton loaded')
}
