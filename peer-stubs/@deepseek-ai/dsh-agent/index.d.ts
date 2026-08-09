/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-agent` seam consumed by
 * `dsh-llm-fallbacks`.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — `Agent` / `AgentOptions` / `RequestErrorAction` and the
 * `agent/request-error` / `agent/request` / `agent/status` / `agent/disposed`
 * cordis `Events` entries. Mirrors dsh-private commit b8343cb
 * (2026-08-09 snapshot); keep in sync when the dsh baseline moves.
 *
 * `AgentOptions` intentionally omits `role` — the Task 6 patch is not applied
 * to this snapshot; role resolution flows through the plugin's own loose
 * `AgentLike` shape instead.
 */
import type { LlmCallConfig, LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Merge-extensible agent creation options (mirror of the real surface). */
export interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string
  /** Model id interpreted by the selected provider adapter. */
  model?: string
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}

/** An agent's lifecycle state, emitted on every transition as `agent/status`. */
export type AgentStatus = 'idle' | 'running'

/** Action returned by a listener that owns model-request recovery. */
export type RequestErrorAction = { kind: 'retry' } | undefined

/** The public live-agent handle (consumed surface only). */
export interface Agent {
  /** The single identity shared with the session. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
}

declare module 'cordis' {
  interface Events {
    /**
     * Replace the frozen call configuration. `await next()` yields the config
     * the machine would use; return a replacement to switch.
     * @mode waterfall
     */
    'agent/request'(
      payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<LlmCallConfig>,
    ): Promise<LlmCallConfig>
    /**
     * Handle one failed model-request attempt before the loop retries or
     * closes its step. A listener returns `{ kind: 'retry' }` without calling
     * `next()` when it owns recovery, or calls `next()` to delegate.
     * @mode waterfall
     */
    'agent/request-error'(
      payload: {
        agent: Agent
        turn: number
        step: number
        provider: string
        failure: LlmFailure
        retryPolicy: ResolvedRetryPolicy | undefined
        signal: AbortSignal
      },
      next: () => Promise<RequestErrorAction>,
    ): Promise<RequestErrorAction>
    /** Agent status changed (`idle` ⇄ `running`). @mode emit */
    'agent/status'(payload: { agent: Agent; status: AgentStatus }): void
    /** An agent left the registry. @mode emit */
    'agent/disposed'(payload: { agent: Agent }): void
  }
}
