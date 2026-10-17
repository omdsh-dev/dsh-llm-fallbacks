/**
 * Role-persona delivery over `agent/created` (plan dsh-021-subagent-seam-repair
 * Task 1).
 *
 * rc.1 removed `SubagentStartRequest.persona`, so the resolved dispatch role's
 * persona is delivered as a SCOPED system-prompt section on the CHILD's own
 * context — the shipped `file-reference-local` pattern (no request mutation, no
 * provider capability gate, no Agent Preset). The section carries the SAME name
 * and order the global deployment persona uses (`SystemPrompt.section`: a
 * scoped section shadows a global section with the same name), so the child's
 * persona REPLACES the deployment prefix instead of stacking under it — the
 * semantics the removed request slot had.
 *
 * Timing: `CreateAgentOptions.setup`'s contract plus `AgentLoop`'s announce
 * guarantee that everything registered for the child exists before
 * `agent/created` is emitted, and the emitter is awaited before the child's
 * first prompt assembly. The seam's `agent/pre-step` notice emitter therefore
 * always observes a child whose persona section is already registered; both
 * surfaces read the SAME ROOT-shared record map, which is what keeps the
 * ` (persona not applied)` suffix truthful.
 *
 * Containment (the seam's degrade-never-crash invariant, and required here
 * because a throwing serial `agent/created` listener fails agent creation):
 * only an agent whose id hits the shared record map is touched (a miss is a
 * silent no-op), a same-name duplicate throw means the descriptor channel
 * already delivered the persona (silent skip), and every other throw is
 * contained to ONE debug line plus the record's sticky `personaNotApplied`.
 *
 * @module dsh-llm-fallbacks/role-persona
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { personaForRole, type SubagentSeamRecord } from './subagents-seam.ts'
import type { FallbacksRole } from './config.ts'

/** Options for {@link installRolePersona}. */
export interface RolePersonaOptions {
  /**
   * The seam's ROOT-shared per-child records — the SAME map the notice
   * emitter reads; the listener writes `personaNotApplied` verdicts back
   * into it (sticky per the existing {@link SubagentSeamRecord} contract).
   */
  records: Map<string, SubagentSeamRecord>
  /** Live declared roles (`roles.list`) — the persona source, read per agent/created. */
  roles: () => readonly FallbacksRole[]
  /** Contained debug sink (at most one line per contained degrade). */
  debug?: (message: string) => void
}

