/**
 * `/fallbacks` slash command tests (plan fallbacks-mount-map-command Task 2,
 * AC-5 / AC-7): registration shape, snapshot building (role/chain
 * resolution incl. the inherit-root tail, recent switches, cooldown),
 * zh/en rendering smoke, the factory-bound handler, and the wiring's
 * conditional `commands` child against real runtime state (no top-level
 * inject pollution).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { apply } from '../src/index.ts'
import { cfg, dispatchRequestError, makeAgent } from './support/harness.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  FALLBACKS_COMMAND_LOCALES,
  fallbacksCommandText,
  fallbacksConfigText,
  parseFallbacksSubcommand,
  RECENT_SWITCHES_LIMIT,
  recentFallbacksSwitches,
  registerFallbacksCommands,
  resolveChainForDiagnostic,
  type FallbacksCommandController,
  type FallbacksCommandRegistry,
  type FallbacksCommandSnapshot,
  type FallbacksConfigSummary,
} from '../src/commands.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'

/** A fully-populated snapshot; `overrides` trim it to the state under test. */
function snapshot(overrides: Partial<FallbacksCommandSnapshot> = {}): FallbacksCommandSnapshot {
  return {
    origin: 'root',
    role: 'inherit',
    chainRole: true,
    chain: ['anthropic/claude-3-5-sonnet', 'openai/*'],
    inherit: false,
    slot: { winner: 'all-day', label: 'all-day' },
    switches: [
      {
        turn: 1,
        step: 1,
        from: { provider: 'deepseek', model: 'deepseek-chat' },
        to: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
        role: 'inherit',
        reason: 'trigger-code',
      },
    ],
    cooldown: [{ key: 'deepseek/deepseek-chat', untilEpochMs: 2000 }],
    ...overrides,
  }
}

/** A fully-populated composed-config summary; `overrides` trim it to the state under test. */
function configSummary(overrides: Partial<FallbacksConfigSummary> = {}): FallbacksConfigSummary {
  return {
    enabled: true,
    triggerCodes: ['AUTH', 'QUOTA', 'RATE_LIMIT'],
    rootChain: ['anthropic/claude-3-5-sonnet', 'openai/*'],
    roles: [
      { id: 'coder', chainCount: 2 },
      { id: 'reviewer', chainCount: 1 },
    ],
    cooldownMs: 300_000,
    revertPolicy: 'cooldown-expiry',
    maxSwitchesPerStep: 8,
    alwaysModeRetryCap: 5,
    presets: 'bundled',
    roleAutoMatch: true,
    ...overrides,
  }
}

/** Register through a capturing fake registry and return the captured definition. */
function captureRegistration(
  controller: FallbacksCommandController,
  locale?: 'zh' | 'en',
): { definition: CommandDefinition; disposer: () => void; result: () => void } {
  let definition: CommandDefinition | undefined
  const disposer = vi.fn(() => {})
  const registry: FallbacksCommandRegistry = {
    register: (def) => {
      definition = def
      return disposer
    },
  }
  const result = locale === undefined
    ? registerFallbacksCommands(registry, controller)
    : registerFallbacksCommands(registry, controller, locale)
  if (definition === undefined) throw new Error('registry.register was not called')
  return { definition, disposer, result }
}

describe('registerFallbacksCommands — registration shape', () => {
  it('registers the /fallbacks definition with name, description, no free-form input, and a handler', () => {
    const { definition } = captureRegistration({ getSnapshot: () => snapshot(), getConfig: () => configSummary() })
    expect(definition.name).toBe('fallbacks')
    expect(definition.description.length).toBeGreaterThan(0)
    // No input descriptor: /fallbacks takes no free-form input, and real
    // dsh-commands normalizeDefinition rejects an empty hint (TypeError) —
    // omitting the optional `input` is the only shape that registers.
    expect(definition.input).toBeUndefined()
    expect(typeof definition.handler).toBe('function')
  })

  it('returns the registry disposer', () => {
    const { result, disposer } = captureRegistration({ getSnapshot: () => snapshot(), getConfig: () => configSummary() })
    // registerFallbacksCommands must hand back the registry's own disposer
    // (the inject child owns its lifetime).
    expect(result).toBe(disposer)
    expect(disposer).toHaveBeenCalledTimes(0)
  })

  it('localizes the description to the registration locale', () => {
    const zh = captureRegistration({ getSnapshot: () => snapshot(), getConfig: () => configSummary() })
    expect(zh.definition.description).toBe('查看当前会话的降级链、最近降级切换与冷却状态（只读）')
    const en = captureRegistration({ getSnapshot: () => snapshot(), getConfig: () => configSummary() }, 'en')
    expect(en.definition.description).toBe(
      'Inspect fallback chain, recent fallback switches, and cooldown for this session (read-only)',
    )
  })
})

