/**
 * In-session role notice row (plan role-based-subagent-adoption Task 3).
 *
 * Coverage is behavioural and public-path, mirroring `subagents-seam.spec.ts`:
 * a `subagents` service is provided, the seam is installed exactly as `apply()`
 * installs it, a consumer CALLS `ctx.subagents.start(...)`, and the child's own
 * `agent/pre-step` waterfall is driven the way the loop drives it
 * (`agent-loop/src/agent.ts:241-257`). Records are created by the production
 * path — never seeded — except where a case must isolate one marker, and every
 * such case carries an in-test positive control (the Task 1 I-1 / M-1 lesson:
 * a negative that also holds with the behaviour broken proves nothing).
 *
 * The last describe block is the contract guard: the emitted source kind must be
 * a member of the FROZEN released kind set the V2→V3 edge classifies.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { installSubagentSeam, subagentSeamOf, type SubagentSeamRecord, type SubagentStartRequestView } from '../src/subagents-seam.ts'
import { buildRoleNotice, installRoleNotice, ROLE_NOTICE_PLUGIN, ROLE_NOTICE_SOURCE_KIND, type RoleNoticeBuilder } from '../src/role-notice.ts'
import type { FallbacksRole } from '../src/config.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, makeAgent } from './support/harness.ts'

/** Declared taxonomy: `coder` and `scout` declare a persona, `reviewer` only whitespace. */
const ROLES: FallbacksRole[] = [
  { id: 'coder', persona: 'Coder persona', chain: [] },
  { id: 'scout', persona: 'Scout persona', chain: ['openai/gpt-4o'] },
  { id: 'reviewer', persona: '   ' },
]

const ROLE_IDS = new Map([
  ['coder', 'coder'],
  ['scout', 'scout'],
  ['reviewer', 'reviewer'],
])

/** An Assignment carrying the header field `**Execute as**: <id>` (the seam's role source). */
function assignment(executeAs: string): string {
  return ['## Assignment', '', `- **Execute as**: ${executeAs}`, '', '## Task 1 — something', ''].join('\n')
}

