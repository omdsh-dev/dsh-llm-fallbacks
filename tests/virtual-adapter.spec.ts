/**
 * Virtual `FallbacksChain/Auto` adapter tests (plan fallbacks-virtual-chain
 * Task 1; PR #62 feedback round): the P2 registration lifecycle (listed
 * whenever enabled — conformance is NOT part of registration; idempotent
 * transition-reconcile; multi-fiber dedupe; slot/chain edits never churn)
 * and the P1/P3 adapter contract (one catalog row; `stream()` is a thin
 * head-delegate through the host LLM runtime, gated on a conforming
 * all-day; `resolveModel` proxies the current effective head with a
 * permissive fallback).
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
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { OFFICIAL_V4_FLASH } from '../src/time-slots.ts'
import {
  EMPTY_EFFECTIVE_CHAIN_CODE,
  FALLBACKS_CHAIN_MODEL,
  FALLBACKS_PROVIDER,
  installFallbacksAdapter,
  pickerDisplayName,
  UNDISPATCHABLE_HEAD_CODE,
} from '../src/virtual-adapter.ts'
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg } from './support/harness.ts'

const HEAD_PROVIDER = 'deepseek-official'
const HEAD_MODEL = 'deepseek-v4-flash'

/** Stub adapter for the real head provider — records delegated calls. */
class StubHeadAdapter extends LlmAdapter {
  readonly calls: Array<{ provider: string; model: string; options: GenerateOptions }> = []

  constructor(public info: Partial<LlmResolvedModelInfo> = {}) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'DeepSeek Official' }
  }

  override listModels() {
    return Promise.resolve([{ provider: HEAD_PROVIDER, id: HEAD_MODEL, name: 'DeepSeek V4 Flash' }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, ...this.info })
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
  return ctx.llm.listProviders().some((provider) => provider.id === FALLBACKS_PROVIDER)
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
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(ctx.llm.listProviders().find((provider) => provider.id === FALLBACKS_PROVIDER)).toEqual({
      id: FALLBACKS_PROVIDER,
      name: 'FallbacksChain',
    })
  })

  it('hides the row when the plugin is disabled', () => {
    apply(ctx, cfg({ enabled: false, rootChain: [OFFICIAL_V4_FLASH] }))
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
      expect(() => apply(bare, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))).not.toThrow()
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('dedupes a duplicate registration (DUPLICATE_ADAPTER caught, first fiber owns the route)', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(() => apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))).not.toThrow()
    expect(ctx.llm.listProviders().filter((provider) => provider.id === FALLBACKS_PROVIDER)).toHaveLength(1)
    expect(listed()).toBe(true)
  })

  it('disabling unregisters the row and re-enabling re-registers it', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { enabled: false })
    expect(listed()).toBe(false)

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { enabled: true })
    expect(listed()).toBe(true)
  })

  it('all-day conformance loss keeps the row registered (enabled-only gate)', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { rootChain: ['other/gpt-4o', 'other/gpt-5'] })
    expect(listed()).toBe(true)
  })

  it('slot-row edits never churn registration', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    const updated: number[] = []
    ctx.events.on('llm/adapters-updated', () => updated.push(updated.length))

    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', chain: [OFFICIAL_V4_FLASH] }],
    })
    // The condition deliberately ignores timeSlots — no register/unregister churn.
    expect(updated).toHaveLength(0)
    expect(listed()).toBe(true)
  })
})

describe('adapter contract (P1/P3)', () => {
  it('advertises exactly the one virtual catalog row', async () => {
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
    await vi.waitFor(() => expect(listed()).toBe(true))
    expect(await ctx.llm.listModels(FALLBACKS_PROVIDER)).toEqual([
      {
        provider: FALLBACKS_PROVIDER,
        id: FALLBACKS_CHAIN_MODEL,
        // All-day winner (no extra slots) — host picker trigger is this name.
        name: `${FALLBACKS_CHAIN_MODEL}: ${HEAD_MODEL}[all-day]`,
      },
    ])
  })
  it('pickerDisplayName annotates the matching slot + head model', () => {
    // 10:00 Asia/Shanghai = 02:00Z — inside Liang Peak (09:00–12:00).
    const now = new Date('2026-08-18T02:00:00Z')
    const name = pickerDisplayName(cfg({
      rootChain: [OFFICIAL_V4_FLASH],
      timeSlots: [{ kind: 'preset', preset: 'liang-peak', days: [], chain: [OFFICIAL_V4_FLASH] }],
    }), now)
    expect(name).toBe(`${FALLBACKS_CHAIN_MODEL}: ${HEAD_MODEL}[Liang Peak]`)
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
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
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
      apply(bare, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
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
    apply(ctx, cfg({ rootChain: [OFFICIAL_V4_FLASH] }))
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

  it('resolveModel and stream() use the same exact head as the root request override (wildcard-first chain)', async () => {
    // The same wildcard-first slot chain the select-is-primary override test
    // uses (tests/index-request.spec.ts, "picks the FIRST exact head,
    // skipping earlier wildcard entries"): the leading `other/*` is never a
    // dispatch target, so BOTH delegate paths must land on
    // `anthropic/claude-sonnet-4` — the head the root override resolves to.
    const anthropicStub = new StubHeadAdapter({ name: 'Claude Sonnet 4' })
    ctx.llm.registerAdapter(['anthropic'], anthropicStub)
    apply(
      ctx,
      cfg({
        rootChain: [OFFICIAL_V4_FLASH],
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

  it('stream() throws an explicit LlmError when the effective chain is empty', async () => {
    const config: FallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: [OFFICIAL_V4_FLASH],
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
        rootChain: [OFFICIAL_V4_FLASH],
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
        rootChain: [OFFICIAL_V4_FLASH],
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
