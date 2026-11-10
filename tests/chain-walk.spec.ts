/**
 * Chain walk (named virtual chains, plan named-virtual-chains T2): the
 * committed rule, candidate order and filters, the effort rule,
 * exactly-one-terminal-finish, chain exhaustion, the pre-attempt throws
 * (UNKNOWN_CHAIN / EMPTY_EFFECTIVE_CHAIN / UNDISPATCHABLE_EFFECTIVE_HEAD /
 * LLM_UNAVAILABLE), the recursion guard, the per-(agent, chain) 分时切换
 * rotation log and the attempt-level success observation. Role/origin splits
 * and the host-policy allowlist branches are DELETED with the two-block
 * model — one walk is one named chain.
 *
 * Drives `walkChain` against the REAL `LlmRuntime` with one scripted adapter,
 * so attempts compose with the runtime's own failure normalization
 * (`adapterStream` turns an adapter throw into a terminal `finish` chunk) —
 * the exact shape the walk sees in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  LlmRuntime,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { FallbackStateStore } from '../src/state.ts'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_EFFECTIVE_CHAIN_CODE,
  LLM_UNAVAILABLE_CODE,
  UNKNOWN_CHAIN_CODE,
  UNDISPATCHABLE_HEAD_CODE,
  walkChain,
  type ChainWalkDeps,
} from '../src/chain-walk.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import { FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { cfg, walkDeps } from './support/harness.ts'

const TEXT: StreamChunk = { type: 'text-delta', index: 0, text: 'ok' }
const STOP: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const USAGE: StreamChunk = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
const TOOL_START: StreamChunk = { type: 'block-start', index: 0, blockType: 'tool-call' }

/** One scripted attempt: the chunks it emits, then either a throw or a clean end. */
interface ScriptedAttempt {
  chunks?: StreamChunk[]
  /** The attempt ends by throwing; the runtime normalizes it into a `finish` chunk. */
  failure?: { code: string; message?: string }
  /** Runs when the attempt's stream closes — drained OR closed early by the consumer. */
  onClose?: () => void
}

/** Scripted adapter for every route the scenarios use — records each dispatch. */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  /** Advisory catalog per provider (the wildcard / context-window probes read it). */
  catalog: (provider: string) => Array<{ id: string; contextWindow?: number }> = () => []
  /** Disclosed reasoning efforts per route; `undefined` advertises no reasoning support. */
  efforts: (provider: string, model: string) => readonly { id: string; name: string }[] | undefined
    = () => undefined
  /** Disclosed per-request output cap per route (parameter adaptation drops an above-cap request). */
  outputCap: (provider: string, model: string) => number | undefined = () => undefined
  /**
   * Disclosed context window per route. The walk's probe reads this through
   * `resolveModelInfo` — the runtime REBUILDS `listModels` rows from a known
   * field set, so a catalog-row window never survives that boundary.
   */
  windows: (provider: string, model: string) => number | undefined = () => undefined
  respond: (options: GenerateOptions, attempt: number) => ScriptedAttempt = () => ({ chunks: [TEXT, STOP] })

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // `contextWindow` is a host-disclosed extra the structural probe reads
    // (`LlmModelInfo` itself does not type it).
    return Promise.resolve(this.catalog(provider).map((row) => ({ provider, name: row.id, ...row })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const window = this.windows(provider, model)
    const efforts = this.efforts(provider, model)
    const defaultMaxTokens = this.outputCap(provider, model)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(window === undefined ? {} : { context: { contextWindow: window } }),
      ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
      ...(efforts === undefined ? {} : { reasoning: { efforts } }),
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const attempt = this.respond(options, this.calls.length - 1)
    try {
      for (const chunk of attempt.chunks ?? []) yield chunk
      if (attempt.failure !== undefined) throw new LlmError(attempt.failure.message ?? attempt.failure.code, attempt.failure.code)
    } finally {
      attempt.onClose?.()
    }
  }
}

let ctx: Context
let adapter: ScriptedAdapter

const ROUTES = ['a', 'b', 'c', 'w', 'other']

