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
 * The bare diagnostic and the config readback are **read-only**: they never
 * mutate fallback state (no cooldown reset, no pending-switch writes). The
 * `config revert-seed <role-id>` subcommand is the one write action (plan
 * fallbacks-tui-settings Task 2, AC-3): it delegates to the controller's
 * `revertSeed` (wired to the seeds service) and prints the outcome — a
 * web-card action capability the settings seam cannot express. zh/en copy
 * lives in this file — the client half's `src/client/locales.ts` is a
 * separate client-side dictionary. The host carries no per-session locale
 * signal (the `locale` service is client-side), so the wiring picks a
 * deterministic default (`zh`, this repo's primary language); both
 * dictionaries are unit-tested.
 *
 * @module dsh-llm-fallbacks/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { INHERIT_ROLE_ID, type FallbacksRole } from './config.ts'
import type { Origin } from './roles.ts'
import type { FallbackSwitchReason, FallbacksSwitchEventData } from './events.ts'
import type { SeedRevertFailReason } from './seeds.ts'
import { PRESETS, type PresetId, type SlotRowConfig } from './time-slots.ts'

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
  /** Current time-slot winner + display label (P5/P7): the 分时切换 side of
   * the status strip. The switches section below is the 降级切换 side —
   * the copy never mixes. */
  readonly slot: { readonly winner: SlotRowConfig | 'all-day'; readonly label: string }
  /** Recent `fallbacks/switch` events (failure walks — 降级切换), newest
   * first, capped at {@link RECENT_SWITCHES_LIMIT}. */
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
 *
 * Enriched readback (plan fallbacks-tui-settings Task 2, AC-4): timeSlots /
 * tz / roles.rules join the summary so TUI operators can verify `/settings`
 * edits. One summarized time-slot row: preset rows carry `{ preset,
 * chainCount }` (windows are frozen code constants in {@link PRESETS} and
 * never stored on the row — the render resolves the window text from
 * PRESETS); custom rows carry `{ start, end, chainCount }`. Rules rows carry
 * `{ provider, model, role }` — an omitted provider/model (wildcard match at
 * runtime) is summarized as `''` and rendered as `*`.
 */
export interface FallbacksConfigSummary {
  readonly enabled: boolean
  readonly triggerCodes: readonly string[]
  readonly rootChain: readonly string[]
  /** Summarized time-slot rows (preset rows carry `preset`, custom rows carry `start`/`end`; both may carry a day mask). */
  readonly timeSlots: readonly { preset?: string; start?: string; end?: string; days?: readonly number[]; chainCount: number }[]
  /** Config-level timezone for slot matching (default `Asia/Shanghai`). */
  readonly tz: string
  readonly roles: readonly { id: string; chainCount: number }[]
  /** Summarized role rules: provider/model patterns → declared role (or the built-in `'inherit'`). */
  readonly rules: readonly { provider: string; model: string; role: string }[]
  readonly cooldownMs: number
  readonly revertPolicy: string
  readonly maxSwitchesPerStep: number
  readonly alwaysModeRetryCap: number
  readonly presets: 'bundled' | 'none'
  /** Dispatch-time LLM role auto-match switch (default true). */
  readonly roleAutoMatch: boolean
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
  /**
   * Revert one role's persona to its CURRENT declared seed default (AC-3).
   * Surfaces the outcome as VALUES, not copy (qc1 F-003 / qc2 F-006 / qc3
   * F-003): `ok: true` when reverted; `ok: false` with the
   * {@link SeedRevertFailReason} code explaining why not (not a seeded role
   * / role row absent). The command handler localizes the code per its
   * registration locale — the controller never pre-localizes. A
   * settings-write failure propagates loudly as a rejected promise (the
   * same contract as the seeds service — never swallowed into an
   * `ok: false`); the handler maps it to a structured error. Implemented by
   * the wiring against the per-apply seed manager
   * (`seeds.revert(roleId, seedsIo)`), not the typert gateway.
   */
  revertSeed(roleId: string): Promise<{ ok: boolean; reason?: SeedRevertFailReason }>
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

/**
 * The `revert-seed` subcommand's localized one-line description — single
 * copy source: consumed by the `usageRevertSeed` copy key (TUI completion
 * node) and the `usage` USAGE line (plan fallbacks-tui-settings Task 2 —
 * same pattern as {@link CONFIG_SUBCOMMAND_DESCRIPTION}).
 */
const REVERT_SEED_SUBCOMMAND_DESCRIPTION = {
  zh: '将角色的 persona 还原为已声明的 Seed 默认',
  en: "revert a role's persona to its declared seed default",
} as const

/** zh/en dictionaries for the `/fallbacks` output. */
export const FALLBACKS_COMMAND_LOCALES = {
  zh: {
    title: '当前会话 fallback 诊断（只读）',
    description: '查看当前会话的降级链、最近降级切换与冷却状态（只读）',
    usageConfig: CONFIG_SUBCOMMAND_DESCRIPTION.zh,
    usageRevertSeed: REVERT_SEED_SUBCOMMAND_DESCRIPTION.zh,
    usage: `  /fallbacks config   ${CONFIG_SUBCOMMAND_DESCRIPTION.zh}\n  /fallbacks config revert-seed <role-id>   ${REVERT_SEED_SUBCOMMAND_DESCRIPTION.zh}`,
    origin: '会话来源',
    role: '角色',
    chain: '链',
    inheritRoot: '（inherit-root）',
    chainNone: '未配置',
    // Copy split (spec § Copy): the slot line is the 分时切换 side; the
    // switches section lists failure walks only — 降级切换. Never mix.
    slot: '分时',
    switches: '最近降级切换',
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
    configTimeSlots: '分时槽',
    configSlotPresetItem: '{preset}（chain: {n}, window {window}）',
    configSlotPresetBare: '{preset}（chain: {n}）',
    configSlotCustomItem: 'custom {start}-{end}（chain: {n}）',
    configTz: '时区',
    configRoles: '角色',
    configRoleItem: '{id}（chain: {n}）',
    configRules: '角色规则',
    configCooldown: '冷却',
    configRevert: '回主策略',
    configMaxSwitches: '单步最大切换',
    configAlwaysCap: 'always 上限',
    configPresets: '预置',
    configRoleAutoMatch: '角色自动匹配',
    configEdit: '编辑：/settings（TUI 设置界面）或 ~/.dsh/profiles/<profile>/cordis.patch.yml（插件行）/ $DSH_HOME/settings.yaml（fallbacks: 分节）',
    configEditHint: 'TUI 通过 /settings 修改配置；文件编辑仍然可用',
    revertSeedOk: '角色 {id} 已还原为 Seed 默认',
    revertSeedFail: '角色 {id} 未还原（{reason}）',
    // C-6: the settings-write failure path — the seeds service propagates a
    // failed write by throwing, and the handler maps the rejection to this
    // localized message (never raw technical text).
    revertSeedError: '角色 {id} 还原失败（设置写入失败）',
    revertSeedReason: {
      'not-seeded': '未声明种子',
      'row-absent': '角色行不存在',
      // Reserved (qc3 F-001): a future seeds outcome for the no-settings-
      // channel case — seeds.revert THROWS today instead of returning this
      // reason, so this key is unreachable copy until that changes.
      'settings-unavailable': '设置通道不可用',
    },
  },
  en: {
    title: 'Session fallback diagnostics (read-only)',
    description: 'Inspect fallback chain, recent fallback switches, and cooldown for this session (read-only)',
    usageConfig: CONFIG_SUBCOMMAND_DESCRIPTION.en,
    usageRevertSeed: REVERT_SEED_SUBCOMMAND_DESCRIPTION.en,
    usage: `  /fallbacks config   ${CONFIG_SUBCOMMAND_DESCRIPTION.en}\n  /fallbacks config revert-seed <role-id>   ${REVERT_SEED_SUBCOMMAND_DESCRIPTION.en}`,
    origin: 'Session origin',
    role: 'Role',
    chain: 'Chain',
    inheritRoot: ' (inherit-root)',
    chainNone: 'not configured',
    // Copy split (spec § Copy): the slot line is the time-slot side; the
    // switches section lists failure walks only — fallback switches.
    slot: 'Time slot',
    switches: 'Recent fallback switches',
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
    configTimeSlots: 'Time slots',
    configSlotPresetItem: '{preset} (chain: {n}, window {window})',
    configSlotPresetBare: '{preset} (chain: {n})',
    configSlotCustomItem: 'custom {start}-{end} (chain: {n})',
    configTz: 'TZ',
    configRoles: 'Roles',
    configRoleItem: '{id} (chain: {n})',
    configRules: 'Rules',
    configCooldown: 'Cooldown',
    configRevert: 'Revert',
    configMaxSwitches: 'Max switches/step',
    configAlwaysCap: 'Always-mode cap',
    configPresets: 'Presets',
    configRoleAutoMatch: 'Auto-match',
    configEdit: 'Edit: /settings (TUI settings screen) or ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) / $DSH_HOME/settings.yaml (fallbacks: section)',
    configEditHint: 'TUI edits config via /settings; file editing still works',
    revertSeedOk: 'role {id} reverted to its seed default',
    revertSeedFail: 'role {id} not reverted ({reason})',
    // C-6: mapped settings-write failure message (mirror of the zh key).
    revertSeedError: 'role {id} revert failed (settings write failed)',
    revertSeedReason: {
      'not-seeded': 'not a seeded role',
      'row-absent': 'role row absent',
      // Reserved (qc3 F-001): unreachable today — see the zh block comment.
      'settings-unavailable': 'settings channel unavailable',
    },
  },
} as const

/** A locale id supported by {@link FALLBACKS_COMMAND_LOCALES}. */
export type FallbacksCommandLocale = keyof typeof FALLBACKS_COMMAND_LOCALES

/** One locale's copy table (structural — zh and en share the same shape). */
type FallbacksCommandCopy = (typeof FALLBACKS_COMMAND_LOCALES)[FallbacksCommandLocale]

// ---------------------------------------------------------------------------
// Subcommand parsing
// ---------------------------------------------------------------------------

/** The `/fallbacks` subcommands: `'config'` (composed-config readback),
 * `'revert-seed'` (persona revert action, requires a role id), or `''` (the
 * bare session snapshot). */
export type FallbacksSubcommand = '' | 'config' | 'revert-seed'

/** One parsed subcommand invocation: the kind plus the optional role id
 * carried by `revert-seed`. */
export interface FallbacksSubcommandParse {
  readonly kind: FallbacksSubcommand
  /** The role id argument of `revert-seed` (present iff `kind === 'revert-seed'`). */
  readonly arg?: string
}

/**
 * Map an invocation's rawInput to a subcommand: trimmed `'config'` →
 * `{ kind: 'config' }`; `'config revert-seed <id>'` → `{ kind: 'revert-seed',
 * arg: id }`; everything else (incl. empty, a missing id, or an unknown
 * subcommand under `config`) → `{ kind: '' }` (bare snapshot). Lenient by
 * design — unknown input keeps today's bare behavior, never errors.
 */
export function parseFallbacksSubcommand(rawInput: string): FallbacksSubcommandParse {
  const trimmed = rawInput.trim()
  if (trimmed === 'config') return { kind: 'config' }
  const [head, sub, ...rest] = trimmed.split(/\s+/)
  if (head === 'config' && sub === 'revert-seed') {
    const arg = rest.join(' ').trim()
    if (arg === '') return { kind: '' }
    return { kind: 'revert-seed', arg }
  }
  return { kind: '' }
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
    // Unknown future reasons render the raw reason string, never "undefined"
    // (a `role-inject` display key is deferred to Plan B client locales — the
    // records above intentionally hold only the failure-time reasons).
    .replace('{reason}', (t.reason as Partial<Record<FallbackSwitchReason, string>>)[entry.reason] ?? entry.reason)
}

/** Render one cooldown entry as one text line (`Infinity` = never reverts). */
function formatCooldown(entry: FallbacksCooldownEntry, t: FallbacksCommandCopy): string {
  if (!Number.isFinite(entry.untilEpochMs)) return t.cooldownNever.replace('{key}', entry.key)
  return t.cooldownLine
    .replace('{key}', entry.key)
    .replace('{time}', new Date(entry.untilEpochMs).toISOString())
}

/**
 * Cap for the composed-config readback's LIST lines — Trigger codes, Root
 * chain, Time slots, Roles, and Rules (qc2 Task-2 Minor): beyond this many
 * items a line truncates with `…` while its leading count always stays the
 * FULL count. Same sanity scale as {@link RECENT_SWITCHES_LIMIT}.
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

/** Weekday names indexed 0=Sunday…6=Saturday (matches the slot day masks). */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * Compact day-mask text for a slot window (qc1 F-004): contiguous runs
 * collapse to a range (`[1,2,3,4,5]` → `Mon-Fri`), gaps stay comma-joined
 * (`[0,6]` → `Sun, Sat`). Empty/absent masks render `''` (every day).
 */
function formatDayMask(days: readonly number[]): string {
  if (days.length === 0) return ''
  const sorted = [...days].sort((a, b) => a - b)
  const runs: string[] = []
  let runStart = sorted[0]!
  let prev = sorted[0]!
  for (let index = 1; index <= sorted.length; index += 1) {
    const day = sorted[index]
    if (day === undefined || day !== prev + 1) {
      runs.push(prev === runStart ? DAY_NAMES[runStart]! : `${DAY_NAMES[runStart]}-${DAY_NAMES[prev]}`)
      runStart = day
      prev = day
    } else {
      prev = day
    }
  }
  return runs.join(', ')
}

/**
 * Resolve a preset row's frozen window text from {@link PRESETS} — preset
 * rows store NO start/end (windows are code constants, `time-slots.ts`), so
 * the readback resolves them here. Windows carrying a day mask append it
 * (`14:00-18:00 (Mon-Fri)`), so the GLM presets' weekday-only windows are
 * visible. Complement (valley) presets match the OUTSIDE of their peak
 * windows — annotated as `outside <windows>` where the appended day mask
 * qualifies exactly which window is excluded (the glm-valley exclusion is
 * the Mon–Fri window only, never the whole daily range). Unknown preset ids
 * (legacy rows the resolver warns about and skips) render without a window
 * segment.
 */
function formatSlotWindow(preset: string): string {
  const definition = PRESETS[preset as PresetId]
  if (definition === undefined) return ''
  const windows = definition.windows
    .map((window) => {
      const dayMask = window.days !== undefined && window.days.length > 0 ? ` (${formatDayMask(window.days)})` : ''
      return `${window.start}-${window.end}${dayMask}`
    })
    .join(', ')
  return definition.complement ? `outside ${windows}` : windows
}

/**
 * Render the `Time slots:` line: full count, then one row per slot —
 * preset rows as `{preset} (chain: n, window <resolved from PRESETS>)`,
 * custom rows as `custom {start}-{end} (chain: n)` — with a compact day
 * mask appended when the row carries one (qc1 F-004). Truncated at the cap
 * like the other list lines.
 */
function formatConfigTimeSlots(
  slots: readonly { preset?: string; start?: string; end?: string; days?: readonly number[]; chainCount: number }[],
  t: FallbacksCommandCopy,
): string {
  const items = slots.slice(0, FALLBACKS_CONFIG_LIST_CAP).map((row) => {
    if (row.preset !== undefined) {
      const window = formatSlotWindow(row.preset)
      // Unknown preset ids (legacy rows the resolver warns about and skips)
      // render without a window segment — never a placeholder or undefined.
      return window === ''
        ? t.configSlotPresetBare.replace('{preset}', row.preset).replace('{n}', String(row.chainCount))
        : t.configSlotPresetItem
            .replace('{preset}', row.preset)
            .replace('{n}', String(row.chainCount))
            .replace('{window}', window)
    }
    // A malformed custom row (missing bounds — legacy source the resolver
    // skips) degrades to a bare custom marker instead of `undefined-undefined`.
    const bounds = row.start !== undefined && row.end !== undefined
      ? `${row.start}-${row.end}${row.days !== undefined && row.days.length > 0 ? ` (${formatDayMask(row.days)})` : ''}`
      : ''
    return t.configSlotCustomItem.replace('{start}-{end}', bounds).replace('{n}', String(row.chainCount))
  })
  const list = items.length === 0 ? '' : `${items.join(', ')}${slots.length > FALLBACKS_CONFIG_LIST_CAP ? ', …' : ''}`
  return `${slots.length}${list.length === 0 ? '' : ` — ${list}`}`
}

/**
 * Render the `Rules:` line: full count, then `provider/model → role` rows
 * (truncated at the cap). An omitted provider/model (wildcard match at
 * runtime) is rendered as `*`.
 */
function formatConfigRules(
  rules: readonly { provider: string; model: string; role: string }[],
  t: FallbacksCommandCopy,
): string {
  const items = rules.slice(0, FALLBACKS_CONFIG_LIST_CAP)
    .map((rule) => `${rule.provider === '' ? '*' : rule.provider}/${rule.model === '' ? '*' : rule.model} → ${rule.role}`)
  const list = items.length === 0 ? '' : `${items.join(', ')}${rules.length > FALLBACKS_CONFIG_LIST_CAP ? ', …' : ''}`
  return `${rules.length}${list.length === 0 ? '' : ` — ${list}`}`
}

/**
 * Render the `/fallbacks config` surface (plan fallbacks-tui-client T2,
 * AC-2 + fallbacks-tui-settings Task 2 AC-4): the composed `fallbacks`
 * namespace as the runtime reads it — enriched with the time-slot rows
 * (preset rows resolve their frozen window from {@link PRESETS}), the
 * config timezone, and the role rules — plus edit hints pointing at the
 * `/settings` TUI edit surface while keeping the file-edit documentation.
 * The FIRST LINE marks the composed-config readback — distinct from the
 * diagnostic title and never merged into {@link fallbacksCommandText} (two
 * operator surfaces, product lock). Locale defaults to `zh` (the command
 * default); en dictionary tested.
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
    `${t.configTimeSlots}: ${summary.timeSlots.length === 0 ? t.configEmpty : formatConfigTimeSlots(summary.timeSlots, t)}`,
    `${t.configTz}: ${summary.tz}`,
    `${t.configRoles}: ${formatConfigRoles(summary.roles, t)}`,
    `${t.configRules}: ${summary.rules.length === 0 ? t.configEmpty : formatConfigRules(summary.rules, t)}`,
    `${t.configCooldown}: ${summary.cooldownMs} ms`,
    `${t.configRevert}: ${summary.revertPolicy}`,
    `${t.configMaxSwitches}: ${summary.maxSwitchesPerStep}`,
    `${t.configAlwaysCap}: ${summary.alwaysModeRetryCap}`,
    `${t.configPresets}: ${summary.presets}`,
    `${t.configRoleAutoMatch}: ${summary.roleAutoMatch ? t.configEnabled : t.configDisabled}`,
    '',
    t.configEdit,
    t.configEditHint,
  ]
  return lines.join('\n')
}

/**
 * Render the `/fallbacks` status surface for one snapshot. Kept minimal and
 * truthful: origin → role → chain (+ inherit tail) → current slot (分时) →
 * recent switches (降级切换) → cooldown.
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
  lines.push(`${t.slot}: ${snapshot.slot.label}`)
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
  return (invocation: CommandInvocation): CommandResult | Promise<CommandResult> => {
    // The contract says rawInput is a string; a contract-violating host
    // passing undefined must still fall back to the bare snapshot (qc2
    // N-3 — keep the lenient-fallback promise absolute).
    const parsed = parseFallbacksSubcommand(invocation.rawInput ?? '')
    if (parsed.kind === 'config') {
      return { kind: 'success', text: fallbacksConfigText(controller.getConfig(), locale) }
    }
    if (parsed.kind === 'revert-seed' && parsed.arg !== undefined) {
      // The one write action (AC-3): delegate to the controller (wired to
      // the seeds service) and surface the outcome — success for a reverted
      // role, error-kind for a not-found role (the message explains why).
      // The controller returns reason CODES (qc1 F-003 / qc2 F-006 / qc3
      // F-003); this handler localizes them against the registration
      // locale, so an en-registered command never renders zh revert copy.
      const roleId = parsed.arg
      const t = FALLBACKS_COMMAND_LOCALES[locale]
      return controller.revertSeed(roleId)
        .then(
          (outcome): CommandResult =>
            outcome.ok
              ? { kind: 'success', text: t.revertSeedOk.replace('{id}', roleId) }
              : {
                  kind: 'error',
                  text: t.revertSeedFail
                    .replace('{id}', roleId)
                    .replace('{reason}', t.revertSeedReason[outcome.reason ?? 'not-seeded']),
                },
        )
        // C-6 (qc2 F-007): a settings-write failure rejects the promise —
        // map it to a structured error-kind outcome with the localized
        // message instead of relying on the host's rejection settlement.
        .catch((): CommandResult => ({ kind: 'error', text: t.revertSeedError.replace('{id}', roleId) }))
    }
    return { kind: 'success', text: fallbacksCommandText(controller.getSnapshot(invocation.agent), locale) }
  }
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
    // `config` and `config revert-seed <role-id>` subcommands, parsed from
    // rawInput by the handler). Real dsh-commands normalizeDefinition
    // rejects an empty hint, so omitting the optional `input` is both the
    // correct representation and the only shape that registers.
    handler: createFallbacksCommandHandler(controller, locale),
  })
}
