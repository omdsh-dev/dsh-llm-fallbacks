/**
 * `/fallbacks` slash command (plan fallbacks-role-runtime T3, AC-5).
 *
 * Session-scoped, read-only diagnostic: current session origin → resolved
 * role → resolved chain (role chain, else rootChain — an `inherit: true`
 * tail is annotated 「（inherit-root）」) → recent `fallbacks/switch` events
 * (newest first, capped) → cooldown status. Mirrors dsh-advisor's
 * `/advisor` command pattern: a conditional `ctx.inject(['commands'])` child
 * in `src/index.ts` calls {@link registerFallbacksCommands} with a
 * factory-bound handler; `commands` never joins the top-level inject list, so
 * the command is silently absent when no command registry is composed (no
 * top-level inject pollution — advisor T1 fix).
 *
 * The handler is **read-only**: it never mutates fallback state (no cooldown
 * reset, no pending-switch writes). zh/en copy lives in this file — the
 * client half's `src/client/locales.ts` is a separate client-side dictionary.
 * The host carries no per-session locale signal (the `locale` service is
 * client-side), so the wiring picks a deterministic default (`zh`, this
 * repo's primary language); both dictionaries are unit-tested.
 *
 * @module dsh-llm-fallbacks/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { INHERIT_ROLE_ID, type FallbacksRole } from './config.ts'
import type { Origin } from './roles.ts'
import type { FallbacksSwitchEventData } from './events.ts'

/** How many recent `fallbacks/switch` events `/fallbacks` shows (newest first). */
export const RECENT_SWITCHES_LIMIT = 5

/** Minimal command registry surface (satisfied by the dsh `CommandService`). */
export interface FallbacksCommandRegistry {
  register(definition: CommandDefinition): () => void
}

/** Minimal agent/session surface the command reads (satisfied by the real `Agent`). */
export interface FallbacksCommandAgent {
  readonly id: string
  readonly options?: { readonly provider?: string; readonly model?: string }
  readonly session: {
    readonly header?: { readonly origin?: Origin }
    readonly events: readonly unknown[]
  }
}

/** One active cooldown entry displayed by `/fallbacks`. */
export interface FallbacksCooldownEntry {
  /** `${provider}/${model}` key. */
  readonly key: string
  /** Expiry epoch ms; `Infinity` for `revertPolicy: 'never'`. */
  readonly untilEpochMs: number
}

/** The read-only diagnostic snapshot the `/fallbacks` handler renders. */
export interface FallbacksCommandSnapshot {
  /** Session origin: `'root'` when the agent carries no header origin. */
  readonly origin: Origin
  /** Resolved role (first matching `roles.rules` entry → built-in `'inherit'`, spec §7.1). */
  readonly role: string
  /** True when the role's own chain is non-empty and shown; false when rootChain (or none) is shown. */
  readonly chainRole: boolean
  /** The displayed chain entries: the role's own chain when non-empty, else
   * rootChain — except `fallback: 'none'` with an empty own chain, which
   * yields `[]` even when rootChain is non-empty (nothing appended, mirroring
   * resolveChainViews' `[...[], ...[]]`); empty = not configured. */
  readonly chain: readonly string[]
  /** True when rootChain is appended as the inherit fallback tail (role's
   * `fallback` is `'inherit-root'` — or the role is unknown — and rootChain
   * is non-empty; the diagnostic annotation source, spec §7.4). */
  readonly inherit: boolean
  /** Recent `fallbacks/switch` events, newest first, capped at {@link RECENT_SWITCHES_LIMIT}. */
  readonly switches: readonly FallbacksSwitchEventData[]
  /** Active cooldown entries for the agent. */
  readonly cooldown: readonly FallbacksCooldownEntry[]
}

/**
 * The composed-config surface `/fallbacks config` renders (plan
 * fallbacks-tui-client T2, AC-2): the composed `fallbacks` namespace as the
 * runtime sees it (settings user layer included). Roles are summarized from
 * `roles.list` as `{ id, chainCount }` — the two-block model: `roles.list`
 * entities carry id/persona/chain/fallback (NO per-role `model`;
 * `provider`/`model` live on `roles.rules`), so the readback line is id +
 * chain count, never a rules dump.
 */
export interface FallbacksConfigSummary {
  readonly enabled: boolean
  readonly triggerCodes: readonly string[]
  readonly rootChain: readonly string[]
  readonly roles: readonly { id: string; chainCount: number }[]
  readonly cooldownMs: number
  readonly revertPolicy: string
  readonly maxSwitchesPerStep: number
  readonly alwaysModeRetryCap: number
  readonly presets: 'bundled' | 'none'
}

