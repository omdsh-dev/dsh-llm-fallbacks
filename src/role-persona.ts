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
 * Timing: `agent/created` is a serial event awaited before the child's first
 * prompt assembly, and this listener AWAITS the injected section fiber: cordis
 * activates a child fiber on a later tick, so awaiting it is what makes the
 * persona observable by the time the dispatch resolves (the shipped
 * `file-reference-local` shape). The seam's `agent/pre-step` notice emitter
 * therefore always observes a child whose persona section is already
 * registered; both surfaces read the SAME ROOT-shared record map, which is what
 * keeps the ` (persona not applied)` suffix truthful.
 *
 * Ownership: the injected fiber belongs to the CHILD's scope, so it does not
 * die with this listener's fiber — each listener holds ITS OWN fibers per agent
 * and releases them on `agent/disposed`, on plugin-fiber teardown, and on
 * explicit `dispose()`. The root-shared claim that dedupes sibling listeners
 * records which listener owns it, so one installer's teardown never releases
 * another's fibers or claims, and a repeated notification never replaces the
 * handle to the fiber that holds the live registration.
 *
 * Containment (the seam's degrade-never-crash invariant, and required here
 * because a throwing serial `agent/created` listener fails agent creation):
 * only an agent whose id hits the shared record map is touched (a miss is a
 * silent no-op), the registry's exact same-name SCOPED section duplicate means
 * a persona section is already on that scope (one attribution-free debug line,
 * no verdict — the registry cannot say who registered it), and every other
 * throw — including a failed fiber activation — is contained to ONE debug line
 * plus the record's sticky `personaNotApplied`.
 *
 * @module dsh-llm-fallbacks/role-persona
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
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
 * Context ROOTS that already carry this module's persona-listener claims. The
 * `agent/created` listener is registered per APPLIED FIBER (like the notice
 * emitter), so the claim must be ROOT-shared: a per-fiber copy would let the
 * second fiber of one root register the section a second time. The value is the
 * LISTENER that owns the registration, so an installer's teardown releases
 * exactly its own claims and never a sibling's live one. Weak, so the state
 * dies with the root; keyed by root, so two hosts in one process (and two test
 * roots) never share claims.
 */
const rolePersonaStates = new WeakMap<Context, Map<string, object>>()

/** The root's shared claim map, created when the root has none yet. */
function rolePersonaStateFor(root: Context): Map<string, object> {
  const existing = rolePersonaStates.get(root)
  if (existing !== undefined) return existing
  const created = new Map<string, object>()
  rolePersonaStates.set(root, created)
  return created
}

/**
 * Install the role-persona listener on `ctx`: register the resolved role's
 * persona as a scoped `deployment:persona-prefix` section on every created
 * agent whose id hits the shared record map, plus a `agents.list()` backfill
 * for children that already exist at install time.
 *
 * Returns the installed listener (its `dispose` withdraws this listener's OWN
 * registrations; a fiber teardown stops it as well).
 */
