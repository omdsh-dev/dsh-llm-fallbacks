/**
 * Fallbacks settings section — the web settings GUI page for the `fallbacks`
 * namespace (spec §4). Registered into the `settings.section` slot (id
 * `fallbacks`, order 30 — after the Models section at 10); owner props are
 * empty and all data flows through {@link FallbacksSettingsController}.
 *
 * Rendering follows the settings-panel design language shared with the
 * Models / Agent-presets / General pages: primitives (`Button` / `Modal` /
 * `Icon*`) for actions and dialogs, capsule controls (h36 r18; h28 r14
 * dense), h32 r8 inputs with the `.selectInput` chevron, r12 cards on the
 * `bg-module-platform` fill, and `--dsw-alias-*` tokens throughout. The
 * reset-to-defaults confirmation is a `Modal` (the delete-confirm pattern of
 * the Models page) — no `window.confirm`.
 *
 * Form surface (spec §4 用户直观性): enumerable values render readable labels
 * (`RATE_LIMIT` → 限流（429）, `QUOTA` → 配额超限, `AUTH` → 权限/认证失败;
 * `cooldown-expiry` → 冷却到期后回主模型, `never` → 保持备用模型) and every
 * field shows its default value. Chains and role rules are row editors; any
 * trigger codes loaded from the descriptor that are not in the known set are
 * preserved on save.
 *
 * Read-only status block (AC-7 行为可见性): an effective-config summary plus
 * a placeholder for the recent-switch summary. The client half has no
 * session-event reading face wired for a root-scoped settings section
 * (runtime confirmation lands with T8) — nothing here invents an API.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import {
  Button, IconPlusOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FallbacksConfig, RevertPolicy } from '../config.ts'
import { defaultFallbacksConfig } from '../config.ts'
import {
  FallbacksSettingsController,
  chainsToRows,
  rowsToChains,
  rowsToRules,
  rulesToRows,
  type ChainRow,
  type RoleRuleRow,
} from './fallbacks-store.ts'
import {
  configSummary,
  KNOWN_TRIGGER_CODES,
  TRIGGER_CODE_LABELS,
  withTriggerCode,
} from './locales.ts'
import css from './FallbacksSection.module.css'

/** Injected dependencies of {@link FallbacksSection} (slot `inject`). */
export interface FallbacksSectionInjected {
  /** The section store (loaded on mount, refreshed on pushed invalidations). */
  controller: FallbacksSettingsController
}

/** Props delivered by the slot outlet: runtime share + locale seat + inject face. */
export type FallbacksSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'fallbacks'> & FallbacksSectionInjected

/** Scalar (non-row) fields of the form draft. */
interface FallbacksScalars {
  enabled: boolean
  triggerCodes: string[]
  defaultRole: string
  cooldownMs: number
  revertPolicy: RevertPolicy
  maxSwitchesPerStep: number
  alwaysModeRetryCap: number
}

/** Split scalars from the row editors (chains / role rules). */
function scalarsOf(config: FallbacksConfig): FallbacksScalars {
  return {
    enabled: config.enabled,
    triggerCodes: [...config.triggerCodes],
    defaultRole: config.roles.default,
    cooldownMs: config.cooldownMs,
    revertPolicy: config.revertPolicy,
    maxSwitchesPerStep: config.maxSwitchesPerStep,
    alwaysModeRetryCap: config.alwaysModeRetryCap,
  }
}

/** Assemble the full config the row editors + scalars describe. */
function assembleConfig(scalars: FallbacksScalars, chainRows: ChainRow[], ruleRows: RoleRuleRow[]): FallbacksConfig {
  return {
    enabled: scalars.enabled,
    triggerCodes: [...scalars.triggerCodes],
    chains: rowsToChains(chainRows),
    roles: { default: scalars.defaultRole, rules: rowsToRules(ruleRows) },
    cooldownMs: scalars.cooldownMs,
    revertPolicy: scalars.revertPolicy,
    maxSwitchesPerStep: scalars.maxSwitchesPerStep,
    alwaysModeRetryCap: scalars.alwaysModeRetryCap,
  }
}

