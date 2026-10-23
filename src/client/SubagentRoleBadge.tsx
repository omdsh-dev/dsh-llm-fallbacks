/**
 * Session-header subagent role/model badge (plan subagent-role-badge T3 +
 * plan subagent-role-model): a compact read-only pill in
 * `conversation.session.header.actions` showing the viewed CHILD session's
 * dispatch role and the model route it runs on, hovering as
 * `role → provider/model (request route)`.
 *
 * Contract notes (re-verified 2026-10-23 against the installed dsh 0.2.1-rc.2):
 * - The slot is `kind: 'list'`, `scope: 'session'`, owner props an empty marker
 *   (`ConversationHeaderActionOwnerProps`, `children?: never`) — the header
 *   renders occupants with `renderSlot(..., {})`, so ALL data flows through the
 *   session standard kit.
 * - Every `scope: 'session'` occupant receives the session standard kit, whose
 *   members this component uses are `sessionId`, `useSessions` (the shared
 *   Session store) and `useProjection` (the viewed session's projection cut).
 *   The compiled peer types do not carry that merge into this plugin's
 *   typecheck program (ui-session is deliberately not a plugin peer), so the
 *   seats are read STRUCTURALLY and guarded — a version-skewed host without them
 *   renders nothing, never throws.
 * - The badge belongs to a CHILD session: `byId[sessionId].origin === 'subagent'`
 *   is the host's own child-session idiom (`dsh-client-ui-subagent`
 *   `SubagentCatalogAction`). Root rows omit `origin`, so a root session renders
 *   nothing even though its own `modelSelection` carries a route — the composer
 *   owns that control.
 * - Role data: the host's `fallbacksSubagentRole` projection (Task 3b), folded
 *   server-side out of the child's own durable log — the ONE role source. The
 *   session kit binds the hook to the VIEWED session, so no `sessionId`
 *   plumbing, no effect, no state, and no polling. An absent key (host without
 *   the unit, or no notice row) omits the role half; `inherit` omits it too.
 * - Route data: the host's EXISTING `modelSelection` projection, read as
 *   `next ?? lastUsed` — the route the child's next request will use, falling
 *   back to the one its latest recorded request ran on. The two halves are
 *   INDEPENDENT: either alone still renders, and both missing renders nothing.
 * - Hook order is render-independent (Task 3b L2 review C-1): the seats are real
 *   hooks, so the three reads are unconditional and only their derived values
 *   are guarded — a conditional read would change the hook count on the very
 *   re-render that publishes a running child's role.
 * - Render-only discipline (C4 pattern, same as `ConversationFallbackSwitch`):
 *   the badge contributes a view; no message construction, no model-context
 *   injection. Degrade-never-crash: a missing/foreign projection value renders
 *   `null` — the actions row collapses cleanly.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the conversation header slot-contract merge (the
// `conversation.session.header.actions` entry — this file's registration
// target and props key). Same empty type-only pattern as the other
// conversation merges in index.ts.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { INHERIT_ROLE_ID } from '../config.ts'
import { ROLE_PROJECTION_KEY, readRoleProjectionValue } from '../role-projection-key.ts'
import css from './SubagentRoleBadge.module.css'

/**
 * The host's own durable model-selection projection key (`dsh-api-session-
 * controller`, merged into `SessionProjectionMap`): its client value carries
 * `next` (the route the next request will use) and `lastUsed` (the route the
 * latest recorded request ran on). Read through the same structural seat as the
 * role key.
 */
const MODEL_SELECTION_PROJECTION_KEY = 'modelSelection'

/** The keyed-hook seat the session kit binds: `useProjection(key) → value | undefined`. */
type ProjectionReader = (key: string) => unknown

/** Props delivered by the actions slot outlet: runtime share + locale seat. */
export type SubagentRoleBadgeProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'fallbacks'>

/**
 * `provider/model` of one model selection, or `undefined` when the value's
 * fields are absent or foreign.
 */
