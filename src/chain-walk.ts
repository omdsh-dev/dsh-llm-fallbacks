/**
 * The chain walk (design dsh-022-rc1-upgrade §2/§3/§6.1): the fallback
 * decision, executed inside the virtual `FallbacksChain/Auto` adapter's
 * `stream()` instead of on the `agent/request` / `agent/request-error`
 * waterfalls.
 *
 * One walk per `stream()` call: resolve the session's agent view, resolve the
 * role and the chain tail, then attempt the chain's heads in order. A
 * pre-output terminal `finish` whose failure code is a trigger code is
 * swallowed, booked (cooldown / recovery) and the walk advances; anything
 * else — a normal finish, an aborted finish, a non-trigger failure, or any
 * failure after the attempt already yielded a chunk — is forwarded verbatim
 * and ends the walk.
 *
 * The COMMITTED rule (§3.1 / §7.5) is why a post-output failure cannot be
 * replayed: yielded chunks cannot be unsent, so a second provider's output
 * cannot be concatenated behind a partial one. Such a failure surfaces to the
 * loop, which settles the partial attempt; llm-retry (or the terminal error)
 * takes over from there, and a retry re-enters this walk, which resumes past
 * the cooled head on its own.
 *
 * Bookkeeping survives a walk exactly as far as the state store does: cooldown
 * (`cooldownMs` / `revertPolicy` / half-open escalation) is the cross-call
 * memory keyed by session, so an llm-retry re-entry starts past a failed head;
 * the per-call failed set and the switch cap live only for this walk
 * (`maxSwitchesPerStep` = switches per walk, attempts ≤ cap + 1).
 *
 * @module dsh-llm-fallbacks/chain-walk
 */

import {
  LlmError,
  type GenerateOptions,
  type LlmRuntime,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  annotateCandidates,
  createCandidateFilter,
  hasWildcardEntry,
  resolveChainViews,
  roleChainEntries,
  selectCandidates,
  type FailingModel,
} from './chains.ts'
import type { FallbacksConfig } from './config.ts'
import type { FallbackSwitchReason } from './events.ts'
import { escalatedCooldownMs } from './recovery.ts'
import { firstAllowedCandidate, resolvedRoutes } from './route-allowlist.ts'
import { resolveDeclaredRole } from './role-resolution.ts'
import type { AgentLike } from './roles.ts'
import { selectorKey, type Selector } from './selectors.ts'
import type { FallbackStateStore } from './state.ts'
import type { EffectivePolicy } from './subagent-policy.ts'
import { resolveEffectiveChain } from './time-slots.ts'
import {
  EMPTY_EFFECTIVE_CHAIN_CODE,
  FALLBACKS_CHAIN_MODEL,
  FALLBACKS_PROVIDER,
  LLM_UNAVAILABLE_CODE,
  UNDISPATCHABLE_HEAD_CODE,
  effectiveHeadOf,
  firstDispatchableExactHead,
  type EffectiveHead,
} from './virtual-adapter.ts'

/**
 * dsh core's canonical failure code for a request larger than the model's
 * context window (`@deepseek-ai/dsh-llm` `CONTEXT_WINDOW_EXCEEDED_CODE`; the
 * DeepSeek adapter's `httpErrorCode()` and llm-pi-ai's `mapStopReason()` both
 * map the provider 400 "maximum context length" to it). Declared as a literal
 * for the same reason `triggerCodes` is `string[]` — the plugin compares dsh
 * failure codes as plain strings and never imports a peer value.
 *
 * It is NOT in llm-retry's retryable set, so the plugin sees it only when the
 * operator lists it in `triggerCodes` — and once listed, this walk handles the
 * rejection BEFORE the harness's compaction plugin compacts anything
 * (measured 2026-09-09: the first overflow switches to the fallback, no
 * compaction happens). Operators who want compaction tried first leave the
 * code out of `triggerCodes`.
 *
 * A `CONTEXT_WINDOW_EXCEEDED` switch is REQUEST-scoped
 * ({@link REQUEST_SCOPED_CODES}): the route is healthy and the request was too
 * big, so the per-call failed key is recorded but no cooldown and no recovery
 * counter are written.
 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * Failure codes whose switch is REQUEST-scoped: the route is healthy and the
 * request was the problem, so a switch records the per-call failed key but
 * writes no cooldown and no recovery counter. Cooling the route down would
 * send the next SHORT prompt to the fallback for no reason.
 */
