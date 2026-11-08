/**
 * llm-retry coexistence under direction C (plan dsh-022-rc1-upgrade §7.2).
 *
 * The plugin no longer listens on `agent/request-error` (or `agent/request`),
 * so the relationship is COMPOSITION rather than waterfall priority:
 * llm-retry exclusively owns failure recovery; the plugin's chain walk lives
 * inside the virtual adapter's `stream()`, and an llm-retry retry simply
 * re-enters it. The cross-call memory that makes that re-entry advance is the
 * cooldown store, proven at the walk level here.
 *
 * Drives the llm-retry semantic double registered BEFORE `apply()` — the bundle
 * composition order (`bundle/cordis.patch.yml` inserts `llm-fallbacks` after
 * `llm-retry`).
 *
 * @module tests/coexist-llm-retry
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, stateStore } from '../src/index.ts'
import { FallbackStateStore } from '../src/state.ts'
import { FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { walkChain } from '../src/chain-walk.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { installLlmRetryStub } from './support/llm-retry-stub.ts'
import {
  alwaysPolicy,
  cfg,
  dispatchRequest,
  dispatchRequestError,
  llmRetryEvents,
  makeAgent,
  normalPolicy,
  walkDeps,
} from './support/harness.ts'

/** Scripted adapter: records dispatches, fails the scripted route. */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override listModels() {
    return Promise.resolve([])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (options.model === 'down') throw new LlmError('route down', 'AUTH')
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** The chain every scenario selects (the picker row id IS the chain id). */
const CHAIN_ID = 'Auto'
/** One named chain (v2). */
const chainOf = (entries: string[], id: string = CHAIN_ID) => ({ id, label: id, entries, timeSlots: [] })

describe('the plugin stays off llm-retry’s waterfall (normal mode)', () => {
  it('lets llm-retry own a retryable code: it backs off, the plugin never decides', async () => {
    const { agent } = makeAgent('coexist-normal', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))
    const policy = normalPolicy({ maxRetries: 2, retryableCodes: ['RATE_LIMIT'] })

    const action = await dispatchRequestError(ctx, agent, {
      failure: { message: '429', code: 'RATE_LIMIT' },
      retryPolicy: policy,
    })

    // llm-retry scheduled the retry, and the plugin wrote no state at all:
    // there is no plugin listener to write it (direction C removed the path).
    expect(action).toEqual({ kind: 'retry' })
    expect(llmRetryEvents(agent)).toHaveLength(1)
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('leaves a non-retryable code to the loop (the stub delegates, the plugin is silent)', async () => {
    const { agent } = makeAgent('coexist-auth', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))

    const action = await dispatchRequestError(ctx, agent, {
      failure: { message: 'bad key', code: 'AUTH' },
      retryPolicy: normalPolicy({ retryableCodes: ['RATE_LIMIT'] }),
    })

    expect(action).toBeUndefined()
    expect(llmRetryEvents(agent)).toHaveLength(0)
    expect(stateStore(ctx)?.size).toBe(0)
  })

  it('leaves the request build untouched (no plugin override on agent/request)', async () => {
    const { agent } = makeAgent('coexist-request', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))

    expect(await dispatchRequest(ctx, agent, { provider: 'mock', model: 'gpt-4o' }))
      .toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('always mode: llm-retry backs off with nothing downstream to honor', async () => {
    const { agent } = makeAgent('coexist-always', { provider: 'mock', model: 'gpt-4o' })
    installLlmRetryStub(ctx)
    apply(ctx, cfg({ chains: [chainOf(['other/gpt-4o'])] }))

    const action = await dispatchRequestError(ctx, agent, {
      failure: { message: 'busy', code: 'SERVER' },
      retryPolicy: alwaysPolicy(),
    })

    expect(action).toEqual({ kind: 'retry' })
    expect(llmRetryEvents(agent)).toHaveLength(1)
    expect(llmRetryEvents(agent)[0]?.data.mode).toBe('always')
    expect(stateStore(ctx)?.size).toBe(0)
  })
})

describe('a retry re-enters the walk, which resumes past the cooled head', () => {
  it('advances one candidate per re-entry instead of pinning the failing route', async () => {
    new LlmRuntime(ctx)
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['a', 'b', 'c'], adapter)
    const states = new FallbackStateStore()
    // The chain under test rides a slot row so the all-day tail stays
    // conforming (the picker row's documented gate).
    const config = cfg({
      chains: [{
        id: CHAIN_ID,
        label: CHAIN_ID,
        entries: ['deepseek-official/deepseek-flash'],
        // The chain under test rides a slot row so its all-day tail stays
        // conforming (the per-chain gate).
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['a/down', 'b/down', 'c/ok'] }],
      }],
    })
    const deps = walkDeps({ readConfig: () => config, getLlm: () => ctx.llm, states })
    const options = { provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [], sessionId: SessionId('s1') }

    // Walk 1: both failing heads are walked once, then the healthy route answers.
    await collect(walkChain(deps, options))
    expect(adapter.calls.map((call) => `${call.provider}/${call.model}`)).toEqual(['a/down', 'b/down', 'c/ok'])
    expect(states.peek('s1')?.cooldown.peek('a/down')).toBeTypeOf('number')
    expect(states.peek('s1')?.cooldown.peek('b/down')).toBeTypeOf('number')

    // The retry re-enters: the cooled heads are skipped, so the walk resumes
    // at the next surviving candidate instead of re-pinning `a/down`.
    adapter.calls.length = 0
    await collect(walkChain(deps, options))
    expect(adapter.calls.map((call) => `${call.provider}/${call.model}`)).toEqual(['c/ok'])
  })
})

/** Drain a chunk stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
