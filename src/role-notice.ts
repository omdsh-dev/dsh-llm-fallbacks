/**
 * In-session role notice row (plan role-based-subagent-adoption Task 3).
 *
 * The child of a role-carrying dispatch gets ONE durable transcript row naming
 * the role it was dispatched as, so the role is visible where the work is read
 * — inside the child's own session — without reaching for live plugin state.
 *
 * Channel: an `agent/pre-step` listener that appends EXACTLY ONE message to the
 * decision the loop is about to enter (`decision.messages`), which the loop
 * then commits durably on the step's first attempt
 * (`agent-loop/src/agent.ts:373-378` — `if (firstAttempt) for (const message of
 * decision.messages)` the loop commits each message to the session log as a
 * `'user/message'`). The listener is registered with `{ prepend: true }` (the
 * `modelSwitchNotice` precedent in
 * `core/agent/src/model-selection.ts:108-125`), so it is the OUTERMOST layer:
 * `await next()` yields the FINAL decision every other listener shaped. The
 * contract is EXACTLY ONE row, not its position: a plugin that registers its
 * own `{ prepend: true }` `agent/pre-step` listener AFTER this one sits outside
 * it and may append after the notice, and the loop commits the decision's
 * messages in order — so the row is appended to whatever the inner listeners
 * shaped, not guaranteed to be the last one.
 *
 * NOT `agent.inject()`: that queue is documented as lossy — "It may miss a
 * request whose pre-step already claimed its batch. Cancellation or disposal
 * may discard pending context." (`core/agent/src/runtime-types.ts:231-241`), and
 * with `wakeup: false` an idle child is never woken to receive it. The pre-step
 * decision has neither failure mode.
 *
 * Session-write contract (plan Global Constraints, hard): the row is a
 * `user/message` built with `createUserMessage` and the producer-declared
 * source `{ kind: 'llm-fallbacks-role-notice', form: 'notice', summary: … }`.
 * 0.1.7-rc.1 removed the shared `plugin` kind: `MessageSourceMap` is
 * producer-declared now ("each producer declares its own `kind` in its own
 * module; there is no shared catch-all `plugin` kind" — dsh-llm message.d.ts),
 * so this module merges its own kind and stamps `form: 'notice'` + the bound
 * summary exactly like the host's own model-switch notice
 * (`core/agent/src/model-selection.ts`). User-role messages carry any
 * producer's kind, consumers fall through unknown kinds, and the V4 format
 * edge retains every direct source kind verbatim — a bespoke kind writes and
 * survives every frozen edge. NO custom session event type, NO `ignorable`
 * marker — a mount-only plugin cannot publish either (`.mstar/projects/
 * _default/references/subagent-role-badge-visible/explore-role-seam-report.md`
 * §Q3). The guard test in `tests/role-notice.spec.ts` pins the exact literal.
 * Pre-upgrade durable rows (`kind: 'plugin', plugin: 'dsh-llm-fallbacks'`)
 * migrate to `kind: 'plugin:dsh-llm-fallbacks'` at the V3→V4 edge; the role
 * projection accepts that legacy form alongside this kind (see
 * {@link ROLE_NOTICE_LEGACY_SOURCE_KINDS}).
 *
 * Once per child SESSION: the emitter consumes the seam's per-child record
 * marker (`firstNoticePending`) AND a per-agent `emitted` set (mirroring the
 * existing `dispatchInjected` pattern), both written only AFTER the row is built
 * — so a throwing producer degrades without consuming the child's one notice.
 * Never for a root agent, never for `inherit`/unresolved (those never get a
 * record), never twice across steps or within-step retries.
 *
 * CF-6 — the emitted marker is SESSION-stable and bounded. `Agent.id` IS the
 * child session id, and a continuable child's durable session outlives its
 * activation, so the caller (`src/index.ts`) keeps this marker across
 * `agent/disposed` and clears it only when the plugin itself is disposed; that
 * is what makes the documented "exactly one notice row per child session" hold
 * across a dispose + re-activate resume. Because it is never per-activation
 * cleared it must be bounded: {@link markNoticeEmitted} evicts the oldest entry
 * once {@link NOTICE_EMITTED_LIMIT} sessions are remembered (a child evicted
 * that way can at worst be announced a second time, and the projection fold is
 * last-wins, so no wrong role is ever produced).
 *
 * Degrade-never-crash: any throw in the path is contained with ONE debug line
 * and the decision is returned UNCHANGED — a step is never broken, and no
 * partial row is ever published.
 *
 * @module dsh-llm-fallbacks/role-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SubagentSeamRecord } from './subagents-seam.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'llm-fallbacks-role-notice': { kind: 'llm-fallbacks-role-notice' } & ContextFormed
  }
}

/**
 * The provenance label this plugin's notice rows carried under the pre-0.1.7
 * `kind: 'plugin'` source API. The durable rows survive as data: the V3→V4
 * session-format edge rewrites every unlisted V3 plugin source to
 * `kind: 'plugin:<plugin>'`, so pre-upgrade child sessions carry
 * `plugin:dsh-llm-fallbacks` rows — {@link ROLE_NOTICE_LEGACY_SOURCE_KINDS}
 * and the role projection gate on this constant to keep badge continuity
 * across the upgrade.
 */
