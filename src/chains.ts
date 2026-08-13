/**
 * Fallback chain resolution (spec §7.2; plan fallbacks-role-runtime Task 1).
 *
 * `resolveChain` returns the ordered candidate list for a failing
 * (provider, model). Candidates come from the role's own chain plus
 * `rootChain` appended as an inherit-root fallback — **append-not-replace**:
 * `[...(roleDef.chain ?? []), ...(roleDef.fallback === 'none' ? [] :
 * rootChain)]` (role entries first, rootChain entries after). The reserved
 * built-in `inherit` id (INHERIT_ROLE_ID) resolves to `rootChain` silently —
 * it is the legal no-rule-match role, not a typo'd id. A truly undeclared
 * role id (defense) resolves to `rootChain` alone + one warn. Chain-key
 * specificity lookup (`exact` / `provider/*` / role / `default` keys) is
 * deleted — the two-block config model has no chain keys.
 *
 * Wildcard entries (`provider/*`) are resolved against the failing model —
 * keep the model id, swap only the provider; the "target provider has no
 * such model id" skip is judged by {@link resolveCandidate} (via
 * `modelExists`) or by the caller's filter.
 *
 * Cooldown / failed-set / same-as-current filtering is caller-side;
 * {@link createCandidateFilter} provides the ready-made predicate.
 *
 * @module dsh-llm-fallbacks/chains
 */

import { INHERIT_ROLE_ID, type FallbacksRole } from './config.ts'
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
 * Single-pass chain resolution for the decision path (T1 review Important
 * #2). Walks the role's concatenated entries ONCE and returns the unfiltered
 * view — `all` (every resolvable candidate, no filter and no existence
 * probe: the caller's early-exit / annotation view) — plus the parallel
 * `wildcard` provenance (`wildcard[i]` = candidate `all[i]` came from a
 * `provider/*` entry). The caller builds the existence probe from `all` and
 * then derives the surviving view with {@link selectCandidates}, so the
 * decision path never resolves the chain twice (and an unknown role warns
 * at most once per decision).
 *
 * The reserved built-in `inherit` id (INHERIT_ROLE_ID) is legal — it
 * resolves to `rootChain` silently (the no-rule-match role, not a typo'd
 * id). Only a truly undeclared id (∉ declared ids ∪ {'inherit'}) warns once
 * (defensive — never crashes). Malformed entries never become candidates.
 */
export function resolveChainViews(
  roles: readonly FallbacksRole[],
  rootChain: readonly string[],
  role: string,
  provider: string,
  model: string,
): { all: Selector[]; wildcard: boolean[] } {
  const failing: FailingModel = { provider, model }
  const roleDef = roles.find((declared) => declared.id === role)
  let entries: readonly string[]
  if (role === INHERIT_ROLE_ID) {
    entries = rootChain
  } else if (roleDef === undefined) {
    console.warn(`llm-fallbacks: unknown role "${role}" — falling back to rootChain`)
    entries = rootChain
  } else {
    entries = [...(roleDef.chain ?? []), ...(roleDef.fallback === 'none' ? [] : rootChain)]
  }
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
 * Ordered fallback candidates for the failing (provider, model).
 *
 * Candidates are the role's concatenated entries (spec §7.2): the declared
 * role's own `chain` followed by `rootChain` unless `fallback: 'none'`
 * (append-not-replace — role entries first, rootChain as the tail). The
 * reserved built-in `inherit` id resolves to `rootChain` silently; a truly
 * undeclared/unknown `role` id resolves to `rootChain` alone and warns once
 * (defensive — never crashes). `filter` optionally drops candidates — the
 * caller owns cooldown/failed-set/same-model filtering (see
 * {@link createCandidateFilter}). `modelExists` is forwarded to
 * {@link resolveCandidate}, so the "target provider has no such model id"
 * skip (spec §2 clause 2) applies to `provider/*` entries only — explicitly
 * listed exact entries are never existence-filtered (T2 review Important #1:
 * decision-path contract).
 *
 * Single-pass: delegates to {@link resolveChainViews} + {@link selectCandidates}
 * (one concatenated-entry walk, warn at most once per call).
 */
export function resolveChain(
  roles: readonly FallbacksRole[],
  rootChain: readonly string[],
  role: string,
  provider: string,
  model: string,
  filter?: (candidate: Selector) => boolean,
  modelExists?: (provider: string, model: string) => boolean,
): Selector[] {
  const { all, wildcard } = resolveChainViews(roles, rootChain, role, provider, model)
  return selectCandidates(all, wildcard, filter, modelExists)
}

/**
 * Whether any entry of the role's concatenated candidates is a wildcard
 * (`provider/*`). F-002: {@link resolveChain} resolves wildcard entries to
 * concrete models, so the wildcard provenance is invisible on the resolved
 * candidate list — the decision path consults the same concatenation
 * `resolveChain` walks (`[...(roleDef?.chain ?? []), ...rootChain]`, spec
 * §7.2) to decide whether the catalog existence probe is needed at all.
 * Malformed entries never become candidates and are skipped. The probe
 * deliberately includes `rootChain` even when the role's `fallback` is
 * `'none'` — an over-approximation (never false-negative on a wildcard the
 * resolution could reach; it only ever builds a probe that is not strictly
 * needed).
 */
export function hasWildcardEntry(
  roles: readonly FallbacksRole[],
  rootChain: readonly string[],
  role: string,
): boolean {
  const roleDef = roles.find((declared) => declared.id === role)
  const entries = [...(roleDef?.chain ?? []), ...rootChain]
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

/** Why one considered candidate was excluded from the selection (spec §2 行为可见性). */
export type CandidateSkipReason = 'same-as-current' | 'cooldown' | 'step-failed' | 'missing-id'

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
  options: Pick<CandidateFilterOptions, 'current' | 'cooldown' | 'failed'>,
): AnnotatedCandidate[] {
  const { current, cooldown, failed } = options
  const usable = new Set(surviving.map((candidate) => selectorKey(candidate.provider, candidate.model)))
  return candidates.map((candidate) => {
    if (candidate.provider === current.provider && candidate.model === current.model) {
      return { candidate, skip: 'same-as-current' }
    }
    const key = selectorKey(candidate.provider, candidate.model)
    if (usable.has(key)) return { candidate }
    if (cooldown.isSuppressed(key)) return { candidate, skip: 'cooldown' }
    if (failed.has(key)) return { candidate, skip: 'step-failed' }
    return { candidate, skip: 'missing-id' }
  })
}
