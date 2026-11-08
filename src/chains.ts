/**
 * Fallback chain resolution: candidate resolution over ONE chain's effective
 * entries (named virtual chains, plan named-virtual-chains T2).
 *
 * `resolveChainViews` / `resolveChain` walk the chain's entries ONCE and
 * resolve each against the failing (provider, model). Wildcard entries
 * (`provider/*`) keep the model id and swap only the provider; the "target
 * provider has no such model id" skip is judged by {@link resolveCandidate}
 * (via `modelExists`) or by the caller's filter — applied to wildcard-origin
 * candidates ONLY ({@link selectCandidates}).
 *
 * Cooldown / failed-set / same-as-current filtering is caller-side;
 * {@link createCandidateFilter} provides the ready-made predicate. A
 * `CONTEXT_WINDOW_EXCEEDED` walk adds one more caller-side dimension to the
 * same predicate — candidates whose disclosed context window is not larger
 * than the failing model's cannot fit the request either
 * ({@link fitsContextWindow}; unknown windows keep the candidate).
 *
 @module dsh-llm-fallbacks/chains
 */

import type { CooldownStore } from './cooldown.ts'
import { parseSelector, resolveWildcardEntry, selectorKey, type Selector } from './selectors.ts'

/** The model that just failed — the anchor for chain resolution. */
export interface FailingModel {
  provider: string
  model: string
}

/**
 * Resolve one chain entry against the failing model.
 *
 * - `provider/model` → that exact selector (not subject to `modelExists` —
 *   the user explicitly listed it).
 * - `provider/*` → keeps the failing model id, swaps only the provider; when
 *   `modelExists` is given and the target provider has no such model id →
 *   `null` (skip).
 * - Malformed entries → `null`: they "do not take effect"; the strict throw
 *   path is {@link parseSelector}, used by the Task 3 config-warning path.
 */
export function resolveCandidate(
  entry: string,
  failing: FailingModel,
  modelExists?: (provider: string, model: string) => boolean,
): Selector | null {
  let selector: Selector
  try {
    selector = parseSelector(entry)
  } catch {
    return null
  }
  if (selector.model === undefined) {
    const resolved = resolveWildcardEntry(failing.model, selector.provider)
    if (modelExists && !modelExists(resolved.provider, resolved.model!)) return null
    return resolved
  }
  return selector
}

/**
 * Single-pass chain resolution over one chain's entries. Walks `entries` ONCE
 * and returns the unfiltered view — `all` (every resolvable candidate, no
 * filter and no existence probe: the caller's early-exit / annotation view) —
 * plus the parallel `wildcard` provenance (`wildcard[i]` = candidate `all[i]`
 * came from a `provider/*` entry). The caller builds the existence probe from
 * `all` and then derives the surviving view with {@link selectCandidates}, so
 * the decision path never resolves the chain twice. Malformed entries never
 * become candidates.
 */
export function resolveChainViews(
  entries: readonly string[],
  provider: string,
  model: string,
  warn: (message: string) => void = console.warn,
): { all: Selector[]; wildcard: boolean[] } {
  const failing: FailingModel = { provider, model }
  const all: Selector[] = []
  const wildcard: boolean[] = []
  for (const entry of entries) {
    let selector: Selector
    try {
      selector = parseSelector(entry)
    } catch {
      continue // malformed entries never become candidates (config-warning path)
    }
    const candidate = resolveCandidate(entry, failing)
    if (candidate === null) continue
    all.push(candidate)
    wildcard.push(selector.model === undefined)
  }
  return { all, wildcard }
}

/**
 * Derive the surviving candidates from a {@link resolveChainViews} pass:
 * the caller filter plus the wildcard-only existence probe. `modelExists`
 * applies to `provider/*`-origin candidates only (scoped by the parallel
 * `wildcard` provenance — T2 review Important #1: exact entries are never
 * existence-filtered), mirroring how {@link resolveCandidate} receives it.
 * Order and duplicates are preserved.
 */
export function selectCandidates(
  all: readonly Selector[],
  wildcard: readonly boolean[],
  filter?: (candidate: Selector) => boolean,
  modelExists?: (provider: string, model: string) => boolean,
): Selector[] {
  const surviving: Selector[] = []
  for (let index = 0; index < all.length; index += 1) {
    const candidate = all[index]!
    if (filter && !filter(candidate)) continue
    if (modelExists && wildcard[index] && !modelExists(candidate.provider, candidate.model!)) continue
    surviving.push(candidate)
  }
  return surviving
}

/**
 * Ordered fallback candidates for the failing (provider, model), over ONE
 * chain's `entries`. `filter` optionally drops candidates — the caller owns
 * cooldown/failed-set/same-model filtering (see {@link createCandidateFilter}).
 * The `modelExists` existence probe is applied by {@link selectCandidates} to
 * `provider/*`-origin candidates ONLY (exact entries are never
 * existence-filtered). `warn` forwards to {@link resolveChainViews}.
 *
 * Single-pass: delegates to {@link resolveChainViews} + {@link selectCandidates}
 * (one entry walk).
 */
export function resolveChain(
  entries: readonly string[],
  provider: string,
  model: string,
  filter?: (candidate: Selector) => boolean,
  modelExists?: (provider: string, model: string) => boolean,
  warn: (message: string) => void = console.warn,
): Selector[] {
  const { all, wildcard } = resolveChainViews(entries, provider, model, warn)
  return selectCandidates(all, wildcard, filter, modelExists)
}

/**
 * Whether any entry of `entries` is a wildcard (`provider/*`). The decision
 * path consults this to decide whether the catalog existence probe is needed
 * at all — a wildcard that can never reach the candidate list never builds a
 * catalog probe. Malformed entries never become candidates and are skipped.
 */
