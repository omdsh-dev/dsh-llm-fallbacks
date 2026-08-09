/**
 * dsh-llm-fallbacks host half (plan Task 3: settings + waterfall + state
 * machine + events).
 *
 * Cordis function plugin mounted by the profile bundle patch row
 * `llm-fallbacks` (see `bundle/cordis.patch.yml`), composed AFTER llm-retry.
 *
 * Wiring:
 * - `fallbacks` settings namespace via {@link installSettingsSection}
 *   (composition entry as base; `scope.watch` → `onChange` re-reads the
 *   runtime and re-validates selectors — spec §4).
 * - `agent/request-error` waterfall: `!enabled` / code ∉ `triggerCodes`
 *   (**always mode included**) → `next()`; otherwise resolve role + chain,
 *   and when a candidate survives the filter (current / cooldown /
 *   step-failed / `provider/*`-missing-id) write the pending switch +
 *   cooldown + failure bookkeeping + append `fallbacks/switch`, then return
 *   `{ kind: 'retry' }` (own recovery, no `next()`).
 * - `agent/request` waterfall: apply a pending switch after `await next()`
 *   (provider/model override, inherited `reasoningEffort` dropped — the
 *   `installModelSelection` `withoutInheritedEffort` pattern), then the
 *   always-mode cap check (count `llm/retry` events for the current
 *   turn/step/provider; ≥ `alwaysModeRetryCap` → same decision path, reason
 *   `always-cap` — ADR-2).
 * - Per-agent state (`FallbackStateStore`): `agent/disposed` removes it,
 *   `agent/status` idle prunes per-step state defensively, plugin dispose
 *   clears everything (spec §6 — no residual state).
 *
 * @module dsh-llm-fallbacks
 */

import type { Context, Logger } from 'cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, defaultFallbacksConfig, type FallbacksConfig } from './config.ts'
import { annotateCandidates, createCandidateFilter, resolveChain, type FailingModel } from './chains.ts'
import { parseSelector, selectorKey } from './selectors.ts'
import { resolveRole } from './roles.ts'
import { FallbackStateStore, type AgentFallbackState, type PendingSwitch } from './state.ts'
import type { FallbackSwitchReason } from './events.ts'

/** The plugin row id mounted by the profile bundle patch. */
export const name = 'llm-fallbacks'

export { Config }
/** The plugin's composition config — the `fallbacks` settings schema (spec §4). */
export type Config = FallbacksConfig
export type { FallbackSwitchReason, FallbacksSwitchEventData } from './events.ts'
export type { AgentFallbackState, FallbackStateStore, PendingSwitch, StepFailures } from './state.ts'

/** Model-catalog service shape the wildcard existence probe reads (`ctx.llm`). */
interface ModelCatalogService {
  listModels(provider: string): Promise<readonly { id: string }[]>
}

/**
 * Per-apply state stores, keyed by context. Weak so entries die with the
 * context; the plugin's own dispose effect clears the store contents.
 * @internal
 */
const stateStores = new WeakMap<Context, FallbackStateStore>()

/**
 * @internal Test seam (T3 review Minor 3): the per-agent fallback state store
 * of the plugin applied to `ctx` — last apply wins. Not part of the plugin's
 * public surface; lets tests assert the no-op purity invariant (a plain
 * request must not grow the store) without reaching into the closure.
 */
export function stateStore(ctx: Context): FallbackStateStore | undefined {
  return stateStores.get(ctx)
}

/**
 * Chain-map normalization (T2 review Minor #1): keys containing `/` are
 * selector keys and are canonicalized via `parseSelector` + `selectorKey`, so
 * whitespace-padded keys match the resolved lookups; keys without `/` are
 * role names and are trimmed. Illegal keys warn and are dropped — they "do
 * not take effect" (spec §4). Entries are validated lazily at resolve time
 * (`resolveCandidate` returns null for malformed ones) after the same warning
 * is emitted here.
 *
 * Exported for direct unit testing of the config-warning path; the plugin
 * calls it at startup and on every settings change (`onChange`).
 */
