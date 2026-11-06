/**
 * Virtual `FallbacksChain/Auto` LLM adapter (plan fallbacks-virtual-chain
 * Task 1, technical pins P1–P3; PR #62 feedback round): a mount-only
 * catalog row that makes the configured effective chain selectable as the
 * session **primary** in the host model picker, without patching dsh or
 * dsh-TUI (web and TUI share the adapter catalog).
 *
 * Wiring (P2): `installFallbacksAdapter` installs ONE conditional
 * `ctx.inject(['llm'])` child — absent `llm` service (test harness) is a
 * clean no-op, and fiber unload ⇒ the child's disposer unregisters the
 * route. Registration is an idempotent transition-reconcile on COMMITTED
 * config snapshots: register when nothing is configured → something is
 * (`isFallbackActive` — content presence, plan fallbacks-web-ux-alignment
 * T2), unregister on the reverse, driven by the settings `onChange` hook
 * (the returned reconcile thunk, wired by `apply()`) plus child activation.
 * The row is visible whenever something is configured — a non-conforming
 * all-day chain does NOT hide it (PR #62 feedback); conformance still gates
 * a successful delegate (`effectiveHeadOf` below refuses a non-conforming
 * all-day). The registration gate is `isFallbackActive` content presence
 * (`rootChain` / `timeSlots` / declared roles): a slot-row edit that flips
 * that gate (e.g. removing the only slot while `rootChain` and roles are
 * empty) intentionally churns registration — the content-presence contract
 * (plan fallbacks-web-ux-alignment T2), not churn to design away; do NOT
 * re-narrow the condition to ignore `timeSlots`. Conformance-only chain
 * edits still never churn (conformance gates the delegate, not the row).
 *
 * Adapter behavior (P1/P3, direction C): `listModels` advertises exactly the
 * one virtual row; `stream()` WALKS the session's chain (cooldown / failed-set
 * / switch cap / recovery bookkeeping) in `src/chain-walk.ts` — the walk is
 * injected at install and owns the pre-attempt guards, so this module stays
 * the catalog + metadata surface. `resolveModel` proxies the current effective
 * head's metadata when resolvable (modalities/context-window/reasoning follow
 * the head) with a permissive default otherwise — never throws.
 * `providerRetryPolicy` and `imageRequestPricing` mirror the same head for the
 * host-captured retry policy and the token meter — also never throwing.
 *
 * @module dsh-llm-fallbacks/virtual-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmImageRequestPricing,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type LlmRuntime,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { isFallbackActive, type FallbacksConfig } from './config.ts'
import { routeOnAllowlist } from './route-allowlist.ts'
import type { PolicyRoute } from './subagent-policy.ts'
import { parseSelector, type Selector } from './selectors.ts'
import { isAllDayConforming, resolveEffectiveChain, resolveSlotState } from './time-slots.ts'

/** Provider route of the virtual adapter (exact string, spec lock). */
export const FALLBACKS_PROVIDER = 'FallbacksChain'
/**
 * Model id of the virtual catalog row (exact string, spec lock). "Auto" is
 * the hardcoded picker id (not i18n — user decision 2026-08-18). The
 * catalog `name` the host picker renders is dynamic — see
 * {@link pickerDisplayName} (`Auto: <model>[<slot>]`).
 */
export const FALLBACKS_CHAIN_MODEL = 'Auto'

/** One dispatchable exact head: `provider/model`. Wildcards are never seeds (P3). */
export interface EffectiveHead {
  provider: string
  model: string
}