beforeEach(() => {
  ctx = new Context()
  new LlmRuntime(ctx)
  adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(ROUTES, adapter)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** A frozen config reader for one scenario. */
function config(overrides: Partial<FallbacksConfig>): () => FallbacksConfig {
  const value = cfg(overrides)
  return () => value
}

/** The chain id every scenario selects (the model id on the wire). */
const CHAIN_ID = 'Auto'

/** The other chain id (a second named chain in the same config). */
const OTHER_CHAIN_ID = 'night'

/** The three windows that tile a whole day (`end` exclusive; `23:59` wraps to `00:00`). */
const FULL_DAY_WINDOWS = [
  { start: '00:00', end: '12:00' },
  { start: '12:00', end: '23:59' },
  { start: '23:59', end: '00:00' },
] as const

/**
 * A scenario config reader: the chain UNDER TEST rides full-day slot rows
 * while its all-day `entries` keep a conforming tail. A walk is refused when
 * the entries tail is not official (the picker row's documented conformance
 * gate), and slot rows are how a real session carries an arbitrary chain
 * under that rule. The windows tile the whole day, so the effective chain is
 * the same chain at any wall clock.
 */
function chainCfg(entries: readonly string[], overrides: Partial<FallbacksConfig> = {}): () => FallbacksConfig {
  const rows = FULL_DAY_WINDOWS.map(({ start, end }) => ({ kind: 'custom' as const, start, end, chain: [...entries] }))
  return config({
    ...overrides,
    chains: [{ id: CHAIN_ID, label: 'Test', entries: [OFFICIAL_FLASH], timeSlots: rows }],
  })
}

/** A config with TWO named chains, each carrying its own full-day slot rows. */
function twoChainCfg(
  first: readonly string[],
  second: readonly string[],
  overrides: Partial<FallbacksConfig> = {},
): () => FallbacksConfig {
  const rows = (entries: readonly string[]) =>
    FULL_DAY_WINDOWS.map(({ start, end }) => ({ kind: 'custom' as const, start, end, chain: [...entries] }))
  return config({
    ...overrides,
    chains: [
      { id: CHAIN_ID, label: 'Test', entries: [OFFICIAL_FLASH], timeSlots: rows(first) },
      { id: OTHER_CHAIN_ID, label: 'Night', entries: [OFFICIAL_FLASH], timeSlots: rows(second) },
    ],
  })
}

/** Drain a chunk stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Walk one virtual call; returns the emitted chunks. */
function walk(
  deps: Partial<ChainWalkDeps>,
  options: Partial<GenerateOptions> = {},
): Promise<StreamChunk[]> {
  const bundle = walkDeps({ getLlm: () => ctx.llm, ...deps })
  return collect(walkChain(bundle, {
    provider: FALLBACKS_PROVIDER,
    model: CHAIN_ID,
    messages: [],
    ...options,
  }))
}

/** The `provider/model` pairs the walk dispatched, in order. */
function dispatched(): string[] {
  return adapter.calls.map((call) => `${call.provider}/${call.model}`)
}

/** Run `fn` and report the `LlmError` code it threw (synchronously). */
function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  }
}

/** Count terminal chunks in one walk's output. */
function finishes(chunks: StreamChunk[]): StreamChunk[] {
  return chunks.filter((chunk) => chunk.type === 'finish')
}

describe('committed rule (design §3.1/§6.1.4)', () => {
  it('switches silently after a pre-output trigger failure', async () => {
    adapter.respond = (options) => options.model === '1'
      ? { failure: { code: 'AUTH', message: 'head down' } }
      : { chunks: [TEXT, STOP] }

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    // The swallowed attempt contributes nothing — not even its finish.
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('advances after a usage chunk when the trigger failure follows it', async () => {
    // Adaptors emit usage BEFORE the terminal finish: 0-token usage is
    // metadata, so it must not commit the attempt (plan 2026-11-07 T1).
    adapter.respond = (options) => options.model === '1'
      ? { chunks: [USAGE], failure: { code: 'QUOTA', message: 'quota' } }
      : { chunks: [TEXT, STOP] }

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(chunks).toEqual([USAGE, TEXT, STOP])
  })

  it('still forwards a failure after real output that follows a usage chunk', async () => {
    adapter.respond = () => ({ chunks: [USAGE, TEXT], failure: { code: 'AUTH', message: 'head down' } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1'])
    expect(chunks.slice(0, 2)).toEqual([USAGE, TEXT])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH', message: 'head down' } },
    })
  })

  it('does not un-commit an attempt whose usage chunk follows real output (QC F1)', async () => {
    // The flag LATCHES: `text-delta` → `usage` → trigger failure must keep the
    // attempt committed, or the second candidate's output would be concatenated
    // behind output the consumer already received.
    adapter.respond = () => ({ chunks: [TEXT, USAGE], failure: { code: 'AUTH', message: 'after output' } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1'])
    expect(chunks.slice(0, 2)).toEqual([TEXT, USAGE])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH', message: 'after output' } },
    })
  })

  it('commits a tool-call block start, so the failure is forwarded (QC2 option b)', async () => {
    // A switch here would pour the next candidate's deltas into this attempt's
    // opened tool-call partial, which assembly then drops — so a block start
    // counts as output, exactly as on `main`.
    adapter.respond = (options) => options.model === '1'
      ? { chunks: [TOOL_START], failure: { code: 'AUTH', message: 'head down' } }
      : { chunks: [TEXT, STOP] }

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1'])
    expect(chunks.slice(0, 1)).toEqual([TOOL_START])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH', message: 'head down' } },
    })
  })

  it('forwards a post-output failure verbatim and never starts another attempt', async () => {
    adapter.respond = () => ({
      chunks: [TEXT],
      failure: { code: 'AUTH', message: 'head down' },
    })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1'])
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual(TEXT)
    expect(chunks[1]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH', message: 'head down' } },
    })
  })

  it('forwards a non-trigger failure instead of switching', async () => {
    adapter.respond = () => ({ failure: { code: 'TRANSPORT', message: 'socket' } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(chunks)).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
  })

  it('emits exactly one terminal finish across a switched walk', async () => {
    adapter.respond = (options) => options.model === '1'
      ? { failure: { code: 'AUTH' } }
      : { chunks: [TEXT, STOP] }

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(finishes(chunks)).toEqual([STOP])
  })

  it('closes the attempt stream when the consumer cancels mid-stream', async () => {
    let closed = false
    adapter.respond = () => ({ chunks: [TEXT, TEXT, TEXT], onClose: () => { closed = true } })
    const stream = walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: chainCfg(['a/1', 'b/2']) }),
      { provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] },
    )[Symbol.asyncIterator]()

    expect(await stream.next()).toEqual({ done: false, value: TEXT })
    await stream.return?.()

    // The walk's own `for await` closes the inner `llm.stream` at the yield, so
    // the adapter's iterator runs its finally with two chunks still unread —
    // and the cancelled attempt is not retried on another route.
    expect(closed).toBe(true)
    expect(dispatched()).toEqual(['a/1'])
  })
})

