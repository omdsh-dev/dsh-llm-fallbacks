/**
 * Fallbacks settings card — the `fallbacks` plugin card on the web settings
 * "插件配置" page (spec §4). Registered into the `settings.plugin.item` keyed
 * slot (key `fallbacks`, the settings namespace the card edits, alongside
 * the upstream bash/agent-loop/web-search cards and the advisor card, in
 * registration order); owner props are empty and all data flows
 * through {@link FallbacksSettingsController}.
 *
 * The card chrome replicates the upstream `PluginCard` contract (self-drawn:
 * the upstream client value face exports no reusable card): a collapsible
 * `<li>` whose header is a button stacking the plugin name over its
 * description, with a dirty "unsaved" pill and a rotating chevron
 * (`IconChevronDownOutline14` from ui-primitives — a CLIENT_EXTERNALS value
 * import), `aria-expanded`/`aria-label` like the upstream header; a divider
 * under the header; then the form content. PR #62 UX round 2: the card
 * footer is gone — each big section (主代理 / 子代理 / 高级选项) carries its
 * own Save/Discard actions beside its heading (高级选项: inside the expanded
 * body) and its own validation / save-error surface. PR #62 UX round 3:
 * each section's Save writes ONLY that section's fields — 主代理 owns
 * rootChain / timeSlots / tz (+ the card-level `enabled`), 子代理 owns
 * roles, 高级选项 owns the advanced scalars; the patch spreads the last
 * ACCEPTED config for every other section, so a 主代理 Save can never
 * ride along an unsaved 子代理 edit (and vice versa) — and validation /
 * the dirty gate apply per section too (a bad role id never blocks 主代理,
 * and only the saved section's Discard reverts that section's edits).
 * Save/discard disabled terms: save = `!sectionDirty || saving ||
 * !writable`, discard = `!sectionDirty || saving` (KD-U1). Disclosure is
 * card-local state:
 * which card a user has open is a reading gesture, and staged edits outlive
 * collapsing — the pill rides the header (upstream rationale).
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
 * to-defaults affordance is GONE from the card (PR #62 UX round 3) — the
 * gateway RPC `fallbacks/reset` and the store `resetToDefaults()` stay as
 * host APIs (store/gateway tests unchanged), only the card UI was removed.
 *
 * The page-only chrome is gone (720px column wrapper, title/intro banners,
 * page-bottom status block): the AC-7 read-only status (derived effective
 * model + recent-switch summary) is folded into the card body, and the
 * plugin-config section owns the column width.
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
 * retry. PR #62 UX round 2: the single `state.error` surface is split by
 * origin — a LOAD failure keeps the card-top notice (with Retry when
 * inert), while a WRITE failure renders under the section whose Save was
 * last clicked (`lastSaveSection`), unlike the advisor's separate
 * apply-failure hints.
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
  Button, IconChevronDownOutline14, IconChevronUpOutline14, IconEllipsisOutline16, IconPlusOutline16, IconTrashOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { FallbacksConfig, FallbacksRole, FallbackStrategy, RevertPolicy } from '../config.ts'
import { defaultFallbacksConfig, INHERIT_ROLE_ID, ROLE_ID_PATTERN } from '../config.ts'
import { parseSelector } from '../selectors.ts'
import { resolveSlotState } from '../time-slots.ts'
import {
  FallbacksSettingsController,
  classifyModel,
  classifyProvider,
  mergeRoleExtras,
  rolesToRows,
  rootChainToRows,
  rowsToRootChain,
  rowsToRules,
  rowsToTimeSlots,
  rulesToRows,
  ruleRoleOptions,
  selectionToRaw,
  selectorRowToRaw,
  timeSlotsToRows,
  type CatalogLookup,
  type ChainSelectorRow,
  type FallbacksSettingsState,
  type RoleRow,
  type RoleRuleRow,
  type RootChainRow,
  type SlotEditorRow,
} from './fallbacks-store.ts'
import {
  KNOWN_TRIGGER_CODES,
  SWITCH_REASON_KEYS,
  TRIGGER_CODE_LABELS,
  withTriggerCode,
  type FallbacksKey,
} from './locales.ts'
import css from './FallbacksCard.module.css'

// Frozen strings mirrored from `src/time-slots.ts` (OFFICIAL_V4_FLASH /
// OFFICIAL_V4_PRO / PRESET_IDS) — the card historically kept the resolver
// module out of the client bundle (type-only seam, time-slots.ts docblock),
// so these product-locked exact strings live here too. PR #62 UX round 4:
// the card now ALSO imports the pure `resolveSlotState` helper (the
// time-slots module has no `@deepseek-ai/*` imports — bundling it into the
// client is safe) for the active-slot indicator; the mirrored constants
// stay for validation + the 默认模型 panel.
const ALL_DAY_FLASH = 'deepseek-official/deepseek-v4-flash'
const ALL_DAY_PRO = 'deepseek-official/deepseek-v4-pro'
const SLOT_PRESET_IDS = ['liang-peak', 'liang-valley', 'glm-peak', 'glm-valley'] as const
/** Custom-row day toggle order (index = weekday, 0=Sunday); display copy lives in the dictionaries. */
const SLOT_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** Timezone picker offer set (PR #62 feedback round) — a small curated list
 * of IANA ids; the accepted tz outside the list renders as a synthetic
 * option so the value is never lost. Preset rows lock the value to
 * Asia/Shanghai (their windows are frozen UTC+8 constants). */
const TZ_OPTIONS = [
  'Asia/Shanghai',
  'UTC',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
] as const

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

/** Select option copy: `Asia/Shanghai (UTC+8)`. */
function tzOptionLabel(tz: string): string {
  const offset = tzUtcOffset(tz)
  return offset === '' ? tz : `${tz} (${offset})`
}
/** Strict 24h `HH:mm` — the resolver's HHMM_RE twin (drift-guarded by the gateway reject-on-save). */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * The 默认模型 value for a chain: the official V4 id when the chain TAIL
 * is that model (Flash XOR Pro — leading 默认降级链 entries allowed);
 * `''` for an empty chain or a chain whose last entry is not official
 * (the panel reads back unselected and save validation blocks the value).
 */
function allDayModelOf(chain: readonly string[]): string {
  const tail = chain.length >= 1 ? chain[chain.length - 1] : undefined
  return tail === ALL_DAY_FLASH || tail === ALL_DAY_PRO ? tail : ''
}

/**
 * The 默认降级链 editor row: the leading entries BEFORE the official-V4
 * tail, or the whole chain while the tail is not official (the draft
 * rides the accepted value until a 默认模型 pick).
 */
function allDayChainRowOf(chain: readonly string[], catalog: CatalogLookup | undefined): RootChainRow {
  const tail = allDayModelOf(chain)
  const rest = tail === '' ? chain : chain.slice(0, -1)
  return rootChainToRows(rest, catalog)[0]!
}

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
  // PR #62 feedback round: the tz picker lives in the 分时槽设置 block.
  // Preset rows lock it to Asia/Shanghai at assembly time (UTC+8 frozen
  // windows), so a preset-bearing config always assembles tz Asia/Shanghai.
  tz: string
  // `roleAutoMatch` is ALWAYS defined at runtime (default `true`): the
  // schema default is folded on the real wire (gateway composition + client
  // parse fold), so absent ≡ true (AC-7 re-scope, PM decision 2026-08-17
  // Option A) and the toggle always renders. The nullable type only mirrors
  // the optional config-model field (`FallbacksConfig.roleAutoMatch`,
  // additive, non-breaking for library consumers — src/config.ts).
  roleAutoMatch: boolean | undefined
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
    roleAutoMatch: config.roleAutoMatch,
    tz: config.tz ?? 'Asia/Shanghai',
  }
}

/**
 * Assemble the full config the row editors + scalars describe. The rebuilt
 * `roles.list` comes from the rows, with the schema-reserved
 * `prompt`/`permissions` merged back from the last accepted config by role
 * id (see {@link mergeRoleExtras}) so a save never silently drops them
 * (T2 reviewer minor #2). `presets` (spec §9.4) follows the same rule at
 * the top level: no presets UI this iteration (R-001 re-defer), so the
 * draft carries the accepted value through untouched — a clean draft stays
 * equal to the accepted config and a save never drops the key.
 * `roleAutoMatch` follows the same rule (config-model mirror of `presets`):
 * the draft carries the scalar's value through untouched. The scalar is
 * ALWAYS defined — the gateway composition resolves the schema default
 * `true` even for a legacy config that never declared the key — so the
 * toggle always renders (default on) and a save persists the resolved value
 * (AC-7 re-scope, PM decision 2026-08-17 Option A).
 *
 * All-day: rootChain is composed from the 默认降级链 editor's leading
 * selectors plus the 默认模型 tail (exactly one official V4 — Flash XOR
 * Pro). While no tail is selected the ACCEPTED chain rides through
 * untouched. `timeSlots` is rebuilt from the slot rows every render. `tz`
 * is a card scalar: preset rows lock it to Asia/Shanghai; custom rows
 * follow the selected timezone.
 */
