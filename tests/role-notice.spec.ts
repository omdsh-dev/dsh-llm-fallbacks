/**
 * In-session role notice row (plan role-based-subagent-adoption Task 3; rc.1
 * `startActivation` migration, plan dsh-021-subagent-seam-repair Task 3).
 *
 * Coverage is behavioural and public-path, mirroring `subagents-seam.spec.ts`:
 * a `subagents` service is provided, the seam is installed exactly as `apply()`
 * installs it, a consumer CALLS `ctx.subagents.startActivation(...)`, and the
 * child's own `agent/pre-step` waterfall is driven the way the loop drives it
 * (`agent-loop/src/agent.ts:241-257`). Records are created by the production
 * path — never seeded — except where a case must isolate one marker, and every
 * such case carries an in-test positive control (the Task 1 I-1 / M-1 lesson:
 * a negative that also holds with the behaviour broken proves nothing).
 *
 * The ` (persona not applied)` verdict belongs to the `agent/created` listener
 * (plan dsh-021-subagent-seam-repair Task 1): the seam itself never touches a
 * persona. A case that needs the verdict therefore installs `installRolePersona`
 * over the SAME record map the seam writes (the `apply()` composition) and
 * dispatches that child's `agent/created` — the same production path, with the
 * capability-gate cases this suite used to carry gone with that gate.
 *
 * The last describe block is the contract guard: the emitted source kind must
 * survive the released session-format edges (the V3→V4 migration retains the
 * direct kind verbatim and native V4 restore admits it).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
// VALUE import, deliberately not a vitest stub: the contract guard below must
// run against the REAL released session-format codecs (the V3→V4 edge), so it
// rides the transitively installed @deepseek-ai/dsh-session-format-catalog
// (0.1.7-rc.1). It stays out of peerDependencies on purpose — the plugin
// itself never imports it, and tests/peer-deps.test.ts enforces the
// peers-only contract for @deepseek-ai/*.
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog'
import { apply } from '../src/index.ts'
import { installSubagentSeam, subagentSeamOf, type SubagentActivationSpecView, type SubagentSeamRecord } from '../src/subagents-seam.ts'
import { installRolePersona } from '../src/role-persona.ts'
import { buildRoleNotice, installRoleNotice, markNoticeEmitted, NOTICE_EMITTED_LIMIT, ROLE_NOTICE_PLUGIN, ROLE_NOTICE_SOURCE_KIND, type RoleNoticeBuilder } from '../src/role-notice.ts'
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

/** The registry's exact scoped duplicate message for the persona section (the descriptor-delivered skip). */
const DUPLICATE_MESSAGE = `prompt section "${PERSONA_PREFIX_SECTION}" is already registered in this scope`

interface FakeSubagents {
  service: Record<string, unknown>
  /** The activation specs the native path received, in call order. */
  activations: SubagentActivationSpecView[]
}

/**
 * Fake rc.1 `subagents` runtime, the shape `subagents-seam.spec.ts` migrated to:
 * it records every activation spec it receives and resolves like the real
 * runtime — a CALLER-reserved `childId` IS the child's id (`manager.startLocal`),
 * while an external backend allocates its own, which this fake takes from the
 * activation LABEL so a case reads its child back off its own dispatch.
 * `providers` is what `getProvider(name)` answers: a `prepareContinuable`-carrying
 * entry for a local backend, nothing for an external one (the seam's only
 * remaining use of the lookup — the persona capability gate is gone).
 */
function fakeSubagents(providers: Record<string, Record<string, unknown>> = {}): FakeSubagents {
  const activations: SubagentActivationSpecView[] = []
  const service: Record<string, unknown> = {
    tag: 'raw-subagents',
    getProvider: (name: string) => providers[name],
    startActivation: (spec: SubagentActivationSpecView) => {
      activations.push(spec)
      return Promise.resolve({ childId: spec.childId ?? spec.label })
    },
  }
  return { service, activations }
}

/** One caller activation (`ctx.subagents.startActivation`): the label is the child id here. */
function activationSpec(label: string, prompt: string): Record<string, unknown> {
  return { provider: 'spawn', label, request: { prompt: [{ type: 'text', text: prompt }] } }
}

