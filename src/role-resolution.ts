/**
 * Dispatch-time role resolution (plan fallbacks-role-automatch Task 2; the
 * dispatch-role stage added by plan dsh-148-agent-team-role-delivery Task 1).
 *
 * Precedence (first hit wins) across four ordered stages:
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
 *    resolve to `'inherit'`);
 * 4. auto-match — only when stage 3 resolved to `'inherit'` AND
 *    `opts.automatchEnabled`: call `opts.automatch` with the agent. The hook
 *    (Task 3 supplies the bounded LLM caller) MUST return a declared raw id
 *    or `null`; the resolver defensively validates the return against
 *    `roleIds` — an unknown id warns and resolves to `'inherit'`, never an
 *    undeclared role. When `automatch` is undefined or `automatchEnabled`
 *    is false the hook is skipped.
 *
 * `'inherit'` is the single "no specific role" outcome — reached by
 * no-rule-match OR an explicit rule targeting `'inherit'` — and both are
 * auto-match eligible when enabled. An operator who wants a class to never
 * auto-match sets `roleAutoMatch: false` (→ `automatchEnabled: false`).
 *
 * Pure ordering logic: no config object and no LLM service inside this
 * module — the LLM is an injectable hook owned by Task 3/4.
 *
 * @module dsh-llm-fallbacks/role-resolution
 */

import { INHERIT_ROLE_ID, type FallbacksRoleRule } from './config.ts'
import { resolveRole, type AgentLike } from './roles.ts'
import type { Selector } from './selectors.ts'

export type { FallbacksRoleRule } from './config.ts'

/** Options for {@link resolveRoleAtDispatch}. */
export interface ResolveRoleAtDispatchOptions {
  /**
   * Dispatch-declared role: the DECLARED RAW id the seam resolved from the
   * Assignment/teammate prompt (`**Execute as**: <id>`). Validated against the
   * live `roleIds` map; absent, `inherit`, or no-longer-declared → skipped.
   */
  dispatchRole?: string
  /**
   * Whether the auto-match stage may run (the `roleAutoMatch` config switch).
   * When `false`, stage 4 never runs and the outcome is identical to the
   * explicit/dispatch/rules stages alone.
   */
  automatchEnabled: boolean
  /**
   * Auto-match hook — Task 3 supplies the bounded LLM caller; the resolver
   * itself contains no LLM. Contract: given the agent being resolved, return
   * a declared raw role id or `null`. The resolver defensively validates the
   * return against `roleIds` — an unknown id warns and resolves to
   * `'inherit'`, never an undeclared role. Skipped when undefined.
   */
  automatch?: (agent: AgentLike) => Promise<string | null>
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
 * Resolve the dispatch-time role for an agent across four ordered stages
 * (explicit → dispatch → rules → auto-match hook). Never throws on its own
 * inputs; the hook's own rejection is deliberately NOT caught here (the
 * Task-3/4 wiring bounds the LLM call so it never throws out of the request
 * path).
 *
 * `roleIds` is the canonical trimmed-id map (`trimmed id → declared raw id`,
 * built in `src/index.ts` apply()): every stage canonicalizes its reference
 * by trim and returns the DECLARED RAW id, so roleDef lookups in
 * `chains.ts` / `commands.ts` find the stored `roles.list[]` entry exactly
 * (qc2 F-001 — no silent role inertness on padded YAML ids).
 */
export async function resolveRoleAtDispatch(
  agent: AgentLike,
  rules: FallbacksRoleRule[],
  roleIds: ReadonlyMap<string, string>,
  opts: ResolveRoleAtDispatchOptions,
): Promise<string> {
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
  const role = resolveRole(agent, rules, roleIds, opts.warn, opts.servedRoute)
  if (role !== INHERIT_ROLE_ID) return role

  // Stage 4 — auto-match hook, only when stage 3 → 'inherit' AND enabled.
  if (opts.automatchEnabled && opts.automatch !== undefined) {
    const picked = await opts.automatch(agent)
    if (picked !== null && picked !== undefined) {
      const declared = roleIds.get(picked.trim())
      if (declared !== undefined) return declared
      opts.warn(`llm-fallbacks: auto-match returned undeclared role "${picked}" — falling back to "inherit"`)
    }
  }

  return INHERIT_ROLE_ID
}

/**
 * The dispatch-time chain head (plan fallbacks-role-automatch Task 4): the
 * FIRST candidate of a `resolveChainViews` pass whose `wildcard` flag is
 * false — an exact `provider/model` entry. `provider/*` entries are NOT
 * dispatch injection targets (no failing model to anchor them; a guessed
 * injection risks a hard failure whose code may sit outside `triggerCodes`),
 * so a wildcard-only chain yields `undefined` → no injection (today's
 * behavior). No cooldown/failed filtering and no existence probe run here —
 * a fresh subagent's first request has no failure-scoped state (see the Task
 * 4 decision) and exact heads are never probed. Pairs with
 * {@link resolveChainViews}'s parallel `wildcard` provenance (`src/chains.ts`);
 * the caller resolves the role's concatenated chain first.
 */
export function firstExactCandidate(
  all: readonly Selector[],
  wildcard: readonly boolean[],
): Selector | undefined {
  for (let index = 0; index < all.length; index += 1) {
    if (!wildcard[index]) return all[index]
  }
  return undefined
}
