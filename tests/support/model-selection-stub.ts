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
 * rc.1 signature: `installModelSelection(agentCtx)` takes only the agent-scoped
 * context. The selection itself is no longer a mutable ref handed in by the
 * caller — the host listener reads the step's captured `modelSelection` (and
 * the session's last request header); see plan `dsh-022-rc1-upgrade`.
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
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

export type { ModelSelection }

/**
 * Register the REAL host `installModelSelection` on `ctx`.
 *
 * @param ctx - the context to register on (the shared test context).
 * @returns the host disposer (the listener also dies with the context fiber).
 */
export function installModelSelectionStub(ctx: Context): () => void {
  return installModelSelection(ctx)
}
