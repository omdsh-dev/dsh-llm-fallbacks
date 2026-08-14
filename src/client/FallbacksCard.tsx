/**
 * Fallbacks settings card — the `fallbacks` plugin card on the web settings
 * "插件配置" page (spec §4). Registered into the `settings.plugin.item` slot
 * (id `fallbacks`, order 30, alongside the upstream bash/agent-loop/web-search
 * cards and the advisor card); owner props are empty and all data flows
 * through {@link FallbacksSettingsController}.
 *
 * The card chrome replicates the upstream `PluginCard` contract (self-drawn:
 * the upstream client value face exports no reusable card): a collapsible
 * `<li>` whose header is a button stacking the plugin name over its
 * description, with a dirty "unsaved" pill and a rotating chevron
 * (`IconChevronDownOutline14` from ui-primitives — a CLIENT_EXTERNALS value
 * import), `aria-expanded`/`aria-label` like the upstream header; a divider
 * under the header; then the form content; then a footer with
 * Discard / Reset / Save carrying the upstream disabled semantics — save =
 * `!dirty || saving || !writable`, discard = `!dirty || saving` (KD-U1).
 * Disclosure is card-local state: which card a user has open is a reading
 * gesture, and staged edits outlive collapsing — the pill rides the header
 * (upstream rationale).
 *
 * The form body is the two-block editing surface (spec §8): the `enabled`
 * checkbox row, the 6 top-level scalar fields (trigger codes / revert
 * policy / three numeric fields), the `rootChain` block (block 1 — the
 * root agent's single chain, no key input), and the roles block (block 2 —
 * declared role entity cards from `roles.list` plus the rule rows from
 * `roles.rules`, whose role field is a dropdown bound to the declared ids
 * + the built-in `inherit`, same-page live). Saving runs `validateDraft`
 * first — id format/reserved word/duplicates, undeclared rule role
 * references, illegal selectors, and a role with no chain entries (no
 * model config) block the write with a validation banner + inline red
 * borders / hints (never touching the store error path); a
 * non-empty `state.legacyKeys` renders the migration banner at the top of
 * the card body. The row editors keep their filled editorCard surface
 * inside the card, with `--dsw-alias-*` tokens throughout. The reset-
 * to-defaults confirmation stays a `Modal` (the delete-confirm pattern of
 * the Models page) — no `window.confirm`.
 *
 * The page-only chrome is gone (720px column wrapper, title/intro banners,
 * page-bottom status block): the AC-7 read-only status (derived effective
 * model + recent-switch summary) is folded into the card body above the
 * footer, and the plugin-config section owns the column width.
 *
 * Degraded/error/loading states keep the same card chrome (KD-U3): the
 * header always renders title+description+chevron, and the body carries the
 * config-channel notice or the load error. A card that cannot reach the
 * `fallbacks/get` gateway channel (`ready && !present`) keeps the USABLE
 * skeleton — the form stays writable and saves are attempted (KD-G5) — with
 * the `unavailable` notice ALWAYS visible (derived open — the header cannot
 * collapse it away), while a healthy card is collapsed until the user
 * expands it (AC-1, the documented divergence from upstream whose
 * unavailable card renders nothing). A hard load failure (`status ===
 * 'error'`) also forces the body open with an error notice and — when the
 * form is inert (`!writable`, i.e. the load never landed) — a Retry button;
 * a save failure keeps the editable form so the Save action itself is the
 * retry (the single `state.error` surface covers both, unlike the advisor's
 * separate apply-failure hints).
 *
 * The degraded derivation is latched in the card (the store stays untouched):
 * `present` only ever changes inside the store's `accept()`, so the settled
 * `ready` read is authoritative, and a card-local latch carries that value
 * through refresh/save windows (`loading`/`saving`) so the notice body can
 * never collapse mid-refresh (the advisor's latched `degraded` field,
 * implemented without a store change); on a first mount the latch is false,
 * so the healthy card starts (and stays) collapsed through its first load.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConfigurableProviderView } from '@deepseek-ai/dsh-client-connection/client'
import {
  Button, IconChevronDownOutline14, IconPlusOutline16, IconTrashOutline16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { FallbacksConfig, FallbacksRole, FallbackStrategy, RevertPolicy } from '../config.ts'
import { defaultFallbacksConfig, INHERIT_ROLE_ID, ROLE_ID_PATTERN } from '../config.ts'
import { parseSelector } from '../selectors.ts'
import {
  FallbacksSettingsController,
  classifyModel,
  classifyProvider,
  deriveEffectiveModel,
  mergeRoleExtras,
  rolesToRows,
  rootChainToRows,
  rowsToRootChain,
  rowsToRules,
  rulesToRows,
  ruleRoleOptions,
  selectionToRaw,
  selectorRowToRaw,
  type CatalogLookup,
  type ChainSelectorRow,
  type FallbacksSettingsState,
  type RoleRow,
  type RoleRuleRow,
  type RootChainRow,
} from './fallbacks-store.ts'
import {
  KNOWN_TRIGGER_CODES,
  SWITCH_REASON_KEYS,
  TRIGGER_CODE_LABELS,
  withTriggerCode,
  type FallbacksKey,
} from './locales.ts'
import css from './FallbacksCard.module.css'

/** Injected dependencies of {@link FallbacksCard} (slot `inject`). */
export interface FallbacksCardInjected {
  /** The card store (loaded on mount, refreshed on pushed invalidations). */
  controller: FallbacksSettingsController
  /** uSES subscription hook bound to the store (inject face — advisor pattern). */
  useSnapshot: SnapshotSelectorHook<FallbacksSettingsState>
}

