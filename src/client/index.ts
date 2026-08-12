/**
 * dsh-llm-fallbacks client half: registers the Fallbacks card into the
 * plugin-config page's `settings.plugin.item` slot (the official "插件配置"
 * settings page — id `fallbacks`, order 30, alongside the upstream bash /
 * agent-loop / web-search cards and the advisor card).
 *
 * Wiring (mirrors dsh-advisor):
 * - Registers the `fallbacks` locale dictionaries (zh/en).
 * - Constructs the card's own store over the connection: the fallbacks
 *   config rides the plugin's gateway channel (`connection.rpc` →
 *   `/api/fallbacks/get|set|reset`), while `settings.describe` (writable +
 *   namespace directory) and the provider/model catalog stay on
 *   `connection.api` (see `fallbacks-store.ts`).
 * - Registers the `settings.plugin.item` card `id: 'fallbacks'` (order 30)
 *   with a business-only inject face ({@link FallbacksSettingsController} +
 *   the snapshot-selector hook); the old `settings.section` registration
 *   (the Settings nav entry) is removed — deleting the section registration
 *   deletes the nav entry.
 * - Refreshes the store on pushed invalidations (`settings/changed` for the
 *   fallbacks namespace, `models/changed` for the catalog, `connection/reset`)
 *   and follows the current session (`sessions.list`) so the status block's
 *   recent-switch summary tracks the session being viewed (spec §2.5 D-5).
 *   `sessions` is an optional reflection read (S-g): a host without the
 *   session service leaves the switches face in its empty ready state.
 *   (`remote` is injected for the Task 3 event-drift rewiring but not yet
 *   consumed.)
 *
 * @module dsh-llm-fallbacks/client
 */

import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the `ctx.locale` Context merge (LocaleService face).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the plugin-config card slot's SlotMap merge (the
// 'settings.plugin.item' entry — this half's registration target). Same empty
// type-only import pattern as the old ui-settings one: it loads the module's
// types (the ./client entry re-exports the slot-contract merge) without any
// value import.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-config/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { FallbacksSection as FallbacksCard } from './FallbacksSection.tsx'
import {
  FallbacksSettingsController, FALLBACKS_SETTINGS_NS,
  refreshCatalogIfLoaded, refreshFallbacksIfLoaded, refreshSwitchesIfLoaded,
} from './fallbacks-store.ts'
import { en, NS, zh } from './locales.ts'

export type { FallbacksSectionInjected, FallbacksSectionProps } from './FallbacksSection.tsx'
export type { FallbacksSettingsState } from './fallbacks-store.ts'
export { FallbacksSettingsController, FALLBACKS_SETTINGS_NS } from './fallbacks-store.ts'

/**
 * Required services (cordis fiber inject); registrations wait on the slot
 * declaration. `sessions` is deliberately NOT injected (S-g): a non-web host
 * without the dsh-session client service must not hang the fiber waiting for
 * it — the wiring reads it reflectively and degrades to the switches empty
 * state when absent (`setCurrentSession` never called, `loadSwitches` ready
 * with an empty array, which the store already supports).
 */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Register the `fallbacks` dictionaries and the plugin-config card once the
 * `settings.plugin.item` declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallbacks: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  // The host (`dsh-session` SessionStore) and client (`ISessions`) Context
  // merges collide in out-of-tree client programs, so read the service through
  // the reflection layer with the client face pinned — the same pattern as the
  // `connection` handle above (the dsh repo keeps the two merges in separate
  // tsconfig programs; a third program sees both). `sessions` is optional
  // (S-g): absent on a non-web host → the switches face stays empty.
  const sessions = ctx.get('sessions') as unknown as ISessions | undefined
  // The store reads/writes the fallbacks config over the connection's
  // generic RPC channel (the host gateway `/api/fallbacks/get|set|reset`);
  // the describe `writable` + namespace directory and the provider/model
  // catalog still ride `connection.api` (guide §9).
  const controller = new FallbacksSettingsController(connection.api, connection.rpc)
  // The card's uSES selector hook, bound once to the controller's store and
  // handed to the renderer through the inject face (advisor pattern).
  const useSnapshot = bindSnapshotSelector(controller.store)

  // Pushed invalidations converge every open surface without polling:
  // `settings/changed` refetches the descriptor + recent-switch summary,
  // `models/changed` refetches only the provider/model catalog (never the
  // form), `connection/reset` refetches all three, and a `sessions.list`
  // current change reloads the status block's switches for the new session
  // (spec §2.5 D-5; the subscription also covers reconnects, which re-pull
  // the list).
  ctx.effect(() => {
    const syncSession = (): void => {
      controller.setCurrentSession(sessions?.list.getSnapshot().current)
    }
    if (sessions !== undefined) syncSession()
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
      ...(sessions === undefined ? [] : [sessions.list.subscribe(syncSession)]),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      // F-006 / M-01: stop in-flight describe/get/set/reset/history
      // responses from publishing to the dead store once the plugin unloads
      // (HMR/dispose) — the generation guard only helps when it is actually
      // bumped here.
      controller.dispose()
    }
  }, 'llm-fallbacks: pushed invalidations')

  // The card registers into the plugin-config page's card slot with the
  // upstream card shape — generator + `yield`, `locale: NS`, and an inject
  // face carrying ONLY the business surface (controller + useSnapshot). The
  // typed `t` seat is synthesized by the renderer from `locale: NS`
  // (PropsLocale<'fallbacks'>), exactly like the upstream three cards and
  // the advisor card; the old `settings.section` registration (the Settings
  // nav "Fallbacks" entry) is removed — deleting the section registration
  // deletes the nav entry. `order: 30` ties with the advisor card; ties are
  // resolved by registration sequence (ui-slots stable sort).
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'fallbacks',
      order: 30, // bash 0 / agent-loop 10 / web-search 20 / advisor 30 / fallbacks 30
      locale: NS,
      inject: () => ({ controller, useSnapshot }),
    }, FallbacksCard)
  })
}
