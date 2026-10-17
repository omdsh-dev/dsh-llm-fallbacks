/**
 * Dispatch-seam role resolution + per-child record (plan
 * role-based-subagent-adoption Task 1; rc.1 `startActivation` migration, plan
 * dsh-021-subagent-seam-repair Task 2).
 *
 * The seam is the documented cordis service-read waterfall
 * (`Events['internal/get']`, `@deepseek-ai/cordis`
 * `lib/types/events.d.ts`): a listener wraps the `subagents` service VALUE on
 * read and returns a prototype-delegating wrapper whose `startActivation`
 * resolves the dispatch role from the incoming activation spec BEFORE
 * delegating. The real service object is never mutated; readers of the
 * `subagents` service transparently receive the wrapper.
 *
 * Role source (plan Global Constraints): the child request's prompt carries
 * the Assignment header field `**Execute as**: <id>` — dsh role binding is
 * prompt-only. {@link resolveDeclaredRoleFromAssignment} is the ONE pure
 * resolution point; it canonicalizes exactly like the existing trimmed-id
 * map (trim, drop ONE leading `@`, case-insensitive match against the
 * declared trimmed ids) and returns the DECLARED RAW id. Undeclared, absent,
 * `inherit`, or ambiguous declarations resolve to `undefined` = no role.
 *
 * The resolution reads the Assignment HEADER region only, never the whole
 * prompt (Task 1 CF-2): the region ends at the first Assignment body marker,
 * and when the prompt carries NO marker it is bounded to the LEADING HEADER
 * BLOCK — the first paragraph plus every following paragraph that opens with
 * header material, ending at the prompt's first prose paragraph. So a
 * `**Execute as**: <id>` line quoted inside a body paragraph can never shape a
 * resolution (it is outside the region) even though mstar's canonical dispatch
 * text carries no body marker at all. Inside the region the engine's pinned
 * ambiguity rule stands unchanged: the DISTINCT DECLARED ids must collapse to
 * exactly one, else the dispatch is a no-op — never a first-occurrence pick.
 *
 * Per-child record + the timing rule (rc.1 `startActivation`): the record
 * `{ role, at, firstNoticePending }` is keyed by the child id (Task 3 reads it
 * to emit the one role notice row). The child is created INSIDE the native
 * call — `manager.startLocal` mints/uses `spec.childId` and only then resolves
 * the activation — so `agent/created` fires BEFORE any `.then` on this side
 * could key a record off the resolved `SubagentActivation.childId`. The
 * wrapper therefore reserves the child id itself for a LOCAL backend (the
 * provider exposes `prepareContinuable`; a reserved id on any other backend is
 * rejected with `UNSUPPORTED_CAPABILITY`) and writes the record SYNCHRONOUSLY
 * before delegating, deleting it when the native call fails. An EXTERNAL
 * backend allocates its own child id, receives the caller's OWN spec object
 * untouched, and has its record keyed off the resolved activation's `childId`.
 *
 * A result carrying no child id — a `jobId` is a registry id, NOT a session id
 * — is never keyed: the child is correlated instead through the parent-owned
 * `subagent/catalog` session event `{ childId, label }` joined on the
 * delegating parent + the activation `label` (the same string the cataloged
 * child membership carries).
 *
 * Persona delivery is NO LONGER this module's job (plan Task 1): rc.1 removed
 * `SubagentStartRequest.persona`, so the resolved role's persona is registered
 * as a scoped `deployment:persona-prefix` section on the CHILD's own context
 * by `./role-persona.ts`, over the SAME ROOT-shared record map this module
 * writes. That listener owns the `personaNotApplied` verdict the notice row
 * reads — EXCEPT when a reservation failure means it can never see the child
 * (the runtime mints its own child id and `agent/created` has already run), in
 * which case this module resolves the same question against the live roles
 * source and carries the verdict onto the record keyed off the RESOLVED id,
 * before the child's first pre-step. This module writes no request field,
 * reads no provider persona capability, and injects no agent preset.
 *
 * In-session notice row (plan Task 3): the SAME install point registers the
 * `agent/pre-step` emitter (`./role-notice.ts`) over the record map it owns, so
 * the role is announced once in the child's own session. Its per-agent
 * `noticeEmitted` marker is exposed here for the caller's cleanup sites: the
 * plugin dispose effect clears it, while `agent/disposed` deliberately KEEPS it
 * (CF-6 — the marker is SESSION-stable and bounded, because a continuable
 * child's durable session survives its activation).
 *
 * Durable role visibility (plan Task 3b): the SAME install point registers the
 * host-side session projection unit (`./role-projection.ts`) that folds that
 * notice row out of the child's own log, so the session-header badge can show
 * the role for a settled child and after a host restart — a read of the SAME
 * single write primitive, never a second one.
 *
 * Multi-fiber composition (CF-5): the record map and the notice marker are
 * ROOT-shared, while only the `internal/get` wrapper (+ the catalog listener it
 * feeds) is single-owner. Every applied fiber registers its OWN notice emitter
 * and projection unit and reports its ownership structurally
 * (`SubagentSeam.ownsWrapper`), so a disposing fiber cannot silently take the
 * role surfaces down with it.
 *
 * Degrade-never-crash: an absent/reshaped service, an unexpected result
 * shape, or any throwing bookkeeping degrades to the native path with at most
 * ONE contained debug log — a dispatch is never affected.
 *
 * @module dsh-llm-fallbacks/subagents-seam
 */

