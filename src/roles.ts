/**
 * Role resolution for fallback chains (spec §7.1; plan fallbacks-role-runtime
 * Task 1).
 *
 * Precedence (first hit wins):
 * 1. the first `rules` entry whose specified origin/provider/model patterns
 *    all match the agent;
 * 2. the built-in `'inherit'` role (no-rule-match default, spec §7.1 / D4).
 *
 * A matched rule must target a declared role id (`roleIds`, derived from
 * `config.roles.list`) or the built-in `'inherit'` — an undeclared target
 * warns and falls back to `'inherit'` (defensive; startup validation already
 * flagged the reference, spec §7.1 / AC-4).
 *
 * A missing agent origin is treated as `'root'`. Origin is read from
 * `session.header.origin` — a native `SessionHeader` field the store folds
 * from `CreateSessionOptions.meta.origin` (`packages/core/session/src/
 * index.ts:884`); subagent children set it via `childSessionMeta`
 * (`packages/subagent/subagent/src/child-agent.ts:115`), root agents carry
 * none. A subagent `persona` is NOT readable at the decision point:
 * `AgentOptions` is provider/model/maxTokens only, and persona is installed
 * as a scoped system-prompt section in the child's creation window — see
 * `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/
 * role-and-model-selection-exploration.md` (Role section).
 *
 * @module dsh-llm-fallbacks/roles
 */

import { INHERIT_ROLE_ID, type FallbacksRoleRule } from './config.ts'

export type { FallbacksRoleRule } from './config.ts'

/** Agent origins understood by role rules (spec §3). */
export type Origin = 'root' | 'subagent'

/** Loose agent shape sufficient for role resolution (spec §3 / brief). */
export interface AgentLike {
  options?: {
    provider?: string
    model?: string
  }
  session?: {
    header?: {
      origin?: Origin
    }
  }
}

/**
 * Resolve the fallback-chain role for an agent: first matching rule (in
 * listed order) → the built-in `'inherit'` role. A rule targeting an id
 * outside `roleIds ∪ {'inherit'}` warns once and resolves to `'inherit'`
 * (the defensive path — `validateFallbacksConfig` already warned at startup,
 * spec §7.1).
 */
export function resolveRole(
  agent: AgentLike,
  rules: FallbacksRoleRule[],
  roleIds: ReadonlySet<string>,
): string {
  const origin = agent.session?.header?.origin ?? 'root'
  for (const rule of rules) {
    if (rule.origin && rule.origin !== origin) continue
    if (rule.provider && rule.provider !== agent.options?.provider) continue
    if (rule.model && rule.model !== agent.options?.model) continue
    if (rule.role !== INHERIT_ROLE_ID && !roleIds.has(rule.role)) {
      console.warn(`llm-fallbacks: rule references undeclared role "${rule.role}" — falling back to "inherit"`)
      return INHERIT_ROLE_ID
    }
    return rule.role
  }
  return INHERIT_ROLE_ID
}
