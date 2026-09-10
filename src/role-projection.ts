/**
 * Durable role visibility for the session-header badge (plan
 * role-based-subagent-adoption Task 3b) — ONE host-side session projection unit
 * folding the role out of the child's OWN durable log.
 *
 * Data source = Task 3's notice row, the plugin's single write primitive: the
 * fold reads the child's committed `user/message` events, keeps the one whose
 * provenance is ours (`source.kind === 'plugin'` + `source.plugin ===
 * ROLE_NOTICE_PLUGIN`), and parses the role out of its **content text**
 * (`[role: <id>]`). No second write path, no new event type, no plugin-owned
 * store: the projection is a pure READ of the log, and the host's projection
 * cache checkpoints every registered unit at session creation, `turn/end` and
 * disposal — so a settled child (served as an unpublished observation whose
 * `projections` ride the follow opening snapshot) and a post-restart view both
 * work with nothing of ours on disk.
 *
 * NEVER `source.summary`: summaries are truncated at
 * `CONTEXT_SUMMARY_MAX_CHARS = 120` (`@deepseek-ai/dsh-llm` `message.ts`,
 * applied by `boundContextSummary`) while a role id has no length bound in the
 * settings schema — a long id would be CUT there and the pill would name a role
 * that does not exist. The content blocks are unbounded, so the content text is
 * the only correct source; the row's provenance is what makes the pre-filter
 * cheap.
 *
 * Mount-only + STRUCTURAL: the registry and the unit contract are consumed as
 * the local structural views below and this module value-imports no host seam,
 * so the host calls INTO us. The declared
 * `@deepseek-ai/dsh-session-projection` peerDependency (Task 3b L2 review M-2)
 * serves the in-process Step-0 spec, which builds the REAL registry — being the
 * real registry is the whole point of that proof — not a runtime import here
 * (the badge reads its seat structurally for the same reason).
 * The runtime shape relied on — `register({ key, stateSchema, init, apply,
 * wire: { viewSchema, view }, stateVersion })` → unregister disposer — is the
 * documented `ProjectionDefinition` contract of
 * `@deepseek-ai/dsh-session-projection@0.1.5-rc.1`
 * (`lib/types/index.d.ts:38-80,150-152`); only `.parse` is ever called on the
 * schemas (`lib/index.js:255,305,433`).
 *
 * @module dsh-llm-fallbacks/role-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ROLE_NOTICE_PERSONA_SKIPPED_SUFFIX, ROLE_NOTICE_PLUGIN } from './role-notice.ts'
import { ROLE_PROJECTION_KEY, type RoleProjectionValue } from './role-projection-key.ts'

/**
 * The `.parse` face the registry uses on a definition's `stateSchema` /
 * `wire.viewSchema` (a structural stand-in for the peer's `ZodType`, so this
 * module needs no zod import and no new peer).
 */
interface ProjectionValueSchema<T> {
  parse(value: unknown): T
}

/**
 * One registered projection unit, as this plugin declares it (the consumed
 * subset of the host's `ProjectionDefinition`): `init` and `apply` are PURE and
 * SYNCHRONOUS, `state` is plain JSON (the persisted-checkpoint precondition),
 * and `wire` publishes the client-visible value.
 */
export interface RoleProjectionUnit {
  readonly key: string
  readonly stateSchema: ProjectionValueSchema<RoleProjectionState | null>
  init(header: unknown, inheritedEventCount: number): RoleProjectionState | null
  apply(state: RoleProjectionState | null, event: SessionEvent): RoleProjectionState | null
  readonly stateVersion: number
  readonly wire: {
    readonly viewSchema: ProjectionValueSchema<RoleProjectionValue>
    view(state: RoleProjectionState | null): RoleProjectionValue
  }
}

