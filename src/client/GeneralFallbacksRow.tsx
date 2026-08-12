/**
 * Fallbacks status row — the `fallbacks` read-only row on the dsh General
 * settings page (plan fallbacks-aux-seams, task 1). Registered into the
 * `settings.general.item` slot (id `fallbacks`, order 100 — after every
 * upstream preference row: agent-preset -25 / permission -20 / language 0 /
 * appearance 10 / composer-enter 20, so the informational row renders at the
 * column end). Owner props are intentionally empty (`children?: never`,
 * dsh-private ui-settings slots.ts:81-84 — the section column only stacks),
 * so all data flows through the shared {@link FallbacksSettingsController}
 * (the same instance the plugin-config card consumes): the row triggers the
 * first read on mount when the store is still idle, and the pushed
 * invalidations wired in `apply` (`settings/document-updated` fallbacks-ns +
 * `connection/reset`, which refresh only already-read stores) keep it fresh
 * afterwards — no new data path, no store API change.
 *
 * The row is read-only by design (偏好位语义: a General preference row is not
 * a control surface): an enabled badge + a compact last-switch summary.
 * Honest degraded states: a hard load error or an unreachable gateway
 * channel (`ready && !present`) render the neutral 'unknown' badge — a
 * channel-down read must never masquerade as 'disabled' (KD-G5); the
 * switches face keeps its own error/empty states (D-5 semantics unchanged).
 *
 * Geometry follows the upstream Setting-Cell (figma 501:30011 — gap 8,
 * pad 16/0, hairline separator, title over subtitle in the text column, a
 * small non-interactive pill on the right); every color resolves through a
 * `--dsw-alias-*` token (light/dark adaptive).
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
// Type-only: the `settings.general.item` SlotMap entry (owner props empty)
// — same empty type-only import pattern as the registration in index.ts.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  FallbacksSettingsController, FallbacksSettingsState,
} from './fallbacks-store.ts'
import { SWITCH_REASON_KEYS } from './locales.ts'
import css from './GeneralFallbacksRow.module.css'

/** Injected dependencies of {@link GeneralFallbacksRow} (slot `inject`). */
export interface GeneralFallbacksRowInjected {
  /** The shared controller (loaded on first mount, refreshed on pushed invalidations). */
  controller: FallbacksSettingsController
  /** uSES subscription hook bound to the store (inject face — advisor pattern). */
  useSnapshot: SnapshotSelectorHook<FallbacksSettingsState>
}

/** Props delivered by the slot outlet: runtime share + locale seat + inject face. */
export type GeneralFallbacksRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'fallbacks'> & GeneralFallbacksRowInjected

/**
 * Render the Fallbacks status row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function GeneralFallbacksRow({ controller, useSnapshot, t }: GeneralFallbacksRowProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  // Lazy first read: the store starts 'idle' and pushed invalidations only
  // refresh an already-read store (`refresh*IfLoaded` skips 'idle'), so the
  // row pulls the descriptor + recent-switch summary itself on mount when
  // the plugin-config card has never opened. `controller` is the stable
  // slot-injected singleton, so this fires once per mount; each side keeps
  // its own idle guard (no retry loop on persistent errors).
  useEffect(() => {
    const snapshot = controller.store.getSnapshot()
    if (snapshot.status === 'idle') void controller.load()
    if (snapshot.switchesStatus === 'idle') void controller.loadSwitches()
  }, [controller])

  // The enabled badge: only a settled `ready` read with a resolved gateway
  // channel (`present`) states the real enabled flag; anything else — a
  // hard load error, an unreachable channel, or a not-yet-settled read —
  // renders the neutral 'unknown' badge (KD-G5 honesty).
  const settled = state.status === 'ready'
  const badgeKey = settled && state.present
    ? (state.config.enabled ? 'general.enabled' : 'general.disabled')
    : 'general.unknown'

  // The compact summary line: the most recent switch (from → to + role/
  // reason) or an honest empty/loading/error state — one line, mirroring
  // the card's status block derivation (S-c reason map shared).
  const latestSwitch = state.switches[0]
  let summary: string
  if (state.status === 'error') {
    summary = t('general.error', { message: state.error ?? '' })
  } else if (!settled) {
    summary = t('loading')
  } else if (!state.present) {
    summary = t('general.unavailable')
  } else if (state.switchesStatus === 'error') {
    summary = t('status.switches.error', { message: state.switchesError ?? '' })
  } else if (state.switchesStatus === 'loading') {
    summary = t('loading')
  } else if (latestSwitch === undefined) {
    summary = t('general.switch.empty')
  } else {
    const reasonKey = SWITCH_REASON_KEYS[latestSwitch.reason]
    summary = t('general.switch', {
      from: `${latestSwitch.from.provider}/${latestSwitch.from.model}`,
      to: `${latestSwitch.to.provider}/${latestSwitch.to.model}`,
      role: latestSwitch.role,
      reason: reasonKey === undefined ? latestSwitch.reason : t(reasonKey),
    })
  }

  const alert = state.status === 'error' || state.switchesStatus === 'error'
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('general.title')}</div>
        <div className={css.summary} role={alert ? 'alert' : undefined}>{summary}</div>
      </div>
      <span className={`${css.badge} ${badgeKey === 'general.enabled' ? css.badgeEnabled : ''}`}>
        {t(badgeKey)}
      </span>
    </div>
  )
}