/** Wait one macrotask so a cordis plugin child's `apply` has run. */
function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

/**
 * Read `ctx.subagents` the way the host does — from a CONSUMER fiber that
 * injects the service (a same-fiber read is short-circuited by cordis and would
 * bypass the wrapper).
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

/** Call `startActivation` on an injected wrapper value without a cast at each site. */
function startActivationOf(value: Record<string, unknown>): (spec: unknown) => Promise<unknown> {
  return value.startActivation as (spec: unknown) => Promise<unknown>
}

/** The wrapper's `startActivation` (the dispatch AND resume path the record is keyed from). */
async function seamActivation(ctx: Context): Promise<(spec: Record<string, unknown>) => Promise<unknown>> {
  return startActivationOf(await seamConsumer(ctx, 'role-notice-consumer-activation'))
}

/**
 * One child agent whose own scope provides an isolated `systemPrompt` double.
 * `sectionError` reproduces the registry's throw sites: the same-name scoped
 * duplicate (the descriptor channel already registered the persona on this
 * child's scope) or any other registration failure.
 */
function childWithPrompt(parent: Context, id: string, sectionError?: Error): Agent {
  const scope = parent.isolate('systemPrompt')
  scope.provide('systemPrompt', {
    getSectionOrder: () => 0,
    section: () => {
      if (sectionError !== undefined) throw sectionError
      return () => {}
    },
  })
  return { id, ctx: scope } as unknown as Agent
}

/** Dispatch one `agent/created` the way the agent runtime does, then let the injected fiber apply. */
async function created(parent: Context, agent: Agent): Promise<void> {
  await parent.serial('agent/created', { agent, source: 'startup' })
  await nextTick()
}

