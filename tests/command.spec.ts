/**
 * `/fallbacks` slash command tests (plan fallbacks-mount-map-command Task 2,
 * AC-5 / AC-7): registration shape, snapshot building (role/chain
 * resolution, recent switches, cooldown), zh/en rendering smoke, the
 * factory-bound handler, and the wiring's conditional `commands` child
 * against real runtime state (no top-level inject pollution).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { apply } from '../src/index.ts'
import { cfg, dispatchRequestError, makeAgent } from './support/harness.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  fallbacksCommandText,
  hasModelSpecificChainKeys,
  RECENT_SWITCHES_LIMIT,
  recentFallbacksSwitches,
  registerFallbacksCommands,
  resolveChainForDiagnostic,
  type FallbacksCommandController,
  type FallbacksCommandRegistry,
  type FallbacksCommandSnapshot,
} from '../src/commands.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'

/** A fully-populated snapshot; `overrides` trim it to the state under test. */
function snapshot(overrides: Partial<FallbacksCommandSnapshot> = {}): FallbacksCommandSnapshot {
  return {
    origin: 'root',
    role: 'default',
    chainRole: true,
    chain: ['anthropic/claude-3-5-sonnet', 'openai/*'],
    chainKeysModelSpecific: false,
    switches: [
      {
        turn: 1,
        step: 1,
        from: { provider: 'deepseek', model: 'deepseek-chat' },
        to: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
        role: 'default',
        reason: 'trigger-code',
      },
    ],
    cooldown: [{ key: 'deepseek/deepseek-chat', untilEpochMs: 2000 }],
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
  it('registers the /fallbacks definition with name, description, empty hint, and a handler', () => {
    const { definition } = captureRegistration({ getSnapshot: () => snapshot() })
    expect(definition.name).toBe('fallbacks')
    expect(definition.description.length).toBeGreaterThan(0)
    expect(definition.input).toEqual({ hint: '' })
    expect(typeof definition.handler).toBe('function')
  })

  it('returns the registry disposer', () => {
    const { result, disposer } = captureRegistration({ getSnapshot: () => snapshot() })
    // registerFallbacksCommands must hand back the registry's own disposer
    // (the inject child owns its lifetime).
    expect(result).toBe(disposer)
    expect(disposer).toHaveBeenCalledTimes(0)
  })

  it('localizes the description to the registration locale', () => {
    const zh = captureRegistration({ getSnapshot: () => snapshot() })
    expect(zh.definition.description).toBe('查看当前会话的降级链、最近切换与冷却状态（只读）')
    const en = captureRegistration({ getSnapshot: () => snapshot() }, 'en')
    expect(en.definition.description).toBe(
      'Inspect fallback chain, recent switches, and cooldown for this session (read-only)',
    )
  })
})