/**
 * The host fold state: the fork boundary the fold was initialized with, plus the
 * resolved role once an OWN notice row has landed (`role` absent until then).
 * An OBJECT, not a bare string, because the registry's publication rule is
 * reference identity (`Object.is`) — the fold must be able to prove it left the
 * state untouched, and that proof is only meaningful for a value the fold could
 * otherwise re-allocate.
 *
 * `inheritedEventCount` is part of the state, not a closure constant: the
 * registry hands `init` the exact fork-inherited prefix length and then folds
 * the WHOLE log into `apply`, so the boundary has to survive into every `apply`
 * call (and into a persisted checkpoint row) for the fold to skip an ancestor's
 * events.
 */
export interface RoleProjectionState {
  /**
   * The exact fork-inherited prefix length `init` was handed: events with
   * `seq < inheritedEventCount` belong to the ANCESTOR the child was seeded
   * from, never to the child.
   */
  readonly inheritedEventCount: number
  /** The DECLARED RAW role id, verbatim (padding included); absent until then. */
  readonly role?: string
}

/**
 * The registry face this plugin uses (`ctx.sessionProjections`): the
 * client-visible `register` overload plus the read faces the in-process proof
 * reads. Structural on purpose — see the module header.
 */
export interface RoleProjectionRegistryView {
  register(unit: RoleProjectionUnit): () => void
}

/**
 * The projection state/version. Bump `stateVersion` whenever the fold changes —
 * v2 added the fork boundary (`inheritedEventCount`), so a v1 checkpoint row is
 * NOT re-usable and must be refolded from the log.
 */
export const ROLE_PROJECTION_STATE_VERSION = 2

/**
 * Accept only the state this unit can produce: `null`, or an object carrying the
 * fork boundary (`inheritedEventCount`) plus an OPTIONAL non-blank `role`. The
 * parse NORMALIZES to exactly those fields, so a persisted row cannot smuggle
 * anything else forward, and a row that predates the fork boundary is REFUSED
 * rather than served with an invented boundary of 0.
 *
 * Containment is the CALLER's, not this unit's, and it differs by rung
 * (role-projection Task 3b QC CF-9 — the earlier comment here claimed a refold
 * on every rung, which is not what the installed host does): `viewCheckpoint`
 * parses inside a `try/catch` and simply leaves the key absent, while `restore`
 * calls `def.stateSchema.parse(row.val)` with NO `try/catch` — so a malformed
 * row that reaches the `restore`/`coldSnapshot` path throws there instead of
 * degrading to "no pill". Making this schema TOTAL (`return null` for anything
 * unrecognized) is the alternative, and it is not free: a `null` seed keeps the
 * row `usable` and replays only the tail, so a role that landed at or below the
 * row's watermark would be silently lost for that read. The tradeoff is
 * registered as a residual instead of being silently resolved here.
 */
const ROLE_STATE_SCHEMA: ProjectionValueSchema<RoleProjectionState | null> = {
  parse(value: unknown): RoleProjectionState | null {
    if (value === null) return null
    if (typeof value === 'object') {
      const { role, inheritedEventCount } = value as { role?: unknown; inheritedEventCount?: unknown }
      if (isInheritedEventCount(inheritedEventCount)) {
        if (role === undefined) return { inheritedEventCount }
        if (typeof role === 'string' && role.trim() !== '') return { inheritedEventCount, role }
      }
    }
    throw new TypeError(
      `role projection: expected null or a non-blank role id with its fork boundary, got ${describeValue(value)}`,
    )
  },
}

/** Exact fork-inherited prefix length, as the registry hands it to `init`. */
function isInheritedEventCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * The client-visible value: the role id or `null`. Narrower than the state on
 * purpose — the wire carries the fact the badge renders, not the fold's shape.
 */
const ROLE_WIRE_SCHEMA: ProjectionValueSchema<RoleProjectionValue> = {
  parse(value: unknown): RoleProjectionValue {
    if (value === null) return null
    if (typeof value === 'string' && value.trim() !== '') return value
    throw new TypeError(
      `role projection: expected null or a non-blank role id on the wire, got ${describeValue(value)}`,
    )
  },
}