/**
 * The session-scoped read-only operations the `/fallbacks` handler drives.
 * Implemented by the wiring (`src/index.ts`) against the live config source
 * (`roles.list` / `rootChain` — no chain map anymore) and the per-agent
 * state store; faked in unit tests.
 */
export interface FallbacksCommandController {
  /** Snapshot the session's fallback diagnostics. Never mutates state. */
  getSnapshot(agent: FallbacksCommandAgent): FallbacksCommandSnapshot
  /**
   * Snapshot the composed fallbacks config (settings readback). Not
   * agent-scoped — the composed config is session-independent; reads the
   * same live config source the runtime reads. Never mutates state.
   */
  getConfig(): FallbacksConfigSummary
}

// ---------------------------------------------------------------------------
// zh/en copy (zh source, en mirror — repo locale convention)
// ---------------------------------------------------------------------------

/**
 * The `config` subcommand's localized one-line description — single copy
 * source: consumed by the `usageConfig` copy key (TUI completion node) and
 * the `usage` USAGE line (plan fallbacks-tui-client T2 — the USAGE line
 * references this key instead of duplicating its text).
 */
const CONFIG_SUBCOMMAND_DESCRIPTION = {
  zh: '查看组合后的 fallbacks 配置（设置回读）',
  en: 'show the composed fallbacks config (settings readback)',
} as const

/** zh/en dictionaries for the `/fallbacks` output. */
export const FALLBACKS_COMMAND_LOCALES = {
  zh: {
    title: '当前会话 fallback 诊断（只读）',
    description: '查看当前会话的降级链、最近切换与冷却状态（只读）',
    usageConfig: CONFIG_SUBCOMMAND_DESCRIPTION.zh,
    usage: `  /fallbacks config   ${CONFIG_SUBCOMMAND_DESCRIPTION.zh}`,
    origin: '会话来源',
    role: '角色',
    chain: '链',
    inheritRoot: '（inherit-root）',
    chainNone: '未配置',
    switches: '最近切换',
    switchesNone: '本会话暂无 fallback 切换',
    switchLine: '{from} → {to}（role={role}，reason={reason}）',
    cooldown: '冷却',
    cooldownNone: '无活跃冷却',
    cooldownLine: '{key} 冷却至 {time}',
    cooldownNever: '{key} 会话内不再回主',
    reason: {
      'trigger-code': '触发码',
      'always-cap': 'always 上限',
    },
    // /fallbacks config (composed-config readback) labels — values stay raw
    // (enum strings / numbers / file paths), labels localize (T2 AC-2).
    configTitle: 'Fallbacks 配置',
    configEnabled: '已启用',
    configDisabled: '未启用',
    configTriggerCodes: '触发码',
    configRootChain: '根链',
    configEmpty: '（空）',
    configRoles: '角色',
    configRoleItem: '{id}（chain: {n}）',
    configCooldown: '冷却',
    configRevert: '回主策略',
    configMaxSwitches: '单步最大切换',
    configAlwaysCap: 'always 上限',
    configPresets: '预置',
    configEdit: '编辑：~/.dsh/profiles/<profile>/cordis.patch.yml（插件行）或 $DSH_HOME/settings.yaml（fallbacks: 分节）',
    configEditHint: 'TUI 无法修改配置——只能编辑文件',
  },
  en: {
    title: 'Session fallback diagnostics (read-only)',
    description: 'Inspect fallback chain, recent switches, and cooldown for this session (read-only)',
    usageConfig: CONFIG_SUBCOMMAND_DESCRIPTION.en,
    usage: `  /fallbacks config   ${CONFIG_SUBCOMMAND_DESCRIPTION.en}`,
    origin: 'Session origin',
    role: 'Role',
    chain: 'Chain',
    inheritRoot: ' (inherit-root)',
    chainNone: 'not configured',
    switches: 'Recent switches',
    switchesNone: 'No fallback switches in this session',
    switchLine: '{from} → {to} (role={role}, reason={reason})',
    cooldown: 'Cooldown',
    cooldownNone: 'none active',
    cooldownLine: '{key} suppressed until {time}',
    cooldownNever: '{key} not reverting this session',
    reason: {
      'trigger-code': 'trigger-code',
      'always-cap': 'always-cap',
    },
    configTitle: 'Fallbacks config',
    configEnabled: 'enabled',
    configDisabled: 'disabled',
    configTriggerCodes: 'Trigger codes',
    configRootChain: 'Root chain',
    configEmpty: '(empty)',
    configRoles: 'Roles',
    configRoleItem: '{id} (chain: {n})',
    configCooldown: 'Cooldown',
    configRevert: 'Revert',
    configMaxSwitches: 'Max switches/step',
    configAlwaysCap: 'Always-mode cap',
    configPresets: 'Presets',
    configEdit: 'Edit: ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) or $DSH_HOME/settings.yaml (fallbacks: section)',
    configEditHint: 'TUI cannot change config — edit files only',
  },
} as const

