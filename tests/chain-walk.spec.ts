/**
 * Chain walk (design dsh-022-rc1-upgrade §2/§3/§6.1): the committed rule,
 * candidate order and filters, the effort rule, exactly-one-terminal-finish,
 * chain exhaustion, the pre-attempt throws, the recursion guard and the
 * attempt-level success observation.
 *
 * Drives `walkChain` against the REAL `LlmRuntime` with one scripted adapter,
 * so attempts compose with the runtime's own failure normalization
 * (`adapterStream` turns an adapter throw into a terminal `finish` chunk) —
 * the exact shape the walk sees in production.
 *
 * @module tests/chain-walk
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
import type { FallbacksConfig } from '../src/config.ts'
import { FallbackStateStore } from '../src/state.ts'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_EFFECTIVE_CHAIN_CODE,
  LLM_UNAVAILABLE_CODE,
  UNDISPATCHABLE_HEAD_CODE,
  walkChain,
  type AgentChainView,
  type ChainWalkDeps,
} from '../src/chain-walk.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import type { EffectivePolicy } from '../src/subagent-policy.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
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

/** The three windows that tile a whole day (`end` exclusive; `23:59` wraps to `00:00`). */
const FULL_DAY_WINDOWS = [
  { start: '00:00', end: '12:00' },
  { start: '12:00', end: '23:59' },
  { start: '23:59', end: '00:00' },
] as const

/**
 * A ROOT-scenario config reader: the chain UNDER TEST rides full-day slot rows
 * while the all-day `rootChain` keeps a conforming tail. A root walk is refused
 * when the all-day tail is not official (the picker row's documented
 * conformance gate), and slot rows are how a real root session carries an
 * arbitrary chain under that rule. The windows tile the whole day, so the
 * effective chain is the same chain at any wall clock.
 *
 * Subagent scenarios keep {@link config}: a child's tail is the RAW `rootChain`,
 * which the slot rows never touch.
 */
function rootConfig(chain: readonly string[], overrides: Partial<FallbacksConfig> = {}): () => FallbacksConfig {
  return config({
    ...overrides,
    rootChain: [OFFICIAL_FLASH],
    timeSlots: FULL_DAY_WINDOWS.map(({ start, end }) => ({ kind: 'custom' as const, start, end, chain: [...chain] })),
  })
}