/** Parse a number input, clamped to a non-negative integer. */
function parseCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? 0 : Math.max(0, parsed)
}

/**
 * Render the Fallbacks settings section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function FallbacksSection({ controller, t }: FallbacksSectionProps): ReactNode {
  const state = useSyncExternalStore(
    controller.store.subscribe,
    controller.store.getSnapshot,
    controller.store.getSnapshot,
  )

  // Initial load: the store starts 'idle' and pushed invalidations only
  // refresh an already-loaded store (`refreshFallbacksIfLoaded` skips
  // 'idle'), so the section must pull the descriptor itself on mount.
  // `controller` is the stable slot-injected singleton, so this fires once
  // per mount; the idle guard (not a status effect) avoids re-triggering on
  // later transitions (no retry loop on persistent errors).
  useEffect(() => {
    if (controller.store.getSnapshot().status === 'idle') {
      void controller.load()
    }
  }, [controller])

  // Editors seed from `defaultFallbacksConfig` on mount (readme-settings spec
  // §1.4-1): the skeleton is always visible — even before any descriptor
  // arrives (idle/loading) or when the namespace is missing (unavailable).
  // The mount seed is only a placeholder: `seededRevision` stays null until
  // the first ready descriptor, and every later ready (a refresh re-load)
  // re-seeds with server truth. Controls are not gated on `ready` — a missing
  // namespace with `writable: true` leaves the switch/form body editable
  // pre-ready (§1.4-4) — so a mid-edit push (host registers the namespace →
  // settings/changed → refresh → load → ready) overwrites the draft with
  // server truth on the next ready: unsaved drafts are not preserved across
  // the unavailable→ready upgrade.
  const [scalars, setScalars] = useState<FallbacksScalars>(() => scalarsOf(defaultFallbacksConfig))
  const [chainRows, setChainRows] = useState<ChainRow[]>(() => chainsToRows(defaultFallbacksConfig.chains))
  const [ruleRows, setRuleRows] = useState<RoleRuleRow[]>(() => rulesToRows(defaultFallbacksConfig.roles.rules))
  const seededRevision = useRef<number | null>(null)

  useEffect(() => {
    if (state.status !== 'ready') return
    if (seededRevision.current === state.revision) return
    seededRevision.current = state.revision
    setScalars(scalarsOf(state.config))
    setChainRows(chainsToRows(state.config.chains))
    setRuleRows(rulesToRows(state.config.roles.rules))
  }, [state.status, state.revision, state.config])

  // Reset-to-defaults confirmation (replaces `window.confirm`): the dialog
  // stays open while the replace is in flight — the Models page's
  // delete-confirm pattern. The store's `saving` state also disables the
  // page actions, so a regular save and a reset cannot overlap.
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  // The skeleton always renders (readme-settings spec §1.2): title, intro,
  // banners, the read-only status block, the `enabled` switch, and the
  // save/reset actions are visible in every store state (idle / loading /
  // ready / saving / unavailable / error). The form body below is gated on
  // the draft's `enabled` flag. Controls are disabled while `writable` is
  // false (initial load, loading, or a read-only describe response), so an
  // empty skeleton never invites edits the host would refuse.

  const updateScalars = (mutator: (draft: FallbacksScalars) => void): void => {
    setScalars(prev => {
      const next: FallbacksScalars = { ...prev, triggerCodes: [...prev.triggerCodes] }
      mutator(next)
      return next
    })
  }

  const updateChainRow = (index: number, patch: Partial<ChainRow>): void => {
    setChainRows(rows => {
      const next = rows.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }

  const updateRuleRow = (index: number, patch: Partial<RoleRuleRow>): void => {
    setRuleRows(rows => {
      const next = rows.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }

  const dirty = JSON.stringify(assembleConfig(scalars, chainRows, ruleRows)) !== JSON.stringify(state.config)
  const saving = state.status === 'saving'
  const writable = state.writable && state.conflict === null
  const unknownCodes = scalars.triggerCodes.filter(code => !KNOWN_TRIGGER_CODES.includes(code))

  const save = (): void => {
    void controller.save(assembleConfig(scalars, chainRows, ruleRows))
  }

  const confirmReset = (): void => {
    setResetting(true)
    // The controller never rejects — failures land in the store as the
    // `error` state and surface in the section's error banner; either way
    // the dialog closes once the store settles.
    void controller.resetToDefaults().finally(() => {
      setResetting(false)
      setConfirmingReset(false)
    })
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('nav.description')}</p>

      {state.conflict !== null && (
        <div className={css.banner} role="alert">
          {t('save.conflict', { expected: state.conflict.expected, actual: state.conflict.actual })}
          <Button variant="ghost" size="sm" onClick={() => { void controller.load() }}>
            {t('reload')}
          </Button>
        </div>
      )}
      {state.error !== null && state.conflict === null && (
        <div className={css.banner} role="alert">{t('error.generic', { message: state.error })}</div>
      )}
      {state.status === 'unavailable' && (
        // Namespace not registered (readme-settings spec §1.4-3): an
        // informational banner — the page shows the default-config seed and
        // saves are attempted; failures land in the error banner above.
        <div className={css.infoBanner}>{t('unavailable')}</div>
      )}

      {/* AC-7 read-only status: effective config summary; the recent-switch
       * summary is a placeholder until T8 wires a session-event reading face
       * for the settings page (see module doc — no fabricated API). */}
      <div className={css.statusBlock}>
        <span className={css.statusTitle}>{t('status.title')}</span>
        <p className={css.statusSummary}>{configSummary(state.config, t)}</p>
        {/* simplify: recent-switch placeholder. Upgrade path: T8 supplies a
         * client session-event source (e.g. a session.history-derived face)
         * and this block renders the latest `fallbacks/switch` events. */}
        <p className={css.statusPlaceholder}>
          {t('status.switchesPlaceholder')}
          <span className={css.statusHint}>{t('status.switchesHint')}</span>
        </p>
      </div>

      {/* The `enabled` switch is a row-level preference (the Permission-row
       * rhythm): title + hint on the left, the native checkbox on the right
       * — the panel has no switch primitive, and the checkbox semantics are
       * the behavior the spec pins. */}
      <label className={css.fieldRow}>
        <span className={css.fieldRowText}>
          <span className={css.fieldRowTitle}>{t('enabled.label')}</span>
          <span className={css.fieldRowDesc}>{t('enabled.hint')}</span>
        </span>
        <input
          type="checkbox"
          className={css.switch}
          checked={scalars.enabled}
          disabled={!writable}
          onChange={event => { updateScalars(draft => { draft.enabled = event.target.checked }) }}
        />
      </label>

      {/* Enabled OFF (readme-settings spec §1.2): the form body is hidden but
       * never discarded — the draft stays in state and comes right back when
       * the switch is toggled on. */}
      {!scalars.enabled && (
        <div className={css.offNotice}>{t('enabled.off')}</div>
      )}

      {scalars.enabled && (
      <>
      <fieldset className={css.field} disabled={!writable}>
        <legend className={css.fieldLabel}>{t('triggerCodes.label')}</legend>
        <span className={css.hint}>{t('triggerCodes.hint')}</span>
        {KNOWN_TRIGGER_CODES.map(code => (
          <label key={code} className={css.optionRow}>
            <input
              type="checkbox"
              checked={scalars.triggerCodes.includes(code)}
              onChange={event => {
                updateScalars(draft => { draft.triggerCodes = withTriggerCode(draft.triggerCodes, code, event.target.checked) })
              }}
            />
            {t(TRIGGER_CODE_LABELS[code])}
          </label>
        ))}
        {unknownCodes.length > 0 && (
          <span className={css.hint}>{t('triggerCodes.extra', { codes: unknownCodes.join(', ') })}</span>
        )}
      </fieldset>

      <fieldset className={css.field} disabled={!writable}>
        <legend className={css.fieldLabel}>{t('revertPolicy.label')}</legend>
        <span className={css.hint}>{t('revertPolicy.hint')}</span>
        {(['cooldown-expiry', 'never'] as const).map(policy => (
          <label key={policy} className={css.optionRow}>
            <input
              type="radio"
              name="fallbacks-revert-policy"
              checked={scalars.revertPolicy === policy}
              onChange={() => { updateScalars(draft => { draft.revertPolicy = policy }) }}
            />
            {t(`revertPolicy.${policy}`)}
          </label>
        ))}
      </fieldset>

      <label className={css.field}>
        <span className={css.fieldLabel}>
          {t('cooldownMs.label')}
          <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.cooldownMs}</span>
        </span>
        <input
          className={`${css.input} ${css.numberInput}`}
          type="number"
          min={0}
          value={String(scalars.cooldownMs)}
          disabled={!writable}
          onChange={event => { updateScalars(draft => { draft.cooldownMs = parseCount(event.target.value) }) }}
        />
        <span className={css.hint}>{t('cooldownMs.hint')}</span>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>
          {t('maxSwitchesPerStep.label')}
          <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.maxSwitchesPerStep}</span>
        </span>
        <input
          className={`${css.input} ${css.numberInput}`}
          type="number"
          min={0}
          value={String(scalars.maxSwitchesPerStep)}
          disabled={!writable}
          onChange={event => { updateScalars(draft => { draft.maxSwitchesPerStep = parseCount(event.target.value) }) }}
        />
        <span className={css.hint}>{t('maxSwitchesPerStep.hint')}</span>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>
          {t('alwaysModeRetryCap.label')}
          <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.alwaysModeRetryCap}</span>
        </span>
        <input
          className={`${css.input} ${css.numberInput}`}
          type="number"
          min={0}
          value={String(scalars.alwaysModeRetryCap)}
          disabled={!writable}
          onChange={event => { updateScalars(draft => { draft.alwaysModeRetryCap = parseCount(event.target.value) }) }}
        />
        <span className={css.hint}>{t('alwaysModeRetryCap.hint')}</span>
      </label>

      <fieldset className={css.field} disabled={!writable}>
        <legend className={css.fieldLabel}>{t('chains.label')}</legend>
        <span className={css.hint}>{t('chains.hint')}</span>
        <div className={css.list}>
          {chainRows.map((row, index) => (
            <div key={index} className={css.editorCard}>
              <input
                className={css.input}
                value={row.key}
                placeholder={t('chains.keyPlaceholder')}
                aria-label={t('chains.key')}
                onChange={event => { updateChainRow(index, { key: event.target.value }) }}
              />
              <textarea
                className={css.textarea}
                rows={2}
                value={row.entries}
                placeholder={t('chains.entriesPlaceholder')}
                aria-label={t('chains.entries')}
                onChange={event => { updateChainRow(index, { entries: event.target.value }) }}
              />
              <div className={css.cardFoot}>
                <button
                  type="button"
                  className={`${css.iconButton} ${css.iconButtonDanger}`}
                  data-tip={t('chains.remove')}
                  aria-label={t('chains.remove')}
                  onClick={() => {
                    setChainRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
                  }}
                >
                  <IconTrashOutline16 />
                </button>
              </div>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<IconPlusOutline16 size={14} />}
          className={css.addButton}
          onClick={() => {
            setChainRows(rows => [...rows, { key: '', entries: '' }])
          }}
        >
          {t('chains.add')}
        </Button>
      </fieldset>

      <fieldset className={css.field} disabled={!writable}>
        <legend className={css.fieldLabel}>{t('roles.label')}</legend>
        <span className={css.hint}>{t('roles.hint')}</span>
        <label className={css.subField}>
          <span className={css.subFieldLabel}>{t('roles.default')}</span>
          <input
            className={css.input}
            value={scalars.defaultRole}
            onChange={event => { updateScalars(draft => { draft.defaultRole = event.target.value }) }}
          />
        </label>
        <div className={css.list}>
          {ruleRows.map((row, index) => (
            <div key={index} className={css.editorCard}>
              <div className={css.ruleGrid}>
                <label className={css.ruleCell}>
                  <span className={css.ruleCellLabel}>{t('roles.rule.origin')}</span>
                  <select
                    className={`${css.input} ${css.selectInput}`}
                    value={row.origin}
                    onChange={event => { updateRuleRow(index, { origin: event.target.value }) }}
                  >
                    <option value="">{t('roles.rule.origin.any')}</option>
                    <option value="root">{t('roles.rule.origin.root')}</option>
                    <option value="subagent">{t('roles.rule.origin.subagent')}</option>
                  </select>
                </label>
                <label className={css.ruleCell}>
                  <span className={css.ruleCellLabel}>{t('roles.rule.provider')}</span>
                  <input
                    className={css.input}
                    value={row.provider}
                    onChange={event => { updateRuleRow(index, { provider: event.target.value }) }}
                  />
                </label>
                <label className={css.ruleCell}>
                  <span className={css.ruleCellLabel}>{t('roles.rule.model')}</span>
                  <input
                    className={css.input}
                    value={row.model}
                    onChange={event => { updateRuleRow(index, { model: event.target.value }) }}
                  />
                </label>
                <label className={css.ruleCell}>
                  <span className={css.ruleCellLabel}>{t('roles.rule.role')}</span>
                  <input
                    className={css.input}
                    value={row.role}
                    onChange={event => { updateRuleRow(index, { role: event.target.value }) }}
                  />
                </label>
              </div>
              <div className={css.cardFoot}>
                <button
                  type="button"
                  className={`${css.iconButton} ${css.iconButtonDanger}`}
                  data-tip={t('roles.removeRule')}
                  aria-label={t('roles.removeRule')}
                  onClick={() => {
                    setRuleRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
                  }}
                >
                  <IconTrashOutline16 />
                </button>
              </div>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<IconPlusOutline16 size={14} />}
          className={css.addButton}
          onClick={() => {
            setRuleRows(rows => [...rows, { origin: '', provider: '', model: '', role: '' }])
          }}
        >
          {t('roles.addRule')}
        </Button>
      </fieldset>
      </>
      )}

      <div className={css.actions}>
        <Button
          variant="primary"
          disabled={!writable || saving || !dirty}
          onClick={save}
        >
          {saving ? t('save.saving') : t('save')}
        </Button>
        <Button variant="outline" disabled={!writable || saving} onClick={() => { setConfirmingReset(true) }}>
          {t('reset')}
        </Button>
      </div>

      {/* Reset-to-defaults confirmation: the Models page's delete-confirm
       * pattern — outline cancel + danger-styled outline confirm. */}
      <Modal
        open={confirmingReset}
        onClose={() => { if (!resetting) setConfirmingReset(false) }}
        title={t('reset.confirmTitle')}
        closeLabel={t('close')}
        description={t('reset.confirm')}
        className={css.resetDialog}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={resetting}
              onClick={() => { setConfirmingReset(false) }}
            >
              {t('reset.confirm.cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.confirmDanger}
              disabled={resetting}
              onClick={confirmReset}
            >
              {resetting ? t('reset.saving') : t('reset.confirm.action')}
            </Button>
          </>
        )}
      />
    </div>
  )
}
