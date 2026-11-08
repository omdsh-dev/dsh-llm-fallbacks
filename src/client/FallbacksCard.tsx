/**
 * Fallbacks settings card — the `fallbacks` plugin card on the web Plugins
 * page (named virtual chains, plan named-virtual-chains T5; the FROZEN UI
 * mockup `.mstar/design/named-virtual-chains/settings-mockup.html`).
 *
 * Flat form vocabulary unchanged: fields at 12px vertical padding with 0.5px
 * hairline separators, 34px inputs on the 0.5px l4 border, per-section
 * Discard + Save pairs. The 虚拟链 group is TAB-PER-CHAIN: underline tabs on
 * the 0.5px l2 hairline (active label = label-primary + 2px brand underline,
 * dirty pip, error "!" mark), a "+" add affordance and a "⋯" chain menu
 * (delete, ≥1 chain), WAI-ARIA tabs with roving tabindex.
 * Each tab body carries 链名称 (the single label editor — the ⋯ menu binds to
 * the same draft field) followed by the SHIPPED block order 分时槽设置 →
 * 默认降级链 → 默认模型（链尾） plus a per-tab Discard/Save writing ONLY that
 * chain (block ids per chain, error text under the owning block).
 *
 * The 子代理 section is role cards: id + persona + 指定降级链 (a MANUAL
 * named-chain pointer; 未指定（沿用 dsh 默认） = the plugin does not
 * intervene). No rules, no per-role chain entries, no host-policy block.
 * The 高级选项 group is unchanged; the 运行状态（只读） block and the
 * General settings row are REMOVED with the client switch-history read.
 *
 * Validation blocks the owning save only: chain id format/duplicates,
 * missing label, per-chain slot guards, tail conformance, role id checks.
 * A non-empty `state.legacyKeys` renders the migration banner at the top.
 *
 * Presentation stays ui-primitives-free: inline SVG icons and the CSS
 * `data-tip` tooltip bubble; every color resolves through a
 * `--dsw-alias-*` token (light/dark parity).
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { FallbacksConfig, FallbacksRole, NamedChain, RevertPolicy } from '../config.ts'
import { CHAIN_ID_PATTERN, ROLE_ID_PATTERN, defaultFallbacksConfig } from '../config.ts'
import { parseSelector } from '../selectors.ts'
import { isOfficialAllDayId, OFFICIAL_ALL_DAY_IDS } from '../time-slots.ts'
import {
  FallbacksSettingsController,
  chainsToDrafts,
  classifyModel,
  classifyProvider,
  draftToChain,
  entryToSelectorRow,
  mergeRoleExtras,
  newChainId,
  rolesToRows,
  rowsToTimeSlots,
  selectionToRaw,
  selectorRowToRaw,
  timeSlotsToRows,
  type CatalogLookup,
  type ChainDraft,
  type ChainSelectorRow,
  type FallbacksSettingsState,
  type RoleRow,
  type SlotEditorRow,
} from './fallbacks-store.ts'
import { resolveSlotState } from '../time-slots.ts'
import {
  KNOWN_TRIGGER_CODES,
  TRIGGER_CODE_LABELS,
  withTriggerCode,
  type FallbacksKey,
} from './locales.ts'
import css from './FallbacksCard.module.css'

function collectInvalidRoleIds(rows: readonly RoleRow[]): Set<string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = row.id.trim()
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const invalid = new Set<string>()
  for (const row of rows) {
    const id = row.id.trim()
    if (!ROLE_ID_PATTERN.test(id) || id === 'inherit' || (counts.get(id) ?? 0) > 1) {
      invalid.add(id)
    }
  }
  return invalid
}

// The official all-day tail set is imported from the pure `src/time-slots.ts`
// module — the legal set is declared once and the card derives its
// validation and the 默认模型 radio list from it. Display labels live in
// `locales.ts` (keys parallel to OFFICIAL_ALL_DAY_IDS below).
const ALL_DAY_LABEL_KEYS = ['allDay.flash', 'allDay.pro'] as const
const SLOT_PRESET_IDS = ['liang-peak', 'liang-valley', 'glm-peak', 'glm-valley'] as const
/** Custom-row day toggle order (index = weekday, 0=Sunday); display copy lives in the dictionaries. */
const SLOT_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** The disclosure chevron (12px) — content-level row/panel toggles only. */
function ChevronDownIcon({ className }: { className?: string }): ReactNode {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The plus glyph (14px default) for the inline add buttons. */
function PlusIcon({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 2.25V9.75M2.25 6H9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** The trash glyph (14px) for the row removals. */
function TrashIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 3.5H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M4.75 3.25V2.5C4.75 2.22386 4.97386 2 5.25 2H6.75C7.02614 2 7.25 2.22386 7.25 2.5V3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M3.5 3.5L3.87464 9.24692C3.91109 9.80186 4.36905 10.2333 4.92513 10.2333H7.07487C7.63095 10.2333 8.08891 9.80186 8.12536 9.24692L8.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M5.1 5.4V8.4M6.9 5.4V8.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** The vertical grip (⋮) for the slot-row drag handle. */
function GripIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="2.4" r="0.95" fill="currentColor" />
      <circle cx="6" cy="6" r="0.95" fill="currentColor" />
      <circle cx="6" cy="9.6" r="0.95" fill="currentColor" />
    </svg>
  )
}

/** IANA timezone of this renderer (browser / host). */
function hostTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' && tz !== '' ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** `UTC+8` / `UTC-4` for an IANA id (current offset, DST-honest). */
function tzUtcOffset(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find(part => part.type === 'timeZoneName')?.value
    if (name === undefined || name === '') return ''
    return name.replace(/^GMT/, 'UTC')
  } catch {
    return ''
  }
}

/** Read-only custom-row copy: `Asia/Shanghai (UTC+8)`. */
function tzDisplayLabel(tz: string): string {
  const offset = tzUtcOffset(tz)
  return offset === '' ? tz : `${tz} (${offset})`
}

/** Persist tz: presets lock UTC+8; custom-only uses the host zone; else keep the accepted value. */
function resolvedSlotTz(rows: readonly SlotEditorRow[], fallback: string): string {
  if (rows.some(row => row.kind === 'preset')) return 'Asia/Shanghai'
  if (rows.some(row => row.kind === 'custom')) return hostTimeZone()
  return fallback === '' ? 'Asia/Shanghai' : fallback
}

/** Strict 24h `HH:mm` — the resolver's HHMM_RE twin (drift-guarded by the gateway reject-on-save). */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * The 默认模型 value for a chain: the official id when the chain TAIL
 * is that model (Flash or Pro XOR — leading 默认降级链 entries allowed);
 * `''` for an empty chain or a chain whose last entry is not official
 * (the panel reads back unselected and save validation blocks the value).
 */
function allDayModelOf(chain: readonly string[]): string {
  const tail = chain.length >= 1 ? chain[chain.length - 1] : undefined
  return tail !== undefined && isOfficialAllDayId(tail) ? tail : ''
}

/** Injected dependencies of {@link FallbacksCard} (slot `inject`). */
export interface FallbacksCardInjected {
  /** The card store (loaded on mount, refreshed on pushed invalidations). */
  controller: FallbacksSettingsController
  /** Bare snapshot source the renderer binds as `useSnapshot`. */
  hooks: {
    snapshot: import('@deepseek-ai/dsh-client-store').SnapshotStore<FallbacksSettingsState>
  }
}

/** Props delivered by the slot outlet: runtime share + locale seat + inject face. */
export type FallbacksCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'fallbacks'>
  & InjectFace<FallbacksCardInjected>

/** Scalar (non-row) fields of the form draft. */
interface FallbacksScalars {
  triggerCodes: string[]
  cooldownMs: number
  revertPolicy: RevertPolicy
  maxSwitchesPerStep: number
  tz: string
}

function scalarsOf(config: FallbacksConfig): FallbacksScalars {
  return {
    triggerCodes: [...config.triggerCodes],
    cooldownMs: config.cooldownMs,
    revertPolicy: config.revertPolicy,
    maxSwitchesPerStep: config.maxSwitchesPerStep,
    tz: config.tz ?? 'Asia/Shanghai',
  }
}

/** Validation buckets: one PER CHAIN (the tab error mark + per-tab save
 * gate), plus the roles and advanced sections. */
interface ValidationBuckets {
  chains: string[][]
  roles: string[]
  advanced: string[]
}

/** One live seed entry's card-facing bits (trimmed-id keyed, wire `seeds`). */
interface SeedRowInfo {
  overridden: boolean
  source?: string
}

/** Badge label for one row's provenance; `null` = no badge (version skew). */
function seedBadgeLabel(seed: SeedRowInfo | undefined, t: FallbacksCardProps['t']): string | null {
  if (seed === undefined) return t('roles.seedSource.user')
  if (seed.source === undefined) return null
  if (seed.source === 'bundled') return t('roles.seedSource.bundled')
  if (seed.source === 'external') return t('roles.seedSource.external')
  if (seed.source === 'user') return t('roles.seedSource.user')
  return seed.source
}

/**
 * Per-chain validation (named virtual chains): chain id format/duplicates +
 * label presence, the 默认模型 tail conformance, selector legality across
 * entries and slot rows, and the per-chain slot-row guards. Roles: id
 * format/reserved/duplicates. Advanced scalars are never validated.
 */
