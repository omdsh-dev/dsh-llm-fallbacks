/**
 * Subagent routing policy reader (plan dsh-012-subagent-routing T1; spec D1).
 *
 * Pure, host-free module: plain data in, results out. It resolves the
 * effective subagent model-selection policy from two snapshots the wiring
 * layer extracts from the host:
 *
 * 1. the session's `subagent/model-selection-policy` event payload, read
 *    STRUCTURALLY — the upstream reader is not published from
 *    `@deepseek-ai/dsh-tool-subagent` and throws on malformed payloads,
 *    which is incompatible with the fail-closed no-throw requirement;
 * 2. the host settings service snapshot (`SubagentModelSelectionConfig`
 *    `.current()`), typed via a type-only peer import that is erased at emit.
 *
 * The session event wins over settings (ADR read order). Anything present but
 * unreadable yields `'unprovable'` (fail-closed): callers must not emit a
 * plugin-originated route they cannot prove is allowed. This module never
 * throws.
 *
 * @module dsh-llm-fallbacks/subagent-policy
 */

import type { SubagentModelSelectionSettings } from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Host-recorded route policy for a model-selectable subagent session.
     * The payload shape mirrors upstream exactly, so a future published
     * upstream augmentation merges identically. Read structurally by this
     * plugin; never written here.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this session may select explicitly for a child. */
      allowedModels: { provider: string; model: string }[]
    }
  }
}

/** One exact child LLM route (structural twin of upstream `AllowedModelRoute`). */
export type PolicyRoute = { readonly provider: string; readonly model: string }

/**
 * Effective subagent routing policy for one session.
 *
 * - `disabled`: host policy off or absent — selection matches pre-policy
 *   (0.3.5) behavior.
 * - `enabled`: an allowlist is proven; plugin-originated routes must stay
 *   inside it.
 * - `unprovable`: the policy is on but unreadable (malformed event payload,
 *   or enabled settings with a malformed route list) — fail-closed; no
 *   plugin-originated route may be emitted.
 */
export type EffectivePolicy =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled'; readonly allowedModels: readonly PolicyRoute[] }
  | { readonly state: 'unprovable' }

/** Outcome of the structural session-event read. */
export type SessionPolicyEventRead =
  | { readonly ok: true; readonly allowedModels: PolicyRoute[] }
  | { readonly ok: false; readonly present: true }
  | { readonly ok: false; readonly present: false }

/** Settings snapshot consumed by the reader — plain structural data, no host objects. */
export type PolicySettings = {
  readonly enabled: boolean
  readonly allowedModels: readonly PolicyRoute[]
}

/** Assignability guard: fails typecheck if the peer's settings shape drifts from the reader's snapshot contract. */
type AssertSettingsShape<T extends PolicySettings> = T

/**
 * The host settings service snapshot type, re-exported from the published
 * peer subpath (type-only). Wiring reads the service's `current()` and passes
 * the result in as plain data; if upstream drifts, this alias fails typecheck
 * instead of drifting silently at runtime (plan ADR).
 */
export type PeerSettingsSnapshot = AssertSettingsShape<SubagentModelSelectionSettings>

/**
 * Parse a raw allowed-models payload into a detached route list.
 * Mirrors the upstream validator's shape rules (array of objects with
 * non-empty string `provider`/`model`) without ever throwing.
 *
 * @param value - untrusted payload fragment.
 * @returns fresh route objects, or undefined when the payload is malformed.
 */
function parseRoutes(value: unknown): PolicyRoute[] | undefined {
  if (!Array.isArray(value)) return undefined
  const routes: PolicyRoute[] = []
  for (const candidate of value) {
    if (
      typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string' || candidate.provider.length === 0
      || !('model' in candidate) || typeof candidate.model !== 'string' || candidate.model.length === 0
    ) {
      return undefined
    }
    routes.push({ provider: candidate.provider, model: candidate.model })
  }
  return routes
}

/**
 * Structurally read the session's `subagent/model-selection-policy` event.
 * Never throws: a present-but-malformed payload is reported, not raised.
 *
 * Recency (qc fix wave S-asym — deliberate asymmetry, both sides mirror
 * upstream): this read takes the FIRST occurrence, exactly like the upstream
 * reader's `.find` — the host writes the policy event at most once per
 * session (its ensure-guard checks the reader before appending), so a second
 * occurrence would already be off-contract. The re-emittable
 * `model/selection` log is the opposite: `authorized-route.ts`
 * `lastModelSelection` scans backwards because upstream's selection
 * projection folds to the newest entry.
 *
 * @param events - plain event descriptors (`type` + optional `data`) captured
 *   from the session by the wiring layer.
 * @returns the detached route list when the event is present and valid;
 *   otherwise a presence flag distinguishing "no policy event" (pure
 *   inheritance path) from "policy event unreadable" (fail-closed).
 */
export function readSessionPolicyEvent(
  events: readonly { type: string; data?: unknown }[],
): SessionPolicyEventRead {
  const event = events.find(candidate => candidate.type === 'subagent/model-selection-policy')
  if (event === undefined) return { ok: false, present: false }
  const data: unknown = event.data
  const payload = typeof data === 'object' && data !== null && 'allowedModels' in data
    ? data.allowedModels
    : undefined
  const routes = parseRoutes(payload)
  // An empty route list is malformed, mirroring the upstream reader's throw.
  if (routes === undefined || routes.length === 0) return { ok: false, present: true }
  return { ok: true, allowedModels: routes }
}

/**
 * Resolve the effective policy from the session-event read and the settings
 * snapshot. The session event wins over settings (ADR read order).
 * Fail-closed: a present-but-malformed event, or enabled settings with a
 * malformed route list, yields `'unprovable'`. Never throws.
 *
 * @param event - result of {@link readSessionPolicyEvent}.
 * @param settings - settings service snapshot, or undefined when the host
 *   does not compose the service.
 */
export function effectivePolicy(
  event: SessionPolicyEventRead,
  settings: PolicySettings | undefined,
): EffectivePolicy {
  if (event.ok) return { state: 'enabled', allowedModels: event.allowedModels }
  if (event.present) return { state: 'unprovable' }
  if (settings === undefined || settings.enabled !== true) return { state: 'disabled' }
  const routes = parseRoutes(settings.allowedModels)
  // Enabled settings with an empty route list are malformed — the upstream
  // service's own validate() rejects that combination.
  if (routes === undefined || routes.length === 0) return { state: 'unprovable' }
  return { state: 'enabled', allowedModels: routes }
}
