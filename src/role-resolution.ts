/**
 * Dispatch-time role resolution (plan fallbacks-role-automatch Task 2; the
 * dispatch-role stage added by plan dsh-148-agent-team-role-delivery Task 1).
 *
 * Precedence (first hit wins) across three ordered stages:
 * 1. explicit — `session.header.agentPreset` trimmed matches a declared role
 *    id → that role's DECLARED RAW id (via the `roleIds` trimmed-id map, the
 *    same canonicalization the rules path uses); the reserved `'inherit'`
 *    and undeclared presets are NEVER dispatchable explicit roles and fall
 *    through to the next stage;
 * 2. dispatch — `opts.dispatchRole`: the role the dispatch seam resolved from
 *    the Assignment/teammate prompt (`**Execute as**: <id>`, the single
 *    parser in `src/subagents-seam.ts`), canonicalized by the same trim +
 *    `roleIds` lookup. An absent, empty, `'inherit'` or no-longer-declared
 *    reference falls through silently — a role removed after the dispatch is
 *    not an error;
 * 3. rules — the existing `resolveRole` passthrough, unchanged (a declared
 *    role wins; no-rule-match / an explicit rule targeting `'inherit'`
 *    resolve to `'inherit'`).
 *
 * `'inherit'` is the single "no specific role" outcome — reached by
 * no-rule-match OR an explicit rule targeting `'inherit'`.
 *
 * There is deliberately NO auto-match stage: the only host point it ever had
 * was the deleted `agent/request` inject, and running an LLM call inside the
 * walk's `stream()` would be a nested request per failure (design
 * dsh-022-rc1-upgrade §2.2). Resolution is therefore pure and synchronous —
 * the walk must throw its pre-attempt errors before the first chunk.
 *
 * @module dsh-llm-fallbacks/role-resolution
 */

import { INHERIT_ROLE_ID, type FallbacksRoleRule } from './config.ts'
import { resolveRole, type AgentLike } from './roles.ts'

export type { FallbacksRoleRule } from './config.ts'

/** Options for {@link resolveDeclaredRole}. */
export interface DeclaredRoleOptions {
  /**
   * Dispatch-declared role: the DECLARED RAW id the seam resolved from the
   * Assignment/teammate prompt (`**Execute as**: <id>`). Validated against the
   * live `roleIds` map; absent, `inherit`, or no-longer-declared → skipped.
   */
  dispatchRole?: string
  /** Warning sink — the decision path injects the plugin logger. */
  warn: (message: string) => void
  /**
   * The route the agent's request was actually SERVED by, when that differs
   * from the pair recorded on the agent (the virtual `FallbacksChain/Auto`
   * row). Rule matching accepts either, so a rule keyed on the real chain head
   * keeps matching a child whose recorded route is the virtual pair (QC1 I-1).
   * `undefined` for every real route.
   */
  servedRoute?: { provider: string; model: string }
}

/**
 * The dispatch role: explicit → dispatch-declared → rules.
 *
 * `roleIds` is the canonical trimmed-id map (`trimmed id → declared raw id`,
 * built in `src/index.ts` apply()): every stage canonicalizes its reference
 * by trim and returns the DECLARED RAW id, so roleDef lookups in
 * `chains.ts` / `commands.ts` find the stored `roles.list[]` entry exactly
 * (qc2 F-001 — no silent role inertness on padded YAML ids).
 */
export function resolveDeclaredRole(
  agent: AgentLike,
  rules: FallbacksRoleRule[],
  roleIds: ReadonlyMap<string, string>,
  opts: DeclaredRoleOptions,
): string {
  // Stage 1 — explicit (architect-locked semantics). 'inherit' and undeclared
  // presets fall through to the later stages; a declared preset wins with its
  // RAW id.
  const preset = agent.session?.header?.agentPreset?.trim()
  if (preset !== undefined && preset !== '' && preset !== INHERIT_ROLE_ID) {
    const declared = roleIds.get(preset)
    if (declared !== undefined) return declared
  }

  // Stage 2 — dispatch-declared role (the seam's `**Execute as**: <id>` for
  // this child). Same trim + roleIds canonicalization; an undeclared
  // reference (the role was deleted after the dispatch) falls through
  // silently — it is not an error, and it warns nowhere.
  const dispatch = opts.dispatchRole?.trim()
  if (dispatch !== undefined && dispatch !== '' && dispatch !== INHERIT_ROLE_ID) {
    const declared = roleIds.get(dispatch)
    if (declared !== undefined) return declared
  }

  // Stage 3 — rules (existing resolveRole passthrough, unchanged).
  return resolveRole(agent, rules, roleIds, opts.warn, opts.servedRoute)
}
