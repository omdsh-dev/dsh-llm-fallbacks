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
 * the local structural views below, so the plugin adds no new
 * `@deepseek-ai/dsh-session-projection` peer for a two-method contract the host
 * calls INTO us (the badge reads its seat structurally for the same reason).
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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
 * The host fold state: the resolved role, or `null` while the child's log
 * carries no notice row. An OBJECT, not a bare string, because the registry's
 * publication rule is reference identity (`Object.is`) — the fold must be able
 * to prove it left the state untouched, and that proof is only meaningful for a
 * value the fold could otherwise re-allocate.
 */
export interface RoleProjectionState {
  /** The DECLARED RAW role id, verbatim (padding included). */
  readonly role: string
}

/**
 * The registry face this plugin uses (`ctx.sessionProjections`): the
 * client-visible `register` overload plus the read faces the in-process proof
 * reads. Structural on purpose — see the module header.
 */
export interface RoleProjectionRegistryView {
  register(unit: RoleProjectionUnit): () => void
}

/** The projection state/version. Bump `stateVersion` whenever the fold changes. */
export const ROLE_PROJECTION_STATE_VERSION = 1

/**
 * Accept only the state this unit can produce: `null`, or an object carrying a
 * non-blank `role`. The parse NORMALIZES to that one field, so a persisted row
 * cannot smuggle anything else forward; anything rejected leaves the row
 * unusable and the registry refolds from the exact log (`viewCheckpoint`
 * catches; `restore` re-reads) instead of serving garbage.
 */
const ROLE_STATE_SCHEMA: ProjectionValueSchema<RoleProjectionState | null> = {
  parse(value: unknown): RoleProjectionState | null {
    if (value === null) return null
    if (typeof value === 'object') {
      const role = (value as { role?: unknown }).role
      if (typeof role === 'string' && role.trim() !== '') return { role }
    }
    throw new TypeError(
      `role projection: expected null or a non-blank role id, got ${describeValue(value)}`,
    )
  },
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
 * The WHOLE notice text, with the Task 3 persona suffix tolerated and stripped
 * first: `[role: <id>]` or `[role: <id>] (persona not applied)`. Anchored and
 * greedy up to the LAST `]`, so a role id containing `]` still parses whole and
 * a row that merely MENTIONS `[role: x]` inside other text never matches.
 */
const ROLE_NOTICE_TEXT_RE = /^\[role: ([\s\S]+)\]$/

/**
 * Parse the role out of one text block, or `undefined` when the block is not
 * exactly a notice. The captured id is returned VERBATIM (the declared id may be
 * padded, and it is the declared id the settings document declares); only a
 * blank capture is rejected.
 */
function roleFromNoticeText(text: string): string | undefined {
  const stripped = text.endsWith(ROLE_NOTICE_PERSONA_SKIPPED_SUFFIX)
    ? text.slice(0, -ROLE_NOTICE_PERSONA_SKIPPED_SUFFIX.length)
    : text
  const role = stripped.match(ROLE_NOTICE_TEXT_RE)?.[1]
  return role === undefined || role.trim() === '' ? undefined : role
}

/** The role carried by one notice message's content, or `undefined`. */
function roleFromContent(content: readonly ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type !== 'text') continue
    const role = roleFromNoticeText(block.text)
    if (role !== undefined) return role
  }
  return undefined
}

/**
 * The ONE role projection unit (plan Task 3b).
 *
 * `init` is `null` (an empty log has no role), `apply` is a last-wins fold over
 * our notice rows that returns the SAME state reference for every other event
 * (the registry's `Object.is` rule: an unchanged reference produces zero
 * downstream work and no client publication) — including a repeated notice with
 * the same role, which is what makes the fold idempotent under a replay.
 */
export const roleProjectionUnit: RoleProjectionUnit = {
  key: ROLE_PROJECTION_KEY,
  stateSchema: ROLE_STATE_SCHEMA,
  stateVersion: ROLE_PROJECTION_STATE_VERSION,
  init: () => null,
  apply: (state, event) => {
    if (event.type !== 'user/message') return state
    const { content, source } = event.data
    // Provenance gate (never a wrong role): only THIS plugin's notice rows are
    // read — a human prompt, another plugin's notice, or a row whose text merely
    // looks like a notice is ignored outright.
    if (source.kind !== 'plugin' || source.plugin !== ROLE_NOTICE_PLUGIN) return state
    const role = roleFromContent(content)
    // Unparseable row → unchanged state (never a wrong role, never a cleared
    // one); the same role again → the SAME object (no allocation, no phantom
    // publication, and the reference equality the registry relies on).
    if (role === undefined || role === state?.role) return state
    return { role }
  },
  wire: {
    viewSchema: ROLE_WIRE_SCHEMA,
    // The wire value is the fact the badge renders; `Object.is` on it changes
    // exactly when the role changed.
    view: (state) => (state === null ? null : state.role),
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
