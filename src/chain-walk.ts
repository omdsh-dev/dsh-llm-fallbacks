/**
 * The chain walk (design dsh-022-rc1-upgrade §2/§3/§6.1): the fallback
 * decision, executed inside the virtual `FallbacksChain/Auto` adapter's
 * `stream()` instead of on the `agent/request` / `agent/request-error`
 * waterfalls.
 *
 * One walk per `stream()` call: resolve the selected named chain and its
 * slot-effective tail, then attempt the chain's heads in order. Root and
 * subagent walks are the SAME shape — every walk is the selected chain. A
 * pre-output terminal `finish` whose failure code is a trigger code is
 * swallowed, booked (cooldown / recovery) and the walk advances; anything
 * else — a normal finish, an aborted finish, a non-trigger failure, or any
 * failure after the attempt already yielded output — is forwarded verbatim
 * and ends the walk. A `usage` chunk is metadata, so it neither commits the
 * attempt nor stops the advance.
 *
 * A pre-output parameter rejection (`UNSUPPORTED_REASONING_EFFORT`, or a
 * `max_tokens`-shaped `INVALID_REQUEST`) is repaired first: the SAME candidate
 * is retried once with the offending control dropped, because a route that
 * discloses no capability only reveals its real cap through that rejection.
 *
 * The COMMITTED rule (§3.1 / §7.5) is why a post-output failure cannot be
 * replayed: yielded chunks cannot be unsent, so a second provider's output
 * cannot be concatenated behind a partial one. Such a failure is still BOOKED
 * (cooldown / recovery) before it is forwarded — the attempt boundary is where
 * both transactions happen — and then surfaces to the loop, which settles the
 * partial attempt; llm-retry (or the terminal error) takes over from there, and
 * a retry re-enters this walk, which resumes past the cooled head on its own.
 *
 * Bookkeeping survives a walk exactly as far as the state store does: cooldown
 * (`cooldownMs` / `revertPolicy` / half-open escalation) is the cross-call
 * memory keyed by session, so an llm-retry re-entry starts past a failed head;
 * the per-call failed set and the switch cap live only for this walk
 * (`maxSwitchesPerStep` = switches per walk, attempts ≤ cap + 1).
 *
 * The pre-attempt guards (`UNKNOWN_CHAIN` / `EMPTY_EFFECTIVE_CHAIN` /
 * `UNDISPATCHABLE_EFFECTIVE_HEAD` / `LLM_UNAVAILABLE`) are owned here, and
 * `slotWinners` carries the per-(agent, chain) 分时切换 rotation log.
 *
 * @module dsh-llm-fallbacks/chain-walk
 */

import {
  LlmError,
  type GenerateOptions,
  type LlmFailure,
  type LlmRuntime,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  annotateCandidates,
  createCandidateFilter,
  hasWildcardEntry,
  resolveChainViews,
  selectCandidates,
  type AnnotatedCandidate,
  type FailingModel,
} from './chains.ts'
import type { FallbacksConfig, NamedChain } from './config.ts'
import { escalatedCooldownMs } from './recovery.ts'
import { selectorKey, type Selector } from './selectors.ts'
import type { FallbackStateStore } from './state.ts'
import { resolveEffectiveChain, isAllDayConforming, resolveSlotState, type SlotRowConfig } from './time-slots.ts'
import {
  FALLBACKS_PROVIDER,
  firstDispatchableExactHead,
  type EffectiveHead,
} from './virtual-adapter.ts'

/**
 * `LlmError` code: the effective chain is empty — the selected named chain has
 * no entries to walk (the pre-attempt guard; the walk is the only point that
 * knows WHICH chain the session selected, `options.model` being the chain id).
 */
export const EMPTY_EFFECTIVE_CHAIN_CODE = 'EMPTY_EFFECTIVE_CHAIN'
/**
 * `LlmError` code: the chain cannot be walked — its entries tail is not
 * conforming (the last entry must be exactly one official model), or no entry
 * is a dispatchable real pair (wildcard selector, malformed selector, or a
 * self-route back to `FallbacksChain/*` — the recursion guard).
 */