/** A locale id supported by {@link FALLBACKS_COMMAND_LOCALES}. */
export type FallbacksCommandLocale = keyof typeof FALLBACKS_COMMAND_LOCALES

/** One locale's copy table (structural — zh and en share the same shape). */
type FallbacksCommandCopy = (typeof FALLBACKS_COMMAND_LOCALES)[FallbacksCommandLocale]

// ---------------------------------------------------------------------------
// Subcommand parsing
// ---------------------------------------------------------------------------

/** The `/fallbacks` subcommands: `'config'` (composed-config readback) or
 * `''` (the bare session snapshot). */
export type FallbacksSubcommand = '' | 'config'

/**
 * Map an invocation's rawInput to a subcommand: trimmed `'config'` →
 * `'config'`; everything else (incl. empty) → `''` (bare snapshot). Lenient
 * by design — unknown input keeps today's bare behavior, never errors.
 */
export function parseFallbacksSubcommand(rawInput: string): FallbacksSubcommand {
  return rawInput.trim() === 'config' ? 'config' : ''
}

// ---------------------------------------------------------------------------
// Snapshot building (pure helpers, tested directly)
// ---------------------------------------------------------------------------

/**
 * True when `data` is a well-formed `fallbacks/switch` payload (the durable
 * session log is append-only and survives plugin/host upgrades, so a
 * `fallbacks/switch` entry may carry a stale or corrupted shape — version
 * skew must not crash the diagnostic).
 */
function isFallbacksSwitchData(data: unknown): data is FallbacksSwitchEventData {
  if (typeof data !== 'object' || data === null) return false
  const payload = data as Record<string, unknown>
  if (typeof payload.turn !== 'number' || typeof payload.step !== 'number') return false
  if (typeof payload.role !== 'string' || typeof payload.reason !== 'string') return false
  const from = payload.from as Record<string, unknown> | undefined
  const to = payload.to as Record<string, unknown> | undefined
  return (
    typeof from?.provider === 'string' &&
    typeof from?.model === 'string' &&
    typeof to?.provider === 'string' &&
    typeof to?.model === 'string'
  )
}

/**
 * The newest `limit` `fallbacks/switch` events from a session's raw event
 * log, newest first. Unknown event shapes and malformed `fallbacks/switch`
 * payloads are skipped defensively (a session log may carry any
 * `SessionEventMap` type, and the durable log can outlive schema versions).
 */
export function recentFallbacksSwitches(events: readonly unknown[], limit: number): FallbacksSwitchEventData[] {
  const found: FallbacksSwitchEventData[] = []
  for (let index = events.length - 1; index >= 0 && found.length < limit; index -= 1) {
    const event = events[index] as { readonly type?: unknown; readonly data?: unknown } | undefined
    if (event?.type !== 'fallbacks/switch') continue
    if (!isFallbacksSwitchData(event.data)) continue
    found.push(event.data)
  }
  return found
}

/**
 * The chain entries `/fallbacks` shows for a role (spec §7.4): the declared
 * role's own chain when non-empty (`chainRole: true`); an empty own chain
 * defers to `rootChain` unless `fallback: 'none'` — then nothing is appended
 * and the display chain is empty, mirroring `resolveChainViews`'s
 * `[...[], ...[]]` exactly; undeclared ids and the built-in `'inherit'`
 * role resolve to `rootChain`. `inherit: true` marks the append-not-replace
 * tail — the role's `fallback` is `'inherit-root'` (the default) or the role
 * is unknown/built-in `'inherit'`, and `rootChain` is non-empty. Mirrors
 * `resolveChainViews`'s concatenation (see {@link buildRoleEntries} —
 * `src/chains.ts`; the diagnostic keeps its display semantics: the role's
 * own chain renders in full, `rootChain` only when the role has no own
 * chain, with the inherit tail as an annotation) without a failing model to
 * resolve against (the diagnostic is model-independent).
 *
 * `warn` mirrors {@link resolveChainViews}' defensive unknown-role warn
 * (qc2 F-002 — routed through the injected logger; the `/fallbacks` path
 * never reaches here unsanitized, as {@link resolveRole} resolves to a
 * declared id or `'inherit'` first, so this is direct-caller parity).
 */