/** The `trimmed id → declared raw id` map `apply()` derives from `config.roles.list`. */
const CODER_ROLE_IDS = new Map([['coder', 'coder']])

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
    model: FALLBACKS_CHAIN_MODEL,
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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(chunks).toEqual([USAGE, TEXT, STOP])
  })

  it('still forwards a failure after real output that follows a usage chunk', async () => {
    adapter.respond = () => ({ chunks: [USAGE, TEXT], failure: { code: 'AUTH', message: 'head down' } })

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(chunks)).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
  })

  it('emits exactly one terminal finish across a switched walk', async () => {
    adapter.respond = (options) => options.model === '1'
      ? { failure: { code: 'AUTH' } }
      : { chunks: [TEXT, STOP] }

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

    expect(finishes(chunks)).toEqual([STOP])
  })

  it('closes the attempt stream when the consumer cancels mid-stream', async () => {
    let closed = false
    adapter.respond = () => ({ chunks: [TEXT, TEXT, TEXT], onClose: () => { closed = true } })
    const stream = walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: rootConfig(['a/1', 'b/2']) }),
      { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] },
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
      readConfig: rootConfig(['a/1', 'b/2', 'c/3'], { maxSwitchesPerStep: 1 }),
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
      readConfig: rootConfig(['a/1', 'b/2', 'b/2', 'c/3']),
      states,
    }, { sessionId: SessionId('s1') })

    // b/2 is cooled → never dispatched; c/3 fails and is not revisited.
    expect(dispatched()).toEqual(['a/1', 'c/3'])
  })

  it('starts past a cooled head on a re-entry (cross-call memory)', async () => {
    const states = new FallbackStateStore()
    states.suppress(states.get('s1'), 'a/1', Date.now() + 60_000)

    await walk({
      readConfig: rootConfig(['a/1', 'b/2']),
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
      readConfig: rootConfig(['a/1', 'b/2'], { triggerCodes: [CONTEXT_WINDOW_EXCEEDED_CODE] }),
    })
    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(skipped)).toHaveLength(1)

    adapter.calls.length = 0
    adapter.windows = (provider) => (provider === 'b' ? 5_000 : 1_000)
    await walk({
      readConfig: rootConfig(['a/1', 'b/2'], { triggerCodes: [CONTEXT_WINDOW_EXCEEDED_CODE] }),
    })
    // A larger window survives the filter.
    expect(dispatched()).toEqual(['a/1', 'b/2'])
  })

  it('probes the catalog before dispatching a wildcard candidate', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })
    adapter.catalog = (provider) => (provider === 'w' ? [{ id: '9' }] : [{ id: '1' }, { id: '2' }])

    await walk({ readConfig: rootConfig(['a/1', 'w/*']) })

    // `w/*` resolves against the head's model id (1), which w does not list.
    expect(dispatched()).toEqual(['a/1'])

    adapter.calls.length = 0
    adapter.catalog = (provider) => (provider === 'w' ? [{ id: '1' }] : [{ id: '1' }])
    await walk({ readConfig: rootConfig(['a/1', 'w/*']) })
    expect(dispatched()).toEqual(['a/1', 'w/1'])
  })

  it('starts a seam-injected walk on the first ALLOWLISTED route, never on a rejected head', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })
    const view: AgentChainView = { origin: 'subagent', sessionId: 's1' }
    const roleCfg = {
      roles: { list: [{ id: 'coder', persona: '', chain: ['a/1', 'b/2'], fallback: 'none' as const }], rules: [] },
    }
    const injected = (allowedModels: { provider: string; model: string }[]): Partial<ChainWalkDeps> => ({
      readConfig: config(roleCfg),
      resolveAgentView: () => view,
      seamRecord: () => ({ role: 'coder', virtualRouteInjected: true }),
      roleIds: () => CODER_ROLE_IDS,
      policyFor: () => ({ state: 'enabled', allowedModels }),
    })

    // An allowlist that excludes every chain route: no attempt at all — the
    // first attempt is a plugin-originated route, so the walk refuses.
    const options = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [], sessionId: SessionId('s1') }
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, ...injected([{ provider: 'c', model: '3' }]) }),
      options,
    ))).toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(adapter.calls).toHaveLength(0)

    // A later allowlisted route is where the walk STARTS: the chain head a/1 is
    // never dispatched, and the switch after its failure has nothing legal left.
    const chunks = await walk(injected([{ provider: 'b', model: '2' }]), { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['b/2'])
    expect(finishes(chunks)).toHaveLength(1)
  })

  it('refuses a seam-injected walk whose policy turns unprovable after the mount', async () => {
    adapter.respond = () => ({ chunks: [STOP] })
    // The mount happened under `enabled` (the record carries the injected
    // verdict); the policy then stops proving anything (an unreadable durable
    // event). The chain still has a route, so only the policy can refuse.
    let policy: EffectivePolicy = { state: 'enabled', allowedModels: [{ provider: 'b', model: '2' }] }
    const injected = (): Partial<ChainWalkDeps> => ({
      readConfig: config({
        roles: { list: [{ id: 'coder', persona: '', chain: ['a/1', 'b/2'], fallback: 'none' as const }], rules: [] },
      }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'coder', virtualRouteInjected: true }),
      roleIds: () => CODER_ROLE_IDS,
      policyFor: () => policy,
    })

    await walk(injected(), { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['b/2'])

    policy = { state: 'unprovable' }
    adapter.calls.length = 0
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, ...injected() }),
      { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [], sessionId: SessionId('s1') },
    ))).toBe(UNDISPATCHABLE_HEAD_CODE)
    // Refused BEFORE the attempt: the chain head a/1 is never dispatched.
    expect(adapter.calls).toHaveLength(0)
  })

  it('records the allowlist-blocked switch and ends the walk on the head failure', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })
    const recordBlocked = vi.fn()

    const chunks = await walk({
      readConfig: config({
        roles: { list: [{ id: 'coder', persona: '', chain: ['a/1', 'c/3'], fallback: 'none' as const }], rules: [] },
      }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'coder', virtualRouteInjected: true }),
      roleIds: () => CODER_ROLE_IDS,
      policyFor: () => ({ state: 'enabled', allowedModels: [{ provider: 'a', model: '1' }] }),
      recordBlocked,
    }, { sessionId: SessionId('s1') })

    // The allowlisted head runs; the only survivor is off-list, so the switch
    // is blocked + recorded and the head's own failure is re-emitted.
    expect(dispatched()).toEqual(['a/1'])
    expect(recordBlocked).toHaveBeenCalledWith('s1', { provider: 'c', model: '3' }, 'trigger-code')
    expect(finishes(chunks)).toHaveLength(1)
  })

  it('refuses a cooled-head re-entry the fresh policy no longer admits, before any request', async () => {
    adapter.respond = () => ({ chunks: [STOP] })
    const ALLOWED = [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }]
    /** Policy reads in order: the resolveWalk admission, then the expansion's re-read. */
    let reads: EffectivePolicy[] = []
    const recordBlocked = vi.fn()

    const plan = (): Partial<ChainWalkDeps> => {
      const states = new FallbackStateStore()
      states.suppress(states.get('s1'), 'a/1', Date.now() + 60_000)
      return {
        readConfig: config({
          roles: { list: [{ id: 'coder', persona: '', chain: ['a/1', 'b/2'], fallback: 'none' as const }], rules: [] },
        }),
        resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
        seamRecord: () => ({ role: 'coder', virtualRouteInjected: true }),
        roleIds: () => CODER_ROLE_IDS,
        states,
        policyFor: () => reads.shift() ?? { state: 'disabled' },
        recordBlocked,
      }
    }
    const options = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [], sessionId: SessionId('s1') }
    /** The code a refused walk rejected with (the throw surfaces on the first pull). */
    const refusedWith = async (): Promise<string | undefined> => {
      try {
        await collect(walkChain(walkDeps({ getLlm: () => ctx.llm, ...plan() }), options))
        return undefined
      } catch (error) {
        return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      }
    }

    // The head was admitted under `enabled`; the re-read after the expansion's
    // catalog awaits cannot prove anything, so the walk must not resume at it.
    reads = [{ state: 'enabled', allowedModels: ALLOWED }, { state: 'unprovable' }]
    await expect(refusedWith()).resolves.toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(adapter.calls).toHaveLength(0)

    // The allowlist narrowed to a route the chain does not carry: the cooled
    // head is revoked with nothing legal left to switch to.
    reads = [{ state: 'enabled', allowedModels: ALLOWED }, { state: 'enabled', allowedModels: [{ provider: 'c', model: '3' }] }]
    await expect(refusedWith()).resolves.toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(adapter.calls).toHaveLength(0)

    // Control: a policy that still admits the head resumes at the next
    // candidate — the refusal is the revocation, never "the head was cooled".
    reads = [{ state: 'enabled', allowedModels: ALLOWED }, { state: 'enabled', allowedModels: ALLOWED }]
    await collect(walkChain(walkDeps({ getLlm: () => ctx.llm, ...plan() }), options))
    expect(dispatched()).toEqual(['b/2'])
    // No trigger failure happened on the cooled-head path, so no blocked-switch
    // record may claim one ('trigger-code') for it.
    expect(recordBlocked).not.toHaveBeenCalled()
  })

  it('labels an allowlist-rejected candidate as skipped in the switch log', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const info = vi.fn()

    await walk({
      readConfig: config({
        roles: { list: [{ id: 'coder', persona: '', chain: ['a/1', 'c/3', 'b/2'], fallback: 'none' as const }], rules: [] },
      }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'coder', virtualRouteInjected: true }),
      roleIds: () => CODER_ROLE_IDS,
      policyFor: () => ({ state: 'enabled', allowedModels: [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }] }),
      log: { info, warn: () => {} },
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    const switchLog = info.mock.calls.find((call) => String(call[0]).includes('降级切换'))
    // `c/3` survived every filter and is skipped for the allowlist alone.
    expect(switchLog?.[8]).toEqual([
      'a/1 (skipped: same-as-current)',
      'c/3 (skipped: allowlist)',
      'b/2',
    ])
  })

  it('leaves a non-injected session unfiltered by the allowlist', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk({
      // Raw tail on purpose: a SUBAGENT walk appends the raw `rootChain`.
      readConfig: config({ rootChain: ['a/1', 'b/2'] }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'inherit' }),
      policyFor: () => ({ state: 'enabled', allowedModels: [] }),
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
  })

  it('dispatches a NON-injected walk whose policy reads unprovable (no seam verdict to honour)', async () => {
    adapter.respond = () => ({ chunks: [STOP] })
    const policyFor = vi.fn(() => ({ state: 'unprovable' as const }))

    const chunks = await walk({
      readConfig: config({ rootChain: ['a/1', 'b/2'] }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      // An inherited child was never mounted on the virtual row, so the policy
      // gates nothing: the refusal is the INJECTED verdict's, never a blanket
      // "unprovable = refuse" (a gate inversion would show up here).
      seamRecord: () => ({ role: 'inherit' }),
      policyFor,
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(chunks)).toHaveLength(1)
    expect(policyFor).not.toHaveBeenCalled()
  })
})

