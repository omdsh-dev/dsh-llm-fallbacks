/**
 * Dispatch-seam role resolution + per-child record (plan
 * role-based-subagent-adoption Task 1; Task 4 extends, never replaces).
 *
 * PRIMARY coverage is behavioural and public-path: the seam is exercised the
 * way the host exercises it — the `subagents` service is provided, the seam is
 * installed (on a plugin child fiber, exactly as `apply()` does), and a
 * consumer that injects `subagents` CALLS `ctx.subagents.start` /
 * `startContinuable`. Assertions are on observable effects: the wrapped call
 * reached the underlying implementation with the request object untouched, the
 * returned child session id keyed the record, and no role resolution left the
 * native path alone.
 *
 * SECONDARY coverage pins wrapper identity: an injected consumer reads the
 * WRAPPER (a different object that still delegates the raw service's members),
 * not the raw service.
 *
 * One OPTIONAL canary pins the install topology itself (the cordis
 * `internal/get` service-read waterfall dispatches for the name `subagents`).
 * It is labelled as a canary tied to that cordis event name and is never the
 * only guard — a peer-version rename can only degrade persona/notice delivery
 * (plan Risk: `internal/get` wrapper is version-sensitive), never a dispatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import {
  installSubagentSeam,
  resolveDeclaredRoleFromAssignment,
  subagentSeamOf,
  type SubagentStartRequestView,
  type SubagentSeamRecord,
} from '../src/subagents-seam.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, makeAgent } from './support/harness.ts'

/** Declared taxonomy: trimmed id → DECLARED RAW id (` coder ` is declared padded). */
const ROLE_IDS = new Map([
  ['coder', 'coder'],
  ['reviewer', 'reviewer'],
  ['scout', 'scout'],
  ['padded', ' padded '],
])

/**
 * An Assignment carrying `**Execute as**: <id>` plus a body after the first
 * body marker. The `## Assignment` head mirrors mstar's canonical dispatch
 * text (`assignmentTextFromFields` emits exactly that heading), and the quoted
 * field line inside the body must never shape the resolution.
 */
function assignment(executeAs: string): string {
  return [
    '## Assignment',
    '',
    '- **You are a leaf executor.**',
    `- **Execute as**: ${executeAs}`,
    '',
    '## Task 1 — something',
    '',
    // A body-quoted field line AFTER the body marker must never shape the result.
    '- **Execute as**: reviewer',
  ].join('\n')
}

