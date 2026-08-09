/**
 * Instrumented double for the `@deepseek-ai/dsh-client-runtime/client` runtime
 * seam (vitest `resolve.alias`, see `vitest.config.ts` and
 * pm-note-type-access.md).
 *
 * The client half consumes exactly one runtime VALUE export:
 * `createSnapshotStore` (the store engine the fallbacks controller's snapshot
 * rides). This double mirrors the `SnapshotStore` contract (getSnapshot /
 * subscribe / update / set); notifications are synchronous (the real engine
 * microtask-batches — tests read the snapshot after awaiting the controller
 * call, so the difference is invisible).
 */
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

export type { ObservableSnapshot, SnapshotStore }

/** Minimal snapshot store: immer-free draft updates over a JSON clone. */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update: (mutator) => {
      const next = JSON.parse(JSON.stringify(state)) as T
      mutator(next)
      state = next
      for (const fn of [...listeners]) fn()
    },
    set: (next) => {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}
