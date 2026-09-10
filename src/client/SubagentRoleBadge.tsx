/**
 * Session-header subagent role badge (plan subagent-role-badge T3; durable
 * channel plan role-based-subagent-adoption Task 3b): a compact read-only pill
 * in `conversation.session.header.utilities` showing which Subagent role the
 * viewed session's dispatch resolved, hovering as `role → latest request route`.
 *
 * Contract notes (verified 2026-09-09 against the harness checkout):
 * - The slot is `kind: 'list'`, `scope: 'session'`, owner props an empty marker
 *   (`ConversationHeaderActionOwnerProps`, `children?: never`) — the header
 *   renders occupants with `renderSlot(..., {})`, so ALL data flows through the
 *   session standard kit.
 * - Every `scope: 'session'` occupant receives the session standard kit
 *   (`useSession` + `useProjection`; ui-session `src/client/index.ts:112-119`,
 *   merged into the runtime share by ui-slots' `PropsRuntime`). The compiled
 *   peer types do not carry that merge into this plugin's typecheck program
 *   (ui-session is deliberately not a plugin peer), so both seats are read
 *   STRUCTURALLY and guarded — a version-skewed host without them renders
 *   nothing, never throws.
 * - Data: the host's `fallbacksSubagentRole` projection (Task 3b), folded
 *   server-side out of the child's own durable log — the ONE role source. The
 *   session kit binds the hook to the VIEWED session (`binding.session.
 *   projections.faceOf(key)`), so no `sessionId` plumbing, no effect, no state,
 *   and no polling: a settled child's follow opening snapshot already carries
 *   the value, and a running child's change frame updates the pill. An absent
 *   key (host without the unit, or no notice row) reads as "no pill".
 * - The hover route comes from the host's EXISTING `modelSelection` projection
 *   (`lastUsed` — the route of the LATEST recorded request), NOT from the
 *   dispatch-time route: it is a separate, richer fact, and the label says so.
 * - Render-only discipline (C4 pattern, same as `ConversationFallbackSwitch`):
 *   the badge contributes a view; no message construction, no model-context
 *   injection. Degrade-never-crash: a missing/foreign projection value or an
 *   `inherit` role renders `null` — the utilities strip collapses cleanly.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the conversation header slot-contract merge (the
// `conversation.session.header.utilities` entry — this file's registration
// target and props key). Same empty type-only pattern as the other
// conversation merges in index.ts.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { INHERIT_ROLE_ID } from '../config.ts'
import { ROLE_PROJECTION_KEY, readRoleProjectionValue } from '../role-projection-key.ts'
import css from './SubagentRoleBadge.module.css'

/**
 * The host's own durable model-selection projection key (`dsh-api-session-
 * controller`, merged into `SessionProjectionMap`): its client value carries
 * `lastUsed` — the route the LATEST recorded request ran on. Read through the
 * same structural seat as the role key.
 */
const MODEL_SELECTION_PROJECTION_KEY = 'modelSelection'

/** The keyed-hook seat the session kit binds: `useProjection(key) → value | undefined`. */
type ProjectionReader = (key: string) => unknown

/** Props delivered by the utilities slot outlet: runtime share + locale seat. */
export type SubagentRoleBadgeProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'fallbacks'>

/**
 * `provider/model` of the model-selection projection's `lastUsed`, or
 * `undefined` when the value/key/fields are absent or foreign — the badge then
 * hovers the role alone instead of rendering a wrong route.
 */
function latestRequestRoute(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { lastUsed } = value as { lastUsed?: unknown }
  if (typeof lastUsed !== 'object' || lastUsed === null) return undefined
  const { provider, model } = lastUsed as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return `${provider}/${model}`
}

/**
 * Render the viewed session's dispatch-resolved role badge.
 * @param props - composed slot props (the session-kit `useProjection` seat is
 *   read structurally — see the module docblock).
 * @returns the badge element, or `null` when there is nothing to show.
 */
export function SubagentRoleBadge(props: SubagentRoleBadgeProps): ReactNode {
  const { t } = props
  // Session standard kit seat (see docblock): runtime-guaranteed for
  // `scope: 'session'` slots, absent from this program's peer types — read
  // structurally and guarded. The seat is a capability of the HOST composition,
  // never render-varying state, so its presence (and therefore the hook order)
  // is constant for every render of this component; a seat-less host renders
  // nothing and calls no hook at all.
  const readProjection: ProjectionReader | undefined = (
    props as { useProjection?: ProjectionReader }
  ).useProjection
  if (typeof readProjection !== 'function') return null

  // The role id the host folded out of this session's own log; only a non-blank
  // string is a role (a foreign value, a missing key and `null` all read as
  // "no pill").
  const role = readRoleProjectionValue(readProjection(ROLE_PROJECTION_KEY))
  if (role === undefined || role === INHERIT_ROLE_ID) return null

  // Route is a SECOND, best-effort fact: absent → the pill still shows the role.
  const model = latestRequestRoute(readProjection(MODEL_SELECTION_PROJECTION_KEY))
  return (
    <span
      className={css.badge}
      title={model === undefined ? role : t('subagentRole.hover', { role, model })}
    >
      {role}
    </span>
  )
}
