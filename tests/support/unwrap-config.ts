/**
 * Unwrap a live config reference: schemastery ≥3.18.4 resolves the plugin's
 * volatile-marked section schema into a stable reference whose `get()` hands
 * out the current immutable snapshot (the 0.1.7-rc.2 host contract — the
 * dsh-settings Loader commits form saves into the reference). The runtime
 * unwrap lives in `normalizeConfig` (src/index.ts); the specs that consume
 * `Config(...)` results directly use this mirror. A no-op on a plain object
 * (the shape the pre-3.18.4 dev-time schemastery resolutions produce).
 */
export function unwrapConfig<T>(value: T | { get(): T }): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}