export const REQUEST_SCOPED_CODES: ReadonlySet<string> = new Set([CONTEXT_WINDOW_EXCEEDED_CODE])

/**
 * Model-catalog view the wildcard / context-window probes read. `contextWindow`
 * is a host-disclosed extra on the advisory catalog row (the dsh `LlmModelInfo`
 * does not type it), while `resolveModelInfo` is where the host actually
 * carries it — both are optional and read structurally, so a host offering
 * neither reports every window as unknown (never a skip).
 */
export interface ModelCatalogLike {
  listModels(provider: string): Promise<readonly { id: string; contextWindow?: number }[]>
  resolveModelInfo?(provider: string, model: string): Promise<{ context?: { contextWindow?: number } }>
}

/**
 * The `provider/*`-entry existence probe: the target provider's advertised
 * catalog, fetched once per expansion and cached per provider. A
 * missing/unknown provider or a failing catalog reads as "no such model", so
 * wildcard candidates to it are skipped; without a catalog no filtering
 * happens (`() => true`).
 *
 * simplify: catalog fetched per expansion, never cached across walks. Walks
 * are failure-driven and rare; cache per provider in the plugin if they ever
 * become hot.
 */
export async function makeModelExists(
  catalog: ModelCatalogLike | undefined,
  providers: readonly string[],
): Promise<(provider: string, model: string) => boolean> {
  if (catalog === undefined || typeof catalog.listModels !== 'function') return () => true
  const models = new Map<string, Set<string>>()
  await Promise.all(providers.map(async (provider) => {
    try {
      const rows = await catalog.listModels(provider)
      models.set(provider, new Set(rows.map((row) => row.id)))
    } catch {
      models.set(provider, new Set())
    }
  }))
  return (provider, model) => models.get(provider)?.has(model) ?? false
}

/**
 * The context-window lookup for a `CONTEXT_WINDOW_EXCEEDED` expansion: a
 * `provider/model → contextWindow` map over the failing route plus every
 * resolved candidate route, fetched once per expansion (the
 * {@link makeModelExists} pattern — failure-driven and rare, never cached).
 *
 * Two sources, cheapest first: the advertised catalog row when it discloses a
 * window (one `listModels` per distinct provider), then — for routes still
 * unknown — the exact-route `resolveModelInfo` metadata, which is where the
 * dsh host puts `context.contextWindow`. A missing catalog, a throwing probe,
 * or a route that discloses nothing all read as UNKNOWN (`undefined`), and
 * unknown always KEEPS the candidate: an undisclosed window must never empty a
 * chain.
 */
export async function makeContextWindowOf(
  catalog: ModelCatalogLike | undefined,
  routes: readonly FailingModel[],
): Promise<(provider: string, model: string) => number | undefined> {
  if (catalog === undefined) return () => undefined
  const windows = new Map<string, number>()
  if (typeof catalog.listModels === 'function') {
    await Promise.all([...new Set(routes.map((route) => route.provider))].map(async (provider) => {
      try {
        for (const row of await catalog.listModels(provider)) {
          if (typeof row.contextWindow === 'number') windows.set(selectorKey(provider, row.id), row.contextWindow)
        }
      } catch {
        // An unreachable catalog leaves its routes unknown — never a skip.
      }
    }))
  }
  const resolveModelInfo = catalog.resolveModelInfo?.bind(catalog)
  if (resolveModelInfo !== undefined) {
    await Promise.all(routes.map(async (route) => {
      const key = selectorKey(route.provider, route.model)
      if (windows.has(key)) return
      try {
        const window = (await resolveModelInfo(route.provider, route.model))?.context?.contextWindow
        if (typeof window === 'number') windows.set(key, window)
      } catch {
        // Same degradation as the catalog probe: unknown, never a skip.
      }
    }))
  }
  return (provider, model) => windows.get(selectorKey(provider, model))
}

/**
 * The minimal agent view one walk needs (design §2.2): `GenerateOptions`
 * carries only `sessionId`, so the session's agent is read opportunistically
 * through the host `agents` registry. `undefined` when the id is absent or the
 * agent left the registry — treated as a root agent with no role (the
 * effective-chain walk still runs).
 */
export interface AgentChainView {
  /** `agent.session.header.origin`; a missing header is a root agent. */
  origin: 'root' | 'subagent'
  /** `agent.session.header.agentPreset` — the explicit role stage. */
  agentPreset?: string
  /** `agent.options` — the pair the rules stage matches (a virtual pair on this path). */
  optionsRoute?: { provider: string; model: string }
  sessionId: string
}