describe('candidate order and filters (design §3.1 step 2)', () => {
  it('caps the walk at maxSwitchesPerStep switches (attempts ≤ cap + 1)', async () => {
    adapter.respond = (options) => ({ failure: { code: 'AUTH', message: `${options.model} down` } })

    const chunks = await walk({
      readConfig: chainCfg(['a/1', 'b/2', 'c/3'], { maxSwitchesPerStep: 1 }),
    })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(finishes(chunks)).toHaveLength(1)
    // The LAST attempt's failure is the one re-emitted.
    expect(chunks.at(-1)).toMatchObject({ reason: { failure: { message: '2 down' } } })
  })

  it('skips a cooled candidate and the route that already failed in this walk', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH', message: 'down' } })
    const states = new FallbackStateStore()
    states.suppress(states.get('s1'), 'b/2', Date.now() + 60_000)

    await walk({
      readConfig: chainCfg(['a/1', 'b/2', 'b/2', 'c/3']),
      states,
    }, { sessionId: SessionId('s1') })

    // b/2 is cooled → never dispatched; c/3 fails and is not revisited.
    expect(dispatched()).toEqual(['a/1', 'c/3'])
  })

  it('starts past a cooled head on a re-entry (cross-call memory)', async () => {
    const states = new FallbackStateStore()
    states.suppress(states.get('s1'), 'a/1', Date.now() + 60_000)

    await walk({
      readConfig: chainCfg(['a/1', 'b/2']),
      states,
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['b/2'])
  })

  it('filters candidates by context window for a CONTEXT_WINDOW_EXCEEDED trigger', async () => {
    adapter.respond = (options) => options.model === '1'
      ? { failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'too big' } }
      : { failure: { code: 'AUTH' } }
    adapter.windows = () => 1_000

    const skipped = await walk({
      readConfig: chainCfg(['a/1', 'b/2'], { triggerCodes: [CONTEXT_WINDOW_EXCEEDED_CODE] }),
    })
    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(skipped)).toHaveLength(1)

    adapter.calls.length = 0
    adapter.windows = (provider) => (provider === 'b' ? 5_000 : 1_000)
    await walk({
      readConfig: chainCfg(['a/1', 'b/2'], { triggerCodes: [CONTEXT_WINDOW_EXCEEDED_CODE] }),
    })
    // A larger window survives the filter.
    expect(dispatched()).toEqual(['a/1', 'b/2'])
  })

  it('probes the catalog before dispatching a wildcard candidate', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })
    adapter.catalog = (provider) => (provider === 'w' ? [{ id: '9' }] : [{ id: '1' }, { id: '2' }])

    await walk({ readConfig: chainCfg(['a/1', 'w/*']) })

    // `w/*` resolves against the head's model id (1), which w does not list.
    expect(dispatched()).toEqual(['a/1'])

    adapter.calls.length = 0
    adapter.catalog = (provider) => (provider === 'w' ? [{ id: '1' }] : [{ id: '1' }])
    await walk({ readConfig: chainCfg(['a/1', 'w/*']) })
    expect(dispatched()).toEqual(['a/1', 'w/1'])
  })

})

