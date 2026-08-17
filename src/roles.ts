/**
 * Role resolution for fallback chains (spec §7.1; plan fallbacks-role-runtime
 * Task 1).
 *
 * This module is the RULES stage. Dispatch-time role resolution
 * (plan fallbacks-role-automatch) is the three-stage resolver in
 * `role-resolution.ts` — explicit (`session.header.agentPreset`) → this
 * rules stage → an optional auto-match hook; `AgentLike` carries the additive
 * `session.header.agentPreset?` carrier for that explicit stage.
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
 * Role ids are canonicalized by trim (qc2 F-001, client-canonical trim
 * alignment — `validateFallbacksConfig` trims ids and rule references, so
 * the runtime must too): `roleIds` maps a TRIMMED id to the DECLARED RAW
 * id, membership compares `rule.role.trim()`, and a matched rule returns
 * the declared raw id — so roleDef lookups in `chains.ts` / `commands.ts`
 * match the stored `roles.list[].id` exactly and a padded YAML id
 * (`' coder '`) with a trimmed rule reference (`'coder'`) resolves to the
 * same role instead of silently degrading to `'inherit'`.
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
      /** Dispatch-time explicit role carrier (plan fallbacks-role-automatch Task 2). */
      agentPreset?: string
    }
  }
}

/**
 * Resolve the fallback-chain role for an agent: first matching rule (in
 * listed order) → the built-in `'inherit'` role. A rule targeting an id
 * outside the declared-id set ∪ {'inherit'} warns once and resolves to
 * `'inherit'` (the defensive path — `validateFallbacksConfig` already
 * warned at startup, spec §7.1).
 *
 * `roleIds` is the canonical trimmed-id map built by the wiring
 * (`trimmed id → declared raw id`, see `src/index.ts` apply()): a matched
 * rule returns the declared RAW id so the roleDef lookups in
 * `chains.ts` / `commands.ts` find the stored `roles.list[]` entry exactly
 * (qc2 F-001 — no silent rule inertness on padded YAML ids).
 *
 * `warn` defaults to `console.warn` (direct-call compatibility); the
 * decision path injects the cordis `logger.warn` so every plugin warning
 * flows through the plugin log namespace (qc2 F-002 / qc3 S-3).
 */
export function resolveRole(
  agent: AgentLike,
  rules: FallbacksRoleRule[],
  roleIds: ReadonlyMap<string, string>,
  warn: (message: string) => void = console.warn,
): string {
  const origin = agent.session?.header?.origin ?? 'root'
  for (const rule of rules) {
    if (rule.origin && rule.origin !== origin) continue
    if (rule.provider && rule.provider !== agent.options?.provider) continue
    if (rule.model && rule.model !== agent.options?.model) continue
    const target = rule.role.trim()
    if (target === INHERIT_ROLE_ID) return INHERIT_ROLE_ID
    const declared = roleIds.get(target)
    if (declared === undefined) {
      warn(`llm-fallbacks: rule references undeclared role "${rule.role}" — falling back to "inherit"`)
      return INHERIT_ROLE_ID
    }
    return declared
  }
  return INHERIT_ROLE_ID
}