function assembleConfig(
  scalars: FallbacksScalars,
  allDayModel: string,
  acceptedRootChain: readonly string[],
  allDayChainRow: RootChainRow,
  roleRows: readonly RoleRow[],
  ruleRows: readonly RoleRuleRow[],
  originalRoles: readonly FallbacksRole[],
  presets: FallbacksConfig['presets'],
  roleAutoMatch: FallbacksConfig['roleAutoMatch'],
  timeSlotRows: readonly SlotEditorRow[],
): FallbacksConfig {
  const list = mergeRoleExtras(roleRows, originalRoles)
  const trailingChain = rowsToRootChain([allDayChainRow])
  const tz = timeSlotRows.some(row => row.kind === 'preset') ? 'Asia/Shanghai' : scalars.tz
  return {
    enabled: scalars.enabled,
    triggerCodes: [...scalars.triggerCodes],
    rootChain: allDayModel === '' ? [...acceptedRootChain] : [...trailingChain, allDayModel],
    roles: { list, rules: rowsToRules(ruleRows) },
    cooldownMs: scalars.cooldownMs,
    revertPolicy: scalars.revertPolicy,
    maxSwitchesPerStep: scalars.maxSwitchesPerStep,
    alwaysModeRetryCap: scalars.alwaysModeRetryCap,
    ...(presets === undefined ? {} : { presets }),
    roleAutoMatch,
    timeSlots: rowsToTimeSlots(timeSlotRows),
    tz,
  }
}

/**
 * The three big sections the card's Save/Discard actions and error surfaces
 * live on (PR #62 UX round 2): 主代理 (main agent — time slots / default
 * chain / default model), 子代理 (subagents — role entities + role rules),
 * and 高级选项 (advanced options — trigger codes / cooldown / revert /
 * caps / roleAutoMatch). Validation errors are tagged by their OWNING
 * section so a 主代理 violation never renders under 子代理; store write
 * failures render under the section whose Save was last clicked.
 */
type ValidationSection = 'main' | 'sub' | 'advanced'

/** An empty per-section validation-error record (the clean-draft shape). */
function emptyValidationErrors(): Record<ValidationSection, string[]> {
  return { main: [], sub: [], advanced: [] }
}

/**
 * Pre-save validation of the assembled draft (spec §8 / plan Task 3):
 * role id format/reserved word/duplicates, undeclared rule role references
 * (only reachable through the synthetic outside option — the dropdown
 * itself constrains normal edits), and illegal selector entries in
 * rootChain and role chains. Returns one localized message per violation,
 * bucketed by the section that owns the offending field (PR #62 UX round
 * 2 — 主代理: allDay / timeSlots / slot* / tz / default model / default
 * chain; 子代理: role* / rule*; 高级选项: trigger / cooldown / revert /
 * always / roleAutoMatch — the scalars are never validated, so the
 * advanced bucket stays empty today). A non-empty result blocks
 * {@link save} — the draft is never written. `persona` is free text and
 * never validated.
 *
 * `seededIds` is the live trimmed-id → overridden map derived from
 * `state.seeds` (spec §9.4): the empty-chain block relaxes for seeded ids
 * only (spec §9.6 / AC-3 — a seeded role's chain is legitimately empty by
 * design, R4, and its persona edits must stay persistable); non-seeded
 * behavior is byte-identical.
 */
