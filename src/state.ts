/**
 * Per-agent fallback state machine (spec §5.1; plan Task 3).
 *
 * One `AgentFallbackState` per `agent.id`, held in a `FallbackStateStore`
 * created at plugin apply, removed on `agent/disposed`, defensively pruned on
 * `agent/status` idle, and cleared wholesale on plugin dispose (spec §6:
 * 无残留状态).
 *
 * **pendingSwitch lifecycle** (spec §5.1):
 * 1. **Produce** (decision point — request-error trigger-code or
 *    agent/request always-cap): `writePending` stores the decision and clears
 *    `appliedTurnStep`, so a *fresh* decision is always applicable at the
 *    current (turn, step) — required for chains (decision B→C must apply even
 *    though A→B was already applied at the same (turn, step)).
 * 2. **Apply** (`agent/request`): `applyPending` returns the pending switch
 *    when one exists and has not already been applied at the current
 *    (turn, step), records `appliedTurnStep`, and clears `pendingSwitch`
 *    (anti-replay guard).
 * 3. **Discard**: chain exhaustion / safety valve → the caller delegates
 *    (`next()`) and the pending state dies with the agent.
 *
 * **stepFailures** resets whenever (turn, step) advances (`syncStep`);
 * **cooldown** (`CooldownStore`) is a `provider/model → expiry epoch ms` map
 * with lazy expiry (`revertPolicy: 'never'` = `Infinity` TTL). The time-boxed
 * cooldown deliberately survives idle cleanup so `cooldown-expiry` revert
 * (US-4 / T4 integration) works across turns.
 *
 * @module dsh-llm-fallbacks/state
 */

import type { FallbackSwitchReason } from './events.ts'
import { CooldownStore, StepFailureSet } from './cooldown.ts'
import { RecoveryStore } from './recovery.ts'
import type { RecoveryPolicy } from './config.ts'

/** Decision awaiting application at the next `agent/request` boundary (spec §5.1). */
export interface PendingSwitch {
  from: { provider: string; model: string }
  to: { provider: string; model: string }
  role: string
  reason: FallbackSwitchReason
}

/**
 * One plugin-originated subagent switch the host allowlist blocked (plan
 * dsh-012-subagent-routing T3; spec D1). The intersection of the resolved
 * candidates with the effective allowlist was empty while the 0.3.5 walk
 * would have switched — the attempt is recorded in-memory only (issue #52:
 * no durable session write) for the Subagents card warning (spec D4/T5).
 */
export interface BlockedSwitchAttempt {
  /** Epoch ms when the switch was blocked. */
  at: number
  /** The route the 0.3.5 walk would have switched to (exact provider+model). */
  route: { provider: string; model: string }
  /** The failure reason that triggered the would-be switch. */
  reason: FallbackSwitchReason
}

/**
 * How the effective subagent chain head was chosen (plan dsh-012-subagent-routing
 * T5 / T2 M3). Lives on a per-agent map (mirrors {@link BlockedSwitchAttempt}),
 * not on {@link AgentFallbackState} — recording a head is not a switch intent
 * (F-004: the fallback store grows only inside `commit()`).
 */
export type ChainHeadSource = 'authorized' | 'injected'

/**
 * The effective chain head for one subagent, plus the source label the
 * Subagents card renders (spec D4). In-memory only (issue #52).
 */
export interface EffectiveChainHead {
  /** Epoch ms when this head was recorded (recency for the card snapshot). */
  at: number
  /** Exact provider+model of the effective chain head. */
  route: { provider: string; model: string }
  /** `authorized` = host spawn preserved; `injected` = plugin role-inject. */
  source: ChainHeadSource
}

/** The current (turn, step)'s failed-model set and switch budget (spec §5.1). */
export interface StepFailures {
  turn: number
  step: number
  /** `${provider}/${model}` keys failed in this step (double suppression with cooldown). */
  failed: StepFailureSet
  /** Switches committed in this step; the caller judges it against `maxSwitchesPerStep`. */
  switchCount: number
}

/** One agent's whole fallback runtime state (spec §5.1). */
export interface AgentFallbackState {
  /** Decision produced but not yet applied at an `agent/request` boundary. */
  pendingSwitch?: PendingSwitch
  /** The (turn, step) the last pending switch was applied to — anti-replay. */
  appliedTurnStep?: { turn: number; step: number }
  /** Current (turn, step)'s failure bookkeeping. */
  stepFailures: StepFailures
  /** `provider/model → expiry epoch ms`; lazily expired on read. */
  cooldown: CooldownStore
  /** Half-open recovery bookkeeping (plan fallbacks-half-open-recovery P2). */
  recovery: RecoveryStore
}

/**
 * The `Map<agent.id, AgentFallbackState>` store plus the state-machine
 * operations (spec §5.1).
 */
export class FallbackStateStore {
  private readonly states = new Map<string, AgentFallbackState>()

  /** Number of tracked agents. */
  get size(): number {
    return this.states.size
  }

  has(agentId: string): boolean {
    return this.states.has(agentId)
  }