describe('snapshot building helpers', () => {
  it('resolveChainForDiagnostic prefers the declared role chain and marks the inherit-root tail', () => {
    const roles = [{ id: 'reviewer', persona: '', chain: ['openai/gpt-4o-mini'] }]
    // Own chain shown; a non-empty rootChain is appended as the inherit tail.
    expect(resolveChainForDiagnostic(roles, ['other/gpt-4o'], 'reviewer')).toEqual({
      chainRole: true,
      chain: ['openai/gpt-4o-mini'],
      inherit: true,
    })
    // No rootChain → no inherit tail to annotate.
    expect(resolveChainForDiagnostic(roles, [], 'reviewer')).toEqual({
      chainRole: true,
      chain: ['openai/gpt-4o-mini'],
      inherit: false,
    })
  })

  it('resolveChainForDiagnostic defers an empty own chain and unknown roles to rootChain', () => {
    const roles = [{ id: 'reviewer', persona: '', chain: [] }]
    const rootChain = ['other/gpt-4o']
    expect(resolveChainForDiagnostic(roles, rootChain, 'reviewer')).toEqual({
      chainRole: false,
      chain: ['other/gpt-4o'],
      inherit: true,
    })
    // Undeclared role id → rootChain + inherit tail (defensive, no crash).
    expect(resolveChainForDiagnostic(roles, rootChain, 'unknown-role')).toEqual({
      chainRole: false,
      chain: ['other/gpt-4o'],
      inherit: true,
    })
  })

  it('resolveChainForDiagnostic reports an unconfigured chain as empty', () => {
    expect(resolveChainForDiagnostic([], [], 'default')).toEqual({ chainRole: false, chain: [], inherit: false })
  })

  it('resolveChainForDiagnostic yields [] for fallback none with an empty own chain even when rootChain is non-empty', () => {
    const roles = [{ id: 'reviewer', persona: '', chain: [], fallback: 'none' }]
    // Mirror resolveChainViews' `[...[], ...[]]` exactly — nothing appended.
    expect(resolveChainForDiagnostic(roles, ['other/gpt-4o'], 'reviewer')).toEqual({
      chainRole: false,
      chain: [],
      inherit: false,
    })
  })

  it('recentFallbacksSwitches filters the event log, newest first, capped at the limit', () => {
    const events = [
      { type: 'llm/retry', data: {} },
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, role: 'inherit', reason: 'trigger-code' } },
      { type: 'fallbacks/switch', data: { turn: 2, step: 1, from: { provider: 'c', model: 'm3' }, to: { provider: 'd', model: 'm4' }, role: 'inherit', reason: 'always-cap' } },
      { type: 'message/user', data: {} },
    ]
    const found = recentFallbacksSwitches(events, RECENT_SWITCHES_LIMIT)
    expect(found).toHaveLength(2)
    // newest first: turn 2 before turn 1
    expect(found[0]).toEqual({ turn: 2, step: 1, from: { provider: 'c', model: 'm3' }, to: { provider: 'd', model: 'm4' }, role: 'inherit', reason: 'always-cap' })
    expect(found[1]).toEqual({ turn: 1, step: 1, from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, role: 'inherit', reason: 'trigger-code' })
  })

  it('recentFallbacksSwitches caps at the limit and skips unknown shapes', () => {
    const events = [1, 'x', null, { type: 'llm/retry', data: {} }, { type: 'message/user', data: {} }]
    expect(recentFallbacksSwitches(events, 1)).toEqual([])
    expect(recentFallbacksSwitches([], 5)).toEqual([])
  })

  it('recentFallbacksSwitches skips malformed fallbacks/switch payloads without throwing', () => {
    const events = [
      { type: 'fallbacks/switch', data: { n: 1 } },
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'a' }, to: { provider: 'b', model: 'm' }, role: 'inherit', reason: 'trigger-code' } }, // from.model missing
      { type: 'fallbacks/switch', data: null },
      // Historical old-session event: sessions written before the runtime
      // resolved no-rule-match to 'inherit' carried role 'default'; the
      // parser must keep reading them (version-skew tolerance, qc1 F-005).
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'deepseek', model: 'deepseek-chat' }, to: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, role: 'default', reason: 'trigger-code' } },
    ]
    const found = recentFallbacksSwitches(events, RECENT_SWITCHES_LIMIT)
    expect(found).toEqual([
      { turn: 1, step: 1, from: { provider: 'deepseek', model: 'deepseek-chat' }, to: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, role: 'default', reason: 'trigger-code' },
    ])
    // Malformed entries must not crash the builder even when nothing is valid.
    expect(recentFallbacksSwitches([{ type: 'fallbacks/switch', data: { n: 1 } }], 5)).toEqual([])
  })
})