/**
 * Drive one `agent/pre-step` waterfall exactly like the loop's `preStep`
 * (`agent-loop/src/agent.ts:241-257`): the default callback returns the claimed
 * messages (the real default additionally appends the assembled
 * system-prompt section, which no notice decision reads).
 *
 * The payload carries the DECLARED shape (`runtime-types.d.ts:313-319`:
 * `{ agent, messages, turn, step, signal }`) — `messages` included, because the
 * real loop passes the claimed batch (`dsh-agent-loop/lib/index.js:894-897`) and
 * a sibling first-party listener on this event DOES read it
 * (`dsh-agent/lib/index.js:163`). Leaving it out would exercise any future
 * `messages` read here against `undefined`.
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
    { agent, messages: [...messages], turn: 1, step, signal: new AbortController().signal },
    next ?? (() => Promise.resolve({ kind: 'enter' as const, messages: [...messages] })),
  )
}

/** A subagent-origin agent stand-in whose `id` matches the dispatched child session id. */
function childAgent(id: string): Agent {
  return makeAgent(id, { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' }).agent
}

describe('buildRoleNotice — the sanctioned session-write shape (pure)', () => {
  it('writes [role: <id>] with the producer-declared notice source', () => {
    const notice = buildRoleNotice('coder', false)
    expect(notice.role).toBe('user')
    expect(notice.content).toEqual([{ type: 'text', text: '[role: coder]' }])
    expect(notice.source.kind).toBe('llm-fallbacks-role-notice')
    expect(notice.source.kind).toBe(ROLE_NOTICE_SOURCE_KIND)
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
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const start = await seamActivation(ctx)
    await start(activationSpec('child-one', assignment('coder')))

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

  it('keeps the once-per-child markers per agent: two children each get their own row (case i)', async () => {
    ctx = new Context()
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const start = await seamActivation(ctx)
    await start(activationSpec('child-a', assignment('coder')))
    await start(activationSpec('child-b', assignment('scout')))

    const claimed = claimedMessage()
    const firstA = admittedMessages(await drivePreStep(ctx, childAgent('child-a'), [claimed], 1))
    const firstB = admittedMessages(await drivePreStep(ctx, childAgent('child-b'), [claimed], 1))
    // Both children are announced: the markers are keyed per agent, so one
    // child's row can never consume another's (a single global "already
    // announced" flag would fail here).
    expect(firstA).toHaveLength(2)
    expect(textOf(firstA[1]!)).toBe('[role: coder]')
    expect(firstB).toHaveLength(2)
    expect(textOf(firstB[1]!)).toBe('[role: scout]')
    expect(seam.noticeEmitted.size).toBe(2)

    // …and neither is announced a second time on a later step.
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-a'), [claimed], 2))).toEqual([claimed])
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-b'), [claimed], 2))).toEqual([claimed])
  })

  it('emits nothing for a root agent, with the same record as positive control', async () => {
    ctx = new Context()
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const start = await seamActivation(ctx)
    await start(activationSpec('child-root', assignment('coder')))

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
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const start = await seamActivation(ctx)
    await start(activationSpec('child-known', assignment('coder')))

    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-unrecorded'), [claimed], 1))).toEqual([claimed])

    // Positive control: a child this seam DID record gets its row in the same setup.
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-known'), [claimed], 1))).toHaveLength(2)
  })

  it('never announces an inherit/unresolved dispatch, with a declared role as positive control', async () => {
    ctx = new Context()
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const start = await seamActivation(ctx)

    // `inherit` is the reserved "no specific role" id: the seam resolves nothing,
    // so no record is keyed (never invent a role) and there is nothing to announce.
    await start(activationSpec('child-inherit', assignment('inherit')))
    await start(activationSpec('child-undeclared', assignment('nobody')))
    expect(seam.records.has('child-inherit')).toBe(false)
    expect(seam.records.has('child-undeclared')).toBe(false)

    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-inherit'), [claimed], 1))).toEqual([claimed])
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-undeclared'), [claimed], 1))).toEqual([claimed])
    expect(seam.noticeEmitted.size).toBe(0)

    // Positive control: a DECLARED role dispatched through the same seam is keyed
    // and announced — so the two negatives above mean "no record", not "no emission".
    await start(activationSpec('child-declared', assignment('coder')))
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-declared'), [claimed], 1))).toHaveLength(2)
  })

  it('honours the per-agent emitted marker even when the record still reads pending', async () => {
    ctx = new Context()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
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
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
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
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug })
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
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
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
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const start = await seamActivation(ctx)
    await start(activationSpec('child-resume', assignment('coder')))

    const agent = childAgent('child-resume')
    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))).toHaveLength(2)
    expect(seam.records.get('child-resume')!.firstNoticePending).toBe(false)

    // A resume re-records the SAME child (the request carries no Assignment
    // header, so the seam's record fallback keys it again from `childId`). The
    // write must PRESERVE the cleared marker — that is what makes the
    // once-per-child guarantee outlive a re-dispatch instead of depending on
    // the child never being written twice.
    await start({ provider: 'spawn', childId: 'child-resume', request: { prompt: [] } })
    expect(seam.records.get('child-resume')).toMatchObject({ role: 'coder', firstNoticePending: false })

    const afterResume = admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))
    expect(afterResume).toEqual([claimed])
  })

  it('announces on the next non-empty step when the record lands after an earlier step (CF-7)', async () => {
    ctx = new Context()
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    const agent = childAgent('child-late')
    const claimed = claimedMessage()

    // Step 1 runs BEFORE any record exists: the dispatch seam writes the record
    // when the wrapped start resolves, so a fast child can reach a step first.
    // Nothing is announced and — the point of this case — nothing is CONSUMED:
    // the emitter is not a one-shot first-step hook, so the row is not lost, it
    // lands on the child's next non-empty step.
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 1))).toEqual([claimed])
    expect(seam.noticeEmitted.size).toBe(0)

    // The record lands (the same shape the production write produces).
    seam.records.set('child-late', { role: 'coder', at: Date.now(), firstNoticePending: true })
    const second = admittedMessages(await drivePreStep(ctx, agent, [claimed], 2))
    expect(second).toHaveLength(2)
    expect(textOf(second[1]!)).toBe('[role: coder]')

    // …and exactly once: the late announcement consumed the markers.
    expect(admittedMessages(await drivePreStep(ctx, agent, [claimed], 3))).toEqual([claimed])
  })

  it('announces ONE row with two applied fibers, and the survivor announces after the owner disposes (CF-5)', async () => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const config = () => cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } })

    // TWO APPLIED FIBERS over one root: each one registers its own notice
    // emitter, over the ROOT-shared record map and marker.
    let firstCtx: Context | undefined
    let secondCtx: Context | undefined
    const firstFiber = ctx.plugin({
      name: 'notice-multi-first',
      apply: (fiberCtx: Context) => {
        firstCtx = fiberCtx
        apply(fiberCtx, config())
      },
    })
    await nextTick()
    const secondFiber = ctx.plugin({
      name: 'notice-multi-second',
      apply: (fiberCtx: Context) => {
        secondCtx = fiberCtx
        apply(fiberCtx, config())
      },
    })
    await nextTick()

    const first = subagentSeamOf(firstCtx!)
    const second = subagentSeamOf(secondCtx!)
    expect(first!.records).toBe(second!.records)
    expect(first!.noticeEmitted).toBe(second!.noticeEmitted)

    const start = await seamActivation(ctx)
    await start(activationSpec('child-two-fibers', assignment('coder')))

    // Two emitters over ONE shared marker ⇒ exactly one row (a per-fiber marker
    // would append the notice twice).
    const claimed = claimedMessage()
    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-two-fibers'), [claimed], 1))
    expect(decision).toHaveLength(2)
    expect(textOf(decision[1]!)).toBe('[role: coder]')
    expect(second!.noticeEmitted.size).toBe(1)

    // The wrapper OWNER disposes while the other fiber stays applied. The
    // survivor's own emitter must still announce — that registration is what the
    // old all-inclusive dedupe dropped, leaving the role surface dead on a
    // still-applied fiber.
    await firstFiber.dispose()
    second!.records.set('child-survivor', { role: 'scout', at: Date.now(), firstNoticePending: true })
    const survivor = admittedMessages(await drivePreStep(ctx, childAgent('child-survivor'), [claimed], 1))
    expect(survivor).toHaveLength(2)
    expect(textOf(survivor[1]!)).toBe('[role: scout]')

    await secondFiber.dispose()
  })

  it('runs outermost, so its row is the LAST admitted message (prepend shape)', async () => {
    ctx = new Context()
    const sibling = createUserMessage({
      content: [{ type: 'text', text: '[sibling pre-step listener]' }],
      source: { kind: 'user' },
    })
    let siblingPayload: { messages?: UserMessage[] } | undefined
    // Registered BEFORE the seam. Only a `prepend: true` registration puts the
    // notice OUTSIDE this listener (the loop's final decision), so the order
    // below pins the documented waterfall position rather than an incidental
    // insertion order.
    ctx.on('agent/pre-step', async (payload, next) => {
      siblingPayload = payload as { messages?: UserMessage[] }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...decision.messages, sibling] }
    })
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    seam.records.set('child-order', { role: 'coder', at: 1, firstNoticePending: true })

    const claimed = claimedMessage()
    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-order'), [claimed], 1))
    expect(decision).toHaveLength(3)
    expect(decision[1]).toBe(sibling)
    expect(textOf(decision[2]!)).toBe('[role: coder]')
    // The waterfall payload carries the loop's DECLARED `messages` batch
    // (`runtime-types.d.ts:313-319`; the real loop passes the claimed batch), so
    // a future listener that reads it is exercised against real data here rather
    // than against `undefined` (Task 3 review Minor 2).
    expect(siblingPayload?.messages).toEqual([claimed])
  })

  it('appends (persona not applied) only when a DECLARED persona was skipped', async () => {
    ctx = new Context()
    // The verdict path is the production one: the seam records the child, and the
    // `agent/created` persona listener (the same composition `apply()` wires)
    // delivers the role persona onto the child's OWN scope, writing
    // `personaNotApplied` back into the SHARED record the notice row reads.
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
    installRolePersona(ctx, { records: seam.records, roles: () => ROLES })
    const start = await seamActivation(ctx)
    const claimed = claimedMessage()

    // (1) Declared persona, the section lands on the child → delivered → no suffix.
    await start(activationSpec('child-delivered', assignment('coder')))
    await created(ctx, childWithPrompt(ctx, 'child-delivered'))
    expect(seam.records.get('child-delivered')?.personaNotApplied).toBeUndefined()
    const delivered = admittedMessages(await drivePreStep(ctx, childAgent('child-delivered'), [claimed], 1))
    expect(textOf(delivered[1]!)).toBe('[role: coder]')

    // (2) Declared persona, the registration genuinely failed → the verdict → suffix.
    await start(activationSpec('child-skipped', assignment('coder')))
    await created(ctx, childWithPrompt(ctx, 'child-skipped', new Error('the prompt registry refused the section')))
    expect(seam.records.get('child-skipped')?.personaNotApplied).toBe(true)
    const skipped = admittedMessages(await drivePreStep(ctx, childAgent('child-skipped'), [claimed], 1))
    expect(textOf(skipped[1]!)).toBe('[role: coder] (persona not applied)')

    // (3) Positive control for "only when the role DECLARES one": the SAME
    // failing registration, a role whose persona is blank after trim — nothing
    // was skipped, so no section was attempted and there is no verdict.
    await start(activationSpec('child-nopersona', assignment('reviewer')))
    await created(ctx, childWithPrompt(ctx, 'child-nopersona', new Error('the prompt registry refused the section')))
    expect(seam.records.get('child-nopersona')?.personaNotApplied).toBeUndefined()
    const bare = admittedMessages(await drivePreStep(ctx, childAgent('child-nopersona'), [claimed], 1))
    expect(textOf(bare[1]!)).toBe('[role: reviewer]')

    // (4) The other silent arm: the registry's exact same-name scoped duplicate
    // is the descriptor channel having delivered the persona already — delivered,
    // just not by this plugin, so the row must not claim a skip.
    await start(activationSpec('child-descriptor', assignment('scout')))
    await created(ctx, childWithPrompt(ctx, 'child-descriptor', new Error(DUPLICATE_MESSAGE)))
    expect(seam.records.get('child-descriptor')?.personaNotApplied).toBeUndefined()
    const descriptor = admittedMessages(await drivePreStep(ctx, childAgent('child-descriptor'), [claimed], 1))
    expect(textOf(descriptor[1]!)).toBe('[role: scout]')
  })

  it('keeps a declared-persona skip reported when a later resume recomputes it (case h + sticky verdict)', async () => {
    ctx = new Context()
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    const seam = installSubagentSeam(ctx, { roleIds: () => ROLE_IDS, debug: vi.fn() })
    installRolePersona(ctx, { records: seam.records, roles: () => ROLES })
    const start = await seamActivation(ctx)

    // Dispatch: the role declares a persona, the section registration failed.
    await start(activationSpec('child-sticky', assignment('coder')))
    await created(ctx, childWithPrompt(ctx, 'child-sticky', new Error('the prompt registry refused the section')))
    expect(seam.records.get('child-sticky')?.personaNotApplied).toBe(true)

    // A resume BEFORE the child's first non-empty pre-step re-keys the record
    // from the fallback (its request carries no Assignment header) and carries no
    // verdict of its own — the role's DECLARED persona is still undelivered on
    // the dispatch the notice reports, so the rewrite must not un-report it.
    const request = { prompt: [] }
    await start({ provider: 'spawn', childId: 'child-sticky', request })
    expect(seam.records.get('child-sticky')).toMatchObject({ role: 'coder', personaNotApplied: true })

    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-sticky'), [claimedMessage()], 1))
    expect(textOf(decision[1]!)).toBe('[role: coder] (persona not applied)')
    // Positive control: the resume really ran, and the caller's OWN request object
    // reached the native path untouched — so the verdict above is the sticky
    // record, not a resume that never happened.
    expect(fake.activations[1]!.request).toBe(request)
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
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } }))

    const start = await seamActivation(ctx)
    await start(activationSpec('child-apply', assignment('coder')))

    const claimed = claimedMessage()
    const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-apply'), [claimed], 1))
    // Dropping the `installRoleNotice(...)` registration from the seam install
    // fails here.
    expect(decision).toHaveLength(2)
    expect(textOf(decision[1]!)).toBe('[role: coder]')
  })

  it('keeps the emitted marker across agent/disposed; clears it only on plugin dispose (CF-6)', async () => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: '', chain: [] }], rules: [] } }))
    const seam = subagentSeamOf(ctx)
    expect(seam).toBeDefined()
    const { agent } = makeAgent('child-cleaned', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })

    // SESSION-stable: `Agent.id` IS the child session id and a continuable
    // child's durable session OUTLIVES the activation, so a disposal must NOT
    // drop the marker — dropping it was what let a re-activation resume append a
    // SECOND `[role: x]` row to the same session log.
    seam!.noticeEmitted.add('child-cleaned')
    ctx.emit('agent/disposed', { agent })
    expect(seam!.noticeEmitted.has('child-cleaned')).toBe(true)

    // The plugin's own dispose is the one place the whole marker map is cleared
    // (no residual state).
    await ctx.fiber.dispose()
    expect(seam!.noticeEmitted.size).toBe(0)
  })

  it('never announces a re-activated child session twice (CF-6, session-stable marker)', async () => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
    const fake = fakeSubagents()
    ctx.provide('subagents', fake.service)
    apply(ctx, cfg({ roles: { list: [{ id: 'coder', persona: 'Coder persona', chain: [] }], rules: [] } }))
    const start = await seamActivation(ctx)

    // First activation: the child is dispatched and announced exactly once.
    await start(activationSpec('child-reactivated', assignment('coder')))
    const claimed = claimedMessage()
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-reactivated'), [claimed], 1))).toHaveLength(2)

    // The activation ends. Per-agent cleanup drops the RECORD (exactly as the
    // other per-agent maps do) while the session-stable marker survives.
    const { agent } = makeAgent('child-reactivated', { provider: 'mock', model: 'gpt-4o' }, { origin: 'subagent' })
    ctx.emit('agent/disposed', { agent })
    expect(subagentSeamOf(ctx)!.records.has('child-reactivated')).toBe(false)
    expect(subagentSeamOf(ctx)!.noticeEmitted.has('child-reactivated')).toBe(true)

    // Re-activation re-dispatches the SAME child session id with a declared role:
    // the record is written fresh (`firstNoticePending: true`), which is exactly
    // the state that used to produce a second durable row.
    await start(activationSpec('child-reactivated', assignment('coder')))
    expect(subagentSeamOf(ctx)!.records.get('child-reactivated')!.firstNoticePending).toBe(true)
    expect(admittedMessages(await drivePreStep(ctx, childAgent('child-reactivated'), [claimed], 1))).toEqual([claimed])
    // Positive control lives in the first activation above: the same emitter, on
    // the same seam, DID append the row before the marker was set.
  })
})