import { randomUUID } from 'node:crypto'
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
 * A line that OPENS an Assignment-header PARAGRAPH (the marker-less fallback
 * bound, CF-2): a heading (any level), a `---` rule, a bold-led line
 * (`**Execute as**: <id>`, `**IDENTITY** — …`), or a short `Key: value` header
 * row (`Execute as: coder`, `Delegation: forbidden`) — mstar's field grammar
 * allows the plain form without bold. A line that matches none of these starts
 * PROSE, which is exactly where the header region ends.
 */
const ASSIGNMENT_HEADER_OPEN_RE =
  /^(?:#{1,6}[ \t]|-{3,}[ \t]*\r?$|[ \t]*(?:[-*][ \t]+)?\*\*|[ \t]*(?:[-*][ \t]+)?\*{0,2}[A-Za-z][A-Za-z /_-]{0,29}\*{0,2}[ \t]*:[ \t]*\S)/

/**
 * One dispatch-resolved per-child record (Task 3 reads it to emit exactly one
 * role notice row per child session).
 */
export interface SubagentSeamRecord {
  /**
   * The DECLARED RAW role id resolved at the dispatch seam.
   *
   * Authoritative-role precedence (CF-10, documented rather than resolved by
   * re-branding): a resume that reuses a reserved `childId` may resolve a
   * DIFFERENT declared role, and this field is then rewritten while the
   * durable notice row the child's session already carries keeps the FIRST role.
   * The projection deliberately reads the notice row, so the durable role is the
   * child's announced identity and this record is only the LIVE dispatch hint
   * (what the next activation / the resume fallback would use). The two can
   * therefore disagree after a re-dispatch until the child is disposed; no
   * consumer may treat the record as the durable role.
   */
  role: string
  /** When the record was written (epoch ms). */
  at: number
  /**
   * `true` until the child's role notice row has been emitted (Task 3). A
   * later write for the SAME child session preserves an already-cleared
   * marker, so a repeat dispatch/resume cannot produce a second notice row.
   * The root-shared `noticeEmitted` set is the SESSION-stable half of that
   * guarantee (it survives `agent/disposed`); this field is the per-record half
   * that a resume rewrite preserves.
   */
  firstNoticePending: boolean
  /**
   * `true` when the role DECLARES a persona and that persona was NOT delivered
   * onto the child. Written by the `agent/created` role-persona listener
   * (`./role-persona.ts`) over this same map — except when a reservation
   * failure means that listener can never see the child (the runtime mints its
   * own child id), where the seam itself carries the verdict onto the record
   * keyed off the RESOLVED id. The seam never delivers or reads a persona
   * other than for that one question. Absent when there was nothing to report:
   * the section was registered, a same-name section was already on the child's
   * scope (whoever registered it), the listener never saw the child (an
   * EXTERNAL backend creates no local agent), the role declares none, or no
   * persona source is wired. Task 3 appends ` (persona not applied)` on `true`
   * only.
   *
   * STICKY (Task 3 review Minor 4): a record rewrite — a resume reusing the
   * reserved `childId`, or the resolved activation re-keying the same child
   * after `agent/created` already ran — can only ADD this verdict, never clear
   * it. A rewrite carries no verdict of its own, and the child's one notice row
   * is a claim about the dispatch that already reported it missing, so the first
   * `true` survives.
   */
  personaNotApplied?: boolean
}

/** One consumed prompt content block (`@deepseek-ai/dsh-llm` `ContentBlock` text members). */
export interface SubagentPromptBlockView {
  readonly type: string
  readonly text?: string
}

/**
 * Structural view of the activation request (consumed fields only): `prompt` is
 * the role-extraction source and `parent` is the catalog-correlation join half.
 * The wrapper forwards the request OBJECT itself, so every other field (cwd,
 * agentOptions, outputSchema, maxDepth, the signal) reaches the service
 * unchanged.
 */
export interface SubagentStartRequestView {
  readonly prompt?: readonly SubagentPromptBlockView[]
  readonly parent?: { readonly session?: { readonly id?: string } }
}

/**
 * Structural view of the activation spec (rc.1 `SubagentActivationSpec`,
 * consumed fields only): `childId` is the caller-reserved identity a resume
 * already carries — also the record fallback when the request carries no
 * Assignment header — and `label` is the catalog join's other half (the
 * cataloged child membership carries this exact string). `signal`, `delivery`
 * and every future field travel with the caller's spec object.
 */
export interface SubagentActivationSpecView {
  readonly provider: string
  readonly label?: string
  readonly childId?: string
  readonly request: SubagentStartRequestView
}

/**
 * Structural view of ONE registered provider's consumed surface
 * (`@deepseek-ai/dsh-subagent` `SubagentProvider`): `prepareContinuable` is the
 * NATIVE local-backend gate — method presence is what routes a start through
 * `manager.startLocal` instead of `manager.startExternal`, and it is therefore
 * also what makes a CALLER-reserved `childId` legal (upstream rejects a reserved
 * id on any other backend with `UNSUPPORTED_CAPABILITY`).
 */
interface SubagentProviderView {
  readonly prepareContinuable?: unknown
}

/**
 * Structural view of the `subagents` runtime the wrapper delegates to
 * (consumed surface only; activation results are opaque and forwarded
 * untouched).
 */
interface SubagentsServiceView {
  startActivation(spec: SubagentActivationSpecView): unknown
  /** Provider lookup — the local-backend probe (absent on a reshaped runtime). */
  getProvider?(name: string): SubagentProviderView | undefined
}

/** Options for {@link installSubagentSeam}. */
export interface SubagentSeamOptions {
  /**
   * Live declared-role id map (trimmed id → DECLARED RAW id), read per
   * activation so a settings change is observed without a re-install.
   */
  roleIds: () => ReadonlyMap<string, string>
  /**
   * Live declared roles (`roles.list`) — the SAME source `./role-persona.ts`
   * reads. Consulted ONLY when a reservation failure means that listener can
   * never see the child: the seam is then the only place left that can carry
   * the persona verdict to the child's notice row. Absent (no persona source is
   * wired) ⇒ no verdict, exactly like a listener that never saw the child.
   */
  roles?: () => readonly FallbacksRole[]
  /** Contained debug sink (at most one line per contained degrade). */
  debug?: (message: string) => void
}

/** The installed seam (Task 3 surface + explicit teardown). */
export interface SubagentSeam {
  /**
   * Per-child records keyed by the child id — the reserved id this wrapper
   * wrote before a local activation, or the `childId` a resolved activation
   * reported. ROOT-shared (CF-5): every fiber applied over the same root reads
   * the same map. Mutable by design: Task 3 clears `firstNoticePending` after
   * emitting the notice, and the role-persona listener writes
   * `personaNotApplied`.
   */
  readonly records: Map<string, SubagentSeamRecord>
  /**
   * Per-agent marker of children whose role notice row was already emitted
   * (mirrors the runtime's `dispatchInjected`): the in-memory half of Task 3's
   * once-per-child guarantee, also ROOT-shared. SESSION-stable (CF-6): it is
   * deliberately NOT cleared on `agent/disposed` — a continuable child's durable
   * session survives the activation, so clearing the marker would let a
   * re-activation resume append a second notice row to the same log. It is
   * bounded (`NOTICE_EMITTED_LIMIT`) and cleared only in the plugin dispose
   * effect.
   */
  readonly noticeEmitted: Set<string>
  /**
   * `true` when THIS install owns the root-scoped `internal/get` wrapper (plus
   * the catalog-correlation listener it feeds) — the only part that must have a
   * single owner. `false` on a later fiber over the same root, which still
   * registers its OWN notice emitter and projection unit. The callers' dedupe
   * branch reads THIS field (CF-5): a structured marker, never a thrown
   * message.
   */
  readonly ownsWrapper: boolean
  /** Stop intercepting service reads (the owning fiber's teardown also does). */
  dispose(): void
}

/** One label-keyed correlation claim for an activation whose result carried no child id. */
interface PendingCorrelation {
  role: string
  at: number
}

/**
 * Cap on un-correlated claims (a `jobId`-only result whose catalog event never
 * arrives). Bounded insertion-order eviction — recency-ordered, because a
 * re-claimed hot key is re-inserted (`beginCorrelation` deletes before it sets),
 * so the busiest claim can never be the one evicted.
 *
 * @internal Exported for the bound test (mirrors `subagentSeamOf`): the value is
 * not part of the plugin's public surface, but a test that hardcoded 64 could
 * not tell the real bound from a stale copy.
 */
export const PENDING_CORRELATION_LIMIT = 64

/**
 * Slice an Assignment's header region: the text before the first body marker
 * (see {@link ASSIGNMENT_BODY_START_RE}), or — when the prompt carries NO
 * marker — its LEADING HEADER BLOCK (see {@link leadingHeaderBlock}).
 */
function assignmentHeaderRegion(prompt: string): string {
  const marker = prompt.match(ASSIGNMENT_BODY_START_RE)
  return marker !== null && marker.index !== undefined
    ? prompt.slice(0, marker.index)
    : leadingHeaderBlock(prompt)
}

/**
 * The prompt's leading header block (CF-2): its FIRST paragraph, plus every
 * following paragraph that OPENS with header material
 * ({@link ASSIGNMENT_HEADER_OPEN_RE}), ending at the first paragraph that opens
 * with anything else — i.e. at the prompt's first PROSE paragraph. Wrapped
 * continuation lines inside a paragraph are free: mstar's canonical dispatch
 * text wraps the field block, and a bound that stopped at the first non-bold
 * line would attenuate every real Assignment.
 *
 * Why a bound is needed at all: mstar's canonical dispatch text carries NO body
 * marker (the `## Assignment` heading is not one), so the pre-CF-2 fallback made
 * the WHOLE prompt the header region — a `**Execute as**: <id>` line quoted in
 * the task body then resolved a role that was never declared in the header,
 * installing that role's persona and writing a durable `[role: <id>]` row. The
 * body of an Assignment is prose, so the first prose paragraph closes the
 * region; a field line inside the header block itself is still read, and the
 * ambiguity rule then refuses two distinct declared ids (never a
 * first-occurrence pick).
 *
 * The residual this leaves (documented, not silently accepted): a body-quoted
 * field line in a paragraph that itself opens with header material and is not
 * preceded by any prose paragraph is still inside the region — it can only
 * resolve when it names exactly one DECLARED id, and the engine's own
 * `assignmentHeaderRegion` has no bound at all, so this is strictly narrower
 * than the shipped engine behavior it mirrors.
 */
function leadingHeaderBlock(prompt: string): string {
  let end = 0
  let offset = 0
  let atParagraphStart = true
  for (const line of prompt.split('\n')) {
    offset += line.length + 1
    if (line.trim() === '') {
      atParagraphStart = true
      continue
    }
    if (atParagraphStart && !ASSIGNMENT_HEADER_OPEN_RE.test(line.replace(/\r$/, ''))) break
    atParagraphStart = false
    end = offset
  }
  return end === 0 ? '' : prompt.slice(0, end)
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
 * PURE, chain-independent persona lookup for the `agent/created` role-persona
 * listener (`./role-persona.ts`; rc.1 delivers the persona as a scoped prompt
 * section on the child, never as a request field):
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
 * The child id carried by a resolved activation, or `undefined`.
 *
 * Covers the rc.1 activation shape (`SubagentActivation.childId`) AND the
 * tool-result vocabulary that still reaches a reshaped runtime
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

/** The label-keyed correlation claim key (parent session + activation label). */
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
 * ROOT-scoped seam state: the per-child record map and the once-per-child notice
 * marker. The `internal/get` wrapper is root-scoped, so only the fiber that owns
 * it WRITES these — but every applied fiber's notice emitter READS the same
 * objects, which is what keeps a multi-fiber composition at exactly ONE notice
 * row per child (a per-fiber copy of the marker would announce the same child
 * once per fiber). Keyed by the context ROOT in a WeakMap, so it dies with the
 * root; an owner fiber's disposal deliberately does NOT drop it, so a surviving
 * fiber (and a later re-apply) keeps reading the same objects.
 */
interface SubagentSeamState {
  readonly records: Map<string, SubagentSeamRecord>
  readonly noticeEmitted: Set<string>
}

/** @internal The root's shared seam state, created on first use. */
const subagentSeamStates = new WeakMap<Context, SubagentSeamState>()

/** The root's shared state, created when the root has none yet. */
function seamStateFor(root: Context): SubagentSeamState {
  const existing = subagentSeamStates.get(root)
  if (existing !== undefined) return existing
  const created: SubagentSeamState = { records: new Map(), noticeEmitted: new Set() }
  subagentSeamStates.set(root, created)
  return created
}

/**
 * Context ROOTS that already carry the seam's `internal/get` WRAPPER — the one
 * genuinely single-owner part. The service-read waterfall is root-scoped and
 * global, so a multi-fiber composition (this plugin applied once per fiber over
 * one root) must not install a second listener set: that would only nest
 * wrappers and multiply the contained debug lines ("ONE per apply").
 *
 * CF-5: the dedupe covers the WRAPPER (and the catalog-correlation listener it
 * owns) ONLY. The two stateless surfaces — the `agent/pre-step` notice emitter
 * and the host session projection unit — are registered by EVERY applied fiber,
 * because a later fiber must keep both alive when an earlier owner fiber
 * disposes (the composition the dedupe exists for). The winner is reported
 * STRUCTURALLY to the caller (`SubagentSeam.ownsWrapper`), never by matching a
 * thrown message. The claim is released by {@link SubagentSeam.dispose} when the
 * OWNER disposes, so a later apply over the same root can own the wrapper again.
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
 * resolve + record the dispatch role per start, and register this fiber's role
 * surfaces (the notice emitter + the projection unit).
 *
 * Never throws for a multi-fiber apply (CF-5): a fiber whose root already owns
 * the `internal/get` wrapper gets a seam with `ownsWrapper: false` — it shares
 * the root's record map / notice marker (so exactly one notice row is written
 * per child) and still installs its OWN notice emitter and projection unit, so
 * neither surface dies when another fiber of the same root disposes.
 *
 * Returns the seam (the shared record map Task 3 reads, the ownership marker,
 * plus an idempotent `dispose` that withdraws THIS fiber's registrations). The
 * `internal/get` listener is owned by this module; callers that rely on the
 * fiber teardown alone may ignore `dispose`.
 */
export function installSubagentSeam(ctx: Context, options: SubagentSeamOptions): SubagentSeam {
  const root = ctx.root
  const state = seamStateFor(root)
  const records = state.records
  /**
   * Task 3's per-agent once-marker (mirrors the runtime's `dispatchInjected`):
   * the in-memory half of the once-per-child guarantee, SESSION-stable (CF-6) —
   * `src/index.ts` keeps it across `agent/disposed` (bounded by
   * `NOTICE_EMITTED_LIMIT`) because a continuable child's durable session
   * outlives the activation, and clears it only in the plugin dispose effect.
   */
  const noticeEmitted = state.noticeEmitted
  /** Owner of the root-scoped `internal/get` wrapper (see `subagentSeamRoots`). */
  const ownsWrapper = !subagentSeamRoots.has(root)
  if (ownsWrapper) subagentSeamRoots.add(root)
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
  const recordChild = (childId: string, role: string, at: number, personaMissed?: boolean): void => {
    const existing = records.get(childId)
    records.set(childId, {
      role,
      at,
      firstNoticePending: existing?.firstNoticePending ?? true,
      // The persona verdict belongs to the role-persona listener, which may
      // already have written it while the child was being created — or be
      // unable to see the child at all, in which case the caller carries it
      // here: a rewrite can only ADD the verdict, never clear it (see
      // `SubagentSeamRecord`).
      ...(existing?.personaNotApplied === true || personaMissed === true ? { personaNotApplied: true } : {}),
    })
  }

  /** Claim the label-keyed catalog correlation for a resolved activation (bounded, recency-ordered eviction). */
  const beginCorrelation = (
    spec: SubagentActivationSpecView | undefined,
    role: string,
    at: number,
  ): string | undefined => {
    const parentSessionId = parentSessionIdOf(spec?.request)
    const label = typeof spec?.label === 'string' ? spec.label : undefined
    if (parentSessionId === undefined || label === undefined || label === '') return undefined
    const key = correlationKey(parentSessionId, label)
    if (!pending.has(key) && pending.size >= PENDING_CORRELATION_LIMIT) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    // Recency, not first-insertion (CF-8): `Map.set` on an existing key keeps
    // its original position, so without the delete a re-claimed hot key would
    // still be the first eviction candidate while staler claims survive.
    pending.delete(key)
    pending.set(key, { role, at })
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
   * `true` when the named provider is a LOCAL backend — the test the runtime
   * itself routes on (`manager.startLocal` vs `manager.startExternal`), and the
   * only case in which a CALLER-reserved `childId` is accepted. A reshaped
   * runtime without `getProvider` exposes no local backend to reserve for, and a
   * throwing lookup is contained HERE: the dispatch then proceeds with the
   * caller's own spec, exactly like every other seam failure.
   */
  const isLocalBackend = (service: SubagentsServiceView, providerName: string): boolean => {
    try {
      if (typeof service.getProvider !== 'function') return false
      return typeof service.getProvider(providerName)?.prepareContinuable === 'function'
    } catch (error) {
      reportDegrade(error)
      return false
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
    if (typeof service.startActivation !== 'function') {
      if (!unreadableServiceLogged) {
        unreadableServiceLogged = true
        debug(`llm-fallbacks: subagent role seam skipped — '${SUBAGENT_SEAM_SERVICE}' is not an activation-capable runtime`)
      }
      return value
    }
    const cached = wrappers.get(value)
    if (cached !== undefined) return cached
    const wrapper: SubagentsServiceView = Object.create(value)
    wrapper.startActivation = (spec: SubagentActivationSpecView): unknown => {
      const role =
        resolveRoleAtSeam(spec?.request)
        // Resume fallback (plan Global Constraints): a resume request may carry
        // no Assignment header — reuse the record of the child the caller
        // already reserved, else no-op.
        ?? (typeof spec?.childId === 'string' ? records.get(spec.childId)?.role : undefined)
      // No declared role → the native path, byte-identical (the caller's OWN spec object).
      if (role === undefined) return service.startActivation(spec)
      const at = Date.now()
      // Timing core (plan Global Constraints): a LOCAL child is created INSIDE
      // the native call, so `agent/created` fires before it returns. Reserve the
      // identity here and write the record SYNCHRONOUSLY — no later point exists
      // at which the child could still be recorded before its own listeners read
      // the map. Only a local backend accepts a reserved id, and only a resolved
      // role justifies constructing a spec at all: every other dispatch hands
      // the service the caller's own object. An EXTERNAL backend allocates its
      // own child id, so its record is keyed below off the resolved activation.
      let effectiveSpec: SubagentActivationSpecView = spec
      let reservedId: string | undefined
      /**
       * Carried out of a reservation failure: whether the resolved role
       * declares a persona the child can now never receive, so `true` must
       * reach the record `recordChild` keys off the RESOLVED id below.
       * `undefined` = no verdict.
       */
      let reservationPersonaMissed: boolean | undefined
      try {
        if (isLocalBackend(service, spec.provider)) {
          reservedId = spec.childId ?? randomUUID()
          if (reservedId !== spec.childId) effectiveSpec = { ...spec, childId: reservedId }
          recordChild(reservedId, role, at)
        }
      } catch (error) {
        // The reservation is seam BOOKKEEPING, never part of the dispatch: the
        // spread above enumerates EVERY spec property (the caller's own exotic
        // or hostile object included), and a throw there must not fail a
        // dispatch the native runtime would still accept. Drop the half-built
        // reservation — nothing stays written for a child the seam never
        // reserved — report ONE contained line, and delegate once with the
        // caller's OWN spec (Global Constraints: any seam failure forwards the
        // caller's own spec object unchanged).
        if (reservedId !== undefined) records.delete(reservedId)
        effectiveSpec = spec
        reservedId = undefined
        reportDegrade(error)
        // The native runtime now mints its OWN child id, so `agent/created`
        // fires before the record exists and `./role-persona.ts` can never
        // report this child: the verdict has to come from here and land on the
        // record `recordChild` writes the moment the resolved id is known —
        // before the child's first pre-step, the only point the notice reads.
        try {
          reservationPersonaMissed = personaForRole(options.roles?.() ?? [], role) !== undefined
        } catch (personaError) {
          // An unreadable declaration is NOT a verdict — nothing was proven
          // skipped — so none is invented and the containment holds.
          reportDegrade(personaError)
        }
      }
      let pendingKey: string | undefined
      try {
        pendingKey = beginCorrelation(spec, role, at)
      } catch (error) {
        reportDegrade(error)
      }
      let result: unknown
      try {
        result = service.startActivation(effectiveSpec)
      } catch (error) {
        endCorrelation(pendingKey)
        // Rollback: the native call threw, so no child reached the reserved id.
        if (reservedId !== undefined) records.delete(reservedId)
        throw error
      }
      // CF-4: `observeStartResult` reads the RESULT SHAPE (`result.then`), and
      // the native activation has ALREADY run by this point — a result object
      // whose `.then` accessor throws (or a hostile thenable) would otherwise
      // escape `wrapper.startActivation` as a failed dispatch for a child that
      // exists. Contain it like every other shape surprise: drop the catalog
      // claim, report ONE contained debug line, and still return the caller's
      // own result.
      try {
        observeStartResult(
          result,
          (childId) => {
            endCorrelation(pendingKey)
            recordChild(childId, role, at, reservationPersonaMissed)
          },
          // No child id in the result (a job id is not one): keep the claim and
          // let the parent-owned `subagent/catalog` event supply the child id.
          () => {},
          // A rejected native call established no child either: drop the claim
          // (it cannot be consumed later by a same-label sibling's catalog
          // event) together with the reservation it was pre-written under.
          () => {
            endCorrelation(pendingKey)
            if (reservedId !== undefined) records.delete(reservedId)
          },
        )
      } catch (error) {
        endCorrelation(pendingKey)
        reportDegrade(error)
      }
      return result
    }
    wrappers.set(value, wrapper)
    return wrapper
  }

  // The ROOT-scoped part, owned by the FIRST fiber only (CF-5 dedupe): the
  // service-read wrapper plus the catalog-correlation listener it feeds.
  if (ownsWrapper) {
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
    // delegating parent session + the activation label (the catalog `label` IS
    // the `SubagentActivationSpec.label` the child membership carries). The join
    // key is NOT unique: two children of one parent dispatched concurrently
    // under the SAME label share it, and the first catalog event consumes
    // whichever role was claimed last — so this fallback can key a sibling's
    // role in that corner (bounded: reachable only when a result carrying no
    // child id reaches the seam; recorded as a residual).
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
  }

  // Task 3: the once-per-child role notice row, emitted from the child's own
  // first non-empty `agent/pre-step` over the root's shared record map. CF-5:
  // registered per APPLIED FIBER (not only by the wrapper owner) — the emitter
  // is a pure read of the shared marker + record, so a second fiber's copy is
  // inert for a child the first already announced and stays live when another
  // fiber of the same root disposes.
  disposers.push(installRoleNotice(ctx, { records, emitted: noticeEmitted, debug }))

  // Task 3b: the durable READ of that same row — one host session projection
  // unit folding the notice out of the child's own log, so the header badge
  // works for a settled child and after a host restart. CF-5: also registered
  // per APPLIED FIBER: the unit is a stateless pure log read (the host registry
  // ref-counts a shared key, so a second registration is one unit, not a
  // conflict), and that is what keeps the badge alive when another fiber of the
  // same root — including the wrapper owner — disposes.
  disposers.push(installRoleProjection(ctx, { debug }))

  const seam: SubagentSeam = {
    records,
    noticeEmitted,
    ownsWrapper,
    dispose: () => {
      // Release the root claim so a later apply (fiber reload) can own the
      // wrapper again; the shared state stays for any surviving fiber.
      if (ownsWrapper) subagentSeamRoots.delete(root)
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  subagentSeamStores.set(ctx, seam)
  return seam
}