/** Everything one walk reads from the plugin wiring (design §6.1). */
export interface ChainWalkDeps {
  readConfig(): FallbacksConfig
  getLlm(): LlmRuntime | undefined
  resolveAgentView(sessionId: GenerateOptions['sessionId']): AgentChainView | undefined
  states: FallbackStateStore
  /** The live `trimmed id → declared raw id` map (re-derived on settings change). */
  roleIds(): ReadonlyMap<string, string>
  /** The dispatch seam's record for one child — the dispatch-role stage. */
  seamRecord(sessionId: SessionKey): { role?: string; virtualRouteInjected?: boolean } | undefined
  /** The host subagent policy for one session: guarded read + fail-closed. */
  policyFor(sessionId: SessionKey): EffectivePolicy
  /** Record a plugin-originated switch the allowlist emptied (in-memory, card-only). */
  recordBlocked?(sessionId: SessionKey, route: { provider: string; model: string }, reason: FallbackSwitchReason): void
  log: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
}

/** A non-null session id — the key the state store and cooldown memory are held under. */
type SessionKey = NonNullable<GenerateOptions['sessionId']>

/** One history message of a walked request. */
type DelegatedMessage = GenerateOptions['messages'][number]

/**
 * The `provider/model` an adapter-private replay envelope names for itself,
 * when it names them in a readable shape.
 *
 * `ReplayEnvelope.response` is an untyped, adapter-private payload
 * (`@deepseek-ai/dsh-llm` `types.d.ts`), so this probe is deliberately
 * structural and total: anything it cannot read yields `undefined` and the
 * caller leaves the message untouched — never guessed, never thrown. A pair
 * naming the virtual route itself is refused, because re-stamping onto
 * `FallbacksChain` would be a self-route.
 */
function envelopeProvenance(replayState: unknown): EffectiveHead | undefined {
  if (typeof replayState !== 'object' || replayState === null) return undefined
  const response: unknown = (replayState as { response?: unknown }).response
  if (typeof response !== 'object' || response === null) return undefined
  const { provider, model } = response as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider === '' || provider === FALLBACKS_PROVIDER) return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/**
 * Restore the provenance of history messages the durable record attributes to
 * the virtual route (R-004) — computed ONCE per walk and reused by every
 * attempt (a rotation stays faithful: envelope provenance names the producing
 * head, never the walk's current target).
 *
 * The loop stamps every durable assistant message with the route of the
 * REQUEST that produced it — `FallbacksChain/Auto` here — while the replay
 * envelope inside it was produced by the head adapter that actually answered.
 * The runtime's ownership gate exposes an envelope to a target adapter only
 * while that adapter instance owns the message's recorded provider
 * (`LlmRuntime.forAdapter`), so the walk's nested `llm.stream({ … provider:
 * head })` would hand the head a message whose envelope has been dropped, and
 * pi-ai-backed thinking signatures would silently degrade.
 *
 * Re-stamping the pair the envelope itself names puts the message back under
 * the adapter that produced it, so the gate keeps it — and a pi-ai adapter's
 * replay validator, which requires `response.provider`/`response.model` to
 * equal the message source, accepts it. Only `source` changes; the durable
 * record the loop writes is untouched.
 *
 * @param messages - the walked request's history, exactly as received.
 * @returns `messages` itself when nothing qualifies, so the untouched path
 *   allocates nothing.
 */
function restoreEnvelopeProvenance(messages: DelegatedMessage[]): DelegatedMessage[] {
  let changed = false
  const restored = messages.map((message): DelegatedMessage => {
    const source = message.source
    // `source` is optional on the request-message union (an identity-free
    // one-shot user input carries `source?: never`), and only an assistant
    // message's `model` source names a provider/model pair to re-stamp.
    if (message.role !== 'assistant' || source?.kind !== 'model') return message
    if (source.provider !== FALLBACKS_PROVIDER || source.model !== FALLBACKS_CHAIN_MODEL) return message
    const provenance = envelopeProvenance(source.replayState)
    if (provenance === undefined) return message
    changed = true
    return { ...message, source: { ...source, ...provenance } }
  })
  return changed ? restored : messages
}

/** The walk's per-call resolution: everything that must be true before any chunk. */
interface WalkStart {
  config: FallbacksConfig
  role: string
  rootTail: readonly string[]
  head: EffectiveHead
  llm: LlmRuntime
  owner: SessionKey | undefined
  seam: { role?: string; virtualRouteInjected?: boolean } | undefined
}

