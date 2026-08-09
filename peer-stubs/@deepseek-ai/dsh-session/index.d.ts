/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-session` seam consumed by
 * `dsh-llm-fallbacks`.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — `SessionEventMap` (merge-extensible, augmented by
 * `src/events.ts`), `SessionEvent`, `Session`, `SessionId`, `EpochHeader`.
 * Mirrors dsh-private commit b8343cb (2026-08-09 snapshot); keep in sync
 * when the dsh baseline moves.
 *
 * `'llm/retry'` is a placeholder declared directly (the real augmentation
 * lives in llm-retry) so the plugin's always-mode cap counting type-checks.
 */
export * from './types'
