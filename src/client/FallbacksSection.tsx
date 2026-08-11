/**
 * Fallbacks settings section — the web settings GUI page for the `fallbacks`
 * namespace (spec §4). Registered into the `settings.section` slot (id
 * `fallbacks`, order 30 — after the Models section at 10); owner props are
 * empty and all data flows through {@link FallbacksSettingsController}.
 *
 * Rendering follows the dsh-advisor settings-section vocabulary shared with
 * the settings panel: title + intro + one outlined card carrying the whole
 * form (`.checkboxRow` enabled row, 12/18 field labels, h32 r8 inputs with
 * the `.selectInput` chevron, number grid, h36 r18 capsule actions at the
 * card bottom), the chain/role row editors keeping their filled editorCard
 * surface inside the card, and `--dsw-alias-*` tokens throughout. The
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
 * Read-only status block (AC-7 行为可见性), compact and pinned at the
 * section bottom: the derived "current effective model" (spec §2.5 D-6 — a
 * display value from config + recent switches, never a live route probe; the
 * non-probing note rides inline right after the derived value, available case
 * only — the unavailable 空态 shows its own copy) and the most recent switch
 * from the current session's raw `fallbacks/switch` events (spec §2.5 D-5 —
 * read through the store's `sessions.history` face, single page, newest-first).
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import type { ConfigurableProviderView } from '@deepseek-ai/dsh-client-connection/client'
import {
  Button, IconPlusOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FallbacksConfig, RevertPolicy } from '../config.ts'
import { defaultFallbacksConfig } from '../config.ts'
import type { FallbackSwitchReason } from '../events.ts'
import {
  FallbacksSettingsController,
  chainsToRows,
  classifyModel,
  classifyProvider,
  deriveEffectiveModel,
  rowsToChains,
  rowsToRules,
  rulesToRows,
  selectionToRaw,
  type CatalogLookup,
  type ChainRow,
  type ChainSelectorRow,
  type FallbacksSettingsState,
  type RoleRuleRow,
} from './fallbacks-store.ts'
import {
  KNOWN_TRIGGER_CODES,
  TRIGGER_CODE_LABELS,
  withTriggerCode,
  type FallbacksKey,
} from './locales.ts'
import css from './FallbacksSection.module.css'

/**
 * Reason → locale key map for the status block's switch summary (S-c). The
 * session log is durable and forward-compatible: a reason value outside the
 * current union (a newer plugin wrote it) renders raw instead of falling into
 * the old binary ternary's else branch.
 */
const SWITCH_REASON_KEYS: Readonly<Partial<Record<FallbackSwitchReason, FallbacksKey>>> = {
  'trigger-code': 'status.switches.reason.trigger-code',
  'always-cap': 'status.switches.reason.always-cap',
}

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

/** The catalog faces the dropdowns classify against; undefined while unready. */
function catalogOf(state: FallbacksSettingsState): CatalogLookup | undefined {
  return state.catalogStatus === 'ready' ? { providers: state.providers, groups: state.groups } : undefined
}

/**
 * One chain entry selector row: provider select + model select (cascade) +
 * wildcard checkbox (spec §2.5 D-3). The provider options are the catalog
 * providers **configured on the Models page** (`configuredProviders`, the
 * Models-page `configured` join) — unconfigured directory providers never
 * become offerable. Out-of-catalog values read back from the server render as
 * a synthetic option with the short "outside catalog" annotation and stay
 * selected — keeping them saves verbatim; picking a catalog option is an
 * intentional change. A directory provider that is not configured is offered
 * the same read-back treatment (short "not configured" annotation) so an
 * existing value is never hidden or dropped. New rows only offer configured
 * options.
 */