/** One claimed inbox message (what the loop hands the pre-step waterfall). */
function claimedMessage(text = 'do the assigned task'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The admitted messages of an `enter` decision; throws for a `reject` (never expected here). */
function admittedMessages(decision: PreStepDecision): UserMessage[] {
  if (decision.kind !== 'enter') throw new Error(`expected an enter decision, got '${decision.kind}'`)
  return decision.messages
}

/** The one text block of a produced message (the notice's model-visible content). */
function textOf(message: UserMessage): string {
  const block = message.content[0] as { type: string; text: string }
  return block.text
}

interface FakeSubagents {
  service: Record<string, unknown>
  starts: Array<{ name: string; request: SubagentStartRequestView }>
}

/**
 * Fake `subagents` runtime: records every delegated call and answers
 * `getProvider(name)` from `providers` — the Task 2 capability gate read, so a
 * single test can exercise a capability-carrying and a capability-less provider
 * by dispatching under different provider names.
 */
function fakeSubagents(
  startResult: unknown,
  providers: Record<string, Record<string, unknown>> = {},
): FakeSubagents {
  const starts: FakeSubagents['starts'] = []
  const resolveResult = typeof startResult === 'function'
    ? (startResult as (request: SubagentStartRequestView) => unknown)
    : () => startResult
  const service: Record<string, unknown> = {
    tag: 'raw-subagents',
    getProvider: (name: string) => providers[name],
    start: (name: string, request: SubagentStartRequestView) => {
      starts.push({ name, request })
      return Promise.resolve(resolveResult(request))
    },
  }
  return { service, starts }
}

/** Every child result is keyed by the request label, so a test reads the child id back off its own dispatch. */
const childIdFromLabel = (request: SubagentStartRequestView): unknown => ({ id: request.label! })

/** Wait one macrotask so a cordis plugin child's `apply` has run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Read `ctx.subagents` the way the host does — from a CONSUMER fiber that
 * injects the service (a same-fiber read is short-circuited by cordis and would
 * bypass the wrapper). Each call registers its own named consumer, so a test can
 * read the wrapper's `start` and `startContinuable` independently.
 */
async function seamConsumer(ctx: Context, name: string): Promise<Record<string, unknown>> {
  let captured: Context | undefined
  ctx.plugin({
    name,
    inject: ['subagents'],
    apply(consumerCtx: Context) {
      captured = consumerCtx
    },
  })
  await nextTick()
  if (captured === undefined) throw new Error('consumer fiber did not apply')
  return (captured as unknown as { subagents: Record<string, unknown> }).subagents
}

/** The wrapper's `start` (the dispatch path the notice record is keyed from). */
async function seamStart(
  ctx: Context,
): Promise<(name: string, request: SubagentStartRequestView) => Promise<unknown>> {
  const value = await seamConsumer(ctx, 'role-notice-consumer-start')
  return (name, request) => (value.start as (n: string, r: SubagentStartRequestView) => Promise<unknown>)(name, request)
}

/** The wrapper's `startContinuable` (the resume path that REWRITES a child's record). */
async function seamContinuable(
  ctx: Context,
): Promise<(spec: Record<string, unknown>) => Promise<unknown>> {
  const value = await seamConsumer(ctx, 'role-notice-consumer-continuable')
  return (spec) => (value.startContinuable as (s: Record<string, unknown>) => Promise<unknown>)(spec)
}

/**
 * Drive one `agent/pre-step` waterfall exactly like the loop's `preStep`
 * (`agent-loop/src/agent.ts:241-257`): the default callback returns the claimed
 * messages (the real default additionally appends the assembled
 * system-prompt section, which no notice decision reads).
 */
function drivePreStep(
  ctx: Context,
  agent: Agent,
  messages: readonly UserMessage[],
  step = 1,
  next?: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  return ctx.waterfall(
    'agent/pre-step',
    { agent, turn: 1, step, signal: new AbortController().signal },
    next ?? (() => Promise.resolve({ kind: 'enter' as const, messages: [...messages] })),
  )
}

/** A subagent-origin agent stand-in whose `id` matches the dispatched child session id. */
function childAgent(id: string): Agent {
  return makeAgent(id, { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' }).agent
}

describe('buildRoleNotice — the sanctioned session-write shape (pure)', () => {
  it('writes [role: <id>] with the plugin notice source', () => {
    const notice = buildRoleNotice('coder', false)
    expect(notice.role).toBe('user')
    expect(notice.content).toEqual([{ type: 'text', text: '[role: coder]' }])
    expect(notice.source.kind).toBe('plugin')
    expect(notice.source.kind).toBe(ROLE_NOTICE_SOURCE_KIND)
    expect((notice.source as { plugin?: string }).plugin).toBe(ROLE_NOTICE_PLUGIN)
    expect((notice.source as { form?: string }).form).toBe('notice')
    expect((notice.source as { summary?: string }).summary).toBe('role: coder')
  })

  it('appends the persona suffix to the text and keeps the summary', () => {
    const skipped = buildRoleNotice('coder', true)
    expect(skipped.content).toEqual([{ type: 'text', text: '[role: coder] (persona not applied)' }])
    expect((skipped.source as { summary?: string }).summary).toBe('role: coder')

    // Positive control: the two arms differ ONLY by the verdict — so the suffix
    // assertion above is not satisfied by a builder that always appends it.
    const delivered = buildRoleNotice('coder', false)
    expect(textOf(delivered)).toBe('[role: coder]')
    expect(textOf(delivered)).not.toContain('persona not applied')
  })
})

describe('role notice — behavioural (public call path)', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
  })

  it('emits exactly ONE row for a recorded child across repeated pre-steps', async () => {
    ctx = new Context()
    const fake = fakeSubagents(childIdFromLabel, { spawn: { capabilities: { persona: true } } })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const start = await seamStart(ctx)
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-one' })

    // The record was keyed by the PRODUCTION path (the wrapped start's result id).
    expect(seam.records.get('child-one')).toMatchObject({ role: 'coder', firstNoticePending: true })

    const agent = childAgent('child-one')
    const claimed = claimedMessage()

    const first = admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))
    // The claimed batch is preserved and the notice is appended LAST.
    expect(first).toHaveLength(2)
    expect(first[0]).toBe(claimed)
    expect(textOf(first[1]!)).toBe('[role: coder]')
    expect(seam.records.get('child-one')!.firstNoticePending).toBe(false)

    // Two LATER steps of the same child: no second row, ever.
    for (const step of [2, 3]) {
      const decision = admittedMessages(await drivePreStep(ctx, agent, [claimed], step))
      expect(decision).toEqual([claimed])
    }
    expect(seam.noticeEmitted.has('child-one')).toBe(true)
  })

  it('emits nothing for a root agent, with the same record as positive control', async () => {
    ctx = new Context()
    const fake = fakeSubagents(childIdFromLabel, { spawn: { capabilities: { persona: true } } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const start = await seamStart(ctx)
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-root' })

    const claimed = claimedMessage()
    // A ROOT agent (no `origin`): the record exists, and the origin gate alone
    // is what withholds the row.
    const root = makeAgent('child-root', { provider: 'mock', model: 'gpt-4o' }, {}).agent
    expect(admittedMessages(await drivePreStep(ctx, root, [claimed], 1))).toEqual([claimed])

    // Positive control: the SAME record, a subagent-origin agent ⇒ the row lands.
    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-root'), [claimed], 1))
    expect(decision).toHaveLength(2)
    expect(textOf(decision[1]!)).toBe('[role: coder]')
  })

  it('emits nothing for an unrecorded child, with a recorded sibling as positive control', async () => {
    ctx = new Context()
    const fake = fakeSubagents(childIdFromLabel, { spawn: { capabilities: { persona: true } } })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const start = await seamStart(ctx)
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-known' })

    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-unrecorded'), [claimed], 1))).toEqual([claimed])

    // Positive control: a child this seam DID record gets its row in the same setup.
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-known'), [claimed], 1))).toHaveLength(2)
  })

  it('never announces an inherit/unresolved dispatch, with a declared role as positive control', async () => {
    ctx = new Context()
    const fake = fakeSubagents(childIdFromLabel, { spawn: { capabilities: { persona: true } } })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const start = await seamStart(ctx)

    // `inherit` is the reserved "no specific role" id: the seam resolves nothing,
    // so no record is keyed (never invent a role) and there is nothing to announce.
    await start('spawn', { prompt: [{ type: 'text', text: assignment('inherit') }], label: 'child-inherit' })
    await start('spawn', { prompt: [{ type: 'text', text: assignment('nobody') }], label: 'child-undeclared' })
    expect(seam.records.has('child-inherit')).toBe(false)
    expect(seam.records.has('child-undeclared')).toBe(false)

    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-inherit'), [claimed], 1))).toEqual([claimed])
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-undeclared'), [claimed], 1))).toEqual([claimed])
    expect(seam.noticeEmitted.size).toBe(0)

    // Positive control: a DECLARED role dispatched through the same seam is keyed
    // and announced — so the two negatives above mean "no record", not "no emission".
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-declared' })
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-declared'), [claimed], 1))).toHaveLength(2)
  })

  it('honours the per-agent emitted marker even when the record still reads pending', async () => {
    ctx = new Context()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const claimed = claimedMessage()
    const agent = childAgent('child-marker')
    const record: SubagentSeamRecord = { role: 'coder', at: 1, firstNoticePending: true }
    seam.records.set('child-marker', record)

    // Seeded `emitted` (the in-memory half of the guarantee): the pending record
    // alone would emit, so this case fails if the marker check is dropped.
    seam.noticeEmitted.add('child-marker')
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))).toEqual([claimed])
    expect(record.firstNoticePending).toBe(true)

    // Positive control: clearing ONLY the marker releases the row from the same
    // still-pending record, so the assertion above is the marker's doing.
    seam.noticeEmitted.delete('child-marker')
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))).toHaveLength(2)
    expect(record.firstNoticePending).toBe(false)
  })

  it('honours the record marker: a cleared record is never announced again', async () => {
    ctx = new Context()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const claimed = claimedMessage()
    const agent = childAgent('child-cleared')
    seam.records.set('child-cleared', { role: 'coder', at: 1, firstNoticePending: false })

    // The record marker is the DURABLE half of the guarantee (Task 1 preserves it
    // across a rewrite — see the resume case below), so a cleared record stays
    // silent even with the in-memory marker empty. Fails if the
    // `firstNoticePending` read is dropped and `emitted` alone carries the
    // decision.
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))).toEqual([claimed])
    expect(seam.noticeEmitted.size).toBe(0)

    // Positive control: the same id with the marker pending DOES announce.
    seam.records.set('child-cleared', { role: 'coder', at: 1, firstNoticePending: true })
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))).toHaveLength(2)
  })

  it('leaves a reject decision untouched, with an enter decision as positive control', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug })
    const claimed = claimedMessage()
    const agent = childAgent('child-reject')
    seam.records.set('child-reject', { role: 'coder', at: 1, firstNoticePending: true })

    const rejected = await drivePreStep(ctx, agent, [claimed], 1, () => Promise.resolve({ kind: 'reject' as const }))
    expect(rejected.kind).toBe('reject')
    expect(seam.noticeEmitted.size).toBe(0)
    expect(seam.records.get('child-reject')!.firstNoticePending).toBe(true)
    // A reject carries NO `messages` field, so skipping it must be the listener's
    // own decision rather than a contained throw: no debug line, and the marker
    // is untouched.
    expect(debug).not.toHaveBeenCalled()

    // Positive control: the same record through an enter decision DOES announce.
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))).toHaveLength(2)
  })

  it('never turns an empty step into a model call, with a claimed batch as positive control', async () => {
    ctx = new Context()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const agent = childAgent('child-empty')
    seam.records.set('child-empty', { role: 'coder', at: 1, firstNoticePending: true })

    // An empty `enter` is the loop's own "spend no model call" outcome: appending
    // a notice would be the ONLY admitted message and would buy a request.
    const empty = admittedMessages(await drivePreStep(ctx, agent, [], 1))
    expect(empty).toEqual([])
    expect(seam.noticeEmitted.size).toBe(0)
    expect(seam.records.get('child-empty')!.firstNoticePending).toBe(true)

    // Positive control: a claimed batch on the same record gets the row.
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimedMessage()], 2))).toHaveLength(2)
  })

  it('degrades with ONE contained debug when the producer throws, and keeps the child announceable', async () => {
    ctx = new Context()
    const debug = vi.fn()
    const published = buildRoleNotice('coder', false)
    let calls = 0
    const buildNotice: RoleNoticeBuilder = () => {
      if (calls++ === 0) throw new Error('producer boom')
      return published
    }
    const records = new Map<string, SubagentSeamRecord>([
      ['child-throws', { role: 'coder', at: 1, firstNoticePending: true }],
    ])
    const emitted = new Set<string>()
    installRoleNotice(ctx, { records, emitted, buildNotice, debug })

    const claimed = claimedMessage()
    const agent = childAgent('child-throws')
    const survived = admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))
    // The step is untouched (same claimed batch, no partial row) …
    expect(survived).toEqual([claimed])
    // … the once-per-child marker was NOT consumed by the throw …
    expect(emitted.size).toBe(0)
    expect(records.get('child-throws')!.firstNoticePending).toBe(true)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('contained')
    expect(String(debug.mock.calls[0]![0])).toContain('producer boom')

    // … so the child is still announced on its next step (a marker written before
    // the build would lose the row permanently).
    const recovered = admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))
    expect(recovered).toHaveLength(2)
    expect(recovered[1]).toBe(published)
  })

  it('never re-announces a child whose record is rewritten by a resume', async () => {
    ctx = new Context()
    const fake = fakeSubagents(childIdFromLabel, { spawn: { capabilities: { persona: true } } })
    fake.service.startContinuable = (spec: { childId?: string }) => Promise.resolve({ childId: spec.childId })
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    const start = await seamStart(ctx)
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-resume' })

    const agent = childAgent('child-resume')
    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))).toHaveLength(2)
    expect(seam.records.get('child-resume')!.firstNoticePending).toBe(false)

    // A resume re-records the SAME child (the request carries no Assignment
    // header, so the seam's record fallback keys it again from `childId`). The
    // write must PRESERVE the cleared marker — that is what makes the
    // once-per-child guarantee outlive a re-dispatch instead of depending on
    // the child never being written twice.
    await (await seamContinuable(ctx))({ provider: 'spawn', childId: 'child-resume', request: { prompt: [] } })
    expect(seam.records.get('child-resume')).toMatchObject({ role: 'coder', firstNoticePending: false })

    const afterResume = admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))
    expect(afterResume).toEqual([claimed])
  })

  it('runs outermost, so its row is the LAST admitted message (prepend shape)', async () => {
    ctx = new Context()
    const sibling = createUserMessage({
      content: [{ type: 'text', text: '[sibling pre-step listener]' }],
      source: { kind: 'user' },
    })
    // Registered BEFORE the seam. Only a `prepend: true` registration puts the
    // notice OUTSIDE this listener (the loop's final decision), so the order
    // below pins the documented waterfall position rather than an incidental
    // insertion order.
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...decision.messages, sibling] }
    })
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES })
    seam.records.set('child-order', { role: 'coder', at: 1, firstNoticePending: true })

    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-order'), [claimedMessage()], 1))
    expect(decision).toHaveLength(3)
    expect(decision[1]).toBe(sibling)
    expect(textOf(decision[2]!)).toBe('[role: coder]')
  })

  it('appends (persona not applied) only when a DECLARED persona was skipped', async () => {
    ctx = new Context()
    const fake = fakeSubagents(childIdFromLabel, {
      capable: { capabilities: { persona: true } },
      nocap: { capabilities: { persona: false } },
    })
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, roles: () => ROLES, debug: vi.fn() })
    const start = await seamStart(ctx)
    const claimed = claimedMessage()

    // (1) Declared persona, capability present → delivered → no suffix.
    await start('capable', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-delivered' })
    const delivered = admittedMessages(await drivePreStep(ctx, childAgent('child-delivered'), [claimed], 1))
    expect(textOf(delivered[1]!)).toBe('[role: coder]')

    // (2) Declared persona, capability absent → the merge skipped it → suffix.
    await start('nocap', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-skipped' })
    const skipped = admittedMessages(await drivePreStep(ctx, childAgent('child-skipped'), [claimed], 1))
    expect(textOf(skipped[1]!)).toBe('[role: coder] (persona not applied)')

    // (3) Positive control for "only when the role DECLARES one": the SAME
    // capability-less provider, a role whose persona is blank after trim.
    await start('nocap', { prompt: [{ type: 'text', text: assignment('reviewer') }], label: 'child-nopersona' })
    const bare = admittedMessages(await drivePreStep(ctx, childAgent('child-nopersona'), [claimed], 1))
    expect(textOf(bare[1]!)).toBe('[role: reviewer]')

    // (4) Explicit caller intent wins the slot: the persona IS applied, just not
    // by this plugin's merge, so the row must not claim it was skipped.
    await start('nocap', {
      prompt: [{ type: 'text', text: assignment('scout') }],
      persona: 'Caller persona',
      label: 'child-caller',
    })
    const caller = admittedMessages(await drivePreStep(ctx, childAgent('child-caller'), [claimed], 1))
    expect(textOf(caller[1]!)).toBe('[role: scout]')
  })
})