export function normalizeChains(chains: Record<string, string[]>, logger: Logger): Record<string, string[]> {
  const normalized: Record<string, string[]> = {}
  for (const [key, entries] of Object.entries(chains)) {
    const roleKey = key.includes('/') ? normalizeSelectorKey(key, logger) : key.trim()
    if (roleKey === null || roleKey === '') continue
    for (const entry of entries) {
      try {
        parseSelector(entry)
      } catch (error) {
        logger.warn(`llm-fallbacks: ignoring invalid chain entry "${entry}" in key "${key}": ${(error as Error).message}`)
      }
    }
    normalized[roleKey] = entries
  }
  return normalized
}

function normalizeSelectorKey(key: string, logger: Logger): string | null {
  try {
    const parsed = parseSelector(key)
    return selectorKey(parsed.provider, parsed.model)
  } catch (error) {
    logger.warn(`llm-fallbacks: ignoring invalid chain key "${key}": ${(error as Error).message}`)
    return null
  }
}

/**
 * Whether any chain entry reachable for this failing (provider, model) is a
 * wildcard (`provider/*`). F-002: `resolveChain` resolves wildcard entries to
 * concrete models, so the wildcard provenance is invisible on the resolved
 * candidate list — the decision path consults the raw entries under the same
 * keys `resolveChain` walks (exact → `provider/*` → role → `default`) to
 * decide whether the catalog existence probe is needed at all. Malformed
 * entries never become candidates and are skipped.
 */
function hasWildcardEntry(
  chains: Record<string, string[]>,
  role: string,
  provider: string,
  model: string,
): boolean {
  const keys = [selectorKey(provider, model), selectorKey(provider), role, 'default']
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    const entries = chains[key]
    if (!entries) continue
    for (const entry of entries) {
      try {
        if (parseSelector(entry).model === undefined) return true
      } catch {
        // malformed entries never become candidates (config-warning path)
      }
    }
  }
  return false
}

/**
 * The `provider/*`-entry existence probe (spec §2 clause 2): the target
 * provider's advertised catalog, fetched once per decision and cached per
 * provider. A missing/unknown provider or a failing catalog reads as "no such
 * model", so wildcard candidates to it are skipped; without an `llm` service
 * no filtering happens (`() => true`).
 *
 * simplify: catalog fetched per decision, never cached across decisions.
 * Decisions are failure-driven and rare; cache per provider in the plugin if
 * they ever become hot.
 */
async function makeModelExists(
  ctx: Context,
  providers: readonly string[],
): Promise<(provider: string, model: string) => boolean> {
  const llm = ctx.get('llm') as ModelCatalogService | undefined
  if (llm === undefined || typeof llm.listModels !== 'function') return () => true
  const catalog = new Map<string, Set<string>>()
  await Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider)
      catalog.set(provider, new Set(models.map((model) => model.id)))
    } catch {
      catalog.set(provider, new Set())
    }
  }))
  return (provider, model) => catalog.get(provider)?.has(model) ?? false
}

/**
 * Count durable `llm/retry` events for the current (turn, step, provider) in
 * **always mode** (ADR-2; spec §2 clause 5). Normal-mode retries belong to
 * llm-retry's bounded budget and must not preempt the fallback, so only
 * `mode: 'always'` events count toward `alwaysModeRetryCap` (T3 review
 * Minor 2 — the real event carries the discriminator, llm-retry types.ts).
 *
 * Fast path (T3 review Minor 4): the session log is append-ordered, so the
 * scan runs backwards and stops at the first event older than the target
 * (turn, step) — a long session's earlier turns are never scanned.
 *
 * Exported for direct unit testing of the counting + fast path.
 */
export function countRetryEvents(session: Session, turn: number, step: number, provider: string): number {
  let count = 0
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    const data = event.data as { turn?: number; step?: number }
    // Everything before the first event older than the target cannot match.
    if (
      typeof data.turn === 'number'
      && typeof data.step === 'number'
      && (data.turn < turn || (data.turn === turn && data.step < step))
    ) break
    if (event.type !== 'llm/retry') continue
    if (data.turn === turn && data.step === step && event.data.provider === provider && event.data.mode === 'always') {
      count += 1
    }
  }
  return count
}

/** The model the failed/current request was routed to. */
function currentModel(agent: Agent, provider: string): FailingModel {
  const header = agent.session.requestHeader()
  return { provider, model: header?.config.model ?? agent.options.model ?? '' }
}

