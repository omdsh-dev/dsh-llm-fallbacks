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
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
import {
  installSubagentSeam,
  personaForRole,
  resolveDeclaredRoleFromAssignment,
  subagentSeamOf,
  type SubagentSeam,
  type SubagentSeamOptions,
  type SubagentStartRequestView,
  type SubagentSeamRecord,
} from '../src/subagents-seam.ts'
import type { FallbacksRole } from '../src/config.ts'
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
 * Declared roles for the Task 2 persona matrix (`roles.list`): `coder` carries
 * a chain and a PADDED persona (trimming is pinned), `scout` is CHAINLESS
 * (`chain: []` — the plan's chain-independence case), `reviewer` declares only
 * whitespace (no persona), and ` padded ` pins the DECLARED RAW id lookup.
 */
const ROLES: FallbacksRole[] = [
  { id: 'coder', persona: '  Coder persona  ', chain: ['openai/gpt-4o'] },
  { id: 'scout', persona: 'Scout persona', chain: [] },
  { id: 'reviewer', persona: '   ' },
  { id: ' padded ', persona: 'Padded persona' },
]

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

describe('personaForRole — pure, chain-independent persona lookup', () => {
  it('returns the TRIMMED persona of the DECLARED RAW id (never the trimmed key)', () => {
    expect(personaForRole(ROLES, 'coder')).toBe('Coder persona')
    // ` padded ` is the DECLARED RAW id the seam resolved — the lookup matches
    // role.id exactly, so a padded declaration still finds its persona.
    expect(personaForRole(ROLES, ' padded ')).toBe('Padded persona')
    expect(personaForRole(ROLES, 'scout')).toBe('Scout persona')
  })

  it('returns undefined for a blank persona, an absent persona key, or an unknown id', () => {
    expect(personaForRole(ROLES, 'reviewer')).toBeUndefined()
    expect(personaForRole([{ id: 'bare' } as unknown as FallbacksRole], 'bare')).toBeUndefined()
    expect(personaForRole(ROLES, 'nobody')).toBeUndefined()
    expect(personaForRole([], 'coder')).toBeUndefined()
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
 * wrapper-identity assertion. `provider` is what `getProvider()` answers — the
 * Task 2 persona-capability gate read (`undefined` = no provider registered).
 */
function fakeSubagents(
  startResult: unknown,
  continuableResult?: unknown,
  provider?: Record<string, unknown>,
): FakeSubagents {
  const starts: FakeSubagents['starts'] = []
  const continuableStarts: FakeSubagents['continuableStarts'] = []
  const service: Record<string, unknown> = {
    tag: 'raw-subagents',
    getProvider: () => provider,
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

/**
 * Dispatch ONE start through a FRESH context with the given seam options and
 * return what the underlying service received, the returned result, the seam,
 * and the contained debug sink. Task 4 uses it where a case needs an in-test
 * POSITIVE CONTROL under DIFFERENT install options: the seam is root-scoped and
 * refuses a second install, so the control cannot reuse the case's context.
 */
async function dispatchWithOptions(
  options: Omit<SubagentSeamOptions, 'debug'>,
  request: SubagentStartRequestView,
  provider?: Record<string, unknown>,
): Promise<{
  received: SubagentStartRequestView
  result: unknown
  seam: SubagentSeam
  debug: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  const debug = vi.fn()
  const fake = fakeSubagents({ id: 'child-option-probe' }, undefined, provider)
  ctx.provide('subagents', fake.service)
  const seam = installSubagentSeam(ctx, { ...options, debug })
  const { value } = await injectSubagents(ctx)
  const result = await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)(
    'spawn',
    request,
  )
  await ctx.fiber.dispose()
  return { received: fake.starts[0]!.request, result, seam, debug }
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

  // --- Task 2: chain-independent native persona delivery ---------------------

  it('merges the declared CHAINLESS role persona into the native start request', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-persona' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })

    const { value } = await injectSubagents(ctx)
    // Interception precondition: every claim below is about what the SERVICE
    // received, which the raw service would also satisfy in the negative
    // direction — pin that the injected read is the wrapper.
    expect(value).not.toBe(fake.service)
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('scout') }] }
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', request)

    // `scout` declares `chain: []`; its persona still arrives — TRIMMED — on the
    // native `persona` slot, and the caller's request object is never mutated.
    const delivered = fake.starts[0]!.request
    expect(delivered.persona).toBe('Scout persona')
    expect(delivered).not.toBe(request)
    expect(delivered.prompt).toBe(request.prompt)
    expect(request.persona).toBeUndefined()
  })

  it('delivers the persona identically for a chainless and a chained role (chain independence)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-chain' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    // The chained role's `chain` is an accessor that THROWS: persona resolution
    // reads the ROLE only, so any `chain` / routing read would degrade here
    // instead of delivering. That is the chain-independence pin.
    const chainedRole: FallbacksRole = { id: 'chained', persona: 'Shared persona' }
    Object.defineProperty(chainedRole, 'chain', {
      enumerable: true,
      get() {
        throw new Error('the persona path must never read the role chain')
      },
    })
    const roles: FallbacksRole[] = [{ id: 'scout', persona: 'Shared persona', chain: [] }, chainedRole]
    installSubagentSeam(ctx, {
      roleIds: () => new Map([['scout', 'scout'], ['chained', 'chained']]),
      roles: () => roles,
    })

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    await start('spawn', { prompt: [{ type: 'text', text: assignment('scout') }] })
    await start('spawn', { prompt: [{ type: 'text', text: assignment('chained') }] })

    expect(fake.starts.map((call) => call.request.persona)).toEqual(['Shared persona', 'Shared persona'])
  })

  it('leaves a caller-set request.persona untouched (explicit caller intent wins)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-explicit' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    const request: SubagentStartRequestView = {
      prompt: [{ type: 'text', text: assignment('scout') }],
      persona: 'caller persona',
    }
    await start('spawn', request)

    // The role persona fills only an ABSENT slot: the caller's own persona and
    // the caller's own request object reach the service untouched.
    expect(fake.starts[0]!.request).toBe(request)
    expect(fake.starts[0]!.request.persona).toBe('caller persona')

    // An empty-string persona is still caller intent (the plan's rule: fill an
    // ABSENT slot only) — never overwritten by the role persona either.
    const emptyPersona: SubagentStartRequestView = {
      prompt: [{ type: 'text', text: assignment('scout') }],
      persona: '',
    }
    await start('spawn', emptyPersona)
    expect(fake.starts[1]!.request).toBe(emptyPersona)
    expect(fake.starts[1]!.request.persona).toBe('')

    // Positive control (discrimination): the SAME role with an ABSENT slot does
    // get the role persona through this wrapper — so "untouched" above is the
    // explicit value winning, not a merge that never happens. This assertion
    // fails when interception or the merge breaks.
    await start('spawn', { prompt: [{ type: 'text', text: assignment('scout') }] })
    expect(fake.starts[2]!.request.persona).toBe('Scout persona')
  })

  it('skips the persona with ONE contained debug when the provider lacks the capability', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ id: 'child-nocap' }, undefined, { capabilities: { persona: false } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('scout') }] }
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', request)

    // Capability miss = skip: the native start receives the ORIGINAL request
    // object (byte-identical to the un-seamed path), never a persona the
    // runtime would reject with UNSUPPORTED_CAPABILITY.
    expect(fake.starts[0]!.request).toBe(request)
    expect(request.persona).toBeUndefined()
    expect(debug).toHaveBeenCalledTimes(1)
    // The skip line must NAME the surface it skipped (plan Errata): an operator
    // reading the log has to tell a one-shot capability miss from any other one.
    expect(String(debug.mock.calls[0]![0])).toContain('lacks the persona capability')
    expect(String(debug.mock.calls[0]![0])).toContain('one-shot')

    // Positive control (discrimination, Task 4 review Minor 3): the SAME wrapper
    // with the capability PRESENT merges the persona — so the identity and the
    // single line above are the capability verdict, not a merge that never runs.
    ;(fake.service as { getProvider?: unknown }).getProvider = () => ({ capabilities: { persona: true } })
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('scout') }],
    })
    expect(fake.starts[1]!.request.persona).toBe('Scout persona')
  })

  it('skips the persona with ONE contained debug when the runtime has no provider lookup', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ id: 'child-nolookup' })
    // A reshaped runtime: `start`-capable but without `getProvider`, so the
    // persona capability cannot be verified.
    delete (fake.service as { getProvider?: unknown }).getProvider
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('scout') }] }
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', request)

    expect(fake.starts[0]!.request).toBe(request)
    expect(request.persona).toBeUndefined()
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('exposes no provider lookup')
    expect(String(debug.mock.calls[0]![0])).toContain('one-shot')

    // Positive control (discrimination, Task 4 review Minor 3): restoring the
    // provider lookup on the SAME service object (the wrapper delegates through
    // the prototype, so the read is live) delivers the persona — so the skip
    // above is the unverifiable capability, not a dead wrapper.
    ;(fake.service as { getProvider?: unknown }).getProvider = () => ({ capabilities: { persona: true } })
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('scout') }],
    })
    expect(fake.starts[1]!.request.persona).toBe('Scout persona')
  })

  it('does not merge when the role declares no persona (blank after trim)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-blank' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })

    const { value } = await injectSubagents(ctx)
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('reviewer') }] }
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', request)

    // No persona declared (`reviewer` is whitespace-only) → the SAME request
    // object reaches the service.
    expect(fake.starts[0]!.request).toBe(request)
    expect(request.persona).toBeUndefined()

    // Positive control (discrimination): a role that DOES declare a persona is
    // merged through this same wrapper — so the identity above means "nothing to
    // deliver", not "the wrapper never ran".
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('scout') }],
    })
    expect(fake.starts[1]!.request.persona).toBe('Scout persona')
  })

  it('does not merge for an unresolved role', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ id: 'child-norole-persona' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })

    const { value } = await injectSubagents(ctx)
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('nobody') }] }
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', request)

    // An undeclared role never reaches the persona path: the original request
    // object arrives, and the only debug line is the M-5 no-role no-op.
    expect(fake.starts[0]!.request).toBe(request)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('no role resolved')

    // Positive control (discrimination, Task 4 review Minor 3): a DECLARED role
    // through the SAME wrapper does merge — so the identity above is the
    // unresolved role, not an inactive seam.
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('scout') }],
    })
    expect(fake.starts[1]!.request.persona).toBe('Scout persona')
  })

  it('canonicalizes a padded, @-prefixed declaration end to end (case g)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-padded' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('  @PADDED  ') }],
    })

    // Both consumers of the resolution see the DECLARED RAW id (` padded `, the
    // settings entry as written): the record's role and — because `personaForRole`
    // matches `role.id` exactly — the delivered persona. A canonicalization that
    // returned the trimmed lookup key (`padded`) would find no persona (it would
    // still key the record, so the persona assertion is the discriminating half).
    expect(seam.records.get('child-padded')?.role).toBe(' padded ')
    expect(fake.starts[0]!.request.persona).toBe('Padded persona')
  })

  it('startContinuable: no role in the request and no record for that child ⇒ no-op', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'unused' }, { childId: 'child-fresh' }, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    const spec = { provider: 'spawn', label: 'fresh', childId: 'child-fresh', request: { prompt: [] } }
    await (value.startContinuable as (spec: unknown) => Promise<unknown>)(spec)

    // Neither an Assignment header nor a record for that child id: the caller's
    // spec object reaches the service unchanged (same identity).
    expect(fake.continuableStarts[0]).toBe(spec)
  })

  it('merges the persona into a continuable start reached through the record fallback', async () => {
    ctx = new Context()
    // The provider's ONE-SHOT persona flag is FALSE while `prepareContinuable`
    // exists: the continuable surface is gated by the NATIVE continuable
    // capability, because the manager applies `request.persona` unconditionally.
    const fake = fakeSubagents({ id: 'unused' }, { childId: 'child-resume' }, {
      capabilities: { persona: false },
      prepareContinuable: () => undefined,
    })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    seam.records.set('child-resume', { role: 'scout', at: 1, firstNoticePending: false })

    const { value } = await injectSubagents(ctx)
    const spec = { provider: 'spawn', label: 'resume', childId: 'child-resume', request: { prompt: [] } }
    await (value.startContinuable as (spec: unknown) => Promise<unknown>)(spec)

    const delivered = fake.continuableStarts[0] as { request: SubagentStartRequestView }
    expect(delivered).not.toBe(spec)
    expect(delivered.request.persona).toBe('Scout persona')
    expect(spec.request.persona).toBeUndefined()
  })

  it('reads the persona source per start, so a live roles edit applies without a re-install', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ id: 'child-live' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    let roles: FallbacksRole[] = [{ id: 'scout', persona: 'First persona', chain: [] }]
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => roles })

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    await start('spawn', { prompt: [{ type: 'text', text: assignment('scout') }] })
    // A settings edit (a later fiber's persona change) must apply to the NEXT
    // dispatch without a re-install: the source is read PER START.
    roles = [{ id: 'scout', persona: 'Second persona', chain: [] }]
    await start('spawn', { prompt: [{ type: 'text', text: assignment('scout') }] })

    expect(fake.starts.map((call) => call.request.persona)).toEqual(['First persona', 'Second persona'])
  })

  it('skips the continuable persona when the provider has no continuable support', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ id: 'unused' }, { childId: 'child-nocont' }, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })
    seam.records.set('child-nocont', { role: 'scout', at: 1, firstNoticePending: false })

    const { value } = await injectSubagents(ctx)
    const spec = { provider: 'spawn', label: 'resume', childId: 'child-nocont', request: { prompt: [] } }
    await (value.startContinuable as (spec: unknown) => Promise<unknown>)(spec)

    // No `prepareContinuable` → the persona is skipped, the caller's spec object
    // is passed through unchanged, and the skip is ONE contained debug line.
    expect(fake.continuableStarts[0]).toBe(spec)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('does not support continuable children')
  })

  // --- Task 4 case (l): a degraded seam leaves the native path intact --------

  it('records the role but merges nothing when no persona source is wired (case l)', async () => {
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('scout') }] }
    // The `roles` option is the persona source; absent, the declaration cannot
    // even be read — the caller's OWN object is forwarded and nothing is logged.
    const withoutSource = await dispatchWithOptions(
      { roleIds: () => ROLE_IDS },
      request,
      { capabilities: { persona: true } },
    )
    expect(withoutSource.received).toBe(request)
    expect(withoutSource.received.persona).toBeUndefined()
    expect(withoutSource.debug).not.toHaveBeenCalled()
    // …while the ROLE is still resolved and recorded: an absent persona source
    // is not a dead seam (the notice row still names the role).
    expect(withoutSource.seam.records.get('child-option-probe')?.role).toBe('scout')

    // Positive control: the SAME request shape through the SAME install call
    // with the source wired merges the persona — so the identity above is the
    // absent source's doing, not a merge that never runs.
    const withSource = await dispatchWithOptions(
      { roleIds: () => ROLE_IDS, roles: () => ROLES },
      request,
      { capabilities: { persona: true } },
    )
    expect(withSource.received.persona).toBe('Scout persona')
  })

  it('degrades with ONE contained debug when the live persona source throws (case l)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ id: 'child-source-boom' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    let healthy = false
    const seam = installSubagentSeam(ctx, {
      roleIds: () => ROLE_IDS,
      roles: () => {
        if (!healthy) throw new Error('settings boom')
        return ROLES
      },
      debug,
    })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('scout') }] }
    const result = await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)(
      'spawn',
      request,
    )

    // The merge aborted before touching the request: the native call ran with
    // the caller's own object, its result reached the caller, and the role was
    // still recorded — ONE contained line names the throw.
    expect(fake.starts[0]!.request).toBe(request)
    expect(result).toEqual({ id: 'child-source-boom' })
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('settings boom')
    expect(seam.records.get('child-source-boom')?.role).toBe('scout')
    // The aborted merge reports NO persona verdict (it does not invent one).
    expect(seam.records.get('child-source-boom')?.personaNotApplied).toBeUndefined()

    // Positive control: the source heals and the SAME install delivers, so the
    // degrade above is the throw and not a persona path that never runs.
    healthy = true
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('scout') }],
    })
    expect(fake.starts[1]!.request.persona).toBe('Scout persona')
  })

  it('degrades with ONE contained debug when the provider lookup throws (case l)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ id: 'child-provider-boom' }, undefined, { capabilities: { persona: true } })
    let healthy = false
    ;(fake.service as { getProvider: unknown }).getProvider = () => {
      if (!healthy) throw new Error('provider boom')
      return { capabilities: { persona: true } }
    }
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    const request: SubagentStartRequestView = { prompt: [{ type: 'text', text: assignment('scout') }] }
    await start('spawn', request)

    expect(fake.starts[0]!.request).toBe(request)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('provider boom')

    // Positive control: the lookup heals → the same dispatch point merges.
    healthy = true
    await start('spawn', { prompt: [{ type: 'text', text: assignment('scout') }] })
    expect(fake.starts[1]!.request.persona).toBe('Scout persona')
  })

  it('contains a throwing persona source on the continuable surface too (case l)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    // `prepareContinuable` present ⇒ the continuable gate would pass, so the only
    // thing that can stop the merge here is the throwing source.
    const fake = fakeSubagents({ id: 'unused' }, { childId: 'child-cont-boom' }, {
      prepareContinuable: () => undefined,
    })
    ctx.provide('subagents', fake.service)
    let healthy = false
    installSubagentSeam(ctx, {
      roleIds: () => ROLE_IDS,
      roles: () => {
        if (!healthy) throw new Error('settings boom')
        return ROLES
      },
      debug,
    })

    const { value } = await injectSubagents(ctx)
    const startContinuable = value.startContinuable as (spec: unknown) => Promise<unknown>
    const spec = {
      provider: 'spawn',
      childId: 'child-cont-boom',
      request: { prompt: [{ type: 'text', text: assignment('scout') }] },
    }
    await startContinuable(spec)

    // The shared containment (`mergePersonaAtSeam`) is what this surface now
    // routes through: the caller's spec object reaches the service untouched and
    // the throw is ONE contained line, never a failed resume.
    expect(fake.continuableStarts[0]).toBe(spec)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('settings boom')

    // Positive control: a healthy source on the SAME install merges into a copy.
    healthy = true
    await startContinuable({
      provider: 'spawn',
      childId: 'child-cont-ok',
      request: { prompt: [{ type: 'text', text: assignment('scout') }] },
    })
    const delivered = fake.continuableStarts[1] as { request: SubagentStartRequestView }
    expect(delivered).not.toBe(spec)
    expect(delivered.request.persona).toBe('Scout persona')
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

  it('wires the persona source at that ONE install point (apply() + live roles.list)', async () => {
    const fake = fakeSubagents({ id: 'child-apply' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    // The FIRST fiber's install point is the only live seam (dedupe above), so
    // this is exactly where the persona source has to be wired: `index.ts`
    // passes `roles: () => source().roles.list` next to `roleIds`/`debug`.
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Applied persona', chain: [] }], rules: [] } }))

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    await (value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>)('spawn', {
      prompt: [{ type: 'text', text: assignment('coder') }],
    })

    // Dropping the `roles` option from the install call (or capturing the roles
    // list at install time) fails here.
    expect(fake.starts[0]!.request.persona).toBe('Applied persona')
  })

  it('reads the swapped live source on a LATER start after a real settings onChange', async () => {
    const fake = fakeSubagents({ id: 'child-live-settings' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Before persona', chain: [] }], rules: [] } }))

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }] })

    // A REAL settings write: `scope.watch` → the install hooks' `onChange`
    // re-derives the plugin state and `setSource` swaps the `source()` thunk —
    // the ONE the seam's `roles: () => source().roles.list` reads PER START
    // (src/index.ts, the "cross-fiber" comment this test pins). The seam is not
    // re-installed here: the second start must observe the swap by itself.
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'coder', persona: 'After persona', chain: [] }], rules: [] },
    })
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }] })

    expect(fake.starts.map((call) => call.request.persona)).toEqual(['Before persona', 'After persona'])
  })

  it('reads the live declared-role map per start, so a role ADDED by a settings edit resolves without a re-install', async () => {
    const fake = fakeSubagents({ id: 'child-role-added' }, undefined, { capabilities: { persona: true } })
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } }))

    const { value } = await injectSubagents(ctx)
    const start = value.start as (name: string, request: SubagentStartRequestView) => Promise<unknown>
    // Before the edit `rookie` is UNDECLARED: nothing resolves, nothing is
    // recorded — the negative half of this pin (the sed-like half lives in the
    // case above).
    await start('spawn', { prompt: [{ type: 'text', text: assignment('rookie') }] })
    expect(subagentSeamOf(ctx)!.records.size).toBe(0)
    expect(fake.starts[0]!.request.persona).toBeUndefined()

    // A REAL settings write adds the role id: `roleIds` is a LIVE read (the same
    // thunk the persona source rides), so the NEXT dispatch resolves the new id
    // and delivers its persona through the seam installed BEFORE the edit — no
    // re-install, no stale trimmed-id map (Task 4 review Minor 4).
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: {
        list: [
          { id: 'coder', persona: 'Coder persona', chain: [] },
          { id: 'rookie', persona: 'Rookie persona', chain: [] },
        ],
        rules: [],
      },
    })
    await start('spawn', { prompt: [{ type: 'text', text: assignment('rookie') }] })
    expect(subagentSeamOf(ctx)!.records.get('child-role-added')?.role).toBe('rookie')
    expect(fake.starts[1]!.request.persona).toBe('Rookie persona')
  })
})