describe('effort rule (design §3.2)', () => {
  it('keeps an explicit selection effort on every attempt', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(adapter.calls.map((call) => call.reasoningEffort)).toEqual(['high', 'high'])
  })

  it('drops the effort entirely when the selection carries none', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(adapter.calls.map((call) => 'reasoningEffort' in call)).toEqual([false, false])
  })
})

describe('pinned effort on chain entries (selector @effort)', () => {
  it('overrides the caller\'s effort on the entry\'s own hop', async () => {
    adapter.efforts = () => [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1@low', 'b/2@high']) },
      { reasoningEffort: 'max' as GenerateOptions['reasoningEffort'] },
    )

    // `max` is not disclosed anywhere: an ignored pin would be dropped and the
    // hop would carry no effort at all.
    expect(adapter.calls.map((call) => call.reasoningEffort)).toEqual(['low', 'high'])
    // The suffix is a request control, never part of the route.
    expect(dispatched()).toEqual(['a/1', 'b/2'])
  })

  it('drops a pinned effort the route does not list instead of the caller\'s', async () => {
    // `a/1` lists only `low`, so its `@high` pin is dropped — and the dropped
    // pin must not fall back to the caller's own `low` (a pin REPLACES the
    // selection for that hop, it is not a preference).
    adapter.efforts = () => [{ id: 'low', name: 'Low' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1@high', 'b/2@low']) },
      { reasoningEffort: 'low' as GenerateOptions['reasoningEffort'] },
    )

    expect('reasoningEffort' in adapter.calls[0]!).toBe(false)
    expect(adapter.calls[1]!.reasoningEffort).toBe('low')
  })

  it('names the pinned effort in the switch log (a/b and a/b@high are not the same attempt)', async () => {
    const info = vi.fn()
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1@low', 'b/2@high']), log: { info, warn: () => {} } },
    )

    const switchLine = info.mock.calls.find(call => String(call[0]).includes('fallback switch'))
    expect(switchLine).toBeDefined()
    // The candidates ride as the last argument (the `%o` slot).
    const candidates = switchLine!.at(-1) as string[]
    expect(candidates).toContain('a/1@low (skipped: same-as-current)')
    expect(candidates).toContain('b/2@high')
  })

  it('does not leak a pin to the next entry that carries none', async () => {
    adapter.efforts = () => [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1@low', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(adapter.calls.map((call) => call.reasoningEffort)).toEqual(['low', 'high'])
  })
})

describe('per-target parameter adaptation (plan 2026-11-07 T2)', () => {
  it('drops an inherited effort the next candidate does not list', async () => {
    adapter.efforts = (_provider, model) => (model === '1'
      ? [{ id: 'high', name: 'High' }]
      : [{ id: 'low', name: 'Low' }])
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(adapter.calls.map((call) => call.reasoningEffort)).toEqual(['high', undefined])
    // Absent, not `undefined`: the runtime would reject an unsupported effort.
    expect('reasoningEffort' in adapter.calls[1]!).toBe(false)
  })

  it('treats an undisclosed reasoning capability as UNKNOWN, not as "supports none"', async () => {
    // The proactive layer must NOT drop on a route whose metadata omits
    // `reasoning` — that is unknown, and unknown keeps the request
    // byte-for-byte (the same rule the maxTokens branch follows for an
    // undisclosed cap). This test therefore pins the ABSENCE of a proactive
    // adaptation; what happens at the adapter boundary is the peer runtime's
    // business, not this layer's.
    const debug = vi.fn()
    adapter.efforts = () => undefined
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1', 'b/2']), log: { info: () => {}, warn: () => {}, debug } },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    // The discriminating assertion: the walk logged no drop of its own.
    expect(debug.mock.calls.filter((call) => String(call[0]).includes('parameter adaptation'))).toEqual([])
    // Observation only (NOT a contract of this layer): `@deepseek-ai/dsh-llm`
    // normalizes an effort the route never disclosed before it reaches
    // `adapter.stream`, so the adapter never sees the control.
    expect(adapter.calls.map((call) => 'reasoningEffort' in call)).toEqual([false, false])
  })

  it('drops a maxTokens above the candidate disclosed cap', async () => {
    adapter.outputCap = (_provider, model) => (model === '2' ? 1000 : 4000)
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk({ readConfig: chainCfg(['a/1', 'b/2']) }, { maxTokens: 2000 })

    // a/1's cap fits, so the inherited 2000 rides; b/2 (cap 1000) drops it and
    // the runtime materializes THAT route's default instead.
    expect(adapter.calls.map((call) => call.maxTokens)).toEqual([2000, 1000])
  })

  it('keeps both controls when the candidate lists the effort and fits the cap', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.outputCap = () => 4000
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: chainCfg(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'], maxTokens: 2000 },
    )

    expect(adapter.calls.map((call) => [call.reasoningEffort, call.maxTokens])).toEqual([
      ['high', 2000],
      ['high', 2000],
    ])
  })

  it('keeps the inherited controls when the capability probe throws', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const runtime = ctx.llm
    const flaky = {
      stream: (options: GenerateOptions) => runtime.stream(options),
      resolveModelInfo: () => Promise.reject(new Error('probe down')),
    } as unknown as LlmRuntime

    await walk(
      { readConfig: chainCfg(['a/1', 'b/2']), getLlm: () => flaky },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'], maxTokens: 2000 },
    )

    // Fail open: an unreadable probe rewrites nothing.
    expect(adapter.calls.map((call) => [call.reasoningEffort, call.maxTokens])).toEqual([
      ['high', 2000],
      ['high', 2000],
    ])
  })

  it('keeps the inherited controls when the host exposes no capability probe', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const streamOnly = {
      stream: (options: GenerateOptions) => ctx.llm.stream(options),
    } as unknown as LlmRuntime

    await walk(
      { readConfig: chainCfg(['a/1', 'b/2']), getLlm: () => streamOnly },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'], maxTokens: 2000 },
    )

    expect(adapter.calls.map((call) => [call.reasoningEffort, call.maxTokens])).toEqual([
      ['high', 2000],
      ['high', 2000],
    ])
  })

  it('logs the proactive drop at debug level (QC F3)', async () => {
    const debug = vi.fn()
    adapter.efforts = () => [{ id: 'low', name: 'Low' }]

    await walk(
      { readConfig: chainCfg(['a/1']), log: { info: () => {}, warn: () => {}, debug } },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('parameter adaptation'), 'a', '1', 'reasoningEffort')
  })

  it('applies the drop when the debug sink throws (I-000118)', async () => {
    // A logger fault is a sink fault, not an adaptation fault: the request must
    // still go out with the above-cap control dropped. `maxTokens` is used
    // because the runtime does NOT reject an over-cap value on its own (an
    // unsupported effort is normalized by the runtime and would mask the bug).
    adapter.outputCap = () => 1000

    await walk(
      {
        readConfig: chainCfg(['a/1']),
        log: {
          info: () => {},
          warn: () => {},
          debug: () => {
            throw new Error('sink down')
          },
        },
      },
      { maxTokens: 4000 },
    )

    expect(dispatched()).toEqual(['a/1'])
    // The drop reached dispatch: the runtime materialized the route's own
    // default budget instead of the inherited 4000.
    expect(adapter.calls[0]!.maxTokens).toBe(1000)
  })
})

