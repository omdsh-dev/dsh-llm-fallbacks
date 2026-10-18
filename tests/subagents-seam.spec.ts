/**
 * Dispatch-seam role resolution + per-child record (plan
 * role-based-subagent-adoption Task 1; rc.1 `startActivation` migration, plan
 * dsh-021-subagent-seam-repair Task 2).
 *
 * PRIMARY coverage is behavioural and public-path: the seam is exercised the
 * way the host exercises it — the `subagents` service is provided, the seam is
 * installed (on a plugin child fiber, exactly as `apply()` does), and a
 * consumer that injects `subagents` CALLS `ctx.subagents.startActivation`.
 * Assertions are on observable effects: the wrapped call reached the underlying
 * implementation with the caller's own spec object (or with the child id
 * reserved for a LOCAL backend), and the per-child record was keyed under that
 * id BEFORE the native call ran.
 *
 * SECONDARY coverage pins wrapper identity: an injected consumer reads the
 * WRAPPER (a different object that still delegates the raw service's members),
 * not the raw service.
 *
 * One OPTIONAL canary pins the install topology itself (the cordis
 * `internal/get` service-read waterfall dispatches for the name `subagents`).
 * It is labelled as a canary tied to that cordis event name and is never the
 * only guard — a peer-version rename can only degrade role delivery (plan Risk:
 * `internal/get` wrapper is version-sensitive), never a dispatch.
 *
 * The drift probe pins the INSTALLED peer's declared surface (`startActivation`
 * present; `start` / `startContinuable` absent) — the guard for the regression
 * class that kept this suite green against a runtime that had already moved on
 * (plan Risk: local drift blindness).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { FALLBACKS_PROFILE_ENTRY } from '../src/gateway.ts'
import { installRolePersona } from '../src/role-persona.ts'
import {
  installSubagentSeam,
  PENDING_CORRELATION_LIMIT,
  personaForRole,
  resolveDeclaredRoleFromAssignment,
  subagentSeamOf,
  type SubagentActivationSpecView,
  type SubagentSeamRecord,
  type SubagentStartRequestView,
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
 * Declared roles for the pure `personaForRole` matrix (`roles.list`): `coder`
 * carries a chain and a PADDED persona (trimming is pinned), `scout` is
 * CHAINLESS (`chain: []`), `reviewer` declares only whitespace (no persona),
 * and ` padded ` pins the DECLARED RAW id lookup.
 */
const ROLES: FallbacksRole[] = [
  { id: 'coder', persona: '  Coder persona  ', chain: ['openai/gpt-4o'] },
  { id: 'scout', persona: 'Scout persona', chain: [] },
  { id: 'reviewer', persona: '   ' },
  { id: ' padded ', persona: 'Padded persona' },
]

/**
 * A LOCAL backend — a provider that exposes `prepareContinuable`, which is what
 * routes a start through `manager.startLocal` and what makes a caller-reserved
 * `childId` legal (the runtime rejects one on any other backend with
 * `UNSUPPORTED_CAPABILITY`). This is the case the seam's reservation and its
 * synchronous pre-write exist for.
 */
