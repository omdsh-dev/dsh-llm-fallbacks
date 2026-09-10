/**
 * Virtual `FallbacksChain/Auto` adapter tests (plan fallbacks-virtual-chain
 * Task 1; PR #62 feedback round): the P2 registration lifecycle (listed
 * whenever enabled — conformance is NOT part of registration; idempotent
 * transition-reconcile; multi-fiber dedupe; slot/chain edits never churn)
 * and the P1/P3 adapter contract (one catalog row; `stream()` is a thin
 * head-delegate through the host LLM runtime, gated on a conforming
 * all-day; `resolveModel` proxies the current effective head with a
 * permissive fallback; `imageRequestPricing` delegates to the SAME head,
 * never throwing; `providerRetryPolicy` mirrors the head's captured policy,
 * never throwing).
 *
 * Runs against the REAL `LlmRuntime` (`@deepseek-ai/dsh-llm`) with a stub
 * head adapter for `deepseek-official`, so the registration boundary, the
 * capability resolution, and the delegated stream all exercise real runtime
 * code — no doubles for the adapter registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmRuntime,
  createAssistantMessage,
  type GenerateOptions,
  type LlmImageRequestPricing,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { apply } from '../src/index.ts'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import {
  EMPTY_EFFECTIVE_CHAIN_CODE,
  FALLBACKS_CHAIN_MODEL,
  FALLBACKS_PROVIDER,
  FallbacksChainAdapter,
  installFallbacksAdapter,
  pickerDisplayName,
  UNDISPATCHABLE_HEAD_CODE,
} from '../src/virtual-adapter.ts'
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { alwaysPolicy, cfg, dispatchRequest, makeAgent } from './support/harness.ts'

const HEAD_PROVIDER = 'deepseek-official'
const HEAD_MODEL = 'deepseek-flash'

/** Minimal durable image ref for pricing calls (shape only — the opaque id is never dereferenced). */
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: 'att-test' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 1024,
  width: 64,
  height: 64,
}
/** One stub price per occurrence — an unmistakable non-neutral answer. */
const STUB_PRICE = { visualTokens: 17, text: 'stub image price' }

/** Route pricing serving {@link STUB_PRICE} for every occurrence. */
function stubPricing(): LlmImageRequestPricing {
  return { priceImages: () => [STUB_PRICE] }
}

/** Stub adapter for the real head provider — records delegated calls. */
class StubHeadAdapter extends LlmAdapter {
  readonly calls: Array<{ provider: string; model: string; options: GenerateOptions }> = []
  readonly pricingCalls: Array<{ provider: string; model: string }> = []
  /** Route pricing served for the head pair; `undefined` declares none (the base default). */
  pricing: LlmImageRequestPricing | undefined
  /** Route retry policy declared for the head; `undefined` declares none (the base default). */
  policy: ResolvedRetryPolicy | undefined

