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
 * config snapshots: register on `enabled` false→true, unregister on
 * true→false, driven by the settings `onChange` hook (the returned
 * reconcile thunk, wired by `apply()`) plus child activation. The row is
 * visible whenever the plugin is enabled — a non-conforming all-day chain
 * does NOT hide it (PR #62 feedback); conformance still gates a
 * successful override/delegate (`effectiveHeadOf` below refuses a
 * non-conforming all-day). The condition deliberately ignores `timeSlots`
 * and conformance, so slot-row edits and chain edits never churn
 * registration.
 *
 * Adapter behavior (P1/P3): `listModels` advertises exactly the one virtual
 * row; `stream()` is a THIN single-hop delegate to the effective chain head
 * through the host LLM runtime — no chain walk, no cooldown/caps/revert
 * bookkeeping, no state writes (a failure inside the delegate surfaces at
 * `agent/request-error`, where the existing engine walks from there).
 * `resolveModel` proxies the current effective head's metadata when
 * resolvable (modalities/context-window/reasoning follow the head) with a
 * permissive default otherwise — never throws.
 *
 * @module dsh-llm-fallbacks/virtual-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type LlmRuntime,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { FallbacksConfig } from './config.ts'
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

/**
 * `LlmError` code: the effective chain is empty — the virtual route has no
 * head to delegate to (P1 guard).
 */
export const EMPTY_EFFECTIVE_CHAIN_CODE = 'EMPTY_EFFECTIVE_CHAIN'
/**
 * `LlmError` code: the effective chain head is not a dispatchable real pair
 * (non-conforming all-day, wildcard selector, malformed selector, or a
 * self-route back to `FallbacksChain/*` — the P1 recursion guard).
 */
export const UNDISPATCHABLE_HEAD_CODE = 'UNDISPATCHABLE_EFFECTIVE_HEAD'
/** `LlmError` code (defensive): the `llm` runtime disappeared mid-flight. */
export const LLM_UNAVAILABLE_CODE = 'LLM_UNAVAILABLE'

/** One dispatchable exact head: `provider/model`. Wildcards are never seeds (P3). */
export interface EffectiveHead {
  provider: string
  model: string
}

/**
 * The FIRST DISPATCHABLE exact head of a chain — the single definition of
 * "effective head" (F-001) shared by the root select-is-primary override
 * (`src/index.ts`) and the virtual adapter's delegate paths. Walks the SAME
 * chain `resolveEffectiveChain` produces, skipping entries that can never
 * be dispatched: malformed selectors (config-warning path), `provider/*`
 * `provider/*` wildcards (no real pair), and self-routes back to
 * `FallbacksChain/*` (the P1 recursion guard). `undefined` when the chain
 * is empty or no entry is dispatchable.
 */
export function firstDispatchableExactHead(chain: readonly string[]): EffectiveHead | undefined {
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
 * The effective chain head at `now` (P1): the first DISPATCHABLE exact head
 * of the SAME `resolveEffectiveChain` the routing engine uses — thin
 * config+clock entry into the shared {@link firstDispatchableExactHead} (no
 * divergent skip/walk rules). `undefined` when the chain is empty or no
 * entry is dispatchable (wildcard, self-route to `FallbacksChain/*`,
 * malformed selector).
 *
 * Conformance gate (PR #62 feedback): the all-day `rootChain` must be
 * conforming (exactly one official V4 model) for a successful delegate —
 * a legacy multi-model (or empty) all-day chain earns no primary
 * semantics even though the picker row is visible. `resolveModel` then
 * falls back to the permissive default and `stream()` throws
 * {@link UNDISPATCHABLE_HEAD_CODE}.
 */
function effectiveHeadOf(config: FallbacksConfig, now: Date): EffectiveHead | undefined {
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
 * The virtual adapter (P1/P3). `stream()` is a thin head-delegate, never a
 * second routing engine: no chain walk, cooldown, caps, revert bookkeeping,
 * or state writes live here — those stay in the `agent/request` /
 * `agent/request-error` listeners.
 */
class FallbacksChainAdapter extends LlmAdapter {
  constructor(
    private readonly readConfig: () => FallbacksConfig,
    private readonly getLlm: () => LlmRuntime | undefined,
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
   * Thin head-delegate (P1): resolve the effective chain head and dispatch
   * that REAL pair through the host LLM runtime. Throws an explicit
   * `LlmError` only when there is no real pair to delegate to: an empty
   * effective chain, an undispatchable head (wildcard / malformed /
   * self-route — the recursion guard), or a vanished `llm` runtime. The
   * runtime normalizes the throw into a terminal error finish chunk, so the
   * documented listener-order degradation stays graceful instead of a hard
   * outage.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.readConfig()
    const now = new Date()
    const chain = resolveEffectiveChain(config, now, config.tz ?? 'Asia/Shanghai')
    if (chain.length === 0) {
      throw new LlmError(
        'llm-fallbacks: the effective chain is empty — the virtual FallbacksChain route has no head to delegate to',
        EMPTY_EFFECTIVE_CHAIN_CODE,
      )
    }
    const head = effectiveHeadOf(config, now)
    if (head === undefined) {
      throw new LlmError(
        'llm-fallbacks: the effective chain head cannot be dispatched (non-conforming all-day, wildcard, malformed, or self-route) — refusing to delegate',
        UNDISPATCHABLE_HEAD_CODE,
      )
    }
    const llm = this.getLlm()
    if (llm === undefined) {
      // The route is registered on a live `llm` service; absence means the
      // fiber is tearing down. Defensive — never silently drop the call.
      throw new LlmError(
        'llm-fallbacks: the llm runtime is unavailable — cannot delegate the FallbacksChain call',
        LLM_UNAVAILABLE_CODE,
      )
    }
    return llm.stream({ ...options, provider: head.provider, model: head.model })
  }
}

/**
 * Install the virtual adapter registration lifecycle (P2).
 *
 * @param ctx - the plugin context.
 * @param readConfig - live config reader (the same `source()` the runtime
 *   reads, so reconcile always sees COMMITTED composed snapshots).
 * @returns the reconcile thunk — call it from the settings `onChange` hook
 *   (child activation runs one reconcile on its own).
 */
export function installFallbacksAdapter(ctx: Context, readConfig: () => FallbacksConfig): () => void {
  let llm: LlmRuntime | undefined
  let disposeAdapter: (() => void) | undefined
  let registered = false
  const logger = ctx.logger('llm-fallbacks')
  // The adapter reads the `llm` binding at CALL time (the inject child swaps
  // it as the service appears/disappears) and the config at call time.
  const adapter = new FallbacksChainAdapter(readConfig, () => llm)

  const reconcile = () => {
    const config = readConfig()
    // PR #62 feedback: the row is visible whenever the plugin is enabled —
    // conformance of the all-day chain is NOT part of registration (a
    // legacy/empty chain still earns the row; the override/delegate paths
    // refuse it via `effectiveHeadOf`).
    const shouldRegister = config.enabled
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