/** Props delivered by the slot outlet: runtime share + locale seat + inject face. */
export type FallbacksCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'fallbacks'> & FallbacksCardInjected

/** Scalar (non-row) fields of the form draft. */
interface FallbacksScalars {
  enabled: boolean
  triggerCodes: string[]
  cooldownMs: number
  revertPolicy: RevertPolicy
  maxSwitchesPerStep: number
  alwaysModeRetryCap: number
}

/** Split scalars from the row editors (rootChain / role entities / role rules). */
function scalarsOf(config: FallbacksConfig): FallbacksScalars {
  return {
    enabled: config.enabled,
    triggerCodes: [...config.triggerCodes],
    cooldownMs: config.cooldownMs,
    revertPolicy: config.revertPolicy,
    maxSwitchesPerStep: config.maxSwitchesPerStep,
    alwaysModeRetryCap: config.alwaysModeRetryCap,
  }
}

/**
 * Assemble the full config the row editors + scalars describe. The rebuilt
 * `roles.list` comes from the rows, with the schema-reserved
 * `prompt`/`permissions` merged back from the last accepted config by role
 * id (see {@link mergeRoleExtras}) so a save never silently drops them
 * (T2 reviewer minor #2).
 */
function assembleConfig(
  scalars: FallbacksScalars,
  rootChainRows: readonly RootChainRow[],
  roleRows: readonly RoleRow[],
  ruleRows: readonly RoleRuleRow[],
  originalRoles: readonly FallbacksRole[],
): FallbacksConfig {
  const list = mergeRoleExtras(roleRows, originalRoles)
  return {
    enabled: scalars.enabled,
    triggerCodes: [...scalars.triggerCodes],
    rootChain: rowsToRootChain(rootChainRows),
    roles: { list, rules: rowsToRules(ruleRows) },
    cooldownMs: scalars.cooldownMs,
    revertPolicy: scalars.revertPolicy,
    maxSwitchesPerStep: scalars.maxSwitchesPerStep,
    alwaysModeRetryCap: scalars.alwaysModeRetryCap,
  }
}

/**
 * Pre-save validation of the assembled draft (spec §8 / plan Task 3):
 * role id format/reserved word/duplicates, undeclared rule role references
 * (only reachable through the synthetic outside option — the dropdown
 * itself constrains normal edits), and illegal selector entries in
 * rootChain and role chains. Returns one localized message per violation;
 * a non-empty result blocks {@link save} — the draft is never written.
 * `label`/`description` are free text and never validated.
 */
function validateDraft(draft: FallbacksConfig, t: FallbacksCardProps['t']): string[] {
  const errors: string[] = []
  const declaredIds = new Set<string>()
  for (const role of draft.roles.list) {
    if (!ROLE_ID_PATTERN.test(role.id)) {
      errors.push(t('validation.roleIdFormat', { id: role.id }))
    }
    if (role.id === INHERIT_ROLE_ID) {
      errors.push(t('validation.roleIdReserved'))
    }
    if (declaredIds.has(role.id)) {
      errors.push(t('validation.roleIdDuplicate', { id: role.id }))
    }
    declaredIds.add(role.id)
    for (const entry of role.chain ?? []) {
      try {
        parseSelector(entry)
      } catch (error) {
        errors.push(t('validation.selector', { entry, message: (error as Error).message }))
      }
    }
    // A declared role with no model config is meaningless (plan
    // fallbacks-feedback-round T2): no chain entries → the save is blocked
    // with an inline hint on the role card (chain area empty).
    if ((role.chain ?? []).length === 0) {
      errors.push(t('validation.roleChainRequired', { id: role.id }))
    }
  }
  for (const entry of draft.rootChain) {
    try {
      parseSelector(entry)
    } catch (error) {
      errors.push(t('validation.selector', { entry, message: (error as Error).message }))
    }
  }
  const validTargets = new Set([...declaredIds, INHERIT_ROLE_ID])
  for (const rule of draft.roles.rules) {
    if (!validTargets.has(rule.role)) {
      errors.push(t('validation.ruleRoleUndeclared', { role: rule.role }))
    }
  }
  return errors
}

/**
 * The trimmed role ids that are validation failures (format / reserved word
 * / duplicate) — drives the inline red border after a blocked save attempt.
 * Derived once per render into a Set (qc3 F-3): a duplicate scan inside the
 * render loop would be O(N²) per row; here the whole derivation is O(N) and
 * each row's check is a single Set lookup. Selector errors stay on the
 * banner only (plan Task 3 inline-scope rule).
 */
