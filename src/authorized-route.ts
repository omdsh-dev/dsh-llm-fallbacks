/**
 * Authorized-route detection from durable child state (plan
 * dsh-012-subagent-routing T2; spec D2).
 *
 * Pure, host-free module: a plain-data session view in, one route out. The
 * wiring captures the view at a subagent's first request from the detection
 * sources the plan names (shapes verified against upstream
 * `packages/subagent/subagent/src/child-agent.ts:68-85` and
 * `packages/api/session-controller/src/types.ts:284`):
 *
 * - the session's `model/selection` log entries (plain descriptors; payload
 *   is the `ModelSelection` shape — provider, model, optional
 *   reasoningEffort), an explicit host-recorded selection for this session;
 * - the durable `request/header` config fold (`requestHeader()?.config`);
 * - the resolved creation options (`agent.options`) as the pre-first-request
 *   fallback — upstream precedence: the durable header wins, options
 *   fallback (`parentAgentOptionsForDelegation`);
 * - the pure-inheritance baseline: the delegating parent's current route,
 *   resolved by the wiring the same way (`requestHeader()?.config` else
 *   creation options).
 *
 * A source yields a route only when BOTH provider and model are present
 * non-empty strings — an effort alone is not a route (spec Terms). A
 * `model/selection` entry is definitionally an explicit selection, so it is
 * authorized as-is. A route read from the header or the creation options is
 * explicit only when it is NOT the pure-inheritance continuation: when the
 * baseline is provable (complete) and equals the candidate exactly, the
 * candidate is the parent's inherited route, not a selection — pure
 * inheritance is NOT an authorized route (spec Terms; upstream
 * `resolveChildAgentOptions` materializes the parent route into child
 * options even without an explicit selection, so equality with the baseline
 * is the only child-side inheritance signal). With the baseline unprovable
 * the candidate stands: D2 keeps authorized chain heads unoverwritten, and
 * the allowlist-constrained inject below this decision holds D1 either way.
 *
 * Never throws; malformed source shapes yield `undefined`, not routes.
 *
 * @module dsh-llm-fallbacks/authorized-route
 */

import type { PolicyRoute } from './subagent-policy.ts'

/** One plain route-bearing source shape (header config, options, selection payload, baseline). */
export type RouteSource = {
  readonly provider?: unknown
  readonly model?: unknown
  readonly reasoningEffort?: unknown
}

/** Structural session view consumed by {@link detectAuthorizedRoute} — plain data only, no live host objects. */
export interface AuthorizedRouteSession {
  /** Durable request-header config fold captured from the child session (absent before the first logged header). */
  readonly requestHeader?: RouteSource | undefined
  /** Plain event descriptors (`type` + optional `data`) captured from the child session's log. */
  readonly events?: readonly { readonly type: string; readonly data?: unknown }[] | undefined
  /** Resolved creation options captured from the agent (pre-first-request fallback). */
  readonly options?: RouteSource | undefined
  /** Pure-inheritance baseline: the delegating parent's current route (absent when unprovable). */
  readonly inherited?: RouteSource | undefined
}

/**
 * The explicit route carried by one source, or `undefined`: both provider and
 * model must be present non-empty strings — an effort alone is not a route.
 */
function completeRoute(source: RouteSource | undefined): PolicyRoute | undefined {
  if (
    typeof source !== 'object' || source === null
    || typeof source.provider !== 'string' || source.provider.length === 0
    || typeof source.model !== 'string' || source.model.length === 0
  ) {
    return undefined
  }
  return { provider: source.provider, model: source.model }
}

/**
 * The latest explicit `model/selection` route in the captured log, or
 * `undefined`. Scanned backwards — the latest selection wins, mirroring the
 * durable selection fold; malformed entries are skipped, never thrown.
 */
function lastModelSelection(entries: AuthorizedRouteSession['events']): PolicyRoute | undefined {
  if (entries === undefined) return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]
    if (candidate?.type !== 'model/selection') continue
    const route = completeRoute(candidate.data as RouteSource | undefined)
    if (route !== undefined) return route
  }
  return undefined
}

/**
 * Detect the subagent's explicit authorized route at its first request, or
 * `undefined` for pure inheritance (semantics in the module doc). The wiring
 * skips role-inject on a defined result — the authorized route is the chain
 * head (spec D2) — and runs the allowlist-constrained three-stage inject on
 * `undefined`.
 */
export function detectAuthorizedRoute(session: AuthorizedRouteSession): PolicyRoute | undefined {
  const { events, requestHeader, options, inherited } = session
  const selected = lastModelSelection(events)
  if (selected !== undefined) return selected
  const route = completeRoute(requestHeader) ?? completeRoute(options)
  if (route === undefined) return undefined
  const baseline = completeRoute(inherited)
  if (baseline !== undefined && route.provider === baseline.provider && route.model === baseline.model) {
    return undefined
  }
  return route
}