describe('resolveDeclaredRoleFromAssignment — pure canonicalization', () => {
  it('resolves a declared id to the DECLARED RAW id', () => {
    expect(resolveDeclaredRoleFromAssignment(assignment('coder'), ROLE_IDS)).toBe('coder')
  })

  it('canonicalizes a padded, @-prefixed id and a differently-cased id', () => {
    expect(resolveDeclaredRoleFromAssignment(assignment('  @CODER  '), ROLE_IDS)).toBe('coder')
  })

  it('returns the padded DECLARED RAW id (never the trimmed lookup key)', () => {
    expect(resolveDeclaredRoleFromAssignment(assignment('padded'), ROLE_IDS)).toBe(' padded ')
  })

  it('accepts the bullet and plain field forms', () => {
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: coder', ROLE_IDS)).toBe('coder')
    expect(resolveDeclaredRoleFromAssignment('- **Execute as**: coder', ROLE_IDS)).toBe('coder')
    expect(resolveDeclaredRoleFromAssignment('Execute as: coder', ROLE_IDS)).toBe('coder')
    expect(resolveDeclaredRoleFromAssignment('Execute as: scout', ROLE_IDS)).toBe('scout')
  })

  it('ignores a body-quoted field line after the first body marker', () => {
    // `assignment()` quotes `**Execute as**: reviewer` inside the task body.
    expect(resolveDeclaredRoleFromAssignment(assignment('coder'), ROLE_IDS)).toBe('coder')
  })

  it('stops the header region at the Assignment grammar body markers (engine parity)', () => {
    // The region ends at the first `# Task`-level heading / `---` / single-`#`
    // heading (the engine's own rule — a body-quoted example must not shape the
    // resolution). mstar's canonical dispatch text starts with `## Assignment`,
    // which is NOT a boundary (the header region therefore covers the fields).
    expect(resolveDeclaredRoleFromAssignment('## Assignment\n\n**Execute as**: coder', ROLE_IDS)).toBe('coder')
    expect(resolveDeclaredRoleFromAssignment('## Assignment\n**Execute as**: coder\n\n### Task 1\n\n**Execute as**: scout', ROLE_IDS)).toBe('coder')
    expect(resolveDeclaredRoleFromAssignment('## Assignment\n**Execute as**: coder\n\n---\n\n**Execute as**: scout', ROLE_IDS)).toBe('coder')
    // A single-`#` title IS a boundary: the fields after it are outside the region.
    expect(resolveDeclaredRoleFromAssignment('# Title\n\n**Execute as**: coder', ROLE_IDS)).toBeUndefined()
  })

  it('returns undefined for absent, empty, undeclared and inherit declarations', () => {
    expect(resolveDeclaredRoleFromAssignment('**You are a leaf executor.**', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('**Execute as**:', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: @', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: nobody', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: inherit', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: @inherit', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('', ROLE_IDS)).toBeUndefined()
  })

  it('returns undefined for an ambiguous declaration and resolves a repeat of one role', () => {
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: coder\n**Execute as**: scout', ROLE_IDS)).toBeUndefined()
    expect(resolveDeclaredRoleFromAssignment('**Execute as**: coder\n**Execute as**: @CODER', ROLE_IDS)).toBe('coder')
  })

  it('returns undefined when nothing is declared', () => {
    expect(resolveDeclaredRoleFromAssignment(assignment('coder'), new Map())).toBeUndefined()
  })
})

/** One captured delegation call on the fake runtime. */
interface FakeSubagents {
  service: Record<string, unknown>
  starts: Array<{ name: string; request: SubagentStartRequestView }>
  continuableStarts: Array<Record<string, unknown>>
}

/**
 * Fake `subagents` runtime: records every delegated call and resolves the
 * given result. `tag` gives the raw service a distinguishable identity for the
 * wrapper-identity assertion.
 */
function fakeSubagents(startResult: unknown, continuableResult?: unknown): FakeSubagents {
  const starts: FakeSubagents['starts'] = []
  const continuableStarts: FakeSubagents['continuableStarts'] = []
  const service: Record<string, unknown> = {
    tag: 'raw-subagents',
    getProvider: () => undefined,
    start: (name: string, request: SubagentStartRequestView) => {
      starts.push({ name, request })
      return Promise.resolve(startResult)
    },
    startContinuable: (spec: Record<string, unknown>) => {
      continuableStarts.push(spec)
      return Promise.resolve(continuableResult)
    },
  }
  return { service, starts, continuableStarts }
}

/** Wait one macrotask so a cordis plugin child's `apply` has run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Read `ctx.subagents` the way the host does: from a CONSUMER fiber that
 * injects the service. Returns the consumer's resolved value (the wrapper) plus
 * a `call` bound to that exact read.
 */
async function injectSubagents(ctx: Context): Promise<{ value: Record<string, unknown> }> {
  let captured: Context | undefined
  ctx.plugin({
    name: 'seam-test-consumer',
    inject: ['subagents'],
    apply(consumerCtx: Context) {
      captured = consumerCtx
    },
  })
  await nextTick()
  if (captured === undefined) throw new Error('consumer fiber did not apply')
  return { value: (captured as unknown as { subagents: Record<string, unknown> }).subagents }
}

/** A minimal parent-agent stand-in for the request's `parent.session.id` join. */
function parentAgent(id: string): SubagentStartRequestView['parent'] {
  return { session: { id } }
}

describe('subagent seam — behavioural (public call path)', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
  })

  it('records the child session id returned by the wrapped start', async () => {
    ctx = new Context()
    ctx.provide('subagents', fakeSubagents({ id: 'child-42' }).service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    const request: SubagentStartRequestView = {
      prompt: [{ type: 'text', text: assignment('coder') }],
      label: 'task one',
      parent: parentAgent('parent-session'),
    }
    const result = await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)(
      'spawn',
      request,
    )

    // The wrapped call reached the underlying implementation, request untouched.
    expect(result).toEqual({ id: 'child-42' })
    expect(seam.records.get('child-42')).toEqual({ role: 'coder', at: expect.any(Number), firstNoticePending: true })
  })

  it('keys a `subagentId` result (continuable) and a `runId` result (foreground)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'unused' })
    // Foreground/continuable TOOL-result vocabulary: both ARE session ids.
    let next: unknown = { kind: 'continuable', subagentId: 'child-continuable' }
    ;(fake.service as { start: unknown }).start = () => Promise.resolve(next)
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }] })
    next = { kind: 'foreground', runId: 'child-foreground' }
    await start('spawn', { prompt: [{ type: 'text', text: assignment('scout') }] })

    expect(seam.records.get('child-continuable')?.role).toBe('coder')
    expect(seam.records.get('child-foreground')?.role).toBe('scout')
  })

  it('never keys a `jobId` result and correlates the child through the catalog event', async () => {
    ctx = new Context()
    ctx.provide('subagents', fakeSubagents({ kind: 'background', jobId: 'job-7' }).service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('coder') }],
      label: 'background task',
      parent: parentAgent('parent-session'),
    })

    // A registry job id is NOT a session id.
    expect(seam.records.has('job-7')).toBe(false)
    expect(seam.records.size).toBe(0)

    // The parent-owned catalog event supplies the child session id; the join is
    // (delegating parent session, delegation label).
    ctx.emit('session/event', { id: 'parent-session' }, {
      type: 'subagent/catalog',
      seq: 1,
      time: Date.now(),
      data: { version: 0, childId: 'child-background', childCreatedAt: Date.now(), mode: 'one-shot', label: 'background task' },
    })

    expect(seam.records.get('child-background')?.role).toBe('coder')
  })

  it('leaves the native path byte-identical when no role resolves', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-plain' })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    // Interception precondition (review M-1): every assertion below is a
    // NEGATIVE (nothing changed / nothing recorded), which the raw service also
    // satisfies — so pin the interception itself first.
    expect(value).not.toBe(fake.service)
    const request = { prompt: [{ type: 'text', text: 'no assignment header here' }] }
    await (value.start as (name: string, request: unknown) => Promise<unknown>)('spawn', request)

    // The SAME request object reached the service, and nothing was recorded.
    expect(fake.starts).toHaveLength(1)
    expect(fake.starts[0]!.request).toBe(request)
    expect(seam.records.size).toBe(0)
  })

  it('falls back to the per-child record for a startContinuable resume without an Assignment header', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'unused' }, { childId: 'child-resumed', messageId: 'message-1' })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    // The child was recorded by an earlier dispatch (durable id reused on resume).
    seam.records.set('child-resumed', { role: 'reviewer', at: 1, firstNoticePending: false })

    const { value } = await injectSubagents(ctx)
    const startContinuable = value.startContinuable as (spec: unknown) => Promise<unknown>
    await startContinuable({ provider: 'spawn', label: 'resume', childId: 'child-resumed', request: { prompt: [] } })

    // The resume reused the record (role re-recorded, last-wins) and kept the
    // cleared notice marker, so Task 3 cannot emit a second notice row.
    // DISCRIMINATING (review I-1): the wrapper REWRITES the record with a fresh
    // `at`, so the seed's `1` cannot survive — this assertion fails when
    // interception is broken, which the role/marker/`any(Number)` assertions
    // above cannot detect (they all hold against the raw service).
    const resumed = seam.records.get('child-resumed')
    expect(resumed?.role).toBe('reviewer')
    expect(resumed?.firstNoticePending).toBe(false)
    expect(resumed?.at).toBeGreaterThan(1)
    expect(fake.continuableStarts).toHaveLength(1)
  })

  it('degrades with ONE contained debug log when the read resolves no runtime', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })
    // An unresolved service value (and, below, a non-runtime value) must pass
    // through untouched — no throw, no record, exactly one contained debug.
    ctx.provide('subagents', undefined)

    const { value } = await injectSubagents(ctx)
    expect(value).toBeUndefined()
    expect(seam.records.size).toBe(0)
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the service value is not a start-capable runtime', async () => {
    ctx = new Context()
    const debug = vi.fn()
    ctx.provide('subagents', { tag: 'not-a-runtime' })
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    expect(value).toEqual({ tag: 'not-a-runtime' })
    expect(seam.records.size).toBe(0)
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('a throwing start still propagates and leaves no record', async () => {
    ctx = new Context()
    const service = {
      start: () => {
        throw new Error('native start refused')
      },
    }
    ctx.provide('subagents', service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    // Interception precondition (review M-1): "no record" is a NEGATIVE and
    // holds for the raw service too — pin the interception first.
    expect(value).not.toBe(service)
    expect(() => (value.start as (name: string, request: SubagentStartRequestView) => unknown)('spawn', {
      prompt: [{ type: 'text', text: assignment('coder') }],
      label: 'task',
      parent: parentAgent('parent-session'),
    })).toThrow('native start refused')
    expect(seam.records.size).toBe(0)
  })

  it('a rejected start ends the catalog correlation claim (review M-2)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const service = {
      start: () => Promise.reject(new Error('native start rejected')),
    }
    ctx.provide('subagents', service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    await expect(
      (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
        prompt: [{ type: 'text', text: assignment('coder') }],
        label: 'task',
        parent: parentAgent('parent-session'),
      }),
    ).rejects.toThrow('native start rejected')

    // The claim was dropped: a catalog event for the same (parent session,
    // label) must NOT key a record for a child that never started. A native
    // rejection is not a seam degrade — no contained debug line either.
    ctx.emit('session/event', { id: 'parent-session' }, {
      type: 'subagent/catalog',
      seq: 1,
      time: Date.now(),
      data: {
        version: 0,
        childId: 'child-after-reject',
        childCreatedAt: Date.now(),
        mode: 'one-shot',
        label: 'task',
      },
    })
    expect(seam.records.size).toBe(0)
    expect(debug).not.toHaveBeenCalled()
  })

  it('emits exactly ONE contained debug log when the prompt declares no resolvable role (review M-5)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    ctx.provide('subagents', fakeSubagents({ id: 'child-norole' }).service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    // No prompt text at all (e.g. a continuable resume): nothing to report.
    await start('spawn', { prompt: [] })
    expect(debug).not.toHaveBeenCalled()
    // A prompt IS present but declares no resolvable role — an absent field,
    // then an undeclared id (and a `#`-led prompt behaves the same: the header
    // region is empty at engine parity). The live no-op becomes observable, and
    // the latch keeps it to ONE line per apply.
    await start('spawn', { prompt: [{ type: 'text', text: 'no assignment header here' }] })
    await start('spawn', { prompt: [{ type: 'text', text: assignment('nobody') }] })
    await start('spawn', { prompt: [{ type: 'text', text: '# Title\n\n**Execute as**: coder' }] })
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('no role resolved')
    expect(seam.records.size).toBe(0)
  })
})

