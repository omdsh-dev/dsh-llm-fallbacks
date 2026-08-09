/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-llm` seam consumed by
 * `dsh-llm-fallbacks`.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — `LlmFailure` / `LlmCallConfig` / `LlmError` / `ResolvedRetryPolicy`
 * / `ReasoningEffortId`. Mirrors dsh-private commit b8343cb (2026-08-09
 * snapshot); keep in sync when the dsh baseline moves.
 */

/** Serializable provider-boundary facts; policy decides whether they are retryable. */
export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status observed at the provider boundary, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: string
}

/** Process-local identity of one reasoning-effort id (mirror of the real brand). */
export type ReasoningEffortId = string & { readonly __brand?: 'ReasoningEffortId' }

/** Provider, model, reasoning effort, and sampling scalars of one conversation's requests. */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** Immutable provider policy captured when its adapter route is registered. */
export interface ResolvedRetryPolicy {
  readonly mode: 'normal' | 'always'
  readonly maxRetries?: number
  readonly retryableCodes?: readonly string[]
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** Typed error for LLM-related failures; carries the stable `code` taxonomy. */
export declare class LlmError extends Error {
  /** Stable machine-routable failure class (e.g. `AUTH`, `RATE_LIMIT`). */
  readonly code: string
  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure
  constructor(message: string, code: string, options?: ErrorOptions & {
    status?: number
    providerRetryAfterMs?: number
    requestId?: string
  })
}