describe('snapshot building helpers', () => {
  it('resolveChainForDiagnostic prefers the role key and falls back to default', () => {
    const chains = { reviewer: ['openai/gpt-4o-mini'], default: ['other/gpt-4o'] }
    expect(resolveChainForDiagnostic(chains, 'reviewer')).toEqual({
      chainRole: true,
      chain: ['openai/gpt-4o-mini'],
    })
    expect(resolveChainForDiagnostic(chains, 'default')).toEqual({
      chainRole: true,
      chain: ['other/gpt-4o'],
    })
    // role key missing → default chain, marked as fallback
    expect(resolveChainForDiagnostic(chains, 'unknown-role')).toEqual({
      chainRole: false,
      chain: ['other/gpt-4o'],
    })
  })

  it('resolveChainForDiagnostic reports an unconfigured chain as empty', () => {
    expect(resolveChainForDiagnostic({}, 'default')).toEqual({ chainRole: false, chain: [] })
  })

  it('hasModelSpecificChainKeys flags provider/model and provider/* keys only', () => {
    expect(hasModelSpecificChainKeys({ 'openai/gpt-4o': ['anthropic/claude-3-5-sonnet'] })).toBe(true)
    expect(hasModelSpecificChainKeys({ 'openai/*': ['anthropic/claude-3-5-sonnet'] })).toBe(true)
    expect(hasModelSpecificChainKeys({ default: ['other/gpt-4o'], reviewer: ['openai/gpt-4o-mini'] })).toBe(false)
    expect(hasModelSpecificChainKeys({ default: ['other/gpt-4o'], 'openai/gpt-4o': ['other/gpt-4o'] })).toBe(true)
    expect(hasModelSpecificChainKeys({})).toBe(false)
  })

  it('recentFallbacksSwitches filters the event log, newest first, capped at the limit', () => {
    const events = [
      { type: 'llm/retry', data: {} },
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, role: 'default', reason: 'trigger-code' } },
      { type: 'fallbacks/switch', data: { turn: 2, step: 1, from: { provider: 'c', model: 'm3' }, to: { provider: 'd', model: 'm4' }, role: 'default', reason: 'always-cap' } },
      { type: 'message/user', data: {} },
    ]
    const found = recentFallbacksSwitches(events, RECENT_SWITCHES_LIMIT)
    expect(found).toHaveLength(2)
    // newest first: turn 2 before turn 1
    expect(found[0]).toEqual({ turn: 2, step: 1, from: { provider: 'c', model: 'm3' }, to: { provider: 'd', model: 'm4' }, role: 'default', reason: 'always-cap' })
    expect(found[1]).toEqual({ turn: 1, step: 1, from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, role: 'default', reason: 'trigger-code' })
  })

  it('recentFallbacksSwitches caps at the limit and skips unknown shapes', () => {
    const events = [1, 'x', null, { type: 'llm/retry', data: {} }, { type: 'message/user', data: {} }]
    expect(recentFallbacksSwitches(events, 1)).toEqual([])
    expect(recentFallbacksSwitches([], 5)).toEqual([])
  })

  it('recentFallbacksSwitches skips malformed fallbacks/switch payloads without throwing', () => {
    const events = [
      { type: 'fallbacks/switch', data: { n: 1 } },
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'a' }, to: { provider: 'b', model: 'm' }, role: 'default', reason: 'trigger-code' } }, // from.model missing
      { type: 'fallbacks/switch', data: null },
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

