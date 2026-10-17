/**
 * Role-persona listener (plan dsh-021-subagent-seam-repair Task 1).
 *
 * Behavioural and public-path, mirroring `role-notice.spec.ts`: the listener is
 * installed exactly as `apply()` installs it, `agent/created` is dispatched the
 * way the agent runtime dispatches it (`ctx.serial`), and the assertions read
 * the listener's observable effect — the prompt-registry registration it makes.
 *
 * Each fixture agent owns an ISOLATED `systemPrompt` double, so a section
 * recorded in one agent's journal is evidence the registration went through
 * THAT agent's own `agent.ctx` scope (the `file-reference-local` shape) rather
 * than a shared/global registry, and a journal that stays empty is evidence it
 * did not.
 *
 * The closing suite drops the doubles for the ownership questions: real
 * `@deepseek-ai/cordis` + the real `@deepseek-ai/dsh-system-prompt` registry,
 * asserted on the ASSEMBLED prompt. Only the real registry owns the section's
 * registration effect, so only there is "the injected fiber was released"
 * observable at all — the readiness the serial `agent/created` dispatch owes
 * the child's first prompt is asserted there too, with NO extra timer tick.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installRolePersona } from '../src/role-persona.ts'
import type { SubagentSeamRecord } from '../src/subagents-seam.ts'
import type { FallbacksRole } from '../src/config.ts'
import { settle } from './support/settle.ts'

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

/** The registry's exact scoped duplicate message for the persona section. */
const DUPLICATE_MESSAGE = `prompt section "${PERSONA_PREFIX_SECTION}" is already registered in this scope`

/** The global persona the real registry is configured with in the closing suite. */
const DEPLOYMENT_PERSONA = 'Deployment persona'

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

/** One dispatched child's seam record. */
function seamRecord(role: string): SubagentSeamRecord {
  return { role, at: 1, firstNoticePending: true }
}

