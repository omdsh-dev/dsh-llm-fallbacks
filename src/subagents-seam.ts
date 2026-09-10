/**
 * Dispatch-seam role resolution + per-child record (plan
 * role-based-subagent-adoption Task 1).
 *
 * The seam is the documented cordis service-read waterfall
 * (`Events['internal/get']`, `@deepseek-ai/cordis` 4.0.2
 * `lib/types/events.d.ts`): a listener wraps the `subagents` service VALUE on
 * read and returns a prototype-delegating wrapper whose `start` /
 * `startContinuable` resolve the dispatch role from the incoming request
 * BEFORE delegating. The real service object is never mutated; readers of the
 * `subagents` service transparently receive the wrapper.
 *
 * Role source (plan Global Constraints): the child request's prompt carries
 * the Assignment header field `**Execute as**: <id>` — dsh role binding is
 * prompt-only. {@link resolveDeclaredRoleFromAssignment} is the ONE pure
 * resolution point (header region only, so a body-quoted field line cannot
 * shape a resolution); it canonicalizes exactly like the existing trimmed-id
 * map (trim, drop ONE leading `@`, case-insensitive match against the
 * declared trimmed ids) and returns the DECLARED RAW id. Undeclared, absent,
 * `inherit`, or ambiguous declarations resolve to `undefined` = no role.
 *
 * Per-child record: the wrapped start's RESULT carries the child session id —
 * `start` resolves to a `SubagentRun` (`id` IS the published child session id
 * for a local run) and `startContinuable` to a `ContinuableStart` (`childId`).
 * The record `{ role, at, firstNoticePending }` is keyed by that id (Task 3
 * reads it to emit the one role notice row). A result carrying only a
 * `jobId` — a registry job id, NOT a session id — is never keyed: the child is
 * correlated instead through the parent-owned `subagent/catalog` session event
 * `{ childId, label }` joined on the delegating parent + request label.
 *
 * Persona delivery (plan Task 2): the SAME single resolution point merges the
 * declared role's `roles.list[].persona` (trimmed, non-empty) into the
 * request's NATIVE `persona` slot — the slot the runtime composes as the
 * scoped `deployment:persona-prefix` system-prompt section on the child. The
 * source is the RESOLVED ROLE only, so delivery is chain-independent: a
 * `chain: []` role gets its persona exactly like a chained one (no routing
 * state is read). Both native start surfaces are covered, with the gate each
 * one's fail-loud contract needs (measured on the installed
 * `@deepseek-ai/dsh-subagent` `0.1.5-rc.1`): the one-shot `start` REJECTS a
 * request carrying `persona` for a provider whose
 * `getProvider(name).capabilities.persona` is not `true` (`lib/index.js:3202-3227`,
 * `assertCapabilities`), so the merge pre-checks that flag; the continuable
 * surface is composed by the continuation manager, which applies
 * `request.persona` unconditionally (`lib/index.js:1703-1705`) and is gated by
 * the provider's `prepareContinuable` presence instead (`lib/index.js:3179-3183`).
 * A gate miss skips the persona with ONE contained debug log — never a failed
 * start. An explicit caller `persona` WINS (the slot is filled only when it is
 * absent), and every skip path returns the caller's OWN request object, so the
 * native call stays byte-identical.
 *
 * In-session notice row (plan Task 3): the SAME install point registers the
 * `agent/pre-step` emitter (`./role-notice.ts`) over the record map it owns, so
 * the role is announced once in the child's own session. Its per-agent
 * `noticeEmitted` marker is exposed here for the caller's cleanup sites
 * (`agent/disposed` + plugin dispose, exactly like the record map).
 *
 * Durable role visibility (plan Task 3b): the SAME install point registers the
 * host-side session projection unit (`./role-projection.ts`) that folds that
 * notice row out of the child's own log, so the session-header badge can show
 * the role for a settled child and after a host restart — a read of the SAME
 * single write primitive, never a second one.
 *
 * Degrade-never-crash: an absent/reshaped service, an unexpected result
 * shape, or any throwing bookkeeping degrades to the native path with at most
 * ONE contained debug log — a dispatch is never affected.
 *
 * @module dsh-llm-fallbacks/subagents-seam
 */

import type { Context } from '@deepseek-ai/cordis'
import { INHERIT_ROLE_ID, type FallbacksRole } from './config.ts'
import { installRoleNotice } from './role-notice.ts'
import { installRoleProjection } from './role-projection.ts'

