/**
 * Virtual `FallbacksChain` LLM adapter (named virtual chains, plan
 * named-virtual-chains T2): one provider carrying N model rows — ONE per
 * named chain, the row id BEING the chain id (picker selection is
 * `FallbacksChain/<chain id>`), without patching dsh or dsh-TUI.
 *
 * Wiring: `installFallbacksAdapter` installs ONE conditional
 * `ctx.inject(['llm'])` child — absent `llm` service (test harness) is a
 * clean no-op, and fiber unload ⇒ the child's disposer unregisters the
 * route. Registration is an idempotent transition-reconcile on COMMITTED
 * config snapshots: register when `chains` goes empty → non-empty
 * (`isFallbackActive` = `chains.length > 0`), unregister on the reverse,
 * driven by the settings `onChange` hook (the returned reconcile thunk,
 * wired by `apply()`) plus child activation. A chain with empty or
 * non-conforming `entries` still shows its row (conformance gates the
 * delegate via {@link effectiveHeadOf}, not the row). One
 * `llm.registerAdapter([FALLBACKS_PROVIDER], adapter)` call serves all rows.
 *
 * Adapter behavior: `listModels` advertises one row per chain;
 * `stream()` WALKS the selected chain (cooldown / failed-set / switch cap /
 * recovery bookkeeping) in `src/chain-walk.ts` — the walk is injected at
 * install and owns the pre-attempt guards. `resolveModel` /
 * `imageRequestPricing` resolve the chain FROM the `model` argument and
 * follow its effective head (permissive default otherwise — never throw).
 * `providerRetryPolicy` returns `undefined` (documented degradation): the
 * host captures the policy ONCE per provider at registration, so the virtual
 * route cannot mirror a per-chain head's policy — the host default applies.
 *
@module dsh-llm-fallbacks/virtual-adapter
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
import { isFallbackActive, type FallbacksConfig, type NamedChain } from './config.ts'
import { parseSelector, type Selector } from './selectors.ts'
import { isAllDayConforming, resolveEffectiveChain, resolveSlotState } from './time-slots.ts'

/** Provider route of the virtual adapter (exact string, spec lock). */
export const FALLBACKS_PROVIDER = 'FallbacksChain'
/** One dispatchable exact head: `provider/model`. Wildcards are never seeds (P3). */
export interface EffectiveHead {
  provider: string
  model: string
}

/**
 * The FIRST DISPATCHABLE exact head of a chain — the single definition of
 * "effective head" (F-001) shared by this module's metadata paths
 * (`pickerDisplayName` / `resolveModel` / `imageRequestPricing`) and the
 * walk's head resolution (`resolveWalk` in `src/chain-walk.ts`). Walks the
 * SAME chain `resolveEffectiveChain` produces, skipping entries that can never
 * be dispatched: malformed selectors (config-warning path), `provider/*`
 * `provider/*` wildcards (no real pair), and self-routes back to
 * `FallbacksChain/*` (the P1 recursion guard). `undefined` when the chain
 * is empty or no entry is dispatchable.
 */
export function firstDispatchableExactHead(
  chain: readonly string[],
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
    return { provider: selector.provider, model: selector.model }
  }
  return undefined
}

/**
 * The effective chain head of ONE named chain at `now`: the first
 * DISPATCHABLE exact head of the SAME `resolveEffectiveChain` the walk uses —
 * thin chain+clock entry into the shared {@link firstDispatchableExactHead}.
 * `undefined` when the entries are empty or non-conforming (the tail must be
 * exactly one official model), or no entry is dispatchable (wildcard,
 * self-route to `FallbacksChain/*`, malformed selector). `resolveModel` then
 * falls back to the permissive default; the delegate side of the conformance
 * gate is the chain walk's `UNDISPATCHABLE_EFFECTIVE_HEAD`.
 */
export function effectiveHeadOf(chain: NamedChain, now: Date, tz = 'Asia/Shanghai'): EffectiveHead | undefined {
  if (!isAllDayConforming(chain.entries)) return undefined
  return firstDispatchableExactHead(resolveEffectiveChain(chain, now, tz))
}

