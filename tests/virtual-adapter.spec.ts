/**
 * Virtual `FallbacksChain` adapter tests (named virtual chains, plan
 * named-virtual-chains T2): the registration lifecycle (listed whenever
 * `chains` is non-empty — conformance is NOT part of registration; idempotent
 * transition-reconcile; multi-fiber dedupe; slot edits never churn) and the
 * adapter contract (ONE row PER chain, the row id BEING the chain id;
 * `stream()` walks the selected chain through the host LLM runtime, gated on
 * a conforming entries tail; `resolveModel`/`imageRequestPricing` resolve the
 * chain FROM the model argument and follow its effective head, permissive
 * fallback, never throwing; `providerRetryPolicy` returns `undefined` — the
 * documented degradation: the host captures the policy once per provider).
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
import { defaultFallbacksConfig, type FallbacksConfig, type NamedChain } from '../src/config.ts'
import { OFFICIAL_FLASH, type SlotRowConfig } from '../src/time-slots.ts'
import { UNDISPATCHABLE_HEAD_CODE } from '../src/chain-walk.ts'
import {
  FALLBACKS_PROVIDER,
  FallbacksChainAdapter,
  installFallbacksAdapter,
  pickerDisplayName,
} from '../src/virtual-adapter.ts'
import { FALLBACKS_PROFILE_ENTRY } from '../src/gateway.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { alwaysPolicy, cfg, dispatchRequest, makeAgent } from './support/harness.ts'

const HEAD_PROVIDER = 'deepseek-official'
const HEAD_MODEL = 'deepseek-flash'

/** The chain id under test (the model id on the wire; the migrated default). */
const CHAIN_ID = 'Auto'

/** A named chain fixture. */
function vChain(entries: readonly string[] = [OFFICIAL_FLASH], timeSlots: SlotRowConfig[] = [], id = CHAIN_ID): NamedChain {
  return { id, label: id === CHAIN_ID ? 'Test' : 'Other', entries: [...entries], timeSlots }
}

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

/**
 * The walk the guard arms below never reach: each one stops at the adapter's
 * own pre-flight checks (or never calls `stream()` at all), so this is a
 * tripwire rather than a stub.
 */
function unusedWalk(): AsyncIterable<StreamChunk> {
  throw new Error('the chain walk must not run in an adapter guard test')
}

/** An empty walk result — for the arm that only asserts delegation. */
function emptyStream(): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      // no chunks
    },
  }
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
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(ctx.llm.listProviders().find((provider) => provider.id === FALLBACKS_PROVIDER)).toEqual({
      id: FALLBACKS_PROVIDER,
      name: 'FallbacksChain',
    })
  })

  it('a legacy enabled: false line does NOT hide the row — content registers (plan fallbacks-web-ux-alignment T2)', async () => {
    // The removed switch is inert: a stored profile still carrying
    // `enabled: false` with a configured chain is ACTIVE (the row toggle is
    // the master switch), so the virtual route registers.
    apply(ctx, cfg({ chains: [vChain()], ...({ enabled: false } as object) }))
    await vi.waitFor(() => expect(listed()).toBe(true))
  })

  it('hides the row with no configured content (content presence replaces the enabled-only gate)', async () => {
    // PR #62 feedback let an enabled-only (contentless) config show the row;
    // T2 re-keyed the gate to content presence — an empty config is a
    // pass-through exactly like an uninstalled plugin, so nothing registers.
    apply(ctx, cfg({ chains: [] }))
    // Give any (incorrect) registration a beat before asserting.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().filter((provider) => provider.id === FALLBACKS_PROVIDER)).toHaveLength(0)
    })
    expect(listed()).toBe(false)
  })

  it('shows the row for a non-conforming chain (conformance gates the delegate, not the row)', async () => {
    apply(ctx, cfg({ chains: [vChain(['other/gpt-4o', 'other/gpt-5'])] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
  })

  it('is a clean no-op without an llm service', async () => {
    const bare = new Context()
    try {
      expect(() => apply(bare, cfg({ chains: [vChain()] }))).not.toThrow()
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('dedupes a duplicate registration (DUPLICATE_ADAPTER caught, first fiber owns the route)', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(() => apply(ctx, cfg({ chains: [vChain()] }))).not.toThrow()
    expect(ctx.llm.listProviders().filter((provider) => provider.id === FALLBACKS_PROVIDER)).toHaveLength(1)
    expect(listed()).toBe(true)
  })

  it('clearing content unregisters the row and restoring content re-registers it', async () => {
    // The live gate is content presence (T2): clearing the all-day chain
    // (the only configured content) deactivates the plugin; writing a chain
    // back re-activates it. No `enabled` write exists any more.
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, { chains: [] })
    expect(listed()).toBe(false)

    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, { chains: [vChain()] })
    await vi.waitFor(() => expect(listed()).toBe(true))
  })

  it('all-day conformance loss keeps the row registered (enabled-only gate)', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, { chains: [vChain(['other/gpt-4o', 'other/gpt-5'])] })
    expect(listed()).toBe(true)
  })

  it('slot-row edits never churn registration', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    const updated: number[] = []
    ctx.events.on('llm/adapters-updated', () => updated.push(updated.length))

    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, {
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', chain: [OFFICIAL_FLASH] }],
    })
    // The condition deliberately ignores timeSlots — no register/unregister churn.
    expect(updated).toHaveLength(0)
    expect(listed()).toBe(true)
  })
})

