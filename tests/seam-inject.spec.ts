/**
 * Subagent role-chain stamp, `injectRoleChain` (named virtual chains §3):
 * the dispatch seam stamps `{ provider: 'FallbacksChain', model:
 * <role.chain> }` onto a child's creation options
 * (`SubagentStartRequest.agentOptions`, which rc.1's
 * `resolveChildAgentOptions` merges over the parent's route when
 * `manager.startLocal` creates the child).
 *
 * The FOUR conditions are pinned as one case each, plus what the stamp must
 * NOT do: an explicit spawn route wins untouched, an external backend keeps
 * pure inheritance, an undeclared pointer behaves as NOT SPECIFIED, and a
 * contained failure (a throwing config read) forwards the caller's own spec.
 * NO host-policy consultation: the seam never reads a policy and the record
 * carries no `virtualRouteInjected` flag — the mapping is the user's STATIC
 * config.
 *
 * Driven the way the host drives it: `subagents` is provided, the seam is
 * installed, and a CONSUMER fiber injects the service and calls
 * `startActivation` through the wrapper.
 *
 * @module tests/seam-inject
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { OFFICIAL_FLASH } from '../src/time-slots.ts'
import type { FallbacksConfig } from '../src/config.ts'
import {
  installSubagentSeam,
  subagentSeamOf,
  type SubagentActivationSpecView,
  type SubagentSeam,
  type SubagentStartRequestView,
} from '../src/subagents-seam.ts'
import { FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { cfg } from './support/harness.ts'

/** Declared taxonomy: `coder` owns the chain the stamp points at. */
const ROLE_IDS = new Map([['coder', 'coder']])

/** The named chain under test for the `coder` role. */
const CHAIN_ID = 'daily'

/** A LOCAL backend — `prepareContinuable` is what routes a start through `manager.startLocal`. */
const LOCAL_PROVIDER = { prepareContinuable: () => undefined }

/** An EXTERNAL backend: no `prepareContinuable`, so the runtime mints its own child id. */
const EXTERNAL_PROVIDER = { tag: 'external' }

/** A config with one declared chain and a `coder` role pointing at it. */
function activeConfig(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return cfg({
    chains: [{ id: CHAIN_ID, label: 'Test', entries: [OFFICIAL_FLASH], timeSlots: [] }],
    roles: { list: [{ id: 'coder', persona: '', chain: CHAIN_ID }] },
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
  roleIds?: () => ReadonlyMap<string, string>
  debug?: (message: string) => void
}

/** Install the seam over a fake runtime. */
function install(options: InstallOptions = {}): { fake: FakeSubagents; seam: SubagentSeam } {
  const fake = fakeSubagents(options.provider ?? LOCAL_PROVIDER)
  ctx.provide('subagents', fake.service)
  const seam = installSubagentSeam(ctx, {
    roleIds: options.roleIds ?? (() => ROLE_IDS),
    source: options.config ?? (() => activeConfig()),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  })
  return { fake, seam }
}

describe('stamp: the four conditions (§3)', () => {
  it('stamps the role chain on a local dispatch child (specified + declared + no explicit route + local)', async () => {
    const { fake, seam } = install()
    const spec = activationSpec()

    const result = await startThroughWrapper(ctx, spec)

    // The native call received the caller's OWN spec shape plus the named
    // chain pair in `request.agentOptions` — the field rc.1 merges over the
    // parent's route when the child is created.
    const received = fake.activations[0]!
    expect(received.request.agentOptions).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: CHAIN_ID,
    })
    expect(received.childId).toEqual(expect.any(String))
    // The caller's object is never mutated.
    expect(spec.request.agentOptions).toBeUndefined()
    expect(spec).not.toHaveProperty('childId')

    const childId = String(received.childId)
    expect(result).toMatchObject({ childId })
    // No mount verdict exists any more — the record is the role only.
    expect(seam.records.get(childId)).toEqual({
      role: 'coder',
      at: expect.any(Number),
      firstNoticePending: true,
    })
  })

  it('does not stamp when no role resolves (NOT SPECIFIED: spec forwarded unchanged)', async () => {
    const { fake } = install()

    await startThroughWrapper(ctx, activationSpec({ executeAs: 'nobody' }))

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
  })

  it('does not stamp when the role declares NO chain (plugin does not intervene)', async () => {
    const { fake } = install({
      config: () => activeConfig({ roles: { list: [{ id: 'coder', persona: '' }] } }),
    })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
  })

  it('does not stamp when the pointer names an UNDECLARED chain (behaves as NOT SPECIFIED)', async () => {
    const { fake } = install({
      config: () => activeConfig({ roles: { list: [{ id: 'coder', persona: '', chain: 'ghost-chain' }] } }),
      debug: () => {},
    })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
  })

  it('does not stamp when the config has no chains at all (inactive)', async () => {
    const { fake } = install({ config: () => cfg({ chains: [], roles: { list: [{ id: 'coder', persona: '', chain: CHAIN_ID }] } }) })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toBeUndefined()
  })
})