  constructor(public info: Partial<LlmResolvedModelInfo> = {}) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'DeepSeek Official' }
  }

  override listModels() {
    return Promise.resolve([{ provider: HEAD_PROVIDER, id: HEAD_MODEL, name: 'DeepSeek Flash' }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, ...this.info })
  }

  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    this.pricingCalls.push({ provider, model })
    return this.pricing
  }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return this.policy
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push({ provider: options.provider, model: options.model, options })
    yield { type: 'text-delta', index: 0, text: 'hello from head' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Drain a chunk stream into an array. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Whether the virtual route is currently registered on the real runtime. */
function listed(): boolean {
  return listedOn(ctx)
}

/** {@link listed} for a locally constructed runtime (fixture-free arms). */
function listedOn(target: Context): boolean {
  return target.llm.listProviders().some((provider) => provider.id === FALLBACKS_PROVIDER)
}

let ctx: Context
let stub: StubHeadAdapter

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
  stub = new StubHeadAdapter()
  // Registers the `llm` service on the context (Service constructor).
  new LlmRuntime(ctx)
  ctx.llm.registerAdapter([HEAD_PROVIDER], stub)
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

describe('registration lifecycle (P2)', () => {
  it('registers the virtual route whenever enabled (conformance-independent)', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(ctx.llm.listProviders().find((provider) => provider.id === FALLBACKS_PROVIDER)).toEqual({
      id: FALLBACKS_PROVIDER,
      name: 'FallbacksChain',
    })
  })

  it('hides the row when the plugin is disabled', () => {
    apply(ctx, cfg({ enabled: false, rootChain: [OFFICIAL_FLASH] }))
    expect(listed()).toBe(false)
  })

  it('shows the row for an empty all-day chain (enabled-only gate, PR #62 feedback)', async () => {
    apply(ctx, cfg({ rootChain: [] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
  })

  it('shows the row for a legacy multi-model rootChain (enabled-only gate, PR #62 feedback)', async () => {
    apply(ctx, cfg({ rootChain: ['other/gpt-4o', 'other/gpt-5'] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
  })

  it('is a clean no-op without an llm service', async () => {
    const bare = new Context()
    try {
      expect(() => apply(bare, cfg({ rootChain: [OFFICIAL_FLASH] }))).not.toThrow()
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('dedupes a duplicate registration (DUPLICATE_ADAPTER caught, first fiber owns the route)', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(() => apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))).not.toThrow()
    expect(ctx.llm.listProviders().filter((provider) => provider.id === FALLBACKS_PROVIDER)).toHaveLength(1)
    expect(listed()).toBe(true)
  })

  it('disabling unregisters the row and re-enabling re-registers it', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { enabled: false })
    expect(listed()).toBe(false)

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { enabled: true })
    expect(listed()).toBe(true)
  })

  it('all-day conformance loss keeps the row registered (enabled-only gate)', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { rootChain: ['other/gpt-4o', 'other/gpt-5'] })
    expect(listed()).toBe(true)
  })

  it('slot-row edits never churn registration', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    const updated: number[] = []
    ctx.events.on('llm/adapters-updated', () => updated.push(updated.length))

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', chain: [OFFICIAL_FLASH] }],
    })
    // The condition deliberately ignores timeSlots — no register/unregister churn.
    expect(updated).toHaveLength(0)
    expect(listed()).toBe(true)
  })
})

