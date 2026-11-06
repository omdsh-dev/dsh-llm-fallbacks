/**
 * End-to-end direction C integration (plan dsh-022-rc1-upgrade): a dispatch
 * child is MOUNTED on the virtual row by the seam, and its virtual-route
 * request WALKS the role chain inside the adapter (real `LlmRuntime`, scripted
 * per-provider adapters, a registry-backed agent view).
 *
 * The config here holds its ONLY chain in `roles.list` (empty `rootChain`) —
 * the production shape for a subagent deployment, and the exact shape that
 * used to fail with `EMPTY_EFFECTIVE_CHAIN` before the walk owned the guards
 * (R-2).
 *
 * @module tests/dispatch-integration
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
import { SUBAGENT_POLICY_SETTINGS_NS } from '../src/gateway.ts'
import { apply } from '../src/index.ts'
import type { SubagentActivationSpecView } from '../src/subagents-seam.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER } from '../src/virtual-adapter.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg } from './support/harness.ts'

const TEXT: StreamChunk = { type: 'text-delta', index: 0, text: 'ok' }
const STOP: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

/** One scripted attempt: chunks, then either a throw or a clean end. */
interface ScriptedAttempt {
  chunks?: StreamChunk[]
  failure?: { code: string; message?: string }
}

/** Scripted adapter for every real route the scenarios use. */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  respond: (options: GenerateOptions) => ScriptedAttempt = () => ({ chunks: [TEXT, STOP] })

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const attempt = this.respond(options)
    for (const chunk of attempt.chunks ?? []) yield chunk
    if (attempt.failure !== undefined) throw new LlmError(attempt.failure.message ?? attempt.failure.code, attempt.failure.code)
  }
}

/** The `provider/model` pairs the walk dispatched, in order. */
function dispatched(adapter: ScriptedAdapter): string[] {
  return adapter.calls.map((call) => `${call.provider}/${call.model}`)
}

/** Drain a chunk stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** One fake agent the `agents` registry serves (the walk's session view). */
interface AgentViewShape {
  id: string
  options: { provider: string; model: string }
  session: { header: { origin: 'subagent' }; snapshotEvents(): unknown[] }
}

