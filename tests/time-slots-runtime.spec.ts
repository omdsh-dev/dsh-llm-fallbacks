/**
 * Time-slot runtime seed tests (plan fallbacks-timeslots Task 2, P7).
 *
 * - Root-origin failure walks (`agent/request-error` → `decide()`) resolve
 *   the slot-effective chain via `resolveEffectiveChain` — the effective
 *   chain replaces the raw `rootChain` as the root role's
 *   `resolveChainViews` tail in BOTH primary and fallback-only modes.
 *   Subagent walks keep the raw `rootChain`; a non-conforming all-day keeps
 *   slot rows INERT (P6) and the v0.2.2 walk runs verbatim.
 * - 分时切换 detection: a per-root-agent last-winner marker at
 *   `agent/request` logs a time-slot switch when the slot winner changes vs
 *   the previous root request — a routing seed, NOT a failure decision:
 *   info log only, exempt from cooldown and `maxSwitchesPerStep`, no
 *   pending switch, no durable event; never force-switches an in-flight
 *   step. Marker cleaned on `agent/disposed` + plugin dispose.
 * - Copy split (spec § Copy): the rotation log says 分时切换 / time-slot
 *   switch; the failure-walk log says 降级切换 / fallback switch. Never
 *   mixed.
 *
 * Uses the real plugin `apply()` against the harness fake agent/session —
 * no LLM runtime needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, stateStore } from '../src/index.ts'
import { OFFICIAL_V4_FLASH, type SlotRowConfig } from '../src/time-slots.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, dispatchRequestError, makeAgent, switchEvents } from './support/harness.ts'

/** A slot row that matches every UTC+8 instant (window 00:00–23:59). */
const allDaySlotRow: SlotRowConfig = {
  kind: 'custom',
  start: '00:00',
  end: '23:59',
  chain: ['anthropic/claude-sonnet-4'],
}

/** A slot row matching UTC+8 09:00–12:00 only. */
const morningSlotRow: SlotRowConfig = {
  kind: 'custom',
  start: '09:00',
  end: '12:00',
  chain: ['anthropic/claude-sonnet-4'],
}

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

/**
 * Capture every ctx.logger export (info/warn/...) from this point on.
 * The exporter threshold defaults to the logger level (INFO), which would
 * drop warn records — `levels.default` = DEBUG (3) lets warn (2) flow.
 */
function captureLogs(): Array<{ type: string; args: unknown[] }> {
  const logs: Array<{ type: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
}

function slotSwitchLogs(logs: Array<{ type: string; args: unknown[] }>): Array<{ type: string; args: unknown[] }> {
  return logs.filter((message) => message.type === 'info' && String(message.args[0]).includes('time-slot switch'))
}

describe('root-origin failure walk seeds from the slot-effective chain (P7)', () => {
  it('walks the winning slot row chain, not the all-day chain (fallback-only mode)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-root-walk', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [allDaySlotRow] }))
    vi.useFakeTimers()
    // 2026-08-18T04:00:00Z = 12:00 Asia/Shanghai — inside the slot window.
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // The failure walk is 降级切换 — never 分时.
    const failLogs = logs.filter(
      (message) => message.type === 'info' && String(message.args[0]).includes('fallback switch'),
    )
    expect(failLogs).toHaveLength(1)
    expect(String(failLogs[0]!.args[0])).toContain('降级切换')
    expect(String(failLogs[0]!.args[0])).not.toContain('分时')
    expect(slotSwitchLogs(logs)).toHaveLength(0)
  })

  it('keeps the raw rootChain walk for subagent-origin agents', async () => {
    const { agent } = makeAgent('ts-sub-walk', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [allDaySlotRow] }))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('existence-filters a wildcard that only the winning slot row reaches (probe walks the effective tail)', async () => {
    // `other/*` exists on the slot row but NOWHERE on the raw rootChain —
    // the F-002 wildcard probe must walk the same effective tail as the
    // candidates (qc2 F-003: probe never diverges from the resolution), so
    // the phantom wildcard is filtered and the switch targets the exact
    // entry.
    ctx.provide('llm', {
      listModels: async (provider: string) =>
        (provider === 'other' ? [] : [{ provider, id: 'gpt-4o', name: 'gpt-4o' }]),
    })
    const { agent } = makeAgent('ts-wild', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({
      rootChain: [OFFICIAL_V4_FLASH],
      timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'openai/gpt-4o'] }],
    }))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('keeps slot rows inert for a legacy non-conforming all-day (P6 — v0.2.2 walk verbatim)', async () => {
    const { agent } = makeAgent('ts-legacy', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: ['mock/legacy-a', 'other/legacy-b'], timeSlots: [allDaySlotRow] }))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'legacy-a' })
  })
})

