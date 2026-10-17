/**
 * Role-persona listener (plan dsh-021-subagent-seam-repair Task 1).
 *
 * Behavioural and public-path, mirroring `role-notice.spec.ts`: the listener is
 * installed exactly as `apply()` installs it, `agent/created` is dispatched the
 * way the agent runtime dispatches it (`ctx.serial`), and the assertions read
 * the listener's observable effect — the prompt-registry registration it makes.
 *
 * Each fixture agent owns an ISOLATED `systemPrompt` service, so a section
 * recorded in one agent's journal is evidence the registration went through
 * THAT agent's own `agent.ctx` scope (the `file-reference-local` shape) rather
 * than a shared/global registry, and a journal that stays empty is evidence it
 * did not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { installRolePersona } from '../src/role-persona.ts'
import type { SubagentSeamRecord } from '../src/subagents-seam.ts'
import type { FallbacksRole } from '../src/config.ts'

/** Declared taxonomy: `coder` and `scout` declare a persona, `reviewer` only whitespace. */
const ROLES: FallbacksRole[] = [
  { id: 'coder', persona: 'Coder persona', chain: [] },
  { id: 'scout', persona: 'Scout persona', chain: [] },
  { id: 'reviewer', persona: '   ' },
]

/**
 * The registry's placement names the listener resolves, at their real values
 * (`@deepseek-ai/dsh-system-prompt` `SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX`
 * is `0`). An unexpected name resolves to `NaN`, which no section assertion
 * accepts.
 */
const SECTION_ORDERS: Record<string, number> = { DEPLOYMENT_PERSONA_PREFIX: 0 }

/** One recorded `section()` registration — the prompt-registry call the listener makes. */
interface SectionRecord {
  name: string
  order: number
  text: unknown
}

/** One dispatched child: the shared-map record, its agent, and its own prompt-registry journal. */
interface ChildFixture {
  id: string
  record: SubagentSeamRecord
  agent: Agent
  sections: SectionRecord[]
}

let ctx: Context

/** The ROOT-shared record map the seam writes at dispatch and this listener reads. */
function recordMap(...children: ChildFixture[]): Map<string, SubagentSeamRecord> {
  return new Map(children.map((child) => [child.id, child.record]))
}

/**
 * One dispatched child: its seam record plus an agent whose own scope provides
 * an isolated `systemPrompt` service journalling the sections registered on it.
 * `sectionError` reproduces the registry's throw sites — the same-name
 * duplicate (the descriptor channel already registered the persona) or any
 * other registration failure.
 */
function child(id: string, role: string, sectionError?: Error): ChildFixture {
  const sections: SectionRecord[] = []
  const scope = ctx.isolate('systemPrompt')
  scope.provide('systemPrompt', {
    getSectionOrder: (name: string) => SECTION_ORDERS[name] ?? Number.NaN,
    section: (section: SectionRecord) => {
      if (sectionError !== undefined) throw sectionError
      sections.push(section)
      return () => {}
    },
  })
  return {
    id,
    record: { role, at: 1, firstNoticePending: true },
    agent: { id, ctx: scope } as unknown as Agent,
    sections,
  }
}

/** Dispatch one `agent/created` the way the agent runtime does, then let the injected fiber apply. */
async function created(agent: Agent): Promise<void> {
  await ctx.serial('agent/created', { agent, source: 'startup' })
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await promise
}

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('role persona — the agent/created listener', () => {
  it('registers the resolved role persona at the deployment persona prefix on the child scope', async () => {
    ctx = new Context()
    const live = child('child-live', 'scout') // exists at install time (the backfill)
    const fresh = child('child-fresh', 'coder') // created after install
    ctx.provide('agents', { list: () => [live.agent] })
    installRolePersona(ctx, { records: recordMap(live, fresh), roles: () => ROLES })

    await created(fresh.agent)

    // Each registration landed on ITS OWN agent's scope, under the section name
    // whose order shadows the global deployment persona (replacement semantics),
    // carrying that role's declared persona.
    expect(live.sections).toEqual([{ name: PERSONA_PREFIX_SECTION, order: 0, text: 'Scout persona' }])
    expect(fresh.sections).toEqual([{ name: PERSONA_PREFIX_SECTION, order: 0, text: 'Coder persona' }])
  })

  it('ignores a child with no dispatch record, and a role that declares no persona (silent no-ops)', async () => {
    ctx = new Context()
    const stranger = child('child-stranger', 'coder') // no record entry
    const blank = child('child-blank', 'reviewer') // record hit, but a blank persona
    ctx.provide('agents', { list: () => [] })
    const debug = vi.fn()
    installRolePersona(ctx, { records: recordMap(blank), roles: () => ROLES, debug })

    await created(stranger.agent)
    await created(blank.agent)

    expect(stranger.sections).toEqual([])
    expect(blank.sections).toEqual([])
    expect(debug).not.toHaveBeenCalled()
  })

  it('treats a same-name duplicate registration as descriptor-delivered (silent skip)', async () => {
    ctx = new Context()
    // The descriptor channel already put `deployment:persona-prefix` on this
    // child's scope: the registry's duplicate throw is the signal.
    const delivered = child(
      'child-delivered',
      'coder',
      new Error(`prompt section "${PERSONA_PREFIX_SECTION}" is already registered in this scope`),
    )
    ctx.provide('agents', { list: () => [] })
    const records = recordMap(delivered)
    const debug = vi.fn()
    installRolePersona(ctx, { records, roles: () => ROLES, debug })

    await created(delivered.agent)

    expect(delivered.sections).toEqual([])
    expect(debug).not.toHaveBeenCalled()
    expect(records.get('child-delivered')?.personaNotApplied).toBeUndefined()
  })

  it('contains any other registration failure and records the persona-not-applied verdict', async () => {
    ctx = new Context()
    const broken = child(
      'child-broken',
      'coder',
      new TypeError(`prompt section "${PERSONA_PREFIX_SECTION}" order must be a finite number`),
    )
    ctx.provide('agents', { list: () => [] })
    const records = recordMap(broken)
    const debug = vi.fn()
    installRolePersona(ctx, { records, roles: () => ROLES, debug })

    // The throw is contained inside the listener: agent creation still resolves.
    await created(broken.agent)

    expect(broken.sections).toEqual([])
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0][0]).toContain('child-broken')
    // The verdict rides the SHARED record: it is what the notice row reads.
    expect(records.get('child-broken')?.personaNotApplied).toBe(true)
  })

  it('dedupes across fibers and clears the marker on agent/disposed', async () => {
    ctx = new Context()
    ctx.provide('agents', { list: () => [] })
    const reused = child('child-reused', 'coder')
    const records = recordMap(reused)
    // TWO fibers of the SAME root: the marker is ROOT-shared, so exactly one of
    // the two listeners registers the section.
    installRolePersona(ctx, { records, roles: () => ROLES })
    installRolePersona(ctx.extend(), { records, roles: () => ROLES })

    await created(reused.agent)
    // Positive control for the assertion below: the marker DOES hold a repeat back.
    expect(reused.sections).toHaveLength(1)
    await created(reused.agent)
    expect(reused.sections).toHaveLength(1)

    // Disposal clears the marker, so a re-created agent of the same id registers again.
    ctx.emit('agent/disposed', { agent: reused.agent })
    const recreated = child('child-reused', 'coder')
    await created(recreated.agent)
    expect(recreated.sections).toEqual([{ name: PERSONA_PREFIX_SECTION, order: 0, text: 'Coder persona' }])
  })
})
