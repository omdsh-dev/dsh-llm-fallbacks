/**
 * Node-safe test double for the published `@deepseek-ai/dsh-client-runtime`
 * `./client` entry. The published package ships `./client` only as a browser
 * loader artifact (`window.__ModuleLoader__.load(...)` — not an importable
 * module), so dev-time tests resolve the one VALUE import the client store
 * makes (`createSnapshotStore`) here instead of a dsh source tree (the former
 * link farm). Mirrors the SnapshotStore API the client store uses:
 * `getSnapshot` / `subscribe` / `update` / `set`.
 */

export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  update(recipe: (draft: T) => void): void
  set(value: T): void
}

export function createSnapshotStore<T>(init: T, _opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } }): SnapshotStore<T> {
  let state: T = init
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update: (recipe) => {
      const draft = structuredClone(state) as T
      recipe(draft)
      state = draft
      emit()
    },
    set: (value) => {
      state = value
      emit()
    },
  }
}