describe('reactive parameter repair (plan 2026-11-07 T2 / AC-7)', () => {
  it('repairs a max_tokens rejection by retrying the SAME candidate without maxTokens', async () => {
    // The observed zai-coding-cn shape: the route discloses no defaultMaxTokens,
    // so proactive adaptation cannot see the cap and the provider 400s instead.
    adapter.respond = (options) => (options.maxTokens === undefined
      ? { chunks: [TEXT, STOP] }
      : { failure: { code: 'INVALID_REQUEST', message: 'max_tokens参数非法：限制数值范围[1,131072]' } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) }, { maxTokens: 384_000 })

    expect(dispatched()).toEqual(['a/1', 'a/1'])
    expect(adapter.calls.map((call) => call.maxTokens)).toEqual([384_000, undefined])
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('suppresses the rejected attempt usage before a repair (I-000120)', async () => {
    // The rejected request's usage describes a request that 400ed, so it is not
    // yielded: exactly one usage chunk belongs to this logical attempt, and it
    // is the repaired attempt's own (inputTokens 0 here).
    const rejectedUsage: StreamChunk = { type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } }
    adapter.respond = (options) => (options.maxTokens === undefined
      ? { chunks: [USAGE, TEXT, STOP] }
      : { chunks: [rejectedUsage], failure: { code: 'INVALID_REQUEST', message: 'max_tokens参数非法：限制数值范围[1,131072]' } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) }, { maxTokens: 384_000 })

    expect(dispatched()).toEqual(['a/1', 'a/1'])
    expect(chunks).toEqual([USAGE, TEXT, STOP])
  })

  it('repairs UNSUPPORTED_REASONING_EFFORT by retrying the SAME candidate without the effort', async () => {
    // The probe lists `high` (so the proactive drop keeps it) but the adapter
    // rejects it anyway — only its own rejection exposes the real set.
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.reasoningEffort === undefined
      ? { chunks: [TEXT, STOP] }
      : { failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no such effort' } })

    const chunks = await walk(
      { readConfig: chainCfg(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(dispatched()).toEqual(['a/1', 'a/1'])
    expect('reasoningEffort' in adapter.calls[1]!).toBe(false)
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('forwards a second identical rejection instead of repairing it again', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = () => ({ failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'still no' } })

    const chunks = await walk(
      { readConfig: chainCfg(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    // One repair, never a loop: the second attempt carried no effort to drop.
    expect(adapter.calls).toHaveLength(2)
    expect(finishes(chunks)).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ reason: { failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } })
  })

  it('does not repair an INVALID_REQUEST that merely mentions max_tokens', async () => {
    // Narrowing (operator concern): prose about the parameter is not a range
    // rejection, so the failure is forwarded instead of guessed at.
    adapter.respond = () => ({ failure: { code: 'INVALID_REQUEST', message: 'prompt exceeds max_tokens budget' } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) }, { maxTokens: 384_000 })

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]!.maxTokens).toBe(384_000)
    expect(chunks.at(-1)).toMatchObject({ reason: { failure: { code: 'INVALID_REQUEST' } } })
  })

  it('books no cooldown for a repaired candidate', async () => {
    const states = new FallbackStateStore()
    adapter.respond = (options) => (options.maxTokens === undefined
      ? { chunks: [STOP] }
      : { failure: { code: 'INVALID_REQUEST', message: 'max_tokens out of range' } })
    const deps = { readConfig: chainCfg(['a/1', 'b/2']), states }

    await walk(deps, { maxTokens: 384_000, sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1', 'a/1'])

    // The repair is a request fix, not a chain switch: the head is attempted
    // again on the next walk instead of being skipped as cooled.
    await walk(deps, { maxTokens: 384_000, sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1', 'a/1', 'a/1', 'a/1'])
  })
})

describe('terminal behavior (design §3.1 step 4, §6.1.1/§6.1.3)', () => {
  it('re-emits the last terminal error finish when the chain is exhausted', async () => {
    adapter.respond = (options) => ({ failure: { code: 'AUTH', message: `${options.model} down` } })

    const chunks = await walk({ readConfig: chainCfg(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(finishes(chunks)).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH', message: '2 down' } },
    })
  })

  it('throws EMPTY_EFFECTIVE_CHAIN before any chunk or dispatch', () => {
    expect(thrownCode(() => walkChain(walkDeps({
      getLlm: () => ctx.llm,
      readConfig: config({ chains: [{ id: CHAIN_ID, label: 'T', entries: [], timeSlots: [] }] }),
    }), {
      provider: FALLBACKS_PROVIDER,
      model: CHAIN_ID,
      messages: [],
    }))).toBe(EMPTY_EFFECTIVE_CHAIN_CODE)
    expect(adapter.calls).toHaveLength(0)
  })

  it('throws UNDISPATCHABLE_EFFECTIVE_HEAD for a wildcard-only or self-route chain', () => {
    const options = { provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] }
    /** Conforming entries + full-day slot rows carrying the broken chain. */
    const carried = (entries: readonly string[]) => config({
      chains: [{
        id: CHAIN_ID,
        label: 'T',
        entries: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom' as const, start: '00:00', end: '23:59', chain: [...entries] }],
      }],
    })
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: carried(['a/*']) }),
      options,
    ))).toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: carried([`${FALLBACKS_PROVIDER}/${CHAIN_ID}`]) }),
      options,
    ))).toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(adapter.calls).toHaveLength(0)
  })

  it('throws LLM_UNAVAILABLE when the runtime is gone', () => {
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => undefined, readConfig: chainCfg(['a/1']) }),
      { provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] },
    ))).toBe(LLM_UNAVAILABLE_CODE)
  })

  it('forwards an aborted finish and starts no further attempt', async () => {
    adapter.respond = () => ({ failure: { code: 'ABORTED', message: 'aborted' } })
    const controller = new AbortController()
    controller.abort()

    const chunks = await walk(
      { readConfig: chainCfg(['a/1', 'b/2']) },
      { signal: controller.signal },
    )

    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(chunks)).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'aborted' } })
  })
})