describe('subagent seam — wrapper identity + install topology', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('SECONDARY: an injected consumer reads the wrapper, not the raw service', async () => {
    ctx = new Context()
    const raw = fakeSubagents({ id: 'child-1' }).service
    ctx.provide('subagents', raw)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    // Distinguishable identity: a different object that still delegates the
    // raw service's own members (prototype delegation, raw never mutated).
    expect(value).not.toBe(raw)
    expect(value.tag).toBe('raw-subagents')
    expect(typeof value.start).toBe('function')
  })

  it('OPTIONAL canary: the cordis service-read waterfall dispatches for `subagents`', async () => {
    // Canary tied to the cordis event literal `internal/get`. Behavioural
    // coverage above does not depend on it (a cordis rename degrades delivery
    // only — plan Risk).
    ctx = new Context()
    ctx.provide('subagents', fakeSubagents({ id: 'child-1' }).service)
    const seen: string[] = []
    ctx.on('internal/get', (_readCtx, name, _error, next) => {
      seen.push(name)
      return next()
    })
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    await injectSubagents(ctx)
    expect(seen).toContain('subagents')
  })
})

describe('subagent seam — per-apply lifetime through apply()', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('installs the seam and cleans the record map on agent/disposed + plugin dispose', async () => {
    const { agent } = makeAgent('child-disposed', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: '', chain: [] }], rules: [] } }))
    const seam = subagentSeamOf(ctx)
    expect(seam).toBeDefined()
    const record: SubagentSeamRecord = { role: 'coder', at: 1, firstNoticePending: true }
    seam!.records.set('child-disposed', record)

    // agent/disposed mirrors the existing per-agent maps (`Agent.id` IS the session id).
    ctx.emit('agent/disposed', { agent })
    expect(seam!.records.has('child-disposed')).toBe(false)

    seam!.records.set('child-disposed', record)
    await ctx.fiber.dispose()
    expect(seam!.records.size).toBe(0)
  })

  it('a second apply over the same context root installs no nested seam (multi-fiber dedupe, review M-3)', async () => {
    const config = () => cfg({ roles: { list: [{ id: 'coder', persona: '', chain: [] }], rules: [] } })
    apply(ctx, config())
    const first = subagentSeamOf(ctx)
    expect(first).toBeDefined()

    // A later fiber over the shared root is refused by the seam and degraded by
    // the guard: the first fiber keeps the only listener set, so the store
    // still holds the FIRST seam (no nested wrapper, no second debug line).
    expect(() => apply(ctx, config())).not.toThrow()
    expect(subagentSeamOf(ctx)).toBe(first)
  })
})
