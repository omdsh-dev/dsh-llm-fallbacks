/**
 * Half-open recovery state machine (plan fallbacks-half-open-recovery Task 2).
 *
 * `RecoveryStore` tracks per-route consecutive-failure counters and half-open
 * episode flags, keyed `${provider}/${model}` via `selectorKey`. It is held
 * per-agent on `AgentFallbackState` and is session-scoped in-memory (same
 * lifetime as the cooldown store; a restart resets every route to a flat
 * first cooldown).
 *
 * The store is pure logic — zero imports, the cooldown.ts purity precedent —
 * so it is unit-testable without a host (recovery.spec.ts imports this module
 * directly).
 *
 * State machine (plan P2):
 * 1. `recordFailure` — a suppression write: increments the consecutive-failure
 *    counter and clears any half-open episode (rule 1).
 * 2. `escalatedCooldownMs` — bounded geometric escalation of the suppression
 *    duration (rule 2).
 * 3. `markHalfOpen` — an expired cooldown leaves the route half-open for one
 *    logged probe (rule 3).
 * 4. `tryMarkProbeLogged` — the once-per-episode admission marker, not a gate
 *    (rule 4).
 * 5. `isHalfOpen` — probe-failure gate for the no-surviving-target path
 *    (rule 5b).
 * 6. `close` — an observed completion closes the circuit, only from half-open
 *    (rule 6).
 *
 * @module dsh-llm-fallbacks/recovery
 */

/** Escalation multiplier applied per consecutive failure (rule 2). */
export const ESCALATION_MULTIPLIER = 2
/** Escalation ceiling: 1 hour (rule 2). */
export const ESCALATION_CAP_MS = 3_600_000

/**
 * Bounded geometric escalation of the suppression duration (rule 2):
 * `max(ms, min(ESCALATION_CAP_MS, ms * ESCALATION_MULTIPLIER ** (n - 1)))`
 * for `n >= 1`. `n = 1` is flat `ms`; the `max(ms, ...)` floor keeps
 * escalation from ever shortening below the configured flat cooldown when
 * `ms >= ESCALATION_CAP_MS`; `ms = 0` degenerates to today's flat-0
 * semantics.
 */
export function escalatedCooldownMs(ms: number, n: number): number {
  return Math.max(ms, Math.min(ESCALATION_CAP_MS, ms * ESCALATION_MULTIPLIER ** (n - 1)))
}

/** One route's recovery bookkeeping (plan P2). */
interface RecoveryEntry {
  /** Suppressions written since the last observed close. */
  consecutiveFailures: number
  /** An expiry episode is in progress. */
  halfOpen: boolean
  /** The one logged admission marker of this episode. */
  probeLogged: boolean
  /** The lapsed expiry epoch (drives the display row). */
  expiredUntil?: number
}

/**
 * Per-route half-open recovery state (plan P2). Pure logic — no host
 * dependencies, no `@deepseek-ai/*` imports.
 */
export class RecoveryStore {
  private entries = new Map<string, RecoveryEntry>()

  /**
   * Record a suppression write for `key` (rule 1): increments the
   * consecutive-failure counter and clears any in-progress half-open episode
   * (a failure while half-open re-suppresses escalated — rule 5). Returns the
   * new counter value `n`; the caller computes the escalated duration with
   * {@link escalatedCooldownMs}.
   */
  recordFailure(key: string): number {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.entries.set(key, { consecutiveFailures: 1, halfOpen: false, probeLogged: false })
      return 1
    }
    entry.consecutiveFailures += 1
    entry.halfOpen = false
    entry.probeLogged = false
    return entry.consecutiveFailures
  }

  /**
   * Open a half-open episode for `key` (rule 3): the lapsed cooldown leaves
   * the route half-open for one logged probe. Resets the per-episode probe
   * marker; the consecutive-failure counter survives the episode so a probe
   * failure escalates to `n + 1` (rule 5). Creates the entry on first sight
   * (mid-session mode flips can surface a cooldown entry with no recovery
   * entry — rule 8).
   */
  markHalfOpen(key: string, until: number): void {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.entries.set(key, {
        consecutiveFailures: 0,
        halfOpen: true,
        probeLogged: false,
        expiredUntil: until,
      })
      return
    }
    entry.halfOpen = true
    entry.probeLogged = false
    entry.expiredUntil = until
  }

  /**
   * Mark the episode's one logged admission (rule 4). Returns `true` only for
   * the first admission of a half-open episode; later admissions while the
   * episode is unresolved return `false` and route normally (the marker is
   * not a gate — there is no admission limit).
   */
  tryMarkProbeLogged(key: string): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined || !entry.halfOpen || entry.probeLogged) return false
    entry.probeLogged = true
    return true
  }

  /** True while `key` has an in-progress half-open episode (rule 5b gate). */
  isHalfOpen(key: string): boolean {
    return this.entries.get(key)?.halfOpen === true
  }

  /**
   * Close the circuit for `key` (rule 6): acts only when the entry exists and
   * is half-open — the entry is deleted (counter reset by deletion, preference
   * fully restored). A completion observed while the route is actively
   * suppressed, or with no entry, is a no-op: a stale in-flight success must
   * not cancel a fresher escalated re-suppression.
   */
  close(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined || !entry.halfOpen) return
    this.entries.delete(key)
  }

  /**
   * The in-progress half-open episodes, in insertion order (display path —
   * plan P4). `untilEpochMs` is the lapsed expiry epoch that drives the
   * `/fallbacks` marker row.
   */
  halfOpenEntries(): Array<{ key: string; untilEpochMs: number }> {
    const out: Array<{ key: string; untilEpochMs: number }> = []
    for (const [key, entry] of this.entries) {
      if (entry.halfOpen && entry.expiredUntil !== undefined) {
        out.push({ key, untilEpochMs: entry.expiredUntil })
      }
    }
    return out
  }
}