/**
 * The FIRST DISPATCHABLE exact head of a chain — the single definition of
 * "effective head" (F-001) shared by this module's metadata paths
 * (`pickerDisplayName` / `resolveModel` / `providerRetryPolicy` /
 * `imageRequestPricing`), the walk's head and served-route resolution
 * (`servedRouteOf` in `src/chain-walk.ts`), and the seam's mount gate
 * (`injectRoute` in `src/subagents-seam.ts`). Walks the SAME chain
 * `resolveEffectiveChain` produces, skipping entries that can never
 * be dispatched: malformed selectors (config-warning path), `provider/*`
 * `provider/*` wildcards (no real pair), and self-routes back to
 * `FallbacksChain/*` (the P1 recursion guard). `undefined` when the chain
 * is empty or no entry is dispatchable.
 *
 * `allowedModels` (spec D1) additionally restricts the result to the host
 * subagent allowlist: a PLUGIN-originated route is only ever attempted on a
 * route the host authorizes, so the seam's mount gate and a plugin-originated
 * walk's start pass the enabled policy's list and an entry it excludes is
 * skipped like any other non-dispatchable entry. An empty intersection is
 * `undefined` — the caller declines the mount / refuses the walk.
 */
export function firstDispatchableExactHead(
  chain: readonly string[],
  allowedModels?: readonly PolicyRoute[],
): EffectiveHead | undefined {
  for (const entry of chain) {
    let selector: Selector
    try {
      selector = parseSelector(entry)
    } catch {
      continue // malformed chain entries (hand-written YAML) are never dispatch targets
    }
    if (selector.model === undefined) continue // wildcard: no real pair to delegate
    if (selector.provider === FALLBACKS_PROVIDER) continue // self-route: recursion guard
    const head = { provider: selector.provider, model: selector.model }
    if (allowedModels !== undefined && !routeOnAllowlist(head, allowedModels)) continue
    return head
  }
  return undefined
}

/**
 * The effective chain head at `now` (P1): the first DISPATCHABLE exact head
 * of the SAME `resolveEffectiveChain` the routing engine uses — thin
 * config+clock entry into the shared {@link firstDispatchableExactHead} (no
 * divergent skip/walk rules). `undefined` when the chain is empty or no
 * entry is dispatchable (wildcard, self-route to `FallbacksChain/*`,
 * malformed selector).
 *
 * Conformance gate (PR #62 feedback): the all-day `rootChain` must be
 * conforming (exactly one official model — Flash or Pro)
 * for a successful delegate —
 * a legacy multi-model (or empty) all-day chain earns no primary
 * semantics even though the picker row is visible. `resolveModel` then
 * falls back to the permissive default. The delegate side of that gate is the
 * chain walk's ROOT-origin rule (`UNDISPATCHABLE_EFFECTIVE_HEAD`); a subagent
 * walks its role chain instead, so the all-day shape never gates a child.
 */
export function effectiveHeadOf(config: FallbacksConfig, now: Date): EffectiveHead | undefined {
  if (!isAllDayConforming(config.rootChain)) return undefined
  const chain = resolveEffectiveChain(config, now, config.tz ?? 'Asia/Shanghai')
  return firstDispatchableExactHead(chain)
}

/**
 * Host picker label: `Auto: <displayName>[<slot>]`.
 * Display name first so the trigger stays readable and platforms stay
 * distinguishable (catalog `name`, not the model id). Bare `Auto` when
 * there is no dispatchable head. Slot label from {@link resolveSlotState}.
 * @param modelDisplayName - catalog/resolved name; falls back to the id.
 */
export function pickerDisplayName(
  config: FallbacksConfig,
  now: Date = new Date(),
  modelDisplayName?: string,
): string {
  const head = effectiveHeadOf(config, now)
  if (head === undefined) return FALLBACKS_CHAIN_MODEL
  const slot = resolveSlotState(config, now, config.tz ?? 'Asia/Shanghai')
  const model = modelDisplayName !== undefined && modelDisplayName !== '' ? modelDisplayName : head.model
  return `${FALLBACKS_CHAIN_MODEL}: ${model}[${slot.label}]`
}

/** Catalog `name` for a head pair; id if the provider is not listed. */
async function resolveHeadDisplayName(llm: LlmRuntime | undefined, head: EffectiveHead): Promise<string> {
  if (llm === undefined) return head.model
  try {
    const listed = await llm.listModels(head.provider)
    const row = listed.find(model => model.id === head.model)
    if (row !== undefined && row.name !== '') return row.name
  } catch {
    // Provider not registered or list failed — try resolveModelInfo.
  }
  try {
    const info = await llm.resolveModelInfo(head.provider, head.model)
    if (info.name !== '') return info.name
  } catch {
    // Unresolvable — caller keeps the id.
  }
  return head.model
}