/**
 * One dispatched child: its seam record plus an agent whose own scope provides
 * an isolated `systemPrompt` double journalling the sections registered on it.
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
    record: seamRecord(role),
    agent: { id, ctx: scope } as unknown as Agent,
    sections,
  }
}

/** Dispatch one `agent/created` the way the agent runtime does, then let the injected fiber apply. */
async function created(agent: Agent): Promise<void> {
  await ctx.serial('agent/created', { agent, source: 'startup' })
  await settle()
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

  it('treats the same-name scoped duplicate as descriptor-delivered (logged skip, no verdict)', async () => {
    ctx = new Context()
    // The descriptor channel already put `deployment:persona-prefix` on this
    // child's scope: the registry's exact scoped duplicate is the signal.
    const delivered = child('child-delivered', 'coder', new Error(DUPLICATE_MESSAGE))
    ctx.provide('agents', { list: () => [] })
    const records = recordMap(delivered)
    const debug = vi.fn()
    installRolePersona(ctx, { records, roles: () => ROLES, debug })

    await created(delivered.agent)

    expect(delivered.sections).toEqual([])
    // Observable, not silent: the one line names the channel that delivered it.
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0][0]).toContain('descriptor channel')
    expect(records.get('child-delivered')?.personaNotApplied).toBeUndefined()
  })

  it('does not absorb an unrelated registration failure that carries the duplicate phrase', async () => {
    ctx = new Context()
    // A duplicate of a DIFFERENT registry entry: no persona was delivered, so
    // the verdict must stand.
    const other = child(
      'child-other-duplicate',
      'coder',
      new Error('prompt context "some:elsewhere" is already registered in this scope'),
    )
    ctx.provide('agents', { list: () => [] })
    const records = recordMap(other)
    const debug = vi.fn()
    installRolePersona(ctx, { records, roles: () => ROLES, debug })

    await created(other.agent)

    expect(other.sections).toEqual([])
    expect(debug).toHaveBeenCalledTimes(1)
    expect(records.get('child-other-duplicate')?.personaNotApplied).toBe(true)
  })

  it('does not absorb a synchronous injection failure that carries the duplicate phrase', async () => {
    ctx = new Context()
    ctx.provide('agents', { list: () => [] })
    // An agent scope that already unwound refuses the inject child; the phrase
    // it throws is not a persona section registration.
    const record = seamRecord('coder')
    const unwound = {
      id: 'child-unwound',
      ctx: {
        inject: () => {
          throw new Error(DUPLICATE_MESSAGE)
        },
      },
    } as unknown as Agent
    const debug = vi.fn()
    installRolePersona(ctx, { records: new Map([['child-unwound', record]]), roles: () => ROLES, debug })

    await created(unwound)

    expect(debug).toHaveBeenCalledTimes(1)
    expect(record.personaNotApplied).toBe(true)
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

describe('role persona — real cordis + real dsh-system-prompt', () => {
  /** Mount the real registry on `ctx`, resolve the child scope, and return both. */
  async function realChild(id: string, role: string): Promise<{ agent: Agent; scopeKey: object }> {
    await ctx.plugin(SystemPrompt, { personaPrefix: DEPLOYMENT_PERSONA })
    const scopeKey = {}
    const agent = { id, ctx: createScope(ctx, scopeKey).ctx } as unknown as Agent
    return { agent, scopeKey }
  }

  /** The assembled persona section's text for one scope. */
  async function assembledPersona(scopeKey: object): Promise<string | undefined> {
    const assembly = await ctx.systemPrompt.assemble({ scope: scopeKey })
    return assembly.sections.find((section) => section.name === PERSONA_PREFIX_SECTION)?.text
  }

  it('puts the persona on the child scope before the agent/created dispatch resolves', async () => {
    ctx = new Context()
    const { agent, scopeKey } = await realChild('child-first-prompt', 'coder')
    const records = new Map([['child-first-prompt', seamRecord('coder')]])
    installRolePersona(ctx, { records, roles: () => ROLES })

    // The dispatch the agent runtime awaits before the child's first prompt.
    await ctx.serial('agent/created', { agent, source: 'startup' })

    // NO extra timer tick: the section must already be assembled, and it REPLACES
    // the same-named global deployment persona (the scoped section shadows it).
    expect(await assembledPersona(scopeKey)).toBe('Coder persona')
    expect(records.get('child-first-prompt')?.personaNotApplied).toBeUndefined()
  })

  it('releases the injected fiber on agent/disposed, withdrawing the section', async () => {
    ctx = new Context()
    const { agent, scopeKey } = await realChild('child-disposed', 'coder')
    installRolePersona(ctx, { records: new Map([['child-disposed', seamRecord('coder')]]), roles: () => ROLES })
    await ctx.serial('agent/created', { agent, source: 'startup' })
    expect(await assembledPersona(scopeKey)).toBe('Coder persona')

    ctx.emit('agent/disposed', { agent })
    await settle()

    // The child keeps its scope but no longer keeps this listener's section.
    expect(await assembledPersona(scopeKey)).toBe(DEPLOYMENT_PERSONA)
  })

  it('dispose() releases every outstanding fiber and clears the shared marker', async () => {
    ctx = new Context()
    const { agent, scopeKey } = await realChild('child-owned', 'coder')
    const records = new Map([['child-owned', seamRecord('coder')]])
    const listener = installRolePersona(ctx, { records, roles: () => ROLES })
    await ctx.serial('agent/created', { agent, source: 'startup' })
    expect(await assembledPersona(scopeKey)).toBe('Coder persona')

    listener.dispose()
    await settle()
    // No agent keeps a section this listener installed.
    expect(await assembledPersona(scopeKey)).toBe(DEPLOYMENT_PERSONA)

    // The marker is cleared, so a reloaded fiber installs the persona again
    // (a still-claimed marker would skip the registration entirely).
    installRolePersona(ctx.extend(), { records, roles: () => ROLES })
    await ctx.serial('agent/created', { agent, source: 'startup' })
    expect(await assembledPersona(scopeKey)).toBe('Coder persona')
  })

  it("releases every outstanding fiber when the installer's own fiber is torn down", async () => {
    ctx = new Context()
    const { agent, scopeKey } = await realChild('child-reloaded', 'scout')
    // The installed fiber the plugin's apply() runs on: its teardown must
    // withdraw the sections, because the injected fibers belong to the CHILD
    // scopes and outlive it.
    const installer = ctx.plugin((pluginCtx) => {
      installRolePersona(pluginCtx, {
        records: new Map([['child-reloaded', seamRecord('scout')]]),
        roles: () => ROLES,
      })
    })
    await installer
    await ctx.serial('agent/created', { agent, source: 'startup' })
    expect(await assembledPersona(scopeKey)).toBe('Scout persona')

    await installer.dispose()
    await settle()

    expect(await assembledPersona(scopeKey)).toBe(DEPLOYMENT_PERSONA)
  })
})