  /** Read without creating; `undefined` for unknown agents. */
  peek(agentId: string): AgentFallbackState | undefined {
    return this.states.get(agentId)
  }

  /** Read, creating an empty state on first sight. */
  get(agentId: string): AgentFallbackState {
    let state = this.states.get(agentId)
    if (state === undefined) {
      state = {
        stepFailures: { turn: 0, step: 0, failed: new StepFailureSet(), switchCount: 0 },
        cooldown: new CooldownStore(),
        recovery: new RecoveryStore(),
      }
      this.states.set(agentId, state)
    }
    return state
  }

  /** Remove one agent's state (`agent/disposed`). */
  delete(agentId: string): void {
    this.states.delete(agentId)
  }

  /** Remove every agent's state (plugin dispose — no residual state). */
  clear(): void {
    this.states.clear()
  }

  /** Reset step-scoped bookkeeping when (turn, step) advances (spec §5.1). */
  syncStep(state: AgentFallbackState, turn: number, step: number): void {
    const { stepFailures } = state
    if (stepFailures.turn === turn && stepFailures.step === step) return
    stepFailures.turn = turn
    stepFailures.step = step
    stepFailures.failed.reset()
    stepFailures.switchCount = 0
  }

  /** Record the current model as failed in this step (spec §5.1). */
  recordFailure(state: AgentFallbackState, key: string): void {
    state.stepFailures.failed.add(key)
  }

  /** Bump the step's switch budget (spec §5.1). */
  recordSwitch(state: AgentFallbackState): void {
    state.stepFailures.switchCount += 1
  }

  /**
   * Produce a pending switch. A fresh decision always supersedes a previous
   * one and must be applicable at the current (turn, step), so the applied
   * marker is cleared here (see module doc — chains).
   */
  writePending(state: AgentFallbackState, pending: PendingSwitch): void {
    state.pendingSwitch = pending
    state.appliedTurnStep = undefined
  }

  /**
   * Apply the pending switch at (turn, step) when one exists and has not
   * already been applied there; records the applied marker and clears the
   * pending switch (spec §5.1 lifecycle step 2).
   */
  applyPending(state: AgentFallbackState, turn: number, step: number): PendingSwitch | undefined {
    const pending = state.pendingSwitch
    if (pending === undefined) return undefined
    const applied = state.appliedTurnStep
    if (applied !== undefined && applied.turn === turn && applied.step === step) return undefined
    state.appliedTurnStep = { turn, step }
    state.pendingSwitch = undefined
    return pending
  }

  /**
   * Defensive `agent/status` idle cleanup: drop per-step state. The time-boxed
   * cooldown survives so `cooldown-expiry` revert works across turns (US-4).
   */
  clearStepState(state: AgentFallbackState): void {
    state.pendingSwitch = undefined
    state.appliedTurnStep = undefined
    state.stepFailures.failed.reset()
    state.stepFailures.switchCount = 0
  }

  /** Suppress `key` until `untilEpochMs` (`Infinity` for `revertPolicy: 'never'`). */
  suppress(state: AgentFallbackState, key: string, untilEpochMs: number): void {
    state.cooldown.suppress(key, untilEpochMs)
  }

  /**
   * Lazy cooldown read (spec §5.1; plan fallbacks-half-open-recovery P2
   * rule 3). Under `'timer'` (the default) today's body runs verbatim:
   * expired entries are dropped on read. Under `'half-open'` the raw `until`
   * is read via `CooldownStore.peek` (no lazy drop): absent ⇒ false;
   * `until > now` ⇒ true; `until <= now` ⇒ the entry is dropped via the
   * existing `isSuppressed` and the route is marked half-open, returning
   * false. `Infinity` (`revertPolicy: 'never'`) never satisfies `until <=
   * now` ⇒ the never short-circuit is structural on the read side.
   */
  isSuppressed(
    state: AgentFallbackState,
    key: string,
    now: number = Date.now(),
    recovery: RecoveryPolicy = 'timer',
  ): boolean {
    if (recovery !== 'half-open') return state.cooldown.isSuppressed(key, now)
    const until = state.cooldown.peek(key)
    if (until === undefined) return false
    if (until > now) return true
    state.cooldown.isSuppressed(key, now)
    state.recovery.markHalfOpen(key, until)
    return false
  }

  /**
   * Bulk half-open transition for the display path (plan P4): walks the
   * cooldown keys applying rule 3 per key. A pure no-op under `'timer'` —
   * internal state and output stay byte-identical in default mode.
   */
  syncRecovery(state: AgentFallbackState, now: number, mode: RecoveryPolicy): void {
    if (mode !== 'half-open') return
    for (const key of state.cooldown.keys()) {
      this.isSuppressed(state, key, now, mode)
    }
  }

  /**
   * Observed completion ⇒ close the circuit (plan P2 rule 6): acts only when
   * the entry exists and is half-open; otherwise a no-op (a stale in-flight
   * success must not cancel a fresher escalated re-suppression).
   */
  observeSuccess(state: AgentFallbackState, key: string): void {
    state.recovery.close(key)
  }
}