describe('recursion guard (design §6.1.2)', () => {
  it('never dispatches a chain entry under FallbacksChain/*', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })

    await walk({
      readConfig: chainCfg(['a/1', `${FALLBACKS_PROVIDER}/${CHAIN_ID}`, 'b/2']),
    })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(adapter.calls.every((call) => call.provider !== FALLBACKS_PROVIDER)).toBe(true)
  })
})

describe('P7 分时切换 rotation log (per (agent, chain) marker)', () => {
  /** Two half-day rows: 00:00–12:00 and the wrap-around 12:00–00:00. */
  const halfDay = cfg({
    chains: [{
      id: CHAIN_ID,
      label: 'Test',
      entries: [OFFICIAL_FLASH],
      timeSlots: [
        { kind: 'custom', start: '00:00', end: '12:00', chain: ['a/1'] },
        { kind: 'custom', start: '12:00', end: '00:00', chain: ['b/2'] },
      ],
    }],
  })

  function at(iso: string): void {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs a time-slot switch when the winner changes since the agent’s last walk on that chain', async () => {
    const markers = new Map<string, { key: string; label: string }>()
    const info = vi.fn()
    const deps = { readConfig: () => halfDay, slotWinners: markers, log: { info, warn: () => {} } }

    at('2026-08-18T02:00:00Z') // 10:00 Asia/Shanghai → the 00:00–12:00 row
    await walk(deps, { sessionId: SessionId('s1') })
    expect(markers.get(`s1\u0000${CHAIN_ID}`)?.key).toBe('custom:00:00-12:00')
    expect(info.mock.calls.filter((call) => String(call[0]).includes('分时切换'))).toHaveLength(0)

    at('2026-08-18T06:00:00Z') // 14:00 Asia/Shanghai → the wrap-around row
    await walk(deps, { sessionId: SessionId('s1') })
    const switches = info.mock.calls.filter((call) => String(call[0]).includes('分时切换'))
    expect(switches).toHaveLength(1)
    expect(switches[0]?.slice(2)).toEqual([CHAIN_ID, 'custom 00:00-12:00', 'custom 12:00-00:00'])
    expect(markers.get(`s1\u0000${CHAIN_ID}`)?.key).toBe('custom:12:00-00:00')
  })

  it('two chains in one session never share the marker', async () => {
    // Each chain carries its own full-day rows with DIFFERENT winners' labels,
    // so a shared marker would corrupt one chain's rotation log.
    const day = cfg({
      chains: [
        {
          id: CHAIN_ID,
          label: 'A',
          entries: [OFFICIAL_FLASH],
          timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['a/1'] }],
        },
        {
          id: OTHER_CHAIN_ID,
          label: 'B',
          entries: [OFFICIAL_FLASH],
          timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['b/2'] }],
        },
      ],
    })
    const markers = new Map<string, { key: string; label: string }>()
    const deps = { readConfig: () => day, slotWinners: markers, log: { info: () => {}, warn: () => {} } }

    at('2026-08-18T02:00:00Z') // 10:00 Asia/Shanghai — inside the row
    await walk(deps, { sessionId: SessionId('s1') })
    await walk(deps, { model: OTHER_CHAIN_ID, sessionId: SessionId('s1') })

    expect(markers.get(`s1\u0000${CHAIN_ID}`)?.key).toBe('custom:00:00-23:59')
    expect(markers.get(`s1\u0000${OTHER_CHAIN_ID}`)?.key).toBe('custom:00:00-23:59')
    expect(markers.size).toBe(2)
  })

  it('a slot row edit on ONE chain does not flip the other chain’s marker', async () => {
    const configA = cfg({
      chains: [
        { id: CHAIN_ID, label: 'A', entries: [OFFICIAL_FLASH], timeSlots: [{ kind: 'custom', start: '00:00', end: '00:00', chain: ['a/1'] }] },
        { id: OTHER_CHAIN_ID, label: 'B', entries: [OFFICIAL_FLASH], timeSlots: [] },
      ],
    })
    const markers = new Map<string, { key: string; label: string }>()
    const deps = { readConfig: () => configA, slotWinners: markers, log: { info: () => {}, warn: () => {} } }
    await walk(deps, { sessionId: SessionId('s1') })
    await walk(deps, { model: OTHER_CHAIN_ID, sessionId: SessionId('s1') })
    // The chain without slot rows writes no marker at all.
    expect(markers.size).toBe(1)
  })
})

