/**
 * Agent Team teammate role delivery through the EXISTING dispatch seam (plan
 * dsh-148-agent-team-role-delivery Task 2).
 *
 * The Agent Team carrier is dynamic (plan Decision, user 2026-10-17): a
 * teammate's role is written into its spawn prompt (`**Execute as**: <id>`) and
 * resolved by the plugin's existing `subagents.startActivation` seam — there is
 * no role field on `SpawnTeammateRequest` and no name→role mapping. So this
 * file proves the ROSTER-SHAPED integration, not the seam's own header parsing
 * (that has its own unit suite in `tests/subagents-seam.spec.ts`).
 *
 * `roster.spawn` (`../deepseek-harness/packages/experimental/agent-team/src/
 * roster.ts:248-283`, dsh 0.2.1-rc.1) mints `childId = randomUUID()` and awaits
 *
 *   ctx.subagents.startActivation({
 *     delivery: 'parent', childId, provider: request.provider,
 *     label: description, request: { prompt: request.prompt, parent: root },
 *     signal,
 *   })
 *
 * Every case below drives an activation through the real `apply()`
 * composition and asserts what a teammate's declared role must (or must not)
 * produce: (a) the per-child seam record, (b) the child's scoped persona
 * section, (c) the role's chain head on the child's FIRST `agent/request`. The
 * two non-local cases assert the documented external outcomes instead — the
 * record keyed from the resolved id, or a refusal with no delivery at all.
 *
 * The fake runtime mirrors the rc.1 local/external split the seam routes on:
 * `spawn` exposes `prepareContinuable` (a LOCAL backend — the caller-reserved
 * `childId` IS the child's id, and the child's serial `agent/created` fires
 * INSIDE the native call); every other provider is external, so it REJECTS a
 * caller-reserved `childId` with `UNSUPPORTED_CAPABILITY` (and the roster
 * always reserves one, so a non-local teammate is refused upstream) and
 * otherwise allocates its own child id. Each provisioned child carries an
 * ISOLATED `systemPrompt` double, so a section recorded there is evidence the
 * persona went through THAT child's own `agent.ctx` scope.
 */

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { apply } from '../src/index.ts'
import { subagentSeamOf, type SubagentActivationSpecView, type SubagentSeamRecord } from '../src/subagents-seam.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequest, makeAgent } from './support/harness.ts'
import { settle } from './support/settle.ts'

/** Declared taxonomy under test: `coder` carries both the persona and the chain head. */
function coderRoles() {
  return { list: [{ id: 'coder', persona: 'Coder persona', chain: ['anthropic/claude-sonnet-4'] }], rules: [] }
}

/** The lead session every teammate under test is spawned by (`request.parent.session.id`). */
const LEAD_SESSION = 'lead-session'

/**
 * The registry placement the persona listener resolves
 * (`@deepseek-ai/dsh-system-prompt` `SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX`
 * is `0`). An unexpected name resolves to `NaN`, which no section assertion
 * accepts.
 */
const SECTION_ORDERS: Record<string, number> = { DEPLOYMENT_PERSONA_PREFIX: 0 }

/**
 * A LOCAL backend — `prepareContinuable` is the rc.1 gate that routes a start
 * through `manager.startLocal` and that makes a caller-reserved `childId` legal
 * (any other backend rejects one with `UNSUPPORTED_CAPABILITY`). This is the
 * shape `roster.spawn` runs against.
 */
const LOCAL_PROVIDER = { prepareContinuable: () => undefined }

/** The child id a NON-local backend reports for itself — never the id its caller reserved. */
const EXTERNAL_CHILD_ID = 'external-child'

/**
 * A teammate's spawn prompt: the model-written `**Execute as**: <id>` carrier,
 * opening the prompt the way mstar's canonical dispatch text does.
 */
function teammatePrompt(executeAs: string): string {
  return `**Execute as**: ${executeAs}\n\nOwn the task in the team plan and report back.`
}

/** One activation spec as a caller hands it to `ctx.subagents.startActivation`. */
interface RosterActivation extends SubagentActivationSpecView {
  readonly delivery: 'parent'
  readonly signal: AbortSignal
}

