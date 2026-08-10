/**
 * dsh-llm-fallbacks client half (plan Task 5): registers the Fallbacks
 * settings page into the web settings GUI.
 *
 * Wiring (mirrors ui-settings-general / ui-models):
 * - Registers the `fallbacks` locale dictionaries (zh/en).
 * - Constructs the section's own store over the settings loopback API
 *   (`settings.describe` read + `settings.update`/`replace` writes with
 *   `expectedRevision`; see `fallbacks-store.ts`).
 * - Registers the `settings.section` entry `id: 'fallbacks'` (order 30, after
 *   the Models section at 10) with a locale-following nav label thunk; owner
 *   props are empty and all data flows through the store (slot contract).
 * - Refreshes the store on pushed invalidations (`settings/changed` for the
 *   fallbacks namespace, `connection/reset`).
 *
 * @module dsh-llm-fallbacks/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `ctx.locale` Context merge (LocaleService face).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the shell's `settings.section` SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { FallbacksSection } from './FallbacksSection.tsx'
import {
  FallbacksSettingsController, FALLBACKS_SETTINGS_NS,
  refreshCatalogIfLoaded, refreshFallbacksIfLoaded,
} from './fallbacks-store.ts'
import { en, NS, zh } from './locales.ts'

export type { FallbacksSectionInjected, FallbacksSectionProps } from './FallbacksSection.tsx'
export type { FallbacksSettingsState } from './fallbacks-store.ts'
export { FallbacksSettingsController, FALLBACKS_SETTINGS_NS } from './fallbacks-store.ts'

/** Required services (cordis fiber inject); registrations wait on the slot declaration. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the `fallbacks` dictionaries and the settings section once the
 * `settings.section` declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallbacks: dictionaries')

  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new FallbacksSettingsController(connection.api)

  // Pushed invalidations converge every open surface without polling:
  // `settings/changed` refetches the descriptor, `models/changed` refetches
  // only the provider/model catalog (never the form), and `connection/reset`
  // refetches both.
  ctx.effect(() => {
    const refresh = (ns?: string): void => {
      if (ns !== undefined && ns !== FALLBACKS_SETTINGS_NS) return
      refreshFallbacksIfLoaded(controller)
    }
    const refreshCatalog = (): void => { refreshCatalogIfLoaded(controller) }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('models/changed', refreshCatalog),
      ctx.on('connection/reset', () => { refresh(); refreshCatalog() }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      // F-006 / M-01: stop in-flight describe/update/replace responses from
      // publishing to the dead store once the plugin unloads (HMR/dispose) —
      // the generation guard only helps when it is actually bumped here.
      controller.dispose()
    }
  }, 'llm-fallbacks: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'fallbacks',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ controller }),
  }, FallbacksSection))
}