describe('role notice — the bounded, session-stable marker (CF-6)', () => {
  it('evicts the oldest session once the bound is reached, keeping the newest', () => {
    const emitted = new Set<string>()
    for (let index = 0; index <= NOTICE_EMITTED_LIMIT; index += 1) markNoticeEmitted(emitted, `child-${index}`)
    expect(emitted.size).toBe(NOTICE_EMITTED_LIMIT)
    expect(emitted.has('child-0')).toBe(false)
    expect(emitted.has(`child-${NOTICE_EMITTED_LIMIT}`)).toBe(true)
  })

  it('bounds the marker the EMITTER writes, so the set cannot grow without limit', async () => {
    const emitted = new Set<string>()
    for (let index = 0; index < NOTICE_EMITTED_LIMIT; index += 1) emitted.add(`child-${index}`)
    const records = new Map<string, SubagentSeamRecord>([
      ['child-overflow', { role: 'coder', at: 1, firstNoticePending: true }],
    ])
    const noticeCtx = new Context()
    try {
      installRoleNotice(noticeCtx, { records, emitted })
      const decision = admittedMessages(await drivePreStep(noticeCtx, childAgent('child-overflow'), [claimedMessage()], 1))
      // The row landed AND the marker stayed bounded: the emitter routes through
      // the bounded helper, so "session-stable" cannot become unbounded growth.
      expect(decision).toHaveLength(2)
      expect(textOf(decision[1]!)).toBe('[role: coder]')
      expect(emitted.size).toBe(NOTICE_EMITTED_LIMIT)
      expect(emitted.has('child-0')).toBe(false)
      expect(emitted.has('child-overflow')).toBe(true)
    } finally {
      await noticeCtx.fiber.dispose()
    }
  })
})