/** The agent shape {@link resolveDeclaredRole} matches rules against. */
function agentLikeOf(view: AgentChainView | undefined): AgentLike {
  return {
    options: view?.optionsRoute,
    session: { header: { origin: view?.origin ?? 'root', agentPreset: view?.agentPreset } },
  }
}

/**
 * The route a `FallbacksChain/Auto` selection really SERVED, for the rules
 * stage's pair-wise matching (QC1 I-1 in the pre-C path): a child whose
 * recorded pair is the virtual row keeps matching a rule keyed on the real
 * chain head. `effectiveHeadOf` is the same head the picker row advertises, and
 * a non-conforming all-day chain yields `undefined` — no anchor, no widening.
 */
function servedRouteOf(
  config: FallbacksConfig,
  view: AgentChainView | undefined,
): { provider: string; model: string } | undefined {
  const route = view?.optionsRoute
  if (route?.provider !== FALLBACKS_PROVIDER || route.model !== FALLBACKS_CHAIN_MODEL) return undefined
  const head = effectiveHeadOf(config, new Date())
  return head === undefined ? undefined : { provider: head.provider, model: head.model }
}

/**
 * Resolve the walk's start state, throwing the three pre-attempt `LlmError`s
 * (design §6.1.1) — a synchronous throw, before any chunk, so the runtime's
 * adapter boundary normalizes it exactly like the adapter's own pre-checks.
 */
function resolveWalk(deps: ChainWalkDeps, options: GenerateOptions): WalkStart {
  const config = deps.readConfig()
  const view = deps.resolveAgentView(options.sessionId)
  const owner = options.sessionId
  const seam = owner === undefined ? undefined : deps.seamRecord(owner)
  const role = resolveDeclaredRole(agentLikeOf(view), config.roles.rules, deps.roleIds(), {
    dispatchRole: seam?.role,
    servedRoute: servedRouteOf(config, view),
    warn: deps.log.warn,
  })
  // Chain tails per origin (§2.2, unchanged from the pre-C decision path):
  // root walks the slot-effective all-day chain, a subagent the raw rootChain
  // tail its role concatenates.
  const rootTail = (view?.origin ?? 'root') === 'subagent'
    ? config.rootChain
    : resolveEffectiveChain(config, new Date(), config.tz ?? 'Asia/Shanghai')
  const entries = roleChainEntries(config.roles.list, rootTail, role)
  if (entries.length === 0) {
    throw new LlmError(
      'llm-fallbacks: the effective chain is empty — the virtual FallbacksChain route has no head to delegate to',
      EMPTY_EFFECTIVE_CHAIN_CODE,
    )
  }
  const head = firstDispatchableExactHead(entries)
  if (head === undefined) {
    throw new LlmError(
      'llm-fallbacks: the effective chain head cannot be dispatched (wildcard, malformed, or self-route) — refusing to delegate',
      UNDISPATCHABLE_HEAD_CODE,
    )
  }
  const llm = deps.getLlm()
  if (llm === undefined) {
    // The route is registered on a live `llm` service; absence means the fiber
    // is tearing down. Defensive — never silently drop the call.
    throw new LlmError(
      'llm-fallbacks: the llm runtime is unavailable — cannot delegate the FallbacksChain call',
      LLM_UNAVAILABLE_CODE,
    )
  }
  return { config, role, rootTail, head, llm, owner, seam }
}

/**
 * Walk one virtual call's chain (design §6.1): an async iterable of the
 * attempts' chunks, ending in exactly one terminal `finish`.
 *
 * Throws only for the pre-attempt conditions (empty chain, undispatchable
 * head, vanished runtime) — every per-attempt failure is either swallowed into
 * another attempt or forwarded as that attempt's own terminal `finish`.
 */
export function walkChain(deps: ChainWalkDeps, options: GenerateOptions): AsyncIterable<StreamChunk> {
  return walk(deps, resolveWalk(deps, options), options)
}

/** One expansion's outcome: the next attempt target plus the annotated candidate log. */
interface Advance {
  target: EffectiveHead
  candidates: string[]
}

/**
 * The walk body (§3.1). Split from {@link walkChain} so the start state — and
 * its synchronous throws — settle before the first chunk can exist.
 */