describe('role notice — per-apply lifetime through apply()', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('emits the row through the real apply() composition', async () => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
    const fake = fakeSubagents(childIdFromLabel, { spawn: { capabilities: { persona: true } } })
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } }))

    const start = await seamStart(ctx)
    await start('spawn', { prompt: [{ type: 'text', text: assignment('coder') }], label: 'child-apply' })

    const claimed = claimedMessage()
    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-apply'), [claimed], 1))
    // Dropping the `installRoleNotice(...)` registration from the seam install
    // (or the seam's `roles` wiring) fails here.
    expect(decision).toHaveLength(2)
    expect(textOf(decision[1]!)).toBe('[role: coder]')
  })

  it('clears the emitted marker on agent/disposed and on plugin dispose', async () => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: '', chain: [] }], rules: [] } }))
    const seam = subagentSeamOf(ctx)
    expect(seam).toBeDefined()
    const { agent } = makeAgent('child-cleaned', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })

    // `agent/disposed` mirrors every other per-agent map (`Agent.id` IS the session id).
    seam!.noticeEmitted.add('child-cleaned')
    ctx.emit('agent/disposed', { agent })
    expect(seam!.noticeEmitted.has('child-cleaned')).toBe(false)

    seam!.noticeEmitted.add('child-cleaned')
    await ctx.fiber.dispose()
    expect(seam!.noticeEmitted.size).toBe(0)
  })
})