describe('role chain tail (design §2.2)', () => {
  it('walks a roles-only config for an injected child (R-2: empty rootChain, no EMPTY_EFFECTIVE_CHAIN)', async () => {
    // The config's ONLY chain lives in `roles.list` — the shape a subagent
    // deployment uses. The pre-C adapter guards read root/all-day semantics and
    // threw EMPTY_EFFECTIVE_CHAIN before the walk could resolve the role; the
    // guards now live in the walk, which resolves the role FIRST.
    adapter.respond = () => ({ chunks: [TEXT, STOP] })

    const chunks = await walk({
      readConfig: () => cfg({ rootChain: [], roles: { list: [{ id: 'coder', persona: '', chain: ['a/1', 'b/2'] }], rules: [] } }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'coder', virtualRouteInjected: true }),
      roleIds: () => CODER_ROLE_IDS,
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(chunks)).toEqual([STOP])
  })

  it('walks a subagent role chain and appends rootChain under inherit-root', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })

    await walk({
      readConfig: config({
        rootChain: ['c/3'],
        roles: { list: [{ id: 'coder', persona: '', chain: ['a/1'] }], rules: [] },
      }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'coder' }),
      roleIds: () => CODER_ROLE_IDS,
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['a/1', 'c/3'])
  })

  it('walks only the role chain when the role declares fallback: none', async () => {
    adapter.respond = () => ({ failure: { code: 'AUTH' } })

    await walk({
      readConfig: config({
        rootChain: ['c/3'],
        roles: { list: [{ id: 'coder', persona: '', chain: ['a/1'], fallback: 'none' }], rules: [] },
      }),
      resolveAgentView: () => ({ origin: 'subagent', sessionId: 's1' }),
      seamRecord: () => ({ role: 'coder' }),
      roleIds: () => CODER_ROLE_IDS,
    }, { sessionId: SessionId('s1') })

    expect(dispatched()).toEqual(['a/1'])
  })
})