const LOCAL_PROVIDER = { prepareContinuable: () => undefined }

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

  it('bounds the marker-less fallback to the leading header block, so a body-quoted field never resolves (CF-2)', () => {
    // No body marker anywhere (mstar's canonical dispatch text starts with
    // `## Assignment`, which is NOT a boundary), and the header field is
    // UNDECLARED: pre-CF-2 the whole prompt was the region, so the body-quoted
    // `scout` below resolved a role the header never declared — announcing that
    // role and writing a durable `[role: scout]` row.
    const undeclaredHeaderPlusBodyQuote = [
      '## Assignment',
      '',
      '**You are a leaf executor.**',
      '',
      '**Execute as**: generic',
      '',
      '## Read first',
      '',
      'The Assignment must carry a header field such as:',
      '',
      '**Execute as**: scout',
      '',
      'Then start reading.',
    ].join('\n')
    expect(resolveDeclaredRoleFromAssignment(undeclaredHeaderPlusBodyQuote, ROLE_IDS)).toBeUndefined()

    // …and with NO header field at all the dispatch declares nothing, so the
    // brief's quoted field must not become the role either (pre-CF-2: 'coder').
    const bodyQuoteOnly = [
      '## Assignment',
      '',
      '**You are a leaf executor.** Follow the brief.',
      '',
      '## Read first',
      '',
      'The brief quotes the field below verbatim:',
      '',
      '**Execute as**: @coder',
    ].join('\n')
    expect(resolveDeclaredRoleFromAssignment(bodyQuoteOnly, ROLE_IDS)).toBeUndefined()

    // The realistic re-dispatch shape: the ORIGINAL Assignment quoted inside a
    // fenced block. The fence opens a prose paragraph, so the region is closed
    // before it and the header's own field wins.
    const fencedQuote = [
      '## Assignment',
      '',
      '**Execute as**: coder',
      '',
      'Re-dispatch of the brief below:',
      '',
      '```markdown',
      '**Execute as**: scout',
      '```',
    ].join('\n')
    expect(resolveDeclaredRoleFromAssignment(fencedQuote, ROLE_IDS)).toBe('coder')

    // Positive control on the SAME bound: a field inside the leading header block
    // still resolves on a multi-paragraph, marker-less prompt, so the
    // `undefined`s above are the bound and not a resolver that stopped working.
    expect(
      resolveDeclaredRoleFromAssignment(
        '## Assignment\n\n**You are a leaf executor.**\n\n**Execute as**: coder\n\nprose body follows.',
        ROLE_IDS,
      ),
    ).toBe('coder')
    // …including a WRAPPED header paragraph (mstar's canonical dispatch text
    // wraps the IDENTITY block): a bound that stopped at the first non-bold
    // continuation line would attenuate every real Assignment. (The prompt here
    // deliberately starts with `## Assignment`: a single-`#` title is the
    // PINNED engine-parity boundary — residual R-003 — and would empty the
    // region before the fields.)
    expect(
      resolveDeclaredRoleFromAssignment(
        '## Assignment\n\n**IDENTITY** — implementer for Task 1. Load `mstar-roles`\n→ `references/fullstack-dev-shared.md`, then `mstar-coding-behavior`.\n\n**Execute as**: @fullstack-dev\n**Delegation**: forbidden\n',
        new Map([['fullstack-dev', 'fullstack-dev']]),
      ),
    ).toBe('fullstack-dev')
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

/** One captured activation on the fake runtime. */
interface FakeSubagents {
  service: Record<string, unknown>
  /** The activation specs the native path received, in call order. */
  activations: SubagentActivationSpecView[]
  /** The value the native call resolves with; a case may replace it between calls. */
  value: Record<string, unknown>
  /** What `getProvider()` answers, read per call so a case may replace the provider. */
  provider: () => Record<string, unknown> | undefined
  /**
   * Test hook run INSIDE the native call, before it resolves — the only place
   * from which a case can observe the seam's record state at call time (the
   * synchronous pre-write). A returned promise is AWAITED before the native
   * call resolves, which is how a case reproduces the production order: the
   * real `manager.startLocal` awaits the child's serial `agent/created` inside
   * its own start, i.e. BEFORE the wrapper ever sees the result.
   */
  onActivation?: (spec: SubagentActivationSpecView) => void | Promise<void>
}

/**
 * Fake rc.1 `subagents` runtime: records every activation spec it receives and
 * resolves like the real runtime — a CALLER-reserved `childId` IS the child's
 * id (`manager.startLocal`), while an external backend allocates its own and
 * reports it on the activation. `provider` is what `getProvider()` answers:
 * `LOCAL_PROVIDER` for a local backend, `undefined` for an external one.
 */
function fakeSubagents(value: Record<string, unknown> = {}, provider?: Record<string, unknown>): FakeSubagents {
  const activations: SubagentActivationSpecView[] = []
  const fake: FakeSubagents = { service: {}, activations, value, provider: () => provider }
  fake.service = {
    tag: 'raw-subagents',
    getProvider: () => fake.provider(),
    startActivation: async (spec: SubagentActivationSpecView) => {
      activations.push(spec)
      await fake.onActivation?.(spec)
      return {
        ...fake.value,
        ...(spec.childId !== undefined ? { childId: spec.childId } : {}),
      }
    },
  }
  return fake
}

/** Wait one macrotask so a cordis plugin child's `apply` has run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Read `ctx.subagents` the way the host does: from a CONSUMER fiber that
 * injects the service. Returns the consumer's resolved value (the wrapper).
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

/** One activation spec as a caller hands it to `ctx.subagents.startActivation`. */
function activationSpec(
  label: string,
  prompt: string,
  parent?: string,
): { provider: string; label: string; request: SubagentStartRequestView } {
  return {
    provider: 'spawn',
    label,
    request: {
      prompt: prompt === '' ? [] : [{ type: 'text', text: prompt }],
      ...(parent === undefined ? {} : { parent: parentAgent(parent) }),
    },
  }
}

/** Call `startActivation` on an injected wrapper value without a cast at each site. */
function startActivationOf(value: Record<string, unknown>): (spec: unknown) => unknown {
  return value.startActivation as (spec: unknown) => unknown
}

/** Emit the parent-owned catalog event that carries an established child's id. */
function emitCatalogEvent(ctx: Context, parentSessionId: string, childId: string, label: string): void {
  ctx.emit('session/event', { id: parentSessionId }, {
    type: 'subagent/catalog',
    seq: 1,
    time: Date.now(),
    data: { version: 0, childId, childCreatedAt: Date.now(), mode: 'one-shot', label },
  })
}

describe('subagent seam — behavioural (public call path)', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
  })

  it('reserves the child id for a local backend and writes the record BEFORE the native call (timing core)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    // The record must already exist when the native call runs: `agent/created`
    // fires inside it, so a record written from the resolved activation would
    // arrive after the child's own listeners read the map.
    let atCall: SubagentSeamRecord | undefined
    fake.onActivation = (spec) => {
      const reserved = spec.childId === undefined ? undefined : seam.records.get(spec.childId)
      // Snapshot the pre-write BEFORE the listener writes below: the seam's own
      // reservation carries NO persona verdict of its own (it synthesizes none —
      // the verdict is Task 1's, written over this same map).
      atCall = reserved === undefined ? undefined : { ...reserved }
      // Lifecycle inside the native call: the role-persona listener verdicts the
      // child DURING its creation, and Task 3 emits the session's one notice row
      // before the call returns. Both writes must survive the rewrite the
      // resolved activation performs below (review I: the sticky verdict).
      if (reserved !== undefined) {
        reserved.personaNotApplied = true
        reserved.firstNoticePending = false
      }
    }

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    const spec = activationSpec('task one', assignment('coder'), 'parent-session')
    const result = await startActivationOf(value)(spec)

    // The native call ran with the caller's OWN object (never mutated) plus a
    // reserved identity — the manager treats caller-reserved and self-minted
    // ids identically.
    const received = fake.activations[0]!
    expect(received).not.toBe(spec)
    expect(received.childId).toEqual(expect.any(String))
    expect(received.childId).not.toBe('')
    expect(spec).not.toHaveProperty('childId')
    // …and the record was there BEFORE the call, keyed by that reserved id.
    expect(atCall).toEqual({ role: 'coder', at: expect.any(Number), firstNoticePending: true })
    // The resolved activation reports the same child; its rewrite re-records
    // from the EXISTING entry, so the verdict written during creation and the
    // cleared notice marker both survive it (a rewrite carries neither).
    expect(result).toMatchObject({ childId: received.childId })
    expect(seam.records.get(received.childId!)).toEqual({
      role: 'coder',
      at: expect.any(Number),
      firstNoticePending: false,
      personaNotApplied: true,
    })
  })

  it('a throwing native call still propagates and rolls the reservation back', async () => {
    ctx = new Context()
    const service = {
      getProvider: () => LOCAL_PROVIDER,
      startActivation: () => {
        throw new Error('native start refused')
      },
    }
    ctx.provide('subagents', service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    // Interception precondition (review M-1): "no record" is a NEGATIVE and
    // holds for the raw service too — pin the interception first.
    expect(value).not.toBe(service)
    expect(() => startActivationOf(value)(activationSpec('task', assignment('coder'), 'parent-session'))).toThrow(
      'native start refused',
    )
    expect(seam.records.size).toBe(0)
  })

  it('a rejected native call ends the claim AND rolls the reservation back (review M-2)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const service = {
      getProvider: () => LOCAL_PROVIDER,
      startActivation: () => Promise.reject(new Error('native start rejected')),
    }
    ctx.provide('subagents', service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    await expect(
      startActivationOf(value)(activationSpec('task', assignment('coder'), 'parent-session')) as Promise<unknown>,
    ).rejects.toThrow('native start rejected')

    // No child was established, so neither the pre-written record nor the claim
    // may linger: a catalog event for the same (parent session, label) must NOT
    // key a record. A native rejection is not a seam degrade — no debug line.
    expect(seam.records.size).toBe(0)
    emitCatalogEvent(ctx, 'parent-session', 'child-after-reject', 'task')
    expect(seam.records.size).toBe(0)
    expect(debug).not.toHaveBeenCalled()
  })

  it('an EXTERNAL backend receives the caller’s own spec and is keyed off the resolved childId', async () => {
    ctx = new Context()
    // No provider ⇒ not a local backend: the runtime allocates the child id, and
    // a reserved id would be rejected with UNSUPPORTED_CAPABILITY.
    const fake = fakeSubagents({ childId: 'child-external' })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    const spec = { ...activationSpec('external task', assignment('coder'), 'parent-session'), provider: 'acp' }
    const result = await startActivationOf(value)(spec)

    // The SAME spec object travelled to the native path (byte-identical), and
    // the record was keyed off the child the activation reported — with NO
    // persona verdict: the resolved-activation write synthesizes none.
    expect(fake.activations[0]).toBe(spec)
    expect(result).toMatchObject({ childId: 'child-external' })
    expect(seam.records.get('child-external')).toEqual({
      role: 'coder',
      at: expect.any(Number),
      firstNoticePending: true,
    })
  })

  it('falls back to the per-child record for a resume without an Assignment header', async () => {
    ctx = new Context()
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    // The child was recorded by an earlier dispatch (durable id reused on
    // resume), already verdict'd by the persona listener (`personaNotApplied`)
    // and already announced (cleared notice marker).
    seam.records.set('child-resumed', {
      role: 'reviewer',
      at: 1,
      firstNoticePending: false,
      personaNotApplied: true,
    })

    const { value } = await injectSubagents(ctx)
    const spec = { provider: 'spawn', label: 'resume', childId: 'child-resumed', request: { prompt: [] } }
    await startActivationOf(value)(spec)

    // The resume reused the record (role re-recorded, last-wins) and kept the
    // cleared notice marker, so Task 3 cannot emit a second notice row.
    // DISCRIMINATING (review I-1): the wrapper REWRITES the record with a fresh
    // `at`, so the seed's `1` cannot survive — this assertion fails when
    // interception is broken, which the role/marker assertions cannot detect
    // (they all hold against the raw service).
    const resumed = seam.records.get('child-resumed')
    expect(resumed?.at).toBeGreaterThan(1)
    // The rewrite carries NO verdict of its own: the listener's sticky `true` is
    // the whole handoff of Task 1's failure signal across this rewrite, so it
    // must survive — and nothing may synthesize a verdict where there was none.
    expect(resumed).toEqual({
      role: 'reviewer',
      at: expect.any(Number),
      firstNoticePending: false,
      personaNotApplied: true,
    })
    // A caller that already reserved the id keeps its OWN spec object: no copy.
    expect(fake.activations[0]).toBe(spec)
  })

  it('leaves the native path byte-identical when neither the header nor the record resolves a role', async () => {
    ctx = new Context()
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    // Interception precondition (review M-1): every assertion below is a
    // NEGATIVE (nothing changed / nothing recorded), which the raw service also
    // satisfies — so pin the interception itself first.
    expect(value).not.toBe(fake.service)
    const request = { prompt: [{ type: 'text', text: 'no assignment header here' }] }
    const spec = { provider: 'spawn', label: 'plain', request }
    await startActivationOf(value)(spec)

    // The SAME spec object reached the service, and nothing was recorded.
    expect(fake.activations[0]).toBe(spec)
    expect(seam.records.size).toBe(0)

    // The resume fallback's other half: a reserved id with no record and no
    // header is a no-op too (a fresh child, nothing to key).
    const fresh = { provider: 'spawn', label: 'fresh', childId: 'child-fresh', request: { prompt: [] } }
    await startActivationOf(value)(fresh)
    expect(fake.activations[1]).toBe(fresh)
    expect(seam.records.size).toBe(0)
  })

  it('keys the child-id-bearing result vocabulary (`childId`, `subagentId`, `runId`)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ childId: 'child-activation' })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    const start = startActivationOf(value)
    await start({ ...activationSpec('activation shape', assignment('coder')), provider: 'acp' })
    // Tool-result vocabulary a reshaped runtime may still hand back: both ARE
    // session ids.
    fake.value = { kind: 'continuable', subagentId: 'child-continuable' }
    await start({ ...activationSpec('continuable shape', assignment('scout')), provider: 'acp' })
    fake.value = { kind: 'foreground', runId: 'child-foreground' }
    await start({ ...activationSpec('foreground shape', assignment('reviewer')), provider: 'acp' })

    expect(seam.records.get('child-activation')?.role).toBe('coder')
    expect(seam.records.get('child-continuable')?.role).toBe('scout')
    expect(seam.records.get('child-foreground')?.role).toBe('reviewer')
  })

  it('never keys a `jobId` result and correlates the child through the catalog event', async () => {
    ctx = new Context()
    const fake = fakeSubagents({ kind: 'background', jobId: 'job-7' })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    await startActivationOf(value)({
      ...activationSpec('background task', assignment('coder'), 'parent-session'),
      provider: 'acp',
    })

    // A registry job id is NOT a session id.
    expect(seam.records.has('job-7')).toBe(false)
    expect(seam.records.size).toBe(0)

    // The parent-owned catalog event supplies the child session id; the join is
    // (delegating parent session, activation label).
    emitCatalogEvent(ctx, 'parent-session', 'child-background', 'background task')
    expect(seam.records.get('child-background')?.role).toBe('coder')
  })

  it('bounds the catalog-correlation claims and evicts by RECENCY, not first insertion (CF-8)', async () => {
    ctx = new Context()
    // Every result carries ONLY a job id, so no record is keyed and each claim
    // stays open in the bounded map.
    const fake = fakeSubagents({ kind: 'background', jobId: 'job-x' })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    const start = startActivationOf(value)
    const claim = (label: string): unknown =>
      start({ ...activationSpec(label, assignment('coder'), 'parent-bounded'), provider: 'acp' })

    for (let index = 0; index < PENDING_CORRELATION_LIMIT; index += 1) await claim(`label-${index}`)
    // Re-claim the FIRST label: it is now the NEWEST claim, so the recency policy
    // must keep it across the eviction the next insertion forces — under the old
    // first-insertion FIFO it was exactly the key that would be dropped.
    await claim('label-0')
    await claim('label-overflow')

    emitCatalogEvent(ctx, 'parent-bounded', 'child-hot', 'label-0')
    emitCatalogEvent(ctx, 'parent-bounded', 'child-cold', 'label-1')
    // The bound + recency are observable in one shot: the oldest UNTOUCHED claim
    // was evicted (its catalog event resolves no claim), the re-claimed hot key
    // survived, and the newest claim is still there.
    expect(seam.records.get('child-hot')?.role).toBe('coder')
    expect(seam.records.has('child-cold')).toBe(false)
    emitCatalogEvent(ctx, 'parent-bounded', 'child-newest', 'label-overflow')
    expect(seam.records.get('child-newest')?.role).toBe('coder')
  })

  it('contains a result whose `then` accessor throws, after the native activation already ran (CF-4)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'then', {
      get() {
        throw new Error('then accessor boom')
      },
    })
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    // The native call returns the exotic object DIRECTLY (no promise wrapper), so
    // the wrapper's shape probe is the statement that throws. It still records the
    // delegation, so "the native call ran" is asserted rather than assumed.
    fake.service.startActivation = (spec: SubagentActivationSpecView) => {
      fake.activations.push(spec)
      return hostile
    }
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    const start = startActivationOf(value)
    // NOT awaited: the wrapper is synchronous (it forwards the native result), and
    // `await` on a value with a throwing `then` accessor would throw in the TEST
    // rather than exercise the wrapper's containment.
    const result = start(activationSpec('hostile', assignment('coder'), 'parent-session'))
    // The child EXISTS (the native call ran): the dispatch must still hand the
    // caller its own result instead of throwing the accessor's error.
    expect(result).toBe(hostile)
    expect(fake.activations).toHaveLength(1)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('then accessor boom')
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

  it('does not wrap a service that is not an activation-capable runtime (the rc.1 install gate)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    // The PRE-rc.1 surface (and any other reshaped runtime): no `startActivation`,
    // so the seam must stay out of the way and say so once.
    const legacy = { tag: 'legacy-runtime', start: () => {}, startContinuable: () => {} }
    ctx.provide('subagents', legacy)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    expect(value).toBe(legacy)
    expect(seam.records.size).toBe(0)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('not an activation-capable runtime')
  })

  it('emits exactly ONE contained debug log when the prompt declares no resolvable role (review M-5)', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    const start = startActivationOf(value)
    // No prompt text at all (e.g. a resume): nothing to report.
    await start({ provider: 'spawn', label: 'empty', request: { prompt: [] } })
    expect(debug).not.toHaveBeenCalled()
    // A prompt IS present but declares no resolvable role — an absent field,
    // then an undeclared id (and a `#`-led prompt behaves the same: the header
    // region is empty at engine parity). The live no-op becomes observable, and
    // the latch keeps it to ONE line per apply.
    await start(activationSpec('absent', 'no assignment header here'))
    await start(activationSpec('undeclared', assignment('nobody')))
    await start(activationSpec('title-led', '# Title\n\n**Execute as**: coder'))
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('no role resolved')
    expect(seam.records.size).toBe(0)
  })

  it('canonicalizes a padded, @-prefixed declaration end to end (case g)', async () => {
    ctx = new Context()
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    await startActivationOf(value)(activationSpec('padded', assignment('  @PADDED  ')))

    // The record carries the DECLARED RAW id (` padded `, the settings entry as
    // written): a canonicalization that returned the trimmed lookup key
    // (`padded`) would key the record differently, and `personaForRole` — which
    // matches `role.id` exactly — would find no persona for it.
    const reserved = fake.activations[0]!.childId
    expect(seam.records.get(String(reserved))?.role).toBe(' padded ')
  })

  it('contains a throwing provider lookup: the caller’s own spec reaches the native path', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ childId: 'child-provider-boom' })
    let healthy = false
    fake.provider = () => {
      if (!healthy) throw new Error('provider boom')
      return LOCAL_PROVIDER
    }
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })

    const { value } = await injectSubagents(ctx)
    const start = startActivationOf(value)
    const spec = { ...activationSpec('unverifiable', assignment('coder')), provider: 'acp' }
    await start(spec)

    // The local-backend probe degraded, so the wrapper reserved nothing: the
    // caller's OWN spec travelled, the record came from the resolved activation,
    // and the throw is ONE contained line.
    expect(fake.activations[0]).toBe(spec)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('provider boom')
    expect(seam.records.get('child-provider-boom')?.role).toBe('coder')

    // Positive control: the lookup heals → the same dispatch point reserves an
    // id and pre-writes the record before the native call.
    healthy = true
    let atCall: SubagentSeamRecord | undefined
    fake.onActivation = (received) => {
      atCall = received.childId === undefined ? undefined : seam.records.get(received.childId)
    }
    await start(activationSpec('healed', assignment('coder')))
    expect(fake.activations[1]!.childId).toEqual(expect.any(String))
    expect(atCall?.role).toBe('coder')
  })

  it('contains a throwing spec spread: the caller’s own spec takes the native path, and the miss still reaches the notice row', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const fake = fakeSubagents({ childId: 'child-spread-boom' }, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    // `roles` is the ONE extra input this path needs — the SAME live source
    // `src/index.ts` wires. The runtime mints its OWN child id below, so no
    // `agent/created` listener can report this child: the seam has to carry the
    // verdict itself, or the notice reports a persona that never arrived.
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })
    // The persona listener is installed exactly as the production composition
    // installs it. IF it could see this child it would register the section and
    // leave the verdict absent, so the empty journal below is the control that
    // it really missed.
    const journal: Array<{ name: string; order: number; text: unknown }> = []
    const childScope = ctx.isolate('systemPrompt')
    childScope.provide('systemPrompt', {
      getSectionOrder: () => 0,
      section: (section: { name: string; order: number; text: unknown }) => {
        journal.push(section)
        return () => {}
      },
    })
    installRolePersona(ctx, { records: seam.records, roles: () => ROLES, debug })
    // A LOCAL role dispatch whose spec cannot be copied: an UNRELATED enumerable
    // accessor throws while the wrapper builds the reserved spec. The seam never
    // consumes that field, so the native runtime would have accepted the object
    // — the reservation (pure seam bookkeeping) must degrade instead of failing
    // the dispatch, exactly like every other seam failure.
    const spec = activationSpec('unverifiable', assignment('coder'))
    Object.defineProperty(spec, 'hostile', {
      enumerable: true,
      get() {
        throw new Error('spread boom')
      },
    })
    // The child the runtime creates for the forwarded spec: its id is the one
    // the fake reports back, and it is the id the record must land under.
    const childAgent = makeAgent('child-spread-boom', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' }).agent
    Object.assign(childAgent, { ctx: childScope })
    let atCall: number | undefined
    fake.onActivation = async () => {
      atCall = seam.records.size
      // The rc.1 native local start AWAITS the created child's serial
      // `agent/created` before the start resolves — i.e. before the wrapper can
      // key any record off the resolved id, which is why the listener misses.
      await ctx.serial('agent/created', { agent: childAgent, source: 'startup' })
    }

    const { value } = await injectSubagents(ctx)
    const result = await startActivationOf(value)(spec)

    // The native call still happened, ONCE, with the caller's OWN object, and
    // nothing was pre-written for a child the seam never reserved.
    expect(fake.activations[0]).toBe(spec)
    expect(fake.activations).toHaveLength(1)
    expect(atCall).toBe(0)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('spread boom')
    // The caller keeps its own result and the native path still keys the child
    // it created off the resolved activation.
    expect(result).toMatchObject({ childId: 'child-spread-boom' })
    expect(seam.records.get('child-spread-boom')?.role).toBe('coder')
    // `agent/created` already ran, so the persona listener could neither deliver
    // NOR report: the verdict must ride the record the notice reads instead.
    expect(journal).toEqual([])
    expect(seam.records.get('child-spread-boom')?.personaNotApplied).toBe(true)

    // End to end: the child's own first step admits the row WITH the suffix.
    // Pre-fix this reads `[role: coder]` — a persona the child never received.
    const claimed = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    const decision = await ctx.waterfall(
      'agent/pre-step',
      { agent: childAgent, messages: [claimed], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [claimed] }),
    )
    if (decision.kind !== 'enter') throw new Error(`expected an enter decision, got '${decision.kind}'`)
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1]!.content[0]).toMatchObject({
      type: 'text',
      text: '[role: coder] (persona not applied)',
    })
  })
})