/**
 * The frozen released V2→V3 source-kind set — CHECKED-IN MIRROR.
 *
 * Provenance: `@deepseek-ai/dsh-session-format-v2-to-v3@0.1.5-rc.1`
 * `lib/index.js:14-30` (`const SOURCE_KINDS = new Set([...])`; checkout
 * `packages/session/session-format-v2-to-v3/src/payload.ts:10`), the boundary
 * that throws `cannot safely transform unclassified message source` (`:125`) for
 * anything outside it. The package does NOT export the set, so the guard below
 * derives it from the installed lib's source when that lib resolves in this
 * tree and falls back to this mirror otherwise — and cross-checks the two when
 * both are available, so neither can drift silently.
 */
const MIRROR_RELEASED_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'user',
  'plugin',
  'model',
  'tool',
  'agent-instructions',
  'session-reference',
  'team-message',
  'goal',
  'skill-invocation',
  'skill-catalog',
  'coordinator',
  'subagent-report',
  'subagent-settled',
  'webhook',
  'agent-message',
])

/** The package whose V2→V3 edge hard-codes the load-safe source-kind set. */
const FROZEN_EDGE_PACKAGE = '@deepseek-ai/dsh-session-format-v2-to-v3'

/**
 * Derive the frozen set from the INSTALLED frozen edge, or `undefined` when the
 * package is absent from this tree (the expected case in registry mode: the
 * plugin's peers are only the packages it imports) or its bundle shape changed.
 * Anchored on `process.cwd()` — the worktree vitest runs in — exactly like
 * `vitest.config.ts` (a bundled `import.meta.url` can point into a dependency
 * tree's temp dir).
 */
