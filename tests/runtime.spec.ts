/**
 * Small-integration runtime tests for the plugin `apply()` (plan Task 3
 * Step 6; rewritten for the two-block config model in fallbacks-role-runtime
 * Task 2): real cordis waterfall dispatch + fake agent/session, with the
 * real `@deepseek-ai/dsh-settings` mounted over an in-memory provider
 * (`tests/support/memory-settings.ts`).
 *
 * Covers the request-error → request switch closed loop, role resolution +
 * chain concatenation under the new model (spec §7: root with no matching
 * rule → built-in `'inherit'` → `rootChain`; a matching rule → the declared
 * role's chain with append-not-replace inherit; `'none'` isolation; an
 * explicit `'inherit'` rule; undeclared-role defense), coexistence order
 * with an llm-retry-like listener, always-mode downstream-first delegation
 * (ADR-2), always-cap at the request boundary, the no-op invariant (AC-8),
 * the T2-review Important #1 decision-path contract (wildcard missing-id
 * filtering, cooldown / step-failed exclusion), the per-step safety valve,
 * state lifecycle cleanup, live settings re-read, and the startup
 * validation + legacy warn paths (AC-4 / US-4).
 *
 * The heavier coexistence/integration matrix (full llm-retry semantics, real
 * agent loop) is Task 4 (`tests/plugin.spec.ts`,
 * `tests/coexist-llm-retry.spec.ts`, `tests/always-mode.spec.ts`).
 *
 * The waterfall drivers / fake agent / config helper were extracted to
 * `tests/support/harness.ts` (Task 4) and are imported here — the Task 4
 * spec files reuse the same seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Logger } from '@deepseek-ai/cordis'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, countRetryEvents, stateStore } from '../src/index.ts'
import { resolveChainForDiagnostic } from '../src/commands.ts'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { MemorySettings } from './support/memory-settings.ts'
import {
  appendLlmRetry,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  makeAgent,
  switchEvents,
} from './support/harness.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
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

/** A declared role entity with the given chain + fallback (spec defaults elsewhere). */
function role(id: string, chain: string[], fallback: 'inherit-root' | 'none' = 'inherit-root') {
  return { id, persona: '', chain, fallback }
}

