/**
 * Selector parsing for `fallbacks` chains (spec §4, plan Task 2).
 *
 * Grammar: `provider/model` (exact — the model segment may itself contain
 * `/`, e.g. NVIDIA NIM `nvidia/minimaxai/minimax-m3`) and `provider/*`
 * (wildcard — the parsed `model` is `undefined`; `*` is only valid as the
 * entire model segment). Illegal selectors throw {@link SelectorError} —
 * the catchable "config warning" path; warn-and-continue lives in Task 3.
 * These modules never crash on their own.
 *
 * @module dsh-llm-fallbacks/selectors
 */

/** A parsed selector: `provider` + optional `model` (`undefined` = wildcard). */
export interface Selector {
  provider: string
  model?: string
  /** Original selector string, kept for diagnostics/logging. */
  raw: string
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
  const modelPart = trimmed.slice(slash + 1).trim()
  if (!provider || !modelPart) {
    throw new SelectorError(`invalid selector "${input}": empty provider or model`)
  }
  // `*` is only valid as the entire model segment (the `provider/*`
  // wildcard); inside a model id it would blur the wildcard grammar.
  if (modelPart !== '*' && modelPart.includes('*')) {
    throw new SelectorError(`invalid selector "${input}": unexpected wildcard in model`)
  }
  const model = modelPart === '*' ? undefined : modelPart
  return { provider, model, raw: trimmed }
}

/**
 * Wildcard-entry resolution: keep the failing model id, swap only the
 * provider (`provider/*` entry semantics, spec §2 clause 2).
 */
export function resolveWildcardEntry(failingModel: string, provider: string): Selector {
  return { provider, model: failingModel, raw: `${provider}/${failingModel}` }
}