export const UNDISPATCHABLE_HEAD_CODE = 'UNDISPATCHABLE_EFFECTIVE_HEAD'
/**
 * `LlmError` code: `options.model` names no declared chain — reachable only
 * once a chain the session selected is deleted or renamed (the migrated
 * default id `Auto` is unchanged, so an upgrade alone never hits this).
 * Thrown synchronously before any chunk; the host surfaces a terminal error
 * finish and the user re-selects in the picker. No silent fallback to
 * another chain — picking the wrong named chain silently would be a
 * data-routing surprise.
 */
export const UNKNOWN_CHAIN_CODE = 'UNKNOWN_CHAIN'
/** `LlmError` code (defensive): the `llm` runtime disappeared mid-flight. */
export const LLM_UNAVAILABLE_CODE = 'LLM_UNAVAILABLE'

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
 * The exact-route capabilities a walk reads from `resolveModelInfo`: the
 * context window (wildcard / overflow expansions) plus the two request
 * controls parameter adaptation compares against. Every field is optional — a
 * host that discloses nothing leaves every request untouched.
 */
interface ModelInfoLike {
  context?: { contextWindow?: number }
  defaultMaxTokens?: number
  reasoning?: { efforts: readonly { id: string; name: string }[] }
}

/**
 * Model-catalog view the wildcard / context-window probes read. `contextWindow`
 * is a host-disclosed extra on the advisory catalog row (the dsh `LlmModelInfo`
 * does not type it), while `resolveModelInfo` is where the host actually
 * carries it — both are optional and read structurally, so a host offering
 * neither reports every window as unknown (never a skip).
 */
