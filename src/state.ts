/**
 * Per-agent fallback state (direction C, plan dsh-022-rc1-upgrade).
 *
 * One `AgentFallbackState` per `agent.id`, held in a `FallbackStateStore`
 * created at plugin apply, removed on `agent/disposed`, and cleared wholesale
 * on plugin dispose (spec §6: 无残留状态).
 *
 * The store is the CROSS-CALL memory the chain walk reads: **cooldown**
 * (`CooldownStore` — a `provider/model → expiry epoch ms` map with lazy expiry;
 * `revertPolicy: 'never'` = `Infinity` TTL) plus the **recovery** circuit
 * (`RecoveryStore`). The time-boxed cooldown deliberately survives idle
 * cleanup so `cooldown-expiry` revert (US-4 / T4 integration) works across
 * turns. Per-request bookkeeping (the failed-candidate set, the switch cap) is
 * walk-local: a walk lives inside one `stream()` call, so nothing durable is
 * kept for it here.
 *
 * @module dsh-llm-fallbacks/state
 */

import { CooldownStore } from './cooldown.ts'
import { RecoveryStore } from './recovery.ts'
import type { RecoveryPolicy } from './config.ts'

/** One agent's fallback runtime state. */
export interface AgentFallbackState {
  /** `provider/model → expiry epoch ms`; lazily expired on read. */
  cooldown: CooldownStore
  /** Half-open recovery bookkeeping (plan fallbacks-half-open-recovery P2). */
  recovery: RecoveryStore
}

/**
 * The `Map<agent.id, AgentFallbackState>` store plus the state operations the
 * walk and the diagnostics surfaces read.
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
      state = { cooldown: new CooldownStore(), recovery: new RecoveryStore() }
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
   * Observed completion ⇒ close the circuit (plan P2 rule 6). The lazy
   * expiry runs FIRST — the same read the decision path performs — so a
   * cooldown that lapsed BEFORE this completion is treated as what it is:
   * an expired suppression, not an active one. The completion is
   * post-expiry evidence and closes the circuit even when no decision-path
   * read has transitioned the entry to half-open yet (a manual
   * re-selection of the route, or a route no walk ever consulted because the
   * current route kept succeeding). An ACTIVE suppression (`until > now`,
   * including the `Infinity` of `revertPolicy: 'never'`) is untouched:
   * a stale in-flight success must not cancel a fresher escalated
   * re-suppression.
   */
  observeSuccess(state: AgentFallbackState, key: string, now: number = Date.now()): void {
    if (state.cooldown.peek(key) !== undefined) this.isSuppressed(state, key, now, 'half-open')
    state.recovery.close(key)
  }
}