function validateDraft(
  chains: readonly NamedChain[],
  roles: readonly FallbacksRole[],
  t: FallbacksCardProps['t'],
): ValidationBuckets {
  const chainBuckets: string[][] = chains.map(() => [])
  const seenIds = new Set<string>()
  chains.forEach((chain, index) => {
    const bucket = chainBuckets[index]!
    if (!CHAIN_ID_PATTERN.test(chain.id)) bucket.push(t('validation.chainIdFormat', { id: chain.id }))
    if (seenIds.has(chain.id)) bucket.push(t('validation.chainIdDuplicate', { id: chain.id }))
    seenIds.add(chain.id)
    if (chain.label === '') bucket.push(t('validation.chainLabelRequired', { id: chain.id }))
    // 默认模型（链尾）：required — the entries must END with exactly one
    // official model (Flash or Pro XOR); empty is legal to EDIT (the picker
    // row still registers) but blocks that chain's save.
    const tail = chain.entries.length >= 1 ? chain.entries[chain.entries.length - 1] : undefined
    if (tail === undefined || !isOfficialAllDayId(tail)) {
      bucket.push(t('validation.allDayRequired'))
    }
    for (const entry of chain.entries) {
      try {
        parseSelector(entry)
      } catch (error) {
        bucket.push(t('validation.selector', { entry, message: (error as Error).message }))
      }
    }
    const seenSlotPresets = new Set<string>()
    for (const row of chain.timeSlots ?? []) {
      if (row.kind !== 'preset' && row.kind !== 'custom') bucket.push(t('validation.slotKind'))
      if (row.kind === 'preset') {
        if (typeof row.preset !== 'string' || !(SLOT_PRESET_IDS as readonly string[]).includes(row.preset)) {
          bucket.push(t('validation.slotPresetUnknown', { preset: row.preset }))
        } else if (seenSlotPresets.has(row.preset)) {
          bucket.push(t('validation.slotPresetDuplicate', { preset: row.preset }))
        } else {
          seenSlotPresets.add(row.preset)
        }
        if (row.start !== undefined || row.end !== undefined || (row.days !== undefined && row.days.length > 0)) {
          bucket.push(t('validation.slotPresetFrozen'))
        }
      } else if (row.kind === 'custom') {
        if (typeof row.start !== 'string' || typeof row.end !== 'string' || !HHMM_RE.test(row.start) || !HHMM_RE.test(row.end)) {
          bucket.push(t('validation.slotWindow'))
        }
        if (row.days !== undefined && row.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
          bucket.push(t('validation.slotDays'))
        }
      }
      for (const entry of row.chain) {
        try {
          parseSelector(entry)
        } catch (error) {
          bucket.push(t('validation.selector', { entry, message: (error as Error).message }))
        }
      }
      if (row.chain.length === 0) bucket.push(t('validation.slotChainRequired'))
    }
  })
  const roleErrors: string[] = []
  const declaredIds = new Set<string>()
  for (const role of roles) {
    if (!ROLE_ID_PATTERN.test(role.id)) roleErrors.push(t('validation.roleIdFormat', { id: role.id }))
    if (role.id === 'inherit') roleErrors.push(t('validation.roleIdReserved'))
    if (declaredIds.has(role.id)) roleErrors.push(t('validation.roleIdDuplicate', { id: role.id }))
    declaredIds.add(role.id)
  }
  return { chains: chainBuckets, roles: roleErrors, advanced: [] }
}

/** Parse a number input, clamped to a non-negative integer. */
function parseCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? 0 : Math.max(0, parsed)
}

/**
 * Custom time-slot rows whose window is not valid `HH:mm` — drives the
 * inline red border on the start/end inputs (same derivation pattern as
 * {@link collectInvalidRoleIds}: one pass per render, index lookup per row).
 */
function collectInvalidSlotRows(rows: readonly SlotEditorRow[]): Set<number> {
  const invalid = new Set<number>()
  rows.forEach((row, index) => {
    if (row.kind === 'preset') return
    if (!HHMM_RE.test(row.start) || !HHMM_RE.test(row.end)) invalid.add(index)
  })
  return invalid
}

/** The catalog faces the dropdowns classify against; undefined while unready. */
function catalogOf(state: FallbacksSettingsState): CatalogLookup | undefined {
  return state.catalogStatus === 'ready' ? { providers: state.providers, groups: state.groups } : undefined
}

/**
 * Inline info mark (T3): a neutral `i` on the tertiary tone — four of them
 * on one screen read as information, not as four validation errors. The
 * detailed explanation rides a CSS `data-tip` bubble (the card's self-drawn
 * tooltip pattern — T4 replaces the primitives Tooltip; anchored to the
 * RIGHT of the mark, the original primitives side="right" contract) while
 * the short inline hint stays on the row. The mark is an exposed, focusable
 * image — the Models page credential-status pattern (role="img" +
 * aria-label) — so the accessible name is always available; the bubble is a
 * progressive enhancement on top.
 *
 * `disabled` mirrors the read-only/loading suppression of the surrounding
 * controls: the bubble is suppressed, the mark drops out of the tab order
 * (and its `:disabled` style dims it).
 *
 * Placement contract (QC W-2 fix): the mark is always a **sibling** of the
 * label-text element — never nested inside a `<label>` or an
 * `aria-labelledby`-referenced node — so its aria-label can never leak into
 * a control/group accessible name. A click on the mark therefore has no
 * label-activation default action to cancel.
 */
function InfoHint({ label, disabled = false }: { label: string; disabled?: boolean }): ReactNode {
  return (
    <span
      className={disabled ? `${css.infoHint} ${css.infoHintDisabled}` : css.infoHint}
      role="img"
      aria-label={label}
      data-tip={label}
      tabIndex={disabled ? -1 : 0}
    >
      i
    </span>
  )
}

/**
 * The virtual all-fallbacks route the host carve-out recognizes (features.md):
 * a subagent spawned on it is not allowlist-filtered, so it is the
 * recommendation when the allowlist does not already carry it.
 */
const VIRTUAL_ALL_ROUTE = { provider: 'FallbacksChain', model: 'Auto' } as const

/**
 * Parse one raw selector into an exact route; wildcard and unparseable
 * entries resolve to `undefined` (they are not exact routes — never expanded,
 * never counted). The selector parser is the single grammar authority.
 */
function exactRouteOf(raw: string): { provider: string; model: string } | undefined {
  let parsed
  try {
    parsed = parseSelector(raw)
  } catch {
    return undefined
  }
  return parsed.model === undefined ? undefined : { provider: parsed.provider, model: parsed.model }
}

/**
 * The whole chain as one line (plan fallbacks-chain-reorder T2, user request):
 * every non-blank entry in walk order joined with `>`, or `undefined` for an
 * empty/blank chain so the caller keeps its own summary (a role's raw strategy
 * token). The card ellipsizes long summaries; the full string rides `title`.
 *
 * With `allowedModels` (host policy enabled) exact entries the policy cannot
 * use are dropped, so the title tells the truth about what will run; wildcard
 * entries stay (their resolved routes are unknown client-side) and an
 * unparseable entry is kept rather than hidden.
 */
function chainSummary(selectors: readonly ChainSelectorRow[]): string | undefined {
  const entries = selectors.map(selectorRowToRaw).filter(entry => entry !== '')
  return entries.length === 0 ? undefined : entries.join(' > ')
}

/**
 * Pure chain reorder (plan fallbacks-chain-reorder T1): a copy of `list` with
 * the entry at `from` re-inserted at `to`; an out-of-range or same-position
 * move returns `list` untouched (the end-clamping the keyboard and the drop
 * handler both rely on).
 */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/**
 * Reorder affordances a chain row receives from its list (plan
 * fallbacks-chain-reorder T1): the row is the DROP target, the trailing grip
 * is the only drag source, and the grip's ArrowUp/ArrowDown route through the
 * same `onKeyMove`. State lives in {@link ChainSelectorList}, so one chain's drag
 * never touches a sibling list.
 */
interface ChainSelectorReorder {
  dragging: boolean
  dropTarget: boolean
  /** A grip drag of THIS list is in progress — the only drops the row accepts. */
  active: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
  /**
   * Keyboard move of the entry at 0-based `from` to `to`, plus the focus
   * hand-off: the list moves focus to the grip at `to` after the reorder
   * render, so the next press walks the SAME entry instead of whatever
   * position it left behind.
   */
  onKeyMove: (from: number, to: number) => void
  /** Registers this row's grip so the list can hand focus over after a move. */
  gripRef: (node: HTMLButtonElement | null) => void
}

/**
 * One chain entry selector row: provider select + model select (cascade).
 * The row is ONE compact line (plan fallbacks-chain-row-compact T1): the
 * 1-based order index, the provider select, the model select, any row-level
 * hint (inline, so it never re-opens the row height) and the trailing remove
 * icon. The visible provider/model field labels are gone — the two selects
 * carry their accessible name on `aria-label` (the visible labels repeated on
 * every row and cost a whole line).
 * The GUI never offers a `provider/*` wildcard — but `provider/*` stays a
 * legal YAML entry in any chain, so a wildcard row read back from the server
 * renders with the legacy-conversion hint and an enabled model select:
 * picking a model converts the row to an exact entry (the patch carries
 * `wildcard: false`). The provider options are the catalog providers
 * **configured on the Models page** (`configuredProviders`, the Models-page
 * `configured` join) — unconfigured directory providers never become
 * offerable. Out-of-catalog values read back from the server render as
 * a synthetic option with the short "outside catalog" annotation and stay
 * selected — keeping them saves verbatim; picking a catalog option is an
 * intentional change. A directory provider that is not configured is offered
 * the same read-back treatment (short "not configured" annotation) so an
 * existing value is never hidden or dropped. New rows only offer configured
 * options.
 */
