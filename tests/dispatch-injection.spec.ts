/**
 * Dispatch-seam mount, wired through the REAL plugin `apply()` (design
 * dsh-022-rc1-upgrade §1.3, direction C).
 *
 * `tests/seam-inject.spec.ts` pins the seam's own decision matrix; this suite
 * pins the WIRING: the seam installed by `apply()` gets the live config, the
 * shared policy reader and the card's `chainHeads` map, so a role-bearing
 * dispatch really lands on the virtual route and the bookkeeping lands in the
 * plugin's own maps (cleaned up on `agent/disposed`).
 *
 * The dispatch side is driven the way the host drives it: a consumer fiber
 * reads `ctx.subagents` and calls `startActivation` through the wrapper.
 *
 * @module tests/dispatch-injection
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FallbacksConfig } from '../src/config.ts'
import { apply, chainHeads } from '../src/index.ts'
import { subagentSeamOf, type SubagentActivationSpecView } from '../src/subagents-seam.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg } from './support/harness.ts'

/** Declared taxonomy: `coder` owns the chain the mount labels as its head. */
const CODER_CHAIN = 'anthropic/claude-sonnet-4'

/** A LOCAL backend — `prepareContinuable` routes the start through `manager.startLocal`. */
const LOCAL_PROVIDER = { prepareContinuable: () => undefined }

/** An EXTERNAL backend: no `prepareContinuable`, so the runtime mints its own child id. */
const EXTERNAL_PROVIDER = { tag: 'external' }

/** A rooted, walkable config. */
function activeConfig(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return cfg({
    rootChain: ['deepseek-official/deepseek-flash'],
    roles: { list: [{ id: 'coder', persona: '', chain: [CODER_CHAIN] }], rules: [] },
    ...overrides,
  })
}

/** One Assignment-shaped prompt carrying the dispatch role field. */
function assignment(executeAs = 'coder'): string {
  return ['## Assignment', '', `- **Execute as**: ${executeAs}`, '', '## Task', '', 'do it'].join('\n')
}

/** One activation spec as a caller hands it to `ctx.subagents.startActivation`. */
function activationSpec(overrides: {
  provider?: string
  childId?: string
  executeAs?: string
  agentOptions?: { provider?: string; model?: string }
} = {}): SubagentActivationSpecView {
  const prompt = assignment(overrides.executeAs)
  return {
    provider: overrides.provider ?? 'spawn',
    label: 'task one',
    ...(overrides.childId === undefined ? {} : { childId: overrides.childId }),
    request: {
      prompt: [{ type: 'text', text: prompt }],
      ...(overrides.agentOptions === undefined ? {} : { agentOptions: overrides.agentOptions }),
    },
  }
}

interface FakeSubagents {
  service: Record<string, unknown>
  activations: SubagentActivationSpecView[]
  mintedChildId: string
}

/** Fake rc.1 `subagents` runtime: records the specs, resolves like `manager.start*`. */
function fakeSubagents(provider: Record<string, unknown>): FakeSubagents {
  const activations: SubagentActivationSpecView[] = []
  const fake: FakeSubagents = { service: {}, activations, mintedChildId: 'minted-child' }
  fake.service = {
    getProvider: () => provider,
    startActivation: async (spec: SubagentActivationSpecView) => {
      activations.push(spec)
      return spec.childId === undefined ? { childId: fake.mintedChildId } : { childId: spec.childId }
    },
  }
  return fake
}

/** Wait one macrotask so a cordis plugin child's `apply` has run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Call `startActivation` through the wrapper a consumer fiber reads. */
async function activate(ctx: Context, spec: SubagentActivationSpecView): Promise<unknown> {
  let consumer: Context | undefined
  ctx.plugin({
    name: 'dispatch-injection-consumer',
    inject: ['subagents'],
    apply(consumerCtx: Context) {
      consumer = consumerCtx
    },
  })
  await nextTick()
  if (consumer === undefined) throw new Error('consumer fiber did not apply')
  const service = (consumer as unknown as { subagents: { startActivation(spec: unknown): unknown } }).subagents
  return service.startActivation(spec)
}

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** Mount the fake runtime, apply the plugin and return the fake. */
function mount(config: FallbacksConfig = activeConfig(), provider: Record<string, unknown> = LOCAL_PROVIDER): FakeSubagents {
  const fake = fakeSubagents(provider)
  ctx.provide('subagents', fake.service)
  apply(ctx, config)
  return fake
}

describe('dispatch-seam mount through apply()', () => {
  it('stamps the virtual route, records the mount and labels the chain head', async () => {
    const fake = mount()

    const result = await activate(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
    const childId = String(received.childId)
    expect(result).toMatchObject({ childId })
    expect(subagentSeamOf(ctx)?.records.get(childId)).toMatchObject({
      role: 'coder',
      virtualRouteInjected: true,
    })
    expect(chainHeads(ctx)?.get(childId)).toEqual({
      at: expect.any(Number),
      route: { provider: 'anthropic', model: 'claude-sonnet-4' },
      source: 'injected',
    })
  })

  it('leaves an explicit spawn route untouched and labels it authorized', async () => {
    const fake = mount()

    await activate(ctx, activationSpec({ agentOptions: { provider: 'openai', model: 'gpt-4o' } }))

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toEqual({ provider: 'openai', model: 'gpt-4o' })
    const childId = String(received.childId)
    expect(subagentSeamOf(ctx)?.records.get(childId)?.virtualRouteInjected).toBeUndefined()
    expect(chainHeads(ctx)?.get(childId)).toMatchObject({
      route: { provider: 'openai', model: 'gpt-4o' },
      source: 'authorized',
    })
  })

  it('never mounts a dispatch that declares no role (the native path is byte-identical)', async () => {
    const fake = mount()
    const spec = activationSpec({ executeAs: 'nobody' })

    await activate(ctx, spec)

    // No role → the caller's OWN spec object reaches the runtime, untouched.
    expect(fake.activations[0]).toBe(spec)
    expect(subagentSeamOf(ctx)?.records.size).toBe(0)
    expect(chainHeads(ctx)?.size).toBe(0)
  })

  it('does not mount on an external backend (pure inheritance)', async () => {
    const fake = mount(activeConfig(), EXTERNAL_PROVIDER)

    await activate(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
    expect(chainHeads(ctx)?.size).toBe(0)
  })

  it('does not mount when the config has no walkable chain at all', async () => {
    const fake = mount(cfg({ rootChain: [], roles: { list: [], rules: [] } }))

    await activate(ctx, activationSpec())

    expect(fake.activations[0]!.request.agentOptions).toBeUndefined()
  })

  it('drops the child bookkeeping on agent/disposed', async () => {
    const fake = mount()
    await activate(ctx, activationSpec())
    const childId = String(fake.activations[0]!.childId)
    expect(chainHeads(ctx)?.has(childId)).toBe(true)

    ctx.emit('agent/disposed', { agent: { id: childId } })

    expect(chainHeads(ctx)?.has(childId)).toBe(false)
    expect(subagentSeamOf(ctx)?.records.has(childId)).toBe(false)
  })
})
