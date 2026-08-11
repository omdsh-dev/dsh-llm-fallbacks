/**
 * In-test semantic double for `installModelSelection`
 * (`@deepseek-ai/dsh-agent/model-selection`). Mirrors the REAL host
 * listener's `agent/request` contract (packages/core/agent/src/model-selection.ts):
 * `await next()`, then apply the assembled selection on top of the resolved
 * config, dropping any inherited `reasoningEffort` (the
 * `withoutInheritedEffort` pattern). It is the host-NATIVE double — the
 * fallback-routing marker check that used to live here (spec §2.5 D-1,
 * local dsh-agent patch) is gone with the patch removal (plan
 * llm-fallbacks-runtime-depatch, T2).
 *
 * The real one registers on an agent-scoped context; the double registers on
 * the shared test context — waterfall registration order is exactly what the
 * composition tests assert (cordis: first-registered listener = outer =
 * final say after `next()`), so the shared context is the right seam.
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
 * `selection.assembled` on top of the resolved config whenever one exists —
 * unconditionally, exactly like the host-native listener. Under an active
 * selection this re-apply clobbers an inner plugin's switch override (the
 * documented degradation); when the plugin's listener is outer, the plugin
 * applies its switch AFTER this listener's re-apply, so the switch wins.
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
