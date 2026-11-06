/**
 * Subagent virtual-chain mount, design dsh-022-rc1-upgrade §1.3 (direction C):
 * the dispatch seam stamps `FallbacksChain/Auto` onto a child's creation
 * options (`SubagentStartRequest.agentOptions`, which rc.1's
 * `resolveChildAgentOptions` merges over the parent's route when
 * `manager.startLocal` creates the child).
 *
 * The five conditions are pinned as one case each, plus what the mount must
 * NOT do: an explicit spawn route is the authorized route (never touched), an
 * external backend keeps pure inheritance, and a contained failure (a throwing
 * config read) forwards the caller's own spec. The record and the card label
 * are asserted through their observable surfaces: `SubagentSeamRecord`
 * (`virtualRouteInjected`, sticky across the resume rewrite) and the
 * `chainHeads` map (`injected` / `authorized`).
 *
 * Driven the way the host drives it: `subagents` is provided, the seam is
 * installed, and a CONSUMER fiber injects the service and calls
 * `startActivation` through the wrapper.
 *
 * @module tests/seam-inject
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FallbacksConfig } from '../src/config.ts'
import type { EffectiveChainHead } from '../src/state.ts'
import type { EffectivePolicy } from '../src/subagent-policy.ts'
import {
  installSubagentSeam,
  subagentSeamOf,
  type SubagentActivationSpecView,
  type SubagentSeam,
  type SubagentStartRequestView,
} from '../src/subagents-seam.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { cfg } from './support/harness.ts'

/** Declared taxonomy: `coder` owns the chain the mount labels as its head. */
const ROLE_IDS = new Map([['coder', 'coder']])

/** The chain under test for the `coder` role. */
const CODER_CHAIN = 'anthropic/claude-sonnet-4'

/** A LOCAL backend — `prepareContinuable` is what routes a start through `manager.startLocal`. */
const LOCAL_PROVIDER = { prepareContinuable: () => undefined }

/** An EXTERNAL backend: no `prepareContinuable`, so the runtime mints its own child id. */
const EXTERNAL_PROVIDER = { tag: 'external' }

/** A rooted config with a walkable `coder` role chain. */
function activeConfig(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return cfg({
    rootChain: ['deepseek-official/deepseek-flash'],
    roles: { list: [{ id: 'coder', persona: '', chain: [CODER_CHAIN] }], rules: [] },
    ...overrides,
  })
}

/** One Assignment-shaped prompt carrying the dispatch role field. */
function assignment(executeAs: string): string {
  return ['## Assignment', '', `- **Execute as**: ${executeAs}`, '', '## Task', '', 'do it'].join('\n')
}

/** One activation spec as a caller hands it to `ctx.subagents.startActivation`. */
function activationSpec(
  overrides: {
    provider?: string
    label?: string
    childId?: string
    executeAs?: string
    agentOptions?: { provider?: string; model?: string }
  } = {},
): SubagentActivationSpecView & { request: SubagentStartRequestView } {
  const prompt = assignment(overrides.executeAs ?? 'coder')
  return {
    provider: overrides.provider ?? 'spawn',
    label: overrides.label ?? 'task one',
    ...(overrides.childId === undefined ? {} : { childId: overrides.childId }),
    request: {
      prompt: [{ type: 'text', text: prompt }],
      ...(overrides.agentOptions === undefined ? {} : { agentOptions: overrides.agentOptions }),
    },
  }
}

/** One captured activation on the fake runtime. */
interface FakeSubagents {
  service: Record<string, unknown>
  /** The activation specs the native path received, in call order. */
  activations: SubagentActivationSpecView[]
  /** The child id the runtime reports for a start it minted itself (external). */
  mintedChildId: string
}

/**
 * Fake rc.1 `subagents` runtime: records every activation spec it receives and
 * resolves like the real runtime — a CALLER-reserved `childId` IS the child's
 * id (`manager.startLocal`), an external backend reports its own.
 */
