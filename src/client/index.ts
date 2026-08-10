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
 *   fallbacks namespace, `models/changed` for the catalog, `connection/reset`)
 *   and follows the current session (`sessions.list`) so the status block's
 *   recent-switch summary tracks the session being viewed (spec §2.5 D-5).
 *
 * @module dsh-llm-fallbacks/client
 */

import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `ctx.locale` Context merge (LocaleService face).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the shell's `settings.section` SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { FallbacksSection } from './FallbacksSection.tsx'
import {
  FallbacksSettingsController, FALLBACKS_SETTINGS_NS,
  refreshCatalogIfLoaded, refreshFallbacksIfLoaded, refreshSwitchesIfLoaded,
} from './fallbacks-store.ts'
import { en, NS, zh } from './locales.ts'

export type { FallbacksSectionInjected, FallbacksSectionProps } from './FallbacksSection.tsx'
export type { FallbacksSettingsState } from './fallbacks-store.ts'
export { FallbacksSettingsController, FALLBACKS_SETTINGS_NS } from './fallbacks-store.ts'

/** Required services (cordis fiber inject); registrations wait on the slot declaration. */
export const inject = ['slots', 'locale', 'connection', 'sessions']

/**
 * Register the `fallbacks` dictionaries and the settings section once the
 * `settings.section` declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallbacks: dictionaries')

  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  // The host (`dsh-session` SessionStore) and client (`ISessions`) Context
  // merges collide in out-of-tree client programs, so read the service through
  // the reflection layer with the client face pinned — the same pattern as the
  // `connection` handle above (the dsh repo keeps the two merges in separate
  // tsconfig programs; a third program sees both).
  const sessions = ctx.get('sessions') as unknown as ISessions
  const controller = new FallbacksSettingsController(connection.api)

  // Pushed invalidations converge every open surface without polling:
  // `settings/changed` refetches the descriptor + recent-switch summary,
  // `models/changed` refetches only the provider/model catalog (never the
  // form), `connection/reset` refetches all three, and a `sessions.list`
  // current change reloads the status block's switches for the new session
  // (spec §2.5 D-5; the subscription also covers reconnects, which re-pull
  // the list).
  ctx.effect(() => {
    const syncSession = (): void => {
      controller.setCurrentSession(sessions.list.getSnapshot().current)
    }
    syncSession()
    const refresh = (ns?: string): void => {
      if (ns !== undefined && ns !== FALLBACKS_SETTINGS_NS) return
      refreshFallbacksIfLoaded(controller)
      refreshSwitchesIfLoaded(controller)
    }
    const refreshCatalog = (): void => { refreshCatalogIfLoaded(controller) }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('models/changed', refreshCatalog),
      ctx.on('connection/reset', () => { refresh(); refreshCatalog() }),
      sessions.list.subscribe(syncSession),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      // F-006 / M-01: stop in-flight describe/update/replace/history
      // responses from publishing to the dead store once the plugin unloads
      // (HMR/dispose) — the generation guard only helps when it is actually
      // bumped here.
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
