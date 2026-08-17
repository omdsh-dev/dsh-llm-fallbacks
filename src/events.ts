/**
 * `fallbacks/switch` session event vocabulary (spec §5 table; plan Task 3).
 *
 * Writing is stopped (issue #52): the plugin no longer appends this event —
 * the apply()-time event-type registration was proven ineffective (module
 * instance mismatch), and a session containing the event refused to load
 * after a dsh restart. The event now exists only in history: old logs are
 * repaired by `scripts/repair-fallbacks-switch-logs.ts`, which marks legacy
 * events ignorable so affected sessions load again.
 * The module is type-only — the augmentation is erased at runtime; the
 * plugin's runtime behavior lives in `src/index.ts`.
 *
 * @module dsh-llm-fallbacks/events
 */

/**
 * Why a switch was decided (spec §5.1 `PendingSwitch.reason`).
 *
 * `role-inject` is the dispatch-time reason (plan fallbacks-role-automatch
 * Task 4): a subagent-origin agent's first request was re-routed to its
 * resolved role's chain head. It is ADDITIVE to the failure-time reasons —
 * the event shape stays a superset of the pre-feature payload, and existing
 * renderers show unknown reasons raw (AC-5). Unlike `trigger-code` /
 * `always-cap`, a `role-inject` event is NOT a failure decision: it carries
 * no pending switch / cooldown / failure bookkeeping (no `commit()`).
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