function deriveReleasedSourceKinds(): ReadonlySet<string> | undefined {
  try {
    const require = createRequire(resolve(process.cwd(), 'package.json'))
    const entry = require.resolve(FROZEN_EDGE_PACKAGE)
    const match = /SOURCE_KINDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(readFileSync(entry, 'utf8'))
    if (match === null || match[1] === undefined) return undefined
    const kinds = [...match[1].matchAll(/["']([^"']+)["']/g)].map((quoted) => quoted[1]!)
    return kinds.length === 0 ? undefined : new Set(kinds)
  } catch {
    return undefined
  }
}

describe('role notice — frozen released source-kind contract guard', () => {
  it('emits a source kind the frozen released V2→V3 edge classifies', () => {
    const derived = deriveReleasedSourceKinds()
    const kinds = derived ?? MIRROR_RELEASED_SOURCE_KINDS
    // The set must never be empty and must never be "everything": both would
    // make the membership assertion below vacuous.
    expect(kinds.size).toBe(MIRROR_RELEASED_SOURCE_KINDS.size)
    if (derived !== undefined) expect([...derived].sort()).toEqual([...MIRROR_RELEASED_SOURCE_KINDS].sort())

    // The emitted source kind — read off the REAL message the emitter produces,
    // not off the constant — is a member of the frozen set. `plugin` is the
    // sanctioned kind for a plugin-authored `notice` (dsh's own `model-selection`
    // and `plan-mode` producers use it).
    const notice = buildRoleNotice('coder', false)
    expect(kinds.has(notice.source.kind)).toBe(true)
    expect(notice.source.kind).toBe(ROLE_NOTICE_SOURCE_KIND)

    // Positive control for the membership: a BESPOKE kind — the failure class
    // this guard exists for — is NOT a member, so "member" above is the frozen
    // set's verdict and not a predicate that accepts any string.
    expect(kinds.has('llm-fallbacks-role')).toBe(false)
    expect(kinds.has('')).toBe(false)
  })
})