describe('effort rule (design §3.2)', () => {
  it('keeps an explicit selection effort on every attempt', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: rootConfig(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(adapter.calls.map((call) => call.reasoningEffort)).toEqual(['high', 'high'])
  })

  it('drops the effort entirely when the selection carries none', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

    expect(adapter.calls.map((call) => 'reasoningEffort' in call)).toEqual([false, false])
  })
})

describe('per-target parameter adaptation (plan 2026-11-07 T2)', () => {
  it('drops an inherited effort the next candidate does not list', async () => {
    adapter.efforts = (_provider, model) => (model === '1'
      ? [{ id: 'high', name: 'High' }]
      : [{ id: 'low', name: 'Low' }])
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: rootConfig(['a/1', 'b/2']) },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(adapter.calls.map((call) => call.reasoningEffort)).toEqual(['high', undefined])
    // Absent, not `undefined`: the runtime would reject an unsupported effort.
    expect('reasoningEffort' in adapter.calls[1]!).toBe(false)
  })

  it('drops a maxTokens above the candidate disclosed cap', async () => {
    adapter.outputCap = (_provider, model) => (model === '2' ? 1000 : 4000)
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk({ readConfig: rootConfig(['a/1', 'b/2']) }, { maxTokens: 2000 })

    // a/1's cap fits, so the inherited 2000 rides; b/2 (cap 1000) drops it and
    // the runtime materializes THAT route's default instead.
    expect(adapter.calls.map((call) => call.maxTokens)).toEqual([2000, 1000])
  })

  it('keeps both controls when the candidate lists the effort and fits the cap', async () => {
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.outputCap = () => 4000
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })

    await walk(
      { readConfig: rootConfig(['a/1', 'b/2']) },
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
      { readConfig: rootConfig(['a/1', 'b/2']), getLlm: () => flaky },
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
      { readConfig: rootConfig(['a/1', 'b/2']), getLlm: () => streamOnly },
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
      { readConfig: rootConfig(['a/1']), log: { info: () => {}, warn: () => {}, debug } },
      { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] },
    )

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('parameter adaptation'), 'a', '1', 'reasoningEffort')
  })
})

