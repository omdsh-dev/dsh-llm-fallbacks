/**
 * Let pending microtasks/macrotasks settle (negative-assertion window): a 50
 * ms macrotask boundary that gives deferred inject children their activation
 * window. Shared by the service / presets-integration / seeds-declare-window
 * specs (behavior-identical hoist of the former per-file copies — qc1 S-007).
 */
export function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 50)
  return promise
}