/** One-line account of a rejected value, total for every input. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * The WHOLE notice text: `[role: <id>]`, or the same text with Task 3's persona
 * suffix as an OPTIONAL TRAILING group (`[role: <id>] (persona not applied)`).
 * Anchored and greedy up to the LAST `]`, so a role id containing `]` still
 * parses whole and a row that merely MENTIONS `[role: x]` inside other text
 * never matches.
 *
 * The suffix is part of THIS grammar, never stripped off the text beforehand
 * (Task 3b L2 review M-5): the writer always closes the bracket BEFORE appending
 * the suffix (`buildRoleNotice`: `[role: ${role}]` + suffix), so the optional
 * group can only consume text that follows the closing bracket — an id DECLARED
 * as ending in the suffix literal (`[role: audit (persona not applied)]`)
 * therefore round-trips whole, and only the writer's one appended suffix is ever
 * treated as the skip marker.
 */
const ROLE_NOTICE_TEXT_RE = new RegExp(
  `^\\[role: ([\\s\\S]+)\\](?:${ROLE_NOTICE_PERSONA_SKIPPED_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?$`,
)

/**
 * Parse the role out of one text block, or `undefined` when the block is not
 * exactly a notice. The captured id is returned VERBATIM (the declared id may be
 * padded, and it is the declared id the settings document declares); only a
 * blank capture is rejected.
 */
function roleFromNoticeText(text: string): string | undefined {
  const role = ROLE_NOTICE_TEXT_RE.exec(text)?.[1]
  return role === undefined || role.trim() === '' ? undefined : role
}

/**
 * The role carried by one notice message's content, or `undefined`.
 *
 * Total over `unknown` (Task 3b L2 review M-3): the registry folds committed
 * events straight into `apply` with no try/catch of its own, so a malformed or
 * repaired row (a non-array `content`, a non-object block, a non-text block)
 * must read as "not a notice" instead of throwing inside the host's fold. Never
 * a wrong role either way — an unexpected shape carries no role at all.
 */
function roleFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type !== 'text' || typeof text !== 'string') continue
    const role = roleFromNoticeText(text)
    if (role !== undefined) return role
  }
  return undefined
}

/**
 * The role one committed event carries, or `undefined` when it is not OUR
 * notice row. Shape-guarded for the same reason as {@link roleFromContent}: the
 * fold runs inside the host's `session/event` pipeline, where a throw would
 * escape the projection registry (it calls `apply` unguarded) and break the
 * session read — the plan's degrade-never-crash constraint.
 */
function roleFromEvent(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const { type, data } = event as { type?: unknown; data?: unknown }
  if (type !== 'user/message') return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const { content, source } = data as { content?: unknown; source?: unknown }
  if (typeof source !== 'object' || source === null) return undefined
  const { kind, plugin } = source as { kind?: unknown; plugin?: unknown }
  // Provenance gate (never a wrong role): only THIS plugin's notice rows are
  // read — a human prompt, another plugin's notice, or a row whose text merely
  // looks like a notice is ignored outright.
  if (kind !== 'plugin' || plugin !== ROLE_NOTICE_PLUGIN) return undefined
  return roleFromContent(content)
}

/**
 * The ONE role projection unit (plan Task 3b).
 *
 * `init` records the fork boundary and nothing else (a child's own log carries
 * no role yet), `apply` skips every event BELOW that boundary — the seeded
 * prefix is the ANCESTOR's log, and the plan pins "child whose notice never
 * landed: no pill, never a wrong pill" — and otherwise folds last-wins over our
 * own notice rows, returning the SAME state reference for every event it does
 * not use (the registry's `Object.is` rule: an unchanged reference produces zero
 * downstream work and no client publication) — including a repeated notice with
 * the same role, which is what makes the fold idempotent under a replay.
 *
 * The boundary carries into the state because the registry calls `apply` with
 * the WHOLE log (including the fork prefix) on every rung: `buildCell`,
 * `drive`'s late-registration fold and `restore` all fold from `init` forward.
 * The host's own sibling unit in the same tree does exactly this
 * (`@deepseek-ai/dsh-subagent` `subagentCatalogProjectionDefinition`:
 * `init: (_header, inheritedEventCount) => ({ inheritedEventCount })` and
 * `apply: … || event.seq < state.inheritedEventCount → return state`).
 */