function ChainSelectorEditor({
  selector, index, catalog, configuredProviders, disabled, t, onChange, onRemove, reorder,
}: {
  selector: ChainSelectorRow
  /** 1-based render position of this row inside its chain (the visible order index). */
  index: number
  catalog: CatalogLookup | undefined
  configuredProviders: readonly LlmConfigurableProvider[]
  disabled: boolean
  t: FallbacksCardProps['t']
  onChange: (patch: Partial<ChainSelectorRow>) => void
  onRemove: () => void
  reorder: ChainSelectorReorder
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
  // with a strict hint (D-4). A wildcard read-back row counts too — without a
  // group there is no model to convert it to, so the select stays disabled
  // instead of offering an empty enabled dropdown.
  const groupMissing = providerRaw !== '' && !providerOutside && group === undefined
  // Nothing selectable: outside provider with no outside model to keep.
  const modelDisabled = disabled || providerRaw === '' || groupMissing || (providerOutside && modelRaw === '')
  // Id of THIS row's strict hint (only rendered when `groupMissing`). The
  // hint became a sibling span in the compact row (plan
  // fallbacks-chain-row-compact T1), so it no longer contributes to the model
  // select's accessible name: the select points at it with `aria-describedby`
  // instead. The instance id keeps the hint id unique across the card — the
  // 1-based row index repeats in every chain (all-day + each time slot /
  // role), and a duplicate id would resolve `aria-describedby` to another
  // row's hint. `useId` stays unconditional: the id is only USED when the hint
  // renders.
  const hintInstanceId = useId().replace(/:/g, '')
  const strictHintId = groupMissing ? `fallbacks-selector-hint-${index}-${hintInstanceId}` : undefined

  return (
    <div
      className={`${css.selectorRow}${reorder.dragging ? ` ${css.selectorRowDragging}` : ''}${reorder.dropTarget ? ` ${css.selectorRowOver}` : ''}`}
      data-selector-row=""
      // The row is the drop target (slot-card precedent): the drag starts on
      // the trailing grip, so a drag that begins on a select never reorders.
      // A FOREIGN drag (text, files, another chain's grip) is not ours to
      // intercept: no `preventDefault`, so the drop is not swallowed.
      onDragOver={event => {
        if (disabled || !reorder.active) return
        event.preventDefault()
        reorder.onDragOver()
      }}
      onDrop={event => {
        if (disabled || !reorder.active) return
        event.preventDefault()
        reorder.onDrop()
      }}
    >
      <div className={css.selectorLine}>
        {/* The chain is ordered; this aria-hidden ordinal is the only place
            the order is expressed (the labelled selects carry the meaning). */}
        <span className={css.selectorIndex} aria-hidden="true" data-selector-index={index}>{index}</span>
        <div className={css.selectorProviderCell}>
          <select
            className={`${css.input} ${css.selectInput}`}
            value={providerRaw}
            // The row's position is part of the name: every chain row would
            // otherwise be announced identically (the visible ordinal is
            // aria-hidden).
            aria-label={t('chains.selector.providerAria', { index: String(index) })}
            disabled={disabled}
            onChange={event => {
              // Cascade: a DIFFERENT provider clears the model choice (D-3);
              // re-picking the same provider keeps the model (S-e).
              if (event.target.value === providerRaw) return
              // A legacy wildcard read-back row switching provider KEEPS
              // `wildcard: true` — an intentional escape hatch: the GUI never
              // creates wildcards, but a `provider/*` entry moved onto another
              // provider stays a wildcard until a concrete model is picked
              // (only the model change converts it to an exact entry, F-004).
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
        </div>
        <div className={css.selectorModelCell}>
          <select
            className={`${css.input} ${css.selectInput}`}
            value={modelRaw}
            aria-label={t('chains.selector.modelAria', { index: String(index) })}
            // A disabled select still needs to SAY why: the strict "no models"
            // hint is a sibling span now, so bind it explicitly.
            aria-describedby={strictHintId}
            disabled={modelDisabled}
            onChange={event => {
              onChange({
                model: classifyModel(providerRaw, event.target.value, catalog),
                // A wildcard read-back row converts to an exact entry the
                // moment a concrete model is picked (GUI never re-offers the
                // wildcard).
                ...(selector.wildcard ? { wildcard: false } : {}),
              })
            }}
          >
            {modelRaw === '' && !providerOutside && (
              <option value="">{t('chains.selector.modelPlaceholder')}</option>
            )}
            {(group?.models ?? []).map(model => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
            {modelOutside && !selector.wildcard && (
              <option value={modelRaw}>{`${modelRaw}${t('catalog.outside.short')}`}</option>
            )}
          </select>
        </div>
        {/* Row-level hints ride the line (inline, ellipsised by CSS) instead
            of a block sibling that would re-open the row height. Each hint is
            a strip whose TEXT holder carries the truncation (`title` keeps the
            full copy); a trailing InfoHint badge sits OUTSIDE that holder, so
            the clip can never eat into it (T2-F2). */}
        {groupMissing && (
          <span className={css.selectorHint}>
            <span
              id={strictHintId}
              className={css.selectorHintText}
              title={t('chains.selector.noModelsStrict')}
            >
              {t('chains.selector.noModelsStrict')}
            </span>
          </span>
        )}
        {(providerOutside || modelOutside) && (
          <span className={css.selectorHint}>
            <span className={css.selectorHintText} title={t('catalog.outside.hint')}>
              {t('catalog.outside.hint')}
            </span>
            <InfoHint label={t('catalog.outside.tooltip')} disabled={disabled} />
          </span>
        )}
        {/* The legacy-conversion hint only renders when a conversion is
            actually possible: with the model select disabled (no catalog
            group / empty provider / outside provider without an outside
            model) there is nothing to pick, so the hint stays off
            (N-003/N-004). */}
        {selector.wildcard && !modelDisabled && (
          <span className={css.selectorHint}>
            <span className={css.selectorHintText} title={t('chains.selector.wildcardLegacy')}>
              {t('chains.selector.wildcardLegacy')}
            </span>
          </span>
        )}
        <button
          type="button"
          className={`${css.iconButton} ${css.iconButtonDanger} ${css.selectorRemove}`}
          data-tip={t('chains.selector.remove', { index: String(index) })}
          aria-label={t('chains.selector.remove', { index: String(index) })}
          // The row's OWN gate, not just the ancestor `fieldset[disabled]`:
          // the plan's acceptance line is "remove … hidden when read-only", and
          // a real `disabled` button is the thing CSS can hide, AT can skip and
          // the browser cannot click (plan QC round G, QC-W1).
          disabled={disabled}
          onClick={onRemove}
        >
          <TrashIcon />
        </button>
        {/* Trailing reorder grip (plan fallbacks-chain-reorder T1): the far
            right of the line, the row's ONLY drag source, and the keyboard
            affordance — ArrowUp/ArrowDown move this entry one position. The
            read-only gate mirrors the remove control (disabled → hidden), so
            a view that cannot save offers no reorder. */}
        <button
          type="button"
          ref={reorder.gripRef}
          className={`${css.dragHandle} ${css.selectorGrip}`}
          draggable={!disabled}
          data-tip={t('chains.selector.reorder', { index: String(index) })}
          aria-label={t('chains.selector.reorder', { index: String(index) })}
          disabled={disabled}
          onDragStart={() => {
            if (disabled) return
            reorder.onDragStart()
          }}
          onDragEnd={reorder.onDragEnd}
          onKeyDown={event => {
            if (disabled) return
            const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
            if (step === 0) return
            event.preventDefault()
            reorder.onKeyMove(index - 1, index - 1 + step)
          }}
        >
          <GripIcon />
        </button>
      </div>
    </div>
  )
}

/**
 * One chain's selector rows plus their drag state (plan
 * fallbacks-chain-reorder T1). The list owns the dragged/over index pair —
 * card-local state, no DataTransfer payload (the jsdom-testable slot-card
 * pattern), one instance per rendered chain, so hooks are never called inside
 * a loop and no two lists share a drag. All three chain editors (default
 * chain, time-slot chains, role chains) render through this component.
 */
function ChainSelectorList({
  selectors, catalog, configuredProviders, disabled, t, onChange, onRemove, onMove,
}: {
  selectors: readonly ChainSelectorRow[]
  catalog: CatalogLookup | undefined
  configuredProviders: readonly LlmConfigurableProvider[]
  disabled: boolean
  t: FallbacksCardProps['t']
  onChange: (index: number, patch: Partial<ChainSelectorRow>) => void
  onRemove: (index: number) => void
  onMove: (from: number, to: number) => void
}): ReactNode {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const settle = (): void => { setDraggedIndex(null); setOverIndex(null) }
  // Focus hand-off (QC F-001): the rows are keyed by POSITION, so a moved
  // entry's grip is re-rendered from the node that used to belong to another
  // position and browser focus stays behind. The keyboard path records the
  // destination here, and the effect below focuses that grip once the reorder
  // has rendered — so consecutive presses keep walking the same entry.
  const gripRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [pendingFocus, setPendingFocus] = useState<number | null>(null)
  useEffect(() => {
    if (pendingFocus === null) return
    gripRefs.current[pendingFocus]?.focus()
    setPendingFocus(null)
  }, [pendingFocus])
  return (
    <div className={css.chainSelectors}>
      {selectors.map((selector, index) => (
        <ChainSelectorEditor
          key={index}
          index={index + 1}
          selector={selector}
          catalog={catalog}
          configuredProviders={configuredProviders}
          disabled={disabled}
          t={t}
          onChange={patch => { onChange(index, patch) }}
          onRemove={() => { onRemove(index) }}
          reorder={{
            dragging: draggedIndex === index,
            dropTarget: draggedIndex !== null && draggedIndex !== index && overIndex === index,
            active: draggedIndex !== null,
            gripRef: node => { gripRefs.current[index] = node },
            onDragStart: () => { setDraggedIndex(index); setOverIndex(index) },
            onDragOver: () => {
              if (draggedIndex === null || overIndex === index) return
              setOverIndex(index)
            },
            onDrop: () => {
              const from = draggedIndex
              settle()
              if (from !== null && from !== index) onMove(from, index)
            },
            onDragEnd: settle,
            onKeyMove: (from, to) => {
              // Out-of-range / same-position moves are the clamped no-ops —
              // no reorder, and no focus hand-off to a nonexistent grip.
              if (from === to || from < 0 || to < 0 || from >= selectors.length || to >= selectors.length) return
              setPendingFocus(to)
              onMove(from, to)
            },
          }}
        />
      ))}
    </div>
  )
}

/**
 * Render the Fallbacks settings card inside the plugin-config section
 * (named virtual chains): the 虚拟链 tab group, the 子代理 role cards and
 * the 高级选项 group, flat under the page's plugin title/description.
 */
export function FallbacksCard({ controller, useSnapshot, t }: FallbacksCardProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  // Initial load + catalog read (the switch-history read is GONE with the
  // status surfaces — named virtual chains §4).
  useEffect(() => {
    const snapshot = controller.store.getSnapshot()
    if (snapshot.status === 'idle') void controller.load()
    if (snapshot.catalogStatus === 'idle') void controller.loadCatalog()
  }, [controller])

  // Editors seed from `defaultFallbacksConfig` on mount; every later ready
  // whose config CONTENT differs re-seeds CLEAN sections only.
  const [scalars, setScalars] = useState<FallbacksScalars>(() => scalarsOf(defaultFallbacksConfig))
  const [chainDrafts, setChainDrafts] = useState<ChainDraft[]>(() => chainsToDrafts(defaultFallbacksConfig.chains))
  const [activeChain, setActiveChain] = useState(0)
  const [roleRows, setRoleRows] = useState<RoleRow[]>(() => rolesToRows(defaultFallbacksConfig.roles.list))
  const [presetToAdd, setPresetToAdd] = useState('')
  const [lastSaveSection, setLastSaveSection] = useState<'chains' | 'sub' | 'advanced' | null>(null)
  const [lastSaveChain, setLastSaveChain] = useState<number | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const seededConfigKey = useRef<string | null>(null)
  const firstSeedDone = useRef(false)

  const chains: NamedChain[] = chainDrafts.map(draftToChain)
  const chainsDirty = JSON.stringify(chains) !== JSON.stringify(state.config.chains)
  // Keyed by chain ID, not by position: adding or deleting a chain shifts the
  // draft indices, and the ACCEPTED array is the base every save patches.
  const acceptedChainOf = (id: string): NamedChain | undefined =>
    state.config.chains.find(chain => chain.id === id)
  const perChainDirty = chainDrafts.map((chainDraft) => {
    const accepted = acceptedChainOf(chainDraft.id)
    // A chain with no accepted counterpart is NEW — always dirty until saved.
    return accepted === undefined || JSON.stringify(draftToChain(chainDraft)) !== JSON.stringify(accepted)
  })
  // The chain LIST itself is draft state too: an added or deleted chain arms
  // the section save even when the active tab's own fields are untouched
  // (otherwise a deletion could never be persisted).
  const structureDirty = chainDrafts.length !== state.config.chains.length
    || chainDrafts.some((draft, index) => state.config.chains[index]?.id !== draft.id)
  const rolesDraft: FallbacksConfig['roles'] = { list: mergeRoleExtras(roleRows, state.config.roles.list) }
  const rolesDirty = JSON.stringify(rolesDraft) !== JSON.stringify(state.config.roles)
  const advancedDirty = JSON.stringify([
    scalars.triggerCodes, scalars.cooldownMs, scalars.revertPolicy, scalars.maxSwitchesPerStep,
  ]) !== JSON.stringify([
    state.config.triggerCodes, state.config.cooldownMs, state.config.revertPolicy,
    state.config.maxSwitchesPerStep,
  ])

  // Reseed on every content-changing ready — CLEAN sections only.
  useEffect(() => {
    if (state.status !== 'ready') return
    const key = JSON.stringify(state.config)
    if (seededConfigKey.current === key) return
    seededConfigKey.current = key
    const firstSeed = !firstSeedDone.current
    firstSeedDone.current = true
    const catalog = catalogOf(state)
    if (firstSeed || !chainsDirty) {
      const drafts = chainsToDrafts(state.config.chains, catalog)
      setChainDrafts(drafts)
      setActiveChain(index => Math.min(index, Math.max(0, drafts.length - 1)))
    }
    if (firstSeed || !rolesDirty) {
      setRoleRows(rolesToRows(state.config.roles.list))
    }
    if (firstSeed || !advancedDirty) {
      setScalars(prev => ({
        ...prev,
        triggerCodes: [...state.config.triggerCodes],
        cooldownMs: state.config.cooldownMs,
        revertPolicy: state.config.revertPolicy,
        maxSwitchesPerStep: state.config.maxSwitchesPerStep,
        tz: state.config.tz ?? 'Asia/Shanghai',
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.config])

  const updateScalars = (mutator: (draft: FallbacksScalars) => void): void => {
    setScalars(prev => {
      const next: FallbacksScalars = { ...prev, triggerCodes: [...prev.triggerCodes] }
      mutator(next)
      return next
    })
  }

  // ---- per-active-chain editors (slots / selectors / tail) ----
  const patchActiveDraft = (mutator: (draft: ChainDraft) => ChainDraft): void => {
    setChainDrafts(drafts => drafts.map((draft, index) => index === activeChain
      ? mutator({ ...draft, slots: draft.slots.map(row => ({ ...row, selectors: row.selectors.map(s => ({ ...s })) })), selectors: draft.selectors.map(s => ({ ...s })) })
      : draft))
  }
  const updateTimeSlotRow = (index: number, patch: Partial<SlotEditorRow>): void => {
    patchActiveDraft(draft => {
      const slots = draft.slots.map(row => ({ ...row }))
      slots[index] = { ...slots[index]!, ...patch }
      return { ...draft, slots }
    })
  }
  const updateTimeSlotSelector = (rowIndex: number, selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    patchActiveDraft(draft => {
      const slots = draft.slots.map(row => ({ ...row, selectors: row.selectors.map(selector => ({ ...selector })) }))
      const selectors = slots[rowIndex]!.selectors
      selectors[selectorIndex] = { ...selectors[selectorIndex]!, ...patch }
      return { ...draft, slots }
    })
  }
  const addTimeSlotSelector = (rowIndex: number): void => {
    patchActiveDraft(draft => ({
      ...draft,
      slots: draft.slots.map((row, index) => index === rowIndex
        ? { ...row, selectors: [...row.selectors, { wildcard: false, provider: null, model: null }] }
        : row),
    }))
  }
  const removeTimeSlotSelector = (rowIndex: number, selectorIndex: number): void => {
    patchActiveDraft(draft => ({
      ...draft,
      slots: draft.slots.map((row, index) => index === rowIndex
        ? { ...row, selectors: row.selectors.filter((_, sIndex) => sIndex !== selectorIndex) }
        : row),
    }))
  }
  const addPresetSlotRow = (): void => {
    if (presetToAdd === '') return
    patchActiveDraft(draft => ({
      ...draft,
      slots: [...draft.slots, { kind: 'preset', preset: presetToAdd, start: '', end: '', days: [], name: '', collapsed: false, selectors: [] }],
    }))
    setPresetToAdd('')
  }
  const addCustomSlotRow = (): void => {
    patchActiveDraft(draft => ({
      ...draft,
      slots: [...draft.slots, { kind: 'custom', start: '', end: '', days: [], name: '', collapsed: false, selectors: [] }],
    }))
  }
  const removeTimeSlotRow = (index: number): void => {
    patchActiveDraft(draft => ({ ...draft, slots: draft.slots.filter((_, rowIndex) => rowIndex !== index) }))
  }
  const moveTimeSlotRow = (index: number, delta: -1 | 1): void => {
    patchActiveDraft(draft => {
      const target = index + delta
      if (target < 0 || target >= draft.slots.length) return draft
      const slots = [...draft.slots]
      const moved = slots[index]!
      slots[index] = slots[target]!
      slots[target] = moved
      return { ...draft, slots }
    })
  }
  const [draggedSlotIndex, setDraggedSlotIndex] = useState<number | null>(null)
  const [overSlotIndex, setOverSlotIndex] = useState<number | null>(null)
  const reorderTimeSlotRow = (from: number, to: number): void => {
    patchActiveDraft(draft => {
      const slots = [...draft.slots]
      if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return draft
      const [moved] = slots.splice(from, 1)
      slots.splice(to, 0, moved!)
      return { ...draft, slots }
    })
  }
  const moveSlotSelector = (rowIndex: number, from: number, to: number): void => {
    patchActiveDraft(draft => ({
      ...draft,
      slots: draft.slots.map((slot, slotIndex) => slotIndex === rowIndex
        ? { ...slot, selectors: moveItem(slot.selectors, from, to) }
        : slot),
    }))
  }

  // 默认降级链 selector editor (per active chain).
  const updateChainSelector = (selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    patchActiveDraft(draft => {
      const selectors = draft.selectors.map((selector, index) => index === selectorIndex ? { ...selector, ...patch } : selector)
      return { ...draft, selectors }
    })
  }
  const addChainSelector = (): void => {
    patchActiveDraft(draft => ({ ...draft, selectors: [...draft.selectors, { wildcard: false, provider: null, model: null }] }))
  }
  const removeChainSelector = (selectorIndex: number): void => {
    patchActiveDraft(draft => ({ ...draft, selectors: draft.selectors.filter((_, index) => index !== selectorIndex) }))
  }
  const reorderChainSelector = (from: number, to: number): void => {
    patchActiveDraft(draft => ({ ...draft, selectors: moveItem(draft.selectors, from, to) }))
  }

  // ---- chain tab management (add / delete) — the label editor lives in the body ----
  const addChain = (): void => {
    // The id comes from the DRAFT list: the accepted config knows nothing
    // about an addition that was never saved, so deriving from it handed two
    // consecutive clicks the same `chain-N`.
    let added = chainDrafts.length
    setChainDrafts((drafts) => {
      added = drafts.length
      return [...drafts, { id: newChainId(drafts), label: '', selectors: [], slots: [] }]
    })
    setActiveChain(added)
    setMenuOpen(false)
  }
  // No second rename state: the ⋯ menu edits the SAME draft label as the
  // 链名称 field, so the two editors can never disagree or revert each other.
  const deleteActiveChain = (): void => {
    if (chainDrafts.length <= 1) return
    setChainDrafts(drafts => drafts.filter((_, index) => index !== activeChain))
    setActiveChain(index => Math.max(0, index - 1))
    setMenuOpen(false)
  }

  // ---- roles ----
  const updateRoleRow = (index: number, patch: Partial<RoleRow>): void => {
    setRoleRows(rows => {
      const next = rows.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }
  const addRole = (): void => {
    setRoleRows(rows => [...rows, { id: '', persona: '', chain: '', collapsed: true, personaOpen: false }])
  }
  const removeRole = (index: number): void => {
    setRoleRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
  }

  const saving = state.status === 'saving'
  const writable = state.writable
  const advancedVisible = advancedOpen || !writable
  const cooldownMsTip = `${t('cooldownMs.tooltip')} ${t('defaults.prefix')}: ${defaultFallbacksConfig.cooldownMs}`
  const maxSwitchesPerStepTip = `${t('maxSwitchesPerStep.tooltip')} ${t('defaults.prefix')}: ${defaultFallbacksConfig.maxSwitchesPerStep}`
  const unknownCodes = scalars.triggerCodes.filter(code => !KNOWN_TRIGGER_CODES.includes(code))
  const presetsPresent = (chainDrafts[activeChain]?.slots ?? []).some(row => row.kind === 'preset')
  const glmConfigured = state.configuredProviders.some(entry => entry.provider === 'zai-coding-cn')
  // The ACTIVE slot row of the ACTIVE chain (per-chain 分时 badge), resolved
  // with the SAME pure helper the runtime uses against the ACCEPTED chain —
  // looked up by chain ID, since the draft index need not match a position in
  // the accepted array after an add/delete.
  const acceptedChain = chainDrafts[activeChain] === undefined
    ? undefined
    : acceptedChainOf(chainDrafts[activeChain]!.id)
  const activeSlotIndex = (() => {
    if (acceptedChain === undefined) return -1
    const winner = resolveSlotState(acceptedChain, new Date(), scalars.tz)
    if (winner.winner === 'all-day') return -1
    return acceptedChain.timeSlots?.indexOf(winner.winner) ?? -1
  })()
  const invalidSlotRows = collectInvalidSlotRows(chainDrafts[activeChain]?.slots ?? [])
  const invalidRoleIds = collectInvalidRoleIds(roleRows)
  const seedInfo = new Map<string, SeedRowInfo>()
  for (const seed of state.seeds) {
    seedInfo.set(seed.id.trim(), { overridden: seed.overridden, source: seed.source })
  }

  // Whole-draft validation, bucketed per chain + roles/advanced.
  const liveErrors = validateDraft(chains, rolesDraft.list, t)
  const activeErrors = liveErrors.chains[activeChain] ?? []
  // `chainsPatch()` writes the whole draft list, so ANY chain's error blocks
  // the section save — not just the active tab's bucket. (A pending chain has
  // no accepted counterpart, so it would otherwise be persisted exactly as
  // the card marks it invalid.)
  const anyChainErrors = liveErrors.chains.some(bucket => bucket.length > 0)
  const activeDirty = (perChainDirty[activeChain] ?? false) || structureDirty

  // Catalog reseed (llm/adapters-updated) re-classifies CLEAN section rows.
  const catalogSeededSections = useRef<{ epoch: number | null; chains: boolean; roles: boolean }>({ epoch: null, chains: false, roles: false })
  useEffect(() => {
    if (state.catalogStatus !== 'ready') return
    const seed = catalogSeededSections.current
    if (seed.epoch !== state.catalogEpoch) {
      seed.epoch = state.catalogEpoch
      seed.chains = false
      seed.roles = false
    }
    const catalog = catalogOf(state)
    if (!chainsDirty && !seed.chains) {
      seed.chains = true
      setChainDrafts(chainsToDrafts(state.config.chains, catalog))
    }
    if (!rolesDirty && !seed.roles) {
      seed.roles = true
      setRoleRows(rolesToRows(state.config.roles.list))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.catalogStatus, state.catalogEpoch, state.config])

  // Per-section saves (the ride-along protection). The chains save writes the
  // DRAFT chain list — the only shape that can express an added or deleted
  // chain — while every OTHER existing chain keeps its ACCEPTED content, so a
  // sibling tab's unsaved edits are never ridden along. A chain with no
  // accepted counterpart is new and persists as its draft.
  const chainsPatch = (): NamedChain[] => {
    const activeId = chainDrafts[activeChain]?.id
    return chainDrafts.map((draft) => {
      if (draft.id === activeId) return draftToChain(draft)
      return acceptedChainOf(draft.id) ?? draftToChain(draft)
    })
  }
  const saveSection = (section: 'chains' | 'sub' | 'advanced'): void => {
    if (section === 'chains') {
      if (anyChainErrors) return
      setLastSaveSection('chains')
      setLastSaveChain(activeChain)
      void controller.save({ ...state.config, chains: chainsPatch() })
      return
    }
    if (section === 'sub') {
      if (liveErrors.roles.length > 0) return
      setLastSaveSection('sub')
      void controller.save({ ...state.config, roles: rolesDraft })
      return
    }
    setLastSaveSection('advanced')
    void controller.save({
      ...state.config,
      triggerCodes: scalars.triggerCodes,
      cooldownMs: scalars.cooldownMs,
      revertPolicy: scalars.revertPolicy,
      maxSwitchesPerStep: scalars.maxSwitchesPerStep,
    })
  }
  const discardChain = (): void => {
    const activeId = chainDrafts[activeChain]?.id
    if (activeId === undefined) return
    const accepted = acceptedChainOf(activeId)
    if (accepted === undefined) {
      // A chain with no accepted counterpart has nothing to revert TO:
      // discarding it removes the pending row.
      setChainDrafts(drafts => drafts.filter((_, index) => index !== activeChain))
      setActiveChain(index => Math.max(0, index - 1))
      return
    }
    const reverted = chainsToDrafts([accepted], catalogOf(state))[0]!
    setChainDrafts(drafts => drafts.map((draft, index) => index === activeChain ? reverted : draft))
  }
  const discardSection = (section: 'sub' | 'advanced'): void => {
    if (section === 'sub') {
      setRoleRows(rolesToRows(state.config.roles.list))
    } else {
      setScalars(prev => ({
        ...prev,
        triggerCodes: [...state.config.triggerCodes],
        cooldownMs: state.config.cooldownMs,
        revertPolicy: state.config.revertPolicy,
        maxSwitchesPerStep: state.config.maxSwitchesPerStep,
      }))
    }
  }

  useEffect(() => {
    if (state.status === 'ready') {
      setLastSaveSection(null)
      setLastSaveChain(null)
    }
  }, [state.status])

  // Degraded latch (the advisor's latched `degraded`, card-local).
  const degradedLatch = useRef(false)
  if (state.status === 'ready') degradedLatch.current = !state.present
  const degraded = state.status === 'ready' ? !state.present : degradedLatch.current

  // Tablist keyboard semantics: ←/→ move, Home/End jump (roving tabindex).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const onTabKeyDown = (event: ReactKeyboardEvent, index: number): void => {
    const count = chainDrafts.length
    if (count === 0) return
    let target: number | null = null
    if (event.key === 'ArrowRight') target = (index + 1) % count
    else if (event.key === 'ArrowLeft') target = (index - 1 + count) % count
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = count - 1
    if (target === null) return
    event.preventDefault()
    setActiveChain(target)
    setMenuOpen(false)
    tabRefs.current[target]!.focus()
  }

  const activeDraft = chainDrafts[activeChain]
  const timeSlotRows: SlotEditorRow[] = activeDraft?.slots ?? []
  // Slot-class errors of the active bucket (block-scoped banner under
  // 分时槽设置); the tail error renders under 默认模型.
  const tailError = activeErrors.includes(t('validation.allDayRequired'))
    ? t('validation.allDayRequired')
    : null
  const slotErrors = activeErrors.filter(message => message !== tailError)

  return (
    <div className={css.root}>
      {state.legacyKeys.length > 0 && (
        <p className={css.legacyNotice} role="status">
          {t('legacy.banner', { keys: state.legacyKeys.join(', ') })}
        </p>
      )}
      <p className={css.notice}>{t('virtualOnly.rule')}</p>
      {state.status === 'error' && state.error !== null && lastSaveSection === null && (
        <div className={css.noticeRow}>
          <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
          {!state.writable && (
            <button type="button" className={css.outlineButton} onClick={() => { void controller.load() }}>
              {t('retry')}
            </button>
          )}
        </div>
      )}
      {degraded && <p className={css.notice} role="status">{t('unavailable')}</p>}
      {state.status === 'ready' && !state.writable && (
        <p className={css.readOnly} role="status">{t('readOnly')}</p>
      )}

      <fieldset className={css.fieldset} disabled={!writable}>
        <h2 className={css.sectionHeading} id="fallbacks-virtual-chains" aria-label={t('virtualChain.label')}>
          <span className={css.sectionHeadingText}>{t('virtualChain.label')}</span>
          <span className={css.hint}>{t('virtualChain.hint')}</span>
        </h2>

        {/* The chain tab strip (the mockup): underline tabs on the 0.5px l2
         * hairline; active label label-primary + 2px brand underline; dirty
         * pip; error "!" mark; "+" add; "⋯" chain menu; WAI-ARIA tabs
         * keyboard semantics with roving tabindex. */}
        <div className={css.tabsWrap} data-tabs-wrap="">
          <div className={css.tabs} role="tablist" aria-label={t('virtualChain.label')} data-tablist="">
            {chainDrafts.map((chainDraft, index) => {
              const selected = index === activeChain
              const dirty = perChainDirty[index] ?? false
              const invalid = (liveErrors.chains[index] ?? []).length > 0
              const name = (chainDraft.label === '' ? chainDraft.id : chainDraft.label)
                + (dirty ? t('chains.tab.dirty') : '') + (invalid ? t('chains.tab.error') : '')
              return (
                <button
                  key={chainDraft.id}
                  ref={node => { tabRefs.current[index] = node }}
                  type="button"
                  role="tab"
                  data-chain-tab={chainDraft.id}
                  aria-selected={selected}
                  aria-controls={`fallbacks-chain-panel-${chainDraft.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={css.tab}
                  aria-label={name}
                  onClick={() => { setActiveChain(index); setMenuOpen(false) }}
                  onKeyDown={event => { onTabKeyDown(event, index) }}
                >
                  {chainDraft.label === '' ? chainDraft.id : chainDraft.label}
                  {dirty && <span className={css.dirtyPip} title={t('chains.tab.dirty')} aria-hidden="true" data-dirty-pip="" />}
                  {invalid && <span className={css.errorMark} aria-hidden="true" data-error-mark="">!</span>}
                </button>
              )
            })}
            <button
              type="button"
              className={css.tabAdd}
              title={t('chains.tab.add')}
              aria-label={t('chains.tab.add')}
              disabled={!writable}
              onClick={addChain}
              data-tab-add=""
            >
              ＋
            </button>
            {chainDrafts.length > 0 && (
              <span className={css.tabMenu} data-tab-menu="">
                <button
                  type="button"
                  className={css.menuBtn}
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                  aria-label={t('chains.tab.menu')}
                  data-menu-btn=""
                  disabled={!writable}
                  onClick={() => { setMenuOpen(open => !open) }}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div className={css.menuPanel} role="menu" aria-label={t('chains.tab.menu')} data-menu-panel="">
                    <label>
                      {t('chains.tab.renameLabel', { id: activeDraft?.id ?? '' })}
                      <input
                        className={`${css.input} ${css.menuInput}`}
                        value={activeDraft?.label ?? ''}
                        data-menu-input=""
                        disabled={!writable}
                        onChange={event => { patchActiveDraft(draft => ({ ...draft, label: event.target.value })) }}
                      />
                    </label>
                    <div className={css.menuActions}>
                      <button
                        type="button"
                        className={css.outlineButton}
                        onClick={() => { setMenuOpen(false) }}
                        data-menu-apply=""
                      >
                        {t('chains.tab.renameDone')}
                      </button>
                    </div>
                    <button
                      type="button"
                      className={css.menuItemDanger}
                      disabled={chainDrafts.length <= 1}
                      onClick={deleteActiveChain}
                      data-menu-delete=""
                    >
                      {chainDrafts.length <= 1 ? t('chains.tab.deleteDisabled') : t('chains.tab.delete')}
                    </button>
                  </div>
                )}
              </span>
            )}
          </div>
          <span className={css.fadeL} aria-hidden="true" />
          <span className={css.fadeR} aria-hidden="true" />
        </div>

        {chainDrafts.length === 0 ? (
          <div className={css.emptyState} data-empty-state="">
            <strong>{t('chains.empty.title')}</strong>
            {t('chains.empty.body')}
            <br /><br />
            <button type="button" className={css.outlineButton} onClick={addChain} data-empty-create="">
              {t('chains.empty.create')}
            </button>
          </div>
        ) : (
        <div
          className={css.chainBody}
          role="tabpanel"
          id={`fallbacks-chain-panel-${activeDraft!.id}`}
          aria-labelledby={`fallbacks-chain-tab-${activeDraft!.id}`}
          data-chain-panel=""
        >
          {slotErrors.length > 0 && (
            <p className={css.error} role="alert">{`${t('validation.blocked')}${slotErrors.join('; ')}`}</p>
          )}

          {/* ======== 链名称 (per chain) ======== */}
          {/* Discoverable rename: the ⋯ menu is the secondary path, this field
              is where a maintainer looks after clicking 「+」 and seeing the raw
              id as the tab title. The ID is the picker model id and stays
              fixed; only the display name is editable. */}
          <div className={`${css.field} ${css.blockField}`} role="group" aria-labelledby={`fallbacks-chain-name-${activeDraft!.id}`}>
            <span className={css.blockHeading}>
              <span id={`fallbacks-chain-name-${activeDraft!.id}`}>{t('chains.name.label')}</span>
              <InfoHint label={t('chains.name.tooltip')} disabled={!writable} />
            </span>
            <input
              className={css.input}
              value={activeDraft!.label}
              placeholder={activeDraft!.id}
              aria-label={t('chains.name.label')}
              data-chain-name=""
              disabled={!writable}
              onChange={event => { patchActiveDraft(draft => ({ ...draft, label: event.target.value })) }}
            />
            <span className={css.hint}>{t('chains.name.hint', { id: activeDraft!.id })}</span>
          </div>

          {/* ======== 分时槽设置 (per chain) ======== */}
          <div className={`${css.field} ${css.blockField}`} role="group" aria-labelledby={`fallbacks-time-slots-${activeDraft!.id}`}>
            <span className={css.blockHeading}>
              <span id={`fallbacks-time-slots-${activeDraft!.id}`}>{t('timeSlots.label')}</span>
              <InfoHint label={t('timeSlots.tooltip')} disabled={!writable} />
            </span>
            <span className={css.hint}>{t('timeSlots.hint')}</span>
            <div className={css.list}>
              {timeSlotRows.length === 0 && (
                <span className={css.hint} data-slot-empty="">{t('timeSlots.empty')}</span>
              )}
              {timeSlotRows.map((row, index) => {
                const invalidWindow = invalidSlotRows.has(index)
                const chainEmpty = row.selectors.every(selector => selectorRowToRaw(selector) === '')
                const firstModel = row.selectors.map(selectorRowToRaw).find(entry => entry !== '')
                const slotExpanded = !row.collapsed || !writable
                return (
                <div
                  key={index}
                  className={`${css.editorCard} ${draggedSlotIndex === index ? css.slotCardDragging : ''} ${overSlotIndex === index && draggedSlotIndex !== null && draggedSlotIndex !== index ? css.slotCardOver : ''}`}
                  onDragOver={(event) => {
                    if (draggedSlotIndex === null) return
                    event.preventDefault()
                    if (overSlotIndex !== index) setOverSlotIndex(index)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const from = draggedSlotIndex
                    setDraggedSlotIndex(null)
                    setOverSlotIndex(null)
                    if (from !== null && from !== index) reorderTimeSlotRow(from, index)
                  }}
                >
                  <div className={css.collapseRow}>
                    <button
                      type="button"
                      className={css.collapseToggle}
                      aria-expanded={slotExpanded}
                      aria-label={t(slotExpanded ? 'timeSlots.collapse' : 'timeSlots.expand')}
                      disabled={!writable}
                      onClick={() => { updateTimeSlotRow(index, { collapsed: !row.collapsed }) }}
                    >
                      <ChevronDownIcon className={slotExpanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
                      <span className={css.collapseTitle}>
                        {row.kind === 'preset'
                          ? t(`timeSlots.preset.${row.preset}.label` as FallbacksKey)
                          : (row.name !== '' ? row.name : `custom ${row.start}-${row.end}`)}
                      </span>
                      {row.kind === 'preset' && (row.preset === 'liang-peak' || row.preset === 'glm-peak') && (
                        <>
                          <span className={`${css.slotTag} ${css.slotTagHighCost}`}>{t('timeSlots.preset.highCost')}</span>
                          <span className={`${css.slotTag} ${css.slotTagMultiplier}`}>
                            {t('timeSlots.preset.multiplier', { n: row.preset === 'liang-peak' ? '2' : '3' })}
                          </span>
                        </>
                      )}
                      {activeSlotIndex === index && (
                        <span className={`${css.slotTag} ${css.slotTagActive}`}>{t('timeSlots.active')}</span>
                      )}
                      {firstModel !== undefined && (
                        <span className={css.collapseMeta}>{firstModel}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={css.dragHandle}
                      draggable={writable}
                      data-tip={t('timeSlots.drag')}
                      aria-label={t('timeSlots.drag')}
                      disabled={!writable}
                      onDragStart={() => {
                        if (!writable) return
                        setDraggedSlotIndex(index)
                        setOverSlotIndex(index)
                      }}
                      onDragEnd={() => { setDraggedSlotIndex(null); setOverSlotIndex(null) }}
                    >
                      <GripIcon />
                    </button>
                  </div>
                  {slotExpanded && (
                  <>
                  {row.kind === 'preset' ? (
                    <>
                      <div className={css.ruleGrid}>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('timeSlots.preset.name')}</span>
                          <span className={css.slotPresetName}>
                            {t(`timeSlots.preset.${row.preset}.label` as FallbacksKey)}
                          </span>
                        </div>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('timeSlots.preset.windowLabel')}</span>
                          <span className={css.hint}>
                            {t(`timeSlots.preset.${row.preset}.window` as FallbacksKey)}
                          </span>
                        </div>
                      </div>
                      <span className={css.hint}>{t('timeSlots.preset.chainsOnly')}</span>
                      {(row.preset === 'glm-peak' || row.preset === 'glm-valley') && (
                        <span className={css.hint}>{t('timeSlots.preset.glm.note')}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <div className={css.field}>
                        <span className={css.ruleCellLabel}>{t('timeSlots.name')}</span>
                        <input
                          className={css.input}
                          value={row.name}
                          placeholder={t('timeSlots.name')}
                          aria-label={t('timeSlots.name')}
                          disabled={!writable}
                          onChange={event => { updateTimeSlotRow(index, { name: event.target.value }) }}
                        />
                      </div>
                      <div className={css.field}>
                        <span className={css.ruleCellLabel}>{t('timeSlots.tz.label')}</span>
                        <span className={css.hint} aria-label={t('timeSlots.tz.label')}>
                          {tzDisplayLabel(presetsPresent ? 'Asia/Shanghai' : hostTimeZone())}
                        </span>
                      </div>
                      <div className={css.ruleGrid}>
                        <label className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('timeSlots.start')}</span>
                          <input
                            className={`${css.input} ${invalidWindow ? css.inputInvalid : ''}`}
                            value={row.start}
                            placeholder="09:00"
                            aria-label={t('timeSlots.start')}
                            disabled={!writable}
                            onChange={event => { updateTimeSlotRow(index, { start: event.target.value }) }}
                          />
                        </label>
                        <label className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('timeSlots.end')}</span>
                          <input
                            className={`${css.input} ${invalidWindow ? css.inputInvalid : ''}`}
                            value={row.end}
                            placeholder="18:00"
                            aria-label={t('timeSlots.end')}
                            disabled={!writable}
                            onChange={event => { updateTimeSlotRow(index, { end: event.target.value }) }}
                          />
                        </label>
                      </div>
                      <div className={css.field}>
                        <span className={css.ruleCellLabel}>{t('timeSlots.days')}</span>
                        <div className={css.dayRow}>
                          {SLOT_WEEKDAYS.map((day, dayIndex) => (
                            <label key={day} className={css.dayCell}>
                              <input
                                type="checkbox"
                                checked={row.days.includes(dayIndex)}
                                disabled={!writable}
                                onChange={() => {
                                  updateTimeSlotRow(index, {
                                    days: row.days.includes(dayIndex)
                                      ? row.days.filter(existing => existing !== dayIndex)
                                      : [...row.days, dayIndex],
                                  })
                                }}
                              />
                              {t(`timeSlots.day.${day}` as FallbacksKey)}
                            </label>
                          ))}
                        </div>
                        <span className={css.hint}>{t('timeSlots.days.hint')}</span>
                      </div>
                      {(row.start !== '' || row.end !== '')
                        && !(HHMM_RE.test(row.start) && HHMM_RE.test(row.end)) && (
                        <span className={css.hint}>{t('validation.slotWindow')}</span>
                      )}
                    </>
                  )}
                  {chainEmpty && (
                    <span className={css.hint}>{t('validation.slotChainRequired')}</span>
                  )}
                  <div className={css.chainBlock} data-chain-block="">
                    <ChainSelectorList
                      selectors={row.selectors}
                      catalog={catalogOf(state)}
                      configuredProviders={state.configuredProviders}
                      disabled={!writable}
                      t={t}
                      onChange={(selectorIndex, patch) => { updateTimeSlotSelector(index, selectorIndex, patch) }}
                      onRemove={selectorIndex => { removeTimeSlotSelector(index, selectorIndex) }}
                      onMove={(from, to) => { moveSlotSelector(index, from, to) }}
                    />
                    <button
                      type="button"
                      className={`${css.outlineButton} ${css.addButton} ${css.addButtonGhost}`}
                      disabled={!writable}
                      onClick={() => { addTimeSlotSelector(index) }}
                    >
                      <PlusIcon />
                      {t('timeSlots.selector.add')}
                    </button>
                  </div>
                  <div className={css.cardFoot}>
                    <div className={css.rowActions}>
                      <button
                        type="button"
                        className={css.iconButton}
                        data-tip={t('timeSlots.moveUp')}
                        aria-label={t('timeSlots.moveUp')}
                        disabled={!writable || index === 0}
                        onClick={() => { moveTimeSlotRow(index, -1) }}
                      >
                        <ChevronDownIcon className={css.chevronFlip} />
                      </button>
                      <button
                        type="button"
                        className={css.iconButton}
                        data-tip={t('timeSlots.moveDown')}
                        aria-label={t('timeSlots.moveDown')}
                        disabled={!writable || index === timeSlotRows.length - 1}
                        onClick={() => { moveTimeSlotRow(index, 1) }}
                      >
                        <ChevronDownIcon />
                      </button>
                      <button
                        type="button"
                        className={`${css.iconButton} ${css.iconButtonDanger}`}
                        data-tip={t('timeSlots.remove')}
                        aria-label={t('timeSlots.remove')}
                        onClick={() => { removeTimeSlotRow(index) }}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                  </>
                  )}
                </div>
                )
              })}
            </div>
            <div className={css.slotAddRow}>
              <select
                className={`${css.input} ${css.selectInput}`}
                value={presetToAdd}
                aria-label={t('timeSlots.presetPlaceholder')}
                disabled={!writable}
                onChange={event => { setPresetToAdd(event.target.value) }}
              >
                <option value="">{t('timeSlots.presetPlaceholder')}</option>
                {SLOT_PRESET_IDS
                  .filter(id => !timeSlotRows.some(row => row.kind === 'preset' && row.preset === id))
                  .map(id => {
                    const glmUnconfigured = !glmConfigured && (id === 'glm-peak' || id === 'glm-valley')
                    return (
                      <option key={id} value={id} disabled={glmUnconfigured}>
                        {t(`timeSlots.preset.${id}.label` as FallbacksKey)}
                        {glmUnconfigured ? t('timeSlots.preset.glm.unconfigured') : null}
                      </option>
                    )
                  })}
              </select>
              <button
                type="button"
                className={`${css.outlineButton} ${css.addButton}`}
                disabled={!writable || presetToAdd === ''}
                onClick={addPresetSlotRow}
              >
                <PlusIcon />
                {t('timeSlots.addPreset')}
              </button>
              <button
                type="button"
                className={`${css.outlineButton} ${css.addButton} ${css.addButtonGhost}`}
                disabled={!writable}
                onClick={addCustomSlotRow}
              >
                <PlusIcon />
                {t('timeSlots.addCustom')}
              </button>
            </div>
          </div>

          {/* ======== 默认降级链 (per chain) ======== */}
          <div className={`${css.field} ${css.blockField}`} role="group" aria-labelledby={`fallbacks-root-chain-${activeDraft!.id}`}>
            <span className={css.blockHeading}>
              <span id={`fallbacks-root-chain-${activeDraft!.id}`}>{t('rootChain.label')}</span>
              <InfoHint label={t('rootChain.tooltip')} disabled={!writable} />
            </span>
            {state.catalogStatus === 'error' && state.catalogError !== null && (
              <span className={css.hint}>{t('catalog.error', { message: state.catalogError })}</span>
            )}
            {state.catalogStatus === 'ready' && state.catalogError !== null && (
              <span className={css.hint}>{t('catalog.partial', { message: state.catalogError })}</span>
            )}
            {state.catalogStatus === 'ready' && (state.groups.length === 0 || state.configuredProviders.length === 0) && (
              <span className={css.hint}>{t('catalog.empty')}</span>
            )}
            {slotErrors.length > 0 && (
              <p className={css.error} role="alert" data-chain-error="">
                {`${t('validation.blocked')}${slotErrors.join('; ')}`}
              </p>
            )}
            <div className={css.list}>
              <div className={css.chainBlock} data-chain-block="">
                <ChainSelectorList
                  selectors={activeDraft!.selectors}
                  catalog={catalogOf(state)}
                  configuredProviders={state.configuredProviders}
                  disabled={!writable}
                  t={t}
                  onChange={(selectorIndex, patch) => { updateChainSelector(selectorIndex, patch) }}
                  onRemove={selectorIndex => { removeChainSelector(selectorIndex) }}
                  onMove={reorderChainSelector}
                />
                <button
                  type="button"
                  className={`${css.outlineButton} ${css.addButton} ${css.addButtonGhost}`}
                  disabled={!writable}
                  onClick={addChainSelector}
                >
                  <PlusIcon />
                  {t('timeSlots.selector.add')}
                </button>
              </div>
            </div>
          </div>

          {/* ======== 默认模型（链尾） (per chain): the radio owns the LAST
           * entries element — the two blocks cannot disagree. ======== */}
          <div className={`${css.field} ${css.blockField}`} role="group" aria-labelledby={`fallbacks-default-model-${activeDraft!.id}`}>
            <span className={css.blockHeading}>
              <span id={`fallbacks-default-model-${activeDraft!.id}`}>{t('defaultModel.label')}</span>
            </span>
            <span className={css.hint}>{t('allDay.hint')}</span>
            {tailError !== null && (
              <p className={css.error} role="alert" data-tail-error="">{`${t('validation.blocked')}${tailError}`}</p>
            )}
            <div className={css.list}>
              {OFFICIAL_ALL_DAY_IDS.map(id => {
                const chain = chains[activeChain]
                const tail = chain !== undefined && chain.entries.length >= 1
                  ? chain.entries[chain.entries.length - 1]
                  : undefined
                return (
                  <label key={id} className={css.optionRow}>
                    <input
                      type="radio"
                      name={`fallbacks-chain-tail-${activeDraft!.id}`}
                      checked={tail === id}
                      disabled={!writable}
                      onChange={() => {
                        patchActiveDraft(draft => {
                          const selector = entryToSelectorRow(id, catalogOf(state))
                          if (draft.selectors.length === 0) {
                            return { ...draft, selectors: [selector] }
                          }
                          const selectors = draft.selectors.map(row => ({ ...row }))
                          selectors[selectors.length - 1] = selector
                          return { ...draft, selectors }
                        })
                      }}
                    />
                    {t(id === OFFICIAL_ALL_DAY_IDS[0] ? 'allDay.flash' : 'allDay.pro')}
                  </label>
                )
              })}
            </div>
          </div>

          {/* Per-tab Discard/Save footer (the mockup): writes ONLY this
           * chain; a sibling chain's dirt never arms this Save. */}
          <div className={css.chainFoot} data-chain-foot="">
            <button
              type="button"
              className={css.discard}
              disabled={!activeDirty || saving}
              onClick={discardChain}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={!writable || saving || !activeDirty || anyChainErrors}
              onClick={() => { saveSection('chains') }}
            >
              {saving ? t('save.saving') : t('save')}
            </button>
            <span className={css.chainFootHint}>{t('chains.chainFoot.hint')}</span>
            {lastSaveSection === 'chains' && lastSaveChain === activeChain && state.status === 'error' && state.error !== null && (
              <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
            )}
          </div>
        </div>
        )}

        {/* ======== 子代理: role cards (id + persona + 指定降级链) ======== */}
        <h2 className={css.sectionHeading} id="fallbacks-subagents" aria-label={t('subagents.label')}>
          <span className={css.sectionHeadingText}>{t('subagents.label')}</span>
          <span className={css.sectionActions}>
            <button
              type="button"
              className={css.discard}
              disabled={!rolesDirty || saving}
              onClick={() => { discardSection('sub') }}
            >
              {t('discard')}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={!writable || saving || !rolesDirty || liveErrors.roles.length > 0}
              onClick={() => { saveSection('sub') }}
            >
              {saving ? t('save.saving') : t('save')}
            </button>
          </span>
        </h2>
        {liveErrors.roles.length > 0 && (
          <p className={css.error} role="alert">
            {`${t('validation.blocked')}${liveErrors.roles.join('; ')}`}
          </p>
        )}
        {lastSaveSection === 'sub' && state.status === 'error' && state.error !== null && (
          <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
        )}
        <div className={css.field} role="group" aria-labelledby="fallbacks-roles-list">
          <span className={css.fieldLabel}>
            <span id="fallbacks-roles-list">{t('roles.list.label')}</span>
          </span>
          <span className={css.hint}>{t('roles.list.hint')}</span>
          <div className={css.list}>
            {roleRows.map((row, index) => {
              const invalid = invalidRoleIds.has(row.id.trim())
              const seed = seedInfo.get(row.id.trim())
              const seedBadge = seedBadgeLabel(seed, t)
              const personaBlank = row.persona.trim() === ''
              // Collapse meta: the role's specified chain route, honest even
              // when collapsed (the mockup).
              const chainRoute = row.chain === ''
                ? t('roles.chainMeta.unspecified')
                : `FallbacksChain/${row.chain}`
              const roleExpanded = !row.collapsed || !writable
              // A pointer naming a chain deleted elsewhere stays visible as a
              // synthetic option so the dangling reference is honest.
              const chainOutside = row.chain !== '' && !chains.some(chain => chain.id === row.chain)
              return (
              <div key={index} className={`${css.editorCard} ${css.roleCard}`} data-role-card={row.id}>
                <div className={css.collapseRow}>
                  <button
                    type="button"
                    className={css.collapseToggle}
                    aria-expanded={roleExpanded}
                    aria-label={t(roleExpanded ? 'roles.collapse' : 'roles.expand', { id: row.id })}
                    disabled={!writable}
                    onClick={() => { updateRoleRow(index, { collapsed: !row.collapsed }) }}
                  >
                    <ChevronDownIcon className={roleExpanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
                    <span className={css.collapseTitle}>{row.id}</span>
                    {seedBadge !== null && (
                      <span className={css.seedBadge} title={seedBadge}>{seedBadge}</span>
                    )}
                    <span className={css.collapseMeta} title={chainRoute}>{chainRoute}</span>
                  </button>
                  {/* SIBLING of the collapse button, never nested: a nested
                    * button is invalid HTML and double-activates the row.
                    * Both row controls name the role (F3): a generic "remove"
                    * sounds identical on every row of the list. */}
                  <button
                    type="button"
                    className={`${css.iconButton} ${css.iconButtonDanger}`}
                    data-tip={t('roles.remove.tip')}
                    aria-label={t('roles.remove', { id: row.id, chain: chainRoute })}
                    onClick={() => { removeRole(index) }}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {roleExpanded && (
                <>
                {seed === undefined && (
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
                  </div>
                )}
                <div className={css.ruleGrid}>
                  <div className={css.ruleCell}>
                    <span className={css.fieldLabel}>
                      <label className={css.ruleCellLabel} htmlFor={`fallbacks-role-chain-${index}`}>{t('roles.chain.label')}</label>
                      <InfoHint label={t('roles.chain.hint')} disabled={!writable} />
                    </span>
                    <select
                      id={`fallbacks-role-chain-${index}`}
                      className={`${css.input} ${css.selectInput}`}
                      value={row.chain}
                      disabled={!writable}
                      onChange={event => { updateRoleRow(index, { chain: event.target.value }) }}
                      data-role-chain-select=""
                    >
                      <option value="">{t('roles.chain.unspecified')}</option>
                      {chains.map(chain => (
                        <option key={chain.id} value={chain.id}>
                          {`${chain.label === '' ? chain.id : chain.label}（FallbacksChain/${chain.id}）`}
                        </option>
                      ))}
                      {chainOutside && (
                        <option value={row.chain}>{`${row.chain}${t('roles.chainMeta.unspecified')}`}</option>
                      )}
                    </select>
                  </div>
                </div>
                <div className={css.ruleGrid}>
                  <div className={css.ruleCell}>
                    <span className={css.ruleCellLabel}>{t('roles.persona')}</span>
                    {seed === undefined ? (
                      <textarea
                        rows={3}
                        className={`${css.input} ${css.inputTextarea}`}
                        value={row.persona}
                        placeholder={t('roles.personaPlaceholder')}
                        aria-label={t('roles.persona')}
                        disabled={!writable}
                        onChange={event => { updateRoleRow(index, { persona: event.target.value }) }}
                      />
                    ) : (
                      <>
                        <div className={css.personaBriefRow}>
                          <span
                            className={personaBlank
                              ? `${css.personaBrief} ${css.personaBriefEmpty}`
                              : css.personaBrief}
                          >
                            {personaBlank ? t('roles.persona.empty') : row.persona}
                          </span>
                          {!personaBlank && (
                            <span
                              role="button"
                              tabIndex={0}
                              className={css.iconButton}
                              aria-expanded={row.personaOpen}
                              aria-label={t(row.personaOpen ? 'roles.persona.collapse' : 'roles.persona.expand')}
                              data-tip={t(row.personaOpen ? 'roles.persona.collapse' : 'roles.persona.expand')}
                              onClick={() => { updateRoleRow(index, { personaOpen: !row.personaOpen }) }}
                              onKeyDown={event => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  updateRoleRow(index, { personaOpen: !row.personaOpen })
                                }
                              }}
                            >
                              <ChevronDownIcon className={row.personaOpen ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
                            </span>
                          )}
                        </div>
                        {row.personaOpen && (
                          <p className={css.personaFull}>{row.persona}</p>
                        )}
                      </>
                    )}
                  </div>
                </div>
                </>
                )}
              </div>
              )
            })}
          </div>
          <button
            type="button"
            className={`${css.outlineButton} ${css.addButton}`}
            disabled={!writable}
            onClick={addRole}
          >
            <PlusIcon />
            {t('roles.add')}
          </button>
        </div>

        {/* ======== 高级选项 (unchanged) ======== */}
        <h2 className={css.sectionHeading} id="fallbacks-advanced" aria-label={t('advanced.label')}>
          <button
            type="button"
            className={css.sectionToggle}
            disabled={!writable}
            aria-expanded={advancedVisible}
            aria-controls={advancedVisible ? 'fallbacks-advanced-body' : undefined}
            aria-label={t(advancedVisible ? 'advanced.collapse' : 'advanced.expand')}
            onClick={() => { if (writable) setAdvancedOpen(!advancedOpen) }}
          >
            <ChevronDownIcon className={advancedVisible ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
            <span className={css.sectionHeadingText}>{t('advanced.label')}</span>
          </button>
        </h2>
        {advancedVisible && (
          <div id="fallbacks-advanced-body" className={css.advancedBody}>
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

        <div className={css.numberFields}>
          <div className={css.field}>
            <span className={css.fieldLabel}>
              <label htmlFor="fallbacks-cooldown-ms">{t('cooldownMs.label')}</label>
              <InfoHint label={cooldownMsTip} disabled={!writable} />
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
              <InfoHint label={maxSwitchesPerStepTip} disabled={!writable} />
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
        </div>
        <div className={css.sectionActions}>
          <button
            type="button"
            className={css.discard}
            disabled={!advancedDirty || saving}
            onClick={() => { discardSection('advanced') }}
          >
            {t('discard')}
          </button>
          <button
            type="button"
            className={css.save}
            disabled={!writable || saving || !advancedDirty}
            onClick={() => { saveSection('advanced') }}
          >
            {saving ? t('save.saving') : t('save')}
          </button>
        </div>
          </div>
        )}
      </fieldset>
    </div>
  )
}