/**
 * The RELEASED session-format edge verdict for the notice source — driven
 * through the INSTALLED `@deepseek-ai/dsh-session-format-catalog` restore
 * (the same physical-row path a real log open takes), not a checked-in text
 * mirror: 0.1.7-rc.1 removed the frozen V2→V3 kind set ("each producer
 * declares its own `kind` in its own module" — dsh-llm message.d.ts), so the
 * contract under guard is that the DIRECT kind survives the V3→V4 migration
 * verbatim and is admitted by native V4 restore, and that the pre-0.1.7
 * `kind: 'plugin', plugin: …` rows migrate to the exact `plugin:<plugin>`
 * form the role projection also accepts.
 */
function restoreWithSource(source: unknown, version: 3 | 4): { source: unknown } {
  const header = { type: 'session', version, id: 'role-notice-guard', createdAt: 1, delegationDepth: 0, isSeeded: false }
  const row = {
    type: 'user/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      id: 'u0',
      role: 'user',
      source,
      content: [{ type: 'text', text: '[role: coder]' }],
    },
  }
  const reader = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
  reader.decodeRow(JSON.parse(JSON.stringify(row)))
  const artifact = reader.finish()
  const event = artifact.events[0] as { data?: { source?: unknown } } | undefined
  return { source: event?.data?.source }
}