export const ROLE_NOTICE_PLUGIN = 'dsh-llm-fallbacks'

/**
 * The message source KIND the notice rides. 0.1.7-rc.1 removed the shared
 * `plugin` kind (`MessageSourceMap` is producer-declared now — each producer
 * declares its own `kind` in its own module, the upstream `model-selection`
 * precedent), so this module declares `llm-fallbacks-role-notice` above and
 * the emitter stamps it with `form: 'notice'` + the bound summary exactly like
 * the host's own model-switch notice. The value is exported so the guard test
 * asserts on the exact literal the emitter uses.
 */
export const ROLE_NOTICE_SOURCE_KIND = 'llm-fallbacks-role-notice'

/**
 * The source kinds the role projection must ALSO accept besides
 * {@link ROLE_NOTICE_SOURCE_KIND}: the V4-migrated form of the pre-0.1.7
 * `kind: 'plugin', plugin: 'dsh-llm-fallbacks'` rows (see
 * {@link ROLE_NOTICE_PLUGIN}).
 */
export const ROLE_NOTICE_LEGACY_SOURCE_KINDS = [`plugin:${ROLE_NOTICE_PLUGIN}`] as const

/** Suffix appended when the role declares a persona that was NOT delivered. */
export const ROLE_NOTICE_PERSONA_SKIPPED_SUFFIX = ' (persona not applied)'

/**
 * How many child sessions whose notice was already emitted stay remembered
 * (CF-6). The marker is session-stable — kept across `agent/disposed` so a
 * re-activated continuable child is not announced twice — so it needs a bound:
 * past this many sessions the oldest entry is evicted (worst case: a later
 * re-activation of that evicted child writes a second identical row; the
 * projection fold is last-wins, so the pill never names a wrong role).
 */
export const NOTICE_EMITTED_LIMIT = 256

/**
 * Mark one child session as announced, evicting the oldest remembered session
 * once {@link NOTICE_EMITTED_LIMIT} is reached (insertion-ordered `Set`
 * semantics: the oldest entry is the first value). A session already marked
 * keeps its position — its marker is only ever written once.
 */
export function markNoticeEmitted(emitted: Set<string>, childSessionId: string): void {
  if (!emitted.has(childSessionId) && emitted.size >= NOTICE_EMITTED_LIMIT) {
    const oldest = emitted.values().next().value
    if (oldest !== undefined) emitted.delete(oldest)
  }
  emitted.add(childSessionId)
}

/** One notice-message producer: role id + whether the declared persona was skipped. */
export type RoleNoticeBuilder = (role: string, personaNotApplied: boolean) => UserMessage

/**
 * Build the ONE role notice row (pure): `[role: <id>]`, with
 * ` (persona not applied)` appended when the role declares a persona that Task
 * 2's capability gate declined to deliver. The summary keeps `role: <id>` either
 * way — it is the collapsed row's one-line account, and the durable role string
 * must live there as well as in the content.
 *
 * @param role - the DECLARED RAW role id resolved at the dispatch seam.
 * @param personaNotApplied - `true` only when a declared persona was skipped.
 */