export interface ModelCatalogLike {
  listModels(provider: string): Promise<readonly { id: string; contextWindow?: number }[]>
  resolveModelInfo?(provider: string, model: string): Promise<ModelInfoLike>
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
 * The per-walk capability lookup behind parameter adaptation: one
 * `resolveModelInfo` per `provider/model`, cached for the walk (an attempt is
 * dispatched once per route, but the head may be resolved again on re-entry).
 * TOTAL — a missing catalog, a throwing probe or malformed metadata reads as
 * UNKNOWN (`undefined`), and unknown always keeps the request unchanged.
 */
function makeModelInfoOf(
  catalog: ModelCatalogLike | undefined,
): (provider: string, model: string) => Promise<ModelInfoLike | undefined> {
  const resolveModelInfo = catalog?.resolveModelInfo?.bind(catalog)
  if (resolveModelInfo === undefined) return () => Promise.resolve(undefined)
  const cache = new Map<string, Promise<ModelInfoLike | undefined>>()
  return (provider, model) => {
    const key = selectorKey(provider, model)
    let info = cache.get(key)
    if (info === undefined) {
      info = (async () => {
        try {
          return await resolveModelInfo(provider, model)
        } catch {
          // Fail open: an unreadable capability never rewrites the request.
          return undefined
        }
      })()
      cache.set(key, info)
    }
    return info
  }
}

/**
 * A request control the walk can drop from a request: proactively when the
 * candidate's disclosed capabilities exclude it, reactively when the adapter
 * itself rejects it (plan 2026-11-07 T2). Proactive adaptation only covers
 * disclosed capabilities; a route that discloses no `defaultMaxTokens` yet
 * rejects the request still has to be repaired from its own rejection signal.
 */
type RepairableControl = 'reasoningEffort' | 'maxTokens'

/**
 * Adapt one dispatch to the candidate's declared capabilities (plan
 * 2026-11-07 T2): DROP a request control the exact route cannot serve —
 * `reasoningEffort` it does not list, `maxTokens` above its disclosed
 * `defaultMaxTokens` — instead of clamping or aliasing it. Unknown capability
 * (`undefined`) or unreadable metadata keeps `options` byte-for-byte unchanged,
 * so a host that discloses nothing behaves exactly as before.
 *
 * A drop is logged at debug level: a served request with a smaller budget than
 * the caller asked for is otherwise indistinguishable from a normal turn.
 */
async function adaptForTarget(
  options: GenerateOptions,
  target: EffectiveHead,
  modelInfoOf: (provider: string, model: string) => Promise<ModelInfoLike | undefined>,
  debug?: (message: string, ...args: unknown[]) => void,
): Promise<GenerateOptions> {
  // Nothing inherited to adapt: no probe, no behavior change.
  if (options.reasoningEffort === undefined && options.maxTokens === undefined) return options
  const info = await modelInfoOf(target.provider, target.model)
  if (info === undefined || info === null) return options
  let adapted: GenerateOptions
  const dropped: RepairableControl[] = []
  try {
    adapted = { ...options }
    const effort = options.reasoningEffort
    // Drop only on a DISCLOSED capability list, like the maxTokens branch below:
    // a route whose metadata omits `reasoning` is unknown, not "supports none".
    if (effort !== undefined
      && info.reasoning !== undefined
      && !(info.reasoning.efforts ?? []).some((supported) => supported.id === effort)) {
      delete adapted.reasoningEffort
      dropped.push('reasoningEffort')
    }
    const maxTokens = options.maxTokens
    if (maxTokens !== undefined && info.defaultMaxTokens !== undefined && maxTokens > info.defaultMaxTokens) {
      delete adapted.maxTokens
      dropped.push('maxTokens')
    }
  } catch {
    // Malformed metadata reads as unknown; the request goes out unchanged.
    return options
  }
  if (dropped.length > 0) {
    // The sink runs OUTSIDE the adaptation try, and its own fault is swallowed:
    // a logger failure must never cancel the drop (I-000118).
    try {
      debug?.(
        'llm-fallbacks: parameter adaptation candidate=%s/%s dropped=%s',
        target.provider,
        target.model,
        dropped.join(','),
      )
    } catch { /* a sink fault is not an adaptation fault */ }
  }
  return adapted
}

/**
 * The provider's own `max_tokens` RANGE rejection: the parameter, immediately
 * followed (within one clause) by one of the range/validity words providers use
 * — `max_tokens参数非法：限制数值范围[1,131072]` / `max_tokens: 384000 is
 * invalid`. A message that merely MENTIONS the parameter (prompt-token-limit
 * prose) must not qualify, so the word requirement and the short gap are both
 * part of the shape, not decoration.
 */
const MAX_TOKENS_REJECTION = /max_tokens[\s\S]{0,40}?(非法|invalid|range|范围|exceed|too\s+large)/i

/**
 * The control an attempt's own pre-output failure says the route cannot serve,
 * or `undefined` when the failure is not a parameter rejection.
 *
 * Matched on the adapter's stable codes, declared as literals for the same
 * reason `triggerCodes` is `string[]` (the plugin compares failure codes as
 * plain strings and imports no peer value): `UNSUPPORTED_REASONING_EFFORT` when
 * the attempt carried an effort, and a `max_tokens`-shaped `INVALID_REQUEST`
 * when it carried a cap.
 */
function repairableControl(failure: LlmFailure, options: GenerateOptions): RepairableControl | undefined {
  if (failure.code === 'UNSUPPORTED_REASONING_EFFORT') {
    return options.reasoningEffort === undefined ? undefined : 'reasoningEffort'
  }
  if (failure.code === 'INVALID_REQUEST' && options.maxTokens !== undefined
    && MAX_TOKENS_REJECTION.test(failure.message)) {
    return 'maxTokens'
  }
  return undefined
}

/** NUL separator: neither an agent id nor a chain id (`CHAIN_ID_PATTERN`) can contain it. */
const SLOT_MARKER_SEPARATOR = '\u0000'

/**
 * Key of one (agent, chain) 分时切换 marker. Both the walk's write and the
 * wiring's `agent/disposed` cleanup build keys through here, so the two halves
 * of the contract cannot drift apart.
 */
export function slotMarkerKey(agentId: string, chainId: string): string {
  return agentId + SLOT_MARKER_SEPARATOR + chainId
}

/** Key prefix covering every chain marker of one agent (the cleanup sweep). */
export function slotMarkerPrefix(agentId: string): string {
  return agentId + SLOT_MARKER_SEPARATOR
}

/** Everything one walk reads from the plugin wiring. */
export interface ChainWalkDeps {
  readConfig(): FallbacksConfig
  getLlm(): LlmRuntime | undefined
  states: FallbackStateStore
  /**
   * Per-(agent, chain id) last time-slot winner (P7 分时切换 marker): the
   * caller owns the map (re-baselined on a settings change, cleared on
   * dispose), the walk reads and writes it — the log only, never a failure
   * decision. Absent ⇒ no log.
   */
  slotWinners?: Map<string, { key: string; label: string }>
  log: {
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    /** Optional: the request-rewriting lines (parameter adaptation) are diagnostics only. */
    debug?(message: string, ...args: unknown[]): void
  }
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
    if (source.provider !== FALLBACKS_PROVIDER) return message
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
  /** The walk's single clock read (slot resolution + rotation log agree). */
  now: Date
  chain: NamedChain
  /** The slot-effective entries this walk attempts (head first). */
  entries: readonly string[]
  head: EffectiveHead
  llm: LlmRuntime
  owner: SessionKey | undefined
}

/**
 * Stable identity of a slot winner for the 分时切换 marker (P7): preset rows
 * key by their frozen id, custom rows by their window — a chain-only edit keeps
 * the SAME logical row (no spurious rotation log), while a window/preset change
 * or a new matching row reads as a switch. `'all-day'` is the no-extra-row
 * winner.
 */
function slotWinnerKey(winner: SlotRowConfig | 'all-day'): string {
  if (winner === 'all-day') return 'all-day'
  return winner.kind === 'preset'
    ? `preset:${winner.preset}`
    : `custom:${winner.start}-${winner.end}`
}

/**
 * P7 分时切换 detection, keyed per (agent, chain id): gated on THAT chain's
 * conformance and at least one slot row (the gate every slot surface reads —
 * `resolveSlotState` already reports `'all-day'`, but the explicit gate keeps
 * a non-conforming chain completely inert). Every chain logs its own rotation.
 * A winner different from this agent's last seen winner on this chain is a
 * time-slot switch — a ROUTING SEED, not a failure decision: info log only,
 * no cooldown, no switch count, no chain switch. A settings edit re-baselines
 * the marker (the caller clears the map), so a config change never logs as a
 * rotation.
 */
function logSlotRotation(deps: ChainWalkDeps, start: WalkStart): void {
  const { config, now, chain, owner } = start
  const markers = deps.slotWinners
  if (markers === undefined || owner === undefined) return
  if (!isAllDayConforming(chain.entries) || (chain.timeSlots?.length ?? 0) === 0) return
  const slot = resolveSlotState(chain, now, config.tz ?? 'Asia/Shanghai')
  const markerKey = slotMarkerKey(owner, chain.id)
  const key = slotWinnerKey(slot.winner)
  const previous = markers.get(markerKey)
  if (previous !== undefined && previous.key !== key) {
    deps.log.info(
      'llm-fallbacks: agent "%s" time-slot switch (分时切换) on chain "%s": %s -> %s',
      owner,
      chain.id,
      previous.label,
      slot.label,
    )
  }
  markers.set(markerKey, { key, label: slot.label })
}

/**
 * Resolve the walk's start state, throwing the pre-attempt `LlmError`s —
 * synchronously, before any chunk, so the runtime's adapter boundary
 * normalizes them into one terminal error finish.
 */
function resolveWalk(deps: ChainWalkDeps, options: GenerateOptions): WalkStart {
  const config = deps.readConfig()
  // The walk's ONE clock read: the chain tail and the slot-rotation log read
  // this instant, so a request landing on a slot boundary cannot anchor to
  // two different slots.
  const now = new Date()
  const owner = options.sessionId
  const chain = config.chains.find((entry) => entry.id === options.model)
  if (chain === undefined) {
    throw new LlmError(
      `llm-fallbacks: unknown virtual chain "${String(options.model)}" — re-select a chain in the model picker`,
      UNKNOWN_CHAIN_CODE,
    )
  }
  const entries = resolveEffectiveChain(chain, now, config.tz ?? 'Asia/Shanghai')
  if (entries.length === 0) {
    throw new LlmError(
      'llm-fallbacks: the effective chain is empty — the virtual FallbacksChain route has no head to delegate to',
      EMPTY_EFFECTIVE_CHAIN_CODE,
    )
  }
  // Conformance gate (PR #62 semantics, per chain): a non-conforming entries
  // tail earns no delegate even though the picker row is visible. Same gate
  // for every walk — there is no origin split any more.
  if (!isAllDayConforming(chain.entries)) {
    throw new LlmError(
      'llm-fallbacks: the chain is not conforming (exactly one official model required) — refusing to delegate',
      UNDISPATCHABLE_HEAD_CODE,
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
  return { config, now, chain, entries, head, llm, owner }
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
  /** The next attempt target; absent when no candidate survives. */
  target?: EffectiveHead
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
  const { config, chain, head, llm, owner } = start
  // P7 分时切换 log — a routing seed observation, never a failure decision.
  logSlotRotation(deps, start)
  // §3.2 adaptation: before each dispatch the request is narrowed to what THAT
  // candidate declares it can serve (drop-only, fail open). The pre-C override
  // path rewrote a seed config on a route change; the walk keeps the seed and
  // adapts only the per-attempt copy below.
  const modelInfoOf = makeModelInfoOf(llm)
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
   * Book one failed attempt at the attempt boundary (§3.3): the per-call
   * failed key, plus the route-scoped cooldown (a request-scoped code leaves
   * the healthy route uncooled). Booking is INDEPENDENT of the swallow/switch
   * decision — a failure after output is forwarded and ends this walk, yet the
   * next walk must still see that head as dead.
   */
  const bookFailure = (failed: EffectiveHead, code: string): void => {
    failedKeys.add(selectorKey(failed.provider, failed.model))
    if (!REQUEST_SCOPED_CODES.has(code)) coolRoute(failed)
  }

  /**
   * Expand the chain from the route that just failed and return the next
   * attempt target, or `undefined` when nothing survives (chain exhausted).
   *
   * Runs per failure. The filters keep their meaning: `same-as-current` is
   * the route that just failed, cooldown is the cross-call memory, the
   * per-call failed set is the walk's own memory, the wildcard probe applies
   * to `provider/*` entries only, and the context-window filter exists only
   * for a `CONTEXT_WINDOW_EXCEEDED` trigger. `from.provider/model` also
   * anchors wildcard expansion: `provider/*` keeps the request's model id and
   * swaps only the provider.
   */
  const advanceFrom = async (from: EffectiveHead, failureCode?: string): Promise<Advance | undefined> => {
    const { all, wildcard } = resolveChainViews(
      start.entries,
      from.provider,
      from.model,
      deps.log.warn,
    )
    // Recursion guard (§6.1.2): an entry that routes back into this adapter is
    // not a candidate at all — never dispatched, never annotated. Correctly
    // treats `FallbacksChain/<other-chain-id>` entries as self-routes too.
    const own = all.map((candidate) => candidate.provider !== FALLBACKS_PROVIDER)
    const candidates = all.filter((_, index) => own[index])
    const wildcards = wildcard.filter((_, index) => own[index])
    const exists = hasWildcardEntry(start.entries)
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
    // 行为可见性: the log shows the attempt order AND why each candidate was
    // skipped; survivors (including the target) are unlabelled.
    const annotated = annotateCandidates(candidates, surviving, { current: from, cooldown, failed, minContextWindow, contextWindowOf })
    const describeCandidates = (list: readonly AnnotatedCandidate[]): string[] => list.map(({ candidate, skip }) => skip === undefined
      ? `${candidate.provider}/${candidate.model}`
      : `${candidate.provider}/${candidate.model} (skipped: ${skip})`)
    const first: Selector | undefined = surviving[0]
    if (first?.model === undefined) return { candidates: describeCandidates(annotated) }
    return { target: { provider: first.provider, model: first.model }, candidates: describeCandidates(annotated) }
  }

  // Attempt 1 is the chain head — unless cross-call memory already cooled it,
  // in which case the walk resumes at the next surviving candidate (the
  // llm-retry re-entry contract). A chain whose every candidate is cooled has
  // no replacement: the head is still attempted, so a request is never left
  // without an answer.
  let target: EffectiveHead
  if (isCooled(selectorKey(head.provider, head.model))) {
    const advance = await advanceFrom(head)
    target = advance?.target ?? head
  } else {
    target = head
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
        'llm-fallbacks: agent "%s" half-open probe %s/%s (chain=%s, reason=%s)',
        owner ?? '',
        target.provider,
        target.model,
        chain.id,
        'trigger-code',
      )
    }

    // §3.1 step 3: yield every chunk as it arrives. The first OUTPUT chunk
    // commits the attempt — from then on a failure belongs to the upper layers
    // and is never replayed (§6.1.4). A `usage` chunk is metadata, not output:
    // adapters emit it BEFORE the terminal finish, so committing on it would
    // make the triggerCodes swallow branch unreachable for every such provider.
    // Everything else — including a block START — is output and commits: a
    // switch after an opened block would pour the next candidate's deltas into
    // this attempt's partial block, which assembly then drops (QC2 option b).
    // The flag LATCHES: once committed, a later `usage` must not un-commit it.
    let committed = false
    let swallowed: { chunk: StreamChunk; code: string } | undefined
    let attemptOptions = await adaptForTarget(options, target, modelInfoOf, deps.log.debug)
    // T2 reactive repair: controls already repaired ONCE on this candidate. A
    // repair is a request fix, not a chain switch — it books nothing and spends
    // no switch — so its only state is this per-candidate set, which makes a
    // second identical rejection a forwarded failure instead of a loop.
    const repaired = new Set<RepairableControl>()
    for (;;) {
      committed = false
      swallowed = undefined
      let repair: RepairableControl | undefined
      // Pre-output `usage` is buffered, not yielded: a repair re-streams this
      // attempt, and the rejected request's usage must not reach the consumer
      // (pinned: one usage chunk per logical attempt). Any other chunk flushes
      // the buffer first, preserving arrival order.
      const pendingUsage: StreamChunk[] = []
      for await (const chunk of llm.stream({ ...attemptOptions, provider: target.provider, model: target.model, messages })) {
        const failure = chunk.type === 'finish' && chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
        if (failure !== undefined && !committed) {
          // The adapter's own rejection outranks the trigger-code rule: the same
          // candidate can serve this request once the offending control is gone,
          // and a repair keeps the walk on the cheapest route.
          const repairable = repairableControl(failure, attemptOptions)
          if (repairable !== undefined && !repaired.has(repairable)) {
            repair = repairable
            break
          }
          if (config.triggerCodes.includes(failure.code)) {
            swallowed = { chunk, code: failure.code }
            break
          }
        }
        if (chunk.type === 'finish') {
          // Both attempt-boundary transactions run BEFORE the terminal chunk is
          // delivered: a consumer that stops on `finish` closes this generator at
          // that yield, so anything written after it would never run.
          if (failure === undefined) {
            // A normal finish is attempt-level success (the route-keyed half-open
            // closure, §3.3); an aborted finish is neither success nor a trigger.
            if (chunk.reason.kind !== 'aborted' && state !== undefined) {
              deps.states.observeSuccess(state, key)
            }
          } else if (config.triggerCodes.includes(failure.code)) {
            // A failure after output is forwarded verbatim and never replayed;
            // booking it is all this walk keeps from it.
            bookFailure(target, failure.code)
          }
          for (const pending of pendingUsage) yield pending
          pendingUsage.length = 0
          yield chunk
          return
        }
        if (chunk.type === 'usage' && !committed) {
          pendingUsage.push(chunk)
          continue
        }
        for (const pending of pendingUsage) yield pending
        pendingUsage.length = 0
        yield chunk
        if (chunk.type !== 'usage') committed = true
      }
      if (repair === undefined) {
        // Not repaired: the attempt is kept (a swallowed switch or forwarded
        // failure), so its buffered usage is delivered before the walk moves on.
        for (const pending of pendingUsage) yield pending
        break
      }
      repaired.add(repair)
      // A narrowed COPY: `adaptForTarget` may hand back the caller's own options.
      attemptOptions = { ...attemptOptions }
      delete attemptOptions[repair]
      deps.log.info(
        'llm-fallbacks: agent "%s" parameter repair (参数修复) candidate=%s/%s dropped=%s',
        owner ?? '',
        target.provider,
        target.model,
        repair,
      )
    }
    // A stream that ends with no terminal chunk yields no finish of its own —
    // the adapter never produced one, so the walk has nothing to add.
    if (swallowed === undefined) return

    bookFailure(target, swallowed.code)
    // §3.1 step 4: no surviving candidate, or the switch cap reached — the
    // last attempt's terminal failure is re-emitted verbatim.
    const next = switches < config.maxSwitchesPerStep ? await advanceFrom(target, swallowed.code) : undefined
    if (next === undefined || next.target === undefined) {
      yield swallowed.chunk
      return
    }
    switches += 1
    deps.log.info(
      'llm-fallbacks: agent "%s" fallback switch (降级切换) %s/%s -> %s/%s (chain=%s, reason=%s, candidates=%o)',
      owner ?? '',
      target.provider,
      target.model,
      next.target.provider,
      next.target.model,
      chain.id,
      'trigger-code',
      next.candidates,
    )
    target = next.target
  }
}
