/**
 * Shared test harness (direction C, plan dsh-022-rc1-upgrade).
 *
 * Two kinds of drivers:
 * - `cfg` / `walkDeps` / `makeAgent` — plain fixtures for the chain walk
 *   (`tests/chain-walk.spec.ts`, `tests/runtime-recovery.spec.ts`).
 * - `dispatchRequest` / `dispatchRequestError` — the real `agent/request` /
 *   `agent/request-error` waterfall dispatches. Under direction C the plugin
 *   registers NEITHER listener, so these drivers assert pass-through (they
 *   return the caller's own seed / the downstream decision) and are how a
 *   suite proves the plugin no longer competes on the loop's waterfalls.
 *
 * @module tests/support/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type {
  LlmCallConfig, LlmFailure, ResolvedNormalRetryPolicy, ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChainWalkDeps } from '../../src/chain-walk.ts'
import { defaultFallbacksConfig, type FallbacksConfig, type NamedChain } from '../../src/config.ts'
import { FallbackStateStore } from '../../src/state.ts'

/**
 * Config helper: spec defaults + overrides (the plugin re-resolves through
 * the schema). There is NO `enabled` baseline any more (plan
 * fallbacks-web-ux-alignment T2 — the config-level switch is removed; the
 * runtime gates read content presence via `isFallbackActive`), so every
 * cfg() call is active exactly when its overrides configure content.
 */
export function cfg(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  // Default to `presets: 'none'` (fallbacks-preset-roles QC fix wave, qc1
  // S-2): the bundled preset self-declaration would otherwise materialize 7
  // preset rows on every legacy apply() that uses cfg(), isolating those
  // suites from preset behavior they do not test. Tests that need the
  // bundled behavior expand the default config explicitly
  // (`{ ...defaultFallbacksConfig, presets: 'bundled' }`).
  return { ...defaultFallbacksConfig, presets: 'none', ...overrides }
}

/**
 * The chain id every scenario selects. The picker row id IS the chain id, so a
 * walk's `options.model` is this value.
 */
export const CHAIN_ID = 'Auto'

/**
 * One named chain (config v2): `{ id, label, entries, timeSlots }`. Routes that
 * do not need slot rotation pass the empty list the schema would compose.
 * @param entries - the 默认降级链 followed by the 默认模型 tail.
 * @param id - chain id (defaults to {@link CHAIN_ID}).
 */
export function chainOf(entries: string[], id: string = CHAIN_ID): NamedChain {
  return { id, label: id, entries, timeSlots: [] }
}

/**
 * Chain-walk dependency bundle (design §6.1) for suites that exercise the walk
 * without the full `apply()` wiring: no runtime, no agent view, no seam record,
 * a policy-off reader and a silent log, each overridable per scenario.
 */
export function walkDeps(overrides: Partial<ChainWalkDeps> = {}): ChainWalkDeps {
  return {
    readConfig: () => cfg(),
    getLlm: () => undefined,
    resolveAgentView: () => undefined,
    states: new FallbackStateStore(),
    roleIds: () => new Map(),
    seamRecord: () => undefined,
    policyFor: () => ({ state: 'disabled' }),
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  }
}

/** Fake agent + session; `setRoute` simulates the loop logging a new request header after a switch. */
export interface AgentHarness {
  agent: Agent
  setRoute(provider: string, model: string): void
}

/**
 * Make a fake agent. `header` mirrors the native `SessionHeader` fields the
 * dispatch-time runtime reads (plan fallbacks-role-automatch Task 4):
 * `session.header.origin` (the origin gate — `'subagent'` only) and
 * `session.header.agentPreset` (the explicit-role carrier). Additive — the
 * default `{}` behaves exactly like the previous `undefined` header for every
 * existing reader (`?.header?.origin ?? 'root'` → `'root'`).
 */
export function makeAgent(
  id: string,
  options: { provider?: string; model?: string } = {},
  header: { origin?: 'root' | 'subagent'; agentPreset?: string } = {},
): AgentHarness {
  const route: { provider?: string; model?: string } = { ...options }
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    id,
    options,
    status: 'idle' as const,
    session: {
      id,
      snapshotEvents: () => events,
      header,
      // Mirrors the real `Session.seq` (the next event's sequence number —
      // always the log length): the P5 `session/event` driver stamps emitted
      // events with it.
      get seq() {
        return events.length
      },
      append(type: string, data: Record<string, unknown>) {
        events.push({ type, data })
        return { seq: events.length, type, data }
      },
      requestHeader: () => (route.provider === undefined ? undefined : { config: route }),
    },
  }
  return {
    agent: agent as unknown as Agent,
    setRoute(provider: string, model: string): void {
      route.provider = provider
      route.model = model
    },
  }
}

