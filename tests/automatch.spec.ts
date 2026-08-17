/**
 * LLM auto-match role selection unit tests (plan fallbacks-role-automatch
 * Task 3).
 *
 * `pickRoleByLlm` is the bounded LLM caller behind the resolver's stage-3
 * auto-match hook: it builds the declared-role taxonomy prompt (ids +
 * personas + agent origin/agentPreset context), streams ONE bounded
 * completion via the optional `ctx.get('llm')` service, and parses a declared
 * role id out of the answer. Every failure mode — empty taxonomy, absent
 * `llm` service, no provider/model route, throw, timeout, garbage answer,
 * `none` — resolves to `null` (the resolver's `'inherit'` fallback) and the
 * function NEVER throws. Provider/model for the judgment call is chosen from
 * the roles' declared chains (first exact selector) when possible, else the
 * agent's current `options.provider`/`options.model`, else skip (`null`).
 *
 * The LLM is ALWAYS a stub here — no real network call ever runs.
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AUTOMATCH_MAX_TOKENS,
  AUTOMATCH_TIMEOUT_MS,
  buildAutomatchPrompt,
  parseAutomatchAnswer,
  pickRoleByLlm,
  type AutomatchContext,
  type AutomatchLlm,
} from '../src/automatch.ts'
import type { FallbacksRole, FallbacksRoles } from '../src/config.ts'
import type { AgentLike } from '../src/roles.ts'

/**
 * Declared taxonomy under test. `coder-qa` is declared PADDED (`' coder-qa '`)
 * so the raw-id canonicalization path (trimmed key → declared raw id, the same
 * map the resolver uses) is exercised. Chain order matters for the judgment
 * route: the first exact (non-wildcard) selector in declaration order is
 * `anthropic/claude-sonnet-4` (coder), followed by a `provider/*` wildcard
 * (not a concrete route) in `coder-qa`.
 */