export function resolveChainForDiagnostic(
  roles: readonly FallbacksRole[],
  rootChain: readonly string[],
  role: string,
  warn: (message: string) => void = console.warn,
): { readonly chainRole: boolean; readonly chain: readonly string[]; readonly inherit: boolean } {
  // Explicit INHERIT_ROLE_ID branch (qc2 F-006): the built-in 'inherit' id
  // resolves to rootChain silently — mirroring resolveChainViews — even if
  // an illegal config declared a role with the reserved id (startup
  // validation warns "reserved"; the runtime never consults it, so the
  // diagnostic must not display it either).
  if (role.trim() === INHERIT_ROLE_ID) {
    return { chainRole: false, chain: rootChain, inherit: rootChain.length > 0 }
  }
  const roleDef = roles.find((declared) => declared.id.trim() === role.trim())
  if (roleDef === undefined) {
    warn(`llm-fallbacks: unknown role "${role}" — falling back to rootChain`)
  }
  const roleChain = roleDef?.chain ?? []
  // Mirror resolveChainViews' concatenation exactly: a declared role's own
  // chain wins when non-empty; an empty own chain defers to rootChain
  // UNLESS fallback is 'none' (no tail appended → empty display chain);
  // the built-in 'inherit' role and any unknown id → rootChain.
  const chain = roleChain.length > 0 ? roleChain : roleDef?.fallback === 'none' ? [] : rootChain
  const inherit = rootChain.length > 0 && (roleDef === undefined || roleDef.fallback !== 'none')
  return { chainRole: roleChain.length > 0, chain, inherit }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render one switch entry as one text line. */
function formatSwitch(entry: FallbacksSwitchEventData, t: FallbacksCommandCopy): string {
  const from = `${entry.from.provider}/${entry.from.model}`
  const to = `${entry.to.provider}/${entry.to.model}`
  return t.switchLine
    .replace('{from}', from)
    .replace('{to}', to)
    .replace('{role}', entry.role)
    // Unknown future reasons render the raw reason string, never "undefined".
    .replace('{reason}', t.reason[entry.reason] ?? entry.reason)
}

/** Render one cooldown entry as one text line (`Infinity` = never reverts). */
function formatCooldown(entry: FallbacksCooldownEntry, t: FallbacksCommandCopy): string {
  if (!Number.isFinite(entry.untilEpochMs)) return t.cooldownNever.replace('{key}', entry.key)
  return t.cooldownLine
    .replace('{key}', entry.key)
    .replace('{time}', new Date(entry.untilEpochMs).toISOString())
}

/**
 * Cap for long list lines in the composed-config readback: beyond this many
 * items a line truncates with `…` (the `Roles:` count always stays the FULL
 * count). Same sanity scale as {@link RECENT_SWITCHES_LIMIT}.
 */
export const FALLBACKS_CONFIG_LIST_CAP = 5

/** Join a list line, truncating past {@link FALLBACKS_CONFIG_LIST_CAP} with `…`. */
function formatConfigList(items: readonly string[]): string {
  if (items.length <= FALLBACKS_CONFIG_LIST_CAP) return items.join(', ')
  return [...items.slice(0, FALLBACKS_CONFIG_LIST_CAP), '…'].join(', ')
}

/** Render the `Roles:` line: full count, then `id (chain: n)` items (truncated). */
function formatConfigRoles(roles: readonly { id: string; chainCount: number }[], t: FallbacksCommandCopy): string {
  // S-1 (qc3): bound the interpolation allocation before truncation — only
  // the first FALLBACKS_CONFIG_LIST_CAP roles can ever render, so slice
  // before map (never O(N) intermediate strings on the command path). The
  // `Roles:` count below still reports the FULL array length.
  const items = roles.slice(0, FALLBACKS_CONFIG_LIST_CAP)
    .map((role) => t.configRoleItem.replace('{id}', role.id).replace('{n}', String(role.chainCount)))
  const list = items.length === 0 ? '' : `${items.join(', ')}${roles.length > FALLBACKS_CONFIG_LIST_CAP ? ', …' : ''}`
  return `${roles.length}${list.length === 0 ? '' : ` — ${list}`}`
}

/**
 * Render the `/fallbacks config` surface (plan fallbacks-tui-client T2,
 * AC-2): the composed `fallbacks` namespace as the runtime reads it + file-only
 * edit hints (TUI has no write surface). The FIRST LINE marks the
 * composed-config readback — distinct from the diagnostic title and never
 * merged into {@link fallbacksCommandText} (two operator surfaces, product
 * lock). Locale defaults to `zh` (the command default); en dictionary tested.
 */
export function fallbacksConfigText(
  summary: FallbacksConfigSummary,
  locale: FallbacksCommandLocale = 'zh',
): string {
  const t = FALLBACKS_COMMAND_LOCALES[locale]
  const lines: string[] = [
    `${t.configTitle}: ${summary.enabled ? t.configEnabled : t.configDisabled}`,
    `${t.configTriggerCodes}: ${summary.triggerCodes.length === 0 ? t.configEmpty : formatConfigList(summary.triggerCodes)}`,
    `${t.configRootChain}: ${summary.rootChain.length === 0 ? t.configEmpty : formatConfigList(summary.rootChain)}`,
    `${t.configRoles}: ${formatConfigRoles(summary.roles, t)}`,
    `${t.configCooldown}: ${summary.cooldownMs} ms`,
    `${t.configRevert}: ${summary.revertPolicy}`,
    `${t.configMaxSwitches}: ${summary.maxSwitchesPerStep}`,
    `${t.configAlwaysCap}: ${summary.alwaysModeRetryCap}`,
    `${t.configPresets}: ${summary.presets}`,
    '',
    t.configEdit,
    t.configEditHint,
  ]
  return lines.join('\n')
}

/**
 * Render the `/fallbacks` status surface for one snapshot. Kept minimal and
 * truthful: origin → role → chain (+ inherit tail) → recent switches →
 * cooldown.
 */
export function fallbacksCommandText(
  snapshot: FallbacksCommandSnapshot,
  locale: FallbacksCommandLocale = 'zh',
): string {
  const t = FALLBACKS_COMMAND_LOCALES[locale]
  const lines: string[] = [t.title]
  lines.push(`${t.origin}: ${snapshot.origin}`)
  lines.push(`${t.role}: ${snapshot.role}`)
  if (snapshot.chain.length === 0) {
    lines.push(`${t.chain}: ${t.chainNone}`)
  } else {
    const suffix = snapshot.inherit ? t.inheritRoot : ''
    lines.push(`${t.chain}: ${snapshot.chain.join(' → ')}${suffix}`)
  }
  if (snapshot.switches.length === 0) {
    lines.push(`${t.switches}: ${t.switchesNone}`)
  } else {
    lines.push(`${t.switches} (${snapshot.switches.length}):`)
    for (const entry of snapshot.switches) {
      lines.push(`  · ${formatSwitch(entry, t)}`)
    }
  }
  if (snapshot.cooldown.length === 0) {
    lines.push(`${t.cooldown}: ${t.cooldownNone}`)
  } else {
    lines.push(`${t.cooldown} (${snapshot.cooldown.length}):`)
    for (const entry of snapshot.cooldown) {
      lines.push(`  · ${formatCooldown(entry, t)}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Handler + registration
// ---------------------------------------------------------------------------

/** Build the `/fallbacks` handler bound to one controller. */
function createFallbacksCommandHandler(
  controller: FallbacksCommandController,
  locale: FallbacksCommandLocale = 'zh',
) {
  return (invocation: CommandInvocation): CommandResult => ({
    kind: 'success',
    text:
      // The contract says rawInput is a string; a contract-violating host
      // passing undefined must still fall back to the bare snapshot (qc2
      // N-3 — keep the lenient-fallback promise absolute).
      parseFallbacksSubcommand(invocation.rawInput ?? '') === 'config'
        ? fallbacksConfigText(controller.getConfig(), locale)
        : fallbacksCommandText(controller.getSnapshot(invocation.agent), locale),
  })
}

/**
 * Register the `/fallbacks` command with a command registry (the dsh
 * `CommandService`, or a fake in tests). Called from the plugin's conditional
 * `ctx.inject(['commands'], ...)` child — the command exists only when a
 * registry is composed.
 * @returns the registry disposer (the inject child owns its lifetime).
 */
export function registerFallbacksCommands(
  registry: FallbacksCommandRegistry,
  controller: FallbacksCommandController,
  locale: FallbacksCommandLocale = 'zh',
): () => void {
  return registry.register({
    name: 'fallbacks',
    description: FALLBACKS_COMMAND_LOCALES[locale].description,
    // No `input` descriptor: `/fallbacks` takes no free-form input (only the
    // `config` subcommand, parsed from rawInput by the handler). Real
    // dsh-commands normalizeDefinition rejects an empty hint, so omitting
    // the optional `input` is both the correct representation and the only
    // shape that registers.
    handler: createFallbacksCommandHandler(controller, locale),
  })
}