/** Ordered `fallbacks/switch` events on an agent's session. */
export function switchEvents(agent: Agent): SessionEvent<'fallbacks/switch'>[] {
  return agent.session.snapshotEvents().filter((event) => event.type === 'fallbacks/switch') as SessionEvent<'fallbacks/switch'>[]
}

/** Ordered `llm/retry` events on an agent's session (the llm-retry stub's durable records). */
export function llmRetryEvents(agent: Agent): SessionEvent<'llm/retry'>[] {
  return agent.session.snapshotEvents().filter((event) => event.type === 'llm/retry') as SessionEvent<'llm/retry'>[]
}

/**
 * Drive one `agent/request-error` waterfall (the loop's dispatch, spec §5 table).
 */
export function dispatchRequestError(
  ctx: Context,
  agent: Agent,
  overrides: {
    turn?: number
    step?: number
    provider?: string
    failure?: LlmFailure
    retryPolicy?: ResolvedRetryPolicy
  } = {},
): Promise<RequestErrorAction> {
  return ctx.waterfall('agent/request-error', {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    provider: overrides.provider ?? 'mock',
    failure: overrides.failure ?? { message: 'boom', code: 'AUTH' },
    retryPolicy: overrides.retryPolicy,
    signal: new AbortController().signal,
  }, () => Promise.resolve(undefined))
}

/**
 * Drive one `agent/request` waterfall (the loop's buildRequest, spec §5 table).
 *
 * Under direction C the plugin registers no listener here, so the returned
 * config IS the seed (the pass-through contract the suite asserts). The fake
 * session's route follows the returned config, mirroring the loop's own header
 * fold.
 */
export async function dispatchRequest(
  ctx: Context,
  agent: Agent,
  seed: LlmCallConfig,
  overrides: { turn?: number; step?: number } = {},
): Promise<LlmCallConfig> {
  const config = await ctx.waterfall('agent/request', {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve(seed))
  const header = agent.session.requestHeader()
  if (header !== undefined) {
    header.config.provider = config.provider
    header.config.model = config.model
  }
  return config
}

/**
 * Provider retry policy with `mode: 'normal'` (llm-retry semantics; default retryable codes per spec §2 note).
 * The overrides type is the distributive partial over both resolved variants
 * (`ResolvedRetryPolicy` is a concrete union, so a plain `Omit` would only
 * expose the common keys).
 */
export function normalPolicy(overrides: Partial<Omit<ResolvedNormalRetryPolicy, 'mode'>> = {}): ResolvedRetryPolicy {
  return {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0,
    ...overrides,
  }
}

/** Provider retry policy with `mode: 'always'` (unbounded retries — llm-retry owns them; the plugin has no cap). */
export function alwaysPolicy(overrides: Partial<Omit<ResolvedRetryPolicy, 'mode'>> = {}): ResolvedRetryPolicy {
  return {
    mode: 'always',
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0,
    ...overrides,
  }
}

/**
 * Runtime double for the declared `LlmError` surface (the real
 * `@deepseek-ai/dsh-llm`, resolved from the npm registry as a peer dep),
 * mirroring the real class (`packages/llm/llm/src/index.ts`):
 * `(message, code, options?)` with a frozen serializable `failure`. The loop
 * constructs the terminal error as `new LlmError(failure.message,
 * failure.code, failure)` (spec §6) — the failure object doubles as the
 * options bag.
 */
export class LlmError extends Error {
  readonly code: string
  readonly failure: LlmFailure

  constructor(
    message: string,
    code: string,
    options: { status?: number; providerRetryAfterMs?: number; requestId?: string } = {},
  ) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.failure = Object.freeze({
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
      // The real `LlmFailure.requestId` is a branded `ProviderRequestId`
      // (dsh-llm brand.ts); the double converts the plain-string test input.
      ...(options.requestId === undefined ? {} : { requestId: ProviderRequestId(options.requestId) }),
    })
  }
}