describe('分时切换 detection — per-root-agent last-winner marker (P7)', () => {
  it('logs a time-slot switch when the winner changes vs the previous root request', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-rotate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    // 08:59 Asia/Shanghai (2026-08-17T00:59:00Z) → all-day wins; baseline.
    vi.setSystemTime(new Date('2026-08-17T00:59:00Z'))
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(slotSwitchLogs(logs)).toHaveLength(0)

    // 09:01 Asia/Shanghai → the custom slot wins → 分时切换 log; the request
    // itself is untouched (rotation is a seed, not an override for real
    // model selections).
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })

    const switched = slotSwitchLogs(logs)
    expect(switched).toHaveLength(1)
    expect(String(switched[0]!.args[0])).toContain('分时切换')
    expect(String(switched[0]!.args[0])).not.toContain('降级')
    expect(switched[0]!.args[2]).toBe('all-day')
    expect(switched[0]!.args[3]).toBe('custom 09:00-12:00')
    // No durable event, no per-agent state (no cooldown, no switch count).
    expect(switchEvents(agent)).toHaveLength(0)
    expect(stateStore(ctx)?.peek(agent.id)).toBeUndefined()
  })

  it('does not log when the winner is unchanged across requests', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-stable', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    vi.setSystemTime(new Date('2026-08-17T02:30:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(slotSwitchLogs(logs)).toHaveLength(0)
  })

  it('rotation is exempt: no cooldown/switch-count bookkeeping and the next failure walks the new slot', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-exempt', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    // Baseline at all-day, then rotate into the morning slot.
    vi.setSystemTime(new Date('2026-08-17T00:59:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(slotSwitchLogs(logs)).toHaveLength(1)
    // The rotation wrote NO fallback state — nothing cooled, nothing counted.
    expect(stateStore(ctx)?.peek(agent.id)).toBeUndefined()

    // The failure decision still works and walks the NEW slot chain — the
    // rotation did not consume the step valve or poison the cooldown.
    expect(await dispatchRequestError(ctx, agent)).toEqual({ kind: 'retry' })
    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('never logs for subagent-origin requests', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-sub', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-08-17T00:59:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(slotSwitchLogs(logs)).toHaveLength(0)
  })

  it('never logs when the plugin is disabled (slots inert)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-off', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ enabled: false, rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-08-17T00:59:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(slotSwitchLogs(logs)).toHaveLength(0)
  })

  it('keeps the marker per agent (a fresh agent baselines on its first request)', async () => {
    const logs = captureLogs()
    const { agent: first } = makeAgent('ts-a', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    const { agent: second } = makeAgent('ts-b', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-08-17T00:59:00Z'))
    await dispatchRequest(ctx, first, { provider: 'mock', model: 'gpt-4o' })
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    // `second` never requested before → first request baselines, no log.
    await dispatchRequest(ctx, second, { provider: 'mock', model: 'gpt-4o' })
    await dispatchRequest(ctx, first, { provider: 'mock', model: 'gpt-4o' })
    const switched = slotSwitchLogs(logs)
    expect(switched).toHaveLength(1)
    expect(switched[0]!.args[1]).toBe('ts-a')
  })

  it('clears the marker on agent/disposed (a re-created agent re-baselines)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('ts-recreate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH], timeSlots: [morningSlotRow] }))
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-08-17T00:59:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    vi.setSystemTime(new Date('2026-08-17T01:01:00Z'))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(slotSwitchLogs(logs)).toHaveLength(1)

    ctx.emit('agent/disposed', { agent })
    const { agent: recreated } = makeAgent('ts-recreate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    await dispatchRequest(ctx, recreated, { provider: 'mock', model: 'gpt-4o' })
    // Marker gone → the first request after re-creation only baselines.
    expect(slotSwitchLogs(logs)).toHaveLength(1)
  })
})
