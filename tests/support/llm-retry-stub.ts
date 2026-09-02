/**
 * In-test semantic double for `@deepseek-ai/dsh-llm-retry` (plan Task 4,
 * Step 1 — dual-plugin coexistence). The real package is not installed here:
 * it ships from the composed dsh app at runtime, so coexistence tests assert
 * the contract against this double, which mirrors `llm-retry/src/index.ts`
 * `recover()` faithfully:
 *
 * - `retryPolicy === undefined` → `next()` (no serving policy).
 * - `mode: 'always'`: **downstream first** (`next()`, via `settleDownstream`),
 *   honor a downstream `{ kind: 'retry' }`; otherwise schedule an always-mode
 *   backoff (append `llm/retry`, return `{ kind: 'retry' }`) — ADR-2.
 * - `mode: 'normal'`: non-retryable code → `next()`; retryable code within
 *   the budget → schedule a normal-mode backoff; budget exhausted → `next()`.
 *
 * Backoffs append the real `LlmRetryEventData` shape (llm-retry types.ts) but
 * do not actually wait — Task 4 asserts contract semantics, not timing.
 *
 * Register this listener BEFORE `apply(...)` of the fallback plugin to mirror
 * the bundle composition order (`bundle/cordis.patch.yml` inserts
 * `llm-fallbacks` after `llm-retry`).
 *
 * @module tests/support/llm-retry-stub
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'

/** Stable policy key mirroring llm-retry's `retryPolicyKey` (src/index.ts). */
function policyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ])
}

/** The last scheduled retry for (turn, step, provider, policy) — mirrors `priorPolicyRetry`. */
function lastRetry(
  agent: Agent,
  turn: number,
  step: number,
  provider: string,
  key: string,
): { retry?: number; retryId?: string } | undefined {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'llm/retry') continue
    const data = event.data as { turn: number; step: number; provider: string; policyKey: string; retry: number; retryId: string }
    if (data.turn === turn && data.step === step && data.provider === provider && data.policyKey === key) return data
  }
  return undefined
}

/** Schedule one backoff: durable `llm/retry` event in the real shape, then own the recovery. */
function backoff(
  agent: Agent,
  turn: number,
  step: number,
  provider: string,
  failure: LlmFailure,
  policy: ResolvedRetryPolicy,
  key: string,
  retry: number,
  retryId: string,
): RequestErrorAction {
  // Real shape (llm-retry types.ts): `retryId` is a branded `RetryId` and
  // `maxRetries` is REQUIRED on the normal variant (absent on always).
  // Branching on the literal `mode` lets the object satisfy the union.
  if (policy.mode === 'normal') {
    agent.session.append('llm/retry', {
      retryId: RetryId(retryId),
      turn,
      step,
      provider,
      mode: policy.mode,
      policyKey: key,
      retry,
      maxRetries: policy.maxRetries,
      delayMs: policy.initialDelayMs,
      failure,
    })
  } else {
    agent.session.append('llm/retry', {
      retryId: RetryId(retryId),
      turn,
      step,
      provider,
      mode: policy.mode,
      policyKey: key,
      retry,
      delayMs: policy.initialDelayMs,
      failure,
    })
  }
  return { kind: 'retry' }
}

export interface LlmRetryStubInternals {
  /** Deterministic retry-id generator; defaults to a per-(provider,turn,step,key) counter. */
  newRetryId?: (provider: string, turn: number, step: number, key: string, retry: number) => string
}

/**
 * Install the llm-retry semantic double on `agent/request-error`.
 * @returns the disposer (listeners also die with the context fiber).
 */
export function installLlmRetryStub(ctx: Context, internals: LlmRetryStubInternals = {}): () => void {
  const newRetryId = internals.newRetryId
    ?? ((provider: string, turn: number, step: number, key: string, retry: number) =>
      `llm-retry-stub:${provider}:${turn}:${step}:${key}:${retry}`)
  return ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    const { agent, turn, step, provider, failure, retryPolicy: policy } = payload
    if (policy === undefined) return next()
    const key = policyKey(policy)
    const prior = lastRetry(agent, turn, step, provider, key)
    if (policy.mode === 'always') {
      // Downstream first (ADR-2): settle `next()`; a downstream retry wins.
      // A throwing downstream falls back to backoff (settleDownstream).
      let decision: RequestErrorAction
      try {
        decision = await next()
      } catch {
        decision = undefined
      }
      if (decision?.kind === 'retry') return decision
    } else {
      if (!policy.retryableCodes.includes(failure.code)) return next()
      if (policy.maxRetries !== undefined && (prior?.retry ?? 0) >= policy.maxRetries) return next()
    }
    const retry = (prior?.retry ?? 0) + 1
    return backoff(agent, turn, step, provider, failure, policy, key, retry, newRetryId(provider, turn, step, key, retry))
  })
}