describe('adapter contract (P1/P3)', () => {
  it('advertises exactly the one virtual catalog row', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(await ctx.llm.listModels(FALLBACKS_PROVIDER)).toEqual([
      {
        provider: FALLBACKS_PROVIDER,
        id: FALLBACKS_CHAIN_MODEL,
        // All-day winner (no extra slots) — host picker trigger is this name.
        name: `${FALLBACKS_CHAIN_MODEL}: DeepSeek Flash[all-day]`,
      },
    ])
  })
  it('pickerDisplayName annotates the matching slot + head display name', () => {
    const now = new Date('2026-08-18T02:00:00Z')
    const name = pickerDisplayName(cfg({
      rootChain: [OFFICIAL_FLASH],
      timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_FLASH] }],
    }), now, 'DeepSeek Flash')
    expect(name).toBe(`${FALLBACKS_CHAIN_MODEL}: DeepSeek Flash[Liang Peak]`)
  })

  it('pickerDisplayName stays bare Auto when the all-day chain is non-conforming', () => {
    expect(pickerDisplayName(cfg({ rootChain: ['openai/gpt-4o'] }))).toBe(FALLBACKS_CHAIN_MODEL)
    expect(pickerDisplayName(cfg({ rootChain: [] }))).toBe(FALLBACKS_CHAIN_MODEL)
  })

  it('resolveModel proxies the current effective head metadata', async () => {
    stub.info = {
      context: { contextWindow: 131_072 },
      defaultMaxTokens: 8192,
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    }
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const info = await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)
    expect(info).toMatchObject({
      provider: FALLBACKS_PROVIDER,
      id: FALLBACKS_CHAIN_MODEL,
      name: HEAD_MODEL,
      context: { contextWindow: 131_072 },
      defaultMaxTokens: 8192,
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    })
  })

  it('resolveModel falls back to a permissive default when the head is unresolvable (never throws)', async () => {
    // A context WITHOUT the head stub: no adapter registered for
    // `deepseek-official` → the proxy lookup fails inside resolveModel →
    // permissive identity metadata, no throw.
    const bare = new Context()
    try {
      new LlmRuntime(bare)
      apply(bare, cfg({ rootChain: [OFFICIAL_FLASH] }))
      await vi.waitFor(() => expect(bare.llm.listProviders().some((provider) => provider.id === FALLBACKS_PROVIDER)).toBe(true))
      expect(await bare.llm.resolveModelInfo(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toEqual({
        provider: FALLBACKS_PROVIDER,
        id: FALLBACKS_CHAIN_MODEL,
        name: FALLBACKS_CHAIN_MODEL,
      })
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('stream() delegates to the effective head through the host runtime', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const chunks = await collect(
      ctx.llm.stream({
        provider: FALLBACKS_PROVIDER,
        model: FALLBACKS_CHAIN_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    )
    expect(chunks).toEqual([
      { type: 'text-delta', index: 0, text: 'hello from head' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // The REAL pair was dispatched — the virtual route never streams itself.
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ provider: HEAD_PROVIDER, model: HEAD_MODEL })
  })

  it('resolveModel and stream() use the same exact head as the root route delegate (wildcard-first chain)', async () => {
    // The same wildcard-first slot chain tests/index-request.spec.ts drives
    // through the root request path ("serves the seed unchanged for a
    // wildcard-first chain"): the leading `other/*` is never a
    // dispatch target, so BOTH delegate paths must land on
    // `anthropic/claude-sonnet-4` — the head the virtual route delegates to.
    const anthropicStub = new StubHeadAdapter({ name: 'Claude Sonnet 4' })
    ctx.llm.registerAdapter(['anthropic'], anthropicStub)
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'anthropic/claude-sonnet-4'] }],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    // resolveModel proxies the SAME head's metadata (name comes from the
    // anthropic stub — proof the proxy followed the chain past the wildcard).
    const info = await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)
    expect(info).toMatchObject({ provider: FALLBACKS_PROVIDER, id: FALLBACKS_CHAIN_MODEL, name: 'Claude Sonnet 4' })

    // stream() delegates to the SAME head — the virtual route never streams
    // itself and never touches the leading wildcard entry.
    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] }),
    )
    expect(chunks).toEqual([
      { type: 'text-delta', index: 0, text: 'hello from head' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(anthropicStub.calls).toHaveLength(1)
    expect(anthropicStub.calls[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4' })
    // The all-day head was never dispatched either.
    expect(stub.calls).toHaveLength(0)
  })

  it('serves the root request as the virtual pair and delegates that exact route to the head', async () => {
    // Plan model-change-notice-loop Task 1: the root `agent/request` no longer
    // rewrites a `FallbacksChain/Auto` seed, so the route the loop serves (and
    // records) IS the virtual pair — this delegate is the only thing that
    // turns it into a real model request. A wildcard-first slot chain keeps
    // the two routes distinguishable: the served route must stay virtual while
    // the delegated pair is the slot head.
    const anthropicStub = new StubHeadAdapter({ name: 'Claude Sonnet 4' })
    ctx.llm.registerAdapter(['anthropic'], anthropicStub)
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'anthropic/claude-sonnet-4'] }],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const { agent } = makeAgent('root-route-delegate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    const served = await dispatchRequest(ctx, agent, {
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
    // The served route is byte-identical to the seed, and it is what the
    // session records (the host's notice listener reads this value).
    expect(served).toEqual({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL })
    expect(agent.session.requestHeader()?.config).toEqual(served)

    // Streaming the SERVED config is the root path's only way to a real model.
    const chunks = await collect(ctx.llm.stream({ ...served, messages: [] }))
    expect(chunks).toEqual([
      { type: 'text-delta', index: 0, text: 'hello from head' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(anthropicStub.calls).toHaveLength(1)
    expect(anthropicStub.calls[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(stub.calls).toHaveLength(0)
  })

  it('stream() throws an explicit LlmError when the effective chain is empty', async () => {
    const config: FallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: [OFFICIAL_FLASH],
      presets: 'none',
    }
    installFallbacksAdapter(ctx, () => config)
    await vi.waitFor(() => expect(listed()).toBe(true))

    // Stale registration (no reconcile ran): the live config loses its chain.
    config.rootChain = []
    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] }),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: EMPTY_EFFECTIVE_CHAIN_CODE } },
    })
    expect(stub.calls).toHaveLength(0)
  })

  it('stream() refuses a self-route head (recursion guard)', async () => {
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{
          kind: 'custom', start: '00:00', end: '23:59',
          chain: [`${FALLBACKS_PROVIDER}/${FALLBACKS_CHAIN_MODEL}`],
        }],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] }),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: UNDISPATCHABLE_HEAD_CODE } },
    })
    expect(stub.calls).toHaveLength(0)
  })

  it('stream() refuses a legacy non-conforming all-day chain (conformance gate, PR #62 feedback)', async () => {
    // The row is visible whenever enabled, but a successful delegate still
    // requires a conforming all-day: the effective head is undefined for a
    // legacy multi-model rootChain, so stream() throws UNDISPATCHABLE and
    // resolveModel falls back to the permissive default.
    apply(ctx, cfg({ rootChain: ['other/gpt-4o', 'other/gpt-5'] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] }),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: UNDISPATCHABLE_HEAD_CODE } },
    })
    expect(stub.calls).toHaveLength(0)

    expect(await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toEqual({
      provider: FALLBACKS_PROVIDER,
      id: FALLBACKS_CHAIN_MODEL,
      name: FALLBACKS_CHAIN_MODEL,
    })
  })

  it('stream() refuses a wildcard head (no real pair to delegate)', async () => {
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_FLASH],
        timeSlots: [{ kind: 'custom', start: '00:00', end: '23:59', chain: [`${HEAD_PROVIDER}/*`] }],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages: [] }),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: UNDISPATCHABLE_HEAD_CODE } },
    })
    expect(stub.calls).toHaveLength(0)
  })
})