/** The config under test: the ONLY chain lives in `roles.list` (roles-only). */
function rolesOnlyConfig(): FallbacksConfig {
  return cfg({
    rootChain: [],
    roles: { list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-sonnet-4', 'other/gpt-4o'] }], rules: [] },
  })
}

interface FakeSubagents {
  service: Record<string, unknown>
  activations: SubagentActivationSpecView[]
}

/** Fake `subagents` runtime: hands back the reserved child id, like `manager.startLocal`. */
function fakeSubagents(): FakeSubagents {
  const activations: SubagentActivationSpecView[] = []
  return {
    activations,
    service: {
      getProvider: () => ({ prepareContinuable: () => undefined }),
      startActivation: async (spec: SubagentActivationSpecView) => {
        activations.push(spec)
        return { childId: spec.childId }
      },
    },
  }
}

/** Wait one macrotask so a cordis plugin child's `apply` has run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let ctx: Context
let adapter: ScriptedAdapter
let views: Map<string, AgentViewShape>
let fake: FakeSubagents

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
  new LlmRuntime(ctx)
  adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['anthropic', 'other'], adapter)
  views = new Map()
  ctx.provide('agents', { get: (id: string) => views.get(id) })
  fake = fakeSubagents()
  ctx.provide('subagents', fake.service)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** Dispatch one child through the seam and register its agent view; returns its id. */
async function mountChild(config: FallbacksConfig): Promise<string> {
  apply(ctx, config)
  let consumer: Context | undefined
  ctx.plugin({
    name: 'dispatch-integration-consumer',
    inject: ['subagents'],
    apply(consumerCtx: Context) {
      consumer = consumerCtx
    },
  })
  await nextTick()
  if (consumer === undefined) throw new Error('consumer fiber did not apply')
  const service = (consumer as unknown as { subagents: { startActivation(spec: unknown): unknown } }).subagents
  const result = await service.startActivation({
    provider: 'spawn',
    label: 'task one',
    request: { prompt: [{ type: 'text', text: '## Assignment\n\n**Execute as**: coder\n' }] },
  }) as { childId: string }
  views.set(result.childId, {
    id: result.childId,
    options: { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL },
    session: { header: { origin: 'subagent' }, snapshotEvents: () => [] },
  })
  return result.childId
}

/** Stream one virtual-route request for a mounted child. */
function streamChild(childId: string): Promise<StreamChunk[]> {
  return collect(ctx.llm.stream({
    provider: FALLBACKS_PROVIDER,
    model: FALLBACKS_CHAIN_MODEL,
    sessionId: SessionId(childId),
    messages: [],
  }))
}

describe('an injected child walks its role chain (roles-only config, R-2)', () => {
  it('mounts the child and serves the first attempt from the role chain', async () => {
    const childId = await mountChild(rolesOnlyConfig())
    expect(fake.activations[0]!.request.agentOptions).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })

    const chunks = await streamChild(childId)

    expect(dispatched(adapter)).toEqual(['anthropic/claude-sonnet-4'])
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('advances to the next role-chain candidate on a trigger failure', async () => {
    const childId = await mountChild(rolesOnlyConfig())
    adapter.respond = (options) => options.model === 'claude-sonnet-4'
      ? { failure: { code: 'AUTH', message: 'down' } }
      : { chunks: [TEXT, STOP] }

    const chunks = await streamChild(childId)

    expect(dispatched(adapter)).toEqual(['anthropic/claude-sonnet-4', 'other/gpt-4o'])
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('intersects switch targets with the host allowlist when the policy is enabled', async () => {
    // Policy from the settings snapshot (no session event on the fake child).
    ;(ctx.get('settings') as MemorySettings).seed(SUBAGENT_POLICY_SETTINGS_NS, {
      enabled: true,
      allowedModels: [{ provider: 'other', model: 'gpt-4o' }],
    })
    const childId = await mountChild(rolesOnlyConfig())
    adapter.respond = () => ({ failure: { code: 'AUTH', message: 'down' } })

    await streamChild(childId)

    // `other/gpt-4o` is the only allowed switch target; the walk stops there.
    expect(dispatched(adapter)).toEqual(['anthropic/claude-sonnet-4', 'other/gpt-4o'])
  })

  it('keeps the virtual pair as the session selection (no model/selection write)', async () => {
    const childId = await mountChild(rolesOnlyConfig())
    await streamChild(childId)

    // The chain advance is a walk, not a selection: the recorded route stays
    // the virtual pair, so the host's selection notice never re-arms.
    expect(views.get(childId)?.options).toEqual({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
    })
  })
})

describe('root sessions on the virtual row keep their all-day chain', () => {
  it('walks the conforming all-day chain for a root session', async () => {
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    apply(ctx, cfg({ rootChain: ['deepseek-official/deepseek-flash'] }))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels(FALLBACKS_PROVIDER)).length).toBe(1)
    })

    const chunks = await collect(ctx.llm.stream({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
      sessionId: SessionId('root-session'),
      messages: [],
    }))

    expect(dispatched(adapter)).toEqual(['deepseek-official/deepseek-flash'])
    expect(chunks).toEqual([TEXT, STOP])
  })

  it('keeps the all-day conformance gate for a legacy multi-model chain', async () => {
    apply(ctx, cfg({ rootChain: ['other/gpt-4o', 'anthropic/claude-sonnet-4'] }))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels(FALLBACKS_PROVIDER)).length).toBe(1)
    })

    const chunks = await collect(ctx.llm.stream({
      provider: FALLBACKS_PROVIDER,
      model: FALLBACKS_CHAIN_MODEL,
      sessionId: SessionId('root-session'),
      messages: [],
    }))

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNDISPATCHABLE_EFFECTIVE_HEAD' } },
    })
    expect(adapter.calls).toHaveLength(0)
  })
})