/**
 * Override a request config with a pending switch: provider/model replaced,
 * inherited `reasoningEffort` dropped (the `installModelSelection`
 * `withoutInheritedEffort` pattern).
 */
function overrideConfig(seed: LlmCallConfig, to: { provider: string; model: string }): LlmCallConfig {
  const { reasoningEffort: _inherited, ...withoutInheritedEffort } = seed
  return { ...withoutInheritedEffort, provider: to.provider, model: to.model }
}

export function apply(ctx: Context, config: FallbacksConfig = defaultFallbacksConfig): void {
  const logger = ctx.logger('llm-fallbacks')
  // Cordis resolves the entry through the schema before apply, so `config` is
  // already defaulted; re-resolving keeps direct calls (tests) normalized.
  const entry = Config(config)
  let source: () => FallbacksConfig = () => entry
  let chains = normalizeChains(entry.chains, logger)
  // F-001: an unconfigured install (empty chains) must be truly zero-cost —
  // the always-cap session scan is short-circuited on this flag, so a plain
  // request never touches the event log when no chains are configured (AC-8).
  let hasChains = Object.keys(chains).length > 0

  installSettingsSection(ctx, settingsNamespace('fallbacks'), Config, entry, {
    setSource: (current) => {
      source = current
    },
    onChange: () => {
      chains = normalizeChains(source().chains, logger)
      hasChains = Object.keys(chains).length > 0
    },
  })

  const states = new FallbackStateStore()
  stateStores.set(ctx, states)

  /**
   * Shared decision path (spec §5.1 lifecycle step 1): resolve the agent's
   * role and chain, filter candidates (same-model / cooldown / step-failed /
   * `provider/*`-missing-id), enforce the per-step safety valve, and — on a
   * hit — return the pending switch for the caller to commit.
   *
   * `state` is the agent's peeked entry: `undefined` for agents with no state
   * yet (F-004 — the store is only grown on a real switch intent, inside
   * `commit`). With no state there is no step bookkeeping, so the valve check
   * passes and cooldown/step-failed reads are false.
   */
  async function decide(
    agent: Agent,
    turn: number,
    step: number,
    current: FailingModel,
    reason: FallbackSwitchReason,
    state: AgentFallbackState | undefined,
  ): Promise<PendingSwitch | null> {
    const config = source()
    if (state !== undefined) {
      states.syncStep(state, turn, step)
      if (state.stepFailures.switchCount >= config.maxSwitchesPerStep) return null
    }
    const role = resolveRole(agent, config.roles.rules, config.roles.default)
    const all = resolveChain(chains, role, current.provider, current.model)
    if (all.length === 0) return null
    // T2 review Important #1 (decision-path contract): the "missing id" skip
    // stays scoped to `provider/*` entries (spec §2 clause 2 — exact entries
    // are never existence-filtered; createCandidateFilter's own modelExists
    // would over-filter them), so the probe is forwarded to
    // resolveChain/resolveCandidate while the filter deliberately does NOT
    // receive modelExists. F-002: the probe is built only when a wildcard
    // entry is reachable — pure exact chains take zero catalog probes.
    const modelExists = hasWildcardEntry(chains, role, current.provider, current.model)
      ? await makeModelExists(
        ctx,
        [...new Set(all.map((candidate) => candidate.provider))],
      )
      : undefined
    const cooldown = {
      isSuppressed: (key: string) => state !== undefined && states.isSuppressed(state, key),
    }
    const failed = {
      has: (key: string) => state !== undefined && state.stepFailures.failed.has(key),
    }
    const filter = createCandidateFilter({ current, cooldown, failed })
    const surviving = resolveChain(chains, role, current.provider, current.model, filter, modelExists)
    const target = surviving[0]
    if (target === undefined || target.model === undefined) return null
    logger.info(
      'llm-fallbacks: agent "%s" switch %s/%s -> %s/%s (role=%s, reason=%s, candidates=%o)',
      agent.id,
      current.provider,
      current.model,
      target.provider,
      target.model,
      role,
      reason,
      // spec §2 行为可见性: the log shows the candidate attempt order AND why
      // each candidate was skipped (cooldown / step-failed / same-as-current /
      // target-provider missing id); survivors (including the target) are
      // unlabelled.
      annotateCandidates(all, surviving, { current, cooldown, failed })
        .map(({ candidate, skip }) => skip === undefined
          ? `${candidate.provider}/${candidate.model}`
          : `${candidate.provider}/${candidate.model} (skipped: ${skip})`),
    )
    return {
      from: { provider: current.provider, model: current.model },
      to: { provider: target.provider, model: target.model },
      role,
      reason,
    }
  }

  /** Commit a decision: pending switch + cooldown + failure bookkeeping + durable event (spec §5.1 step 1). */
  function commit(agent: Agent, state: AgentFallbackState, pending: PendingSwitch, turn: number, step: number): void {
    const config = source()
    const fromKey = selectorKey(pending.from.provider, pending.from.model)
    const until = config.revertPolicy === 'never' ? Number.POSITIVE_INFINITY : Date.now() + config.cooldownMs
    // F-004 follow-up: a state freshly created by `states.get` at the commit
    // site carries no (turn, step) markers — sync them here so the next
    // decision's valve/failed-set bookkeeping sees this committed step (a
    // no-op for states `decide` already synced at the same (turn, step)).
    states.syncStep(state, turn, step)
    states.writePending(state, pending)
    states.suppress(state, fromKey, until)
    states.recordFailure(state, fromKey)
    states.recordSwitch(state)
    agent.session.append('fallbacks/switch', {
      turn,
      step,
      from: pending.from,
      to: pending.to,
      role: pending.role,
      reason: pending.reason,
    })
  }

  ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure },
    next,
  ) => {
    const config = source()
    // Always mode delegates downstream first (llm-retry), so non-trigger
    // failures must pass through here too — the cap lives at agent/request
    // (ADR-2). Only trigger codes enter the decision path.
    if (!config.enabled || !config.triggerCodes.includes(failure.code)) return next()
    const current = currentModel(agent, provider)
    if (!current.model) return next()
    // F-005: the decision path is defensive — an unexpected throw (e.g. a
    // session.append failure, a future refactor) must not replace the original
    // failure semantics (spec §6); log and delegate instead.
    try {
      // F-004: peek, never create — a null decision must not grow the store.
      const state = states.peek(agent.id)
      const pending = await decide(agent, turn, step, current, 'trigger-code', state)
      if (pending === null) return next()
      commit(agent, states.get(agent.id), pending, turn, step)
      return { kind: 'retry' }
    } catch (error) {
      logger.warn(
        'llm-fallbacks: decision path failed, passing the original failure through: %s',
        (error as Error)?.message ?? String(error),
      )
      return next()
    }
  })

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const seed = await next()
    // No-op purity (T3 review Minor 3): peek, never create — a plain request
    // must not grow the per-agent map (AC-8). State is created lazily only
    // when a real switch intent exists (a pending decision to apply, or the
    // always-cap tripped below).
    const state = states.peek(agent.id)
    // Apply a pending decision first (trigger-code path); a switch for this
    // request means the always-cap count of the previous provider is moot.
    const applied = state === undefined ? undefined : states.applyPending(state, turn, step)
    if (applied !== undefined) return overrideConfig(seed, applied.to)
    const config = source()
    if (
      hasChains
      && config.enabled
      && config.alwaysModeRetryCap > 0
      && countRetryEvents(agent.session, turn, step, seed.provider) >= config.alwaysModeRetryCap
    ) {
      // Cap tripped: a genuine switch intent — but the state is still only
      // grown when the decision actually commits (F-004: a null decision —
      // e.g. all candidates filtered — leaves no entry behind).
      const decisionState = states.peek(agent.id)
      const pending = await decide(
        agent,
        turn,
        step,
        { provider: seed.provider, model: seed.model },
        'always-cap',
        decisionState,
      )
      if (pending !== null) {
        const commitState = states.get(agent.id)
        commit(agent, commitState, pending, turn, step)
        const appliedCap = states.applyPending(commitState, turn, step)
        if (appliedCap !== undefined) return overrideConfig(seed, appliedCap.to)
      }
    }
    return seed
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const state = states.peek(agent.id)
    if (state !== undefined) states.clearStepState(state)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
  })

  ctx.effect(() => () => {
    states.clear()
  }, 'llm-fallbacks: clear per-agent state')
}