async function* walk(
  deps: ChainWalkDeps,
  start: WalkStart,
  options: GenerateOptions,
): AsyncIterable<StreamChunk> {
  const { config, role, rootTail, head, llm, owner } = start
  // §3.2 effort rule: an explicit selection effort rides every attempt (the
  // spread below keeps it). The pre-C override path had to DROP an inherited
  // effort on a route change; the walk never rewrites a seed config, so the
  // rule collapses to a verbatim passthrough — an absent effort stays absent.
  const messages = restoreEnvelopeProvenance(options.messages)

  /** The session's state, or `undefined` while the walk has written nothing (F-004). */
  const stateOf = () => (owner === undefined ? undefined : deps.states.peek(owner))

  /** Routes that already failed in THIS walk — the per-call failed set (§3.3). */
  const failedKeys = new Set<string>()

  /** Cross-call memory: is this route still cooled (half-open reads included)? */
  const isCooled = (key: string): boolean => {
    const state = stateOf()
    return state !== undefined && deps.states.isSuppressed(state, key, Date.now(), config.recovery ?? 'timer')
  }

  /**
   * Book a swallowed failure on `failed` (§3.3). A ROUTE-scoped failure cools
   * the route — the only cross-call memory, so an llm-retry re-entry resumes
   * past it. Under half-open this single write is also rule 5b: the escalated
   * duration comes from the consecutive-failure counter, so a failed probe
   * with no surviving target is re-suppressed exactly like one with a target.
   */
  const coolRoute = (failed: EffectiveHead): void => {
    if (owner === undefined) return
    const state = deps.states.get(owner)
    const key = selectorKey(failed.provider, failed.model)
    const until = config.revertPolicy === 'never'
      ? Number.POSITIVE_INFINITY
      : (config.recovery ?? 'timer') === 'half-open'
        ? Date.now() + escalatedCooldownMs(config.cooldownMs, state.recovery.recordFailure(key))
        : Date.now() + config.cooldownMs
    deps.states.suppress(state, key, until)
  }

  /**
   * Expand the chain from the route that just failed and return the next
   * attempt target, or `undefined` when nothing survives (chain exhausted).
   *
   * Runs per failure — exactly where the pre-C decision path ran, so the
   * filters keep their old meaning: `same-as-current` is the route that just
   * failed, cooldown is the cross-call memory, the per-call failed set is the
   * walk's own memory, the wildcard probe applies to `provider/*` entries
   * only, and the context-window filter exists only for a
   * `CONTEXT_WINDOW_EXCEEDED` trigger. `from.provider/model` also anchors
   * wildcard expansion: `provider/*` keeps the request's model id and swaps
   * only the provider.
   */
  const advanceFrom = async (from: EffectiveHead, failureCode?: string): Promise<Advance | undefined> => {
    const { all, wildcard } = resolveChainViews(
      config.roles.list,
      rootTail,
      role,
      from.provider,
      from.model,
      deps.log.warn,
    )
    // Recursion guard (§6.1.2): an entry that routes back into this adapter is
    // not a candidate at all — never dispatched, never annotated.
    const own = all.map((candidate) => candidate.provider !== FALLBACKS_PROVIDER)
    const candidates = all.filter((_, index) => own[index])
    const wildcards = wildcard.filter((_, index) => own[index])
    const exists = hasWildcardEntry(config.roles.list, rootTail, role)
      ? await makeModelExists(llm, [...new Set(candidates.map((candidate) => candidate.provider))])
      : undefined
    const contextWindowOf = failureCode === CONTEXT_WINDOW_EXCEEDED_CODE
      ? await makeContextWindowOf(llm, [
        from,
        ...candidates.flatMap((candidate) => candidate.model === undefined
          ? []
          : [{ provider: candidate.provider, model: candidate.model }]),
      ])
      : undefined
    const minContextWindow = contextWindowOf?.(from.provider, from.model)
    const cooldown = { isSuppressed: (key: string) => isCooled(key) }
    const failed = { has: (key: string) => failedKeys.has(key) }
    const filter = createCandidateFilter({ current: from, cooldown, failed, minContextWindow, contextWindowOf })
    const surviving = selectCandidates(candidates, wildcards, filter, exists)
    // §2 行为可见性: the log shows the attempt order AND why each candidate was
    // skipped; survivors (including the target) are unlabelled.
    const annotated = annotateCandidates(candidates, surviving, { current: from, cooldown, failed, minContextWindow, contextWindowOf })
      .map(({ candidate, skip }) => skip === undefined
        ? `${candidate.provider}/${candidate.model}`
        : `${candidate.provider}/${candidate.model} (skipped: ${skip})`)

    // §3.1 step 2 / spec D1: a seam-injected child is a PLUGIN-originated
    // route, so its switches are intersected with the host allowlist in
    // candidate order; an empty intersection is recorded and exhausts the
    // walk, and an unprovable policy fails closed (no switch it cannot prove).
    if (start.seam?.virtualRouteInjected === true && owner !== undefined) {
      const policy = deps.policyFor(owner)
      if (policy.state === 'unprovable') {
        deps.log.warn(
          'llm-fallbacks: agent "%s" subagent model-selection policy is on but unreadable — skipping fallback switch',
          owner,
        )
        return undefined
      }
      if (policy.state === 'enabled') {
        const allowed = firstAllowedCandidate(resolvedRoutes(surviving), policy.allowedModels)
        if (allowed === undefined) {
          const wouldBe = surviving[0]
          if (wouldBe?.model !== undefined) {
            deps.log.warn(
              'llm-fallbacks: agent "%s" fallback switch %s/%s blocked: resolved candidates are all outside the subagent allowlist — no switch',
              owner,
              wouldBe.provider,
              wouldBe.model,
            )
            deps.recordBlocked?.(owner, { provider: wouldBe.provider, model: wouldBe.model }, 'trigger-code')
          }
          return undefined
        }
        return { target: allowed, candidates: annotated }
      }
    }
    const first: Selector | undefined = surviving[0]
    if (first?.model === undefined) return undefined
    return { target: { provider: first.provider, model: first.model }, candidates: annotated }
  }

  // Attempt 1 is the chain head — unless cross-call memory already cooled it,
  // in which case the walk resumes at the next surviving candidate (the
  // llm-retry re-entry contract). A chain whose every candidate is cooled has
  // no replacement: the head is still attempted, so a request is never left
  // without an answer.
  let target: EffectiveHead = head
  if (isCooled(selectorKey(head.provider, head.model))) {
    target = (await advanceFrom(head))?.target ?? head
  }
  let switches = 0

  for (;;) {
    const key = selectorKey(target.provider, target.model)
    const state = stateOf()
    // P2 rule 4: the once-per-episode half-open probe admission — one info
    // line per episode, not a gate (there is no admission limit).
    if (
      (config.recovery ?? 'timer') === 'half-open' &&
      state !== undefined &&
      state.recovery.tryMarkProbeLogged(key)
    ) {
      deps.log.info(
        'llm-fallbacks: agent "%s" half-open probe %s/%s (role=%s, reason=%s)',
        owner ?? '',
        target.provider,
        target.model,
        role,
        'trigger-code',
      )
    }

    // §3.1 step 3: yield every chunk as it arrives. The FIRST yielded chunk
    // commits the attempt — from then on a failure belongs to the upper layers
    // and is never replayed (§6.1.4).
    let committed = false
    let swallowed: { chunk: StreamChunk; code: string } | undefined
    for await (const chunk of llm.stream({ ...options, provider: target.provider, model: target.model, messages })) {
      const failure = chunk.type === 'finish' && chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
      if (failure !== undefined && !committed && config.triggerCodes.includes(failure.code)) {
        swallowed = { chunk, code: failure.code }
        break
      }
      yield chunk
      committed = true
      if (chunk.type === 'finish') {
        // A normal finish is attempt-level success (the route-keyed half-open
        // closure, §3.3); an aborted finish is neither success nor a trigger.
        if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted' && state !== undefined) {
          deps.states.observeSuccess(state, key)
        }
        return
      }
    }
    // A stream that ends with no terminal chunk yields no finish of its own —
    // the adapter never produced one, so the walk has nothing to add.
    if (swallowed === undefined) return

    failedKeys.add(key)
    if (!REQUEST_SCOPED_CODES.has(swallowed.code)) coolRoute(target)
    // §3.1 step 4: no surviving candidate, or the switch cap reached — the
    // last attempt's terminal failure is re-emitted verbatim.
    const next = switches < config.maxSwitchesPerStep ? await advanceFrom(target, swallowed.code) : undefined
    if (next === undefined) {
      yield swallowed.chunk
      return
    }
    switches += 1
    deps.log.info(
      'llm-fallbacks: agent "%s" fallback switch (降级切换) %s/%s -> %s/%s (role=%s, reason=%s, candidates=%o)',
      owner ?? '',
      target.provider,
      target.model,
      next.target.provider,
      next.target.model,
      role,
      'trigger-code',
      next.candidates,
    )
    target = next.target
  }
}
