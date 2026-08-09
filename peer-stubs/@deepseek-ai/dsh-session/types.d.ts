/**
 * Session event vocabulary stub (see `index.d.ts` header). Mirrors
 * dsh-private commit b8343cb (2026-08-09 snapshot), consumed surface only.
 */
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Plugin-owned events augment this interface (see `src/events.ts`).
 */
export interface SessionEventMap {
  /**
   * Placeholder for the llm-retry event the plugin's always-mode cap counts
   * (the real augmentation lives in llm-retry). Only the fields the plugin
   * consumes are declared.
   */
  'llm/retry': {
    turn: number
    step: number
    provider: string
    policyKey?: string
    retry?: number
  }
}

/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
export type SessionEventType = keyof SessionEventMap

/** One immutable entry in the session log (simplified — no surface metadata). */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  }
}[T]

/** Process-local branded session identity. */
export type SessionId = string & { readonly __brand?: 'SessionId' }

/** Full header for the next request, appended inside its step before dispatch. */
export interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: unknown
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: unknown[]
}

/** Session identity + creation metadata folded into the durable header. */
export interface SessionHeader {
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Coarse product classification for a session created as a subagent child. */
  readonly origin?: 'subagent'
  /** Delegation depth: absent (zero) for a top-level session. */
  readonly delegationDepth?: number
}

/** An event-sourced session: an append-only log of {@link SessionEvent}s (consumed surface only). */
export interface Session {
  /** The session identity. */
  readonly id: SessionId
  /** The durable session header (carries `origin` for subagent children). */
  readonly header: SessionHeader
  /** An immutable snapshot of the append-only event log. */
  readonly events: readonly SessionEvent[]
  /** Append one typed event to the log (non-surface events take no surface metadata). */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T>
  /** The folded request header of the latest logged request, when one exists. */
  requestHeader(): EpochHeader | undefined
}