export function buildRoleNotice(role: string, personaNotApplied: boolean): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text' as const,
      text: personaNotApplied ? `[role: ${role}]${ROLE_NOTICE_PERSONA_SKIPPED_SUFFIX}` : `[role: ${role}]`,
    }],
    source: {
      kind: ROLE_NOTICE_SOURCE_KIND,
      form: 'notice' as const,
      // `summary` is caller text (the role id comes from plugin settings), so it
      // rides the same bound the first-party notice producer uses.
      summary: boundContextSummary(`role: ${role}`),
    },
  })
}

/** Options for {@link installRoleNotice}. */
export interface RoleNoticeOptions {
  /**
   * The dispatch seam's per-child records, keyed by child SESSION id (which IS
   * `Agent.id`). Read at each pre-step — never captured — so a record written by
   * a dispatch that races the child's first step is still seen.
   */
  records: Map<string, SubagentSeamRecord>
  /**
   * Per-agent marker of children whose notice was already emitted (mirrors the
   * runtime's `dispatchInjected`): the in-memory half of the once-per-child
   * guarantee, independent of the record's `firstNoticePending` (which a record
   * rewrite preserves deliberately) and of the loop's retry bookkeeping.
   *
   * SESSION-stable and bounded (CF-6): the caller keeps it across
   * `agent/disposed` so a re-activated child is never announced twice, and
   * {@link markNoticeEmitted} bounds it. ROOT-shared across the fibers applied
   * over one root (CF-5), so a second fiber's emitter cannot announce a child
   * the first already announced.
   */
  emitted: Set<string>
  /**
   * Message producer. Defaults to {@link buildRoleNotice}; the only reason to
   * replace it is to pin the contained-degrade path (a throwing producer must
   * publish no row and must NOT consume the child's one notice).
   */
  buildNotice?: RoleNoticeBuilder
  /** Contained debug sink (at most ONE line per contained degrade). */
  debug?: (message: string) => void
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the `agent/pre-step` notice emitter on `ctx`; returns its disposer
 * (the owning fiber's teardown registers it, exactly like the seam's other
 * listeners).
 *
 * Emission order per pre-step (cheapest first, all read-only until the emit):
 * `next()` → reject/abort → empty decision → `origin === 'subagent'` → already
 * emitted → pending record. The empty-decision guard is NOT cosmetic: the loop
 * skips a step whose admitted messages are empty (`phase.step === 0 &&
 * decision.messages.length === 0` → turn completed, no model call), so a notice
 * pushed into an empty decision would turn a no-op step into a model call whose
 * only input is our row.
 */
export function installRoleNotice(ctx: Context, options: RoleNoticeOptions): () => void {
  const buildNotice = options.buildNotice ?? buildRoleNotice
  const debug = (message: string): void => {
    try {
      options.debug?.(message)
    } catch {
      // Never-throws invariant: a throwing sink must not escape the listener.
    }
  }

  return ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      const decision = await next()
      try {
        if (decision.kind === 'reject' || signal.aborted) return decision
        if (decision.messages.length === 0) return decision
        if (agent.session?.header?.origin !== 'subagent') return decision
        if (options.emitted.has(agent.id)) return decision
        const record = options.records.get(agent.id)
        if (record === undefined || !record.firstNoticePending) return decision
        // Build FIRST: a throwing producer must reach the contained path with
        // the marker untouched, so the child can still be announced later.
        const notice = buildNotice(record.role, record.personaNotApplied === true)
        // Publish (in-memory) only after the row exists. `agent/pre-step` runs
        // once per step and the loop reuses the decision across a step's
        // retries, so the durable append stays single; these two markers are
        // what keep a LATER step — and, for `emitted`, a later ACTIVATION of the
        // same child session (CF-6) — from announcing the same child again.
        markNoticeEmitted(options.emitted, agent.id)
        record.firstNoticePending = false
        return { ...decision, messages: [...decision.messages, notice] }
      } catch (error) {
        debug(
          `llm-fallbacks: role notice for agent "${agent.id}" skipped (contained, the step is unchanged): ${errorMessage(error)}`,
        )
        return decision
      }
    },
    { prepend: true },
  )
}
