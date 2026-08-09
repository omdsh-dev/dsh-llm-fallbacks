/**
 * `fallbacks/switch` session event vocabulary (spec §5 table; plan Task 3).
 *
 * The event is appended (never rewrites history — AC-7) at every switch,
 * including the always-mode cap path: "无事件即无切换" (Global Constraint).
 * The module is type-only — the augmentation is erased at runtime; the
 * plugin's runtime behavior lives in `src/index.ts`.
 *
 * @module dsh-llm-fallbacks/events
 */

/** Why a switch was decided (spec §5.1 `PendingSwitch.reason`). */
export type FallbackSwitchReason = 'trigger-code' | 'always-cap'

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
    /** Durable, append-only record of one provider/model switch decided by dsh-llm-fallbacks. */
    'fallbacks/switch': FallbacksSwitchEventData
  }
}
