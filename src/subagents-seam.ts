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
 * Degrade-never-crash: an absent/reshaped service, an unexpected result
 * shape, or any throwing bookkeeping degrades to the native path with at most
 * ONE contained debug log — a dispatch is never affected.
 *
 * @module dsh-llm-fallbacks/subagents-seam
 */

import type { Context } from '@deepseek-ai/cordis'
import { INHERIT_ROLE_ID } from './config.ts'

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
}

/** One consumed prompt content block (`@deepseek-ai/dsh-llm` `ContentBlock` text members). */
export interface SubagentPromptBlockView {
  readonly type: string
  readonly text?: string
}

/**
 * Structural view of the one-shot start request (consumed fields only): the
 * `prompt` is the role-extraction source, `label` + `parent` are the
 * catalog-correlation join key. The wrapper forwards the request object
 * itself, so every other field reaches the service unchanged.
 */
export interface SubagentStartRequestView {
  readonly prompt?: readonly SubagentPromptBlockView[]
  readonly label?: string
  readonly parent?: { readonly session?: { readonly id?: string } }
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
 * Structural view of the `subagents` runtime the wrapper delegates to
 * (consumed surface only; start results are opaque and forwarded untouched).
 */
interface SubagentsServiceView {
  start(name: string, request: SubagentStartRequestView): unknown
  startContinuable?(spec: ContinuableStartSpecView): unknown
}

/** Options for {@link installSubagentSeam}. */
export interface SubagentSeamOptions {
  /**
   * Live declared-role id map (trimmed id → DECLARED RAW id), read per start
   * so a settings change is observed without a re-install.
   */
  roleIds: () => ReadonlyMap<string, string>
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
  /** Stop intercepting service reads (the owning fiber's teardown also does). */
  dispose(): void
}

/** One label-keyed correlation claim for a start whose result carried no session id. */
interface PendingCorrelation {
  role: string
  at: number
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
 * @internal Test seam (mirrors `subagentRoleRecords`): the seam installed on
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
  const recordChild = (childSessionId: string, role: string, at: number): void => {
    const existing = records.get(childSessionId)
    records.set(childSessionId, {
      role,
      at,
      firstNoticePending: existing?.firstNoticePending ?? true,
    })
  }

  /** Claim the label-keyed catalog correlation for a resolved start (bounded, insertion-order eviction). */
  const beginCorrelation = (request: SubagentStartRequestView | undefined, role: string): string | undefined => {
    const parentSessionId = parentSessionIdOf(request)
    const label = typeof request?.label === 'string' ? request.label : undefined
    if (parentSessionId === undefined || label === undefined || label === '') return undefined
    const key = correlationKey(parentSessionId, label)
    if (!pending.has(key) && pending.size >= PENDING_CORRELATION_LIMIT) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    pending.set(key, { role, at: Date.now() })
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
      let pendingKey: string | undefined
      try {
        pendingKey = beginCorrelation(request, role)
      } catch (error) {
        reportDegrade(error)
      }
      let result: unknown
      try {
        // Task 2 merge point: the ONE place the resolved role is available
        // before the request reaches the service (`role` above + `name` here
        // is everything the persona decision needs — no second resolution).
        result = service.start(name, request)
      } catch (error) {
        endCorrelation(pendingKey)
        throw error
      }
      observeStartResult(
        result,
        (childSessionId) => {
          endCorrelation(pendingKey)
          recordChild(childSessionId, role, Date.now())
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
        const result: unknown = startContinuable.call(service, spec)
        observeStartResult(
          result,
          (childSessionId) => recordChild(childSessionId, role, Date.now()),
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
      recordChild(childSessionId, claim.role, claim.at)
    } catch (error) {
      reportDegrade(error)
    }
  }))

  const seam: SubagentSeam = {
    records,
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
