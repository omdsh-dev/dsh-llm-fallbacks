/**
 * Fallbacks settings section — the web settings GUI page for the `fallbacks`
 * namespace (spec §4). Registered into the `settings.section` slot (id
 * `fallbacks`, order 30 — after the Models section at 10); owner props are
 * empty and all data flows through {@link FallbacksSettingsController}.
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
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FallbacksConfig, RevertPolicy } from '../config.ts'
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

  // Editors seed from the descriptor once per revision; a save or a reload
  // bumps the revision and re-seeds with server truth.
  const [scalars, setScalars] = useState<FallbacksScalars | null>(null)
  const [chainRows, setChainRows] = useState<ChainRow[]>([])
  const [ruleRows, setRuleRows] = useState<RoleRuleRow[]>([])
  const seededRevision = useRef<number | null>(null)

  useEffect(() => {
    if (state.status !== 'ready') return
    if (seededRevision.current === state.revision) return
    seededRevision.current = state.revision
    setScalars(scalarsOf(state.config))
    setChainRows(chainsToRows(state.config.chains))
    setRuleRows(rulesToRows(state.config.roles.rules))
  }, [state.status, state.revision, state.config])

  // Statuses that keep the form mounted: ready, saving, and error-with-
  // conflict (the stale draft stays visible next to the conflict banner so a
  // reload can re-seed instead of silently discarding the user's edits).
  const formMounted = scalars !== null && (
    state.status === 'ready'
    || state.status === 'saving'
    || (state.status === 'error' && state.conflict !== null)
  )
  if (!formMounted) {
    if (state.status === 'unavailable') {
      return <div className={css.notice}>{t('unavailable')}</div>
    }
    if (state.status === 'error') {
      return <div className={css.notice} role="alert">{t('error.generic', { message: state.error ?? '' })}</div>
    }
    return <div className={css.notice}>{t('loading')}</div>
  }

  const updateScalars = (mutator: (draft: FallbacksScalars) => void): void => {
    setScalars(prev => {
      if (prev === null) return prev
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

  const reset = (): void => {
    if (window.confirm(t('reset.confirm'))) void controller.resetToDefaults()
  }

  return (
    <div className={css.section}>
      <h3 className={css.title}>{t('nav')}</h3>
      <p className={css.intro}>{t('nav.description')}</p>

      {state.conflict !== null && (
        <div className={css.banner} role="alert">
          {t('save.conflict', { expected: state.conflict.expected, actual: state.conflict.actual })}
          <button type="button" className={css.linkButton} onClick={() => { void controller.load() }}>
            {t('reload')}
          </button>
        </div>
      )}
      {state.error !== null && state.conflict === null && (
        <div className={css.banner} role="alert">{t('error.generic', { message: state.error })}</div>
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

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('enabled.label')}</span>
        <input
          type="checkbox"
          checked={scalars.enabled}
          disabled={!writable}
          onChange={event => { updateScalars(draft => { draft.enabled = event.target.checked }) }}
        />
        <span className={css.hint}>{t('enabled.hint')}</span>
      </label>

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
          className={css.numberInput}
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
          className={css.numberInput}
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
          className={css.numberInput}
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
            <div key={index} className={css.rowCard}>
              <input
                className={css.textInput}
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
              <button type="button" className={css.linkButton} onClick={() => {
                setChainRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
              }}>
                {t('chains.remove')}
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={css.addButton} onClick={() => {
          setChainRows(rows => [...rows, { key: '', entries: '' }])
        }}>
          {t('chains.add')}
        </button>
      </fieldset>

      <fieldset className={css.field} disabled={!writable}>
        <legend className={css.fieldLabel}>{t('roles.label')}</legend>
        <span className={css.hint}>{t('roles.hint')}</span>
        <label className={css.subField}>
          <span className={css.subFieldLabel}>{t('roles.default')}</span>
          <input
            className={css.textInput}
            value={scalars.defaultRole}
            onChange={event => { updateScalars(draft => { draft.defaultRole = event.target.value }) }}
          />
        </label>
        <div className={css.list}>
          {ruleRows.map((row, index) => (
            <div key={index} className={css.ruleCard}>
              <label className={css.ruleCell}>
                <span className={css.ruleCellLabel}>{t('roles.rule.origin')}</span>
                <select
                  className={css.textInput}
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
                  className={css.textInput}
                  value={row.provider}
                  onChange={event => { updateRuleRow(index, { provider: event.target.value }) }}
                />
              </label>
              <label className={css.ruleCell}>
                <span className={css.ruleCellLabel}>{t('roles.rule.model')}</span>
                <input
                  className={css.textInput}
                  value={row.model}
                  onChange={event => { updateRuleRow(index, { model: event.target.value }) }}
                />
              </label>
              <label className={css.ruleCell}>
                <span className={css.ruleCellLabel}>{t('roles.rule.role')}</span>
                <input
                  className={css.textInput}
                  value={row.role}
                  onChange={event => { updateRuleRow(index, { role: event.target.value }) }}
                />
              </label>
              <button type="button" className={css.linkButton} onClick={() => {
                setRuleRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
              }}>
                {t('roles.removeRule')}
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={css.addButton} onClick={() => {
          setRuleRows(rows => [...rows, { origin: '', provider: '', model: '', role: '' }])
        }}>
          {t('roles.addRule')}
        </button>
      </fieldset>

      <div className={css.actions}>
        <button
          type="button"
          className={css.primaryButton}
          disabled={!writable || saving || !dirty}
          onClick={save}
        >
          {saving ? t('save.saving') : t('save')}
        </button>
        <button type="button" className={css.secondaryButton} disabled={!writable || saving} onClick={reset}>
          {t('reset')}
        </button>
      </div>
    </div>
  )
}
