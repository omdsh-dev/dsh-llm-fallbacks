/**
 * Role resolution for fallback chains (spec §3, ADR-3; plan Task 2/3).
 *
 * Rules-only (Plan B/T1): there is no explicit-role branch — an explicit
 * role existed only via the dsh-agent patch (removed), so resolution never
 * reads one. Precedence (first hit wins):
 * 1. the first `rules` entry whose specified origin/provider/model patterns
 *    all match the agent;
 * 2. `defaultRole` (`roles.default`, itself `'default'`).
 *
 * A missing agent origin is treated as `'root'`. Origin is read from
 * `session.header.origin` — a native `SessionHeader` field the store folds
 * from `CreateSessionOptions.meta.origin` (`packages/core/session/src/
 * index.ts:884`); subagent children set it via `childSessionMeta`
 * (`packages/subagent/subagent/src/child-agent.ts:115`), root agents carry
 * none. A subagent `persona` is NOT readable at the decision point:
 * `AgentOptions` is provider/model/maxTokens only, and persona is installed
 * as a scoped system-prompt section in the child's creation window — see
 * `guides/role-and-model-selection-exploration.md` (Role section).
 *
 * @module dsh-llm-fallbacks/roles
 */

/** Agent origins understood by role rules (spec §3). */
export type Origin = 'root' | 'subagent'

/** One role rule: any subset of origin/provider/model patterns → role. */
export interface RoleRule {
  origin?: Origin
  provider?: string
  model?: string
  role: string
}

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
 * listed order) → `defaultRole`. Rules-only — an explicit-role field (dsh
 * patch, removed) is never consulted.
 */
export function resolveRole(agent: AgentLike, rules: RoleRule[], defaultRole: string): string {
  const origin = agent.session?.header?.origin ?? 'root'
  for (const rule of rules) {
    if (rule.origin && rule.origin !== origin) continue
    if (rule.provider && rule.provider !== agent.options?.provider) continue
    if (rule.model && rule.model !== agent.options?.model) continue
    return rule.role
  }
  return defaultRole
}
