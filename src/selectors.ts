/**
 * Selector parsing for `fallbacks` chains (spec §4, plan Task 2).
 *
 * Grammar: `provider/model` (exact — the model segment may itself contain
 * `/`, e.g. NVIDIA NIM `nvidia/minimaxai/minimax-m3`) and `provider/*`
 * (wildcard — the parsed `model` is `undefined`; `*` is only valid as the
 * entire model segment). Either form may carry ONE trailing pinned reasoning
 * effort, `…@<effort>`, split off the LAST `@` of the model segment; a suffix
 * that is not an effort id stays model text (so exotic model ids keep their
 * `@`). The effort never enters {@link selectorKey} — it is a per-hop request
 * control, not part of the route identity. Illegal selectors throw
 * {@link SelectorError} —
 * the catchable "config warning" path; warn-and-continue lives in Task 3.
 * These modules never crash on their own.
 *
 * @module dsh-llm-fallbacks/selectors
 */

/** A parsed selector: `provider` + optional `model` (`undefined` = wildcard). */
export interface Selector {
  provider: string
  model?: string
  /**
   * Pinned reasoning effort of this hop (`provider/model@effort`), absent when
   * the entry follows the session's own selection. Applies to the request, so
   * it is deliberately NOT part of the route identity ({@link selectorKey}).
   */
  effort?: string
  /** Original selector string, kept for diagnostics/logging. */
  raw: string
}

/**
 * The one accepted effort grammar of the `@effort` suffix. A lowercase id —
 * the catalog's own effort ids are lowercase (`off`, `low`, `high`, `max`).
 * Any other suffix after the last `@` is MODEL TEXT, never a parse error: a
 * hand-written model id carrying an `@` must keep working, and a typo must not
 * silently become a route.
 */
const EFFORT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * Split a trailing `@<effort>` off one model segment.
 * @param modelPart - the (already trimmed) model segment of the entry.
 * @returns the model id without the suffix, plus the effort when the suffix is
 *   a legal effort id. The `@` at index 0 is not a suffix (there is no model
 *   before it), so it stays model text.
 */
function splitEffort(modelPart: string): { model: string; effort?: string } {
  const at = modelPart.lastIndexOf('@')
  if (at <= 0) return { model: modelPart }
  const suffix = modelPart.slice(at + 1)
  if (!EFFORT_ID_RE.test(suffix)) return { model: modelPart }
  return { model: modelPart.slice(0, at), effort: suffix }
}

/** Catchable error for illegal/unknown selectors (config-warning path). */
export class SelectorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectorError'
  }
}

/** Canonical key: `provider/model`, or `provider/*` for a wildcard model. */
export function selectorKey(provider: string, model?: string): string {
  return model === undefined ? `${provider}/*` : `${provider}/${model}`
}

/**
 * Parse a chain key or entry selector.
 *
 * Accepts `provider/model` and `provider/*`; throws {@link SelectorError}
 * on anything else (missing separator, empty parts, wildcard inside the
 * model segment).
 */
export function parseSelector(input: string): Selector {
  if (typeof input !== 'string') {
    throw new SelectorError(`invalid selector ${String(input)}: expected "provider/model" or "provider/*"`)
  }
  const trimmed = input.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new SelectorError(`invalid selector "${input}": expected "provider/model" or "provider/*"`)
  }
  // Trim inside each segment too (T2 review Minor #1): 'openai/ gpt-4o' and
  // ' openai /gpt-4o ' must parse to canonical provider/model instead of
  // silently carrying whitespace into a never-matching candidate/chain key.
  const provider = trimmed.slice(0, slash).trim()
  const rawModelPart = trimmed.slice(slash + 1).trim()
  if (!provider || !rawModelPart) {
    throw new SelectorError(`invalid selector "${input}": empty provider or model`)
  }
  const { model: modelPart, effort } = splitEffort(rawModelPart)
  // `*` is only valid as the entire model segment (the `provider/*`
  // wildcard); inside a model id it would blur the wildcard grammar.
  if (modelPart !== '*' && modelPart.includes('*')) {
    throw new SelectorError(`invalid selector "${input}": unexpected wildcard in model`)
  }
  const model = modelPart === '*' ? undefined : modelPart
  // The key is omitted (not `undefined`) when the entry pins no effort, so an
  // effort-free parse stays deep-equal to the pre-@effort shape.
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
    raw: trimmed,
  }
}

/**
 * Wildcard-entry resolution: keep the failing model id, swap only the
 * provider (`provider/*` entry semantics, spec §2 clause 2).
 */
export function resolveWildcardEntry(failingModel: string, provider: string, effort?: string): Selector {
  return {
    provider,
    model: failingModel,
    ...(effort === undefined ? {} : { effort }),
    raw: effort === undefined ? `${provider}/${failingModel}` : `${provider}/${failingModel}@${effort}`,
  }
}
