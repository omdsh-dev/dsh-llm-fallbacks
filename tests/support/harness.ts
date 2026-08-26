/**
 * Shared integration-test harness (plan Task 4). The drivers here are
 * extracted from Task 3's `tests/runtime.spec.ts` (real cordis waterfall
 * dispatch + fake agent/session) and extended with a mini agent-loop driver
 * that replays the loop's `buildRequest → stream → request-error → retry?`
 * semantics (mirrored from `packages/core/agent-loop/src/agent.ts`: build the
 * request through the `agent/request` waterfall, report the failure through
 * `agent/request-error` with the serving provider, re-enter `buildRequest` on
 * `{ kind: 'retry' }`, otherwise throw `new LlmError(failure.message,
 * failure.code, failure)` — spec §6).
 *
 * The Task 4 spec files (`tests/plugin.spec.ts`, `tests/coexist-llm-retry
 * .spec.ts`, `tests/always-mode.spec.ts`) drive the real plugin `apply()`
 * against this harness.
 *
 * @module tests/support/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ProviderRequestId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {
  LlmCallConfig, LlmFailure, ReasoningEffortId, ResolvedNormalRetryPolicy, ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defaultFallbacksConfig, type FallbacksConfig } from '../../src/config.ts'

/**
 * Config helper: spec defaults + overrides (the plugin re-resolves through
 * the schema). The `enabled` baseline is explicit `true` — the default value
 * flipped to `false` in this iteration (readme-settings spec §1.2), and the
 * runtime tests exercise the *active* plugin, so every cfg() call inherits
 * `enabled: true` unless a case overrides it (AC-3 default no-op is pinned
 * by its own explicit test).
 */
export function cfg(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  // Default to `presets: 'none'` (fallbacks-preset-roles QC fix wave, qc1
  // S-2): the bundled preset self-declaration would otherwise materialize 7
  // preset rows on every legacy apply() that uses cfg(), isolating those
  // suites from preset behavior they do not test. Tests that need the
  // bundled behavior expand the default config explicitly
  // (`{ ...defaultFallbacksConfig, presets: 'bundled' }`).
  return { ...defaultFallbacksConfig, enabled: true, presets: 'none', ...overrides }
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
      events,
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
  return agent.session.events.filter((event) => event.type === 'fallbacks/switch') as SessionEvent<'fallbacks/switch'>[]
}

/** Ordered `llm/retry` events on an agent's session (the llm-retry stub's durable records). */
export function llmRetryEvents(agent: Agent): SessionEvent<'llm/retry'>[] {
  return agent.session.events.filter((event) => event.type === 'llm/retry') as SessionEvent<'llm/retry'>[]
}

/**
 * Append one durable `llm/retry` event in the **real** llm-retry event shape
 * (llm-retry `src/types.ts`: `retryId` / `turn` / `step` / `provider` /
 * `mode` / `policyKey` / `retry` / [`maxRetries` for normal] / `delayMs` /
 * `failure`). Task 4 uses the full shape so the always-cap counting is
 * exercised against the real bundle's event shape (T3 fix review ⚠️2 — the
 * `mode` discriminator must survive the real payload).
 */
export function appendLlmRetry(
  agent: Agent,
  data: {
    turn: number
    step: number
    provider: string
    mode: 'normal' | 'always'
    retry?: number
    policyKey?: string
    maxRetries?: number
    delayMs?: number
    failure?: LlmFailure
  },
): void {
  const { turn, step, provider, mode } = data
  const retry = data.retry ?? 1
  const policyKey = data.policyKey ?? (mode === 'always'
    ? '["always",500,10000,0]'
    : '["normal",2,["RATE_LIMIT"],500,10000,0]')
  const delayMs = data.delayMs ?? 500
  const failure = data.failure ?? { message: 'busy', code: mode === 'normal' ? 'RATE_LIMIT' : 'SERVER' }
  // Real shape (llm-retry `src/types.ts`): `retryId` is a branded `RetryId`,
  // `maxRetries` is REQUIRED on the normal variant (and must stay absent on
  // the always variant — excess-property check). Branching on the literal
  // `mode` lets the object literal satisfy the discriminated union.
  if (mode === 'normal') {
    agent.session.append('llm/retry', {
      retryId: RetryId(`llm-retry:${provider}:${turn}:${step}:${retry}`),
      turn,
      step,
      provider,
      mode,
      policyKey,
      retry,
      maxRetries: data.maxRetries ?? 2,
      delayMs,
      failure,
    })
  } else {
    agent.session.append('llm/retry', {
      retryId: RetryId(`llm-retry:${provider}:${turn}:${step}:${retry}`),
      turn,
      step,
      provider,
      mode,
      policyKey,
      retry,
      delayMs,
      failure,
    })
  }
}

