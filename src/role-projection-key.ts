/**
 * The session-projection contract of the subagent role pill (plan
 * role-based-subagent-adoption Task 3b): the ONE key the host fold
 * (`./role-projection.ts`) publishes and the session-header badge reads.
 *
 * PURE module — no `@deepseek-ai/*` import, no host-only dependency — because
 * BOTH halves import it: the host through the seam's install point, the client
 * through `SubagentRoleBadge`. Splitting the key (and the value guard) out of
 * the host module is what keeps the client half free of the fold's host
 * imports, and a single shared literal is what keeps the two halves from
 * drifting into a silent "no pill".
 *
 * @module dsh-llm-fallbacks/role-projection-key
 */

/**
 * The projection key the role pill reads (`useProjection(ROLE_PROJECTION_KEY)`).
 * Lower-camel like the host's own session-scoped keys (`modelSelection`,
 * `sessionListMetadata`); the `fallbacks` prefix keeps a third-party key
 * unambiguous inside the shared `SessionProjectionMap`.
 */
export const ROLE_PROJECTION_KEY = 'fallbacksSubagentRole'

/**
 * The client-visible value of the role projection: the DECLARED RAW role id the
 * child was dispatched as (padding included — it is the id the settings
 * document declares), or `null` while the child's log carries no role notice
 * row (`./role-notice.ts`).
 *
 * A role id, NOT a record: the route is a SEPARATE host projection
 * (`modelSelection`), because the notice row is written once at the child's
 * first step while the route it ends up on can change afterwards.
 */
export type RoleProjectionValue = string | null

/**
 * Read a projection value defensively (degrade-never-crash): only a non-blank
 * string is a role. `undefined` — the key is not registered on this host, or no
 * baseline/frame has carried it yet — and every foreign value read as "no
 * role", so the pill collapses to nothing instead of naming something wrong.
 *
 * @param value - the raw `useProjection('<key>')` value.
 */
export function readRoleProjectionValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