export function hasWildcardEntry(entries: readonly string[]): boolean {
  for (const entry of entries) {
    try {
      if (parseSelector(entry).model === undefined) return true
    } catch {
      // malformed entries never become candidates (config-warning path)
    }
  }
  return false
}

/** Inputs for {@link createCandidateFilter}. */
export interface CandidateFilterOptions {
  /** The currently active (failing) model — skipped as "same as current". */
  current: FailingModel
  /** Cooldown store: suppressed candidates are skipped (keyed `provider/model`). */
  cooldown: Pick<CooldownStore, 'isSuppressed'>
  /** Failed-set for the current step: already-failed candidates are skipped. */
  failed: { has(key: string): boolean }
  /** Optional existence probe: candidates the target provider lacks are skipped. */
  modelExists?: (provider: string, model: string) => boolean
  /**
   * The failing model's context window, when known — set only for a
   * `CONTEXT_WINDOW_EXCEEDED` walk. Candidates whose own known window is not
   * LARGER than this cannot fit the request either and are skipped.
   */
  minContextWindow?: number
  /** Context-window lookup for a candidate route; `undefined` = not disclosed. */
  contextWindowOf?: (provider: string, model: string) => number | undefined
}

/**
 * The context-window exclusion, shared by {@link createCandidateFilter} and
 * {@link annotateCandidates} so the switch log can never disagree with the
 * filter that produced it.
 *
 * A candidate is excluded ONLY when both windows are known and the
 * candidate's is not larger than the failing model's — the request that just
 * overflowed cannot fit there either. Unknown on either side (no
 * context-window walk, an undisclosed catalog, a wildcard with no model id)
 * KEEPS the candidate: capacity metadata is advisory, and a provider that
 * discloses nothing must never empty the chain.
 */
function fitsContextWindow(
  candidate: Selector,
  minContextWindow?: number,
  contextWindowOf?: (provider: string, model: string) => number | undefined,
): boolean {
  if (minContextWindow === undefined || contextWindowOf === undefined) return true
  if (candidate.model === undefined) return true
  const candidateWindow = contextWindowOf(candidate.provider, candidate.model)
  return candidateWindow === undefined || candidateWindow > minContextWindow
}

/**
 * The caller-side candidate filter (Task 3): a candidate is usable when it
 * differs from the current model, is not cooldown-suppressed, has not failed
 * in this step, can fit the request that overflowed (context-window walks
 * only — see {@link fitsContextWindow}), and (when `modelExists` is given)
 * exists on its provider.
 */
export function createCandidateFilter(options: CandidateFilterOptions): (candidate: Selector) => boolean {
  const { current, cooldown, failed, modelExists, minContextWindow, contextWindowOf } = options
  return (candidate) => {
    if (candidate.provider === current.provider && candidate.model === current.model) return false
    if (cooldown.isSuppressed(selectorKey(candidate.provider, candidate.model))) return false
    if (failed.has(selectorKey(candidate.provider, candidate.model))) return false
    if (!fitsContextWindow(candidate, minContextWindow, contextWindowOf)) return false
    if (modelExists && candidate.model !== undefined && !modelExists(candidate.provider, candidate.model)) {
      return false
    }
    return true
  }
}

/**
 * Why one considered candidate was excluded from the selection (spec §2
 * 行为可见性). `context-window` is the `CONTEXT_WINDOW_EXCEEDED` walk's
 * exclusion: the candidate's disclosed window is not larger than the failing
 * model's, so the request that just overflowed cannot fit there either.
 */
export type CandidateSkipReason = 'same-as-current' | 'cooldown' | 'step-failed' | 'context-window' | 'missing-id'

/** One entry of the ordered, per-candidate annotation (T3 review Minor 1). */
export interface AnnotatedCandidate {
  candidate: Selector
  /** Why this candidate was excluded; `undefined` = it survived every exclusion. */
  skip?: CandidateSkipReason
}

/**
 * Annotate the ordered "considered" candidate list with each candidate's skip
 * reason (spec §2 行为可见性: the switch log must show the attempt order and
 * why each candidate was skipped). The selection-relevant view is the
 * `surviving` list the decision path resolved with filter + existence probe:
 * a candidate absent from it failed one of the exclusions, and the concrete
 * reason is derived from the same checks {@link createCandidateFilter}
 * applies, in the same precedence. `missing-id` therefore only ever labels
 * entries the existence probe dropped — exact entries are never
 * existence-probed (T2 contract), so they stay in `surviving` and are
 * reported as usable, never as missing-id.
 *
 * This is the diagnostic counterpart of {@link createCandidateFilter} — pure,
 * order-preserving, and duplicate-preserving.
 */
export function annotateCandidates(
  candidates: readonly Selector[],
  surviving: readonly Selector[],
  options: Pick<CandidateFilterOptions, 'current' | 'cooldown' | 'failed' | 'minContextWindow' | 'contextWindowOf'>,
): AnnotatedCandidate[] {
  const { current, cooldown, failed, minContextWindow, contextWindowOf } = options
  const usable = new Set(surviving.map((candidate) => selectorKey(candidate.provider, candidate.model)))
  return candidates.map((candidate) => {
    if (candidate.provider === current.provider && candidate.model === current.model) {
      return { candidate, skip: 'same-as-current' }
    }
    const key = selectorKey(candidate.provider, candidate.model)
    if (usable.has(key)) return { candidate }
    if (cooldown.isSuppressed(key)) return { candidate, skip: 'cooldown' }
    if (failed.has(key)) return { candidate, skip: 'step-failed' }
    if (!fitsContextWindow(candidate, minContextWindow, contextWindowOf)) return { candidate, skip: 'context-window' }
    return { candidate, skip: 'missing-id' }
  })
}
