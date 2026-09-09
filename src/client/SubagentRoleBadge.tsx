/**
 * Session-header subagent role badge (plan subagent-role-badge T3): a
 * compact read-only pill in `conversation.session.header.utilities` showing
 * which Subagent role the viewed session's dispatch resolved, hovering as
 * `role → provider/model`.
 *
 * Contract notes (verified 2026-09-09 against the harness checkout):
 * - The slot is `kind: 'list'`, `scope: 'session'`, owner props an empty
 *   marker (`ConversationHeaderActionOwnerProps`, `children?: never`) — the
 *   header renders occupants with `renderSlot(..., {})`, so ALL data flows
 *   through this component's inject face and the session standard kit.
 * - Every `scope: 'session'` occupant receives the session standard kit
 *   (`sessionId` + `useSession` + `useProjection`; ui-session
 *   `src/client/index.ts:112-119`, merged into the runtime share by ui-slots'
 *   `PropsRuntime`) — the fetch keys off the `sessionId` prop directly (mount
 *   + whenever the prop changes; the slot machinery remounts the occupant per
 *   viewed session — no manual session subscription). The compiled peer types
 *   do not carry the ui-session standard-props merge into this plugin's
 *   typecheck program (that package is deliberately not a plugin peer), so
 *   the seat is read structurally and guarded — a version-skewed host without
 *   it renders nothing, never throws.
 * - Data: `fallbacks/subagent-roles` gateway readbacks via the injected fetch
 *   face ({@link fetchSubagentRoleRecord} — never throws): one on mount +
 *   whenever the viewed session changes, then a BOUNDED delayed re-probe
 *   while no record has landed (the record is written at the subagent's first
 *   dispatch request, which can land after this header mounted).
 * - Render-only discipline (C4 pattern, same as `ConversationFallbackSwitch`):
 *   the badge contributes a view; no message construction, no model-context
 *   injection. Degrade-never-crash: a missing record, an `inherit` role, or
 *   ANY readback error renders `null` — the utilities strip collapses cleanly.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the conversation header slot-contract merge (the
// `conversation.session.header.utilities` entry — this file's registration
// target and props key). Same empty type-only pattern as the other
// conversation merges in index.ts.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { INHERIT_ROLE_ID } from '../config.ts'
import type { FallbacksSettingsController, SubagentRoleView } from './fallbacks-store.ts'
import css from './SubagentRoleBadge.module.css'

/**
 * Injected dependencies of {@link SubagentRoleBadge} (slot `inject`): the
 * shared controller, the same seam the settings card and the General row use.
 * The badge reads through {@link FallbacksSettingsController.fetchSubagentRole}
 * — the controller's rpc face (the same `/api` caller the store rides); no
 * second channel, no extra inject member.
 */
export interface SubagentRoleBadgeInjected {
  /** The shared controller (its `fetchSubagentRole` rides the gateway channel). */
  controller: FallbacksSettingsController
}

/** Props delivered by the utilities slot outlet: runtime share + locale seat + inject face. */
export type SubagentRoleBadgeProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'fallbacks'> & SubagentRoleBadgeInjected

/**
 * Bounded delayed re-probe (QC fix wave F-001): while the viewed session has
 * no record yet, re-fetch up to {@link ROLE_RECORD_PROBES} times
 * {@link ROLE_RECORD_PROBE_DELAY_MS} apart (~10s window) and stop on the
 * first record, a session switch, or unmount. The record is written once, at
 * the subagent's FIRST dispatch request — a header opened before that moment
 * would otherwise never see the badge until remount.
 */
const ROLE_RECORD_PROBE_DELAY_MS = 2_000
const ROLE_RECORD_PROBES = 5

/**
 * Render the viewed session's dispatch-resolved role badge.
 * @param props - composed slot props (the `sessionId` session-kit seat is
 *   read structurally — see the module docblock).
 * @returns the badge element, or `null` when there is nothing to show.
 */
export function SubagentRoleBadge(props: SubagentRoleBadgeProps): ReactNode {
  const { t, controller } = props
  // Session standard kit seat (see docblock): runtime-guaranteed for
  // `scope: 'session'` slots, absent from this program's peer types — read
  // structurally, guard, degrade.
  const seatSessionId: unknown = (props as { sessionId?: unknown }).sessionId
  const sessionId = typeof seatSessionId === 'string' && seatSessionId !== '' ? seatSessionId : undefined
  // The record is session-STAMPED and reset DURING RENDER when `sessionId`
  // changes (QC fix wave F-002): a reset that only ran in the effect executed
  // post-paint, leaving a one-paint window where a session switch could show
  // the previous session's badge. The render-time adjustment re-renders with
  // the reset state before anything commits — no frame ever paints a foreign
  // session's record, regardless of host remount semantics.
  const [stamped, setStamped] = useState<{ sessionId: string | undefined; record: SubagentRoleView | undefined }>({
    sessionId,
    record: undefined,
  })
  if (stamped.sessionId !== sessionId) {
    setStamped({ sessionId, record: undefined })
  }
  const record = stamped.sessionId === sessionId ? stamped.record : undefined

  // Fetch on mount + whenever the viewed session changes; while the record
  // has not landed yet (empty readback), re-probe a bounded number of times
  // with a short delay (see the probe constants) — the cancellation latch and
  // the pending-timer clear drop every in-flight probe on a switch/unmount,
  // and finding a record stops the probing.
  useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = (attempt: number): void => {
      void controller.fetchSubagentRole(sessionId).then((next) => {
        if (cancelled) return
        if (next !== undefined) {
          setStamped({ sessionId, record: next })
          return
        }
        if (attempt >= ROLE_RECORD_PROBES) return
        timer = setTimeout(() => {
          timer = undefined
          probe(attempt + 1)
        }, ROLE_RECORD_PROBE_DELAY_MS)
      })
    }
    probe(0)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [controller, sessionId])

  // Degrade-never-crash: no record (absent id seat, no record for this
  // session, readback error, channel down) → nothing. `inherit` means "no
  // specific role" — never badge it (defense in depth: the writer never
  // records `inherit`, so a wire record claiming it is skew).
  if (record === undefined || record.role === INHERIT_ROLE_ID) return null
  const model = record.model === undefined ? undefined : `${record.model.provider}/${record.model.model}`
  return (
    <span
      className={css.badge}
      title={model === undefined ? record.role : t('subagentRole.hover', { role: record.role, model })}
    >
      {record.role}
    </span>
  )
}