const ROLES: FallbacksRoles = {
  list: [
    { id: 'coder', persona: 'Coding implementer.', chain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'] },
    { id: 'code-review', persona: 'Reviews code and findings.', chain: ['openai/gpt-4o'] },
    { id: ' coder-qa ', persona: 'Quality assurance.', chain: ['provider/*', 'google/gemini-1.5-pro'] },
  ],
  rules: [],
}

/** Trimmed-id → declared-raw-id map (same canonicalization as the resolver). */
const ROLE_IDS = new Map([
  ['coder', 'coder'],
  ['code-review', 'code-review'],
  ['coder-qa', ' coder-qa '],
])

const AGENT: AgentLike = { options: { provider: 'google', model: 'gemini-1.5-pro' }, session: { header: { origin: 'subagent', agentPreset: 'general' } } }

function asyncIter(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Scripted llm double; records every `GenerateOptions` passed to `stream`. */
function makeFake(streamFn: (options: GenerateOptions) => AsyncIterable<StreamChunk>): {
  stream: AutomatchLlm['stream']
  calls: GenerateOptions[]
} {
  const calls: GenerateOptions[] = []
  const stream = vi.fn((options: GenerateOptions) => {
    calls.push(options)
    return streamFn(options)
  })
  return { stream, calls }
}

function fakeCtx(llm: AutomatchLlm | undefined): AutomatchContext {
  return { get: (name: string) => (name === 'llm' ? llm : undefined) }
}

const CODER_ANSWER: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'co' },
  { type: 'text-delta', index: 0, text: 'der' },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('buildAutomatchPrompt', () => {
  it('lists every declared id (trimmed) and persona', () => {
    const prompt = buildAutomatchPrompt(ROLES.list, AGENT)
    expect(prompt).toContain('coder')
    expect(prompt).toContain('Coding implementer.')
    expect(prompt).toContain('code-review')
    expect(prompt).toContain('coder-qa')
    expect(prompt).toContain('Quality assurance.')
  })

  it('includes the agent origin and agentPreset context', () => {
    const prompt = buildAutomatchPrompt(ROLES.list, AGENT)
    expect(prompt).toContain('origin: subagent')
    expect(prompt).toContain('agentPreset: general')
  })

  it('instructs exactly-one-declared-id-or-none', () => {
    const prompt = buildAutomatchPrompt(ROLES.list, AGENT)
    expect(prompt).toMatch(/EXACTLY ONE/)
    expect(prompt).toContain('"none"')
  })

  it('omits the agentPreset line when the preset is absent/empty', () => {
    const prompt = buildAutomatchPrompt(ROLES.list, { session: { header: { origin: 'root' } } })
    expect(prompt).not.toContain('agentPreset:')
    expect(prompt).toContain('origin: root')
  })
})

describe('parseAutomatchAnswer', () => {
  it('accepts an id with surrounding whitespace, quotes, backticks and punctuation', () => {
    expect(parseAutomatchAnswer('  "coder"  ', ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer("'coder'", ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer('`coder`', ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer(' coder,', ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer('(coder)', ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer('coder.', ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer('coder ', ROLE_IDS)).toBe('coder')
  })

  it('is case-insensitive on the id', () => {
    expect(parseAutomatchAnswer('Coder', ROLE_IDS)).toBe('coder')
    expect(parseAutomatchAnswer('CODE-REVIEW', ROLE_IDS)).toBe('code-review')
  })

  it('canonicalizes to the declared RAW id for a padded declared id', () => {
    expect(parseAutomatchAnswer('coder-qa', ROLE_IDS)).toBe(' coder-qa ')
    expect(parseAutomatchAnswer(' coder-qa ', ROLE_IDS)).toBe(' coder-qa ')
  })

  it("returns null for the 'none' decline token (case-insensitive)", () => {
    expect(parseAutomatchAnswer('none', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('None', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('"NONE"', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer(' none. ', ROLE_IDS)).toBeNull()
  })

  it('rejects unknown / malformed answers', () => {
    expect(parseAutomatchAnswer('ghost', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('coderx', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('the best role is coder', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('   ', ROLE_IDS)).toBeNull()
    expect(parseAutomatchAnswer('---', ROLE_IDS)).toBeNull()
  })
})

describe('pickRoleByLlm — fast paths', () => {
  it('returns null for an empty taxonomy without touching the LLM', async () => {
    const { stream } = makeFake(() => asyncIter([]))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), { list: [], rules: [] }, AGENT, { warn })).resolves.toBeNull()
    expect(stream).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns null without warning when ctx.llm is absent', async () => {
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx(undefined), ROLES, AGENT, { warn })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips without an LLM call when no provider/model route can be chosen', async () => {
    const { stream } = makeFake(() => asyncIter([]))
    const warn = vi.fn()
    const roles: FallbacksRoles = { list: [{ id: 'coder', persona: 'x' }], rules: [] }
    await expect(pickRoleByLlm(fakeCtx({ stream }), roles, {}, { warn })).resolves.toBeNull()
    expect(stream).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('never throws — a throwing ctx.get resolves to null', async () => {
    const warn = vi.fn()
    const ctx: AutomatchContext = {
      get: () => {
        throw new Error('context exploded')
      },
    }
    await expect(pickRoleByLlm(ctx, ROLES, AGENT, { warn })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('pickRoleByLlm — judgment call', () => {
  it('picks a declared role id from a stub stream', async () => {
    const { stream, calls } = makeFake((options) => asyncIter(CODER_ANSWER))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { timeoutMs: 1000, warn })).resolves.toBe('coder')
    expect(stream).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(calls[0].maxTokens).toBe(AUTOMATCH_MAX_TOKENS)
    expect(calls[0].system).toContain('coder')
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('prefers a roles-declared route over the agent options for the judgment call', async () => {
    const { stream, calls } = makeFake((options) => asyncIter(CODER_ANSWER))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { timeoutMs: 1000, warn })).resolves.toBe('coder')
    // First exact (non-wildcard) selector in declaration order is coder's head.
    expect(calls[0].provider).toBe('anthropic')
    expect(calls[0].model).toBe('claude-sonnet-4')
  })

  it('falls back to the agent current provider/model when roles declare no chains', async () => {
    const roles: FallbacksRoles = { list: [{ id: 'coder', persona: 'x' }], rules: [] }
    const { stream, calls } = makeFake((options) => asyncIter(CODER_ANSWER))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), roles, AGENT, { timeoutMs: 1000, warn })).resolves.toBe('coder')
    expect(calls[0].provider).toBe('google')
    expect(calls[0].model).toBe('gemini-1.5-pro')
  })

  it('returns null for a garbage answer', async () => {
    const { stream } = makeFake(() =>
      asyncIter([{ type: 'text-delta', index: 0, text: 'no matching role here' }, { type: 'finish', reason: { kind: 'stop' } }]),
    )
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { timeoutMs: 1000, warn })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns null for an empty model reply', async () => {
    const { stream } = makeFake(() => asyncIter([{ type: 'finish', reason: { kind: 'stop' } }]))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { timeoutMs: 1000, warn })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns null on a terminal error finish (adapter failure), even with partial text', async () => {
    const { stream } = makeFake(() =>
      asyncIter([
        { type: 'text-delta', index: 0, text: 'co' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'quota', code: 'QUOTA' } } },
      ]),
    )
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { timeoutMs: 1000, warn })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns null when the stub stream throws, warns, and does not rethrow', async () => {
    const { stream } = makeFake(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('provider exploded')
      },
    }))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { warn })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed'))
  })

  it('times out, abandons the stream, warns, and returns null', async () => {
    const { stream, calls } = makeFake((options) => ({
      async *[Symbol.asyncIterator]() {
        // A stream that never finishes but honors options.signal — the real
        // dsh-llm contract. It terminates only when the timeout aborts it.
        const signal = options.signal
        if (signal === undefined) throw new Error('expected a timeout signal')
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('aborted by timeout')
      },
    }))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { timeoutMs: 20, warn })).resolves.toBeNull()
    expect(stream).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    // The completion was abandoned: the signal we passed was actually aborted.
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('uses the default 5s timeout when timeoutMs is omitted', async () => {
    expect(AUTOMATCH_TIMEOUT_MS).toBe(5000)
    // The default is threaded through the stream options only as an internal
    // timer — the public contract (opts.timeoutMs optional) is type-checked.
    const { stream } = makeFake((options) => asyncIter(CODER_ANSWER))
    const warn = vi.fn()
    await expect(pickRoleByLlm(fakeCtx({ stream }), ROLES, AGENT, { warn })).resolves.toBe('coder')
  })
})

describe('pickRoleByLlm — types', () => {
  it('the real cordis Context satisfies AutomatchContext', () => {
    // Compile-time guard for the Task-4 wiring: the real cordis `Context.get`
    // (ReflectService overloads, `any` for the string face, merged `llm`
    // service for the literal face) must be directly passable as `ctx`.
    expectTypeOf<Context>().toMatchTypeOf<AutomatchContext>()
    const llmLike: AutomatchLlm = { stream: () => asyncIter([]) }
    expectTypeOf(llmLike).toMatchTypeOf<AutomatchLlm>()
  })

  it('roles.list type is the declared FallbacksRole list', () => {
    expectTypeOf<FallbacksRole>().toMatchTypeOf<{ id: string; persona: string; chain?: string[] }>()
  })
})