describe('role notice — released session-format edge contract guard', () => {
  it('emits a source kind the released format edges retain verbatim', async () => {
    // Read the emitted kind off the row the PRODUCTION path actually admits (a
    // recorded child's first non-empty pre-step), not off a direct builder call:
    // the emitter must not publish a different message than the builder.
    const ctx = new Context()
    try {
      const fake = fakeSubagents()
      ctx.provide('subagents', fake.service)
      installSubagentSeam(ctx, { roleIds: () => ROLE_IDS })
      const start = await seamActivation(ctx)
      await start(activationSpec('child-guard', assignment('coder')))
      const decision = admittedMessages(await drivePreStep(ctx, childAgent('child-guard'), [claimedMessage()], 1))
      expect(decision).toHaveLength(2)

      const emitted = decision[1]!
      expect(emitted.source.kind).toBe(ROLE_NOTICE_SOURCE_KIND)
      // The pure builder agrees with the emitted row (the literal is exported so
      // this cannot be satisfied by two different constants).
      expect(buildRoleNotice('coder', false).source.kind).toBe(emitted.source.kind)

      // The REAL edge verdict: the emitted source rides a V3 log through the
      // V3→V4 migration (kind retained verbatim, form/summary untouched) and
      // native V4 restore admits the same source unchanged.
      const source = {
        kind: emitted.source.kind,
        form: 'notice',
        summary: (emitted.source as { summary?: string }).summary,
      }
      expect(restoreWithSource(source, 3).source).toEqual(source)
      expect(restoreWithSource(source, 4).source).toEqual(source)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('pre-0.1.7 plugin rows migrate to the exact legacy kind the projection accepts', () => {
    // The V3→V4 edge rewrites every unlisted V3 plugin source to
    // `plugin:<plugin>` — the durable form of THIS plugin's pre-upgrade rows
    // (`src/role-projection.ts` gates on it for badge continuity).
    const legacy = { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN, form: 'notice', summary: 'role: coder' }
    const migrated = restoreWithSource(legacy, 3).source as { kind?: string }
    expect(migrated.kind).toBe(`plugin:${ROLE_NOTICE_PLUGIN}`)
    expect(migrated.form).toBe('notice')
    expect(migrated.summary).toBe('role: coder')
    // Positive control: a foreign plugin's row keeps ITS plugin id — the
    // projection gate never reads another plugin's rows as ours.
    expect((restoreWithSource({ kind: 'plugin', plugin: 'someone-else' }, 3).source as { kind?: string }).kind)
      .toBe('plugin:someone-else')
  })

  it('an empty source kind is refused by the released edge (the admission is not any-string)', () => {
    // Native V4 admission refuses a non-producer-owned kind; the V3→V4
    // migration refuses a nonempty-kind source with its own message.
    expect(() => restoreWithSource({ kind: '' }, 4)).toThrow(/producer-owned source kind/)
    expect(() => restoreWithSource({ kind: '' }, 3)).toThrow(/nonempty kind/)
  })
})