/**
 * Host picker label for one chain: `` `${chain.label}: <head>[<slot>]` ``.
 * Bare `chain.label` when there is no dispatchable head. The label is
 * user-editable and display-only; the model id is the chain id.
 */
export function pickerDisplayName(
  chain: NamedChain,
  now: Date = new Date(),
  modelDisplayName?: string,
  tz = 'Asia/Shanghai',
): string {
  const head = effectiveHeadOf(chain, now, tz)
  if (head === undefined) return chain.label
  const slot = resolveSlotState(chain, now, tz)
  const model = modelDisplayName !== undefined && modelDisplayName !== '' ? modelDisplayName : head.model
  return `${chain.label}: ${model}[${slot.label}]`
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

  /** Advisory catalog: ONE row per named chain; `name` is the live picker label. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.readConfig()
    const now = new Date()
    const tz = config.tz ?? 'Asia/Shanghai'
    return Promise.all(config.chains.map(async (chain) => {
      const head = effectiveHeadOf(chain, now, tz)
      const display = head === undefined ? undefined : await resolveHeadDisplayName(this.getLlm(), head)
      return {
        provider,
        id: chain.id,
        name: pickerDisplayName(chain, now, display, tz),
      }
    }))
  }

  /**
   * Model-scoped metadata: resolve the chain FROM the `model` argument (the
   * chain id) and follow its effective head — modalities/context-window/
   * reasoning follow the head, the truthful answer for the CURRENT head.
   * Permissive default for an unknown chain id or an unresolvable head;
   * never throws.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const chain = this.readConfig().chains.find((entry) => entry.id === model)
    const head = chain === undefined ? undefined : effectiveHeadOf(chain, new Date(), this.readConfig().tz ?? 'Asia/Shanghai')
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
        // registered) — fall through to the permissive default.
      }
    }
    return { provider, id: model, name: model }
  }

  /**
   * DOCUMENTED DEGRADATION (named virtual chains): the adapter stays ONE
   * `FallbacksChain` provider carrying N chain rows, but the host captures
   * `adapter.providerRetryPolicy(provider)` ONCE per provider at
   * registration, so the virtual route can no longer mirror its head's
   * retry policy. It returns `undefined` — the host's own default applies.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * Image pricing, model-scoped: resolve the chain FROM the `model`
   * argument and delegate through the runtime lookup for its effective head
   * (including `undefined`). Never throws: an unknown chain id, an
   * unresolvable head, a vanished `llm`, or a throwing delegate degrades to
   * `undefined` — the token meter's neutral estimate.
   */
  override imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined {
    try {
      const chain = this.readConfig().chains.find((entry) => entry.id === model)
      const head = chain === undefined ? undefined : effectiveHeadOf(chain, new Date(), this.readConfig().tz ?? 'Asia/Shanghai')
      if (head === undefined || head.provider === FALLBACKS_PROVIDER) return undefined
      return this.getLlm()?.imageRequestPricing(head.provider, head.model)
    } catch {
      return undefined // thrown delegate → the meter's neutral estimate
    }
  }

  /**
   * The virtual route's entry point: `options.model` IS the chain id and the
   * selected chain is WALKED (`src/chain-walk.ts`) — the walk owns the
   * pre-attempt guards (`UNKNOWN_CHAIN` / `EMPTY_EFFECTIVE_CHAIN` /
   * `UNDISPATCHABLE_EFFECTIVE_HEAD` / `LLM_UNAVAILABLE`, thrown synchronously
   * before any chunk, so the runtime normalizes them exactly like an adapter
   * throw).
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
    // The rows are visible whenever a chain is configured
    // (`isFallbackActive` = `chains.length > 0`); a chain's conformance is NOT
    // part of registration — a chain with empty or non-conforming entries
    // still earns its row, and the delegate refuses it via `effectiveHeadOf`.
    const shouldRegister = isFallbackActive(config)
    if (shouldRegister && !registered) {
      if (llm === undefined) return
      try {
        disposeAdapter = llm.registerAdapter([FALLBACKS_PROVIDER], adapter)
        registered = true
        logger.info('llm-fallbacks: virtual adapter registered — FallbacksChain/<chain id> rows are selectable in the model picker')
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
      logger.info('llm-fallbacks: virtual adapter unregistered — FallbacksChain rows hidden from the model picker')
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