function fakeSubagents(provider: Record<string, unknown>): FakeSubagents {
  const activations: SubagentActivationSpecView[] = []
  const fake: FakeSubagents = { service: {}, activations, mintedChildId: 'minted-child' }
  fake.service = {
    tag: 'raw-subagents',
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

/** Read `ctx.subagents` the way the host does and call `startActivation` through the wrapper. */
async function startThroughWrapper(ctx: Context, spec: unknown): Promise<unknown> {
  let consumer: Context | undefined
  ctx.plugin({
    name: 'seam-inject-consumer',
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
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

interface InstallOptions {
  provider?: Record<string, unknown>
  config?: () => FallbacksConfig
  policyFor?: (agentId: string) => EffectivePolicy
  debug?: (message: string) => void
}

/** Install the seam over a fake runtime; returns the fake, the seam and the head labels. */
function install(options: InstallOptions = {}): {
  fake: FakeSubagents
  seam: SubagentSeam
  chainHeads: Map<string, EffectiveChainHead>
} {
  const fake = fakeSubagents(options.provider ?? LOCAL_PROVIDER)
  ctx.provide('subagents', fake.service)
  const chainHeads = new Map<string, EffectiveChainHead>()
  const seam = installSubagentSeam(ctx, {
    roleIds: () => ROLE_IDS,
    source: options.config ?? (() => activeConfig()),
    policyFor: options.policyFor ?? (() => ({ state: 'disabled' })),
    chainHeads,
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  })
  return { fake, seam, chainHeads }
}

describe('mount: the five conditions (§1.3)', () => {
  it('stamps the virtual route on a local dispatch child and records the mount + head label', async () => {
    const { fake, seam, chainHeads } = install()
    const spec = activationSpec()

    const result = await startThroughWrapper(ctx, spec)

    // The native call received the caller's OWN spec shape plus the virtual
    // pair in `request.agentOptions` — the field rc.1 merges over the parent's
    // route when the child is created.
    const received = fake.activations[0]!
    expect(received.request.agentOptions).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
    expect(received.childId).toEqual(expect.any(String))
    // The caller's object is never mutated.
    expect(spec.request.agentOptions).toBeUndefined()
    expect(spec).not.toHaveProperty('childId')

    const childId = String(received.childId)
    expect(result).toMatchObject({ childId })
    expect(seam.records.get(childId)).toMatchObject({ role: 'coder', virtualRouteInjected: true })
    // The card label: the head this child's chain will actually be served by.
    expect(chainHeads.get(childId)).toEqual({
      at: expect.any(Number),
      route: { provider: 'anthropic', model: 'claude-sonnet-4' },
      source: 'injected',
    })
  })

  it('does not inject when the config is inactive (nothing to walk)', async () => {
    const { fake, seam } = install({
      // The role still resolves (its id map is live), but nothing is configured.
      config: () => cfg({ rootChain: [], roles: { list: [], rules: [] } }),
    })
    const spec = activationSpec()

    await startThroughWrapper(ctx, spec)

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
    expect(seam.records.get(String(received.childId))?.virtualRouteInjected).toBeUndefined()
  })

  it('does not inject when the resolved role chain has no dispatchable exact head', async () => {
    const { fake, seam } = install({
      config: () => activeConfig({
        rootChain: [],
        roles: { list: [{ id: 'coder', persona: '', chain: ['anthropic/*'] }], rules: [] },
      }),
    })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
    expect(seam.records.get(String(received.childId))?.virtualRouteInjected).toBeUndefined()
  })

  it('skips the mount when the subagent policy is unprovable (fail-closed)', async () => {
    const { fake, seam, chainHeads } = install({
      policyFor: () => ({ state: 'unprovable' }),
      debug: () => {},
    })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
    expect(seam.records.get(String(received.childId))?.virtualRouteInjected).toBeUndefined()
    expect(chainHeads.size).toBe(0)
  })

  it('mounts under an enabled policy too (the walk filters switches, not the mount)', async () => {
    const { fake } = install({
      policyFor: () => ({ state: 'enabled', allowedModels: [{ provider: 'b', model: '2' }] }),
    })

    await startThroughWrapper(ctx, activationSpec())

    expect(fake.activations[0]!.request.agentOptions).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
  })
})

describe('never touched: explicit routes and external backends', () => {
  it('leaves an explicit spawn route alone and labels it authorized', async () => {
    const { fake, seam, chainHeads } = install()
    const spec = activationSpec({ agentOptions: { provider: 'openai', model: 'gpt-4o' } })

    await startThroughWrapper(ctx, spec)

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toEqual({ provider: 'openai', model: 'gpt-4o' })
    const childId = String(received.childId)
    expect(seam.records.get(childId)?.virtualRouteInjected).toBeUndefined()
    expect(chainHeads.get(childId)).toMatchObject({
      route: { provider: 'openai', model: 'gpt-4o' },
      source: 'authorized',
    })
  })

  it('does not inject on an EXTERNAL backend (pure inheritance, documented degradation)', async () => {
    const { fake, seam, chainHeads } = install({ provider: EXTERNAL_PROVIDER })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.childId).toBeUndefined()
    expect(received.request.agentOptions).toBeUndefined()
    // The record is keyed off the RESOLVED child id (the runtime minted it).
    expect(seam.records.get(fake.mintedChildId)?.virtualRouteInjected).toBeUndefined()
    expect(chainHeads.size).toBe(0)
  })

  it('forwards the caller’s own spec when the config read throws (contained degrade)', async () => {
    const debug: string[] = []
    const { fake } = install({
      config: () => {
        throw new Error('config unavailable')
      },
      debug: (message) => debug.push(message),
    })
    const spec = activationSpec()

    await startThroughWrapper(ctx, spec)

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
    // The reservation survives (it is seam bookkeeping, not the mount), and the
    // failure reports exactly one contained line.
    expect(received.childId).toEqual(expect.any(String))
    expect(debug).toHaveLength(1)
  })
})

describe('resume + record stickiness', () => {
  it('resolves the role from the record for a header-less resume and mounts it', async () => {
    const { fake, seam } = install()
    const first = activationSpec()
    await startThroughWrapper(ctx, first)
    const childId = String(fake.activations[0]!.childId)

    // A resume: the caller reserves the SAME child id and carries no Assignment
    // header at all — the record is the only role memory.
    const resume = { provider: 'spawn', label: 'resume', childId, request: { prompt: [] } }
    await startThroughWrapper(ctx, resume)

    const received = fake.activations[1]!
    expect(received.childId).toBe(childId)
    expect(received.request.agentOptions).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
    expect(seam.records.get(childId)).toMatchObject({ role: 'coder', virtualRouteInjected: true })
  })

  it('keeps the mount verdict across a rewrite that carries no verdict of its own', async () => {
    const { fake, seam } = install()
    await startThroughWrapper(ctx, activationSpec())
    const childId = String(fake.activations[0]!.childId)
    expect(seam.records.get(childId)?.virtualRouteInjected).toBe(true)

    // A second dispatch under the same reserved id that does NOT mount (an
    // explicit route): the sticky flag must survive the rewrite.
    await startThroughWrapper(ctx, activationSpec({
      childId,
      agentOptions: { provider: 'openai', model: 'gpt-4o' },
    }))

    expect(seam.records.get(childId)).toMatchObject({ virtualRouteInjected: true })
  })

  it('exposes the install through the root-shared seam handle (subagentSeamOf)', () => {
    install()
    expect(subagentSeamOf(ctx)).toBeDefined()
  })
})