describe('request-error → request switch closed loop', () => {
  it('decides on a trigger code, records the switch, and applies it at the next request', async () => {
    const { agent } = makeAgent('agent-loop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data).toEqual({
      turn: 1,
      step: 1,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'inherit',
      reason: 'trigger-code',
    })

    // Retry buildRequest: the pending switch overrides provider/model and
    // drops any inherited reasoningEffort (installModelSelection pattern).
    const config = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })

    // Applied + cleared: a later request at the same (turn, step) is untouched.
    const again = await dispatchRequest(ctx, agent, { provider: 'other', model: 'gpt-4o' })
    expect(again).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('passes through non-trigger codes (retryable codes stay with llm-retry)', async () => {
    const { agent } = makeAgent('agent-nontrigger', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'busy', code: 'SERVER' } })
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('is a no-op without chains (AC-8 regression invariant)', async () => {
    const { agent } = makeAgent('agent-noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('passes through when disabled', async () => {
    const { agent } = makeAgent('agent-disabled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ enabled: false, rootChain: ['other/gpt-4o'] }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('role resolution + chain concatenation (spec §7)', () => {
  it('routes root with no matching rule to rootChain via the built-in inherit role', async () => {
    // A rule exists but targets subagent origin only — the root agent must
    // not match it and resolves to 'inherit' → rootChain.
    const { agent } = makeAgent('agent-root', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['other/gpt-4o'],
      roles: {
        list: [role('coder', ['third/x'])],
        rules: [{ origin: 'subagent', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)[0]?.data.role).toBe('inherit')
  })

  it('routes a matching rule to the declared role chain', async () => {
    const { agent } = makeAgent('agent-coder', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['third/x'],
      roles: {
        list: [role('coder', ['other/gpt-4o'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)[0]?.data.role).toBe('coder')
  })

  it('canonicalizes a padded declared id: list " coder " + rule "coder" resolves to the declared role (qc2 F-001)', async () => {
    // The startup validator accepts this config (both sides trimmed,
    // client-canonical trim alignment); the runtime must NOT silently
    // degrade to 'inherit' → rootChain. The declared role's chain must be
    // used, proving the padded id resolves (declared raw id returned, roleDef
    // lookup trim-consistent) — no silent inertness.
    const { agent } = makeAgent('agent-padded', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['third/x'],
      roles: {
        list: [role(' coder ', ['other/gpt-4o'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    // The declared chain (other/gpt-4o), not the rootChain fallback (third/x).
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    // The event carries the declared RAW id as stored in roles.list.
    expect(switchEvents(agent)[0]?.data.role).toBe(' coder ')
  })

  it('appends rootChain after the role chain by default (inherit-root, append-not-replace)', async () => {
    // The role chain's only entry equals the current model (filtered), so
    // the appended rootChain tail must still be reachable — the switch to
    // third/x proves the concatenation (role entries first, rootChain last).
    const { agent } = makeAgent('agent-inherit', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['third/x'],
      roles: {
        list: [role('coder', ['mock/gpt-4o'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'third', model: 'x' })
    expect(switchEvents(agent)[0]?.data.role).toBe('coder')
  })

  it("keeps only the role chain under fallback 'none' (no rootChain append)", async () => {
    const { agent, setRoute } = makeAgent('agent-none', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['third/x'],
      roles: {
        list: [role('coder', ['other/gpt-4o'], 'none')],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    // First failure: role chain wins → other/gpt-4o.
    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Same-step failure at other: the only role-chain candidate equals the
    // current model and rootChain must NOT be consulted ('none') → no-op.
    const second = await dispatchRequestError(ctx, agent, { provider: 'other' })
    expect(second).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it("resolves an explicit rule targeting 'inherit' to rootChain", async () => {
    const { agent } = makeAgent('agent-explicit-inherit', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['other/gpt-4o'],
      roles: { list: [], rules: [{ role: 'inherit' }] },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)[0]?.data.role).toBe('inherit')
  })

  it('defends an undeclared role reference: warn + fall back to inherit → rootChain (no crash)', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('agent-ghost', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      rootChain: ['other/gpt-4o'],
      roles: { list: [], rules: [{ role: 'ghost' }] },
    }))

    // Startup: validateFallbacksConfig flags the undeclared reference and
    // detectLegacyKeys reports it as a legacy key class (US-4).
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('rule references undeclared role "ghost"'))).toBe(true)
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('legacy config keys detected'))).toBe(true)

    // Decision: resolveRole warns and resolves to 'inherit' → rootChain.
    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)[0]?.data.role).toBe('inherit')
    // The decision-path warn flows through the plugin logger (qc2 F-002),
    // NOT console — the runtime message is the 'falling back' variant
    // (distinct from the startup validator's 'expected one of ...' variant).
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('falling back to "inherit"'))).toBe(true)
  })
})

describe('diagnostic snapshot mirrors resolveChainViews concatenation (T2 fix I1)', () => {
  // /fallbacks shows the same chain the runtime would walk (chains.ts
  // resolveChainViews single walk), model-independent. Regression anchor:
  // a declared role with an EMPTY own chain under fallback 'none' resolves
  // to [] at runtime — the diagnostic must not fall back to rootChain.
  it('shows an empty chain for a declared role with no chain under fallback none', () => {
    expect(resolveChainForDiagnostic([role('reviewer', [], 'none')], ['other/gpt-4o'], 'reviewer')).toEqual({
      chainRole: false,
      chain: [],
      inherit: false,
    })
  })

  it('defers an empty own chain to rootChain under the default inherit-root', () => {
    expect(resolveChainForDiagnostic([role('reviewer', [])], ['other/gpt-4o'], 'reviewer')).toEqual({
      chainRole: false,
      chain: ['other/gpt-4o'],
      inherit: true,
    })
  })

  it('shows the declared chain and marks the appended rootChain tail as inherit', () => {
    expect(resolveChainForDiagnostic([role('reviewer', ['a/x'])], ['other/gpt-4o'], 'reviewer')).toEqual({
      chainRole: true,
      chain: ['a/x'],
      inherit: true,
    })
  })

  it('keeps the declared chain isolated under fallback none (no inherit tail)', () => {
    expect(resolveChainForDiagnostic([role('reviewer', ['a/x'], 'none')], ['other/gpt-4o'], 'reviewer')).toEqual({
      chainRole: true,
      chain: ['a/x'],
      inherit: false,
    })
  })

  it('resolves unknown ids and the built-in inherit role to rootChain + inherit', () => {
    expect(resolveChainForDiagnostic([], ['other/gpt-4o'], 'ghost')).toEqual({
      chainRole: false,
      chain: ['other/gpt-4o'],
      inherit: true,
    })
    expect(resolveChainForDiagnostic([], ['other/gpt-4o'], 'inherit')).toEqual({
      chainRole: false,
      chain: ['other/gpt-4o'],
      inherit: true,
    })
  })
})

describe('default-config no-op (AC-3: enabled default OFF flips nothing at runtime)', () => {
  it('passes trigger-code failures and requests through with zero events on the default config', async () => {
    const { agent } = makeAgent('agent-ac3', { provider: 'mock', model: 'gpt-4o' })
    // The true spec default — `enabled: false`, empty rootChain — must behave
    // exactly like an uninstalled plugin (readme-settings spec §1.3: the
    // default-value flip does not change the runtime gating).
    apply(ctx, defaultFallbacksConfig)

    // request-error: the trigger code would enter the decision path if the
    // switch were on; with the default config it passes through untouched.
    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)

    // request: passthrough, and no state entry was ever grown (zero-cost).
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(0)
  })
})

describe('coexistence order with llm-retry (registered first)', () => {
  it('lets llm-retry own retryable failures until its budget is exhausted', async () => {
    const { agent } = makeAgent('agent-coexist', { provider: 'mock', model: 'gpt-4o' })
    let budget = 1
    ctx.on('agent/request-error', async (payload, next) => {
      if (payload.failure.code === 'RATE_LIMIT' && budget > 0) {
        budget -= 1
        return { kind: 'retry' }
      }
      return next()
    })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    // Retryable code within budget: llm-retry owns recovery, fallback never runs.
    const owned = await dispatchRequestError(ctx, agent, { failure: { message: '429', code: 'RATE_LIMIT' } })
    expect(owned).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Budget exhausted: llm-retry delegates; the trigger code reaches fallback.
    const delegated = await dispatchRequestError(ctx, agent, { failure: { message: '429', code: 'RATE_LIMIT' } })
    expect(delegated).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data.reason).toBe('trigger-code')

    // Never-retryable code (AUTH): llm-retry delegates immediately.
    const auth = await dispatchRequestError(ctx, agent, { failure: { message: 'bad key', code: 'AUTH' } })
    expect(auth).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(2)
  })
})

describe('always mode: downstream first, cap at agent/request (ADR-2)', () => {
  it('passes non-trigger failures through (llm-retry always backoff owns them)', async () => {
    const { agent } = makeAgent('agent-always', { provider: 'mock', model: 'gpt-4o' })
    ctx.on('agent/request-error', async (payload, next) => {
      const downstream = await next()
      if (downstream?.kind === 'retry') return downstream
      appendLlmRetry(agent, {
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        mode: 'always',
        policyKey: 'always',
        retry: 1,
      })
      return { kind: 'retry' }
    })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    // Non-trigger code under always mode: fallback must NOT preempt the backoff.
    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'busy', code: 'SERVER' } })
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(0)

    // Trigger code: the downstream (fallback) decision wins, llm-retry honors it.
    const auth = await dispatchRequestError(ctx, agent, { failure: { message: 'bad key', code: 'AUTH' } })
    expect(auth).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('switches at the request boundary once llm/retry events reach the cap', async () => {
    const { agent } = makeAgent('agent-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 5 }))

    for (let retry = 1; retry <= 4; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'always', retry })
    }
    const below = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(below).toEqual({ provider: 'mock', model: 'gpt-4o', reasoningEffort: 'high' as ReasoningEffortId })
    expect(switchEvents(agent)).toHaveLength(0)

    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'always', retry: 5 })
    const switched = await dispatchRequest(ctx, agent, {
      provider: 'mock',
      model: 'gpt-4o',
      reasoningEffort: 'high' as ReasoningEffortId,
    })
    expect(switched).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(1)
    expect(switchEvents(agent)[0]?.data).toMatchObject({
      turn: 1,
      step: 1,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'inherit',
      reason: 'always-cap',
    })
  })

  it('counts retries scoped to (turn, step, provider)', async () => {
    const { agent } = makeAgent('agent-cap-scope', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 3 }))

    // Five retries but for a different step/provider — cap must not trip.
    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 2, provider: 'other', mode: 'always', policyKey: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('does not count normal-mode retries toward the cap (llm-retry owns them)', async () => {
    const { agent } = makeAgent('agent-cap-normal', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 3 }))

    // A normal-mode provider retrying RATE_LIMIT with maxRetries ≥ cap: those
    // bounded retries belong to llm-retry and must not preempt-switch the
    // fallback (spec §2 clause 5 — the cap is an always-mode mechanism).
    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, {
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'normal',
        retry,
      })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('disables the cap when alwaysModeRetryCap is 0', async () => {
    const { agent } = makeAgent('agent-cap-zero', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 0 }))

    for (let retry = 1; retry <= 5; retry += 1) {
      appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'always', retry })
    }
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(switchEvents(agent)).toHaveLength(0)
  })
})

