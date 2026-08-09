/**
 * Selector parsing for `fallbacks` chains (spec §4, plan Task 2).
 *
 * Grammar: `provider/model` (exact) and `provider/*` (wildcard — the parsed
 * `model` is `undefined`). Illegal selectors throw {@link SelectorError} —
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
 * on anything else (missing separator, empty parts, extra separators).
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
  const provider = trimmed.slice(0, slash)
  const modelPart = trimmed.slice(slash + 1)
  if (!provider.trim() || !modelPart.trim()) {
    throw new SelectorError(`invalid selector "${input}": empty provider or model`)
  }
  if (modelPart.includes('/')) {
    throw new SelectorError(`invalid selector "${input}": unexpected extra separator`)
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