describe('never touched: explicit routes and external backends', () => {
  it('leaves an explicit spawn route alone (explicit wins)', async () => {
    const { fake, seam } = install()
    const spec = activationSpec({ agentOptions: { provider: 'openai', model: 'gpt-4o' } })

    await startThroughWrapper(ctx, spec)

    const received = fake.activations[0]!
    expect(received.request.agentOptions).toEqual({ provider: 'openai', model: 'gpt-4o' })
    const childId = String(received.childId)
    // The role record is still written (identity is independent of routing).
    expect(seam.records.get(childId)).toMatchObject({ role: 'coder' })
  })

  it('does not stamp on an EXTERNAL backend (pure inheritance)', async () => {
    const { fake, seam } = install({ provider: EXTERNAL_PROVIDER })

    await startThroughWrapper(ctx, activationSpec())

    const received = fake.activations[0]!
    expect(received.childId).toBeUndefined()
    expect(received.request.agentOptions).toBeUndefined()
    // The record is keyed off the RESOLVED child id (the runtime minted it).
    expect(seam.records.get(fake.mintedChildId)).toMatchObject({ role: 'coder' })
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
    // The reservation survives (it is seam bookkeeping, not the stamp), and the
    // failure reports exactly one contained line.
    expect(received.childId).toEqual(expect.any(String))
    expect(debug).toHaveLength(1)
  })
})

describe('resume + record', () => {
  it('hands a resume the caller’s own spec and writes only the role record (I-000081)', async () => {
    const { fake, seam } = install()
    await startThroughWrapper(ctx, activationSpec({ agentOptions: { provider: 'openai', model: 'gpt-4o' } }))
    const childId = String(fake.activations[0]!.childId)

    // A resume: the caller reserves the SAME child id and carries no Assignment
    // header at all — the record is the only role memory. The activation
    // creates nothing, so it is NOT a fresh dispatch: it must not stamp.
    const resume = { provider: 'spawn', label: 'resume', childId, request: { prompt: [] } }
    await startThroughWrapper(ctx, resume)

    expect(fake.activations[1]).toBe(resume)
    expect(seam.records.get(childId)).toEqual({
      role: 'coder',
      at: expect.any(Number),
      firstNoticePending: true,
    })
  })

  it('a resume of a stamped child injects nothing', async () => {
    const { fake } = install()
    await startThroughWrapper(ctx, activationSpec())
    const childId = String(fake.activations[0]!.childId)
    expect(fake.activations[0]!.request.agentOptions).toEqual({ provider: FALLBACKS_PROVIDER, model: CHAIN_ID })

    const resume = { provider: 'spawn', label: 'resume', childId, request: { prompt: [] } }
    await startThroughWrapper(ctx, resume)

    // The native call received the resume UNCHANGED — byte-identical object.
    expect(fake.activations[1]).toBe(resume)
  })

  it('exposes the install through the root-shared seam handle (subagentSeamOf)', () => {
    install()
    expect(subagentSeamOf(ctx)).toBeDefined()
  })
})
