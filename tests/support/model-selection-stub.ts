/**
 * In-test registration seam for the host's `installModelSelection`
 * (`@deepseek-ai/dsh-agent/model-selection`).
 *
 * **The real host implementation is registered here — nothing is mirrored.**
 * A hand copy lived here until plan `model-change-notice-loop` QC1 I-2: the
 * repo's own policy is that the real `@deepseek-ai/dsh-agent` module is the only
 * truth (`tests/host-native.spec.ts`), the function is a public root export
 * (`@deepseek-ai/dsh-agent/lib/index.js`, re-exported by
 * `lib/types/index.d.ts`), and a copy is exactly the failure mode this suite
 * already paid for once — Task 4 had to *add* the omitted `agent/pre-step`
 * notice listener because the copy mirrored only `agent/request`, which is why
 * the suite stayed green while production injected a durable
 * `[model changed: …]` notice on every admitted step (evidence E21). With the
 * copy gone, any upstream change to the listener, its comparison, or its
 * guards reaches this suite automatically (the plan's deferred upstream fix,
 * residual R-001, can no longer flip real behavior while the suite stays green).
 *
 * Registering the real function also installs its `system-prompt/assemble`
 * listener. That listener writes `selection.assembled` from `selection.current`
 * during prompt assembly; the shared test harness never dispatches
 * `system-prompt/assemble`, so a test that hand-sets `assembled` (the
 * composition-order cases) keeps full control of the captured selection while
 * the assemble arm stays real and inert. A test that wants the assemble arm to
 * run seeds `selection.current` and dispatches the event itself.
 *
 * The real function registers on an agent-scoped context; this seam registers
 * it on the shared test context — waterfall registration order is exactly what
 * the composition tests assert (cordis: first-registered listener = outer =
 * final say after `next()`), so the shared context is the right seam.
 *
 * @module tests/support/model-selection-stub
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'

export type { ModelSelection, ModelSelectionRef }

/**
 * Register the REAL host `installModelSelection` on `ctx`.
 *
 * @param ctx - the context to register on (the shared test context).
 * @param selection - the mutable selection the host listeners read.
 * @returns the host disposer (the listeners also die with the context fiber).
 */
export function installModelSelectionStub(ctx: Context, selection: ModelSelectionRef): () => void {
  return installModelSelection(ctx, selection)
}
