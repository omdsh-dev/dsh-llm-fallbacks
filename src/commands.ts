/**
 * `/fallbacks` slash command (plan fallbacks-mount-map-command Task 2, AC-5).
 *
 * Session-scoped, read-only diagnostic: current session origin → resolved
 * role → resolved chain (role key, else `default`) → recent `fallbacks/switch`
 * events (newest first, capped) → cooldown status. Mirrors dsh-advisor's
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
  /** Resolved role (first matching `roles.rules` entry → `roles.default`). */
  readonly role: string
  /** True when the role's own chain key exists; false when `default` (or none) is shown. */
  readonly chainRole: boolean
  /** The displayed chain entries (role chain, else `default` chain); empty = not configured. */
  readonly chain: readonly string[]
  /** Recent `fallbacks/switch` events, newest first, capped at {@link RECENT_SWITCHES_LIMIT}. */
  readonly switches: readonly FallbacksSwitchEventData[]
  /** Active cooldown entries for the agent. */
  readonly cooldown: readonly FallbacksCooldownEntry[]
}

/**
 * The session-scoped read-only operations the `/fallbacks` handler drives.
 * Implemented by the wiring (`src/index.ts`) against the live config source,
 * the chain map, and the per-agent state store; faked in unit tests.
 */
export interface FallbacksCommandController {
  /** Snapshot the session's fallback diagnostics. Never mutates state. */
  getSnapshot(agent: FallbacksCommandAgent): FallbacksCommandSnapshot
}

// ---------------------------------------------------------------------------
// zh/en copy (zh source, en mirror — repo locale convention)
// ---------------------------------------------------------------------------

/** zh/en dictionaries for the `/fallbacks` output. */
export const FALLBACKS_COMMAND_LOCALES = {
  zh: {
    title: '当前会话 fallback 诊断（只读）',
    origin: '会话来源',
    role: '角色',
    chain: '链',
    chainDefault: '（default 兜底）',
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
  },
  en: {
    title: 'Session fallback diagnostics (read-only)',
    origin: 'Session origin',
    role: 'Role',
    chain: 'Chain',
    chainDefault: ' (default fallback)',
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
  },
} as const

/** A locale id supported by {@link FALLBACKS_COMMAND_LOCALES}. */
export type FallbacksCommandLocale = keyof typeof FALLBACKS_COMMAND_LOCALES

/** One locale's copy table (structural — zh and en share the same shape). */
type FallbacksCommandCopy = (typeof FALLBACKS_COMMAND_LOCALES)[FallbacksCommandLocale]

// ---------------------------------------------------------------------------
// Snapshot building (pure helpers, tested directly)
// ---------------------------------------------------------------------------

/**
 * The newest `limit` `fallbacks/switch` events from a session's raw event
 * log, newest first. Unknown event shapes are skipped defensively (a session
 * log may carry any `SessionEventMap` type).
 */
export function recentFallbacksSwitches(events: readonly unknown[], limit: number): FallbacksSwitchEventData[] {
  const found: FallbacksSwitchEventData[] = []
  for (let index = events.length - 1; index >= 0 && found.length < limit; index -= 1) {
    const event = events[index] as { readonly type?: unknown; readonly data?: unknown } | undefined
    if (event === undefined || event.type !== 'fallbacks/switch') continue
    found.push(event.data as FallbacksSwitchEventData)
  }
  return found
}

/**
 * The chain entries `/fallbacks` shows for a role: the role's own chain key
 * when present, else the `default` chain (mirrors `resolveChain`'s
 * role → default fallback without the model-dependent exact/provider keys —
 * the diagnostic has no failing model to resolve against).
 */
export function resolveChainForDiagnostic(
  chains: Record<string, readonly string[]>,
  role: string,
): { readonly chainRole: boolean; readonly chain: readonly string[] } {
  const roleChain = chains[role]
  if (roleChain !== undefined) return { chainRole: true, chain: roleChain }
  return { chainRole: false, chain: chains['default'] ?? [] }
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
    .replace('{reason}', t.reason[entry.reason])
}

/** Render one cooldown entry as one text line (`Infinity` = never reverts). */
function formatCooldown(entry: FallbacksCooldownEntry, t: FallbacksCommandCopy): string {
  if (!Number.isFinite(entry.untilEpochMs)) return t.cooldownNever.replace('{key}', entry.key)
  return t.cooldownLine
    .replace('{key}', entry.key)
    .replace('{time}', new Date(entry.untilEpochMs).toISOString())
}

/**
 * Render the `/fallbacks` status surface for one snapshot. Kept minimal and
 * truthful: origin → role → chain → recent switches → cooldown.
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
    const suffix = snapshot.chainRole ? '' : t.chainDefault
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
    text: fallbacksCommandText(controller.getSnapshot(invocation.agent), locale),
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
    description: 'Inspect fallback chain, recent switches, and cooldown for this session（查看当前会话的降级链、最近切换与冷却状态）',
    input: { hint: '' },
    handler: createFallbacksCommandHandler(controller, locale),
  })
}