describe('decision-path candidate filtering (T2 review Important #1)', () => {
  it('filters provider/* entries whose target provider lacks the failing model id', async () => {
    ctx.provide('llm', {
      listModels: async (provider: string) =>
        (provider === 'other' ? [] : [{ provider, id: 'gpt-4o', name: 'gpt-4o' }]),
    })
    const { agent } = makeAgent('agent-wild-missing', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      roles: {
        list: [role('coder', ['other/*'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('resolves provider/* entries when the target provider has the model id', async () => {
    ctx.provide('llm', {
      listModels: async (provider: string) =>
        (provider === 'other' ? [{ provider, id: 'gpt-4o', name: 'gpt-4o' }] : []),
    })
    const { agent } = makeAgent('agent-wild-present', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      roles: {
        list: [role('coder', ['other/*'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('never existence-filters explicitly listed exact entries (spec §2 clause 2)', async () => {
    ctx.provide('llm', { listModels: async () => [] })
    const { agent } = makeAgent('agent-exact', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      roles: {
        list: [role('coder', ['other/gpt-4o'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('does not probe the model catalog when no candidate is a wildcard (F-002)', async () => {
    const listModels = vi.fn()
    ctx.provide('llm', { listModels })
    const { agent } = makeAgent('f002-exact', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    // Exact-entry chains only: the existence probe is pure waste on the
    // error-recovery critical path — it must not run at all.
    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(listModels).not.toHaveBeenCalled()
  })

  it('probes the catalog once per decision when a wildcard candidate exists (F-002)', async () => {
    const listModels = vi.fn(async (provider: string) =>
      (provider === 'other' ? [{ id: 'gpt-4o' }] : []))
    ctx.provide('llm', { listModels })
    const { agent } = makeAgent('f002-wild', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      roles: {
        list: [role('coder', ['other/*'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(listModels).toHaveBeenCalledWith('other')
  })

  it('excludes cooldown-suppressed and step-failed candidates (double suppression)', async () => {
    const { agent, setRoute } = makeAgent('agent-suppress', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'] }))

    // Failure 1: mock/gpt-4o → other/gpt-4o (mock is now cooled AND step-failed).
    const first = await dispatchRequestError(ctx, agent)
    expect(first).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // Failure 2 in the same step: mock (cooldown + failed) and other (== current)
    // are both excluded → no candidate → passthrough, original error semantics.
    const second = await dispatchRequestError(ctx, agent, { provider: 'other' })
    expect(second).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('keeps cooldown suppression across a step advance (failed set resets, cooldown persists)', async () => {
    const { agent, setRoute } = makeAgent('agent-cooldown', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'] }))

    const first = await dispatchRequestError(ctx, agent)
    expect(first).toEqual({ kind: 'retry' })
    setRoute('other', 'gpt-4o')

    // New step: the failed set reset, but mock is still in cooldown → still no
    // switch back (revert waits for cooldown expiry — US-4).
    const second = await dispatchRequestError(ctx, agent, { provider: 'other', step: 2 })
    expect(second).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })

  it('stops switching once the per-step safety valve is exceeded', async () => {
    const { agent, setRoute } = makeAgent('agent-valve', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['b/x', 'c/x', 'd/x'], maxSwitchesPerStep: 2 }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    setRoute('b', 'x')
    expect((await dispatchRequestError(ctx, agent, { provider: 'b' }))).toEqual({ kind: 'retry' })
    setRoute('c', 'x')
    // switchCount is 2 ≥ 2 → no decision even though d/x is available.
    const third = await dispatchRequestError(ctx, agent, { provider: 'c' })
    expect(third).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(2)
  })
})

describe('switch log skip reasons (spec §2 行为可见性; T3 review Minor 1)', () => {
  /** The `candidates=%o` array arg of the nth switch info log line. */
  function switchLogCandidates(logs: Array<{ type: string; args: unknown[] }>, index: number): unknown[] {
    const switchLogs = logs.filter((message) => message.type === 'info' && String(message.args[0]).includes('switch'))
    const candidates = switchLogs[index]?.args.find((arg) => Array.isArray(arg))
    return (candidates ?? []) as unknown[]
  }

  it('annotates every considered candidate with its skip reason in order', async () => {
    const logs = captureLogs()
    const { agent, setRoute } = makeAgent('agent-log', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o', 'third/x'] }))

    // Failure 1: mock is the current model → same-as-current; other/gpt-4o wins.
    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    expect(switchLogCandidates(logs, 0)).toEqual([
      'mock/gpt-4o (skipped: same-as-current)',
      'other/gpt-4o',
      'third/x',
    ])
    setRoute('other', 'gpt-4o')

    // Failure 2 at other (same step): mock is cooled AND step-failed (cooldown
    // wins precedence), other == current → third/x wins.
    expect((await dispatchRequestError(ctx, agent, { provider: 'other' }))).toEqual({ kind: 'retry' })
    expect(switchLogCandidates(logs, 1)).toEqual([
      'mock/gpt-4o (skipped: cooldown)',
      'other/gpt-4o (skipped: same-as-current)',
      'third/x',
    ])
  })

  it('labels wildcard entries the target provider lacks as missing-id', async () => {
    ctx.provide('llm', {
      listModels: async (provider: string) =>
        (provider === 'other' ? [] : [{ provider, id: 'gpt-4o', name: 'gpt-4o' }]),
    })
    const logs = captureLogs()
    const { agent } = makeAgent('agent-log-missing', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({
      roles: {
        list: [role('coder', ['other/*', 'local/*'])],
        rules: [{ provider: 'mock', role: 'coder' }],
      },
    }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    expect(switchLogCandidates(logs, 0)).toEqual([
      'other/gpt-4o (skipped: missing-id)',
      'local/gpt-4o',
    ])
  })
})

describe('countRetryEvents — always-mode counting + fast path (T3 review Minor 4)', () => {
  /** Minimal session double — `countRetryEvents` only reads `session.events`. */
  function sessionWith(events: Array<{ type: string; data: Record<string, unknown> }>): Session {
    return { events: events as unknown as SessionEvent[] } as unknown as Session
  }

  it('returns 0 without scanning earlier turns when the target (turn, step) has no retries', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    for (let step = 1; step <= 50; step += 1) {
      events.push({ type: 'llm/retry', data: { turn: 1, step, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 } })
    }
    // 50 old-turn events, target (2, 1): the reverse scan breaks on the first
    // event older than the target and returns 0.
    expect(countRetryEvents(sessionWith(events), 2, 1, 'mock')).toBe(0)
  })

  it('counts only always-mode retries at the exact (turn, step, provider)', () => {
    // Append-ordered log (oldest first — the session log is append-only).
    const events: Array<{ type: string; data: Record<string, unknown> }> = [
      { type: 'llm/retry', data: { turn: 1, step: 9, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 } },
      { type: 'llm/retry', data: { turn: 2, step: 3, provider: 'mock', mode: 'normal', policyKey: 'normal', retry: 1 } },
      { type: 'llm/retry', data: { turn: 2, step: 3, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 } },
      { type: 'llm/retry', data: { turn: 2, step: 3, provider: 'mock', mode: 'always', policyKey: 'always', retry: 2 } },
      { type: 'llm/retry', data: { turn: 2, step: 3, provider: 'other', mode: 'always', policyKey: 'always', retry: 1 } },
    ]
    expect(countRetryEvents(sessionWith(events), 2, 3, 'mock')).toBe(2)
  })

  it('does not let events after the target (turn, step) leak into the count', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [
      { type: 'llm/retry', data: { turn: 2, step: 3, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 } },
      { type: 'llm/retry', data: { turn: 2, step: 4, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 } },
    ]
    expect(countRetryEvents(sessionWith(events), 2, 3, 'mock')).toBe(1)
  })
})

describe('lazy per-agent state on agent/request (T3 review Minor 3)', () => {
  it('keeps the store empty after a no-op request (no chains)', async () => {
    const { agent } = makeAgent('agent-lazy-noop', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('skips the always-cap session scan entirely when no chains are configured (F-001)', async () => {
    const { agent } = makeAgent('f001-scan', { provider: 'mock', model: 'gpt-4o' })
    // The no-op invariant promises a truly zero-cost request on an unconfigured
    // install (AC-8). Watch for any read of the session event log during the
    // request path: with default config (enabled + cap > 0 but empty rootChain
    // and no role chains) the always-cap counting must be short-circuited, not
    // scanned per request.
    let eventReads = 0
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    Object.defineProperty(agent.session, 'events', {
      configurable: true,
      get() {
        eventReads += 1
        return events
      },
    })
    apply(ctx, cfg())
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(eventReads).toBe(0)
  })

  it('does not create a state entry when the request-error decision yields no candidate (F-004)', async () => {
    const { agent } = makeAgent('f004-noentry', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg())

    expect(await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })).toBeUndefined()
    expect(stateStore(ctx)?.has(agent.id)).toBe(false)
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('does not create a state entry when every candidate is filtered out (F-004)', async () => {
    const { agent } = makeAgent('f004-filtered', { provider: 'mock', model: 'gpt-4o' })
    // The only candidate equals the current model → filtered as same-as-current.
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o'] }))

    expect(await dispatchRequestError(ctx, agent)).toBeUndefined()
    expect(stateStore(ctx)?.has(agent.id)).toBe(false)
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('does not create a state entry when the always-cap decision yields no candidate (F-004)', async () => {
    const { agent } = makeAgent('f004-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o'], alwaysModeRetryCap: 1 }))
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 })

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.has(agent.id)).toBe(false)
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('keeps the store empty after a request while disabled', async () => {
    const { agent } = makeAgent('agent-lazy-disabled', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ enabled: false, rootChain: ['other/gpt-4o'] }))
    await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('creates state lazily only once the always-cap path has a real switch intent', async () => {
    const { agent } = makeAgent('agent-lazy-cap', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], alwaysModeRetryCap: 2 }))

    // Below cap: no switch intent yet → still no state entry.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'always', retry: 1 })
    const below = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(below).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(0)

    // At cap: genuine switch intent → state created and the switch applied.
    appendLlmRetry(agent, { turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'always', retry: 2 })
    const switched = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(switched).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(1)
  })

  it('applies a pending switch from request-error without growing the store', async () => {
    const { agent } = makeAgent('agent-lazy-pending', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    expect(stateStore(ctx)?.size).toBe(1)
    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(stateStore(ctx)?.size).toBe(1)
  })
})

describe('per-agent state lifecycle', () => {
  it('clears state on agent/disposed (cooldown no longer suppresses)', async () => {
    const { agent, setRoute } = makeAgent('agent-disposed', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['mock/gpt-4o', 'other/gpt-4o'] }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    ctx.emit('agent/disposed', { agent })
    setRoute('other', 'gpt-4o')

    // State gone: mock is no longer cooled/failed → switch back is possible.
    const after = await dispatchRequestError(ctx, agent, { provider: 'other' })
    expect(after).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)).toHaveLength(2)
  })

  it('prunes a pending switch on agent/status idle (defensive)', async () => {
    const { agent } = makeAgent('agent-idle', { provider: 'mock', model: 'gpt-4o' })
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    expect((await dispatchRequestError(ctx, agent))).toEqual({ kind: 'retry' })
    ctx.emit('agent/status', { agent, status: 'idle' })

    const config = await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' })
    expect(config).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })
})

describe('settings live re-read', () => {
  it('re-reads rootChain and enabled through the real settings service on update', async () => {
    const { agent } = makeAgent('agent-settings', { provider: 'mock', model: 'gpt-4o' })
    const ns = settingsNamespace('fallbacks')
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))

    // The real installSettingsSection registers through `ctx.inject` (a
    // deferred callback even when the service is already mounted), so settle
    // one macrotask before probing the registration.
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>()
    setTimeout(settle, 0)
    await settled

    // The namespace is registered on the mounted service; the user document
    // is empty, so the composition entry (the cfg() default) resolves.
    expect(ctx.settings.describe().map((descriptor) => descriptor.ns)).toContain(ns)

    // A real settings update merges into the user document; scope.watch →
    // onChange re-reads the source thunk (scope.get()) and re-applies.
    await ctx.settings.update(ns, { rootChain: ['third/x'] })

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'third', model: 'x' })

    await ctx.settings.update(ns, { enabled: false })

    const disabled = await dispatchRequestError(ctx, agent)
    expect(disabled).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(1)
  })
})

describe('startup validation + legacy warn (AC-4 warn-not-crash, US-4 migration pointer)', () => {
  it('warns on illegal chain entries at startup and treats them as inert', async () => {
    const logs = captureLogs()
    const { agent } = makeAgent('agent-invalid', { provider: 'mock', model: 'gpt-4o' })
    // 'nope' has no provider/model separator; 'openai/' has an empty model —
    // both fail parseSelector (warn) and never become candidates. The valid
    // entry still resolves, so the switch happens to other/gpt-4o.
    expect(() => apply(ctx, cfg({ rootChain: ['nope', 'other/gpt-4o'] }))).not.toThrow()
    expect(logs.some((message) => message.type === 'warn'
      && String(message.args[0]).includes('invalid rootChain entry "nope"'))).toBe(true)

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toEqual({ kind: 'retry' })
    expect(switchEvents(agent)[0]?.data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
  })

  it('does not crash at startup with only illegal selectors and treats them as inert', async () => {
    const { agent } = makeAgent('agent-invalid-only', { provider: 'mock', model: 'gpt-4o' })
    expect(() => apply(ctx, cfg({ rootChain: ['openai/'] }))).not.toThrow()

    const action = await dispatchRequestError(ctx, agent)
    expect(action).toBeUndefined()
    expect(switchEvents(agent)).toHaveLength(0)
  })

  it('warns with the migration pointer when the source carries two-block-era keys', async () => {
    const logs = captureLogs()
    const legacy = {
      ...defaultFallbacksConfig,
      enabled: true,
      // The removed `chains` map and `roles.default` field survive the
      // schema (unknown keys retained) — exactly the composed object a
      // pre-migration settings.yaml yields at startup.
      chains: { default: ['other/gpt-4o'], reviewer: ['openai/gpt-4o-mini'] },
      roles: { default: 'default', list: [], rules: [] },
    } as unknown as FallbacksConfig
    expect(() => apply(ctx, legacy)).not.toThrow()

    const legacyWarns = logs.filter((message) => message.type === 'warn'
      && String(message.args[0]).includes('legacy config keys detected'))
    expect(legacyWarns).toHaveLength(1)
    expect(String(legacyWarns[0]?.args[0])).toContain('docs/configuration.md migration table')
    expect(legacyWarns[0]?.args[1]).toEqual(['chains', 'roles.default'])
  })
})
