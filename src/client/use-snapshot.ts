/**
 * uSES bridge: turns a bare observable snapshot source into a typed selector
 * hook. Client-side-rendered only, so no server snapshot is wired.
 *
 * This is the ONE hook constructor in the plugin's client stack — engines and
 * hosts traffic in bare sources; binding happens on the React side.
 *
 * rc.8 migration: upstream `@deepseek-ai/dsh-client-web-react` (which exported
 * this exact implementation) was deleted in dsh 0.1.0-rc.8; its
 * `bindSnapshotSelector` moved into `@deepseek-ai/dsh-client-ui-renderer` as a
 * module-private helper (not part of the published export surface), and
 * `SnapshotSelectorHook` now ships from `@deepseek-ai/dsh-client-ui-slots`.
 * The plugin vendors the same uSES bridge it consumed in rc.7 so the
 * snapshot-selector contract (selector + optional equality) is preserved
 * verbatim without importing from a package that no longer exposes it.
 *
 * @module dsh-llm-fallbacks/use-snapshot
 */
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind a bare observable source to a typed uSES selector hook.
 * subscribe/getSnapshot are captured once per source into stable closures
 * (also re-binds `this` for method-based sources), so components never
 * resubscribe across renders. Equality defaults to Object.is.
 * @param w - snapshot source (engine store, Session object, store instance).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
  }
}
