/**
 * Fallback chain resolution (spec §2 clause 2, §4; plan Task 2).
 *
 * `resolveChain` returns the ordered candidate list for a failing
 * (provider, model): specificity order exact `provider/model` key →
 * `provider/*` key → role key → `default` key, entries keeping their listed
 * order within a key. Wildcard entries (`provider/*`) are resolved against
 * the failing model — keep the model id, swap only the provider; the
 * "target provider has no such model id" skip is judged by
 * {@link resolveCandidate} (via `modelExists`) or by the caller's filter.
 *
 * Cooldown / failed-set / same-as-current filtering is caller-side (Task 3);
 * {@link createCandidateFilter} provides the ready-made predicate.
 *
 * @module dsh-llm-fallbacks/chains
 */

import type { CooldownStore, StepFailureSet } from './cooldown.ts'
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
 * Ordered fallback candidates for the failing (provider, model).
 *
 * Chain keys are consulted in specificity order (exact → `provider/*` →
 * `role` → `default`); every present key contributes its entries, so the
 * result is a priority-ordered union. Wildcard entries are resolved against
 * the failing model. `filter` optionally drops candidates — the caller owns
 * cooldown/failed-set/same-model filtering (see {@link createCandidateFilter}).
 * `modelExists` is forwarded to {@link resolveCandidate}, so the
 * "target provider has no such model id" skip (spec §2 clause 2) applies to
 * `provider/*` entries only — explicitly listed exact entries are never
 * existence-filtered (T2 review Important #1: Task 3 decision path contract).
 */
export function resolveChain(
  chains: Record<string, string[]>,
  role: string,
  provider: string,
  model: string,
  filter?: (candidate: Selector) => boolean,
  modelExists?: (provider: string, model: string) => boolean,
): Selector[] {
  const failing: FailingModel = { provider, model }
  const keys = [selectorKey(provider, model), selectorKey(provider), role, 'default']
  const candidates: Selector[] = []
  const seenKeys = new Set<string>()
  for (const key of keys) {
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const entries = chains[key]
    if (!entries) continue
    for (const entry of entries) {
      const candidate = resolveCandidate(entry, failing, modelExists)
      if (candidate && (!filter || filter(candidate))) candidates.push(candidate)
    }
  }
  return candidates
}

/** Inputs for {@link createCandidateFilter}. */
export interface CandidateFilterOptions {
  /** The currently active (failing) model — skipped as "same as current". */
  current: FailingModel
  /** Cooldown store: suppressed candidates are skipped (keyed `provider/model`). */
  cooldown: Pick<CooldownStore, 'isSuppressed'>
  /** Failed-set for the current step: already-failed candidates are skipped. */
  failed: Pick<StepFailureSet, 'has'>
  /** Optional existence probe: candidates the target provider lacks are skipped. */
  modelExists?: (provider: string, model: string) => boolean
}

/**
 * The caller-side candidate filter (Task 3): a candidate is usable when it
 * differs from the current model, is not cooldown-suppressed, has not failed
 * in this step, and (when `modelExists` is given) exists on its provider.
 */
export function createCandidateFilter(options: CandidateFilterOptions): (candidate: Selector) => boolean {
  const { current, cooldown, failed, modelExists } = options
  return (candidate) => {
    if (candidate.provider === current.provider && candidate.model === current.model) return false
    if (cooldown.isSuppressed(selectorKey(candidate.provider, candidate.model))) return false
    if (failed.has(selectorKey(candidate.provider, candidate.model))) return false
    if (modelExists && candidate.model !== undefined && !modelExists(candidate.provider, candidate.model)) {
      return false
    }
    return true
  }
}