function validateDraft(
  draft: FallbacksConfig,
  t: FallbacksCardProps['t'],
  seededIds: ReadonlyMap<string, boolean>,
): Record<ValidationSection, string[]> {
  const errors = emptyValidationErrors()
  const declaredIds = new Set<string>()
  for (const role of draft.roles.list) {
    if (!ROLE_ID_PATTERN.test(role.id)) {
      errors.sub.push(t('validation.roleIdFormat', { id: role.id }))
    }
    if (role.id === INHERIT_ROLE_ID) {
      errors.sub.push(t('validation.roleIdReserved'))
    }
    if (declaredIds.has(role.id)) {
      errors.sub.push(t('validation.roleIdDuplicate', { id: role.id }))
    }
    declaredIds.add(role.id)
    for (const entry of role.chain ?? []) {
      try {
        parseSelector(entry)
      } catch (error) {
        errors.sub.push(t('validation.selector', { entry, message: (error as Error).message }))
      }
    }
    // A declared role with no model config is meaningless (plan
    // fallbacks-feedback-round T2): the chain has no configured entries —
    // blank selector rows serialize to nothing, so they count as empty —
    // the save is blocked with an inline hint on the role card. Seeded
    // roles are the one exception (spec §9.6 / AC-3): seeds never invent a
    // chain (R4), so a seeded role's chain is legitimately empty by design
    // and the block relaxes for seeded ids only — the persona edit stays
    // persistable. Non-seeded behavior is byte-identical.
    if ((role.chain ?? []).length === 0 && !seededIds.has(role.id.trim())) {
      errors.sub.push(t('validation.roleChainRequired', { id: role.id }))
    }
  }
  // 默认模型 tail: required, not removable. The chain must END with
  // exactly one official V4 model; leading 默认降级链 entries are the
  // ordered walk before that last-resort fallback. An empty default or a
  // legacy chain whose last entry is not official (rides the draft
  // untouched while the panel is unselected) blocks the save.
  const allDayTail = draft.rootChain.length >= 1 ? draft.rootChain[draft.rootChain.length - 1] : undefined
  if (allDayTail !== ALL_DAY_FLASH && allDayTail !== ALL_DAY_PRO) {
    errors.main.push(t('validation.allDayRequired'))
  }
  for (const entry of draft.rootChain) {
    try {
      parseSelector(entry)
    } catch (error) {
      errors.main.push(t('validation.selector', { entry, message: (error as Error).message }))
    }
  }
  // Time-slot rows (plan fallbacks-timeslots Task 3): preset rows must
  // carry a frozen preset id, at most one row per preset; custom rows
  // require strict `HH:mm` bounds and 0–6 integer days; every row needs a
  // non-empty model chain (an empty chain is a no-op the resolver would
  // warn about and skip) and legal selector entries.
  const seenSlotPresets = new Set<string>()
  for (const row of draft.timeSlots ?? []) {
    if (row.kind !== 'preset' && row.kind !== 'custom') {
      errors.main.push(t('validation.slotKind'))
    }
    if (row.kind === 'preset') {
      if (typeof row.preset !== 'string' || !(SLOT_PRESET_IDS as readonly string[]).includes(row.preset)) {
        errors.main.push(t('validation.slotPresetUnknown', { preset: row.preset }))
      } else if (seenSlotPresets.has(row.preset)) {
        errors.main.push(t('validation.slotPresetDuplicate', { preset: row.preset }))
      } else {
        seenSlotPresets.add(row.preset)
      }
      // qc1 F-002: preset rows reject stored windows/day masks the same way
      // the gateway does (`validateTimeSlotsPatch`) — preset windows are
      // frozen code constants. A hand-written YAML row carrying days/start/
      // end is invisible in the preset UI (no window controls render), so
      // without this guard it would pass the card and fail only at the
      // gateway with a generic English banner, un-fixable from the card.
      if (row.start !== undefined || row.end !== undefined || (row.days !== undefined && row.days.length > 0)) {
        errors.main.push(t('validation.slotPresetFrozen'))
      }
    } else if (row.kind === 'custom') {
      if (typeof row.start !== 'string' || typeof row.end !== 'string' || !HHMM_RE.test(row.start) || !HHMM_RE.test(row.end)) {
        errors.main.push(t('validation.slotWindow'))
      }
      if (row.days !== undefined && row.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
        errors.main.push(t('validation.slotDays'))
      }
    }
    for (const entry of row.chain) {
      try {
        parseSelector(entry)
      } catch (error) {
        errors.main.push(t('validation.selector', { entry, message: (error as Error).message }))
      }
    }
    if (row.chain.length === 0) {
      errors.main.push(t('validation.slotChainRequired'))
    }
  }
  const validTargets = new Set([...declaredIds, INHERIT_ROLE_ID])
  for (const rule of draft.roles.rules) {
    if (!validTargets.has(rule.role)) {
      errors.sub.push(t('validation.ruleRoleUndeclared', { role: rule.role }))
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

/**
 * Custom time-slot rows whose window is not valid `HH:mm` — drives the
 * inline red border after a blocked save attempt (same derivation pattern
 * as {@link collectInvalidRoleIds}: one pass per render, index lookup per
 * row).
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
 * One chain entry selector row: provider select + model select (cascade).
 * The GUI never offers a `provider/*` wildcard (root agent and role chains
 * alike; provider-any matching lives in the role rules) — but `provider/*`
 * stays a legal YAML entry, so a wildcard row read back from the server
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
  // with a strict hint (D-4). A wildcard read-back row counts too — without a
  // group there is no model to convert it to, so the select stays disabled
  // instead of offering an empty enabled dropdown.
  const groupMissing = providerRaw !== '' && !providerOutside && group === undefined
  // Nothing selectable: outside provider with no outside model to keep.
  const modelDisabled = disabled || providerRaw === '' || groupMissing || (providerOutside && modelRaw === '')

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
        </label>
        <label className={css.ruleCell}>
          <span className={css.ruleCellLabel}>{t('roles.rule.model')}</span>
          <select
            className={`${css.input} ${css.selectInput}`}
            value={modelRaw}
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
          {groupMissing && (
            <span className={css.hint}>{t('chains.selector.noModelsStrict')}</span>
          )}
        </label>
      </div>
      {(providerOutside || modelOutside) && (
        <span className={css.hint}>
          {t('catalog.outside.hint')}
          <InfoHint label={t('catalog.outside.tooltip')} disabled={disabled} />
        </span>
      )}
      {/* The legacy-conversion hint only renders when a conversion is
          actually possible: with the model select disabled (no catalog group
          / empty provider / outside provider without an outside model) there
          is nothing to pick, so the hint stays off (N-003/N-004). */}
      {selector.wildcard && !modelDisabled && (
        <span className={css.hint}>{t('chains.selector.wildcardLegacy')}</span>
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
  // 默认模型 tail: official V4 id, or '' while the accepted chain has no
  // official last entry. The 默认降级链 editor holds the LEADING entries
  // before that tail.
  const [allDayModel, setAllDayModel] = useState<string>(() => allDayModelOf(defaultFallbacksConfig.rootChain))
  const [allDayChainRow, setAllDayChainRow] = useState<RootChainRow>(() => allDayChainRowOf(defaultFallbacksConfig.rootChain, undefined))
  const [timeSlotRows, setTimeSlotRows] = useState<SlotEditorRow[]>(() => timeSlotsToRows(defaultFallbacksConfig.timeSlots ?? []))
  const [roleRows, setRoleRows] = useState<RoleRow[]>(() => rolesToRows(defaultFallbacksConfig.roles.list))
  const [ruleRows, setRuleRows] = useState<RoleRuleRow[]>(() => rulesToRows(defaultFallbacksConfig.roles.rules))
  // The preset picker's pending selection (UI-only, never part of the draft).
  const [presetToAdd, setPresetToAdd] = useState<string>('')
  // Pre-save validation (spec §8; PR #62 UX round 2): save() validates the
  // assembled draft and a blocked write leaves the messages bucketed by
  // their OWNING section (主代理 / 子代理 / 高级选项) so each section's
  // error surface only shows its own violations, with `validationAttempted`
  // true so the offending role-id rows keep their inline red border. Both
  // clear when a save passes validation or the user discards the draft.
  const [validationErrors, setValidationErrors] = useState<Record<ValidationSection, string[]>>(emptyValidationErrors)
  const [validationAttempted, setValidationAttempted] = useState(false)
  // The section whose Save was last clicked (PR #62 UX round 2): a store
  // write failure (`state.error`) renders under THAT section instead of the
  // card-top banner; null means no save has been attempted, so a load
  // failure keeps the card-top notice + Retry.
  const [lastSaveSection, setLastSaveSection] = useState<ValidationSection | null>(null)
  const seededConfigKey = useRef<string | null>(null)

  // PR #62 UX round 3 — the assembled draft + the PER-SECTION dirty flags,
  // computed once per render and shared by the reseed effects, the header
  // pill, the per-section Save/Discard gates, and save(). Field ownership:
  // 主代理 owns rootChain / timeSlots / tz (+ the card-level `enabled`
  // while the form is shown), 子代理 owns roles (incl. empty rule rows —
  // they serialize away but still count as pending UI), 高级选项 owns the
  // advanced scalars. Each section's dirty term gates ONLY that section's
  // Save/Discard, so a 子代理 edit never enables 主代理 Save (and vice
  // versa); the header pill is the union.
  const draft = assembleConfig(
    scalars, allDayModel, state.config.rootChain, allDayChainRow,
    roleRows, ruleRows,
    state.config.roles.list, state.config.presets, scalars.roleAutoMatch,
    timeSlotRows,
  )
  // Empty rule rows (role still on the "select role" placeholder) never
  // reach the assembled draft — rowsToRules drops them — so they surface as
  // an edit + a validation error instead of silently discarding on save
  // (qc3 F-4).
  const hasEmptyRuleRows = ruleRows.some(row => row.role === '')
  const enabledDirty = scalars.enabled !== state.config.enabled
  const mainDirty = enabledDirty
    || JSON.stringify([...draft.rootChain, draft.timeSlots, draft.tz])
      !== JSON.stringify([...state.config.rootChain, state.config.timeSlots ?? [], state.config.tz ?? 'Asia/Shanghai'])
  const subDirty = hasEmptyRuleRows || JSON.stringify(draft.roles) !== JSON.stringify(state.config.roles)
  const advancedDirty = JSON.stringify([
    draft.triggerCodes, draft.cooldownMs, draft.revertPolicy,
    draft.maxSwitchesPerStep, draft.alwaysModeRetryCap, draft.roleAutoMatch,
  ]) !== JSON.stringify([
    state.config.triggerCodes, state.config.cooldownMs, state.config.revertPolicy,
    state.config.maxSwitchesPerStep, state.config.alwaysModeRetryCap, state.config.roleAutoMatch,
  ])
  const dirty = mainDirty || subDirty || advancedDirty

  // Editors seed from the accepted config on every content-changing ready
  // (PR #62 UX round 3): the reseed is PER-SECTION — only CLEAN sections
  // re-seed, so a 主代理 save can never clobber unsaved 子代理 rows (and
  // vice versa). The FIRST ready is the mount seed (the useState
  // placeholders came from `defaultFallbacksConfig`), which must always
  // land the real config — `firstSeed` bypasses the dirty gates once.
  const firstSeedDone = useRef(false)
  // PR #62 UX round 3: a write that is NOT one of the card's per-section
  // saves (the seed-revert — `controller.revertSeed`) must still re-seed
  // the WHOLE form: the accepted config is the new truth, and the
  // per-section gates exist to protect UNSAVED user edits, not to keep
  // stale editor state after a user-initiated revert. The revert click
  // sets this flag; the next config reseed consumes it as a full reseed.
  const forceReseed = useRef(false)
  useEffect(() => {
    if (state.status !== 'ready') return
    const key = JSON.stringify(state.config)
    if (seededConfigKey.current === key) return
    seededConfigKey.current = key
    const firstSeed = !firstSeedDone.current
    firstSeedDone.current = true
    const force = forceReseed.current
    forceReseed.current = false
    const catalog = catalogOf(state)
    if (firstSeed || force || !mainDirty) {
      setAllDayModel(allDayModelOf(state.config.rootChain))
      setAllDayChainRow(allDayChainRowOf(state.config.rootChain, catalog))
      setTimeSlotRows(timeSlotsToRows(state.config.timeSlots ?? [], catalog))
      setScalars(prev => ({ ...prev, enabled: state.config.enabled, tz: state.config.tz ?? 'Asia/Shanghai' }))
    }
    if (firstSeed || force || !subDirty) {
      setRoleRows(rolesToRows(state.config.roles.list, catalog))
      setRuleRows(rulesToRows(state.config.roles.rules, catalog))
    }
    if (firstSeed || force || !advancedDirty) {
      setScalars(prev => ({
        ...prev,
        triggerCodes: [...state.config.triggerCodes],
        cooldownMs: state.config.cooldownMs,
        revertPolicy: state.config.revertPolicy,
        maxSwitchesPerStep: state.config.maxSwitchesPerStep,
        alwaysModeRetryCap: state.config.alwaysModeRetryCap,
        roleAutoMatch: state.config.roleAutoMatch,
      }))
    }
  }, [state.status, state.config, mainDirty, subDirty, advancedDirty])

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

  // Time-slot row editors (plan fallbacks-timeslots Task 3): preset rows
  // freeze their windows (models-only edits); custom rows edit
  // start/end/days + models. Rows reorder freely — the all-day row below
  // is always last and NOT part of this list.
  const updateTimeSlotRow = (index: number, patch: Partial<SlotEditorRow>): void => {
    setTimeSlotRows(rows => {
      const next = rows.map(row => ({ ...row }))
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }

  const updateTimeSlotSelector = (rowIndex: number, selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    setTimeSlotRows(rows => {
      const next = rows.map(row => ({ ...row, selectors: row.selectors.map(selector => ({ ...selector })) }))
      const selectors = next[rowIndex]!.selectors
      selectors[selectorIndex] = { ...selectors[selectorIndex]!, ...patch }
      return next
    })
  }

  const addTimeSlotSelector = (rowIndex: number): void => {
    setTimeSlotRows(rows => rows.map((row, index) => index === rowIndex
      ? { ...row, selectors: [...row.selectors, { wildcard: false, provider: null, model: null }] }
      : row))
  }

  const removeTimeSlotSelector = (rowIndex: number, selectorIndex: number): void => {
    setTimeSlotRows(rows => rows.map((row, index) => index === rowIndex
      ? { ...row, selectors: row.selectors.filter((_, sIndex) => sIndex !== selectorIndex) }
      : row))
  }

  const addPresetSlotRow = (): void => {
    if (presetToAdd === '') return
    // PR #62 UX round 4 part B: the GLM presets route to zai-coding-cn
    // models — without the provider configured they are unselectable (the
    // disabled option normally prevents it, but a stale selection must not
    // slip through the guard).
    if ((presetToAdd === 'glm-peak' || presetToAdd === 'glm-valley') && !glmConfigured) return
    setTimeSlotRows(rows => [...rows, { kind: 'preset', preset: presetToAdd, start: '', end: '', days: [], name: '', collapsed: false, selectors: [] }])
    setPresetToAdd('')
  }

  const addCustomSlotRow = (): void => {
    setTimeSlotRows(rows => [...rows, { kind: 'custom', start: '', end: '', days: [], name: '', collapsed: false, selectors: [] }])
  }

  const removeTimeSlotRow = (index: number): void => {
    setTimeSlotRows(rows => rows.filter((_, rowIndex) => rowIndex !== index))
  }

  const moveTimeSlotRow = (index: number, delta: -1 | 1): void => {
    setTimeSlotRows(rows => {
      const target = index + delta
      if (target < 0 || target >= rows.length) return rows
      const next = rows.map(row => ({ ...row }))
      const moved = next[index]!
      next[index] = next[target]!
      next[target] = moved
      return next
    })
  }

  // Drag-reorder (PR #62 feedback round): HTML5 DnD on the slot row cards —
  // the dragged index is card-local state (no DataTransfer needed, which
  // keeps the flow jsdom-testable). The up/down buttons stay as the
  // keyboard/precise affordance.
  const [draggedSlotIndex, setDraggedSlotIndex] = useState<number | null>(null)
  const [overSlotIndex, setOverSlotIndex] = useState<number | null>(null)

  const reorderTimeSlotRow = (from: number, to: number): void => {
    setTimeSlotRows(rows => {
      if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows
      const next = rows.map(row => ({ ...row }))
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved!)
      return next
    })
  }

  // 默认降级链 trailing-selector editor (PR #62 feedback round).
  const updateAllDayChainSelector = (selectorIndex: number, patch: Partial<ChainSelectorRow>): void => {
    setAllDayChainRow(row => ({
      ...row,
      selectors: row.selectors.map((selector, index) => index === selectorIndex ? { ...selector, ...patch } : selector),
    }))
  }

  const addAllDayChainSelector = (): void => {
    setAllDayChainRow(row => ({
      ...row,
      selectors: [...row.selectors, { wildcard: false, provider: null, model: null }],
    }))
  }

  const removeAllDayChainSelector = (selectorIndex: number): void => {
    setAllDayChainRow(row => ({
      ...row,
      selectors: row.selectors.filter((_, index) => index !== selectorIndex),
    }))
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
    // PR #62 UX round 2: a freshly added role card starts collapsed like
    // every other role card.
    setRoleRows(rows => [...rows, { id: '', persona: '', selectors: [], fallback: 'inherit-root', collapsed: true }])
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

  // The joined validation errors across all sections — the disabled-state
  // row's single error surface (the per-section surfaces are unmounted
  // while the form is hidden). The per-section dirty flags live with the
  // draft at the top of the component (shared by the reseed effects).
  const allValidationErrors = [...validationErrors.main, ...validationErrors.sub, ...validationErrors.advanced]
  const saving = state.status === 'saving'
  const writable = state.writable
  const unknownCodes = scalars.triggerCodes.filter(code => !KNOWN_TRIGGER_CODES.includes(code))
  // PR #62 feedback round: preset rows lock the tz to UTC+8 / Asia/Shanghai
  // (frozen windows) — the picker is disabled and the assembled tz is forced.
  const presetsPresent = timeSlotRows.some(row => row.kind === 'preset')
  // PR #62 UX round 4 part B: the GLM presets (glm-peak / glm-valley) route
  // to zai-coding-cn models — they are only selectable when that provider is
  // CONFIGURED (the Models-page `configured` join, matching the caveat
  // wording); a non-ready catalog counts as not-configured (conservative
  // default, same as the rest of the card).
  const glmConfigured = state.configuredProviders.some(entry => entry.provider === 'zai-coding-cn')
  // PR #62 UX round 4: the currently-ACTIVE slot row (P5), resolved with
  // the SAME pure helper the runtime uses (`resolveSlotState` — the single
  // source; never derived from switch history), against the ACCEPTED config
  // + the live tz scalar (a live draft snapshot at render is fine). The
  // winner is the matching row OBJECT from the accepted config, or
  // 'all-day'; a row winner is tagged by INDEX — the editor rows preserve
  // the accepted order through load/save, so `timeSlotRows[winnerIndex]`
  // is the matching row. 'all-day' means no slot row matches (the all-day
  // surface is the 默认模型 panel — out of scope), so no row is tagged;
  // a malformed config also resolves 'all-day' → no tag, which is correct.
  const slotState = resolveSlotState(state.config, new Date(), scalars.tz)
  const activeSlotIndex = slotState.winner === 'all-day'
    ? -1
    : (state.config.timeSlots?.indexOf(slotState.winner) ?? -1)

  // The rules role dropdown's offer set — derived ONCE per render and shared
  // by every rule row (qc3 F-3; previously recomputed inside the render
  // loop): a role added/removed on the same page reflects immediately, and
  // the store dedupes on the canonical (trimmed) ids so mid-edit duplicate
  // ids never render duplicate options.
  const roleOptions = ruleRoleOptions({ list: roleRows })
  // Offending role ids after a blocked save attempt, derived once per render
  // into a Set (qc3 F-3) — each row's inline red border is one lookup.
  const invalidRoleIds = validationAttempted ? collectInvalidRoleIds(roleRows) : null
  // Custom slot rows with an invalid `HH:mm` window after a blocked save
  // attempt (same derivation pattern — red borders on the start/end inputs).
  const invalidSlotRows = validationAttempted ? collectInvalidSlotRows(timeSlotRows) : null
  // Seeded-role badge state, derived ONCE per render from the wire `seeds`
  // (spec §9.4; the qc3 F-3 same-derivation pattern): trimmed role id →
  // whether the persona is currently an operator override. The same map
  // drives the badge pill, the revert affordance, and the seeded-only Save
  // relax — each row's membership is a single lookup, and non-seeded rows
  // are indistinguishable from a card without seeds at all.
  const seededIds = new Map<string, boolean>()
  for (const seed of state.seeds) {
    seededIds.set(seed.id.trim(), seed.overridden)
  }

  // The compact recent-switch line: the most recent switch (from → to +
  // role/reason) or an honest empty/loading/error state — one line, never a
  // list (spec §2.5 D-5 semantics unchanged; the store still caps at
  // RECENT_SWITCH_LIMIT). Compass AC-2: this is the ONLY line the read-only
  // status block carries — the effective-model line (D-6) and the selectionNote
  // degradation line moved out of the card (see docs/verification.md).
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
    const params = {
      count: String(state.switches.length),
      from: `${latestSwitch.from.provider}/${latestSwitch.from.model}`,
      to: `${latestSwitch.to.provider}/${latestSwitch.to.model}`,
      role: latestSwitch.role,
      reason: reasonKey === undefined ? latestSwitch.reason : t(reasonKey),
    }
    // Task 5 (direction 3): a `role-inject` switch reads naturally as the
    // resolved role → its chain-head model (`{to}`) instead of the generic
    // `({role} · {reason})` parenthetical — role + reason stay visible
    // (AC-5); all other reasons keep today's shape.
    switchesLine = latestSwitch.reason === 'role-inject'
      ? t('status.switches.compact.roleInject', params)
      : t('status.switches.compact', params)
  }

  // Catalog refresh (llm/adapters-updated) re-classifies rows against the fresh
  // directory: a value that was outside when the settings seeded becomes a
  // catalog option, and the empty-catalog guidance clears (R-3a). PR #62 UX
  // round 3: the re-seed is PER-SECTION like the config reseed — only CLEAN
  // sections re-classify, in-progress edits are never clobbered. The
  // per-section epoch flags are consumed only on an actual re-seed (S-d): a
  // dirty section skips without consuming, so the effect re-runs after its
  // save (dirty → false) and re-seeds the just-saved values against the
  // fresh catalog.
  const catalogSeededSections = useRef<{ epoch: number | null; main: boolean; sub: boolean }>({ epoch: null, main: false, sub: false })
  useEffect(() => {
    if (state.catalogStatus !== 'ready') return
    const seed = catalogSeededSections.current
    if (seed.epoch !== state.catalogEpoch) {
      seed.epoch = state.catalogEpoch
      seed.main = false
      seed.sub = false
    }
    const catalog = catalogOf(state)
    if (!mainDirty && !seed.main) {
      seed.main = true
      setAllDayModel(allDayModelOf(state.config.rootChain))
      setAllDayChainRow(allDayChainRowOf(state.config.rootChain, catalog))
      setTimeSlotRows(timeSlotsToRows(state.config.timeSlots ?? [], catalog))
    }
    if (!subDirty && !seed.sub) {
      seed.sub = true
      setRoleRows(rolesToRows(state.config.roles.list, catalog))
      setRuleRows(rulesToRows(state.config.roles.rules, catalog))
    }
  }, [state.catalogStatus, state.catalogEpoch, state.config, mainDirty, subDirty])

  // PR #62 UX round 3: every section's Save writes ONLY that section's
  // fields through the one gateway (`controller.save`), with the other
  // sections' values taken from the last ACCEPTED config — a 子代理 Save
  // of a 主代理 edit persists neither (the unsaved sibling drafts stay in
  // the editors). The saved section is recorded so a store write failure
  // renders under the section whose Save was clicked; validation violations
  // render under their OWNING section (validateDraft buckets them), and
  // ONLY the saved section's bucket blocks the write.
  const sectionPatch = (section: ValidationSection): FallbacksConfig => {
    const base = { ...state.config, enabled: scalars.enabled }
    switch (section) {
      case 'main':
        return { ...base, rootChain: draft.rootChain, timeSlots: draft.timeSlots, tz: draft.tz }
      case 'sub':
        return { ...base, roles: draft.roles }
      case 'advanced':
        return {
          ...base,
          triggerCodes: draft.triggerCodes,
          cooldownMs: draft.cooldownMs,
          revertPolicy: draft.revertPolicy,
          maxSwitchesPerStep: draft.maxSwitchesPerStep,
          alwaysModeRetryCap: draft.alwaysModeRetryCap,
          roleAutoMatch: draft.roleAutoMatch,
        }
    }
  }

  const save = (section: ValidationSection): void => {
    setLastSaveSection(section)
    const errors = validateDraft(draft, t, seededIds)
    // An empty rule row is invisible to validateDraft (rowsToRules dropped
    // it from the draft) — the row would vanish on a successful save with no
    // explanation. Block the SUB save alongside the draft violations (qc3
    // F-4); the row keeps its inline hint so the user sees why.
    if (section === 'sub' && hasEmptyRuleRows) {
      errors.sub.push(t('validation.ruleRoleRequired'))
    }
    if (errors[section].length > 0) {
      // Validation blocks the write: the draft is never sent to the gateway,
      // and the violations surface under their owning sections + inline red
      // borders (spec §8 — the store's `state.error` data path stays
      // untouched).
      setValidationErrors(errors)
      setValidationAttempted(true)
      return
    }
    setValidationErrors(emptyValidationErrors())
    setValidationAttempted(false)
    void controller.save(sectionPatch(section))
  }

  // The compact disabled-state row (PR #62 UX round 3): the `enabled`
  // master switch is card-level, NOT a section — while the plugin is OFF
  // the row's Save writes ONLY `enabled` merged onto the accepted config
  // (hidden in-memory edits of the other sections are never persisted).
  const saveEnabled = (): void => {
    setLastSaveSection('main')
    setValidationErrors(emptyValidationErrors())
    setValidationAttempted(false)
    void controller.save({ ...state.config, enabled: scalars.enabled })
  }

  // Discard is a pure client-side revert to the last accepted config (no
  // gateway write — upstream semantics), now PER-SECTION: 主代理 Discard
  // reverts main fields (+ the card-level `enabled`), 子代理 Discard reverts
  // roles, 高级选项 Discard reverts the advanced scalars — a 主代理 Discard
  // never reverts 子代理 edits. The upstream disabled term
  // `!sectionDirty || saving` applies (no `!writable`: in read-only the
  // draft can still hold staged edits from before a mid-session writable
  // flip, and a client-side revert is always safe).
  const discardSection = (section: ValidationSection): void => {
    switch (section) {
      case 'main': {
        setAllDayModel(allDayModelOf(state.config.rootChain))
        setAllDayChainRow(allDayChainRowOf(state.config.rootChain, catalogOf(state)))
        setTimeSlotRows(timeSlotsToRows(state.config.timeSlots ?? [], catalogOf(state)))
        setScalars(prev => ({ ...prev, enabled: state.config.enabled, tz: state.config.tz ?? 'Asia/Shanghai' }))
        break
      }
      case 'sub': {
        setRoleRows(rolesToRows(state.config.roles.list, catalogOf(state)))
        setRuleRows(rulesToRows(state.config.roles.rules, catalogOf(state)))
        break
      }
      case 'advanced': {
        setScalars(prev => ({
          ...prev,
          triggerCodes: [...state.config.triggerCodes],
          cooldownMs: state.config.cooldownMs,
          revertPolicy: state.config.revertPolicy,
          maxSwitchesPerStep: state.config.maxSwitchesPerStep,
          alwaysModeRetryCap: state.config.alwaysModeRetryCap,
          roleAutoMatch: state.config.roleAutoMatch,
        }))
        break
      }
    }
    // The draft (section) reverted to the accepted config: any blocked-
    // validation banner/inline marks no longer describe the current draft.
    setValidationErrors(emptyValidationErrors())
    setValidationAttempted(false)
  }

  // The compact disabled-state row's Discard (PR #62 UX round 3): reverts
  // `enabled` only — the smallest correct behavior (hidden drafts of other
  // sections stay staged, matching the save side that never persisted them).
  const discardEnabled = (): void => {
    setScalars(prev => ({ ...prev, enabled: state.config.enabled }))
    setValidationErrors(emptyValidationErrors())
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
    const errors = validateDraft(draft, t, seededIds)
    if (errors.main.length === 0 && errors.sub.length === 0 && errors.advanced.length === 0
      && !ruleRows.some(row => row.role === '')) {
      setValidationErrors(emptyValidationErrors())
      setValidationAttempted(false)
    }
    // `seededIds` is intentionally NOT a dep: it is a fresh Map per render
    // (derived from state.seeds, spec §9.4) and `draft` already re-runs
    // this effect on every render — listing it would only re-run the
    // bounded validateDraft pass with zero behavioral change (qc1 S-8).
  }, [validationAttempted, draft, ruleRows, t])

  // PR #62 UX round 2: a store write failure renders under the section
  // whose Save was clicked; once the store settles READY (a successful
  // write or load) the section anchor is no longer meaningful — a later
  // load failure must go back to the card-top notice + Retry. A write
  // ERROR also clears the revert's force-reseed flag: a failed revert
  // leaves the config untouched, so the flag must not leak into the next
  // (section) save's reseed and clobber unrelated unsaved edits.
  useEffect(() => {
    if (state.status === 'ready') setLastSaveSection(null)
    if (state.status === 'error') forceReseed.current = false
  }, [state.status])

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
  // The advanced options disclosure is card-local USER state, default
  // collapsed (the section is a quiet detail surface). The derived
  // `advancedVisible` mirrors the card header's degraded-open semantics:
  // a read-only view must show the advanced fields without interaction.
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
  // Advanced options: user-collapsible while writable; forced visible in the
  // read-only (degraded) view — same forced-open rule as the card header.
  const advancedVisible = advancedOpen || !writable

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
          {state.status === 'error' && state.error !== null && lastSaveSection === null && (
            // PR #62 UX round 2: a store WRITE failure renders under the
            // section whose Save was clicked (lastSaveSection set); this
            // card-top notice is the LOAD-failure surface (initial load or
            // a refresh that never landed) — the Retry button only shows
            // when the form is inert (the load never landed): with
            // writable the form itself is the retry surface (Save), and a
            // reload would clobber staged edits.
            <div className={css.noticeRow}>
              <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
              {!state.writable && (
                <Button variant="outline" size="sm" onClick={() => { void controller.load() }}>
                  {t('retry')}
                </Button>
              )}
            </div>
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
              <>
                <p className={css.offNotice}>{t('enabled.off')}</p>
                {/* PR #62 UX round 2: the form (and its per-section actions
                 * and error surfaces) is hidden while disabled — this
                 * compact row keeps the enabled flip saveable/discardable
                 * (the old footer's always-visible role; the section
                 * actions themselves live beside the headings once the form
                 * is shown). PR #62 UX round 3: the row writes ONLY
                 * `enabled` merged onto the accepted config (never the
                 * hidden in-memory edits of the other sections); its
                 * Save/Discard gate on the enabled flip alone. Blocked-save
                 * and store errors surface right here (the per-section
                 * surfaces are unmounted). */}
                {allValidationErrors.length > 0 && (
                  <p className={css.error} role="alert">
                    {`${t('validation.blocked')}${allValidationErrors.join('; ')}`}
                  </p>
                )}
                {lastSaveSection === 'main' && state.status === 'error' && state.error !== null && (
                  <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
                )}
                <div className={css.sectionActions}>
                  <button
                    type="button"
                    className={`${css.secondaryButton} ${css.sectionAction}`}
                    disabled={!enabledDirty || saving}
                    onClick={discardEnabled}
                  >
                    {t('discard')}
                  </button>
                  <button
                    type="button"
                    className={`${css.primaryButton} ${css.sectionAction}`}
                    disabled={!writable || saving || !enabledDirty}
                    onClick={saveEnabled}
                  >
                    {saving ? t('save.saving') : t('save')}
                  </button>
                </div>
              </>
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
              {/* PR #62 feedback round: the 主代理 (main agent) section
               * heading groups 分时槽设置 / 默认降级链 / 默认模型 below.
               * PR #62 UX round 2: Save/Discard sit BESIDE the heading and
               * this section's validation / save errors render directly
               * under it (the card footer is gone). PR #62 UX round 3: the
               * actions gate on the MAIN section's dirty term (its fields +
               * the card-level `enabled`) and save only main fields. */}
              <div className={css.sectionHeading} id="fallbacks-main-agent">
                <span className={css.sectionHeadingText}>{t('mainAgent.label')}</span>
                <div className={css.sectionActions}>
                  <button
                    type="button"
                    className={`${css.secondaryButton} ${css.sectionAction}`}
                    disabled={!mainDirty || saving}
                    onClick={() => { discardSection('main') }}
                  >
                    {t('discard')}
                  </button>
                  <button
                    type="button"
                    className={`${css.primaryButton} ${css.sectionAction}`}
                    disabled={!writable || saving || !mainDirty}
                    onClick={() => { save('main') }}
                  >
                    {saving ? t('save.saving') : t('save')}
                  </button>
                </div>
              </div>
              {validationErrors.main.length > 0 && (
                <p className={css.error} role="alert">
                  {`${t('validation.blocked')}${validationErrors.main.join('; ')}`}
                </p>
              )}
              {lastSaveSection === 'main' && state.status === 'error' && state.error !== null && (
                <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
              )}
              {/* 分时槽设置 (plan fallbacks-timeslots Task 3; PR #62 feedback
               * round): the extra-row list — first matching row wins, the
               * all-day (默认降级链) row is always last. Preset rows freeze
               * their windows (read-only summary; models-only edits); custom
               * rows edit start/end/days + models. Rows can be removed,
               * reordered with the buttons, or DRAG-reordered. No
               * `timeSlots.enabled` master switch — adding a row IS the
               * opt-in (spec Settings UX). */}
              <div className={css.field} role="group" aria-labelledby="fallbacks-time-slots">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-time-slots">{t('timeSlots.label')}</span>
                  <InfoHint label={t('timeSlots.tooltip')} disabled={!writable} />
                </span>
                <span className={css.hint}>{t('timeSlots.hint')}</span>
                <div className={css.list}>
                  {timeSlotRows.map((row, index) => {
                    const invalidWindow = invalidSlotRows?.has(index) ?? false
                    const chainEmpty = row.selectors.every(selector => selectorRowToRaw(selector) === '')
                    const firstModel = row.selectors.map(selectorRowToRaw).find(entry => entry !== '')
                    // PR #62 UX round 4 part C: slot rows default COLLAPSED
                    // (same rule as role cards) but a read-only view FORCES
                    // them open — the collapse toggle is disabled when
                    // `!writable`, so without the forced-open term the slot
                    // configs would be unreachable in read-only (mirror of
                    // `roleExpanded` below).
                    const slotExpanded = !row.collapsed || !writable
                    return (
                    <div
                      key={index}
                      className={`${css.editorCard} ${draggedSlotIndex === index ? css.slotCardDragging : ''} ${overSlotIndex === index && draggedSlotIndex !== null && draggedSlotIndex !== index ? css.slotCardOver : ''}`}
                      // PR #62 UX round 2: the CARD is only the drop target —
                      // dragging starts from the dedicated handle below, so a
                      // click on the collapse header never starts a drag.
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
                      {/* Collapse header (PR #62 feedback round; UX round 2):
                       * the WHOLE first row is the toggle (one header
                       * control — chevron + name + first model), with a
                       * SEPARATE drag handle so click ≠ drag. Collapsed rows
                       * show the row name + its first model only, and stay
                       * drag-reorderable (the handle works in both states). */}
                      <div className={css.collapseRow}>
                        <button
                          type="button"
                          className={css.collapseToggle}
                          aria-expanded={slotExpanded}
                          aria-label={t(slotExpanded ? 'timeSlots.collapse' : 'timeSlots.expand')}
                          disabled={!writable}
                          onClick={() => { updateTimeSlotRow(index, { collapsed: !row.collapsed }) }}
                        >
                          <IconChevronDownOutline14 className={slotExpanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
                          <span className={css.collapseTitle}>
                            {row.kind === 'preset'
                              ? t(`timeSlots.preset.${row.preset}.label` as FallbacksKey)
                              : (row.name !== '' ? row.name : `custom ${row.start}-${row.end}`)}
                          </span>
                          {/* PR #62 UX round 4: cost/multiplier tags on the
                           * peak presets (red 高消耗 + yellow x2/x3) and the
                           * 激活 tag on the currently-active row (resolved by
                           * index — see `activeSlotIndex`). The chips sit
                           * AFTER the ellipsizing title span (never inside it
                           * — an in-title chip would be clipped by the
                           * title's text-overflow) and before the first-model
                           * meta, in the same title flex row. */}
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
                          <IconEllipsisOutline16 className={css.dragHandleIcon} />
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
                            // PR #62 feedback: GLM presets route to
                            // zai-coding-cn models — the caveat rides both
                            // GLM preset rows.
                            <span className={css.hint}>{t('timeSlots.preset.glm.note')}</span>
                          )}
                        </>
                      ) : (
                        <>
                          {/* Custom rows carry an editable display name (PR
                           * #62 feedback round — the collapsed header shows
                           * it). */}
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
                            <select
                              className={`${css.input} ${css.selectInput}`}
                              aria-label={t('timeSlots.tz.label')}
                              value={presetsPresent ? 'Asia/Shanghai' : scalars.tz}
                              disabled={!writable || presetsPresent}
                              onChange={event => { updateScalars(draft => { draft.tz = event.target.value }) }}
                            >
                              {TZ_OPTIONS.map(tz => (
                                <option key={tz} value={tz}>{tzOptionLabel(tz)}</option>
                              ))}
                              {scalars.tz !== '' && !(TZ_OPTIONS as readonly string[]).includes(scalars.tz) && (
                                <option value={scalars.tz}>{tzOptionLabel(scalars.tz)}</option>
                              )}
                            </select>
                            <span className={css.hint}>{t('timeSlots.tz.hint')}</span>
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
                          {/* The window-format hint surfaces while a custom
                           * row is partially filled (a fresh blank row stays
                           * quiet — the chain hint below already marks it). */}
                          {(row.start !== '' || row.end !== '')
                            && !(HHMM_RE.test(row.start) && HHMM_RE.test(row.end)) && (
                            <span className={css.hint}>{t('validation.slotWindow')}</span>
                          )}
                        </>
                      )}
                      {chainEmpty && (
                        <span className={css.hint}>{t('validation.slotChainRequired')}</span>
                      )}
                      <div className={css.chainSelectors}>
                        {row.selectors.map((selector, selectorIndex) => (
                          <ChainSelectorEditor
                            key={selectorIndex}
                            selector={selector}
                            catalog={catalogOf(state)}
                            configuredProviders={state.configuredProviders}
                            disabled={!writable}
                            t={t}
                            onChange={patch => { updateTimeSlotSelector(index, selectorIndex, patch) }}
                            onRemove={() => { removeTimeSlotSelector(index, selectorIndex) }}
                          />
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        icon={<IconPlusOutline16 size={14} />}
                        className={css.addButton}
                        onClick={() => { addTimeSlotSelector(index) }}
                      >
                        {t('timeSlots.selector.add')}
                      </Button>
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
                            <IconChevronUpOutline14 />
                          </button>
                          <button
                            type="button"
                            className={css.iconButton}
                            data-tip={t('timeSlots.moveDown')}
                            aria-label={t('timeSlots.moveDown')}
                            disabled={!writable || index === timeSlotRows.length - 1}
                            onClick={() => { moveTimeSlotRow(index, 1) }}
                          >
                            <IconChevronDownOutline14 />
                          </button>
                          <button
                            type="button"
                            className={`${css.iconButton} ${css.iconButtonDanger}`}
                            data-tip={t('timeSlots.remove')}
                            aria-label={t('timeSlots.remove')}
                            onClick={() => { removeTimeSlotRow(index) }}
                          >
                            <IconTrashOutline16 />
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
                        // PR #62 UX round 4 part B: the GLM presets are
                        // unselectable until zai-coding-cn is configured —
                        // the options stay VISIBLE (disabled, never removed)
                        // so the user sees why, with the reason suffix.
                        const glmUnconfigured = !glmConfigured && (id === 'glm-peak' || id === 'glm-valley')
                        return (
                          <option key={id} value={id} disabled={glmUnconfigured}>
                            {t(`timeSlots.preset.${id}.label` as FallbacksKey)}
                            {glmUnconfigured ? t('timeSlots.preset.glm.unconfigured') : null}
                          </option>
                        )
                      })}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconPlusOutline16 size={14} />}
                    disabled={!writable || presetToAdd === ''}
                    onClick={addPresetSlotRow}
                  >
                    {t('timeSlots.addPreset')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconPlusOutline16 size={14} />}
                    disabled={!writable}
                    onClick={addCustomSlotRow}
                  >
                    {t('timeSlots.addCustom')}
                  </Button>
                </div>
              </div>

              {/* 默认降级链 (PR #62 feedback round): the all-day fallback
               * chain as a configurable selector list (add/remove) — the
               * Flash|Pro panel lives in the separate 默认模型 block below.
               * The preemption hints are removed. */}
              <div className={css.field} role="group" aria-labelledby="fallbacks-root-chain">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-root-chain">{t('rootChain.label')}</span>
                  <InfoHint label={t('rootChain.tooltip')} disabled={!writable} />
                </span>
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
                  <div className={css.editorCard}>
                    <div className={css.chainSelectors}>
                      {allDayChainRow.selectors.map((selector, selectorIndex) => (
                        <ChainSelectorEditor
                          key={selectorIndex}
                          selector={selector}
                          catalog={catalogOf(state)}
                          configuredProviders={state.configuredProviders}
                          disabled={!writable}
                          t={t}
                          onChange={patch => { updateAllDayChainSelector(selectorIndex, patch) }}
                          onRemove={() => { removeAllDayChainSelector(selectorIndex) }}
                        />
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<IconPlusOutline16 size={14} />}
                      className={css.addButton}
                      onClick={addAllDayChainSelector}
                    >
                      {t('timeSlots.selector.add')}
                    </Button>
                  </div>
                </div>
              </div>

              {/* 默认模型: official V4 Flash | Pro 二选一 — the LAST
               * fallback of the all-day chain (UI order = walk order).
               * Required: an empty or legacy tail reads back unselected
               * plus the nonconforming notice; save validation blocks. */}
              <div className={css.field} role="group" aria-labelledby="fallbacks-default-model">
                <span className={css.fieldLabel}>
                  <span id="fallbacks-default-model">{t('defaultModel.label')}</span>
                </span>
                <span className={css.hint}>{t('allDay.hint')}</span>
                <div className={css.list}>
                  <div className={css.editorCard}>
                    <label className={css.optionRow}>
                      <input
                        type="radio"
                        name="fallbacks-all-day"
                        checked={allDayModel === ALL_DAY_FLASH}
                        disabled={!writable}
                        onChange={() => { setAllDayModel(ALL_DAY_FLASH) }}
                      />
                      {t('allDay.flash')}
                    </label>
                    <label className={css.optionRow}>
                      <input
                        type="radio"
                        name="fallbacks-all-day"
                        checked={allDayModel === ALL_DAY_PRO}
                        disabled={!writable}
                        onChange={() => { setAllDayModel(ALL_DAY_PRO) }}
                      />
                      {t('allDay.pro')}
                    </label>
                    {allDayModel === '' && (
                      <span className={css.hint}>{t('allDay.nonconforming')}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* PR #62 feedback: the 子代理 (subagents) section heading
               * groups the roles list + the role rules below. PR #62 UX
               * round 2: Save/Discard sit BESIDE the heading and this
               * section's validation / save errors render directly under it
               * (the card footer is gone). PR #62 UX round 3: the actions
               * gate on the SUB section's dirty term (roles/rules + empty
               * rule rows) and save only the roles section. */}
              <div className={css.sectionHeading} id="fallbacks-subagents">
                <span className={css.sectionHeadingText}>{t('subagents.label')}</span>
                <div className={css.sectionActions}>
                  <button
                    type="button"
                    className={`${css.secondaryButton} ${css.sectionAction}`}
                    disabled={!subDirty || saving}
                    onClick={() => { discardSection('sub') }}
                  >
                    {t('discard')}
                  </button>
                  <button
                    type="button"
                    className={`${css.primaryButton} ${css.sectionAction}`}
                    disabled={!writable || saving || !subDirty}
                    onClick={() => { save('sub') }}
                  >
                    {saving ? t('save.saving') : t('save')}
                  </button>
                </div>
              </div>
              {validationErrors.sub.length > 0 && (
                <p className={css.error} role="alert">
                  {`${t('validation.blocked')}${validationErrors.sub.join('; ')}`}
                </p>
              )}
              {lastSaveSection === 'sub' && state.status === 'error' && state.error !== null && (
                <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
              )}
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
                 * ids with the red border (aria-invalid). Seeded rows (R2 —
                 * incl. preset-materialized rows, which surface as seeded
                 * rows) have their id input disabled: seed/preset role ids
                 * are immutable from the card. Only the id is locked —
                 * persona (R3 override/revert) and chain/fallback (R4) stay
                 * editable. A rename can only arrive via an external config
                 * edit; a row whose id no longer matches the wire's seed
                 * declaration renders as an ordinary row. */}
                <div className={css.list}>
                  {roleRows.map((row, index) => {
                    const invalid = invalidRoleIds?.has(row.id.trim()) ?? false
                    // undefined = not a currently seeded row (no badge, no
                    // revert, no Save relax — the row is an ordinary config
                    // row; R2: dropping a declaration keeps the row). Seeded
                    // rows (incl. preset-materialized ones) are id-immutable
                    // (R2): their id input is disabled below — only the id is
                    // locked; persona/chain/fallback stay editable. Renames
                    // arrive only via external config edits; a row whose id
                    // no longer matches the wire's seed declaration renders
                    // as an ordinary row.
                    const seed = seededIds.get(row.id.trim())
                    // Collapse summary (PR #62 feedback round): the first
                    // chain model, or the raw strategy token when the chain
                    // is empty (inherit-root = the role rides the root
                    // chain).
                    const roleFirstModel = row.selectors.map(selectorRowToRaw).find(entry => entry !== '')
                    const roleSummary = roleFirstModel ?? row.fallback
                    // PR #62 UX round 2: role cards default collapsed, but a
                    // read-only view FORCES them open (same rule as the
                    // advanced section) — the collapse toggle is disabled
                    // when `!writable`, so without the forced-open term the
                    // role configs would be unreachable in read-only.
                    const roleExpanded = !row.collapsed || !writable
                    return (
                    <div key={index} className={css.editorCard}>
                      {/* Collapse header (PR #62 UX round 2): the WHOLE first
                       * row is the toggle — one header control (chevron + id
                       * + summary) — so a click anywhere on the row
                       * expands/collapses. Collapsed roles show id + first
                       * chain model (or inherit-root / none). */}
                      <div className={css.collapseRow}>
                        <button
                          type="button"
                          className={css.collapseToggle}
                          aria-expanded={roleExpanded}
                          aria-label={t(roleExpanded ? 'roles.collapse' : 'roles.expand')}
                          disabled={!writable}
                          onClick={() => { updateRoleRow(index, { collapsed: !row.collapsed }) }}
                        >
                          <IconChevronDownOutline14 className={roleExpanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
                          <span className={css.collapseTitle}>{row.id}</span>
                          <span className={css.collapseMeta}>{roleSummary}</span>
                        </button>
                      </div>
                      {roleExpanded && (
                      <>
                      <div className={css.ruleGrid}>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('roles.id')}</span>
                          <input
                            className={`${css.input} ${invalid ? css.inputInvalid : ''}`}
                            value={row.id}
                            placeholder={t('roles.idPlaceholder')}
                            aria-label={t('roles.id')}
                            aria-invalid={invalid ? true : undefined}
                            disabled={!writable || seed !== undefined}
                            onChange={event => { updateRoleRow(index, { id: event.target.value }) }}
                          />
                          <span className={css.hint}>{t('roles.id.hint')}</span>
                        </div>
                      </div>
                      <div className={css.ruleGrid}>
                        <div className={css.ruleCell}>
                          <span className={css.ruleCellLabel}>{t('roles.persona')}</span>
                          <textarea
                            rows={3}
                            className={`${css.input} ${css.inputTextarea}`}
                            value={row.persona}
                            placeholder={t('roles.personaPlaceholder')}
                            aria-label={t('roles.persona')}
                            disabled={!writable}
                            onChange={event => { updateRoleRow(index, { persona: event.target.value }) }}
                          />
                          {seed !== undefined && (
                            // Seed badge + revert (spec §9.4 / AC-3 — R3, not
                            // polish): only CURRENTLY seeded rows carry the
                            // default-vs-override pill and the revert
                            // affordance; dropping a seed declaration leaves
                            // the row ordinary (R2). Revert restores the
                            // CURRENTLY declared seed default through the
                            // gateway, never depends on a card Save, and is
                            // disabled while the card cannot write or a write
                            // is in flight. The pill reuses the `pending`
                            // pill vocabulary and the row rides the `hint`
                            // rhythm — no new control shapes.
                            <span className={css.hint}>
                              <span className={css.pending}>
                                {t(seed ? 'roles.seedOverride' : 'roles.seedDefault')}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!writable || saving}
                                onClick={() => {
                                  // PR #62 UX round 3: the revert is a
                                  // user-initiated NON-section write — the
                                  // accepted config is the new truth, so the
                                  // next config reseed must bypass the
                                  // per-section dirty gates (the editor
                                  // holds the pre-revert value and would
                                  // otherwise look "dirty").
                                  forceReseed.current = true
                                  void controller.revertSeed(row.id.trim())
                                }}
                              >
                                {t('roles.revertPersona')}
                              </Button>
                            </span>
                          )}
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
                          // model config. Non-seeded: save is blocked
                          // (roleChainRequired) and the inline hint explains
                          // why (plan fallbacks-feedback-round T2),
                          // unconditional while no row serializes to a usable
                          // chain entry. Seeded: the chain is legitimately
                          // empty by design (R4 — seeds never invent one), so
                          // the hint turns non-blocking (seedChainOptional)
                          // and the Save relax persists the persona edit
                          // (spec §9.6 / AC-3).
                          <span className={css.hint}>
                            {seed !== undefined
                              ? t('roles.seedChainOptional', { id: row.id })
                              : t('validation.roleChainRequired', { id: row.id })}
                          </span>
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
                      </>
                      )}
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
                      {/* PR #62 feedback: no origin cell — rules are
                       * subagent-only; a persisted wire `origin` is ignored. */}
                      <div className={css.ruleGrid}>
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
                    setRuleRows(rows => [...rows, { provider: null, model: null, role: '' }])
                  }}
                >
                  {t('roles.addRule')}
                </Button>
              </div>
              <div className={css.field} role="group" aria-labelledby="fallbacks-advanced">
                {/* The toggle is explicitly `disabled` in a read-only view
                    (`!writable` — the same value the wrapping fieldset uses,
                    made explicit so the inert state survives jsdom, which
                    does not propagate fieldset[disabled] to buttons); the
                    click gate below covers the writable-only toggle;
                    aria-expanded stays derived (forced true in the read-only
                    view). The group's accessible name rides a STATIC span id
                    (not the button's flipping aria-label): `fallbacks-advanced`
                    names the inner text span, so the group name is always
                    "Advanced options"; aria-controls is conditional because
                    the body unmounts while collapsed (F-006). */}
                <button
                  type="button"
                  className={css.sectionToggle}
                  disabled={!writable}
                  aria-expanded={advancedVisible}
                  aria-controls={advancedVisible ? 'fallbacks-advanced-body' : undefined}
                  aria-label={t(advancedVisible ? 'advanced.collapse' : 'advanced.expand')}
                  onClick={() => { if (writable) setAdvancedOpen(!advancedOpen) }}
                >
                  <span id="fallbacks-advanced" className={css.sectionToggleText}>{t('advanced.label')}</span>
                  <IconChevronDownOutline14 className={advancedVisible ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
                </button>
                {advancedVisible && (
                  <div id="fallbacks-advanced-body">
                    {/* The roleAutoMatch toggle (plan fallbacks-settings-visibility Task 3): a
                     * row-level preference in the advanced section, default on (the
                     * config-model default). It ALWAYS renders (AC-7 re-scope, PM
                     * decision 2026-08-17 Option A): the gateway composition always
                     * resolves the schema default `true` for the key — even for a
                     * legacy config that never declared it — so there is no
                     * client-side key-presence signal to hide on. The toggle reads
                     * and writes the scalar → the existing draft → config path via
                     * `assembleConfig`; a legacy config's first save therefore
                     * persists `roleAutoMatch: true` (semantically identical to the
                     * default). */}
                    <div className={css.checkboxRow}>
                      <div className={css.checkLabel}>
                        <span className={css.checkLabelTitle}>
                          <label htmlFor="fallbacks-role-automatch">{t('roleAutoMatch.label')}</label>
                          <InfoHint label={t('roleAutoMatch.tooltip')} disabled={!writable} />
                        </span>
                        <span className={css.checkLabelDesc}>{t('roleAutoMatch.hint')}</span>
                      </div>
                      <input
                        id="fallbacks-role-automatch"
                        type="checkbox"
                        className={css.checkbox}
                        checked={scalars.roleAutoMatch}
                        disabled={!writable}
                        onChange={event => { updateScalars(draft => { draft.roleAutoMatch = event.target.checked }) }}
                      />
                    </div>
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
                    {/* PR #62 UX round 2: the advanced section's Save/Discard
                     * live INSIDE the expanded body (not next to the collapsed
                     * toggle). PR #62 UX round 3: they gate on the advanced
                     * section's own dirty term only; the global Reset is gone
                     * from the card. This section's validation / save errors
                     * render right above the actions. */}
                    {validationErrors.advanced.length > 0 && (
                      <p className={css.error} role="alert">
                        {`${t('validation.blocked')}${validationErrors.advanced.join('; ')}`}
                      </p>
                    )}
                    {lastSaveSection === 'advanced' && state.status === 'error' && state.error !== null && (
                      <p className={css.error} role="alert">{t('error.generic', { message: state.error })}</p>
                    )}
                    <div className={css.sectionActions}>
                      <button
                        type="button"
                        className={`${css.secondaryButton} ${css.sectionAction}`}
                        disabled={!advancedDirty || saving}
                        onClick={() => { discardSection('advanced') }}
                      >
                        {t('discard')}
                      </button>
                      <button
                        type="button"
                        className={`${css.primaryButton} ${css.sectionAction}`}
                        disabled={!writable || saving || !advancedDirty}
                        onClick={() => { save('advanced') }}
                      >
                        {saving ? t('save.saving') : t('save')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </fieldset>
            )}
          </div>

          {/* AC-2 read-only status, compact and folded into the card body
           * (above the footer — the page-bottom block is gone): only the most
           * recent switch (D-5 — read through the store's `sessions.history`
           * face). The effective-model line (D-6) and the selectionNote
           * degradation line moved out of the card (compass AC-2): the
           * selectionNote degradation is re-homed to docs/verification.md
           * §4.7, while the D-6 trim itself is documented there at §4.3
           * item 4 (the derived-value helper stays as a store export — D-6
           * contract retention). The verbose config-summary dump is gone;
           * errors/empty still render, compact. */}
          <div className={css.statusBlock}>
            <span className={css.statusTitle}>{t('status.title')}</span>
            <p className={css.statusLine} role={state.switchesStatus === 'error' ? 'alert' : undefined}>
              <span className={css.statusLineLabel}>{t('status.switches.label')}</span>
              {switchesLine}
            </p>
          </div>

        </div>
      )}

    </li>
  )
}