describe('reactive parameter repair (plan 2026-11-07 T2 / AC-7)', () => {
  it('repairs a max_tokens rejection by retrying the SAME candidate without maxTokens', async () => {
    // The observed zai-coding-cn shape: the route discloses no defaultMaxTokens,
    // so proactive adaptation cannot see the cap and the provider 400s instead.
    adapter.respond = (options) => (options.maxTokens === undefined
      ? { chunks: [TEXT, STOP] }
      : { failure: { code: 'INVALID_REQUEST', message: 'max_tokens参数非法：限制数值范围[1,131072]' } })

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) }, { maxTokens: 384_000 })

    expect(dispatched()).toEqual(['a/1', 'a/1'])
    expect(adapter.calls.map((call) => call.maxTokens)).toEqual([384_000, undefined])
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('repairs UNSUPPORTED_REASONING_EFFORT by retrying the SAME candidate without the effort', async () => {
    // The probe lists `high` (so the proactive drop keeps it) but the adapter
    // rejects it anyway — only its own rejection exposes the real set.
    adapter.efforts = () => [{ id: 'high', name: 'High' }]
    adapter.respond = (options) => (options.reasoningEffort === undefined
      ? { chunks: [TEXT, STOP] }
      : { failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'no such effort' } })

    const chunks = await walk(
      { readConfig: rootConfig(['a/1', 'b/2']) },
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
      { readConfig: rootConfig(['a/1', 'b/2']) },
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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) }, { maxTokens: 384_000 })

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]!.maxTokens).toBe(384_000)
    expect(chunks.at(-1)).toMatchObject({ reason: { failure: { code: 'INVALID_REQUEST' } } })
  })

  it('books no cooldown for a repaired candidate', async () => {
    const states = new FallbackStateStore()
    adapter.respond = (options) => (options.maxTokens === undefined
      ? { chunks: [STOP] }
      : { failure: { code: 'INVALID_REQUEST', message: 'max_tokens out of range' } })
    const deps = { readConfig: rootConfig(['a/1', 'b/2']), states }

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

    const chunks = await walk({ readConfig: rootConfig(['a/1', 'b/2']) })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(finishes(chunks)).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH', message: '2 down' } },
    })
  })

  it('throws EMPTY_EFFECTIVE_CHAIN before any chunk or dispatch', () => {
    expect(thrownCode(() => walkChain(walkDeps({ getLlm: () => ctx.llm, readConfig: config({ rootChain: [] }) }), {
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
      messages: [],
    }))).toBe(EMPTY_EFFECTIVE_CHAIN_CODE)
    expect(adapter.calls).toHaveLength(0)
  })

  it('throws UNDISPATCHABLE_EFFECTIVE_HEAD for a wildcard-only or self-route chain', () => {
    const options = { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] }
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: rootConfig(['a/*']) }),
      options,
    ))).toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(thrownCode(() => walkChain(
      walkDeps({
        getLlm: () => ctx.llm,
        readConfig: rootConfig([`${FALLBACKS_PROVIDER}/${FALLBACKS_CHAIN_MODEL}`]),
      }),
      options,
    ))).toBe(UNDISPATCHABLE_HEAD_CODE)
    expect(adapter.calls).toHaveLength(0)
  })

  it('throws LLM_UNAVAILABLE when the runtime is gone', () => {
    expect(thrownCode(() => walkChain(
      walkDeps({ getLlm: () => undefined, readConfig: rootConfig(['a/1']) }),
      { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] },
    ))).toBe(LLM_UNAVAILABLE_CODE)
  })

  it('forwards an aborted finish and starts no further attempt', async () => {
    adapter.respond = () => ({ failure: { code: 'ABORTED', message: 'aborted' } })
    const controller = new AbortController()
    controller.abort()

    const chunks = await walk(
      { readConfig: rootConfig(['a/1', 'b/2']) },
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
      readConfig: rootConfig(['a/1', `${FALLBACKS_PROVIDER}/${FALLBACKS_CHAIN_MODEL}`, 'b/2']),
    })

    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(adapter.calls.every((call) => call.provider !== FALLBACKS_PROVIDER)).toBe(true)
  })
})