/**
 * One activation as `roster.spawn` hands it to the seam. `childId` is optional
 * on purpose: the roster always reserves one, and the generic external case
 * below is the caller that reserves none.
 */
function rosterActivation(
  childId: string | undefined,
  prompt: string,
  description = 'teammate',
  provider = 'spawn',
): RosterActivation {
  return {
    delivery: 'parent',
    // Spread only when reserved — a present-but-undefined `childId` would be a
    // different spec shape than the caller's real one.
    ...(childId === undefined ? {} : { childId }),
    provider,
    label: description,
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent: { session: { id: LEAD_SESSION } },
    },
    signal: new AbortController().signal,
  }
}

/** One recorded `section()` registration — the prompt-registry call the persona listener makes. */
interface SectionRecord {
  name: string
  order: number
  text: unknown
}

/** One teammate the fake runtime provisioned. */
interface ChildFixture {
  readonly childId: string
  /** Sections registered on this child's OWN isolated `systemPrompt` scope. */
  readonly sections: SectionRecord[]
  /** The seam's record for this child id AT NATIVE-CALL TIME, before `agent/created`. */
  readonly recordAtCall: SubagentSeamRecord | undefined
}

/** The fake rc.1 `subagents` runtime plus what it observed. */
interface FakeSubagents {
  readonly service: Record<string, unknown>
  /** Every activation spec the native path received, in call order. */
  readonly activations: SubagentActivationSpecView[]
  /** Every teammate provisioned, in call order. */
  readonly children: ChildFixture[]
}

/**
 * The fake rc.1 `subagents` runtime, driven the way `roster.spawn` drives it.
 * `spawn` is the local backend; any other provider is external — it refuses a
 * caller-reserved `childId` the way rc.1 does (`UNSUPPORTED_CAPABILITY`) and
 * otherwise resolves with ITS OWN child id.
 */
function fakeSubagents(ctx: Context): FakeSubagents {
  const activations: SubagentActivationSpecView[] = []
  const children: ChildFixture[] = []
  const getProvider = (name: string): Record<string, unknown> | undefined =>
    name === 'spawn' ? LOCAL_PROVIDER : undefined
  const service: Record<string, unknown> = {
    tag: 'raw-subagents',
    getProvider,
    startActivation: async (spec: SubagentActivationSpecView) => {
      activations.push(spec)
      if (getProvider(spec.provider) === undefined) {
        if (spec.childId !== undefined) {
          throw Object.assign(new Error('reserved child ids require a local backend'), {
            code: 'UNSUPPORTED_CAPABILITY',
          })
        }
        return { childId: EXTERNAL_CHILD_ID }
      }
      const childId = spec.childId ?? ''
      // The runtime's child stand-in: `Agent.id` IS the child session id here,
      // and its `ctx` carries an isolated `systemPrompt` double so a recorded
      // section is evidence the persona reached THIS child's own scope. The
      // assertion is structural (the double + the serial event are the only
      // Agent surface this composition consumes), so the cast is unchecked.
      const scope = ctx.isolate('systemPrompt')
      const sections: SectionRecord[] = []
      scope.provide('systemPrompt', {
        getSectionOrder: (name: string) => SECTION_ORDERS[name] ?? Number.NaN,
        section: (section: SectionRecord) => {
          sections.push(section)
          return () => {}
        },
      })
      const child = { id: childId, ctx: scope } as unknown as Agent
      children.push({
        childId,
        sections,
        // The synchronous pre-write the timing contract promises, read BEFORE
        // `agent/created` — the point at which the child's own listeners (and
        // this test) read the map.
        recordAtCall: subagentSeamOf(ctx)?.records.get(childId),
      })
      await ctx.serial('agent/created', { agent: child, source: 'startup' })
      return { childId }
    },
  }
  return { service, activations, children }
}

/** The seam's per-child record map, through the accessor the seam's own tests use. */
function records(): Map<string, SubagentSeamRecord> {
  const seam = subagentSeamOf(ctx)
  if (seam === undefined) throw new Error('the subagent seam is not installed')
  return seam.records
}