describe('chain selection (options.model IS the chain id)', () => {
  it('throws UNKNOWN_CHAIN synchronously for an unknown chain id', () => {
    adapter.respond = () => ({ chunks: [STOP] })
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: chainCfg(['a/1']) }),
      { provider: FALLBACKS_PROVIDER, model: 'deleted-chain', messages: [] },
    ))).toBe(UNKNOWN_CHAIN_CODE)
    expect(adapter.calls).toHaveLength(0)
  })

  it('throws UNKNOWN_CHAIN for a chain deleted while the session still selects it', () => {
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: config({ chains: [] }) }),
      { provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] },
    ))).toBe(UNKNOWN_CHAIN_CODE)
    expect(adapter.calls).toHaveLength(0)
  })

  it('walks the SELECTED chain, not another configured chain', async () => {
    adapter.respond = () => ({ chunks: [TEXT, STOP] })
    await walk(
      { readConfig: twoChainCfg(['a/1'], ['b/2']) },
      { sessionId: SessionId('s1') },
    )
    expect(dispatched()).toEqual(['a/1'])
    adapter.calls.length = 0
    await walk(
      { readConfig: twoChainCfg(['a/1'], ['b/2']) },
      { model: OTHER_CHAIN_ID, sessionId: SessionId('s1') },
    )
    expect(dispatched()).toEqual(['b/2'])
  })

  it('per-agent cooldown survives a chain switch: a route cooling down on chain A is not retried on chain B', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const states = new FallbackStateStore()

    // Chain A: a/1 fails and is cooled down.
    await walk({ readConfig: twoChainCfg(['a/1', 'c/3'], ['b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1', 'c/3'])

    // Chain B: the SAME route a/1 stays cooled — route health is a property of
    // the route, not of the chain — so chain B starts past it at b/2.
    adapter.calls.length = 0
    await walk(
      { readConfig: twoChainCfg(['a/1', 'c/3'], ['a/1', 'b/2']), states },
      { model: OTHER_CHAIN_ID, sessionId: SessionId('s1') },
    )
    expect(dispatched()).toEqual(['b/2'])
  })
})

