/**
 * Cooldown store + per-step failure set (spec §5.1; plan Task 2).
 *
 * `CooldownStore` maps `provider/model` keys to an expiry epoch ms with lazy
 * evaluation: expired entries are dropped on read. `revertPolicy: 'never'`
 * is expressed by suppressing with `Infinity` — the entry never expires
 * within the session.
 *
 * `StepFailureSet` is the step's failed-model set (spec §5.1 `failed`).
 * `switchCount` / `maxSwitchesPerStep` judgement belongs to the caller
 * (Task 3) — this task only provides the data structure.
 *
 * @module dsh-llm-fallbacks/cooldown
 */

/**
 * Per-agent model cooldown: `suppress(key, untilEpochMs)` then
 * `isSuppressed(key, now?)` with lazy expiry.
 */
export class CooldownStore {
  private entries = new Map<string, number>()

  /** Number of tracked keys (expired entries are dropped lazily on read). */
  get size(): number {
    return this.entries.size
  }

  /** Suppress `key` until `untilEpochMs` (use `Infinity` for `revertPolicy: 'never'`). */
  suppress(key: string, untilEpochMs: number): void {
    this.entries.set(key, untilEpochMs)
  }

  /** True while `key` is suppressed at time `now` (default `Date.now()`); expired entries are removed. */
  isSuppressed(key: string, now: number = Date.now()): boolean {
    const until = this.entries.get(key)
    if (until === undefined) return false
    if (until <= now) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  /**
   * Read-only snapshot of the active (non-expired) entries, insertion order.
   * Expired entries are dropped lazily on read (same semantics as
   * {@link isSuppressed}); `Infinity` entries are always active. Consumed by
   * the `/fallbacks` command's cooldown display — never mutates state.
   */
  snapshot(now: number = Date.now()): Array<{ key: string; untilEpochMs: number }> {
    const active: Array<{ key: string; untilEpochMs: number }> = []
    for (const [key, until] of this.entries) {
      if (until <= now) {
        this.entries.delete(key)
        continue
      }
      active.push({ key, untilEpochMs: until })
    }
    return active
  }
}

/**
 * The current step's failed-model set (`${provider}/${model}` keys).
 */
export class StepFailureSet {
  private keys = new Set<string>()

  get size(): number {
    return this.keys.size
  }

  add(key: string): void {
    this.keys.add(key)
  }

  has(key: string): boolean {
    return this.keys.has(key)
  }

  reset(): void {
    this.keys.clear()
  }
}