describe('P7 分时切换 rotation log (moved into the walk)', () => {
  /** Two half-day rows: 00:00–12:00 and the wrap-around 12:00–00:00. */
  const halfDay = cfg({
    rootChain: [OFFICIAL_FLASH],
    timeSlots: [
      { kind: 'custom', start: '00:00', end: '12:00', chain: ['a/1'] },
      { kind: 'custom', start: '12:00', end: '00:00', chain: ['b/2'] },
    ],
  })

  function at(iso: string): void {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs a time-slot switch when the winner changes since the agent’s last walk', async () => {
    const markers = new Map<string, { key: string; label: string }>()
    const info = vi.fn()
    const deps = { readConfig: () => halfDay, slotWinners: markers, log: { info, warn: () => {} } }

    at('2026-08-18T02:00:00Z') // 10:00 Asia/Shanghai → the 00:00–12:00 row
    await walk(deps, { sessionId: SessionId('s1') })
    expect(markers.get('s1')?.key).toBe('custom:00:00-12:00')
    expect(info.mock.calls.filter((call) => String(call[0]).includes('分时切换'))).toHaveLength(0)

    at('2026-08-18T06:00:00Z') // 14:00 Asia/Shanghai → the wrap-around row
    await walk(deps, { sessionId: SessionId('s1') })
    const switches = info.mock.calls.filter((call) => String(call[0]).includes('分时切换'))
    expect(switches).toHaveLength(1)
    expect(switches[0]?.slice(2)).toEqual(['custom 00:00-12:00', 'custom 12:00-00:00'])
    expect(markers.get('s1')?.key).toBe('custom:12:00-00:00')
  })

  it('never logs for a subagent-origin walk (rotation is a root observation)', async () => {
    const markers = new Map<string, { key: string; label: string }>()
    const info = vi.fn()
    const deps = {
      readConfig: () => halfDay,
      resolveAgentView: () => ({ origin: 'subagent' as const, sessionId: 's1' }),
      slotWinners: markers,
      log: { info, warn: () => {} },
    }

    at('2026-08-18T02:00:00Z')
    await walk(deps, { sessionId: SessionId('s1') })
    at('2026-08-18T06:00:00Z')
    await walk(deps, { sessionId: SessionId('s1') })

    expect(info.mock.calls.filter((call) => String(call[0]).includes('分时切换'))).toHaveLength(0)
    expect(markers.size).toBe(0)
  })
})

describe('bookkeeping (design §3.3)', () => {
  it('cools a route-scoped failure and skips it on the next walk', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const states = new FallbackStateStore()

    await walk({ readConfig: rootConfig(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1', 'b/2'])
    expect(states.peek('s1')?.cooldown.peek('a/1')).toBeTypeOf('number')

    adapter.calls.length = 0
    await walk({ readConfig: rootConfig(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    // The cooled head is skipped: the second walk resumes at the next candidate.
    expect(dispatched()).toEqual(['b/2'])
  })

  it('writes no cooldown for a request-scoped failure', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE } } : { chunks: [STOP] })
    const states = new FallbackStateStore()

    await walk({
      readConfig: rootConfig(['a/1', 'b/2'], { triggerCodes: [CONTEXT_WINDOW_EXCEEDED_CODE] }),
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
    const first = await walk({ readConfig: rootConfig(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['a/1'])
    expect(finishes(first)).toHaveLength(1)

    // …and the dead head is no longer healthy for the NEXT walk.
    adapter.calls.length = 0
    await walk({ readConfig: rootConfig(['a/1', 'b/2']), states }, { sessionId: SessionId('s1') })
    expect(dispatched()).toEqual(['b/2'])
  })

  it('observes success before the terminal finish is delivered', async () => {
    const states = new FallbackStateStore()
    const state = states.get('s1')
    state.recovery.markHalfOpen('a/1', Date.now())

    // The valid consumer pattern: stop AT the finish, never ask the iterator for
    // another result — which closes the generator at that `yield`.
    for await (const chunk of walkChain(
      walkDeps({ getLlm: () => ctx.llm, readConfig: rootConfig(['a/1']), states }),
      { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [], sessionId: SessionId('s1') },
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

    await walk({ readConfig: rootConfig(['a/1']), states }, { sessionId: SessionId('s1') })

    expect(state.recovery.isHalfOpen('a/1')).toBe(false)
  })

  it('logs the switch with the annotated candidate order', async () => {
    adapter.respond = (options) => (options.model === '1' ? { failure: { code: 'AUTH' } } : { chunks: [STOP] })
    const info = vi.fn()

    await walk({
      readConfig: rootConfig(['a/1', 'b/2']),
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