describe('adapter contract (P1/P3)', () => {
  it('advertises ONE row per chain, the row id being the chain id', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(await ctx.llm.listModels(FALLBACKS_PROVIDER)).toEqual([
      {
        provider: FALLBACKS_PROVIDER,
        id: CHAIN_ID,
        // All-day winner (no extra slots) — host picker trigger is this name.
        name: `Test: DeepSeek Flash[all-day]`,
      },
    ])
    // A config with TWO chains advertises two rows (id = chain id, label
    // prefix per chain) — on a FRESH context, because the first apply's
    // adapter instance owns this context's route and reads ITS config.
    const two = new Context()
    new LlmRuntime(two)
    try {
      apply(two, cfg({ chains: [vChain(), vChain([OFFICIAL_FLASH], [], 'night')] }))
      await vi.waitFor(() => expect(listedOn(two)).toBe(true))
      const rows = await two.llm.listModels(FALLBACKS_PROVIDER)
      // No head stub on this context: the display name falls back to the id.
      expect(rows.map((row) => [row.id, row.name])).toEqual([
        [CHAIN_ID, 'Test: deepseek-flash[all-day]'],
        ['night', 'Other: deepseek-flash[all-day]'],
      ])
    } finally {
      await two.fiber.dispose()
    }
  })
  it('pickerDisplayName annotates the matching slot + head display name with the chain label', () => {
    const now = new Date('2026-08-18T02:00:00Z')
    const name = pickerDisplayName(
      vChain([OFFICIAL_FLASH], [{ kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_FLASH] }]),
      now,
      'DeepSeek Flash',
    )
    expect(name).toBe('Test: DeepSeek Flash[Liang Peak]')
  })

  it('pickerDisplayName stays the bare chain label when the entries are non-conforming or empty', () => {
    expect(pickerDisplayName(vChain(['openai/gpt-4o']))).toBe('Test')
    expect(pickerDisplayName(vChain([]))).toBe('Test')
  })

  it('resolveModel proxies the current effective head metadata', async () => {
    stub.info = {
      context: { contextWindow: 131_072 },
      defaultMaxTokens: 8192,
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    }
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const info = await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, CHAIN_ID)
    expect(info).toMatchObject({
      provider: FALLBACKS_PROVIDER,
      id: CHAIN_ID,
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
      apply(bare, cfg({ chains: [vChain()] }))
      await vi.waitFor(() => expect(bare.llm.listProviders().some((provider) => provider.id === FALLBACKS_PROVIDER)).toBe(true))
      expect(await bare.llm.resolveModelInfo(FALLBACKS_PROVIDER, CHAIN_ID)).toEqual({
        provider: FALLBACKS_PROVIDER,
        id: CHAIN_ID,
        name: CHAIN_ID,
      })
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('stream() delegates to the effective head through the host runtime', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const chunks = await collect(
      ctx.llm.stream({
        provider: FALLBACKS_PROVIDER,
        model: CHAIN_ID,
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
        chains: [vChain([OFFICIAL_FLASH], [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'anthropic/claude-sonnet-4'] }])],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    // resolveModel proxies the SAME head's metadata (name comes from the
    // anthropic stub — proof the proxy followed the chain past the wildcard).
    const info = await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, CHAIN_ID)
    expect(info).toMatchObject({ provider: FALLBACKS_PROVIDER, id: CHAIN_ID, name: 'Claude Sonnet 4' })

    // stream() delegates to the SAME head — the virtual route never streams
    // itself and never touches the leading wildcard entry.
    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] }),
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
        chains: [vChain([OFFICIAL_FLASH], [{ kind: 'custom', start: '00:00', end: '23:59', chain: ['other/*', 'anthropic/claude-sonnet-4'] }])],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const { agent } = makeAgent('root-route-delegate', { provider: 'mock', model: 'gpt-4o' }, { origin: 'root' })
    const served = await dispatchRequest(ctx, agent, {
      provider: FALLBACKS_PROVIDER,
      model: CHAIN_ID,
    })
    // The served route is byte-identical to the seed, and it is what the
    // session records (the host's notice listener reads this value).
    expect(served).toEqual({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID })
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

  it('stream() hands a stale-registered call to the walk, which owns the pre-attempt guards', async () => {
    const config: FallbacksConfig = { ...defaultFallbacksConfig, chains: [vChain()], presets: 'none' }
    // Tripwire for the OLD contract: the adapter never refuses here itself —
    // the guards live in the walk.
    const walked: GenerateOptions[] = []
    installFallbacksAdapter(ctx, () => config, (options) => {
      walked.push(options)
      return emptyStream()
    })
    await vi.waitFor(() => expect(listed()).toBe(true))

    // Stale registration (no reconcile ran): the live config loses its chain.
    config.chains = []
    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] }),
    )
    expect(walked).toHaveLength(1)
    expect(chunks).toEqual([])
    expect(stub.calls).toHaveLength(0)
  })

  it('stream() skips a self-route slot head and delegates to the inherited official tail', async () => {
    apply(
      ctx,
      cfg({
        chains: [vChain([OFFICIAL_FLASH], [{
          kind: 'custom', start: '00:00', end: '23:59',
          chain: [`${FALLBACKS_PROVIDER}/${CHAIN_ID}`],
        }])],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] }),
    )
    // The recursion guard keeps the self-route out of the attempt order; the
    // inherited entries tail is the dispatchable head.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ provider: HEAD_PROVIDER, model: HEAD_MODEL })
  })

  it('stream() refuses a legacy non-conforming all-day chain (conformance gate, PR #62 feedback)', async () => {
    // The row is visible whenever enabled, but a successful delegate still
    // requires a conforming all-day: the effective head is undefined for a
    // legacy multi-model rootChain, so stream() throws UNDISPATCHABLE and
    // resolveModel falls back to the permissive default.
    apply(ctx, cfg({ chains: [vChain(['other/gpt-4o', 'other/gpt-5'])] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] }),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: UNDISPATCHABLE_HEAD_CODE } },
    })
    expect(stub.calls).toHaveLength(0)

    // resolveModel NEVER throws for a non-conforming chain: permissive default.
    expect(await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, CHAIN_ID)).toEqual({
      provider: FALLBACKS_PROVIDER,
      id: CHAIN_ID,
      name: CHAIN_ID,
    })

    // Metadata NEVER throws for an unknown chain id either (permissive default).
    expect(await ctx.llm.resolveModelInfo(FALLBACKS_PROVIDER, 'deleted-chain')).toEqual({
      provider: FALLBACKS_PROVIDER,
      id: 'deleted-chain',
      name: 'deleted-chain',
    })
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, 'deleted-chain')).toBeUndefined()
  })

  it('stream() skips a wildcard slot head and delegates to the inherited official tail', async () => {
    apply(
      ctx,
      cfg({
        chains: [vChain([OFFICIAL_FLASH], [{ kind: 'custom', start: '00:00', end: '23:59', chain: [`${HEAD_PROVIDER}/*`] }])],
      }),
    )
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Pin the wall clock inside the matching slot window (00:00–23:59).
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))

    const chunks = await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages: [] }),
    )
    // A wildcard head has no real pair to delegate; the inherited tail does.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ provider: HEAD_PROVIDER, model: HEAD_MODEL })
  })
})

