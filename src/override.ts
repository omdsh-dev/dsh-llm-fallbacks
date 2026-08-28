/**
 * RouteChanged effort rule for config overrides (plan dsh-012-subagent-routing
 * T4; spec D3).
 *
 * Pure, host-free module: plain seed config plus a target route in, the
 * overridden config out. The effort handling mirrors the upstream
 * `resolveChildAgentOptions` rule (deepseek-harness
 * `subagent/src/child-agent.ts:117`): a changed provider+model route drops the
 * seed's route-owned `reasoningEffort` so the selected model resolves its own
 * default, unless an effort is explicitly named for the override; an
 * unchanged route keeps the seed effort. Policy-independent by design — the
 * same rule applies on every override path whether the subagent routing
 * policy is on or off (spec D3). Never throws.
 *
 * @module dsh-llm-fallbacks/override
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Reasoning-effort value carried by `LlmCallConfig.reasoningEffort`. */
export type LlmReasoningEffort = NonNullable<LlmCallConfig['reasoningEffort']>

/**
 * Override a request config with a target route under the upstream
 * routeChanged effort rule (spec D3):
 *
 * - An explicitly named effort always survives — it wins over the seed effort
 *   on either route (upstream semantics: the request overrides the parent).
 * - Same provider+model route → the seed `reasoningEffort` is preserved.
 * - Route changed without an explicit effort → the seed effort is dropped
 *   (never carry a stale effort into a different provider/model route).
 *
 * @param seed - the caller's current request config.
 * @param to - the effective target route.
 * @param explicitEffort - an effort explicitly named for this override.
 * @returns a fresh config routed to `to` with the effort rule applied; never
 * mutates `seed`.
 */
export function overrideConfigWithRouteRule(
  seed: LlmCallConfig,
  to: { provider: string; model: string },
  explicitEffort?: LlmReasoningEffort,
): LlmCallConfig {
  if (explicitEffort !== undefined) {
    return { ...seed, reasoningEffort: explicitEffort, provider: to.provider, model: to.model }
  }
  const routeChanged = to.provider !== seed.provider || to.model !== seed.model
  if (!routeChanged) {
    return { ...seed, provider: to.provider, model: to.model }
  }
  const { reasoningEffort: _routeOwned, ...withoutRouteOwnedEffort } = seed
  return { ...withoutRouteOwnedEffort, provider: to.provider, model: to.model }
}