/**
 * The virtual adapter (P1/P3). `stream()` hands the call to the injected walk
 * (see `src/chain-walk.ts`) — registration metadata stays here.
 */
export class FallbacksChainAdapter extends LlmAdapter {
  constructor(
    private readonly readConfig: () => FallbacksConfig,
    private readonly getLlm: () => LlmRuntime | undefined,
    private readonly walk: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ) {
    super()
  }

  /** Minimal honest descriptor (P3) — the provider route IS the display name. */
  override providerInfo(provider: string) {
    return { id: provider, name: FALLBACKS_PROVIDER }
  }

  /** Advisory catalog: one virtual row; `name` is the live picker label. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.readConfig()
    const now = new Date()
    const head = effectiveHeadOf(config, now)
    const display = head === undefined ? undefined : await resolveHeadDisplayName(this.getLlm(), head)
    return [{
      provider,
      id: FALLBACKS_CHAIN_MODEL,
      name: pickerDisplayName(config, now, display),
    }]
  }

  /**
   * Proxy the current effective head's model metadata when resolvable (P3):
   * modalities/context-window/reasoning follow the head — the truthful
   * answer for the CURRENT head. Permissive default otherwise; never throws.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const head = effectiveHeadOf(this.readConfig(), new Date())
    const llm = this.getLlm()
    if (head !== undefined && llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(head.provider, head.model, signal)
        return {
          provider,
          id: model,
          name: info.name,
          ...(info.description === undefined ? {} : { description: info.description }),
          ...(info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities }),
          ...(info.context === undefined ? {} : { context: info.context }),
          ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
          ...(info.reasoning === undefined ? {} : { reasoning: info.reasoning }),
        }
      } catch {
        // Head metadata unresolvable (e.g. the head's provider is not
        // registered) — fall through to the permissive default (P3).
      }
    }
    return { provider, id: model, name: model }
  }

  /**
   * Route-accurate retry attribution: the virtual row declares no policy of
   * its own — the virtual `provider` argument is intentionally ignored. The
   * host captures `adapter.providerRetryPolicy(provider) ??
   * resolveRetryPolicy(void 0, …)` ONCE, when a route is registered, so
   * answering here with the SAME policy the concrete head route declared
   * (e.g. a user's `llm-deepseek.retryPolicy`, including `mode: 'always'`)
   * keeps retries behaving exactly as they do on the head `stream()`
   * dispatches. Never throws: an unresolvable head, a vanished `llm`, or an
   * unregistered head provider degrades to `undefined` — the host's own
   * default. That last arm matters: the runtime's lookup THROWS `NO_ADAPTER`
   * for an unknown provider, and this call happens inside the plugin's
   * `registerAdapter`, so an escaping throw would take the whole virtual
   * route down instead of just degrading its policy.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    try {
      const head = effectiveHeadOf(this.readConfig(), new Date())
      // Defensive recursion guard (mirroring imageRequestPricing):
      // `effectiveHeadOf` already refuses self-routes, so a
      // `FallbacksChain/*` head is impossible — assert it anyway so a future
      // resolution change can never re-enter the virtual adapter's own
      // registration.
      if (head === undefined || head.provider === FALLBACKS_PROVIDER) return undefined
      return this.getLlm()?.providerRetryPolicy(head.provider)
    } catch {
      return undefined // unknown provider route → the host's own default
    }
  }

  /**
   * Route-accurate image pricing: the virtual row has no
   * pricing of its own — the virtual `provider`/`model` arguments are
   * intentionally ignored. Resolves the SAME effective head `stream()`
   * dispatches and delegates through the runtime lookup, so the token
   * meter gets exactly the answer the concrete route's adapter would give
   * (including `undefined`). Never throws: an unresolvable head, a
   * vanished `llm`, or a throwing delegate degrades to `undefined` — the
   * token meter's neutral estimate.
   */
  override imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
    try {
      const head = effectiveHeadOf(this.readConfig(), new Date())
      // Defensive recursion guard: `effectiveHeadOf` already refuses
      // self-routes, so a `FallbacksChain/*` head is impossible — assert
      // it anyway so a future resolution change can never recurse image
      // pricing into the virtual adapter itself.
      if (head === undefined || head.provider === FALLBACKS_PROVIDER) return undefined
      return this.getLlm()?.imageRequestPricing(head.provider, head.model)
    } catch {
      return undefined // thrown delegate → the meter's neutral estimate
    }
  }

  /**
   * The virtual route's entry point (P1, direction C): the session's chain is
   * WALKED (`src/chain-walk.ts`) — the walk owns the pre-attempt guards
   * (`EMPTY_EFFECTIVE_CHAIN` / `UNDISPATCHABLE_EFFECTIVE_HEAD` /
   * `LLM_UNAVAILABLE`, thrown synchronously before any chunk, so the runtime
   * normalizes them exactly like an adapter throw) because only it can resolve
   * WHICH chain the calling session walks: a subagent's role chain is not the
   * root's all-day chain, so a root-only gate here would refuse a child that
   * has a perfectly walkable role chain.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.walk(options)
  }
}

/**
 * Install the virtual adapter registration lifecycle (P2).
 *
 * @param ctx - the plugin context.
 * @param readConfig - live config reader (the same `source()` the runtime
 *   reads, so reconcile always sees COMMITTED composed snapshots).
 * @param walk - the chain walk the adapter's `stream()` runs for one virtual
 *   call (built by `apply()` over its live state — see `src/chain-walk.ts`).
 * @returns the reconcile thunk — call it from the settings `onChange` hook
 *   (child activation runs one reconcile on its own).
 */