// ---------------------------------------------------------------------------
// Catalog availability of selectable routes (the `modelAvailable` GUI gate —
// plan fallbacks-web-ux-alignment T9b, the 2026-09-27 research adaptation):
// since the current host (`session-controller/src/catalog.ts:73-89`) GUI model
// selection is gated on ADVERTISED catalog membership — picking a pair no
// `listModels` row advertises throws `session/model-unavailable`. The pin
// below asserts every route the card can put into a chain resolves through an
// advertised catalog row; the out-of-catalog boundary is documented, and the
// evidence task found no gap to fix (the adapter already advertises its row).
// ---------------------------------------------------------------------------

describe('catalog availability of selectable routes (rc.2 modelAvailable gate, T9b)', () => {
  /** The GUI gate's resolution face: is the pair advertised by its provider's catalog rows? */
  async function advertised(provider: string, model: string): Promise<boolean> {
    const rows = await ctx.llm.listModels(provider)
    return rows.some(row => row.id === model)
  }

  it('the virtual picker row the card composes is advertised (FallbacksChain / Auto)', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    // The adapter's `listModels` override (src/virtual-adapter.ts) is the
    // advertisement the GUI gate reads — the row the picker offers when the
    // card's Default model panel is filled.
    expect(await advertised(FALLBACKS_PROVIDER, CHAIN_ID)).toBe(true)
  })

  it('a real chain model is advertised by its own provider (catalog-served, GUI-selectable)', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    // Chain entries picked in the card come from the aggregate model catalog,
    // i.e. from a provider's own `listModels` rows — the head pair resolves.
    expect(await advertised(HEAD_PROVIDER, HEAD_MODEL)).toBe(true)
  })

  it('an out-of-catalog chain entry is NOT advertised — GUI-unselectable, still core-routable (documented boundary)', async () => {
    // The card keeps hand-written out-of-catalog chain values as annotated
    // synthetic options (configuration.md §Save rules). Under the GUI gate
    // such a pair can never be PICKED in the GUI — it is reachable only as a
    // fallback TARGET (core routing accepts unlisted ids). That is the
    // intended boundary, not a gap: no fix follows from the evidence task.
    expect(await advertised(HEAD_PROVIDER, 'legacy-unlisted-model')).toBe(false)
  })
})