/**
 * The cordis service-read waterfall event the seam registers on. Referenced
 * ONCE (registration) so a future cordis rename is a one-line change here.
 */
export const SUBAGENT_SEAM_EVENT = 'internal/get'

/** The service name the seam wraps (`ctx.subagents`). */
export const SUBAGENT_SEAM_SERVICE = 'subagents'

/** The parent-owned catalog event carrying an established child's session id. */
const SUBAGENT_CATALOG_EVENT = 'subagent/catalog'

/**
 * Assignment body markers — the header region ends at the FIRST of a
 * `# Task`-style heading (any level), a `---` separator, or a single-`#`
 * heading (the `mstar` Assignment grammar, mirrored pure so this plugin needs
 * no engine dependency). A field line quoted in the task body AFTER a marker
 * must not shape the resolution.
 */
const ASSIGNMENT_BODY_START_RE = /^(?:#{1,6}[ \t]+Task\b|-{3,}[ \t]*$|#[ \t])/m

/** Assignment header field, bold form: `**Execute as**: <id>` (optional bullet). */
const EXECUTE_AS_BOLD_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\*\*\s*Execute as\s*\*\*\s*:\s*(.*)$/

/** Assignment header field, plain form: `Execute as: <id>` (optional bullet). */
const EXECUTE_AS_PLAIN_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?Execute as\s*:\s*(.*)$/

/**
 * One dispatch-resolved per-child record (Task 3 reads it to emit exactly one
 * role notice row per child session).
 */
export interface SubagentSeamRecord {
  /** The DECLARED RAW role id resolved at the dispatch seam. */
  role: string
  /** When the record was written (epoch ms). */
  at: number
  /**
   * `true` until the child's role notice row has been emitted (Task 3). A
   * later write for the SAME child session preserves an already-cleared
   * marker, so a repeat dispatch/resume cannot produce a second notice row.
   */
  firstNoticePending: boolean
  /**
   * `true` when the role DECLARES a persona and that persona was NOT delivered
   * (Task 2's capability gate declined it, or no provider was registered to
   * carry it). Absent when there was nothing to report: the persona was
   * delivered, the caller set one (explicit intent wins), the role declares
   * none, or no persona source is wired. Task 3 appends
   * ` (persona not applied)` on `true` only.
   *
   * STICKY (Task 3 review Minor 4): a record rewrite (a `startContinuable`
   * resume re-keys the child) can only ADD this verdict, never clear it. A
   * resume recomputes the merge outcome on its own surface — and that surface
   * legitimately returns `false` when it delivers the CALLER's persona or when
   * its own merge degrades — but neither retroactively installs the role's
   * DECLARED persona on the dispatch that already reported it missing. The
   * child's one notice row is a claim about that dispatch, so the first `true`
   * survives; a later `false` is simply not recorded.
   */
  personaNotApplied?: boolean
}

/** One consumed prompt content block (`@deepseek-ai/dsh-llm` `ContentBlock` text members). */
export interface SubagentPromptBlockView {
  readonly type: string
  readonly text?: string
}

/**
 * Structural view of the one-shot start request (consumed fields only): the
 * `prompt` is the role-extraction source, `label` + `parent` are the
 * catalog-correlation join key, and `persona` is the NATIVE per-child persona
 * slot the role persona is merged into (plan Global Constraints: an explicit
 * caller value wins). The wrapper forwards the request object itself, so every
 * other field reaches the service unchanged.
 */
export interface SubagentStartRequestView {
  readonly prompt?: readonly SubagentPromptBlockView[]
  readonly label?: string
  readonly parent?: { readonly session?: { readonly id?: string } }
  readonly persona?: string
}

/**
 * Structural view of the continuable start spec (consumed fields only):
 * `childId` is the caller-reserved identity a resume already carries, used as
 * the record fallback when the resume request has no Assignment header.
 */
export interface ContinuableStartSpecView {
  readonly provider: string
  readonly label?: string
  readonly childId?: string
  readonly request: SubagentStartRequestView
}

/**
 * Structural view of ONE registered provider's consumed surface
 * (`@deepseek-ai/dsh-subagent` `SubagentProvider`): `capabilities.persona` is
 * the ONE-SHOT capability flag `SubagentRuntime.assertCapabilities` enforces
 * (a request carrying a persona for a provider without it is REJECTED), while
 * `prepareContinuable` is the NATIVE continuable gate — method presence IS the
 * continuable capability (upstream: `SubagentCapabilities` describes the
 * ONE-SHOT path only).
 */
interface SubagentProviderView {
  readonly capabilities?: { readonly persona?: boolean }
  readonly prepareContinuable?: unknown
}

/**
 * Structural view of the `subagents` runtime the wrapper delegates to
 * (consumed surface only; start results are opaque and forwarded untouched).
 */
interface SubagentsServiceView {
  start(name: string, request: SubagentStartRequestView): unknown
  startContinuable?(spec: ContinuableStartSpecView): unknown
  /** Provider lookup — the persona-capability gate read (absent on a reshaped runtime). */
  getProvider?(name: string): SubagentProviderView | undefined
}

/** One start surface the persona merge runs on (the gate differs per surface). */
type PersonaSurface = 'one-shot' | 'continuable'

/** Options for {@link installSubagentSeam}. */
export interface SubagentSeamOptions {
  /**
   * Live declared-role id map (trimmed id → DECLARED RAW id), read per start
   * so a settings change is observed without a re-install.
   */
  roleIds: () => ReadonlyMap<string, string>
  /**
   * Live declared roles (`roles.list`) — the persona source, read per start so
   * a settings/persona edit is observed without a re-install. Absent ⇒ the
   * seam only records roles (no persona delivery).
   */
  roles?: () => readonly FallbacksRole[]
  /** Contained debug sink (at most one line per contained degrade). */
  debug?: (message: string) => void
}

/** The installed seam (Task 3 surface + explicit teardown). */
export interface SubagentSeam {
  /**
   * Per-child records keyed by the child SESSION id (the wrapped start's
   * result id). Mutable by design: Task 3 clears `firstNoticePending` after
   * emitting the notice.
   */
  readonly records: Map<string, SubagentSeamRecord>
  /**
   * Per-agent marker of children whose role notice row was already emitted
   * (mirrors the runtime's `dispatchInjected`): the in-memory half of Task 3's
   * once-per-child guarantee, cleared with `records` on `agent/disposed` and in
   * the plugin dispose effect.
   */
  readonly noticeEmitted: Set<string>
  /** Stop intercepting service reads (the owning fiber's teardown also does). */
  dispose(): void
}

/** One label-keyed correlation claim for a start whose result carried no session id. */
interface PendingCorrelation {
  role: string
  at: number
  personaNotApplied: boolean
}

/**
 * Outcome of one persona decision: the request to forward (`request` ITSELF on
 * every skip path, so the native call stays byte-identical) plus whether a
 * DECLARED persona was left undelivered — the one bit Task 3's notice row needs
 * to say ` (persona not applied)`.
 */
interface PersonaMergeOutcome {
  readonly request: SubagentStartRequestView
  readonly personaNotApplied: boolean
}

/**
 * Cap on un-correlated claims (a `jobId`-only result whose catalog event never
 * arrives). Bounded insertion-order eviction keeps the claim map small.
 */
const PENDING_CORRELATION_LIMIT = 64

/**
 * Slice an Assignment's header region — the text before the first body marker
 * (see {@link ASSIGNMENT_BODY_START_RE}); returns the full text when no marker
 * is present.
 */
function assignmentHeaderRegion(prompt: string): string {
  const marker = prompt.match(ASSIGNMENT_BODY_START_RE)
  return marker !== null && marker.index !== undefined ? prompt.slice(0, marker.index) : prompt
}

/** Every `**Execute as**: <id>` value in the header region, in line order (bold form first). */
function declaredExecuteAsValues(prompt: string): string[] {
  const values: string[] = []
  for (const line of assignmentHeaderRegion(prompt).split(/\r?\n/)) {
    const match = line.match(EXECUTE_AS_BOLD_LINE_RE) ?? line.match(EXECUTE_AS_PLAIN_LINE_RE)
    if (match !== null && match[1] !== undefined) values.push(match[1].trim())
  }
  return values
}

/**
 * Canonicalize one declared Execute-as value: trim, drop ONE leading `@`.
 * Returns `undefined` for an empty value or the reserved `inherit`.
 */
function canonicalizeRoleReference(raw: string): string | undefined {
  const trimmed = raw.trim()
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  const id = withoutAt.trim()
  if (id === '' || id === INHERIT_ROLE_ID) return undefined
  return id
}

/**
 * Look one canonicalized id up in the declared trimmed-id map — exact match
 * first (the existing map's semantics), then case-insensitively. Returns the
 * DECLARED RAW id. Two declared ids differing only in case: the first map
 * entry wins (insertion order).
 */
function lookupDeclaredRole(id: string, roleIds: ReadonlyMap<string, string>): string | undefined {
  const direct = roleIds.get(id)
  if (direct !== undefined) return direct
  const lower = id.toLowerCase()
  for (const [trimmedId, declared] of roleIds) {
    if (trimmedId.toLowerCase() === lower) return declared
  }
  return undefined
}

/**
 * PURE dispatch-role resolution (plan Global Constraints): read the Assignment
 * header field `**Execute as**: <id>` from `prompt` and return the DECLARED
 * RAW role id, or `undefined` when nothing resolves. Never throws.
 *
 * - absent / empty / body-quoted-only → `undefined`
 * - `inherit` (the reserved "no specific role" id) → `undefined`
 * - undeclared id → `undefined` (never invent a role)
 * - several DISTINCT declared ids in the header region → `undefined`
 *   (ambiguous); repeats of the same declared id (e.g. `coder` and `@CODER`)
 *   still resolve
 *
 * @param prompt - the Assignment text carried by the child request's prompt.
 * @param roleIds - the declared trimmed-id map (`trimmed id → declared raw id`).
 */
export function resolveDeclaredRoleFromAssignment(
  prompt: string,
  roleIds: ReadonlyMap<string, string>,
): string | undefined {
  const declared = new Set<string>()
  for (const raw of declaredExecuteAsValues(prompt)) {
    const id = canonicalizeRoleReference(raw)
    if (id === undefined) continue
    const resolved = lookupDeclaredRole(id, roleIds)
    if (resolved !== undefined) declared.add(resolved)
  }
  if (declared.size !== 1) return undefined
  return declared.values().next().value
}

/** Project a request's prompt content blocks to the text the Assignment arrives in. */
function promptTextOf(blocks: readonly SubagentPromptBlockView[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/**
 * PURE, chain-independent persona lookup (plan Task 2 / Global Constraints):
 * the DECLARED `persona` of `roleId`, trimmed, and only when it is still
 * non-empty after the trim — a blank persona is NO persona. `roleId` is the
 * DECLARED RAW id the seam already resolved, so this is an exact id match, not
 * a second canonicalization pass.
 *
 * Only `id` and `persona` are read: no `chain`, no `rootChain`, no routing
 * state — a `chain: []` role's persona resolves exactly like a chained one's.
 *
 * @param roles - the live declared roles (`roles.list`).
 * @param roleId - the DECLARED RAW role id resolved at the seam.
 */
export function personaForRole(roles: readonly FallbacksRole[], roleId: string): string | undefined {
  for (const role of roles) {
    if (role.id !== roleId) continue
    const persona = role.persona?.trim() ?? ''
    return persona === '' ? undefined : persona
  }
  return undefined
}

/**
 * The child session id carried by a start result, or `undefined`.
 *
 * Covers the wrapped-runtime shapes (`SubagentRun.id`,
 * `ContinuableStart.childId`) AND the tool-result vocabulary
 * (`{ kind: 'continuable', subagentId }`, `{ kind: 'foreground', runId }`).
 * A `{ kind: 'background', jobId }` result deliberately yields `undefined`:
 * a job id is a registry id, never a session id.
 */
function childSessionIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const value = result as Record<string, unknown>
  for (const key of ['subagentId', 'runId', 'childId', 'id'] as const) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** The delegating parent's session id (`request.parent.session.id`), or `undefined`. */
function parentSessionIdOf(request: SubagentStartRequestView | undefined): string | undefined {
  const id = request?.parent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The label-keyed correlation claim key (parent session + request label). */
function correlationKey(parentSessionId: string, label: string): string {
  return `${parentSessionId}\u0000${label}`
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Per-apply installed seams, keyed by context. Weak so entries die with the
 * context. @internal
 */
const subagentSeamStores = new WeakMap<Context, SubagentSeam>()

/**
 * Context ROOTS that already carry an installed seam. The `internal/get`
 * service-read waterfall is root-scoped and global, so a multi-fiber
 * composition (this plugin applied once per fiber over one root) must not
 * install a second listener set: that would only nest wrappers and multiply
 * the contained debug lines ("ONE per apply"). The first installer owns the
 * seam; {@link installSubagentSeam} refuses a duplicate and `src/index.ts`
 * turns that refusal into a fiber-local no-op seam (the service / gateway /
 * typert dedupe pattern).
 */
const subagentSeamRoots = new WeakSet<Context>()

/**
 * @internal Test seam (mirrors `chainHeads`): the seam installed on
 * `ctx`, if any. Not part of the plugin's public surface — lets tests read and
 * seed the per-child record map without reaching into the installation
 * closure. `undefined` when no seam is installed.
 */
export function subagentSeamOf(ctx: Context): SubagentSeam | undefined {
  return subagentSeamStores.get(ctx)
}

/**
 * Install the dispatch seam on `ctx`: wrap every `subagents` service read and
 * resolve + record the dispatch role per start.
 *
 * Throws when `ctx`'s ROOT already carries a seam (multi-fiber apply): the
 * caller's dedupe guard degrades instead of nesting a second listener set. The
 * root claim is released by {@link SubagentSeam.dispose}, so a later apply over
 * the same root can install again.
 *
 * Returns the seam (the record map Task 3 reads, plus an idempotent
 * `dispose`). The `internal/get` listener is owned by this module; callers
 * that rely on the fiber teardown alone may ignore `dispose`.
 */
export function installSubagentSeam(ctx: Context, options: SubagentSeamOptions): SubagentSeam {
  const root = ctx.root
  if (subagentSeamRoots.has(root)) {
    throw new Error(`the '${SUBAGENT_SEAM_SERVICE}' role seam is already installed on this context root`)
  }
  const records = new Map<string, SubagentSeamRecord>()
  /**
   * Task 3's per-agent once-marker (mirrors the runtime's `dispatchInjected`):
   * the in-memory half of the once-per-child guarantee. The caller clears it on
   * `agent/disposed` and in the plugin dispose effect, next to `records`.
   */
  const noticeEmitted = new Set<string>()
  const pending = new Map<string, PendingCorrelation>()
  const wrappers = new WeakMap<object, object>()
  const disposers: Array<() => void> = []
  /** One debug per apply for a service read that is absent/not start-capable. */
  let unreadableServiceLogged = false
  /** One debug per apply for a dispatch prompt that declares no resolvable role. */
  let noRoleLogged = false

  const debug = (message: string): void => {
    try {
      options.debug?.(message)
    } catch {
      // Never-throws invariant: a throwing sink must not escape the seam.
    }
  }

  const reportDegrade = (error: unknown): void => {
    debug(`llm-fallbacks: subagent role seam degraded to the native path (start unaffected): ${errorMessage(error)}`)
  }

  /** Write one per-child record; a repeat write for the same child keeps a cleared notice marker. */
  const recordChild = (
    childSessionId: string,
    role: string,
    at: number,
    personaNotApplied: boolean,
  ): void => {
    const existing = records.get(childSessionId)
    records.set(childSessionId, {
      role,
      at,
      firstNoticePending: existing?.firstNoticePending ?? true,
      // Absent (never `false`) when there is nothing to report, so the field
      // reads as "a declared persona was skipped" and nothing else. Sticky:
      // once a rewrite reported the declared persona undelivered, a later
      // surface's `false` cannot clear it (see `SubagentSeamRecord`).
      ...(personaNotApplied || existing?.personaNotApplied === true ? { personaNotApplied: true } : {}),
    })
  }

  /** Claim the label-keyed catalog correlation for a resolved start (bounded, insertion-order eviction). */
  const beginCorrelation = (
    request: SubagentStartRequestView | undefined,
    role: string,
    personaNotApplied: boolean,
  ): string | undefined => {
    const parentSessionId = parentSessionIdOf(request)
    const label = typeof request?.label === 'string' ? request.label : undefined
    if (parentSessionId === undefined || label === undefined || label === '') return undefined
    const key = correlationKey(parentSessionId, label)
    if (!pending.has(key) && pending.size >= PENDING_CORRELATION_LIMIT) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    // The persona verdict is decided BEFORE the child id exists, so it rides the
    // claim: the catalog-correlated record reports it exactly like a direct one.
    pending.set(key, { role, at: Date.now(), personaNotApplied })
    return key
  }

  const endCorrelation = (key: string | undefined): void => {
    if (key !== undefined) pending.delete(key)
  }

  /** Resolve the dispatch role from one request's prompt; contained, never throws. */
  const resolveRoleAtSeam = (request: SubagentStartRequestView | undefined): string | undefined => {
    try {
      const prompt = promptTextOf(request?.prompt)
      if (prompt.trim() === '') return undefined
      const role = resolveDeclaredRoleFromAssignment(prompt, options.roleIds())
      // Plan Global Constraints: ABSENT or UNDECLARED ⇒ no-op with at most ONE
      // debug log. Latched per apply so the no-op is distinguishable from "the
      // seam never intercepted" (the QA live check) without flooding on every
      // role-less dispatch. The `#[ \t]` header boundary above stays at engine
      // parity — a `#`-led prompt is exactly this no-role outcome.
      if (role === undefined && !noRoleLogged) {
        noRoleLogged = true
        debug(
          `llm-fallbacks: subagent role seam — no role resolved from the Assignment prompt (absent or undeclared '**Execute as**: <id>'); the dispatch is unchanged`,
        )
      }
      return role
    } catch (error) {
      reportDegrade(error)
      return undefined
    }
  }

  /**
   * Observe one start result WITHOUT altering it: a thenable is watched
   * (rejection is a no-result path, never an unhandled rejection); a plain
   * value is inspected directly. `onNoChildId` (resolved, but the result
   * carries no session id) and `onRejected` (the start failed) are DISTINCT:
   * only the former may keep a catalog-correlation claim open.
   */
  const observeStartResult = (
    result: unknown,
    onChildId: (childSessionId: string) => void,
    onNoChildId: () => void,
    onRejected: () => void,
  ): void => {
    const onValue = (value: unknown): void => {
      try {
        const childSessionId = childSessionIdOf(value)
        if (childSessionId === undefined) onNoChildId()
        else onChildId(childSessionId)
      } catch (error) {
        reportDegrade(error)
      }
    }
    if (typeof result === 'object' && result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
      void (result as PromiseLike<unknown>).then(
        onValue,
        () => {
          try {
            onRejected()
          } catch (error) {
            reportDegrade(error)
          }
        },
      )
      return
    }
    onValue(result)
  }

  /**
   * The persona-capability gate verdict for one surface (plan Global
   * Constraints: merge ONLY when the target provider advertises the persona
   * capability). `'unknown'` (no provider registered) does not shadow the
   * native contract — the start still runs and fails loud its own way
   * (`NO_PROVIDER`) — but the declared persona IS undelivered, so it is
   * reported like every other skip (plan Errata: ONE debug line per skip reason,
   * naming the surface; QA's live discrimination depends on those signals).
   * `'unavailable'` (a reshaped runtime without `getProvider`) cannot verify the
   * capability, so the persona is skipped.
   */
  const personaGate = (
    service: SubagentsServiceView,
    providerName: string,
    surface: PersonaSurface,
  ): 'ok' | 'unknown' | 'unavailable' | 'unsupported' => {
    if (typeof service.getProvider !== 'function') return 'unavailable'
    const provider = service.getProvider(providerName)
    if (provider === undefined) return 'unknown'
    // One-shot: the flag the runtime's `assertCapabilities` enforces (a persona
    // request for a provider without it is REJECTED, never ignored).
    if (surface === 'one-shot') return provider.capabilities?.persona === true ? 'ok' : 'unsupported'
    // Continuable: the manager composes the child itself and applies
    // `request.persona` unconditionally — method presence IS the gate.
    return typeof provider.prepareContinuable === 'function' ? 'ok' : 'unsupported'
  }

  /**
   * Merge the declared role persona into the request's NATIVE `persona` slot,
   * or return `request` ITSELF (same object) on every skip path — a skip leaves
   * the native call byte-identical. Order (plan Global Constraints):
   *
   * 1. an explicit caller `persona` WINS (`tool-subagent` `Config.persona`, or
   *    `@mstar-harness/dsh`'s own merge): the slot is filled only when absent —
   *    silent, caller intent is not a skip (`personaNotApplied: false`: the
   *    persona IS applied, just not by us).
   * 2. no persona source wired → nothing to deliver, and the declaration cannot
   *    even be read (silent, `false`).
   * 3. the role declares no persona (or a blank one) → nothing to deliver
   *    (silent, `false`).
   * 4. provider unknown → ONE contained debug log naming the surface (the
   *    native start fails loud its own way, so the request is untouched), and
   *    the declared persona really is undelivered → `true`.
   * 5. gate miss (capability absent / unverifiable) → ONE contained debug log,
   *    request unchanged — merging what the runtime would reject is never
   *    acceptable → `true`.
   * 6. hit → a shallow copy carrying the persona (the caller's object is never
   *    mutated) + ONE debug log naming the role, the provider, and the surface
   *    → `false`.
   *
   * Task 3's notice row is the only consumer of `personaNotApplied`.
   */
  const withRolePersona = (
    service: SubagentsServiceView,
    providerName: string,
    request: SubagentStartRequestView,
    role: string,
    surface: PersonaSurface,
  ): PersonaMergeOutcome => {
    if (request.persona !== undefined) return { request, personaNotApplied: false }
    const readRoles = options.roles
    if (readRoles === undefined) return { request, personaNotApplied: false }
    const persona = personaForRole(readRoles(), role)
    if (persona === undefined) return { request, personaNotApplied: false }
    const gate = personaGate(service, providerName, surface)
    if (gate === 'unknown') {
      debug(
        `llm-fallbacks: no subagent provider '${providerName}' is registered on the ${surface} start — role persona for '${role}' not delivered (the native start fails loud its own way)`,
      )
      return { request, personaNotApplied: true }
    }
    if (gate === 'unavailable') {
      debug(
        `llm-fallbacks: role persona for '${role}' skipped on the ${surface} start — the '${SUBAGENT_SEAM_SERVICE}' runtime exposes no provider lookup, so the persona capability cannot be verified (the start proceeds unchanged)`,
      )
      return { request, personaNotApplied: true }
    }
    if (gate === 'unsupported') {
      debug(
        surface === 'one-shot'
          ? `llm-fallbacks: subagent provider '${providerName}' lacks the persona capability on the ${surface} start — role persona for '${role}' skipped (the start proceeds unchanged)`
          : `llm-fallbacks: subagent provider '${providerName}' does not support continuable children on the ${surface} surface — role persona for '${role}' skipped (the native continuable start fails loud its own way)`,
      )
      return { request, personaNotApplied: true }
    }
    debug(
      `llm-fallbacks: role persona delivered via the native subagent persona channel for role '${role}' (${surface} start on provider '${providerName}')`,
    )
    return { request: { ...request, persona }, personaNotApplied: false }
  }

  /**
   * Contained wrapper around {@link withRolePersona}: a throwing live persona
   * source / provider read degrades to the CALLER's request object with no
   * persona verdict — the merge aborts, the start is never affected.
   */
  const mergePersonaAtSeam = (
    service: SubagentsServiceView,
    providerName: string,
    request: SubagentStartRequestView,
    role: string,
    surface: PersonaSurface,
  ): PersonaMergeOutcome => {
    try {
      return withRolePersona(service, providerName, request, role, surface)
    } catch (error) {
      reportDegrade(error)
      return { request, personaNotApplied: false }
    }
  }

  /** Wrap one `subagents` read value; non-services and absent values pass through. */
  const wrapService = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) {
      if (value === undefined && !unreadableServiceLogged) {
        unreadableServiceLogged = true
        debug(`llm-fallbacks: subagent role seam inactive — '${SUBAGENT_SEAM_SERVICE}' did not resolve a service on this read`)
      }
      return value
    }
    const service = value as SubagentsServiceView
    if (typeof service.start !== 'function') {
      if (!unreadableServiceLogged) {
        unreadableServiceLogged = true
        debug(`llm-fallbacks: subagent role seam skipped — '${SUBAGENT_SEAM_SERVICE}' is not a start-capable runtime`)
      }
      return value
    }
    const cached = wrappers.get(value)
    if (cached !== undefined) return cached
    const wrapper: SubagentsServiceView = Object.create(value)
    wrapper.start = (name: string, request: SubagentStartRequestView): unknown => {
      const role = resolveRoleAtSeam(request)
      // No declared role → the native path, byte-identical (same request object).
      if (role === undefined) return service.start(name, request)
      // Task 2 merge point: the ONE place the resolved role is available before
      // the request reaches the service (`role` above + `name` here is
      // everything the persona decision needs — no second resolution). A skip
      // returns the caller's OWN request object; a hit a shallow copy carrying
      // the persona. The verdict rides the record Task 3 reads.
      const persona = mergePersonaAtSeam(service, name, request, role, 'one-shot')
      let pendingKey: string | undefined
      try {
        pendingKey = beginCorrelation(request, role, persona.personaNotApplied)
      } catch (error) {
        reportDegrade(error)
      }
      let result: unknown
      try {
        result = service.start(name, persona.request)
      } catch (error) {
        endCorrelation(pendingKey)
        throw error
      }
      observeStartResult(
        result,
        (childSessionId) => {
          endCorrelation(pendingKey)
          recordChild(childSessionId, role, Date.now(), persona.personaNotApplied)
        },
        // No session id in the result (a job id is not one): keep the claim and
        // let the parent-owned `subagent/catalog` event supply the child id.
        () => {},
        // A rejected start created no child: drop the claim so it cannot be
        // consumed later by a same-label sibling's catalog event.
        () => endCorrelation(pendingKey),
      )
      return result
    }
    const startContinuable = service.startContinuable
    if (typeof startContinuable === 'function') {
      wrapper.startContinuable = (spec: ContinuableStartSpecView): unknown => {
        const role = resolveRoleAtSeam(spec?.request)
          // Resume fallback (plan Global Constraints): a resume request may
          // carry no Assignment header — reuse the record of the child the
          // caller already reserved, else no-op.
          ?? (typeof spec?.childId === 'string' ? records.get(spec.childId)?.role : undefined)
        if (role === undefined) return startContinuable.call(service, spec)
        // Task 2: the continuable surface merges into `spec.request` — the SAME
        // native persona slot (`ContinuableStartSpec.request` is a
        // `SubagentStartRequest`) — gated by the NATIVE continuable capability.
        // A skip leaves the caller's spec object untouched (same identity). The
        // containment is `mergePersonaAtSeam`'s, which both surfaces share, so a
        // throwing live persona source cannot escape on this path either.
        const outcome = mergePersonaAtSeam(service, spec.provider, spec.request, role, 'continuable')
        const effectiveSpec = outcome.request === spec.request ? spec : { ...spec, request: outcome.request }
        const result: unknown = startContinuable.call(service, effectiveSpec)
        observeStartResult(
          result,
          (childSessionId) => recordChild(childSessionId, role, Date.now(), outcome.personaNotApplied),
          () => {},
          () => {},
        )
        return result
      }
    }
    wrappers.set(value, wrapper)
    return wrapper
  }

  disposers.push(ctx.on(SUBAGENT_SEAM_EVENT, (_readCtx, name, _error, next) => {
    const value: unknown = next()
    if (name !== SUBAGENT_SEAM_SERVICE) return value
    try {
      return wrapService(value)
    } catch (error) {
      // Contained: an internal wrap error degrades to the raw service.
      reportDegrade(error)
      return value
    }
  }))

  // Background correlation fallback: the parent-owned catalog event carries
  // the child session id a `jobId`-only result never does. Join on the
  // delegating parent session + the request label (the catalog `label` IS the
  // delegation `description`). The join key is NOT unique: two children of one
  // parent dispatched concurrently under the SAME label share it, and the
  // first catalog event consumes whichever role was claimed last — so this
  // fallback can key a sibling's role in that corner (bounded: reachable only
  // when a `jobId`-only result reaches the seam; recorded as a residual).
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if ((event.type as string) !== SUBAGENT_CATALOG_EVENT) return
      const data = (event as unknown as { data?: { childId?: unknown; label?: unknown } }).data
      const childSessionId = data?.childId
      const label = data?.label
      if (typeof childSessionId !== 'string' || childSessionId === '') return
      if (typeof label !== 'string' || label === '') return
      const key = correlationKey(session.id, label)
      const claim = pending.get(key)
      if (claim === undefined) return
      pending.delete(key)
      recordChild(childSessionId, claim.role, claim.at, claim.personaNotApplied)
    } catch (error) {
      reportDegrade(error)
    }
  }))

  // Task 3: the once-per-child role notice row, emitted from the child's own
  // first `agent/pre-step` over the record map this seam owns. Registered here
  // because this is the ONE install point (the multi-fiber dedupe above leaves
  // only the first fiber's seam live, and only THAT seam holds records), so a
  // registration anywhere else would add listeners that can never announce
  // anything.
  disposers.push(installRoleNotice(ctx, { records, emitted: noticeEmitted, debug }))

  // Task 3b: the durable READ of that same row — one host session projection
  // unit folding the notice out of the child's own log, so the header badge
  // works for a settled child and after a host restart. Registered at this ONE
  // install point too (same multi-fiber dedupe: the projection is a pure log
  // read with no per-fiber state, and the host registry counts a shared key, so
  // a second fiber registering it would be harmless — but the seam is where the
  // plugin's Task 3 surface is installed, and the dedupe keeps one owner).
  disposers.push(installRoleProjection(ctx, { debug }))

  const seam: SubagentSeam = {
    records,
    noticeEmitted,
    dispose: () => {
      // Release the root claim so a later apply (fiber reload) can install.
      subagentSeamRoots.delete(root)
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  subagentSeamRoots.add(root)
  subagentSeamStores.set(ctx, seam)
  return seam
}