function ChainSelectorEditor({
  selector, catalog, configuredProviders, disabled, t, onChange, onRemove,
}: {
  selector: ChainSelectorRow
  catalog: CatalogLookup | undefined
  configuredProviders: readonly ConfigurableProviderView[]
  disabled: boolean
  t: FallbacksSectionProps['t']
  onChange: (patch: Partial<ChainSelectorRow>) => void
  onRemove: () => void
}): ReactNode {
  const providerRaw = selectionToRaw(selector.provider)
  const providerOutside = selector.provider?.kind === 'outside'
  // A catalog provider that is not configured (Models-page `configured` join):
  // keep the read-back value visible as a synthetic option — never offerable,
  // never dropped on save.
  const providerUnconfigured = !providerOutside && providerRaw !== ''
    && (catalog?.providers.some(entry => entry.provider === providerRaw) ?? false)
    && !configuredProviders.some(entry => entry.provider === providerRaw)
  const modelRaw = selectionToRaw(selector.model)
  const modelOutside = selector.model?.kind === 'outside'
  const group = catalog?.groups.find(entry => entry.id === providerRaw)
  // Catalog provider with no successful model listing: model select disabled
  // with a hint (D-4); the wildcard stays available (D-4: never depends on
  // the models).
  const groupMissing = providerRaw !== '' && !providerOutside && !selector.wildcard && group === undefined
  // Nothing selectable: outside provider with no outside model to keep.
  const modelDisabled = disabled || selector.wildcard || providerRaw === '' || groupMissing || (providerOutside && modelRaw === '')

  return (
    <div className={css.selectorRow}>
      <div className={css.ruleGrid}>
        <label className={css.ruleCell}>
          <span className={css.ruleCellLabel}>{t('roles.rule.provider')}</span>
          <select
            className={`${css.input} ${css.selectInput}`}
            value={providerRaw}
            disabled={disabled}
            onChange={event => {
              // Cascade: a DIFFERENT provider clears the model choice (D-3);
              // re-picking the same provider keeps the model (S-e).
              if (event.target.value === providerRaw) return
              onChange({ provider: classifyProvider(event.target.value, catalog), model: null })
            }}
          >
            <option value="">{t('chains.selector.providerPlaceholder')}</option>
            {configuredProviders.map(entry => (
              <option key={entry.provider} value={entry.provider}>{entry.displayName}</option>
            ))}
            {providerUnconfigured && (
              <option value={providerRaw}>{`${providerRaw}${t('catalog.unconfigured.short')}`}</option>
            )}
            {providerOutside && (
              <option value={providerRaw}>{`${providerRaw}${t('catalog.outside.short')}`}</option>
            )}
          </select>
        </label>
        <label className={css.ruleCell}>
          <span className={css.ruleCellLabel}>{t('roles.rule.model')}</span>
          <select
            className={`${css.input} ${css.selectInput}`}
            value={selector.wildcard ? '' : modelRaw}
            disabled={modelDisabled}
            onChange={event => { onChange({ model: classifyModel(providerRaw, event.target.value, catalog) }) }}
          >
            {modelRaw === '' && !providerOutside && !selector.wildcard && (
              <option value="">{t('chains.selector.modelPlaceholder')}</option>
            )}
            {(group?.models ?? []).map(model => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
            {modelOutside && !selector.wildcard && (
              <option value={modelRaw}>{`${modelRaw}${t('catalog.outside.short')}`}</option>
            )}
          </select>
          {groupMissing && <span className={css.hint}>{t('chains.selector.noModels')}</span>}
        </label>
        <label className={`${css.ruleCell} ${css.wildcardCell}`}>
          <input
            type="checkbox"
            checked={selector.wildcard}
            disabled={disabled || providerRaw === ''}
            onChange={event => {
              onChange({
                wildcard: event.target.checked,
                ...(event.target.checked ? { model: null } : {}),
              })
            }}
          />
          {t('chains.selector.wildcard')}
        </label>
      </div>
      {(providerOutside || modelOutside) && (
        <span className={css.hint}>{t('catalog.outside.hint')}</span>
      )}
      <div className={css.cardFoot}>
        <button
          type="button"
          className={`${css.iconButton} ${css.iconButtonDanger}`}
          data-tip={t('chains.selector.remove')}
          aria-label={t('chains.selector.remove')}
          onClick={onRemove}
        >
          <IconTrashOutline16 />
        </button>
      </div>
    </div>
  )
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
  // refresh an already-loaded store (`refresh*IfLoaded` skips 'idle'), so the
  // section must pull the descriptor itself on mount. The catalog read is the
  // parallel twin (D-4), and the recent-switch summary follows the current
  // session (D-5 — `setCurrentSession` recorded the id at apply time): each
  // side keeps its own idle guard (no retry loop on persistent errors).
  // `controller` is the stable slot-injected singleton, so this fires once
  // per mount.
  useEffect(() => {
    const snapshot = controller.store.getSnapshot()
    if (snapshot.status === 'idle') void controller.load()
    if (snapshot.catalogStatus === 'idle') void controller.loadCatalog()
    if (snapshot.switchesStatus === 'idle') void controller.loadSwitches()
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
    setChainRows(chainsToRows(state.config.chains, catalogOf(state)))
    setRuleRows(rulesToRows(state.config.roles.rules, catalogOf(state)))
  }, [state.status, state.revision, state.config])

  // Reset-to-defaults confirmation (replaces `window.confirm`): the dialog
  // stays open while the replace is in flight — the Models page's
  // delete-confirm pattern. The store's `saving` state also disables the
  // page actions, so a regular save and a reset cannot overlap.
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  // The skeleton always renders (readme-settings spec §1.2): title, intro,
  // banners, the `enabled` switch, the save/reset actions, and the read-only
  // status block pinned at the bottom are visible in every store state (idle /
  // loading / ready / saving / unavailable / error). The form body below is
  // gated on the draft's `enabled` flag. Controls are disabled while
  // `writable` is false (initial load, loading, or a read-only describe
  // response), so an empty skeleton never invites edits the host would refuse.

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

  const updateChainSelector = (chainIndex: number, selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    setChainRows(rows => {
      const next = rows.map(row => ({ ...row, selectors: row.selectors.map(selector => ({ ...selector })) }))
      const selectors = next[chainIndex]!.selectors
      selectors[selectorIndex] = { ...selectors[selectorIndex]!, ...patch }
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

  // R-4b: the status block's derived effective model (spec §2.5 D-6). The
  // derivation is a display value over config + recent switches — the
  // non-probing note ⑤ renders inline after the value.
  const effectiveModel = deriveEffectiveModel(state.config, state.switches)
  const effectiveModelLine = effectiveModel.kind === 'unavailable'
    ? t('status.effectiveModel.unavailable')
    : `${effectiveModel.provider}/${effectiveModel.model} · ${t('status.effectiveModel.note')}`

  // The compact recent-switch line: the most recent switch (from → to +
  // role/reason) or an honest empty/loading/error state — one line, never a
  // list (spec §2.5 D-5 semantics unchanged; the store still caps at
  // RECENT_SWITCH_LIMIT).
  const latestSwitch = state.switches[0]
  let switchesLine: string
  if (state.switchesStatus === 'error') {
    switchesLine = t('status.switches.error', { message: state.switchesError })
  } else if (state.switchesStatus === 'loading') {
    switchesLine = t('loading')
  } else if (latestSwitch === undefined) {
    switchesLine = t('status.switches.empty')
  } else {
    const reasonKey = SWITCH_REASON_KEYS[latestSwitch.reason]
    switchesLine = t('status.switches.compact', {
      count: String(state.switches.length),
      from: `${latestSwitch.from.provider}/${latestSwitch.from.model}`,
      to: `${latestSwitch.to.provider}/${latestSwitch.to.model}`,
      role: latestSwitch.role,
      reason: reasonKey === undefined ? latestSwitch.reason : t(reasonKey),
    })
  }

  // Catalog refresh (models/changed) re-classifies rows against the fresh
  // directory: a value that was outside when the settings seeded becomes a
  // catalog option, and the empty-catalog guidance clears (R-3a). Only
  // untouched drafts are re-seeded — in-progress edits are never clobbered.
  // The epoch is recorded only on an actual re-seed (S-d): a dirty draft skips
  // without consuming the epoch, so the effect re-runs after save (dirty →
  // false) and re-seeds the just-saved values against the fresh catalog.
  const catalogSeededEpoch = useRef<number | null>(null)
  useEffect(() => {
    if (state.catalogStatus !== 'ready') return
    if (catalogSeededEpoch.current === state.catalogEpoch) return
    if (dirty) return
    catalogSeededEpoch.current = state.catalogEpoch
    setChainRows(chainsToRows(state.config.chains, catalogOf(state)))
    setRuleRows(rulesToRows(state.config.roles.rules, catalogOf(state)))
  }, [state.catalogStatus, state.catalogEpoch, state.config, dirty])

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

      {/* One outlined card carries the whole form (the dsh-advisor settings
       * vocabulary): the enabled row, the form body (gated on the draft's
       * `enabled` flag), and the save/reset capsule actions. The skeleton
       * semantics are unchanged — the card, the enabled row, the actions,
       * and the status block render in every store state. */}
      <div className={css.card}>
        {/* The `enabled` switch is a row-level preference (the advisor
         * checkboxRow rhythm): label text on the left, the native checkbox
         * on the right, no separator line — the panel has no switch
         * primitive, and the checkbox semantics are the behavior the spec
         * pins. */}
        <div className={css.checkboxRow}>
          <label htmlFor="fallbacks-enabled" className={css.checkLabel}>
            <span className={css.checkLabelTitle}>{t('enabled.label')}</span>
            <span className={css.checkLabelDesc}>{t('enabled.hint')}</span>
          </label>
          <input
            id="fallbacks-enabled"
            type="checkbox"
            className={css.checkbox}
            checked={scalars.enabled}
            disabled={!writable}
            onChange={event => { updateScalars(draft => { draft.enabled = event.target.checked }) }}
          />
        </div>

        {/* Enabled OFF (readme-settings spec §1.2): the form body is hidden but
         * never discarded — the draft stays in state and comes right back when
         * the switch is toggled on. */}
        {!scalars.enabled && (
          <p className={css.offNotice}>{t('enabled.off')}</p>
        )}

        {scalars.enabled && (
        /* The form body is one fieldset without a legend: the enabled toggle
         * above it is the group's question (the advisor fieldset). `disabled`
         * propagates to every control inside — read-only/loading describes
         * keep the whole body inert. */
        <fieldset className={css.fieldset} disabled={!writable}>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('triggerCodes.label')}</span>
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
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{t('revertPolicy.label')}</span>
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
          </div>

          {/* The three short numeric fields sit side by side, each keeping a
           * full-width field of its own grid column. */}
          <div className={css.numberFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>
                {t('cooldownMs.label')}
                <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.cooldownMs}</span>
              </span>
              <input
                className={css.input}
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
                className={css.input}
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
                className={css.input}
                type="number"
                min={0}
                value={String(scalars.alwaysModeRetryCap)}
                disabled={!writable}
                onChange={event => { updateScalars(draft => { draft.alwaysModeRetryCap = parseCount(event.target.value) }) }}
              />
              <span className={css.hint}>{t('alwaysModeRetryCap.hint')}</span>
            </label>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{t('chains.label')}</span>
            <span className={css.hint}>{t('chains.hint')}</span>
            {/* Catalog state is an enrichment of the dropdowns, never a blocker:
             * a failed read (or an empty directory) only adds a hint line and
             * leaves every other field editable and saveable (spec §2.3 R-3a). */}
            {state.catalogStatus === 'error' && state.catalogError !== null && (
              <span className={css.hint}>{t('catalog.error', { message: state.catalogError })}</span>
            )}
            {state.catalogStatus === 'ready' && state.catalogError !== null && (
              <span className={css.hint}>{t('catalog.partial', { message: state.catalogError })}</span>
            )}
            {state.catalogStatus === 'ready' && (state.groups.length === 0 || state.configuredProviders.length === 0) && (
              <span className={css.hint}>{t('catalog.empty')}</span>
            )}
            <div className={css.list}>
              {chainRows.map((row, index) => (
                <div key={index} className={css.editorCard}>
                  <input
                    className={`${css.input} ${css.keyInput}`}
                    value={row.key}
                    placeholder={t('chains.keyPlaceholder')}
                    aria-label={t('chains.key')}
                    onChange={event => { updateChainRow(index, { key: event.target.value }) }}
                  />
                  <div className={css.chainSelectors}>
                    {row.selectors.map((selector, selectorIndex) => (
                      <ChainSelectorEditor
                        key={selectorIndex}
                        selector={selector}
                        catalog={catalogOf(state)}
                        configuredProviders={state.configuredProviders}
                        disabled={!writable}
                        t={t}
                        onChange={patch => { updateChainSelector(index, selectorIndex, patch) }}
                        onRemove={() => {
                          setChainRows(rows => rows.map((entry, entryIndex) => entryIndex === index
                            ? { ...entry, selectors: entry.selectors.filter((_, sIndex) => sIndex !== selectorIndex) }
                            : entry))
                        }}
                      />
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconPlusOutline16 size={14} />}
                    className={css.addButton}
                    onClick={() => {
                      setChainRows(rows => rows.map((entry, entryIndex) => entryIndex === index
                        ? { ...entry, selectors: [...entry.selectors, { wildcard: false, provider: null, model: null }] }
                        : entry))
                    }}
                  >
                    {t('chains.selector.add')}
                  </Button>
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
                setChainRows(rows => [...rows, { key: '', selectors: [] }])
              }}
            >
              {t('chains.add')}
            </Button>
          </div>

          <div className={css.field}>
            <span className={css.fieldLabel}>{t('roles.label')}</span>
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
              {ruleRows.map((row, index) => {
                const catalog = catalogOf(state)
                const providerRaw = selectionToRaw(row.provider)
                const group = catalog?.groups.find(entry => entry.id === providerRaw)
                const providerOutside = row.provider?.kind === 'outside'
                // Same read-back treatment as the chain selector rows: a catalog
                // provider that is not configured stays visible but unofferable.
                const providerUnconfigured = !providerOutside && providerRaw !== ''
                  && (catalog?.providers.some(entry => entry.provider === providerRaw) ?? false)
                  && !state.configuredProviders.some(entry => entry.provider === providerRaw)
                const modelOutside = row.model?.kind === 'outside'
                return (
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
                      <select
                        className={`${css.input} ${css.selectInput}`}
                        value={providerRaw}
                        onChange={event => {
                          // Cascade (same D-3 rule as chains): a DIFFERENT provider
                          // clears the model choice; re-picking the same provider
                          // keeps the model (S-e).
                          if (event.target.value === providerRaw) return
                          updateRuleRow(index, { provider: classifyProvider(event.target.value, catalog), model: null })
                        }}
                      >
                        <option value="">{t('roles.rule.provider.any')}</option>
                        {state.configuredProviders.map(entry => (
                          <option key={entry.provider} value={entry.provider}>{entry.displayName}</option>
                        ))}
                        {providerUnconfigured && (
                          <option value={providerRaw}>{`${providerRaw}${t('catalog.unconfigured.short')}`}</option>
                        )}
                        {providerOutside && (
                          <option value={providerRaw}>{`${providerRaw}${t('catalog.outside.short')}`}</option>
                        )}
                      </select>
                    </label>
                    <label className={css.ruleCell}>
                      <span className={css.ruleCellLabel}>{t('roles.rule.model')}</span>
                      <select
                        className={`${css.input} ${css.selectInput}`}
                        value={selectionToRaw(row.model)}
                        onChange={event => {
                          updateRuleRow(index, { model: classifyModel(providerRaw, event.target.value, catalog) })
                        }}
                      >
                        <option value="">{t('roles.rule.model.any')}</option>
                        {(group?.models ?? []).map(model => (
                          <option key={model.id} value={model.id}>{model.name}</option>
                        ))}
                        {modelOutside && (
                          <option value={selectionToRaw(row.model)}>{`${selectionToRaw(row.model)}${t('catalog.outside.short')}`}</option>
                        )}
                      </select>
                    </label>
                    <label className={css.ruleCell}>
                      <span className={css.ruleCellLabel}>{t('roles.rule.role')}</span>
                      <input
                        className={css.input}
                        value={row.role}
                        placeholder={t('roles.rule.rolePlaceholder')}
                        onChange={event => { updateRuleRow(index, { role: event.target.value }) }}
                      />
                    </label>
                  </div>
                  {(providerOutside || modelOutside) && (
                    <span className={css.hint}>{t('catalog.outside.hint')}</span>
                  )}
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
                )
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              icon={<IconPlusOutline16 size={14} />}
              className={css.addButton}
              onClick={() => {
                setRuleRows(rows => [...rows, { origin: '', provider: null, model: null, role: '' }])
              }}
            >
              {t('roles.addRule')}
            </Button>
          </div>
        </fieldset>
        )}

        {/* Save/reset: the advisor h36 r18 capsule actions, right-aligned at
         * the card bottom. */}
        <div className={css.editorActions}>
          <button
            type="button"
            className={css.primaryButton}
            disabled={!writable || saving || !dirty}
            onClick={save}
          >
            {saving ? t('save.saving') : t('save')}
          </button>
          <button
            type="button"
            className={css.secondaryButton}
            disabled={!writable || saving}
            onClick={() => { setConfirmingReset(true) }}
          >
            {t('reset')}
          </button>
        </div>
      </div>

      {/* AC-7 read-only status, compact and pinned at the section bottom
       * (after the form card): the derived "current effective model"
       * (D-6 — a display value from config + recent switches, never a live
       * route probe; note ⑤ rides inline) and the most recent switch (D-5 —
       * read through the store's `sessions.history` face). The verbose
       * config-summary dump is gone; errors/empty still render, compact. */}
      <div className={css.statusBlock}>
        <span className={css.statusTitle}>{t('status.title')}</span>
        <p className={css.statusLine}>
          <span className={css.statusLineLabel}>{t('status.effectiveModel.label')}</span>
          {effectiveModelLine}
        </p>
        <p className={css.statusLine} role={state.switchesStatus === 'error' ? 'alert' : undefined}>
          <span className={css.statusLineLabel}>{t('status.switches.label')}</span>
          {switchesLine}
        </p>
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