/**
 * Emit one `assistant/message` `session/event` through the SAME context the
 * plugin listens on (plan fallbacks-half-open-recovery P5 driver): the
 * post-commit append firehose the P3 success-observation listener consumes.
 * The message is a real `createAssistantMessage` (dsh-llm) carrying the
 * producing route's `provider`/`model` provenance — the actual producing
 * route, so a probe served through the virtual FallbacksChain/Auto adapter
 * matches its real head's key.
 */
export function emitAssistantMessage(
  ctx: Context,
  agent: Agent,
  data: {
    provider: string
    model: string
    turn?: number
    step?: number
    interrupted?: true
  },
): void {
  const { provider, model } = data
  const message = createAssistantMessage({
    content: [{ type: 'text', text: 'ok' }],
    source: { provider, model },
  })
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    seq: agent.session.seq,
    time: Date.now(),
    data: {
      turn: data.turn ?? 1,
      step: data.step ?? 1,
      message,
      ...(data.interrupted === undefined ? {} : { interrupted: data.interrupted }),
    },
  })
}

/** Drive one `agent/request-error` waterfall (the loop's dispatch, spec §5 table). */
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
 * M-02: mirrors the real agent loop, which folds (logs) the request header
 * with the served route after buildRequest — the effective config returned by
 * the waterfall is written back into the fake session's route, so
 * `currentModel` reads the actually-served provider/model on the next
 * `agent/request-error` without the test author hand-syncing `setRoute`.
 * `setRoute` degrades to an explicit override for tests that route manually.
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

/** Provider retry policy with `mode: 'always'` (unbounded retries — the cap mechanism's subject). */
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

/** One scripted step attempt: `undefined` = the attempt succeeded. */
export type StepAttempt = LlmFailure | undefined

export interface StepResult {
  outcome: 'success' | 'error'
  /** Terminal `LlmError` when the step ended in error — original code/message preserved (spec §6). */
  error?: LlmError
  /** Request configs built per attempt (post-waterfall — reflects applied switches). */
  requests: LlmCallConfig[]
}

export interface RunStepOptions {
  /** Retry policy reported in every `agent/request-error` payload (the serving provider's policy). */
  retryPolicy?: ResolvedRetryPolicy
  /** Base config builder for each attempt; defaults to the current route. */
  seed?: (route: { provider: string; model: string }) => LlmCallConfig
}

/**
 * Mini agent-loop driver (mirrors `agent-loop/src/agent.ts` step()): build the
 * request through `agent/request` (a pending switch applies here), report the
 * scripted failure through `agent/request-error`, re-enter the build on
 * `{ kind: 'retry' }`, and end the step with the original failure's `LlmError`
 * on passthrough. The request header is logged (via `setRoute`) before each
 * failure dispatch, as the real loop does.
 */
export async function runAgentStep(
  ctx: Context,
  handle: AgentHarness,
  script: readonly StepAttempt[],
  options: RunStepOptions = {},
): Promise<StepResult> {
  const { agent, setRoute } = handle
  const route: { provider: string; model: string } = {
    provider: agent.options.provider ?? 'mock',
    model: agent.options.model ?? '',
  }
  const requests: LlmCallConfig[] = []
  for (const failure of script) {
    const config = await dispatchRequest(ctx, agent, options.seed ? options.seed(route) : { ...route })
    requests.push(config)
    // The loop logs the request header (with the served route) before dispatch.
    setRoute(config.provider, config.model)
    if (failure === undefined) return { outcome: 'success', requests }
    const action = await dispatchRequestError(ctx, agent, {
      provider: config.provider,
      failure,
      retryPolicy: options.retryPolicy,
    })
    if (action?.kind !== 'retry') {
      return { outcome: 'error', error: new LlmError(failure.message, failure.code, failure), requests }
    }
  }
  // Script exhausted with a trailing failure and no passthrough: the step ends
  // with that failure's original error.
  const last = script.at(-1)
  if (last !== undefined) {
    return { outcome: 'error', error: new LlmError(last.message, last.code, last), requests }
  }
  return { outcome: 'success', requests }
}