export const roleProjectionUnit: RoleProjectionUnit = {
  key: ROLE_PROJECTION_KEY,
  stateSchema: ROLE_STATE_SCHEMA,
  stateVersion: ROLE_PROJECTION_STATE_VERSION,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount }),
  apply: (state, event) => {
    // Total over `unknown` FIRST (the registry calls `apply` unguarded inside
    // its own fold): a non-object row carries neither a seq nor a notice.
    if (typeof event !== 'object' || event === null) return state
    // A `null` state only reaches this fold from a direct caller/test (the
    // registry always starts from `init`): with no recorded boundary nothing can
    // be proven inherited, so the fold reads the event as before. A row without
    // a numeric `seq` cannot be proven inherited either.
    const inheritedEventCount = state?.inheritedEventCount ?? 0
    const { seq } = event as { seq?: unknown }
    if (typeof seq === 'number' && seq < inheritedEventCount) return state
    const role = roleFromEvent(event)
    // Unparseable row → unchanged state (never a wrong role, never a cleared
    // one); the same role again → the SAME object (no allocation, no phantom
    // publication, and the reference equality the registry relies on).
    if (role === undefined || role === state?.role) return state
    return { inheritedEventCount, role }
  },
  wire: {
    viewSchema: ROLE_WIRE_SCHEMA,
    // The wire value is the fact the badge renders; `Object.is` on it changes
    // exactly when the role changed.
    view: (state) => (state === null ? null : state.role ?? null),
  },
}

/** Options for {@link installRoleProjection}. */
export interface RoleProjectionOptions {
  /** Contained debug sink (at most ONE line per contained degrade). */
  debug?: (message: string) => void
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register {@link roleProjectionUnit} on `ctx.sessionProjections` through the
 * same conditional-inject idiom the plugin already uses for `settings` / `llm` /
 * `typert`: the child activates only when the registry is composed, so a
 * composition without it keeps the key absent and the badge renders nothing
 * (capability absence — never a dispatch failure, never a crash).
 *
 * Registration is an effect on the child fiber: a second apply over the same
 * root registers the SAME key at the SAME `stateVersion`, which the registry
 * counts (one unit, the key survives until the last holder unloads) — so this
 * needs no dedupe of its own, and a reshaped registry that refuses the
 * registration degrades with one contained debug line.
 *
 * @param ctx - the plugin fiber's context.
 * @param options - contained debug sink.
 * @returns the disposer that withdraws the child (and with it the key).
 */
export function installRoleProjection(ctx: Context, options: RoleProjectionOptions = {}): () => void {
  const debug = (message: string): void => {
    try {
      options.debug?.(message)
    } catch {
      // Never-throws invariant: a throwing sink must not escape the install.
    }
  }
  let child: { dispose(): unknown } | undefined
  try {
    child = ctx.inject(['sessionProjections'], (projectionCtx) => {
      try {
        const { sessionProjections: registry } = projectionCtx as unknown as {
          sessionProjections?: RoleProjectionRegistryView
        }
        if (registry === undefined || typeof registry.register !== 'function') {
          debug(
            'llm-fallbacks: role projection not registered — the resolved sessionProjections service is not a registry (the badge shows no role on this composition)',
          )
          return () => {}
        }
        return registry.register(roleProjectionUnit)
      } catch (error) {
        // Contained: a registry that refuses the unit must not break the plugin.
        debug(`llm-fallbacks: role projection not registered (contained): ${errorMessage(error)}`)
        return () => {}
      }
    })
  } catch (error) {
    debug(`llm-fallbacks: role projection install skipped (contained): ${errorMessage(error)}`)
  }
  return () => {
    try {
      child?.dispose()
    } catch {
      // A throwing teardown must not escape the seam's dispose either.
    }
  }
}