describe('imageRequestPricing (0.1.2 adoption)', () => {
  it('delegates to the SAME effective head stream() dispatches (route-accurate)', async () => {
    stub.pricing = stubPricing()
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    const pricing = ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, CHAIN_ID)
    // The head adapter's own pricing came back — queried for the HEAD pair,
    // never the virtual `FallbacksChain/Auto` arguments.
    expect(pricing?.priceImages([IMAGE_REF])).toEqual([STUB_PRICE])
    expect(stub.pricingCalls).toEqual([{ provider: HEAD_PROVIDER, model: HEAD_MODEL }])
  })

  it('returns undefined for an unknown or undispatchable head (never throws)', async () => {
    // Undispatchable: a legacy non-conforming all-day chain has no head.
    apply(ctx, cfg({ chains: [vChain(['other/gpt-4o', 'other/gpt-5'])] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, CHAIN_ID)).toBeUndefined()

    // Unknown: the head pair resolves but no adapter is registered for it.
    const bare = new Context()
    try {
      new LlmRuntime(bare)
      apply(bare, cfg({ chains: [vChain()] }))
      await vi.waitFor(() =>
        expect(bare.llm.listProviders().some((provider) => provider.id === FALLBACKS_PROVIDER)).toBe(true))
      expect(bare.llm.imageRequestPricing(FALLBACKS_PROVIDER, CHAIN_ID)).toBeUndefined()
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('returns undefined when the llm runtime is gone (mid-teardown guard)', () => {
    // Direct construction — the registration lifecycle can never reach a
    // registered route whose `llm` vanished, so the guard is unit-tested
    // on the class directly.
    const config: FallbacksConfig = { ...defaultFallbacksConfig, chains: [vChain()], presets: 'none' }
    const adapter = new FallbacksChainAdapter(() => config, () => undefined, unusedWalk)
    expect(adapter.imageRequestPricing(FALLBACKS_PROVIDER, CHAIN_ID)).toBeUndefined()
  })

  it('degrades to undefined when the head adapter pricing throws', async () => {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    vi.spyOn(stub, 'imageRequestPricing').mockImplementation(() => {
      throw new Error('head pricing exploded')
    })
    // The runtime lookup would propagate the throw; the virtual override
    // must absorb it into the meter's neutral estimate.
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, CHAIN_ID)).toBeUndefined()
  })

  it('registers nothing with no configured content — the pricing face is moot (T2)', async () => {
    // An empty config never registers the virtual route (content presence),
    // so there is no `FallbacksChain` row to answer a pricing lookup with.
    apply(ctx, cfg({ chains: [] }))
    // Give any (incorrect) registration a beat before asserting.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().filter((provider) => provider.id === FALLBACKS_PROVIDER)).toHaveLength(0)
    })
    expect(ctx.llm.imageRequestPricing(FALLBACKS_PROVIDER, CHAIN_ID)).toBeUndefined()
  })
})

