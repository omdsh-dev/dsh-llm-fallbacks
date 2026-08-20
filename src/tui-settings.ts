/**
 * dsh-tui settings-section surface (plan fallbacks-tui-settings Task 1,
 * AC-1 + AC-2): registers a `tuiSettingsSections` section for the
 * `fallbacks` settings namespace so the dsh-tui profile's `/settings`
 * screen shows every web-card capability as an editable form — with ZERO
 * dsh-TUI changes.
 *
 * The service and its shapes are consumed structurally (read-only reference:
 * dsh-TUI @ 2747b87, `src/dsh-adapter/settings-sections.ts`): the six types
 * below are minimal local copies of the host's `TuiSettingsFieldKind` /
 * `TuiSettingsFieldOption` / `TuiSettingsFieldWrite` / `TuiSettingsField` /
 * `TuiSettingsGroup` / `TuiSettingsSection` (reusing the plugin's existing
 * `TuiLocalizedDescriptions` copy of the host `LocalizedDescriptions`), so
 * no `@deepseek-harness-tui/dsh-tui` peer is needed (plan constraint: zero
 * new peer/dependency).
 *
 * The screen runs `format`/`parse` IN-PROCESS (verified probe against main
 * 2747b87: `settingsEditor.ts` `defaultFormat`/`defaultParse` call
 * `field.format(value)` / `field.parse(text)` directly — no IPC
 * serialization), so custom JSON/trigger-code parsers reach the renderer.
 * Complex web-card structures are carried by `text` fields whose `parse`
 * mirrors the gateway's save rules through the exported
 * {@link validateConfigPatch} — an invalid draft returns `undefined` and
 * blocks the save (never writes partial/corrupt config); a blank draft
 * stages a `clear` (the field re-inherits the composition layer).
 *
 * @module dsh-llm-fallbacks/tui-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { validateConfigPatch } from './gateway.ts'
import type { TuiLocalizedDescriptions } from './tui.ts'

/** Control kinds the TUI settings screen knows how to render (host shape). */
export type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