/** The installed listener surface (explicit teardown; fiber teardown also stops it). */
export interface RolePersona {
  dispose(): void
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Context ROOTS that already carry this module's persona-listener state. The
 * `agent/created` listener is registered per APPLIED FIBER (like the notice
 * emitter), so the marker must be ROOT-shared: a per-fiber copy would let the
 * second fiber of one root register the section a second time. Weak, so the
 * state dies with the root; keyed by root, so two hosts in one process (and
 * two test roots) never share claims.
 */
const rolePersonaStates = new WeakMap<Context, Set<string>>()

/** The root's shared marker set, created when the root has none yet. */
function rolePersonaStateFor(root: Context): Set<string> {
  const existing = rolePersonaStates.get(root)
  if (existing !== undefined) return existing
  const created = new Set<string>()
  rolePersonaStates.set(root, created)
  return created
}

/**
 * Install the role-persona listener on `ctx`: register the resolved role's
 * persona as a scoped `deployment:persona-prefix` section on every created
 * agent whose id hits the shared record map, plus a `agents.list()` backfill
 * for children that already exist at install time.
 *
 * Returns the installed listener (its `dispose` withdraws this fiber's
 * registrations; a fiber teardown stops it as well).
 */
export function installRolePersona(ctx: Context, options: RolePersonaOptions): RolePersona {
  const root = ctx.root
  const registered = rolePersonaStateFor(root)
  const debug = (message: string): void => {
    try {
      options.debug?.(message)
    } catch {
      // Never-throws invariant: a throwing sink must not escape the listener.
    }
  }

  /**
   * One contained failure at the persona slot. A same-name duplicate means the
   * descriptor channel already delivered the persona: silent. Anything else is
   * reported once and recorded as the STICKY `personaNotApplied` verdict the
   * notice row reads (the record map is shared with the seam, so the verdict
   * rides the child's own record).
   *
   * The duplicate test is the registry's DUPLICATE-NAME error — the signature of
   * a resumed continuable child whose persisted descriptor already registered
   * `deployment:persona-prefix` on its own scope (upstream
   * `applyChildOverrides` composes the descriptor's persona), i.e. the persona
   * IS delivered and must not be reported missing. Upstream throws a plain
   * `Error` (`prompt section "<name>" is already registered in this scope`) and
   * the registry exposes no read of its registered names, so the message is the
   * only available signal.
   * simplify: message-coupled — an upstream reword downgrades the skip to a
   * contained degrade, and the notice row would then claim "persona not applied"
   * for a persona the descriptor did deliver. Upgrade path: a typed error/code
   * from `SystemPrompt.section`.
   */
  const contain = (agent: Agent, record: SubagentSeamRecord, error: unknown): void => {
    if (error instanceof Error && error.message.includes('is already registered')) return
    debug(
      `llm-fallbacks: role persona for agent "${agent.id}" (role "${record.role}") not applied — contained, the child runs unchanged: ${errorMessage(error)}`,
    )
    record.personaNotApplied = true
  }

  /** Register the resolved role persona for one agent; never throws. */
  const installPersona = (agent: Agent): void => {
    // A miss is not a role child (an unrelated agent, or a dispatch the seam
    // never saw): nothing to deliver, nothing to report.
    const record = options.records.get(agent.id)
    if (record === undefined) return
    // This root already attempted the child (a sibling fiber's listener, or a
    // repeated `agent/disposed`-less notification): the section is registered
    // once per child id.
    if (registered.has(agent.id)) return
    let persona: string | undefined
    try {
      persona = personaForRole(options.roles(), record.role)
    } catch (error) {
      // A throwing live roles source is not a persona verdict: the declaration
      // could not be read, so nothing was skipped.
      debug(
        `llm-fallbacks: role persona for agent "${agent.id}" not resolved — contained, the child runs unchanged: ${errorMessage(error)}`,
      )
      return
    }
    // A role that declares no (or a blank) persona has nothing to deliver.
    if (persona === undefined) return
    const text = persona
    // Claim BEFORE the fiber applies: `inject` registers a child plugin, so the
    // section lands on a later tick — the claim is what keeps a sibling fiber's
    // listener from registering the same name on the same scope.
    registered.add(agent.id)
    try {
      agent.ctx.inject(['systemPrompt'], (scope) => {
        try {
          scope.systemPrompt.section({
            name: PERSONA_PREFIX_SECTION,
            order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text,
          })
        } catch (error) {
          contain(agent, record, error)
        }
      })
    } catch (error) {
      // Registering the section's own fiber failed (an agent scope that already
      // unwound): same containment, since a throw would fail agent creation.
      contain(agent, record, error)
    }
  }

  const disposers: Array<() => void> = []
  // `agent/created` is a serial event: its listener contract is
  // `undefined | Promise<undefined>` (a rejection fails agent creation), so the
  // explicitly returned `undefined` is the contract, not a style choice.
  disposers.push(ctx.on('agent/created', ({ agent }) => {
    installPersona(agent)
    return undefined
  }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => { registered.delete(agent.id) }))
  // Backfill: a child created before this fiber applied (a plugin reload over a
  // live root) is still a role child the persona owes. The consumed surface is
  // read structurally — an absent registry, or a narrower `agents` service
  // without `list` (hosts and test doubles both), simply has no child to
  // backfill; nothing here may break the plugin's apply.
  const agents: { list?: () => readonly Agent[] } | undefined = ctx.get('agents')
  if (typeof agents?.list === 'function') {
    for (const agent of agents.list()) installPersona(agent)
  }

  return {
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
      // Drop the root's claims so a reloaded fiber can attempt the children
      // again: the sections of a disposed fiber's agents are gone with it, and a
      // surviving duplicate is contained as a descriptor-delivered skip.
      registered.clear()
    },
  }
}