function selectionRoute(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  // Trim the wire values here; the role id is kept verbatim by contract
  // (`role-projection-key.ts`, docs/consumer-api.md).
  const trimmedProvider = provider.trim()
  const trimmedModel = model.trim()
  if (trimmedProvider === '' || trimmedModel === '') return undefined
  // Never capped: the pill BODY truncates for display, the title keeps this whole.
  return `${trimmedProvider}/${trimmedModel}`
}

/** Display form of a route in the pill body; the title keeps the full route. */
function displayRoute(route: string): string {
  // shortcut: fixed 120-char display cap (ellipsis included); widen if real ids outgrow it.
  return route.length > 120 ? `${route.slice(0, 119)}…` : route
}

/**
 * `provider/model` the child's NEXT request will use, falling back to the route
 * its latest recorded request ran on (`modelSelection.next` → `lastUsed`), or
 * `undefined` when neither carries a route — the badge then renders the role
 * alone instead of a wrong route.
 */
function modelSelectionRoute(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { next, lastUsed } = value as { next?: unknown; lastUsed?: unknown }
  return selectionRoute(next) ?? selectionRoute(lastUsed)
}

/** The keyed store hook the host binds for `scope: 'session'` slots. */
type SessionsHook = <T>(
  selector: (state: { byId?: Record<string, { origin?: string } | undefined> }) => T,
) => T

/**
 * Render the viewed SUBAGENT session's role and model.
 * @param props - composed slot props (the session-kit `useProjection` /
 *   `useSessions` seats are read structurally — see the module docblock).
 * @returns the badge element, or `null` when there is nothing to show.
 */
export function SubagentRoleBadge(props: SubagentRoleBadgeProps): ReactNode {
  const { t } = props
  // Session standard kit seats (see docblock): runtime-guaranteed for
  // `scope: 'session'` slots, absent from this program's peer types — read
  // structurally and guarded. The seats are capabilities of the HOST
  // composition, never render-varying state, so their presence (and therefore
  // the hook order) is constant for every render of this component; a seat-less
  // host renders nothing and calls no hook at all.
  const readProjection: ProjectionReader | undefined = (
    props as { useProjection?: ProjectionReader }
  ).useProjection
  const useSessions: SessionsHook | undefined = (props as { useSessions?: SessionsHook }).useSessions
  const sessionId = (props as { sessionId?: unknown }).sessionId
  if (typeof readProjection !== 'function' || typeof useSessions !== 'function') return null
  if (typeof sessionId !== 'string') return null

  // A root session has its own composer model control and no dispatch role:
  // this badge is the CHILD session's identity, shown when the child is opened.
  const isChild = useSessions((state) => state.byId?.[sessionId]?.origin === 'subagent')

  // BOTH seats are read UNCONDITIONALLY, in a fixed order, on every render —
  // `useProjection` is a real hook (`keyedObservableHook` → `observableHook` →
  // `useSyncExternalStore`, one hook per call), so a read that depends on THIS
  // render's value would change the hook count across renders and React would
  // throw ("Rendered more hooks than during the previous render") on exactly the
  // path this badge exists for: a running child whose `fallbacksSubagentRole`
  // value appears when the notice row lands. Only the DERIVED values are
  // guarded below.
  const rawRole = readProjection(ROLE_PROJECTION_KEY)
  const rawModelSelection = readProjection(MODEL_SELECTION_PROJECTION_KEY)

  if (!isChild) return null

  // The role id the host folded out of this session's own log; only a non-blank
  // string is a role, and `inherit` means the child runs the parent's role.
  const declared = readRoleProjectionValue(rawRole)
  const role = declared === INHERIT_ROLE_ID ? undefined : declared
  // Route is a SECOND, independent fact: either one alone still renders.
  const model = modelSelectionRoute(rawModelSelection)
  if (role === undefined && model === undefined) return null

  const title = role !== undefined && model !== undefined
    ? t('subagentRole.hover', { role, model })
    : role ?? model
  return (
    <span className={css.badge} title={title}>
      {role}
      {role !== undefined && model !== undefined && ' · '}
      {model !== undefined && <span className={css.route}>{displayRoute(model)}</span>}
    </span>
  )
}
