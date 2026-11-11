/**
 * Chain catalog lookup for the session-header pill: the chain label plus the
 * STATIC effective head, read from the plugin's shared client store.
 *
 * Kept out of the published `./client` entry (`src/client/index.ts` imports
 * it, never re-exports it): it is the registration closure's value source, not
 * plugin API.
 */
import { parseSelector } from '../selectors.ts'
import { isAllDayConforming, resolveEffectiveChain } from '../time-slots.ts'
import type { ChainRoute, ChainRouteLookup } from './SubagentRoleBadge.tsx'
import type { FallbacksSettingsState } from './fallbacks-store.ts'

/**
 * The provider route the virtual adapter owns. Duplicated from
 * `src/virtual-adapter.ts` on purpose: that host module value-imports
 * the host `dsh-llm` package, and the client bundle's purity gate refuses to inline
 * any such import (see `scripts/build-client.ts`), so the client half cannot
 * reach the constant.
 */
const FALLBACKS_PROVIDER = 'FallbacksChain'

/**
 * The static effective head of one chain's entry list — the client-side twin of
 * `effectiveHeadOf` (`src/virtual-adapter.ts`): the FIRST dispatchable exact
 * entry, skipping malformed selectors, `provider/*` wildcards and self-routes
 * back into this adapter. `null` when the chain has none.
 *
 * `simplify:` ten duplicated lines, because the host definition lives in a
 * module the client bundle cannot load. If `effectiveHeadOf` /
 * `firstDispatchableExactHead` ever move into a pure module, delete this copy
 * and import it.
 */
function firstDispatchableHead(entries: readonly string[]): { provider: string; model: string } | null {
  for (const entry of entries) {
    let selector: ReturnType<typeof parseSelector>
    try {
      selector = parseSelector(entry)
    } catch {
      continue // malformed entries are never dispatch targets
    }
    if (selector.model === undefined) continue // wildcard: no real pair
    if (selector.provider === FALLBACKS_PROVIDER) continue // self-route guard
    return { provider: selector.provider, model: selector.model }
  }
  return null
}

/**
 * Chain catalog lookup for the session-header pill (plan
 * settings-compact-slots-reasoning T4, design §11 Option A): the chain label
 * plus the STATIC effective head, read from the plugin's shared client store.
 *
 * No RPC and no load trigger. The return value distinguishes the two "no
 * chain" states the pill must render differently:
 * - `undefined` — the store has never been ready (cold), so the pill keeps
 *   today's raw `FallbacksChain/<id>` instead of claiming the chain is
 *   missing.
 * - `null` — the last resolved config does not contain this id (deleted
 *   chain, stale selection). The pill prints the unresolved state.
 *
 * A pushed invalidation refetches the store (`status` ready → loading →
 * ready); the closure remembers the last config accepted while ready/saving so
 * that one in-flight RPC round trip never flashes the raw route.
 * @param getSnapshot - read the live settings state (the shared controller).
 * @returns the lookup the badge receives as a prop.
 */
export function chainRouteLookup(getSnapshot: () => FallbacksSettingsState): ChainRouteLookup {
  // Only a ready/saving snapshot carries a real config; the loading state that
  // every refetch publishes keeps the last accepted one.
  let lastResolved: FallbacksSettingsState | undefined
  return (chainId: string): ChainRoute | null | undefined => {
    const snapshot = getSnapshot()
    if (snapshot.status === 'ready' || snapshot.status === 'saving') lastResolved = snapshot
    const source = lastResolved ?? snapshot
    // Never resolved: claim nothing — the pill keeps the raw route.
    if (source.status !== 'ready' && source.status !== 'saving') return undefined
    const chain = source.config.chains.find(entry => entry.id === chainId)
    if (chain === undefined) return null // loaded, and this chain is gone
    const head = isAllDayConforming(chain.entries)
      ? firstDispatchableHead(resolveEffectiveChain(chain, new Date(), source.config.tz ?? 'Asia/Shanghai'))
      : null
    const displayName = head === null
      ? ''
      : source.groups.find(group => group.id === head.provider)?.models.find(model => model.id === head.model)?.name ?? ''
    return {
      id: chain.id,
      label: chain.label,
      head: head === null
        ? null
        : { ...head, name: displayName === '' ? head.model : displayName },
    }
  }
}