function collectInvalidRoleIds(rows: readonly RoleRow[]): Set<string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = row.id.trim()
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const invalid = new Set<string>()
  for (const row of rows) {
    const id = row.id.trim()
    if (!ROLE_ID_PATTERN.test(id) || id === INHERIT_ROLE_ID || (counts.get(id) ?? 0) > 1) {
      invalid.add(id)
    }
  }
  return invalid
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
 * Inline "!" info badge (T3): the detailed explanation rides a primitives
 * Tooltip bubble (side "right", ~300ms hover delay, immediate on keyboard
 * focus) while the short inline hint stays on the row. The badge is an
 * exposed, focusable image — the Models page credential-status pattern
 * (role="img" + aria-label) — so the accessible name is always available;
 * the tooltip is a progressive enhancement on top.
 *
 * `disabled` mirrors the read-only/loading suppression of the surrounding
 * controls: the bubble is suppressed, the badge drops out of the tab order
 * (and its `:disabled` style dims it).
 *
 * Placement contract (QC W-2 fix): the badge is always a **sibling** of the
 * label-text element — never nested inside a `<label>` or an
 * `aria-labelledby`-referenced node — so its aria-label can never leak into
 * a control/group accessible name. A click on the badge therefore has no
 * label-activation default action to cancel.
 */