describe('fallbacksCommandText — output states', () => {
  it('renders origin, role, and a configured role chain', () => {
    const text = fallbacksCommandText(snapshot(), 'zh')
    expect(text).toContain('会话来源: root')
    expect(text).toContain('角色: default')
    expect(text).toContain('链: anthropic/claude-3-5-sonnet → openai/*')
    expect(text).not.toContain('兜底')
  })

  it('renders the default-chain fallback marker when the role key is missing', () => {
    const text = fallbacksCommandText(snapshot({ chainRole: false, chain: ['other/gpt-4o'] }), 'zh')
    expect(text).toContain('链: other/gpt-4o（default 兜底）')
  })

  it('renders "not configured" when no chain exists', () => {
    const zh = fallbacksCommandText(snapshot({ chainRole: false, chain: [] }), 'zh')
    expect(zh).toContain('链: 未配置')
    const en = fallbacksCommandText(snapshot({ chainRole: false, chain: [] }), 'en')
    expect(en).toContain('Chain: not configured')
  })

  it('renders the model-specific-keys caveat when the config declares provider/model keys', () => {
    const zh = fallbacksCommandText(snapshot({ chainKeysModelSpecific: true }), 'zh')
    expect(zh).toContain('（含模型级链键 provider/model、provider/* — 诊断仅显示 role/default 链）')
    const en = fallbacksCommandText(snapshot({ chainKeysModelSpecific: true }), 'en')
    expect(en).toContain(
      '(model-specific chain keys provider/model, provider/* present — diagnostic shows role/default only)',
    )
  })

  it('omits the caveat when the config has no model-specific chain keys', () => {
    const zh = fallbacksCommandText(snapshot(), 'zh')
    expect(zh).not.toContain('模型级链键')
    const en = fallbacksCommandText(snapshot(), 'en')
    expect(en).not.toContain('model-specific chain keys')
  })

  it('lists recent switches newest-first with from/to/role/reason', () => {
    const switches: FallbacksSwitchEventData[] = [
      { turn: 1, step: 1, from: { provider: 'deepseek', model: 'deepseek-chat' }, to: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, role: 'default', reason: 'trigger-code' },
      { turn: 2, step: 1, from: { provider: 'anthropic', model: 'claude-3-5-sonnet' }, to: { provider: 'openai', model: 'gpt-4o' }, role: 'default', reason: 'always-cap' },
    ]
    const text = fallbacksCommandText(snapshot({ switches }), 'zh')
    expect(text).toContain('最近切换 (2):')
    expect(text.indexOf('deepseek/deepseek-chat → anthropic/claude-3-5-sonnet')).toBeLessThan(
      text.indexOf('anthropic/claude-3-5-sonnet → openai/gpt-4o'),
    )
    expect(text).toContain('reason=触发码')
    expect(text).toContain('reason=always 上限')
    expect(text).toContain('role=default')
  })

  it('renders the none state when no switches exist', () => {
    const zh = fallbacksCommandText(snapshot({ switches: [] }), 'zh')
    expect(zh).toContain('最近切换: 本会话暂无 fallback 切换')
    const en = fallbacksCommandText(snapshot({ switches: [] }), 'en')
    expect(en).toContain('Recent switches: No fallback switches in this session')
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
    expect(text).toContain('角色: default')
    expect(text).toContain('链:')
    expect(text).toContain('最近切换 (1):')
    expect(text).toContain('冷却 (1):')
  })

  it('renders the en dictionary end to end', () => {
    const text = fallbacksCommandText(populated, 'en')
    expect(text).toContain('Session fallback diagnostics (read-only)')
    expect(text).toContain('Session origin: root')
    expect(text).toContain('Role: default')
    expect(text).toContain('Chain:')
    expect(text).toContain('Recent switches (1):')
    expect(text).toContain('Cooldown (1):')
    expect(text).toContain('(role=default, reason=trigger-code)')
  })

  it('defaults to zh when no locale is given', () => {
    expect(fallbacksCommandText(populated)).toBe(fallbacksCommandText(populated, 'zh'))
  })
})

describe('handler — factory-bound, read-only', () => {
  it('renders the controller snapshot as a success result for the invoking agent', () => {
    const agent = { id: 'a1', session: { events: [] } }
    const controller: FallbacksCommandController = { getSnapshot: vi.fn(() => snapshot()) }
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

  it('ignores rawInput (diagnostic command takes no subcommand)', () => {
    const controller: FallbacksCommandController = { getSnapshot: () => snapshot() }
    const { definition } = captureRegistration(controller)
    const result = definition.handler({
      commandId: 'x',
      agent: { id: 'a1', session: { events: [] } },
      rawInput: '   whatever',
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result.kind).toBe('success')
  })

  it('is bound to the locale passed at registration', () => {
    const { definition } = captureRegistration({ getSnapshot: () => snapshot() }, 'en')
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
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
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
    apply(ctx, cfg({ chains: { default: ['other/gpt-4o'] } }))
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-agent', { provider: 'mock', model: 'gpt-4o' })
    // A real switch: durable event + cooldown on the source model.
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
    expect(text).toContain('角色: default')
    expect(text).toContain('链: other/gpt-4o')
    expect(text).toContain('mock/gpt-4o → other/gpt-4o')
    expect(text).toContain('reason=触发码')
    expect(text).toContain('冷却 (1):')
    expect(text).toContain('mock/gpt-4o 冷却至')
    expect(text).not.toContain('无活跃冷却')

    // Read-only: the invocation must not have grown the store or replayed events.
    expect(agent.session.events).toHaveLength(1)
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
    expect(text).toContain('最近切换: 本会话暂无 fallback 切换')
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
      { type: 'fallbacks/switch', data: { turn: 1, step: 1, from: { provider: 'a' }, to: { provider: 'b', model: 'm' }, role: 'default', reason: 'trigger-code' } },
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
    expect(text).toContain('最近切换: 本会话暂无 fallback 切换')
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