/**
 * Read `ctx.subagents` the way the host does: from a CONSUMER fiber that
 * injects the service, through the context PROXY — the `internal/get`
 * waterfall the seam wraps (a same-fiber read, or `ctx.get()`, reads the store
 * directly and bypasses it). The resolved value is narrowed structurally: the
 * seam's wrapper is a prototype delegate, so only its consumed surface is
 * asserted. `rawService` is the value this test provided; resolving to it would
 * mean the seam never intercepted, which makes EVERY negative assertion below
 * vacuous — so the fixture refuses it up front.
 */
async function injectSubagents(
  ctx: Context,
  rawService: Record<string, unknown>,
): Promise<(spec: RosterActivation) => Promise<Record<string, unknown>>> {
  let consumer: Context | undefined
  ctx.plugin({
    name: 'agent-team-roles-consumer',
    inject: ['subagents'],
    apply(consumerCtx: Context) {
      consumer = consumerCtx
    },
  })
  await settle()
  if (consumer === undefined) throw new Error('the consumer fiber did not apply')
  // Unchecked cast assigned once: `Context` declares no service index
  // signature, so the compiler has no shape for a runtime-provided service.
  const consumerServices = consumer as unknown as { subagents: unknown }
  const service: unknown = consumerServices.subagents
  if (service === rawService) {
    throw new Error("the consumer resolved the RAW 'subagents' service — the dispatch seam is not installed")
  }
  if (service === null || typeof service !== 'object' || !('startActivation' in service)) {
    throw new Error("the consumer resolved no activation-capable 'subagents' service")
  }
  const { startActivation } = service
  if (typeof startActivation !== 'function') {
    throw new Error("the resolved 'subagents' service exposes no startActivation")
  }
  // The activation result is the runtime's own opaque object; the cases read it
  // through `toMatchObject`/`resolves` only.
  const start = startActivation as (spec: RosterActivation) => Promise<Record<string, unknown>>
  return (spec) => start(spec)
}

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

/** Mount the real plugin over the fake rc.1 runtime; hand back the wrapper's start call. */
async function mount(): Promise<{
  fake: FakeSubagents
  activate: (spec: RosterActivation) => Promise<Record<string, unknown>>
}> {
  const fake = fakeSubagents(ctx)
  ctx.provide('subagents', fake.service)
  apply(ctx, cfg({ roles: coderRoles() }))
  await settle()
  return { fake, activate: await injectSubagents(ctx, fake.service) }
}

/** Drive one child's FIRST `agent/request` the way the agent loop does. */
async function firstRequest(childId: string): Promise<{ provider: string; model: string }> {
  const seed = { provider: 'mock', model: 'gpt-4o' }
  const { agent } = makeAgent(childId, seed, { origin: 'subagent' })
  return dispatchRequest(ctx, agent, seed)
}

