/**
 * Role resolution for fallback chains (spec §3, ADR-3; plan Task 2).
 *
 * Precedence (first hit wins):
 * 1. `agent.options.role` — the explicit role (dsh patch, Task 6);
 * 2. the first `rules` entry whose specified origin/provider/model patterns
 *    all match the agent;
 * 3. `defaultRole` (`roles.default`, itself `'default'`).
 *
 * A missing agent origin is treated as `'root'` — root agents carry no
 * `session.meta.origin`. Unspecified rule fields do not constrain.
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
    role?: string
    provider?: string
    model?: string
  }
  session?: {
    meta?: {
      origin?: Origin
    }
  }
}

/**
 * Resolve the fallback-chain role for an agent: explicit `options.role` →
 * first matching rule (in listed order) → `defaultRole`.
 */
export function resolveRole(agent: AgentLike, rules: RoleRule[], defaultRole: string): string {
  if (agent.options?.role) return agent.options.role
  const origin = agent.session?.meta?.origin ?? 'root'
  for (const rule of rules) {
    if (rule.origin && rule.origin !== origin) continue
    if (rule.provider && rule.provider !== agent.options?.provider) continue
    if (rule.model && rule.model !== agent.options?.model) continue
    return rule.role
  }
  return defaultRole
}