describe('imageRequestPricing (0.1.2 adoption)', () => {
  it('delegates to the SAME effective head stream() dispatches (route-accurate)', async () => {
    stub.pricing = stubPricing()
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const pricing = ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)
    // The head adapter's own pricing came back — queried for the HEAD pair,
    // never the virtual `FallbacksChain/Auto` arguments.
    expect(pricing?.priceImages([IMAGE_REF])).toEqual([STUB_PRICE])
    expect(stub.pricingCalls).toEqual([{ provider: HEAD_PROVIDER, model: HEAD_MODEL }])
  })

  it('returns undefined for an unknown or undispatchable head (never throws)', async () => {
    // Undispatchable: a legacy non-conforming all-day chain has no head.
    apply(ctx, cfg({ rootChain: ['other/gpt-4o', 'other/gpt-5'] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toBeUndefined()

    // Unknown: the head pair resolves but no adapter is registered for it.
    const bare = new Context()
    try {
      new LlmRuntime(bare)
      apply(bare, cfg({ rootChain: [OFFICIAL_FLASH] }))
      await vi.waitFor(() =>
        expect(bare.llm.listProviders().some((provider) => provider.id === FALLBACKS_PROVIDER)).toBe(true))
      expect(bare.llm.imageRequestPricing(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toBeUndefined()
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('returns undefined when the llm runtime is gone (mid-teardown guard)', () => {
    // Direct construction — the registration lifecycle can never reach a
    // registered route whose `llm` vanished, so the guard is unit-tested
    // on the class directly.
    const config: FallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: [OFFICIAL_FLASH],
      presets: 'none',
    }
    const adapter = new FallbacksChainAdapter(() => config, () => undefined)
    expect(adapter.imageRequestPricing(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toBeUndefined()
  })

  it('degrades to undefined when the head adapter pricing throws', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    vi.spyOn(stub, 'imageRequestPricing').mockImplementation(() => {
      throw new Error('head pricing exploded')
    })
    // The runtime lookup would propagate the throw; the virtual override
    // must absorb it into the meter's neutral estimate.
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toBeUndefined()
  })

  it('returns undefined when the effective chain is empty', async () => {
    apply(ctx, cfg({ rootChain: [] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL)).toBeUndefined()
  })
})

/**
 * Retry attribution (`dsh-llm` `prepareRoutes`): the host captures
 * `adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, …)`
 * ONCE, when a route is registered — so a virtual route declaring no policy
 * of its own silently hands `FallbacksChain` the permissive normal default
 * and drops the `retryPolicy` the user configured on the head actually served
 * by the delegate. The proxy answers with the SAME captured object the head's
 * own route returns; an unresolvable head answers `undefined` (the host
 * default) rather than a fabricated policy — and never throws, because that
 * throw happens INSIDE `registerAdapter` and would take the whole virtual
 * route down.
 */
describe('providerRetryPolicy (route-accurate retry attribution)', () => {
  /** Unmistakable head policy: `always` + a backoff the host default never has. */
  const HEAD_POLICY: ResolvedRetryPolicy = alwaysPolicy({ initialDelayMs: 1234, maxDelayMs: 4321 })

  it('reports the effective head policy, not the permissive default', async () => {
    const local = new Context()
    try {
      new LlmRuntime(local)
      const headStub = new StubHeadAdapter()
      // Declared BEFORE the registration below — the host captures it there.
      headStub.policy = HEAD_POLICY
      local.llm.registerAdapter([HEAD_PROVIDER], headStub)
      apply(local, cfg({ rootChain: [OFFICIAL_FLASH] }))
      await vi.waitFor(() => expect(listedOn(local)).toBe(true))

      const virtual = local.llm.providerRetryPolicy(FALLBACKS_PROVIDER)
      // The head route's own captured object came back — identity, not a copy.
      expect(virtual).toBe(local.llm.providerRetryPolicy(HEAD_PROVIDER))
      expect(virtual).toMatchObject({ mode: 'always', initialDelayMs: 1234, maxDelayMs: 4321 })
    } finally {
      await local.fiber.dispose()
    }
  })

  it('reports the runtime default for a non-conforming chain (conformance-gated, not policy-gated)', async () => {
    // Non-conformance lives in the chain TAIL (`isAllDayConforming` reads only
    // the last entry), while the FIRST entry is a REGISTERED official head.
    // That combination is what makes the conformance gate observable: drop the
    // gate and head resolution walks the raw chain to that registered head —
    // whose captured policy IS `always` — so the proxy would echo `always`
    // here instead of the host default, and this arm would fail. The head
    // route's own `always` answer in the same runtime (asserted below) is the
    // control: the proxy is gated on a conforming chain, not a blanket echo of
    // every policy the runtime happens to hold.
    const local = new Context()
    try {
      new LlmRuntime(local)
      const headStub = new StubHeadAdapter()
      headStub.policy = HEAD_POLICY
      local.llm.registerAdapter([HEAD_PROVIDER], headStub)
      apply(local, cfg({ rootChain: [OFFICIAL_FLASH, 'other/gpt-4o'] }))
      await vi.waitFor(() => expect(listedOn(local)).toBe(true))

      expect(local.llm.providerRetryPolicy(HEAD_PROVIDER)).toMatchObject({ mode: 'always' })
      expect(local.llm.providerRetryPolicy(FALLBACKS_PROVIDER)).toMatchObject({
        mode: 'normal',
        maxRetries: 5,
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        jitterRatio: 0.1,
      })
    } finally {
      await local.fiber.dispose()
    }
  })

  it('absorbs an unregistered head provider instead of failing registration', async () => {
    // The chain resolves to a conforming head but no adapter owns that route,
    // so the runtime's own lookup throws `NO_ADAPTER` — inside the plugin's
    // `registerAdapter` call. Absorbing it is what keeps the row selectable.
    const bare = new Context()
    try {
      new LlmRuntime(bare)
      apply(bare, cfg({ rootChain: [OFFICIAL_FLASH] }))
      await vi.waitFor(() => expect(listedOn(bare)).toBe(true))
      expect(bare.llm.providerRetryPolicy(FALLBACKS_PROVIDER)).toMatchObject({ mode: 'normal', maxRetries: 5 })
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('answers undefined when the llm runtime is gone (mid-teardown guard)', () => {
    // Direct construction: the registration lifecycle cannot reach a
    // registered route whose `llm` vanished, so the guard is unit-tested on
    // the class directly (mirrors the pricing guard above).
    const config: FallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: [OFFICIAL_FLASH],
      presets: 'none',
    }
    const adapter = new FallbacksChainAdapter(() => config, () => undefined)
    expect(adapter.providerRetryPolicy(FALLBACKS_PROVIDER)).toBeUndefined()
  })
})

describe('delegated history provenance (R-004)', () => {
  /**
   * The agent loop stamps every durable assistant message with the route of the
   * REQUEST that produced it (`FallbacksChain/Auto` on this path) while the
   * replay envelope inside it came from the head adapter that actually answered.
   * `LlmRuntime.forAdapter` keeps an envelope only when the TARGET adapter owns
   * the message's recorded provider, so on the delegate's inner pass the head is
   * handed a message with no `replayState` — pi-ai-backed thinking signatures are
   * silently dropped.
   *
   * Two arms: a recognised envelope (whose own provenance names the head) must
   * still reach the head, and an envelope this plugin cannot read must be left
   * exactly as it is.
   */
  /**
   * A replay envelope in the shape the host's pi-ai adapter validates
   * (`@deepseek-ai/dsh-llm-pi-ai` `readReplayState`: `response.kind === 'pi-ai'`,
   * `version === 2`, non-empty `api`/`provider`/`model`, a known `stopReason`,
   * and a `blocks` array). Verified against the installed 0.1.5-rc.1 build —
   * the plugin does not depend on pi-ai, so the fixture reproduces the contract
   * structurally instead of importing it.
   */
  const HEAD_ENVELOPE = {
    response: {
      kind: 'pi-ai',
      version: 2,
      api: 'anthropic-messages',
      provider: HEAD_PROVIDER,
      model: HEAD_MODEL,
      stopReason: 'stop',
    },
    blocks: [{ type: 'text', textSignature: 'sig-1' }],
  }

  /** One durable assistant message, as the loop records it on `provider`/`model`. */
  function assistantOn(provider: string, model: string, replayState?: unknown) {
    return createAssistantMessage({
      content: [{ type: 'text', text: 'earlier turn' }],
      source: { provider, model, ...(replayState === undefined ? {} : { replayState }) },
    })
  }

  /** A durable assistant message as the loop records it on the virtual route. */
  function virtualRouteHistory(replayState?: unknown) {
    return assistantOn(FALLBACKS_PROVIDER, FALLBACKS_CHAIN_MODEL, replayState)
  }

  /** Delegate one request with `messages`; return the history the head adapter saw. */
  async function delegatedHistory(messages: ReturnType<typeof assistantOn>[]) {
    apply(ctx, cfg({ rootChain: [OFFICIAL_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL, messages }),
    )
    expect(stub.calls).toHaveLength(1)
    return stub.calls[0]!.options.messages
  }

  it('hands the head its own envelope for a history message recorded on the virtual route', async () => {
    const [delegated] = await delegatedHistory([virtualRouteHistory(HEAD_ENVELOPE)])
    // Discriminating: pre-fix the recorded pair is the virtual one, so the
    // runtime's ownership gate strips the envelope before the head sees it.
    expect(delegated).toMatchObject({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: HEAD_PROVIDER,
        model: HEAD_MODEL,
        replayState: HEAD_ENVELOPE,
      },
    })
  })

  it('restores the virtual route and still withholds a real-route envelope (boundary pin)', async () => {
    // Both halves of what this fix does and does not cover.
    //
    // Restored: a message the loop recorded on the VIRTUAL route keeps its
    // envelope and reaches the head under the pair the envelope names — which is
    // also what pi-ai's replay validator demands (`response.provider`/`model`
    // must equal the message source, else it throws `INVALID_REPLAY_STATE`
    // instead of replaying the thinking blocks).
    //
    // Not covered (pre-existing): a message recorded on a REAL route loses its
    // envelope one gate earlier — on the OUTER pass the target adapter is this
    // virtual adapter, which does not own that historical provider, so
    // `forAdapter` strips it before `stream()` ever receives the history. No
    // plugin code can recover it on that path (the durable envelope is simply
    // not in the delegated options). Same cross-route boundary as R-004, on the
    // other side of the delegate — documented here, not fixed here.
    const [realRoute, virtualRoute] = await delegatedHistory([
      assistantOn(HEAD_PROVIDER, HEAD_MODEL, HEAD_ENVELOPE),
      virtualRouteHistory(HEAD_ENVELOPE),
    ])
    expect((realRoute?.source as { replayState?: unknown }).replayState).toBeUndefined()
    expect(virtualRoute?.source).toMatchObject({
      kind: 'model',
      provider: HEAD_PROVIDER,
      model: HEAD_MODEL,
      replayState: HEAD_ENVELOPE,
    })
  })

  it('leaves an unreadable envelope untouched instead of inventing a provenance', async () => {
    // Regression guard, NOT a discriminator: this passes before and after the
    // fix. The probe cannot name a provider for an unrecognised shape, so the
    // message keeps the virtual pair and the runtime's ownership gate strips the
    // envelope exactly as it does today — the conservative half of the contract.
    const unreadable = { someAdapterPrivateShape: 'unrecognised' }
    const [delegated] = await delegatedHistory([virtualRouteHistory(unreadable)])
    expect(delegated).toMatchObject({
      source: { kind: 'model', provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL },
    })
    expect((delegated?.source as { replayState?: unknown }).replayState).toBeUndefined()
  })
})