/**
 * Retry policy (`dsh-llm` `prepareRoutes`): the host captures
 * `adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, …)`
 * ONCE per provider at registration. The adapter stays ONE `FallbacksChain`
 * provider carrying N chain rows, so the virtual route can no longer mirror a
 * per-chain head's policy — it answers `undefined` and the host applies its
 * own default. DOCUMENTED DEGRADATION (named virtual chains §2): a head's
 * custom `retryPolicy` (including `mode: 'always'`) stops applying on the
 * virtual route; the one-provider-per-chain alternative was rejected (picker
 * UX + per-chain register/unregister churn).
 */
describe('providerRetryPolicy (documented degradation — host default)', () => {
  /** Unmistakable head policy: `always` + a backoff the host default never has. */
  const HEAD_POLICY: ResolvedRetryPolicy = alwaysPolicy({ initialDelayMs: 1234, maxDelayMs: 4321 })

  it('returns undefined even when the head route declares a custom policy (no head mirror)', async () => {
    const local = new Context()
    try {
      new LlmRuntime(local)
      const headStub = new StubHeadAdapter()
      headStub.policy = HEAD_POLICY
      local.llm.registerAdapter([HEAD_PROVIDER], headStub)
      apply(local, cfg({ chains: [vChain()] }))
      await vi.waitFor(() => expect(listedOn(local)).toBe(true))

      // The control: the head route itself still answers `always`.
      expect(local.llm.providerRetryPolicy(HEAD_PROVIDER)).toMatchObject({ mode: 'always', initialDelayMs: 1234 })
      // The virtual route does NOT mirror it — the host captured the
      // adapter's `undefined` answer at registration and resolved its OWN
      // normal default (never the head's `always`).
      const virtual = local.llm.providerRetryPolicy(FALLBACKS_PROVIDER)
      expect(virtual).toBeDefined()
      expect(virtual).not.toBe(local.llm.providerRetryPolicy(HEAD_PROVIDER))
      expect(virtual).toMatchObject({ mode: 'normal' })
    } finally {
      await local.fiber.dispose()
    }
  })

  it('answers undefined when the llm runtime is gone (mid-teardown guard)', () => {
    // Direct construction: the registration lifecycle cannot reach a
    // registered route whose `llm` vanished, so the guard is unit-tested on
    // the class directly (mirrors the pricing guard above).
    const config: FallbacksConfig = { ...defaultFallbacksConfig, chains: [vChain()], presets: 'none' }
    const adapter = new FallbacksChainAdapter(() => config, () => undefined, unusedWalk)
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
   * and a `blocks` array). Verified against an installed host build —
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
    return assistantOn(FALLBACKS_PROVIDER, CHAIN_ID, replayState)
  }

  /** Delegate one request with `messages`; return the history the head adapter saw. */
  async function delegatedHistory(messages: ReturnType<typeof assistantOn>[]) {
    apply(ctx, cfg({ chains: [vChain()] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    await collect(
      ctx.llm.stream({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID, messages }),
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
    // Not covered (introduced by the change that removed the root rewrite — only
    // the cross-adapter-instance rotation subset predates it): a message
    // recorded on a REAL route loses its envelope one gate earlier — on the
    // OUTER pass the target adapter is this virtual adapter, which does not own
    // that historical provider, so `forAdapter` strips it before `stream()` ever
    // receives the history. Before that change the root request carried the head
    // pair, so the outer pass aimed at the head adapter and kept this history;
    // it now always aims at the virtual adapter, so every real-route envelope in
    // a virtual-route session is dropped. No plugin code can recover it on that
    // path (the durable envelope is simply not in the delegated options). Same
    // cross-route boundary as R-004, on the other side of the delegate —
    // documented in docs/configuration.md under the accepted gaps, not fixed here.
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
      source: { kind: 'model', provider: FALLBACKS_PROVIDER, model: CHAIN_ID },
    })
    expect((delegated?.source as { replayState?: unknown }).replayState).toBeUndefined()
  })
})
