/**
 * In-test semantic double for `installModelSelection`
 * (`@deepseek-ai/dsh-agent/model-selection`; plan Task 4 — T3 review ⚠️3
 * composition-order assertions). Mirrors the real listener's `agent/request`
 * contract (packages/core/agent/src/model-selection.ts): `await next()`, then
 * apply the assembled selection on top of the resolved config, dropping any
 * inherited `reasoningEffort` (the `withoutInheritedEffort` pattern).
 *
 * The real one registers on an agent-scoped context; the double registers on
 * the shared test context — waterfall registration order is exactly what the
 * composition tests assert, so the shared context is the right seam.
 *
 * @module tests/support/model-selection-stub
 */

import type { Context } from 'cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Complete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

/**
 * Install the model-selection double: an `agent/request` listener that applies
 * `selection.assembled` on top of the resolved config when one exists.
 * @returns the disposer (listeners also die with the context fiber).
 */
export function installModelSelectionStub(ctx: Context, selection: ModelSelectionRef): () => void {
  return ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
}