describe('parseFallbacksSubcommand — rawInput subcommand parsing', () => {
  it("maps trimmed 'config' to the config subcommand (separator whitespace included)", () => {
    // /fallbacks config → rawInput === ' config' (exact text after the name).
    expect(parseFallbacksSubcommand(' config')).toBe('config')
    expect(parseFallbacksSubcommand('config')).toBe('config')
    expect(parseFallbacksSubcommand('  config  ')).toBe('config')
  })

  it("maps everything else — including empty input — to the bare snapshot (lenient, no error)", () => {
    expect(parseFallbacksSubcommand('')).toBe('')
    expect(parseFallbacksSubcommand('   ')).toBe('')
    expect(parseFallbacksSubcommand(' xyz')).toBe('')
    expect(parseFallbacksSubcommand('configx')).toBe('')
    // Trim only — no case folding: the host lowercases the command name, not rawInput.
    expect(parseFallbacksSubcommand('CONFIG')).toBe('')
  })
})

describe('fallbacksCommandText — output states', () => {
  it('renders origin, role, and a configured role chain without an inherit annotation', () => {
    const text = fallbacksCommandText(snapshot(), 'zh')
    expect(text).toContain('会话来源: root')
    expect(text).toContain('角色: inherit')
    expect(text).toContain('链: anthropic/claude-3-5-sonnet → openai/*')
    expect(text).not.toContain('inherit-root')
  })

  it('appends the inherit-root annotation when the chain inherits rootChain (inherit: true)', () => {
    const zh = fallbacksCommandText(snapshot({ chainRole: true, chain: ['openai/gpt-4o-mini'], inherit: true }), 'zh')
    expect(zh).toContain('链: openai/gpt-4o-mini（inherit-root）')
    const en = fallbacksCommandText(snapshot({ chainRole: false, chain: ['other/gpt-4o'], inherit: true }), 'en')
    expect(en).toContain('Chain: other/gpt-4o (inherit-root)')
  })

  it('renders "not configured" when no chain exists', () => {
    const zh = fallbacksCommandText(snapshot({ chainRole: false, chain: [], inherit: false }), 'zh')
    expect(zh).toContain('链: 未配置')
    const en = fallbacksCommandText(snapshot({ chainRole: false, chain: [], inherit: false }), 'en')
    expect(en).toContain('Chain: not configured')
  })

  it('renders "not configured" for a fallback-none role with an empty own chain despite a rootChain', () => {
    // Full path: resolution (none + empty → []) feeds the renderer → 未配置.
    const { chain, inherit } = resolveChainForDiagnostic(
      [{ id: 'reviewer', persona: '', chain: [], fallback: 'none' }],
      ['other/gpt-4o'],
      'reviewer',
    )
    expect(chain).toEqual([])
    expect(inherit).toBe(false)
    const zh = fallbacksCommandText(snapshot({ chainRole: false, chain, inherit }), 'zh')
    expect(zh).toContain('链: 未配置')
  })

  it('lists recent switches newest-first with from/to/role/reason', () => {
    // Historical old-session events: sessions written before the runtime
    // resolved no-rule-match to 'inherit' carried role 'default'; the
    // renderer must keep displaying them verbatim (qc1 F-005).
    const switches: FallbacksSwitchEventData[] = [
      { turn: 1, step: 1, from: { provider: 'deepseek', model: 'deepseek-chat' }, to: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, role: 'default', reason: 'trigger-code' },
      { turn: 2, step: 1, from: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, to: { provider: 'openai', model: 'gpt-4o' }, role: 'default', reason: 'always-cap' },
    ]
    const text = fallbacksCommandText(snapshot({ switches }), 'zh')
    expect(text).toContain('最近降级切换 (2):')
    expect(text.indexOf('deepseek/deepseek-chat → anthropic/claude-3-5-sonnet')).toBeLessThan(
      text.indexOf('anthropic/claude-3-5-sonnet → openai/gpt-4o'),
    )
    expect(text).toContain('reason=触发码')
    expect(text).toContain('reason=always 上限')
    expect(text).toContain('role=default')
  })

  it('renders the none state when no switches exist', () => {
    const zh = fallbacksCommandText(snapshot({ switches: [] }), 'zh')
    expect(zh).toContain('最近降级切换: 本会话暂无 fallback 切换')
    const en = fallbacksCommandText(snapshot({ switches: [] }), 'en')
    expect(en).toContain('Recent fallback switches: No fallback switches in this session')
  })

  it('renders the current time-slot winner (分时 side) with its label', () => {
    const zh = fallbacksCommandText(snapshot({ slot: { winner: 'all-day', label: 'all-day' } }), 'zh')
    expect(zh).toContain('分时: all-day')
    const slotRow = { kind: 'preset' as const, preset: 'liang-peak' as const, chain: ['openai/gpt-4o'] }
    const peak = fallbacksCommandText(snapshot({ slot: { winner: slotRow, label: 'Liang Peak' } }), 'zh')
    expect(peak).toContain('分时: Liang Peak')
    // en mirror
    const en = fallbacksCommandText(snapshot({ slot: { winner: slotRow, label: 'Liang Peak' } }), 'en')
    expect(en).toContain('Time slot: Liang Peak')
  })

  it('lists active cooldown entries with their expiry', () => {
    const text = fallbacksCommandText(snapshot({ cooldown: [{ key: 'deepseek/deepseek-chat', untilEpochMs: 2000 }] }), 'zh')
    expect(text).toContain('冷却 (1):')
    expect(text).toContain('deepseek/deepseek-chat 冷却至 1970-01-01T00:00:02.000Z')
  })

  it('renders the never-revert phrasing for an infinite cooldown', () => {
    const text = fallbacksCommandText(snapshot({ cooldown: [{ key: 'deepseek/deepseek-chat', untilEpochMs: Number.POSITIVE_INFINITY }] }), 'zh')
    expect(text).toContain('deepseek/deepseek-chat 会话内不再回主')
  })

  it('renders the none state when no cooldown is active', () => {
    const zh = fallbacksCommandText(snapshot({ cooldown: [] }), 'zh')
    expect(zh).toContain('冷却: 无活跃冷却')
    const en = fallbacksCommandText(snapshot({ cooldown: [] }), 'en')
    expect(en).toContain('Cooldown: none active')
  })
})