describe('subagent seam — wrapper identity + install topology', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('SECONDARY: an injected consumer reads the wrapper, not the raw service', async () => {
    ctx = new Context()
    const raw = fakeSubagents({ childId: 'child-1' }).service
    ctx.provide('subagents', raw)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })

    const { value } = await injectSubagents(ctx)
    // Distinguishable identity: a different object that still delegates the
    // raw service's own members (prototype delegation, raw never mutated).
    expect(value).not.toBe(raw)
    expect(value.tag).toBe('raw-subagents')
    expect(typeof value.startActivation).toBe('function')
  })

  it('OPTIONAL canary: the cordis service-read waterfall dispatches for `subagents`', async () => {
    // Canary tied to the cordis event literal `internal/get`. Behavioural
    // coverage above does not depend on it (a cordis rename degrades delivery
    // only — plan Risk).
    ctx = new Context()
    ctx.provide('subagents', fakeSubagents({ childId: 'child-1' }).service)
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

/**
 * The guard for the regression class that hid the rc.1 migration: this seam
 * consumes `ctx.subagents` through LOCAL structural views (no `dsh-subagent`
 * peer), so a self-shaped test fake plus `tsc` both stayed green while the
 * installed runtime had already replaced `start`/`startContinuable` with
 * `startActivation` — the planted fakes and the seam's views agreed with each
 * other and with nothing else.
 *
 * The probe pins the DECLARED surface the install gate and the wrapper are
 * written against, resolved from the installed package itself (its own `types`
 * entry — no hard-coded version, path or dist layout). Only that entry file is
 * read: it declares the service the seam wraps, whereas sibling files mention
 * `start(` for unrelated internals (an `ActivationObserver`, a doc comment), so
 * scanning the directory would fail on shapes that are not this contract.
 */
function assertActivationSurface(surface: string): void {
  expect(surface).toMatch(/startActivation\s*\(/)
  expect(surface).not.toContain('startContinuable')
  expect(surface).not.toMatch(/\bstart\s*\(/)
}

/** One installed package's declared type surface, from that package's own manifest. */
function installedSubagentSurface(): string {
  const manifestPath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-subagent/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { types?: string }
  if (typeof manifest.types !== 'string') throw new Error('@deepseek-ai/dsh-subagent declares no `types` entry')
  return readFileSync(resolve(dirname(manifestPath), manifest.types), 'utf8')
}

describe('subagent seam — installed peer surface (drift probe)', () => {
  it('the installed @deepseek-ai/dsh-subagent service surface is startActivation-shaped', () => {
    assertActivationSurface(installedSubagentSurface())
  })

  it('rejects the pre-rc.1 surface shape (the guard’s own negative control)', () => {
    // The surface this plugin was originally written against: the probe must
    // REJECT it, or it pins nothing.
    const legacy = [
      'start(name: string, request: SubagentStartRequest): Promise<SubagentResult>;',
      'startContinuable(spec: SubagentActivationSpec): Promise<SubagentActivation>;',
    ].join('\n')
    expect(() => assertActivationSurface(legacy)).toThrow()
    // Positive control on the SAME helper: an activation-shaped surface passes.
    expect(() => assertActivationSurface('startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>')).not.toThrow()
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
    expect(first!.ownsWrapper).toBe(true)

    // A later fiber over the shared root does NOT install a second listener set
    // (no nested wrapper): it shares the root's record map and reports the
    // ownership structurally (CF-5 — no thrown message, no no-op seam).
    expect(() => apply(ctx, config())).not.toThrow()
    const second = subagentSeamOf(ctx)
    expect(second).not.toBe(first)
    expect(second!.ownsWrapper).toBe(false)
    expect(second!.records).toBe(first!.records)
    expect(second!.noticeEmitted).toBe(first!.noticeEmitted)
  })

  it('multi-fiber: the wrapper has ONE owner while every applied fiber keeps its role surfaces (CF-5)', async () => {
    const fake = fakeSubagents({ childId: 'child-multi' })
    ctx.provide('subagents', fake.service)
    const config = () => cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } })

    // TWO APPLIED FIBERS over ONE root — the composition the M-3 dedupe exists
    // for, with each fiber disposable on its own.
    let firstCtx: Context | undefined
    let secondCtx: Context | undefined
    const firstFiber = ctx.plugin({
      name: 'fallbacks-multi-first',
      apply: (fiberCtx: Context) => {
        firstCtx = fiberCtx
        apply(fiberCtx, config())
      },
    })
    await nextTick()
    const secondFiber = ctx.plugin({
      name: 'fallbacks-multi-second',
      apply: (fiberCtx: Context) => {
        secondCtx = fiberCtx
        apply(fiberCtx, config())
      },
    })
    await nextTick()

    const first = subagentSeamOf(firstCtx!)
    const second = subagentSeamOf(secondCtx!)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // Structural ownership, not message matching: the first fiber owns the
    // root-scoped wrapper, the later one shares the root's state.
    expect(first!.ownsWrapper).toBe(true)
    expect(second!.ownsWrapper).toBe(false)
    expect(second!.records).toBe(first!.records)

    // ONE wrapper: the dispatch reaches the raw service exactly once (a nested
    // wrapper would call it twice) and keys the SHARED record map.
    const { value } = await injectSubagents(ctx)
    await startActivationOf(value)({ ...activationSpec('multi', assignment('coder')), provider: 'acp' })
    expect(fake.activations).toHaveLength(1)
    expect(first!.records.get('child-multi')?.role).toBe('coder')

    // The wrapper OWNER disposes while the other fiber stays applied: the root
    // claim is released (so a later apply can own the wrapper again) and the
    // survivor's own notice emitter / projection registration is untouched —
    // its survival is pinned in `role-notice.spec.ts` (emitter) and
    // `role-projection.spec.ts` (registry key).
    await firstFiber.dispose()
    expect(second!.ownsWrapper).toBe(false)

    let thirdCtx: Context | undefined
    const thirdFiber = ctx.plugin({
      name: 'fallbacks-multi-third',
      apply: (fiberCtx: Context) => {
        thirdCtx = fiberCtx
        apply(fiberCtx, config())
      },
    })
    await nextTick()
    const third = subagentSeamOf(thirdCtx!)
    expect(third!.ownsWrapper).toBe(true)
    // …and the shared state object outlived the owner disposal (the survivor and
    // the re-install read the SAME map).
    expect(third!.records).toBe(first!.records)
    await thirdFiber.dispose()
    await secondFiber.dispose()
  })

  it('pre-writes the role record before the native call at the ONE install point (apply())', async () => {
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    // This fiber owns the wrapper (the dedupe above leaves that single-owner
    // part to the first install), and it is exactly where the reservation has to
    // happen: `index.ts` installs ONE seam per fiber, so the record a role child
    // is announced from must come from this call path.
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Applied persona', chain: [] }], rules: [] } }))
    const seam = subagentSeamOf(ctx)!
    let atCall: SubagentSeamRecord | undefined
    fake.onActivation = (spec) => {
      atCall = spec.childId === undefined ? undefined : seam.records.get(spec.childId)
    }

    const { value } = await injectSubagents(ctx)
    expect(value).not.toBe(fake.service)
    await startActivationOf(value)(activationSpec('applied', assignment('coder')))

    // Dropping the reservation (or writing the record only from the resolved
    // activation) fails here.
    const reserved = fake.activations[0]!.childId
    expect(reserved).toEqual(expect.any(String))
    expect(atCall?.role).toBe('coder')
    expect(seam.records.get(String(reserved))?.role).toBe('coder')
  })

  it('reads the live declared-role map per activation, so a role ADDED by a settings edit resolves without a re-install', async () => {
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } }))

    const { value } = await injectSubagents(ctx)
    const start = startActivationOf(value)
    // Before the edit `rookie` is UNDECLARED: nothing resolves, nothing is
    // recorded — and the caller's own spec object travels untouched.
    const before = activationSpec('undeclared role', assignment('rookie'))
    await start(before)
    expect(subagentSeamOf(ctx)!.records.size).toBe(0)
    expect(fake.activations[0]).toBe(before)

    // A REAL settings write adds the role id: `roleIds` is a LIVE read (the same
    // thunk the settings onChange re-derives), so the NEXT dispatch resolves the
    // new id through the seam installed BEFORE the edit — no re-install, no stale
    // trimmed-id map (Task 4 review Minor 4).
    await ctx.settings.update(FALLBACKS_PROFILE_ENTRY, {
      roles: {
        list: [
          { id: 'coder', persona: 'Coder persona', chain: [] },
          { id: 'rookie', persona: 'Rookie persona', chain: [] },
        ],
        rules: [],
      },
    })
    await start(activationSpec('added role', assignment('rookie')))
    const reserved = fake.activations[1]!.childId
    expect(subagentSeamOf(ctx)!.records.get(String(reserved))?.role).toBe('rookie')
  })

  it('the service getter reads the dispatch role before the child’s first step (plan agent-role-getter)', async () => {
    // LOCAL backend: this is the only path on which the record can exist BEFORE
    // the native call — `manager.startLocal` creates the child inside it, so the
    // caller-reserved id and its record are the seam's creation-time guarantee.
    const fake = fakeSubagents({}, LOCAL_PROVIDER)
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: '', chain: [] }], rules: [] } }))
    // The service lives inside the settings inject child (seeds-declare-window):
    // wait for visibility, then read the getter through the REAL service face.
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })
    const fb = ctx.get('llm-fallbacks')!
    const seam = subagentSeamOf(ctx)!
    // Read the map INSIDE the native call — the instant the child is created.
    let atCall: SubagentSeamRecord | undefined
    fake.onActivation = (spec) => {
      atCall = spec.childId === undefined ? undefined : seam.records.get(spec.childId)
    }

    const { value } = await injectSubagents(ctx)
    await startActivationOf(value)(activationSpec('task one', assignment('coder'), 'parent-session'))
    const reserved = String(fake.activations[0]!.childId)

    // The record was already written when the native activation ran…
    expect(atCall?.role).toBe('coder')
    // …and the real service face answers the DECLARED RAW role immediately after
    // it returns: the notice row's precondition still holds — nothing has
    // emitted the durable `[role: coder]` row yet, so this is the pre-first-step
    // read, not a projection read.
    expect(seam.records.get(reserved)?.firstNoticePending).toBe(true)
    expect(fb.getAgentRole(reserved)).toBe('coder')
    // A non-role child reads as `null`, never `undefined`.
    expect(fb.getAgentRole('no-such-child')).toBeNull()

    // The EXTERNAL path shares the same map with a later timing: its id is
    // allocated by the provider, so the record can only appear once the resolved
    // activation reports it — nothing is readable before (S-001).
    fake.value = { childId: 'child-external' }
    fake.provider = () => undefined
    expect(seam.records.has('child-external')).toBe(false)
    await startActivationOf(value)(activationSpec('task two', assignment('coder'), 'parent-session'))
    expect(fb.getAgentRole('child-external')).toBe('coder')
  })
})