describe('bookkeeping (design §3.3)', () => {
  it('cools a route-scoped failure and skips it on the next walk', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const states = new FallbackStateStore()

    await walk({ readConfig: chainCfg(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(states.peek('s1')?.cooldown.peek('a/1')).toBeTypeOf('number')

    adapter.calls.length = 0
    await walk({ readConfig: chainCfg(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    // The cooled head is skipped: the second walk resumes at the next candidate.
    expect(dispatched()).toEqual(['b/2'])
  })

  it('writes no cooldown for a request-scoped failure', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE } } : { chunks: [STOP] })
    const states = new FallbackStateStore()

    await walk({
      readConfig: chainCfg(['a/1', 'b/2'], { triggerCodes: [CONTEXT_WINDOW_EXCEEDED_CODE] }),
      states,
    }, { sessionId: SessionId('s1') })

    expect(states.peek('s1')?.cooldown.peek('a/1')).toBeUndefined()
  })

  it('cools a head that failed after output, so the next walk resumes past it', async () => {
    adapter.respond = (options) => options.model === '1'
      ? { chunks: [TEXT], failure: { code: 'AUTH', message: 'head down' } }
      : { chunks: [STOP] }
    const states = new FallbackStateStore()

    // The failure is forwarded verbatim and never replayed inside this walk…
    const first = await walk({ readConfig: chainCfg(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(first)).toHaveLength(1)

    // …and the dead head is no longer healthy for the NEXT walk.
    adapter.calls.length = 0
    await walk({ readConfig: chainCfg(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['b/2'])
  })

  it('observes success before the terminal finish is delivered', async () => {
    const states = new FallbackStateStore()
    const state = states.get('s1')
    state.recovery.markHalfOpen('a/1', Date.now())

    // The valid consumer pattern: stop AT the finish, never ask the iterator for
    // another result — which closes the generator at that `yield`.
    for await (const chunk of walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: chainCfg(['a/1']), states }),
      { provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [], sessionId: SessionId('s1') },
    )) {
      if (chunk.type === 'finish') break
    }

    expect(state.recovery.isHalfOpen('a/1')).toBe(false)
  })

  it('closes a half-open episode on attempt-level success', async () => {
    const states = new FallbackStateStore()
    const state = states.get('s1')
    state.recovery.markHalfOpen('a/1', Date.now())
    expect(state.recovery.isHalfOpen('a/1')).toBe(true)

    await walk({ readConfig: chainCfg(['a/1']), states }, { sessionId: SessionId('s1') })

    expect(state.recovery.isHalfOpen('a/1')).toBe(false)
  })

  it('logs the switch with the annotated candidate order', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const info = vi.fn()

    await walk({
      readConfig: chainCfg(['a/1', 'b/2']),
      log: { info, warn: () => {} },
    })

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('降级切换'),
      expect.anything(),
      'a', '1', 'b', '2',
      expect.anything(), 'trigger-code',
      expect.anything(),
    )
  })
})
