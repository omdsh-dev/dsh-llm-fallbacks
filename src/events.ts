/**
 * `fallbacks/switch` session event vocabulary (spec §5 table; plan Task 3).
 *
 * Writing is stopped (issue #52): the plugin no longer appends this event —
 * the apply()-time event-type registration was proven ineffective (module
 * instance mismatch), and a session containing the event refused to load
 * after a dsh restart. The event now exists only in history: old logs that
 * contain it cannot be repaired by an `ignorable` flag (the released
 * session-format chain refuses unknown event types even when marked
 * ignorable), so `pnpm repair:session-logs` only reports such logs by
 * default; its opt-in lossy `--drop-legacy-events` mode is the sole recovery.
 * The module is type-only — the augmentation is erased at runtime; the
 * plugin's runtime behavior lives in `src/index.ts`.
 *
 * @module dsh-llm-fallbacks/events
 */

// The `llm/retry` / `llm/retry-started` SessionEventMap entries are
// declared by `@deepseek-ai/dsh-llm-retry` (host plugin augmenting
// `@deepseek-ai/dsh-session/types`), not by the core session package. This
// plugin no longer reads them (direction C deleted the always-mode counter),
// but the peer's augmentation stays in this program's type graph so every
// consumer that types a `llm/retry` event against the session map compiles —
// type-only import, erased at runtime (same pattern as the client half's
// empty type-only imports). The event DATA shape stays the
// `LlmRetryEventData` the host appends
// (retryId/turn/step/provider/mode/policyKey/retry/...).
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/**
 * Why a switch was decided — a **history and bookkeeping vocabulary** since
 * direction C, not a set of live decision paths.
 *
 * `trigger-code` is the only reason the current code produces (the walk's
 * swallowed trigger failure, and the blocked-attempt record that mirrors it).
 * `always-cap` (retired always-mode cap) and `role-inject` (retired
 * dispatch-time request override) survive only so legacy `fallbacks/switch`
 * events and their renderers keep a label; nothing writes them any more, and
 * an unknown reason still renders raw (AC-5).
 */
export type FallbackSwitchReason = 'trigger-code' | 'always-cap' | 'role-inject'

/** Durable payload of one provider/model switch (spec §5 table). */
export interface FallbacksSwitchEventData {
  turn: number
  step: number
  /** The model the request was using when the switch was decided. */
  from: { provider: string; model: string }
  /** The chain candidate the switch moves to. */
  to: { provider: string; model: string }
  /** The fallback-chain role the decision resolved for the agent (ADR-3). */
  role: string
  reason: FallbackSwitchReason
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Historical, append-only record of one provider/model switch decided by dsh-llm-fallbacks (no longer written — issue #52 stop-write). */
    'fallbacks/switch': FallbacksSwitchEventData
  }
}
