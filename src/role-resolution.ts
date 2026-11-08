/**
 * Dispatch-time role resolution (named virtual chains, plan
 * named-virtual-chains T3): narrowed to TWO stages —
 * 1. explicit — `session.header.agentPreset` trimmed matches a declared role
 *    id → that role's DECLARED RAW id (via the `roleIds` trimmed-id map); the
 *    reserved `'inherit'` and undeclared presets are NEVER dispatchable
 *    explicit roles;
 * 2. dispatch — `opts.dispatchRole`: the role the dispatch seam resolved from
 *    the Assignment/teammate prompt (`**Execute as**: <id>`, the single
 *    parser in `src/subagents-seam.ts`), canonicalized by the same trim +
 *    `roleIds` lookup. An absent, empty, `'inherit'` or no-longer-declared
 *    reference resolves to `undefined` — no role, no error.
 *
 * The rules stage is DELETED with `roles.rules` (v2). `undefined` is the
 * single "no specific role" outcome — the plugin does not intervene and the
 * child inherits the delegating agent's route.
 *
 * @module dsh-llm-fallbacks/role-resolution
 */

export interface DeclaredRoleOptions {
  /**
   * Dispatch-declared role: the DECLARED RAW id the seam resolved from the
   * Assignment/teammate prompt (`**Execute as**: <id>`). Validated against the
   * live `roleIds` map; absent, `inherit`, or no-longer-declared → skipped.
   */
  dispatchRole?: string
}

/**
 * The dispatch role: explicit preset → dispatch-declared. Returns
 * `undefined` when neither stage resolves (NOT SPECIFIED — no plugin
 * intervention).
 *
 * `roleIds` is the canonical trimmed-id map (`trimmed id → declared raw id`,
 * built in `src/index.ts` apply()): every stage canonicalizes its reference
 * by trim and returns the DECLARED RAW id.
 */
export function resolveDeclaredRole(
  agentPreset: string | undefined,
  roleIds: ReadonlyMap<string, string>,
  opts: DeclaredRoleOptions,
): string | undefined {
  // Stage 1 — explicit preset. 'inherit' and undeclared presets fall through
  // to the dispatch stage; a declared preset wins with its RAW id.
  const preset = agentPreset?.trim()
  if (preset !== undefined && preset !== '' && preset !== 'inherit') {
    const declared = roleIds.get(preset)
    if (declared !== undefined) return declared
  }

  // Stage 2 — dispatch-declared role (the seam's `**Execute as**: <id>` for
  // this child). Same trim + roleIds canonicalization; an undeclared
  // reference (the role was deleted after the dispatch) resolves to nothing
  // — it is not an error, and it warns nowhere.
  const dispatch = opts.dispatchRole?.trim()
  if (dispatch !== undefined && dispatch !== '' && dispatch !== 'inherit') {
    const declared = roleIds.get(dispatch)
    if (declared !== undefined) return declared
  }

  return undefined
}