describe('Agent Team teammate role delivery (roster-shaped activation)', () => {
  it('delivers a teammate role end to end: record at native-call time, persona, chain head', async () => {
    const { fake, activate } = await mount()

    const childId = randomUUID()
    const spec = rosterActivation(childId, teammatePrompt('coder'))
    await activate(spec)

    // (a) The record existed SYNCHRONOUSLY, keyed by the id the roster
    // reserved, BEFORE the native call created the child — the only point at
    // which the child's own listeners can still read it.
    expect(fake.children[0]!.recordAtCall).toEqual({
      role: 'coder',
      at: expect.any(Number),
      firstNoticePending: true,
    })
    expect(records().get(childId)?.role).toBe('coder')
    // The runtime received the caller's OWN spec object (a reserved id needs no copy).
    expect(fake.activations[0]).toBe(spec)

    // (b) The child's persona is its role's, registered on the CHILD's own scope.
    expect(fake.children[0]!.sections).toEqual([
      { name: PERSONA_PREFIX_SECTION, order: 0, text: 'Coder persona' },
    ])

    // (c) The child's first request is routed to the role's chain head.
    expect(await firstRequest(childId)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('gives two teammates of the same role their own record, persona and chain head', async () => {
    const { fake, activate } = await mount()

    // Distinct names AND distinct child ids, both declaring `coder` — the
    // dynamic carrier's whole point (the rejected name→role mapping could not
    // express this).
    const first = randomUUID()
    const second = randomUUID()
    await activate(rosterActivation(first, teammatePrompt('coder'), 'review the auth module'))
    await activate(rosterActivation(second, teammatePrompt('coder'), 'write the migration'))

    expect(fake.children.map((child) => child.childId)).toEqual([first, second])
    expect(records().size).toBe(2)
    expect(records().get(first)?.role).toBe('coder')
    expect(records().get(second)?.role).toBe('coder')
    expect(fake.children[0]!.sections).toEqual([
      { name: PERSONA_PREFIX_SECTION, order: 0, text: 'Coder persona' },
    ])
    expect(fake.children[1]!.sections).toEqual([
      { name: PERSONA_PREFIX_SECTION, order: 0, text: 'Coder persona' },
    ])
    expect(await firstRequest(first)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(await firstRequest(second)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  })

  it('leaves a teammate with no declared header un-roled: no record, no persona, request unchanged', async () => {
    const { fake, activate } = await mount()

    const childId = randomUUID()
    const spec = rosterActivation(childId, 'Build the login page and report back.')
    await activate(spec)

    // No role resolved: nothing recorded, and the native path received the
    // caller's OWN spec object, untouched.
    expect(records().size).toBe(0)
    expect(fake.activations[0]).toBe(spec)
    // The teammate still exists — nothing was delivered to it.
    expect(fake.children.map((child) => child.childId)).toEqual([childId])
    expect(fake.children[0]!.sections).toEqual([])
    // The rules/inherit path: the first request keeps the route it inherited.
    expect(await firstRequest(childId)).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('leaves a teammate declaring an UNDECLARED header un-roled (same no-op)', async () => {
    const { fake, activate } = await mount()

    const childId = randomUUID()
    const spec = rosterActivation(childId, teammatePrompt('ghost'))
    await activate(spec)

    expect(records().size).toBe(0)
    expect(fake.activations[0]).toBe(spec)
    expect(fake.children[0]!.sections).toEqual([])
    expect(await firstRequest(childId)).toEqual({ provider: 'mock', model: 'gpt-4o' })
  })

  it('keys a generic external child record off the id the backend resolved', async () => {
    const { fake, activate } = await mount()

    // The seam's generic external shape: a caller that reserves NO `childId`.
    // This is the shape an external backend accepts.
    const spec = rosterActivation(undefined, teammatePrompt('coder'), 'external teammate', 'acp')
    await expect(activate(spec)).resolves.toMatchObject({ childId: EXTERNAL_CHILD_ID })
    expect(fake.activations[0]).toBe(spec)

    // The role IS recorded — keyed from the id the ACTIVATION resolved, never
    // from an id its caller never reserved.
    expect(records().get(EXTERNAL_CHILD_ID)?.role).toBe('coder')
    expect(records().size).toBe(1)
    // No local agent was created, so no persona section was ever attempted…
    expect(fake.children).toEqual([])
    // …and that is the documented outcome, not a failure: no persona verdict is
    // invented for a child this host cannot reach.
    expect(records().get(EXTERNAL_CHILD_ID)?.personaNotApplied).toBeUndefined()
  })

  it('refuses a roster-shaped teammate on a non-local provider, delivering no role', async () => {
    const { fake, activate } = await mount()

    const childId = randomUUID()
    // The REAL roster shape — `roster.spawn` always reserves a `childId` —
    // against a provider whose backend is not local. rc.1 rejects the reserved
    // id, so member creation fails and no role can be delivered.
    const spec = rosterActivation(childId, teammatePrompt('coder'), 'external teammate', 'acp')
    await expect(activate(spec)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'reserved child ids require a local backend',
    })
    // The seam forwarded the caller's OWN spec object — an external backend
    // cannot take a reserved id, so there is nothing to copy it for.
    expect(fake.activations[0]).toBe(spec)

    // No delivery was invented for a member that was never created: neither the
    // reserved id nor the external one carries a record, and no local agent
    // exists to have got a persona.
    expect(records().has(childId)).toBe(false)
    expect(records().has(EXTERNAL_CHILD_ID)).toBe(false)
    expect(records().size).toBe(0)
    expect(fake.children).toEqual([])
  })
})
