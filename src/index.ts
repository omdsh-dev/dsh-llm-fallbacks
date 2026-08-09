/**
 * dsh-llm-fallbacks host half (skeleton).
 *
 * Cordis function plugin mounted by the profile bundle patch row
 * `llm-fallbacks` (see `bundle/cordis.patch.yml`). Task 1 ships the
 * loadable skeleton only: the real work — `fallbacks` settings namespace,
 * `agent/request-error` + `agent/request` waterfall decisions, per-agent
 * state machine, `fallbacks/switch` session events — lands in Tasks 2/3.
 *
 * @module dsh-llm-fallbacks
 */

import type { Context } from 'cordis'
import z from 'schemastery'

/** The plugin row id mounted by the profile bundle patch. */
export const name = 'llm-fallbacks'

/** No host config in the skeleton — the `fallbacks` settings namespace arrives with Task 2/3. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

export function apply(ctx: Context): void {
  ctx.logger('llm-fallbacks').info('dsh-llm-fallbacks skeleton loaded — fallback logic lands in Tasks 2/3')
}