/** One select choice (host `TuiSettingsFieldOption` shape). */
export interface TuiSettingsFieldOption {
  /** Stored value. */
  value: string
  /** Display label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: TuiLocalizedDescriptions
}

/** The write one field's draft stages when the section is saved (host shape). */
export type TuiSettingsFieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** One editable field (host `TuiSettingsField` shape). */
export interface TuiSettingsField {
  /** Key path from the section root, in the settings service's mutate vocabulary. */
  path: readonly string[]
  /** Short field label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: TuiLocalizedDescriptions
  /** Optional one-line help rendered under the field. */
  hint?: string
  /** Provider-owned translations for the hint. */
  hintDescriptions?: TuiLocalizedDescriptions
  /** Optional group id; grouped fields render on that group's subpage. */
  group?: string
  kind: TuiSettingsFieldKind
  /** Choices for `kind: 'select'` (ignored otherwise). */
  options?: readonly TuiSettingsFieldOption[]
  /** Input placeholder for `kind: 'text' | 'number'`. */
  placeholder?: string
  /**
   * Render a stored value as draft text. Defaults to the kind's conversion.
   * The screen calls this directly with the namespace-view value (which may
   * be `undefined` when the field path is absent), so every custom format
   * must guard `undefined`/`null` → `''`.
   */
  format?(value: unknown): string
  /**
   * The write this draft text stages, or `undefined` when the text is not a
   * value this field accepts — an invalid draft blocks the save. A custom
   * parse REPLACES the host's default blank→clear, so it must handle the
   * empty draft itself.
   */
  parse?(text: string): TuiSettingsFieldWrite | undefined
}

/** One navigation group inside the section (host `TuiSettingsGroup` shape). */
export interface TuiSettingsGroup {
  /** Stable identifier, unique inside the section. */
  id: string
  /** Group title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: TuiLocalizedDescriptions
}

/** One plugin's section inside the TUI settings screen (host shape). */
export interface TuiSettingsSection {
  /** Settings namespace this section edits — matches the plugin's registration. */
  ns: string
  /** Section title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: TuiLocalizedDescriptions
  /** Optional navigation groups, in display order. */
  groups?: readonly TuiSettingsGroup[]
  /** Editable fields, in display order. */
  fields: readonly TuiSettingsField[]
}

/** The section namespace — must match the `fallbacks` settings namespace. */
export const FALLBACKS_TUI_SECTION_NS = 'fallbacks'

/**
 * Render a JSON-backed field's stored value as draft text. The host calls
 * `format(value)` with the namespace-view value (absent path → `undefined`),
 * so both `undefined` and `null` render as an empty draft. Pretty-printed so
 * operators can read/edit the structure directly in the TUI.
 */
function jsonFieldFormat(value: unknown): string {
  return value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
}

/**
 * Build the parse for a JSON-backed text field: blank/whitespace text stages
 * a `clear` (the field re-inherits the composition layer — a custom parse
 * replaces the host's default blank→clear, so the empty draft is owned
 * here), then `JSON.parse` + the gateway's `validateConfigPatch` on the
 * parsed value (invalid JSON or a shape the gateway would reject on save →
 * `undefined`, blocking the save — never partial/corrupt config).
 */
function jsonFieldParse(
  patch: (parsed: unknown) => Record<string, unknown>,
): (text: string) => TuiSettingsFieldWrite | undefined {
  return (text) => {
    if (text.trim() === '') return { kind: 'clear' }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    try {
      validateConfigPatch(patch(parsed))
    } catch {
      return undefined
    }
    return { kind: 'set', value: parsed }
  }
}

/**
 * Render `triggerCodes` as comma-separated draft text. Non-array values
 * (absent path) render as an empty draft.
 */
function triggerCodesFormat(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : ''
}

/**
 * Parse a comma-separated `triggerCodes` draft: blank → `clear`; otherwise
 * split on `,`, trim, and drop empty tokens into the string array the
 * schema expects. Any non-string token (impossible from a string split, kept
 * as the total guard) → `undefined` (save blocked).
 */
function triggerCodesParse(text: string): TuiSettingsFieldWrite | undefined {
  if (text.trim() === '') return { kind: 'clear' }
  const tokens = text
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
  if (tokens.some((token) => typeof token !== 'string')) return undefined
  return { kind: 'set', value: tokens }
}

/**
 * The `fallbacks` /settings section: 13 fields covering all 15 web-card
 * capabilities (the default-model choice rides `rootChain`'s last entry and
 * the per-role fallback strategy rides `roles.list` JSON). Scalar
 * capabilities use native kinds (boolean/number/select); complex structures
 * use `text` fields with custom `format`/`parse` that mirror the gateway's
 * validation. Built fresh per call — the host deep-freezes whatever it
 * receives, and each registration stays independent.
 */
export function buildFallbacksTuiSection(): TuiSettingsSection {
  return {
    ns: FALLBACKS_TUI_SECTION_NS,
    title: 'fallbacks',
    descriptions: {
      zh: '回退设置：降级链、分时切换、角色与高级选项（与 Web 设置卡片完全一致）。',
      en: 'Fallback settings: degradation chains, time slots, roles, and advanced options (full parity with the web settings card).',
    },
    groups: [
      { id: 'general', title: 'General', descriptions: { zh: '通用', en: 'General' } },
      { id: 'chain', title: 'Fallback chain', descriptions: { zh: '降级链', en: 'Fallback chain' } },
      { id: 'roles', title: 'Roles', descriptions: { zh: '角色', en: 'Roles' } },
      { id: 'advanced', title: 'Advanced', descriptions: { zh: '高级', en: 'Advanced' } },
    ],
    fields: [
      {
        path: ['enabled'],
        label: 'Enabled',
        descriptions: { zh: '启用回退', en: 'Enabled' },
        group: 'general',
        kind: 'boolean',
      },
      {
        path: ['roleAutoMatch'],
        label: 'LLM role auto-match',
        descriptions: { zh: 'LLM 角色自动匹配', en: 'LLM role auto-match' },
        group: 'general',
        kind: 'boolean',
      },
      {
        path: ['presets'],
        label: 'Preset roles',
        descriptions: { zh: '预置角色', en: 'Preset roles' },
        group: 'general',
        kind: 'select',
        options: [
          {
            value: 'bundled',
            label: 'Bundled (7 preset roles)',
            descriptions: { zh: '预置（7 个预置角色）', en: 'Bundled (7 preset roles)' },
          },
          { value: 'none', label: 'None', descriptions: { zh: '不注入', en: 'None' } },
        ],
      },
      {
        path: ['triggerCodes'],
        label: 'Trigger codes',
        descriptions: { zh: '触发码', en: 'Trigger codes' },
        hint: 'Comma-separated failure codes that trigger the fallback.',
        hintDescriptions: { zh: '逗号分隔的触发回退的失败码。', en: 'Comma-separated failure codes that trigger the fallback.' },
        group: 'general',
        kind: 'text',
        format: triggerCodesFormat,
        parse: triggerCodesParse,
      },
      {
        path: ['tz'],
        label: 'Timezone',
        descriptions: { zh: '时区', en: 'Timezone' },
        group: 'general',
        kind: 'text',
      },
      {
        path: ['rootChain'],
        label: 'Root chain (JSON)',
        descriptions: { zh: '根降级链（JSON）', en: 'Root chain (JSON)' },
        hint: 'JSON array of model selectors; the last entry must be an official V4 model.',
        hintDescriptions: { zh: '模型选择器 JSON 数组；末项必须是官方 V4 模型。', en: 'JSON array of model selectors; the last entry must be an official V4 model.' },
        group: 'chain',
        kind: 'text',
        format: jsonFieldFormat,
        parse: jsonFieldParse((parsed) => ({ rootChain: parsed })),
      },
      {
        path: ['timeSlots'],
        label: 'Time slots (JSON)',
        descriptions: { zh: '分时切换（JSON）', en: 'Time slots (JSON)' },
        hint: 'JSON array of slot rows (kind: preset|custom).',
        hintDescriptions: { zh: '分时行 JSON 数组（kind: preset|custom）。', en: 'JSON array of slot rows (kind: preset|custom).' },
        group: 'chain',
        kind: 'text',
        format: jsonFieldFormat,
        parse: jsonFieldParse((parsed) => ({ timeSlots: parsed })),
      },
      {
        path: ['roles', 'list'],
        label: 'Roles (JSON)',
        descriptions: { zh: '角色列表（JSON）', en: 'Roles (JSON)' },
        group: 'roles',
        kind: 'text',
        format: jsonFieldFormat,
        parse: jsonFieldParse((parsed) => ({ roles: { list: parsed } })),
      },
      {
        path: ['roles', 'rules'],
        label: 'Role rules (JSON)',
        descriptions: { zh: '角色规则（JSON）', en: 'Role rules (JSON)' },
        group: 'roles',
        kind: 'text',
        format: jsonFieldFormat,
        parse: jsonFieldParse((parsed) => ({ roles: { rules: parsed } })),
      },
      {
        path: ['cooldownMs'],
        label: 'Cooldown (ms)',
        descriptions: { zh: '冷却时间（毫秒）', en: 'Cooldown (ms)' },
        group: 'advanced',
        kind: 'number',
      },
      {
        path: ['maxSwitchesPerStep'],
        label: 'Max switches per step',
        descriptions: { zh: '单步最大切换次数', en: 'Max switches per step' },
        group: 'advanced',
        kind: 'number',
      },
      {
        path: ['alwaysModeRetryCap'],
        label: 'Always-mode retry cap',
        descriptions: { zh: 'Always 模式重试上限', en: 'Always-mode retry cap' },
        group: 'advanced',
        kind: 'number',
      },
      {
        path: ['revertPolicy'],
        label: 'Revert policy',
        descriptions: { zh: '恢复策略', en: 'Revert policy' },
        group: 'advanced',
        kind: 'select',
        options: [
          {
            value: 'cooldown-expiry',
            label: 'Cooldown expiry',
            descriptions: { zh: '冷却到期', en: 'Cooldown expiry' },
          },
          { value: 'never', label: 'Never', descriptions: { zh: '从不', en: 'Never' } },
        ],
      },
    ],
  }
}

/**
 * Register the `fallbacks` section on the optional `tuiSettingsSections`
 * service. First-fiber-only (`serviceOwned === true` — mirrors
 * `installTuiClient` and the gateway/typert multi-fiber dedupe; the host
 * registry throws on a duplicate namespace, so a deduped later fiber must
 * never register). The service is optional: a composition without
 * `dsh-tui-settings-sections` keeps the plugin working and simply omits the
 * TUI settings surface.
 *
 * The inject child returns the registry disposer so cordis withdraws the
 * registration when this fiber (or the service) goes away.
 */
export function installTuiSettingsSection(ctx: Context, opts: { serviceOwned: boolean }): void {
  if (!opts.serviceOwned) return
  ctx.inject(['tuiSettingsSections'], (tctx) => {
    // Structural accessor: the inject key stays in the standard position
    // while the service is read through the narrow local shape — the key is
    // not on this repo's `Context`, so the child context is widened once.
    const registry = (tctx as unknown as {
      tuiSettingsSections?: { register(section: TuiSettingsSection): () => void }
    }).tuiSettingsSections
    if (registry === undefined) return
    return registry.register(buildFallbacksTuiSection())
  })
}