export function installRolePersona(ctx: Context, options: RolePersonaOptions): RolePersona {
  const root = ctx.root
  const registered = rolePersonaStateFor(root)
  /**
   * This listener's identity in `registered`: it owns every claim it makes, and
   * is therefore the only listener that may release them.
   */
  const owner: object = {}
  /** This listener's OWN injected section fibers, by agent id. */
  const fibers = new Map<string, Fiber>()
  const debug = (message: string): void => {
    try {
      options.debug?.(message)
    } catch {
      // Never-throws invariant: a throwing sink must not escape the listener.
    }
  }

  /**
   * One contained failure at the persona slot: one debug line plus the STICKY
   * `personaNotApplied` verdict the notice row reads (the record map is shared
   * with the seam, so the verdict rides the child's own record).
   */
  const contain = (agent: Agent, record: SubagentSeamRecord, error: unknown): void => {
    debug(
      `llm-fallbacks: role persona for agent "${agent.id}" (role "${record.role}") not applied — contained, the child runs unchanged: ${errorMessage(error)}`,
    )
    record.personaNotApplied = true
  }

  /**
   * Withdraw this listener's own injected section for one agent id. Cordis
   * unloads the child fiber on a later tick, so the unload is not awaited here;
   * the promise is still consumed so a rejected unload cannot surface as an
   * unhandled rejection.
   */
  const release = (id: string): void => {
    const fiber = fibers.get(id)
    if (fiber === undefined) return
    fibers.delete(id)
    void fiber.dispose().catch((error: unknown) => {
      debug(
        `llm-fallbacks: role persona section for agent "${id}" not withdrawn (contained): ${errorMessage(error)}`,
      )
    })
  }

  /** Register the resolved role persona for one agent; never throws. */
  const installPersona = async (agent: Agent): Promise<void> => {
    // A miss is not a role child (an unrelated agent, or a dispatch the seam
    // never saw): nothing to deliver, nothing to report.
    const record = options.records.get(agent.id)
    if (record === undefined) return
    // The section is registered once per child id on this root, by exactly one
    // listener: a sibling fiber's listener owns it, or THIS listener already
    // does (a repeated notification). Re-injecting would only hit the registry's
    // duplicate and replace the handle to the fiber that owns the live
    // registration, so a repeat is answered without injecting at all.
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
    // Claim BEFORE the fiber applies: a sibling fiber's listener must not
    // register the same name on the same scope while this one is in flight.
    // The claim records THIS listener as its owner.
    registered.set(agent.id, owner)
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        try {
          scope.systemPrompt.section({
            name: PERSONA_PREFIX_SECTION,
            order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text,
          })
        } catch (error) {
          // The ONE skippable failure — the registry's duplicate for THIS name
          // in a SCOPED layer: the scope already carries a section of this
          // name (a sibling listener's registration, or one a resumed child's
          // own scope brought with it — upstream `applyChildOverrides` composes
          // the descriptor's persona there), i.e. the persona IS delivered and
          // must not be reported missing, whoever registered the section.
          //
          // Upstream `SystemPrompt.section` throws a plain `Error` and the
          // registry exposes no read of its registered names, so the message is
          // the only available signal. It is matched EXACTLY, name included, so
          // a duplicate of any OTHER registry entry (context, variable, or the
          // unscoped global section, each with its own wording) and every other
          // registration failure still reach the contained verdict below. It
          // cannot tell WHO registered the name, so the debug line below states
          // only what is known: a same-name section already exists in this
          // scope, so THIS listener did not install the persona. Any same-name
          // section the scope already carries is skipped, whoever put it there.
          // simplify: message-coupled — an upstream reword downgrades this skip
          // to a contained degrade (a false "persona not applied" for a persona
          // the already-present section delivered). Upgrade path: a typed
          // error/code from `SystemPrompt.section`.
          if (
            error instanceof Error &&
            error.message === `prompt section "${PERSONA_PREFIX_SECTION}" is already registered in this scope`
          ) {
            debug(
              `llm-fallbacks: role persona for agent "${agent.id}" not installed — a section named "${PERSONA_PREFIX_SECTION}" already exists in its scope: ${errorMessage(error)}`,
            )
            return
          }
          contain(agent, record, error)
        }
      })
      fibers.set(agent.id, fiber)
      // The child fiber activates on its own tick; awaiting it is what makes the
      // section observable before this serial dispatch resolves, i.e. before the
      // child's first prompt assembly.
      await fiber
    } catch (error) {
      // A failed activation, or an agent scope that already unwound: same
      // containment, since a throw would fail agent creation.
      release(agent.id)
      contain(agent, record, error)
    }
  }

  const disposers: Array<() => void> = []
  // `agent/created` is a serial event: its listener contract is
  // `undefined | Promise<undefined>` (a rejection fails agent creation), so the
  // awaited dispatch and the explicitly returned `undefined` are the contract,
  // not style choices — awaiting the injected fiber is what puts the section on
  // the child before its first prompt assembly.
  disposers.push(ctx.on('agent/created', async ({ agent }) => {
    await installPersona(agent)
    return undefined
  }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    // The child is gone: withdraw the section this listener installed for it,
    // then free its id — whoever holds the claim, since a disposed child's scope
    // takes the section down with it — so a re-created agent is delivered to
    // again.
    release(agent.id)
    registered.delete(agent.id)
  }))
  // Backfill: a child created before this fiber applied (a plugin reload over a
  // live root) is still a role child the persona owes. The consumed surface is
  // read structurally — an absent registry, or a narrower `agents` service
  // without `list` (hosts and test doubles both), simply has no child to
  // backfill; nothing here may break the plugin's apply. `installPersona` never
  // rejects, so the deferred activation against the already-existing child is
  // safe to leave unawaited.
  const agents: { list?: () => readonly Agent[] } | undefined = ctx.get('agents')
  if (typeof agents?.list === 'function') {
    for (const agent of agents.list()) void installPersona(agent)
  }

  const dispose = (): void => {
    for (const off of disposers.splice(0)) off()
    // Withdraw every section this listener installed, then release exactly THIS
    // listener's claims so a reloaded fiber can attempt the children again. A
    // sibling fiber's surviving claim backs its own section — it is not ours to
    // release, and dropping it would make that section look unclaimed to the
    // next listener (which would re-inject, hit the duplicate, and lose the
    // handle to the fiber that owns the registration).
    for (const id of [...fibers.keys()]) release(id)
    for (const [id, holder] of [...registered]) if (holder === owner) registered.delete(id)
  }
  // The injected fibers belong to the CHILD scopes, so they outlive THIS fiber:
  // a plugin unload/reload must run the same teardown (the peer
  // `subagentSeam.dispose()` is wired into the plugin effect the same way).
  ctx.effect(() => dispose, 'llm-fallbacks: role persona listener')
  return { dispose }
}