describe('fallbacksCommandText — zh/en copy smoke', () => {
  const populated = snapshot()

  it('renders the zh dictionary end to end', () => {
    const text = fallbacksCommandText(populated, 'zh')
    expect(text).toContain('当前会话 fallback 诊断（只读）')
    expect(text).toContain('会话来源: root')
    expect(text).toContain('角色: inherit')
    expect(text).toContain('链:')
    expect(text).toContain('分时: all-day')
    expect(text).toContain('最近降级切换 (1):')
    expect(text).toContain('冷却 (1):')
  })

  it('renders the en dictionary end to end', () => {
    const text = fallbacksCommandText(populated, 'en')
    expect(text).toContain('Session fallback diagnostics (read-only)')
    expect(text).toContain('Session origin: root')
    expect(text).toContain('Role: inherit')
    expect(text).toContain('Chain:')
    expect(text).toContain('Time slot: all-day')
    expect(text).toContain('Recent fallback switches (1):')
    expect(text).toContain('Cooldown (1):')
    expect(text).toContain('(role=inherit, reason=trigger-code)')
  })

  it('defaults to zh when no locale is given', () => {
    expect(fallbacksCommandText(populated)).toBe(fallbacksCommandText(populated, 'zh'))
  })
})

describe('fallbacksConfigText — composed-config readback', () => {
  it('first line marks the composed-config surface — distinct from the diagnostic title and not USAGE', () => {
    const text = fallbacksConfigText(configSummary(), 'en')
    const first = text.split('\n')[0]!
    expect(first).toBe('Fallbacks config: enabled')
    expect(first).not.toBe(FALLBACKS_COMMAND_LOCALES.en.title)
    expect(first).not.toContain('Session fallback diagnostics')
    expect(first).not.toMatch(/^  \/fallbacks/)
  })

  it('renders the enabled/disabled switch as the first line', () => {
    expect(fallbacksConfigText(configSummary(), 'en').split('\n')[0]).toBe('Fallbacks config: enabled')
    expect(fallbacksConfigText(configSummary({ enabled: false }), 'en').split('\n')[0]).toBe('Fallbacks config: disabled')
  })

  it('renders trigger codes as a joined list', () => {
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Trigger codes: AUTH, QUOTA, RATE_LIMIT')
  })

  it('renders root chain entries, and (empty) when none', () => {
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Root chain: anthropic/claude-3-5-sonnet, openai/*')
    expect(fallbacksConfigText(configSummary({ rootChain: [] }), 'en')).toContain('Root chain: (empty)')
  })

  it('renders (empty) for no trigger codes — no trailing-empty line (qc2 N-4)', () => {
    expect(fallbacksConfigText(configSummary({ triggerCodes: [] }), 'en')).toContain('Trigger codes: (empty)')
    const text = fallbacksConfigText(configSummary({ triggerCodes: [] }), 'en')
    expect(text).not.toMatch(/Trigger codes: ?\n/)
  })

  it('renders the roles summary with the full count and per-role chain counts', () => {
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Roles: 2 — coder (chain: 2), reviewer (chain: 1)')
  })

  it('renders zero roles without a dangling separator', () => {
    const text = fallbacksConfigText(configSummary({ roles: [] }), 'en')
    expect(text).toContain('Roles: 0')
    expect(text).not.toContain('Roles: 0 —')
  })

  it('truncates long lists at the cap with an ellipsis (full count stays visible)', () => {
    const roles = Array.from({ length: 7 }, (_, i) => ({ id: `role-${i}`, chainCount: i }))
    const text = fallbacksConfigText(configSummary({ roles }), 'en')
    expect(text).toContain('Roles: 7 — role-0 (chain: 0), role-1 (chain: 1), role-2 (chain: 2), role-3 (chain: 3), role-4 (chain: 4), …')
    expect(text).not.toContain('role-5')
    const codes = ['A', 'B', 'C', 'D', 'E', 'F']
    expect(fallbacksConfigText(configSummary({ triggerCodes: codes }), 'en')).toContain('Trigger codes: A, B, C, D, E, …')
  })

  it('renders cooldown, revert policy, caps, presets, and role auto-match', () => {
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Cooldown: 300000 ms')
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Revert: cooldown-expiry')
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Max switches/step: 8')
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Always-mode cap: 5')
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Presets: bundled')
    expect(fallbacksConfigText(configSummary({ presets: 'none' }), 'en')).toContain('Presets: none')
    expect(fallbacksConfigText(configSummary(), 'en')).toContain('Auto-match: enabled')
    expect(fallbacksConfigText(configSummary({ roleAutoMatch: false }), 'en')).toContain('Auto-match: disabled')
  })

  it('renders the file-only edit hints after a blank line', () => {
    const text = fallbacksConfigText(configSummary(), 'en')
    expect(text).toContain(
      '\n\nEdit: ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) or $DSH_HOME/settings.yaml (fallbacks: section)',
    )
    expect(text).toContain('TUI cannot change config — edit files only')
  })
})

describe('fallbacksConfigText — zh/en copy smoke', () => {
  const populated = configSummary()

  it('renders the zh dictionary end to end', () => {
    const text = fallbacksConfigText(populated, 'zh')
    expect(text.split('\n')[0]).toBe('Fallbacks 配置: 已启用')
    expect(text).toContain('触发码: AUTH, QUOTA, RATE_LIMIT')
    expect(text).toContain('根链: anthropic/claude-3-5-sonnet, openai/*')
    expect(text).toContain('角色: 2 — coder（chain: 2）, reviewer（chain: 1）')
    expect(text).toContain('冷却: 300000 ms')
    expect(text).toContain('回主策略: cooldown-expiry')
    expect(text).toContain('单步最大切换: 8')
    expect(text).toContain('always 上限: 5')
    expect(text).toContain('预置: bundled')
    expect(text).toContain('编辑：~/.dsh/profiles/<profile>/cordis.patch.yml（插件行）或 $DSH_HOME/settings.yaml（fallbacks: 分节）')
    expect(text).toContain('TUI 无法修改配置——只能编辑文件')
  })

  it('renders the en dictionary end to end', () => {
    const text = fallbacksConfigText(populated, 'en')
    expect(text.split('\n')[0]).toBe('Fallbacks config: enabled')
    expect(text).toContain('Trigger codes: AUTH, QUOTA, RATE_LIMIT')
    expect(text).toContain('Root chain: anthropic/claude-3-5-sonnet, openai/*')
    expect(text).toContain('Roles: 2 — coder (chain: 2), reviewer (chain: 1)')
    expect(text).toContain('Cooldown: 300000 ms')
    expect(text).toContain('Revert: cooldown-expiry')
    expect(text).toContain('Max switches/step: 8')
    expect(text).toContain('Always-mode cap: 5')
    expect(text).toContain('Presets: bundled')
    expect(text).toContain('Edit: ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) or $DSH_HOME/settings.yaml (fallbacks: section)')
    expect(text).toContain('TUI cannot change config — edit files only')
  })

  it('defaults to zh when no locale is given', () => {
    expect(fallbacksConfigText(populated)).toBe(fallbacksConfigText(populated, 'zh'))
  })

  it('USAGE lists the config subcommand, reusing the usageConfig description (single copy source)', () => {
    expect(FALLBACKS_COMMAND_LOCALES.zh.usage).toBe('  /fallbacks config   查看组合后的 fallbacks 配置（设置回读）')
    expect(FALLBACKS_COMMAND_LOCALES.en.usage).toBe(
      '  /fallbacks config   show the composed fallbacks config (settings readback)',
    )
    // The USAGE line composes the shared description — never duplicated copy.
    expect(FALLBACKS_COMMAND_LOCALES.zh.usage).toContain(FALLBACKS_COMMAND_LOCALES.zh.usageConfig)
    expect(FALLBACKS_COMMAND_LOCALES.en.usage).toContain(FALLBACKS_COMMAND_LOCALES.en.usageConfig)
  })
})

describe('handler — factory-bound, read-only', () => {
  it('renders the controller snapshot as a success result for the invoking agent', () => {
    const agent = { id: 'a1', session: { events: [] } }
    const controller: FallbacksCommandController = { getSnapshot: vi.fn(() => snapshot()), getConfig: vi.fn(() => configSummary()) }
    const { definition } = captureRegistration(controller, 'en')
    const result = definition.handler({
      commandId: 'x',
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result).toEqual({ kind: 'success', text: fallbacksCommandText(snapshot(), 'en') })
    expect(controller.getSnapshot).toHaveBeenCalledWith(agent)
  })

  it('treats non-config rawInput leniently — falls back to the snapshot (no USAGE prepend)', () => {
    const controller: FallbacksCommandController = { getSnapshot: () => snapshot(), getConfig: () => configSummary() }
    const { definition } = captureRegistration(controller)
    const result = definition.handler({
      commandId: 'x',
      agent: { id: 'a1', session: { events: [] } },
      rawInput: '   whatever',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result).toEqual({ kind: 'success', text: fallbacksCommandText(snapshot()) })
    // The diagnostic body is exactly the snapshot text — the config surface
    // (USAGE / composed-config summary) is never prepended onto it.
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    expect(text).not.toContain('/fallbacks config')
  })

  it('routes the config subcommand to getConfig and renders the composed-config readback', () => {
    const controller: FallbacksCommandController = {
      getSnapshot: vi.fn(() => snapshot()),
      getConfig: vi.fn(() => configSummary()),
    }
    const { definition } = captureRegistration(controller, 'en')
    const result = definition.handler({
      commandId: 'x',
      agent: { id: 'a1', session: { events: [] } },
      rawInput: ' config',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result).toEqual({ kind: 'success', text: fallbacksConfigText(configSummary(), 'en') })
    expect(controller.getConfig).toHaveBeenCalledTimes(1)
    expect(controller.getConfig).toHaveBeenCalledWith()
    expect(controller.getSnapshot).not.toHaveBeenCalled()
  })

  it('treats a contract-violating missing rawInput as bare input (defensive ?? \'\') (qc2 N-3)', () => {
    const controller: FallbacksCommandController = {
      getSnapshot: vi.fn(() => snapshot()),
      getConfig: () => configSummary(),
    }
    const { definition } = captureRegistration(controller)
    const result = definition.handler({
      commandId: 'x',
      agent: { id: 'a1', session: { events: [] } },
      rawInput: undefined,
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    // Falls back to the bare snapshot instead of throwing on the deref.
    expect(result).toEqual({ kind: 'success', text: fallbacksCommandText(snapshot()) })
    expect(controller.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('is bound to the locale passed at registration', () => {
    const { definition } = captureRegistration({ getSnapshot: () => snapshot(), getConfig: () => configSummary() }, 'en')
    const result = definition.handler({
      commandId: 'x',
      agent: { id: 'a1', session: { events: [] } },
      rawInput: '',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect((result as { text?: string }).text).toContain('Session origin')
  })
})

describe('apply() wiring — conditional commands child', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers /fallbacks only when a commands service is composed', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))
    await vi.waitFor(() => expect(registered).toHaveLength(1))
    expect(registered[0]?.name).toBe('fallbacks')
  })

  it('handler reads live runtime state (role, chain, switches, cooldown) and never mutates it', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-agent', { provider: 'mock', model: 'gpt-4o' })
    // A real switch: cooldown on the source model (no durable event, issue #52).
    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })

    const result = registered[0]!.handler({
      commandId: 'x',
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result.kind).toBe('success')
    const text = (result as { text?: string }).text ?? ''
    expect(text).toContain('会话来源: root')
    // No rules match → the built-in 'inherit' role → rootChain + inherit tail.
    expect(text).toContain('角色: inherit')
    expect(text).toContain('链: other/gpt-4o（inherit-root）')
    // P7: the 分时 line reports the current slot winner (all-day here — no
    // extra rows), separate from the 降级切换 switches section.
    expect(text).toContain('分时: all-day')
    // Stop-write (issue #52): no durable fallbacks/switch event → the command's
    // recent-switch section is empty, while the cooldown readback still works.
    expect(text).toContain('最近降级切换: 本会话暂无 fallback 切换')
    expect(text).toContain('冷却 (1):')
    expect(text).toContain('mock/gpt-4o 冷却至')
    expect(text).not.toContain('无活跃冷却')

    // Read-only: the invocation must not have grown the store or replayed events.
    expect(agent.session.events).toHaveLength(0)
  })

  it('reports the slot as all-day when a legacy non-conforming all-day keeps the rows inert (qc1 F-001)', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    apply(ctx, cfg({
      rootChain: ['mock/legacy-a', 'other/legacy-b'],
      timeSlots: [{ kind: 'custom', start: '09:00', end: '12:00', chain: ['anthropic/claude-sonnet-4'] }],
    }))
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-legacy-slot', { provider: 'mock', model: 'gpt-4o' })
    // Pin the clock INSIDE the slot window (09:01 Asia/Shanghai): the row
    // would win for a conforming all-day — with a legacy multi-model chain
    // the 分时 line must stay on the inert all-day state (no slot status
    // for a rotation that never affects routing).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    try {
      const result = registered[0]!.handler({
        commandId: 'x',
        agent,
        rawInput: '',
        signal: new AbortController().signal,
      } as unknown as CommandInvocation)
      expect(result.kind).toBe('success')
      const text = (result as { text?: string }).text ?? ''
      expect(text).toContain('分时: all-day')
      expect(text).not.toContain('custom 09:00-12:00')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows an unconfigured chain and no cooldown for an untouched agent', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    apply(ctx, cfg())
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-idle', { provider: 'mock', model: 'gpt-4o' })
    const result = registered[0]!.handler({
      commandId: 'x',
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    const text = (result as { text?: string }).text ?? ''
    expect(text).toContain('链: 未配置')
    expect(text).toContain('分时: all-day')
    expect(text).toContain('最近降级切换: 本会话暂无 fallback 切换')
    expect(text).toContain('冷却: 无活跃冷却')
  })

  it('degrades gracefully when the session log carries malformed fallbacks/switch entries', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    apply(ctx, cfg())
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-malformed', { provider: 'mock', model: 'gpt-4o' })
    // Durable session log with stale/corrupted shapes (version skew).
    const log = agent.session.events as unknown as Array<{ type: string; data: Record<string, unknown> }>
    log.push(
      { type: 'fallbacks/switch', data: { n: 1 } },
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'a' }, to: { provider: 'b', model: 'm' }, role: 'inherit', reason: 'trigger-code' } },
    )
    const result = registered[0]!.handler({
      commandId: 'x',
      agent,
      rawInput: '',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    // Never throws to the host runner; malformed entries are skipped.
    expect(result.kind).toBe('success')
    const text = (result as { text?: string }).text ?? ''
    expect(text).toContain('最近降级切换: 本会话暂无 fallback 切换')
  })

  it('/fallbacks config reads the composed live source (getConfig over source()) and never mutates session state', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    // Composed config incl. the settings user layer: role chain length feeds
    // the chainCount summary; `presets: 'none'` (cfg default) keeps the
    // bundled preset self-declaration inert so the roles summary is stable.
    apply(ctx, cfg({
      enabled: true,
      triggerCodes: ['AUTH'],
      rootChain: ['other/gpt-4o'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['other/gpt-4o-mini'], fallback: 'inherit-root' }],
        rules: [],
      },
    }))
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-config', { provider: 'mock', model: 'gpt-4o' })
    const result = registered[0]!.handler({
      commandId: 'x',
      agent,
      rawInput: ' config',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result.kind).toBe('success')
    const text = result.kind === 'success' ? (result.text ?? '') : ''
    expect(text.split('\n')[0]).toBe('Fallbacks 配置: 已启用')
    expect(text).toContain('触发码: AUTH')
    expect(text).toContain('根链: other/gpt-4o')
    expect(text).toContain('角色: 1 — coder（chain: 1）')
    expect(text).toContain('冷却: 300000 ms')
    expect(text).toContain('回主策略: cooldown-expiry')
    expect(text).toContain('单步最大切换: 8')
    expect(text).toContain('always 上限: 5')
    expect(text).toContain('预置: none')
    expect(text).toContain('编辑：')
    // Read-only: the config readback must not grow the session log.
    expect(agent.session.events).toHaveLength(0)
  })

  it('top-level inject list is unchanged (commands stays conditional)', async () => {
    // The conditional child must not pollute the top-level inject: apply()
    // without a composed commands service completes without registering or
    // throwing, and a registry composed later activates the child exactly
    // once — never eagerly at apply time, never twice.
    const registered: CommandDefinition[] = []
    apply(ctx, cfg())
    expect(registered).toHaveLength(0)
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    await vi.waitFor(() => expect(registered).toHaveLength(1))
    expect(registered[0]?.name).toBe('fallbacks')
  })
})