export function installFallbacksAdapter(
  ctx: Context,
  readConfig: () => FallbacksConfig,
  walk: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
): () => void {
  let llm: LlmRuntime | undefined
  let disposeAdapter: (() => void) | undefined
  let registered = false
  const logger = ctx.logger('llm-fallbacks')
  // The adapter reads the `llm` binding at CALL time (the inject child swaps
  // it as the service appears/disappears) and the config at call time.
  const adapter = new FallbacksChainAdapter(readConfig, () => llm, walk)

  const reconcile = () => {
    const config = readConfig()
    // PR #62 feedback: the row is visible whenever something is configured
    // (`isFallbackActive` — content presence; the removed `enabled` switch is
    // re-keyed to it) — conformance of the all-day chain is NOT part of
    // registration (a legacy/empty chain still earns the row as long as
    // something is configured; the delegate refuses it via
    // `effectiveHeadOf`).
    const shouldRegister = isFallbackActive(config)
    if (shouldRegister && !registered) {
      if (llm === undefined) return
      try {
        disposeAdapter = llm.registerAdapter([FALLBACKS_PROVIDER], adapter)
        registered = true
        logger.info('llm-fallbacks: virtual adapter registered — FallbacksChain/Auto is selectable in the model picker')
      } catch (error) {
        // Multi-fiber dedupe (P2, mirroring the service/gateway/typert
        // children): a later fiber applying over a shared context root hits
        // the runtime's loud duplicate-key failure — the FIRST fiber owns
        // the route while later fibers degrade gracefully. Key on the stable
        // `DUPLICATE_ADAPTER` code, not `instanceof` — the peer module
        // identity can differ across plugin/host boundaries.
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'DUPLICATE_ADAPTER') throw error
        logger.debug('llm-fallbacks: virtual adapter already registered — no route on this fiber (multi-fiber dedupe)')
      }
    } else if (!shouldRegister && registered) {
      disposeAdapter?.()
      disposeAdapter = undefined
      registered = false
      logger.info('llm-fallbacks: virtual adapter unregistered — FallbacksChain/Auto hidden from the model picker')
    }
  }

  ctx.inject(['llm'], (llmCtx) => {
    llm = llmCtx.llm
    reconcile()
    return () => {
      // Fiber unload / `llm` service removal: withdraw the route.
      disposeAdapter?.()
      disposeAdapter = undefined
      registered = false
      llm = undefined
    }
  })

  return reconcile
}