function InfoHint({ label, disabled = false }: { label: string; disabled?: boolean }): ReactNode {
  return (
    <Tooltip label={label} side="right" delayMs={300} disabled={disabled}>
      <span
        className={disabled ? `${css.infoHint} ${css.infoHintDisabled}` : css.infoHint}
        role="img"
        aria-label={label}
        tabIndex={disabled ? -1 : 0}
      >
        !
      </span>
    </Tooltip>
  )
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
  t: FallbacksCardProps['t']
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
        <span className={css.hint}>
          {t('catalog.outside.hint')}
          <InfoHint label={t('catalog.outside.tooltip')} disabled={disabled} />
        </span>
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
 * Render the Fallbacks settings card inside the plugin-config section,
 * replicating the upstream PluginCard chrome (KD-U1). The body carries the
 * existing form content unchanged plus the folded-in status block and the
 * footer actions (Discard / Reset / Save).
 * @param props - slot-delivered injected dependencies and the synthesized t seat.
 * @returns the card.
 */
export function FallbacksCard({ controller, useSnapshot, t }: FallbacksCardProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  // Initial load: the store starts 'idle' and pushed invalidations only
  // refresh an already-loaded store (`refresh*IfLoaded` skips 'idle'), so the
  // card must pull the descriptor itself on mount. The catalog read is the
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
  // arrives (idle/loading) or while the gateway channel is unreachable
  // (`present: false`). The mount seed is only a placeholder:
  // `seededConfigKey` stays null until the first ready state, and every
  // later ready whose config CONTENT differs (a refresh re-load that landed
  // new server truth) re-seeds — the gateway has no revision stamp, so the
  // config itself is the freshness signal. The draft seed invariant (I-1)
  // holds on both sides: the store never publishes defaults over an
  // accepted real config, and the card never re-seeds identical content.
  // Controls are not gated on `ready` — a channel-down load with
  // `writable: true` leaves the switch/form body editable pre-ready
  // (§1.4-4) — so a mid-edit push (channel recovers → settings/document-updated →
  // refresh → load → ready) overwrites the draft with server truth on the
  // next content-changing ready: unsaved drafts are not preserved across
  // the unreachable→ready upgrade.
  const [scalars, setScalars] = useState<FallbacksScalars>(() => scalarsOf(defaultFallbacksConfig))
  const [rootChainRows, setRootChainRows] = useState<RootChainRow[]>(() => rootChainToRows(defaultFallbacksConfig.rootChain))
  const [roleRows, setRoleRows] = useState<RoleRow[]>(() => rolesToRows(defaultFallbacksConfig.roles.list))
  const [ruleRows, setRuleRows] = useState<RoleRuleRow[]>(() => rulesToRows(defaultFallbacksConfig.roles.rules))
  // Pre-save validation (spec §8): save() validates the assembled draft and
  // a blocked write leaves the messages in the banner with
  // `validationAttempted` true so the offending role-id rows keep their
  // inline red border. Both clear when a save passes validation or the user
  // discards the draft.
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [validationAttempted, setValidationAttempted] = useState(false)
  const seededConfigKey = useRef<string | null>(null)

  useEffect(() => {
    if (state.status !== 'ready') return
    const key = JSON.stringify(state.config)
    if (seededConfigKey.current === key) return
    seededConfigKey.current = key
    setScalars(scalarsOf(state.config))
    setRootChainRows(rootChainToRows(state.config.rootChain, catalogOf(state)))
    setRoleRows(rolesToRows(state.config.roles.list, catalogOf(state)))
    setRuleRows(rulesToRows(state.config.roles.rules, catalogOf(state)))
  }, [state.status, state.config])

  // Reset-to-defaults confirmation (replaces `window.confirm`): the dialog
  // stays open while the replace is in flight — the Models page's
  // delete-confirm pattern. The store's `saving` state also disables the
  // card actions, so a regular save and a reset cannot overlap.
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  // The skeleton always renders inside the open body (readme-settings spec
  // §1.2): the `enabled` switch, the form body (or its off-notice), the
  // status block, and the footer actions are visible in every store state
  // (idle / loading / ready / saving / error). The form body below is gated
  // on the draft's `enabled` flag. Controls are disabled while `writable` is
  // false (initial load, loading, or a read-only describe response), so an
  // empty skeleton never invites edits the host would refuse.

  const updateScalars = (mutator: (draft: FallbacksScalars) => void): void => {
    setScalars(prev => {
      const next: FallbacksScalars = { ...prev, triggerCodes: [...prev.triggerCodes] }
      mutator(next)
      return next
    })
  }

  // The rootChain block is ONE row holding the ordered selector list — no
  // key input (spec §8: 无键输入). `rootChainToRows` always yields a single
  // row, so these helpers operate on its selectors.
  const updateRootChainSelector = (selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    setRootChainRows(rows => rows.map((row, index) => index === 0
      ? { ...row, selectors: row.selectors.map((selector, sIndex) => sIndex === selectorIndex ? { ...selector, ...patch } : selector) }
      : row))
  }

  const addRootChainSelector = (): void => {
    setRootChainRows(rows => rows.map((row, index) => index === 0
      ? { ...row, selectors: [...row.selectors, { wildcard: false, provider: null, model: null }] }
      : row))
  }

  const removeRootChainSelector = (selectorIndex: number): void => {
    setRootChainRows(rows => rows.map((row, index) => index === 0
      ? { ...row, selectors: row.selectors.filter((_, sIndex) => sIndex !== selectorIndex) }
      : row))
  }

  const updateRoleRow = (index: number, patch: Partial<RoleRow>): void => {
    setRoleRows(rows => {
      const next = rows.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }

  const updateRoleSelector = (roleIndex: number, selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    setRoleRows(rows => {
      const next = rows.map(row => ({ ...row, selectors: row.selectors.map(selector => ({ ...selector })) }))
      const selectors = next[roleIndex]!.selectors
      selectors[selectorIndex] = { ...selectors[selectorIndex]!, ...patch }
      return next
    })
  }

  const addRoleSelector = (roleIndex: number): void => {
    setRoleRows(rows => rows.map((row, index) => index === roleIndex
      ? { ...row, selectors: [...row.selectors, { wildcard: false, provider: null, model: null }] }
      : row))
  }

  const removeRoleSelector = (roleIndex: number, selectorIndex: number): void => {
    setRoleRows(rows => rows.map((row, index) => index === roleIndex
      ? { ...row, selectors: row.selectors.filter((_, sIndex) => sIndex !== selectorIndex) }
      : row))
  }

  const addRole = (): void => {
    setRoleRows(rows => [...rows, { id: '', label: '', description: '', selectors: [], fallback: 'inherit-root' }])
  }

  const removeRole = (index: number): void => {
    setRoleRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
  }

  const updateRuleRow = (index: number, patch: Partial<RoleRuleRow>): void => {
    setRuleRows(rows => {
      const next = rows.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }

  // The draft is assembled once per render and reused by the dirty check,
  // the validation gate, and save — `state.config.roles.list` supplies the
  // prompt/permissions merge so a clean draft equals the accepted config.
  const draft = assembleConfig(scalars, rootChainRows, roleRows, ruleRows, state.config.roles.list)
  // Empty rule rows (role still on the "select role" placeholder) never
  // reach the assembled draft — rowsToRules drops them — so validateDraft
  // cannot see them. Surface them as a validation error instead of
  // silently discarding the row on save (qc3 F-4).
  const hasEmptyRuleRows = ruleRows.some(row => row.role === '')
  // An empty rule row makes no config difference, but it IS an unsaved UI
  // change: count it so the unsaved pill, Discard, and Save all treat the
  // row as pending (otherwise Save stays disabled and the row vanishes on
  // the next successful save with no chance to explain itself).
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.config) || hasEmptyRuleRows
  const saving = state.status === 'saving'
  const writable = state.writable
  const unknownCodes = scalars.triggerCodes.filter(code => !KNOWN_TRIGGER_CODES.includes(code))

  // The rules role dropdown's offer set — derived ONCE per render and shared
  // by every rule row (qc3 F-3; previously recomputed inside the render
  // loop): a role added/removed on the same page reflects immediately, and
  // the store dedupes on the canonical (trimmed) ids so mid-edit duplicate
  // ids never render duplicate options.
  const roleOptions = ruleRoleOptions({ list: roleRows })
  // Offending role ids after a blocked save attempt, derived once per render
  // into a Set (qc3 F-3) — each row's inline red border is one lookup.
  const invalidRoleIds = validationAttempted ? collectInvalidRoleIds(roleRows) : null

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

  // Catalog refresh (llm/adapters-updated) re-classifies rows against the fresh
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
    setRootChainRows(rootChainToRows(state.config.rootChain, catalogOf(state)))
    setRoleRows(rolesToRows(state.config.roles.list, catalogOf(state)))
    setRuleRows(rulesToRows(state.config.roles.rules, catalogOf(state)))
  }, [state.catalogStatus, state.catalogEpoch, state.config, dirty])

  const save = (): void => {
    const errors = validateDraft(draft, t)
    // An empty rule row is invisible to validateDraft (rowsToRules dropped
    // it from the draft) — the row would vanish on a successful save with no
    // explanation. Block it alongside the draft violations (qc3 F-4); the
    // row keeps its inline hint so the user sees why.
    if (hasEmptyRuleRows) {
      errors.push(t('validation.ruleRoleRequired'))
    }
    if (errors.length > 0) {
      // Validation blocks the write: the draft is never sent to the gateway,
      // and the violations surface as the banner + inline red borders (spec
      // §8 — the store's `state.error` data path stays untouched).
      setValidationErrors(errors)
      setValidationAttempted(true)
      return
    }
    setValidationErrors([])
    setValidationAttempted(false)
    void controller.save(draft)
  }

  // Discard is a pure client-side revert to the last accepted config (no
  // gateway write — upstream semantics); the upstream disabled term
  // `!dirty || saving` applies (no `!writable`: in read-only the draft can
  // still hold staged edits from before a mid-session writable flip, and a
  // client-side revert is always safe).
  const discard = (): void => {
    setScalars(scalarsOf(state.config))
    setRootChainRows(rootChainToRows(state.config.rootChain, catalogOf(state)))
    setRoleRows(rolesToRows(state.config.roles.list, catalogOf(state)))
    setRuleRows(rulesToRows(state.config.roles.rules, catalogOf(state)))
    // The draft reverted to the accepted config: any blocked-validation
    // banner/inline marks no longer describe the current draft.
    setValidationErrors([])
    setValidationAttempted(false)
  }

  // Live-clear the blocked-save presentation once the draft is valid again:
  // a user fixing the offending field would otherwise stare at a stale
  // "save was blocked" banner over a now-valid draft (the Save action is
  // dirty-gated, so the next attempt may never fire).
  useEffect(() => {
    if (!validationAttempted) return
    // The empty-rule-row violation lives outside the draft (rowsToRules
    // dropped the row), so it must clear on the ROW state, not just the
    // assembled draft (qc3 F-4).
    if (validateDraft(draft, t).length === 0 && !ruleRows.some(row => row.role === '')) {
      setValidationErrors([])
      setValidationAttempted(false)
    }
  }, [validationAttempted, draft, ruleRows, t])

  const confirmReset = (): void => {
    setResetting(true)
    // The controller never rejects — failures land in the store as the
    // `error` state and surface in the card's error notice; either way
    // the dialog closes once the store settles.
    void controller.resetToDefaults().finally(() => {
      setResetting(false)
      setConfirmingReset(false)
    })
  }

  // Disclosure is card-local USER state (upstream rationale): the healthy
  // card starts collapsed and opens on the header click only. The degraded
  // (`ready && !present` — gateway channel unreachable) and error cards
  // render their notice body ALWAYS visible (AC-1 — the notice must appear
  // without interaction), so `open` is DERIVED from the current snapshot —
  // never from a mount-time snapshot read and never through a useEffect
  // (I-1): the mount-time snapshot is the store default ('idle',
  // present=false), so a mount-time read would wrongly start the healthy
  // card open.
  // `present` is only written by the store's `accept()`, so a settled
  // `ready` read is authoritative; during a refresh/save window
  // (`loading`/`saving`) the open derivation falls back to a card-local
  // LATCH of the last settled degraded value (the advisor qc1 S-2 pattern,
  // implemented in the card because the store stays untouched) — without it
  // the notice body would collapse every time a degraded card refreshes.
  // The latch update is a deterministic render-time write: it only runs on
  // the settled `ready` snapshot and stores the same value every render of
  // that snapshot.
  // The error term gets the same latch treatment (qc2 S-1): a settled
  // `error` (initial-load failure, save rejection) forces the card open
  // with the error notice; the latch keeps the body open through the
  // Retry→loading window — an unlatched `state.status === 'error'` term
  // would collapse the body the moment Retry flips status to 'loading' (the
  // user never opened the card, so `userOpen` is false) and hide the error
  // notice mid-flight. It releases on the next settled `ready` — the
  // successful state transition — so a recovered card collapses like any
  // healthy card.
  const [userOpen, setUserOpen] = useState(false)
  const degradedLatch = useRef(false)
  const errorLatch = useRef(false)
  if (state.status === 'ready') {
    degradedLatch.current = !state.present
    errorLatch.current = false
  } else if (state.status === 'error') {
    errorLatch.current = true
  }
  const degraded = state.status === 'ready' ? !state.present : degradedLatch.current
  const open = userOpen || errorLatch.current || degraded

  const title = t('title')
  const header = (
    <button
      type="button"
      className={css.header}
      aria-expanded={open}
      aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
      // The click toggles `userOpen` only, gated to the user-collapsible
      // (healthy) state (advisor qc3 S-1): while degraded/error the derived
      // open is forced true, so the click must be a NO-OP — toggling userOpen
      // would silently latch it and pre-open the recovered form, and the
      // "collapse" aria-label would announce an action the control cannot
      // perform. The header stays focusable; aria-expanded stays true.
      onClick={() => { if (!degraded && state.status !== 'error') setUserOpen(!userOpen) }}
    >
      <span className={css.headText}>
        <span className={css.name}>{title}</span>
        <span className={css.description}>{t('intro')}</span>
      </span>
      {dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
      <IconChevronDownOutline14
        className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron}
      />
    </button>
  )

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      {header}
      {open && (
        <div className={css.body}>
          {/* Migration banner (spec §8): the wire's legacyKeys detected
              two-block-era leftovers → an informational notice at the top of
              the card body. Never blocks editing and never touches disk —
              a save MERGES over the user layer (W-1/F-1), so legacy keys
              survive until manually removed; the banner stays until a get
              reports them gone. */}
          {state.legacyKeys.length > 0 && (
            <p className={css.legacyNotice} role="status">
              {t('legacy.banner', { keys: state.legacyKeys.join(', ') })}
            </p>
          )}
          {state.status === 'error' && state.error !== null && (
            <div className={css.noticeRow}>
              <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
              {/* Retry only when the form is inert (the load never landed):
                  with writable the form itself is the retry surface (Save),
                  and a reload would clobber staged edits. */}
              {!state.writable && (
                <Button variant="outline" size="sm" onClick={() => { void controller.load() }}>
                  {t('retry')}
                </Button>
              )}
            </div>
          )}
          {validationErrors.length > 0 && (
            // Pre-save validation blocked the last save attempt (spec §8):
            // the same error presentation as the store error banner, but the
            // store's `state.error` data path stays untouched — the draft
            // was never sent. The inline red borders on the offending role
            // id rows ride `validationAttempted`.
            <p className={css.error} role="alert">
              {`${t('validation.blocked')}${validationErrors.join('; ')}`}
            </p>
          )}
          {degraded && (
            // Gateway channel unreachable (KD-G5 — the fallbacks config rides
            // the plugin gateway, not describe): an informational notice — the
            // card stays the usable skeleton (last accepted config, or the
            // defaults on a first load) and saves are attempted; failures land
            // in the error notice above.
            <p className={css.notice} role="status">{t('unavailable')}</p>
          )}
          {state.status === 'ready' && !state.writable && (
            // The host describe said read-only. Gated on `ready`: the initial
            // idle/loading window has `writable:false` and must not flash a
            // read-only notice on a card that simply has not loaded yet
            // (upstream/advisor read the notice from a settled store).
            <p className={css.readOnly} role="status">{t('readOnly')}</p>
          )}

          {/* The form body sits directly in the card body (the upstream cards
           * stack their controls in the body); the container only paces the
           * content below the divider. The `enabled` switch is a row-level
           * preference (the advisor checkboxRow rhythm): label text on the
           * left, the native checkbox on the right, no separator line — the
           * panel has no switch primitive, and the checkbox semantics are the
           * behavior the spec pins. */}
          <div className={css.form}>
            <div className={css.checkboxRow}>
              <div className={css.checkLabel}>
                <span className={css.checkLabelTitle}>
                  <label htmlFor="fallbacks-enabled">{t('enabled.label')}</label>
                  <InfoHint label={t('enabled.tooltip')} disabled={!writable} />
                </span>
                <span className={css.checkLabelDesc}>{t('enabled.hint')}</span>
              </div>
              <input
                id="fallbacks-enabled"
                type="checkbox"
                className={css.checkbox}
                checked={scalars.enabled}
                disabled={!writable}
                onChange={event => { updateScalars(draft => { draft.enabled = event.target.checked }) }}
              />
            </div>

            {/* Enabled OFF (readme-settings spec §1.2): the form body is hidden
             * but never discarded — the draft stays in state and comes right
             * back when the switch is toggled on. */}
            {!scalars.enabled && (
              <p className={css.offNotice}>{t('enabled.off')}</p>
            )}

            {scalars.enabled && (
            /* The form body is one fieldset without a legend: the enabled
             * toggle above it is the group's question (the advisor fieldset).
             * `disabled` propagates to every control inside — read-only/loading
             * describes keep the whole body inert. The multi-control groups
             * (triggerCodes / revertPolicy / chains / roles) keep the group
             * labels the previous per-group legends provided via role="group" +
             * aria-labelledby. */
            <fieldset className={css.fieldset} disabled={!writable}>
              <div className={css.field} role="group" aria-labelledby="fallbacks-trigger-codes">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-trigger-codes">{t('triggerCodes.label')}</span>
                  <InfoHint label={t('triggerCodes.tooltip')} disabled={!writable} />
                </span>
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

              <div className={css.field} role="group" aria-labelledby="fallbacks-revert-policy">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-revert-policy">{t('revertPolicy.label')}</span>
                  <InfoHint label={t('revertPolicy.tooltip')} disabled={!writable} />
                </span>
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
                <div className={css.field}>
                  <span className={css.fieldLabel}>
                    <label htmlFor="fallbacks-cooldown-ms">{t('cooldownMs.label')}</label>
                    <InfoHint label={t('cooldownMs.tooltip')} disabled={!writable} />
                    <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.cooldownMs}</span>
                  </span>
                  <input
                    id="fallbacks-cooldown-ms"
                    className={css.input}
                    type="number"
                    min={0}
                    value={String(scalars.cooldownMs)}
                    disabled={!writable}
                    onChange={event => { updateScalars(draft => { draft.cooldownMs = parseCount(event.target.value) }) }}
                  />
                  <span className={css.hint}>{t('cooldownMs.hint')}</span>
                </div>

                <div className={css.field}>
                  <span className={css.fieldLabel}>
                    <label htmlFor="fallbacks-max-switches">{t('maxSwitchesPerStep.label')}</label>
                    <InfoHint label={t('maxSwitchesPerStep.tooltip')} disabled={!writable} />
                    <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.maxSwitchesPerStep}</span>
                  </span>
                  <input
                    id="fallbacks-max-switches"
                    className={css.input}
                    type="number"
                    min={0}
                    value={String(scalars.maxSwitchesPerStep)}
                    disabled={!writable}
                    onChange={event => { updateScalars(draft => { draft.maxSwitchesPerStep = parseCount(event.target.value) }) }}
                  />
                  <span className={css.hint}>{t('maxSwitchesPerStep.hint')}</span>
                </div>

                <div className={css.field}>
                  <span className={css.fieldLabel}>
                    <label htmlFor="fallbacks-always-cap">{t('alwaysModeRetryCap.label')}</label>
                    <InfoHint label={t('alwaysModeRetryCap.tooltip')} disabled={!writable} />
                    <span className={css.defaultNote}>{t('defaults.prefix')}: {state.config.alwaysModeRetryCap}</span>
                  </span>
                  <input
                    id="fallbacks-always-cap"
                    className={css.input}
                    type="number"
                    min={0}
                    value={String(scalars.alwaysModeRetryCap)}
                    disabled={!writable}
                    onChange={event => { updateScalars(draft => { draft.alwaysModeRetryCap = parseCount(event.target.value) }) }}
                  />
                  <span className={css.hint}>{t('alwaysModeRetryCap.hint')}</span>
                </div>
              </div>

              <div className={css.field} role="group" aria-labelledby="fallbacks-root-chain">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-root-chain">{t('rootChain.label')}</span>
                  <InfoHint label={t('rootChain.tooltip')} disabled={!writable} />
                </span>
                <span className={css.hint}>{t('rootChain.hint')}</span>
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
                {/* Block 1 (spec §8): ONE row holding the ordered selector
                 * list — no key input, the row IS the chain. */}
                <div className={css.list}>
                  {rootChainRows.map((row, rowIndex) => (
                    <div key={rowIndex} className={css.editorCard}>
                      <div className={css.chainSelectors}>
                        {row.selectors.map((selector, selectorIndex) => (
                          <ChainSelectorEditor
                            key={selectorIndex}
                            selector={selector}
                            catalog={catalogOf(state)}
                            configuredProviders={state.configuredProviders}
                            disabled={!writable}
                            t={t}
                            onChange={patch => { updateRootChainSelector(selectorIndex, patch) }}
                            onRemove={() => { removeRootChainSelector(selectorIndex) }}
                          />
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        icon={<IconPlusOutline16 size={14} />}
                        className={css.addButton}
                        onClick={addRootChainSelector}
                      >
                        {t('rootChain.selector.add')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className={css.field} role="group" aria-labelledby="fallbacks-roles-list">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-roles-list">{t('roles.list.label')}</span>
                  <InfoHint label={t('roles.list.tooltip')} disabled={!writable} />
                </span>
                <span className={css.hint}>{t('roles.list.hint')}</span>
                {/* Block 2a (spec §8): declared role entities — identity text
                 * fields, the role's own chain selectors, the append
                 * strategy, removal. prompt/permissions are schema-reserved
                 * and never rendered this round. The id input carries the
                 * format hint inline; a blocked save attempt marks offending
                 * ids with the red border (aria-invalid). */}
                <div className={css.list}>
                  {roleRows.map((row, index) => {
                    const invalid = invalidRoleIds?.has(row.id.trim()) ?? false
                    return (
                    <div key={index} className={css.editorCard}>
                      <div className={css.ruleGrid}>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('roles.id')}</span>
                          <input
                            className={`${css.input} ${invalid ? css.inputInvalid : ''}`}
                            value={row.id}
                            placeholder={t('roles.idPlaceholder')}
                            aria-label={t('roles.id')}
                            aria-invalid={invalid ? true : undefined}
                            disabled={!writable}
                            onChange={event => { updateRoleRow(index, { id: event.target.value }) }}
                          />
                          <span className={css.hint}>{t('roles.id.hint')}</span>
                        </div>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('roles.label')}</span>
                          <input
                            className={css.input}
                            value={row.label}
                            aria-label={t('roles.label')}
                            disabled={!writable}
                            onChange={event => { updateRoleRow(index, { label: event.target.value }) }}
                          />
                        </div>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('roles.description')}</span>
                          <input
                            className={css.input}
                            value={row.description}
                            aria-label={t('roles.description')}
                            disabled={!writable}
                            onChange={event => { updateRoleRow(index, { description: event.target.value }) }}
                          />
                        </div>
                      </div>
                      <div className={css.chainSelectors}>
                        {row.selectors.map((selector, selectorIndex) => (
                          <ChainSelectorEditor
                            key={selectorIndex}
                            selector={selector}
                            catalog={catalogOf(state)}
                            configuredProviders={state.configuredProviders}
                            disabled={!writable}
                            t={t}
                            onChange={patch => { updateRoleSelector(index, selectorIndex, patch) }}
                            onRemove={() => { removeRoleSelector(index, selectorIndex) }}
                          />
                        ))}
                        {row.selectors.every(selector => selectorRowToRaw(selector) === '') && (
                          // A role whose chain area is empty — no selector
                          // rows, or only blank placeholder rows — has no
                          // model config: save is blocked (roleChainRequired);
                          // the inline hint explains why (plan
                          // fallbacks-feedback-round T2), unconditional while
                          // no row serializes to a usable chain entry.
                          <span className={css.hint}>{t('validation.roleChainRequired', { id: row.id })}</span>
                        )}
                      </div>
                      <div className={css.ruleGrid}>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('roles.fallback')}</span>
                          <select
                            className={`${css.input} ${css.selectInput}`}
                            value={row.fallback}
                            aria-label={t('roles.fallback')}
                            disabled={!writable}
                            onChange={event => { updateRoleRow(index, { fallback: event.target.value as FallbackStrategy }) }}
                          >
                            <option value="inherit-root">{t('roles.fallback.inherit-root')}</option>
                            <option value="none">{t('roles.fallback.none')}</option>
                          </select>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        icon={<IconPlusOutline16 size={14} />}
                        className={css.addButton}
                        onClick={() => { addRoleSelector(index) }}
                      >
                        {t('roles.selector.add')}
                      </Button>
                      <div className={css.cardFoot}>
                        <button
                          type="button"
                          className={`${css.iconButton} ${css.iconButtonDanger}`}
                          data-tip={t('roles.remove')}
                          aria-label={t('roles.remove')}
                          onClick={() => { removeRole(index) }}
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
                  onClick={addRole}
                >
                  {t('roles.add')}
                </Button>
              </div>

              <div className={css.field} role="group" aria-labelledby="fallbacks-roles-rules">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-roles-rules">{t('roles.rules')}</span>
                  <InfoHint label={t('roles.rules.tooltip')} disabled={!writable} />
                </span>
                <span className={css.hint}>{t('roles.rules.hint')}</span>
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
                    // roleOptions is hoisted once per render (qc3 F-3): the
                    // offer set derives LIVE from the declared role rows —
                    // a role added/removed on the same page is reflected
                    // immediately (spec §8 同页联动). A role deleted under
                    // a referencing rule leaves the row's value orphaned —
                    // it stays visible as a synthetic "undeclared" option
                    // so the dangling reference is honest, and save()'s
                    // validation flags it. The offer set uses the same
                    // canonical (trimmed) ids that rowsToRoles/rowsToRules
                    // rebuild, so what the dropdown offers is exactly what
                    // save-time validation accepts.
                    const roleOutside = row.role !== '' && !roleOptions.includes(row.role)
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
                          <select
                            className={`${css.input} ${css.selectInput}`}
                            value={row.role}
                            disabled={!writable}
                            onChange={event => { updateRuleRow(index, { role: event.target.value }) }}
                          >
                            <option value="">{t('roles.rule.roleSelectPlaceholder')}</option>
                            {roleOptions.map(id => (
                              <option key={id} value={id}>{id === INHERIT_ROLE_ID ? t('roles.rule.role.inherit') : id}</option>
                            ))}
                            {roleOutside && (
                              <option value={row.role}>{`${row.role}${t('roles.rule.roleUndeclared.short')}`}</option>
                            )}
                          </select>
                        </label>
                      </div>
                      {(providerOutside || modelOutside) && (
                        <span className={css.hint}>
                          {t('catalog.outside.hint')}
                          <InfoHint label={t('catalog.outside.tooltip')} disabled={!writable} />
                        </span>
                      )}
                      {row.role === '' && (
                        // qc3 F-4: an empty role row would be dropped by
                        // rowsToRules on assembly and vanish on save — the
                        // inline hint explains why save is blocked.
                        <span className={css.hint}>{t('validation.ruleRoleRequired')}</span>
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
          </div>

          {/* AC-7 read-only status, compact and folded into the card body
           * (above the footer — the page-bottom block is gone): the derived
           * "current effective model" (D-6 — a display value from config +
           * recent switches, never a live route probe; note ⑤ rides inline)
           * and the most recent switch (D-5 — read through the store's
           * `sessions.history` face). The verbose config-summary dump is
           * gone; errors/empty still render, compact. */}
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
            {/* Plan llm-fallbacks-runtime-depatch T2 (degradation): the marker
             * coordination shipped with the local dsh-agent patch is removed, so
             * a model manually selected in the web front end may be re-applied
             * over a fallback switch. Honest one-line note (zh + en). */}
            <p className={css.statusLine}>{t('status.selectionNote')}</p>
          </div>

          {/* Discard / Reset / Save: the upstream footer (failed message +
           * discard + save) with the fallbacks Reset per the current UX — the
           * actions keep the h36 r18 capsule vocabulary (settings-page
           * standard), right-aligned at the card bottom. */}
          <div className={css.footer}>
            <button
              type="button"
              className={css.secondaryButton}
              disabled={!dirty || saving}
              onClick={discard}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className={css.secondaryButton}
              disabled={!writable || saving}
              onClick={() => { setConfirmingReset(true) }}
            >
              {t('reset')}
            </button>
            <button
              type="button"
              className={css.primaryButton}
              disabled={!writable || saving || !dirty}
              onClick={save}
            >
              {saving ? t('save.saving') : t('save')}
            </button>
          </div>
        </div>
      )}

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
    </li>
  )
}
