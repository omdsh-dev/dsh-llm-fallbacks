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
 *   the snapshot-selector hook); the old Settings-nav section registration
 *   is removed — deleting the section registration deletes the nav entry.
 * - Refreshes the store on pushed invalidations — the forwarded remote
 *   events `settings/document-updated` (ns-filtered to the fallbacks
 *   namespace; refetches the descriptor + recent-switch summary) and
 *   `llm/adapters-updated` (refetches only the provider/model catalog), plus
 *   the client `connection/reset` (refetches all three) — and follows the
 *   current session (`sessions.list`) so the status block's recent-switch
 *   summary tracks the session being viewed (spec §2.5 D-5). `sessions` is
 *   an optional reflection read (S-g): a host without the session service
 *   leaves the switches face in its empty ready state.
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
// Type-only: the settings domain's slot-contract merge (the
// 'settings.general.item' entry — the General page status row's registration
// target). Same empty type-only pattern; the ui-settings package is already
// a type-only peer (`peerDependencies`) and a manifest inject entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the conversation domain's slot-contract merge (the
// 'conversation.chat.node' keyed entry — the transcript switch node's
// registration target) + the `ChatNodeDataMap` key seat. Same empty
// type-only pattern; the ui-conversation package joins the type-only peers
// and the manifest inject list with this registration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the gateway's Client half declares `ctx.remote` (the typed
// Remote service) on the cordis Context face.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// Type-only: the forwarded-event allowlist seat (`TypeRTRemoteEventSelection`)
// — the `$on` key projection the invalidation subscriptions subscribe through.
import type {} from '@deepseek-ai/dsh-api-remotes/types'
// Type-only: the settings seam's cordis `Events` entry
// (`settings/document-updated` with the branded `SettingsNamespace`) and the
// llm registry's (`llm/adapters-updated` payload-free) — same pattern as
// dsh-client-ui-settings' settings-scope (types subpath, no value import).
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { FallbacksCard } from './FallbacksCard.tsx'
import { GeneralFallbacksRow } from './GeneralFallbacksRow.tsx'
import {
  ConversationFallbackSwitch, fallbackSwitchDefinition,
} from './ConversationFallbackSwitch.tsx'
import {
  FallbacksSettingsController, FALLBACKS_SETTINGS_NS,
  refreshCatalogIfLoaded, refreshFallbacksIfLoaded, refreshSwitchesIfLoaded,
} from './fallbacks-store.ts'
import { en, NS, zh } from './locales.ts'

export type { FallbacksCardInjected, FallbacksCardProps } from './FallbacksCard.tsx'
export type { GeneralFallbacksRowInjected, GeneralFallbacksRowProps } from './GeneralFallbacksRow.tsx'
export type {
  ConversationFallbackSwitchProps, FallbacksSwitchChatData,
} from './ConversationFallbackSwitch.tsx'
export type { FallbacksSettingsState } from './fallbacks-store.ts'
export { FallbacksSettingsController, FALLBACKS_SETTINGS_NS } from './fallbacks-store.ts'

/**
 * Required services (cordis fiber inject); registrations wait on the slot
 * declaration. `conversationEvents` is declared because the D1 Definition
 * registration reads the service directly (`ctx.conversationEvents.register`
 * at the bottom of `apply` — explicit fiber-ordering parity with the
 * ui-workflow-run precedent, whose inject list includes it for the same
 * direct read). The runtime would still provide the service synchronously
 * on apply, but the declaration makes the dependency honest. `sessions` is
 * deliberately NOT injected (S-g): a non-web host without the dsh-session
 * client service must not hang the fiber waiting for it — the wiring reads
 * it reflectively and degrades to the switches empty state when absent
 * (`setCurrentSession` never called, `loadSwitches` ready with an empty
 * array, which the store already supports).
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'conversationEvents']

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

  // Pushed invalidations converge every open surface without polling. The
  // 20260811 dsh snapshot dropped the client-side settings/catalog events;
  // the runtime now forwards the settings seam's raw-section event and the
  // llm registry's topology event through the `remote` service (inject list):
  // - `settings/document-updated(ns, revision)` — ns-filtered to the
  //   fallbacks namespace; refetches the descriptor + recent-switch summary
  //   (never the catalog),
  // - `llm/adapters-updated()` — payload-free; refetches only the
  //   provider/model catalog (never the form),
  // - `connection/reset` — client event; refetches all three, coalesced
  //   through the advisor microtask debounce (a burst of resets = one
  //   refetch; the IfLoaded guards keep an unopened card idle),
  // - a `sessions.list` current change reloads the status block's switches
  //   for the new session (spec §2.5 D-5; the subscription also covers
  //   reconnects, which re-pull the list).
  ctx.effect(() => {
    const syncSession = (): void => {
      controller.setCurrentSession(sessions?.list.getSnapshot().current)
    }
    if (sessions !== undefined) syncSession()
    // The `$on` listener seat is `Events['settings/document-updated']`
    // (`(ns: SettingsNamespace, revision: number) => void`); the widened
    // optional-string param mirrors dsh-client-ui-settings' settings-scope
    // (`refresh` bound to the same remote event), and `undefined` ns passes
    // the filter so the connection/reset path can share this helper.
    const refresh = (ns?: string): void => {
      if (ns !== undefined && ns !== FALLBACKS_SETTINGS_NS) return
      refreshFallbacksIfLoaded(controller)
      refreshSwitchesIfLoaded(controller)
    }
    const refreshCatalog = (): void => { refreshCatalogIfLoaded(controller) }
    let pendingReset = false
    // Effect-teardown latch (qc3 S-2): `connection/reset` can land in the
    // same tick the plugin unloads (HMR / fiber dispose); the cleanup below
    // then disposes every subscription and the controller, but the queued
    // microtask would still run and start discarded RPCs (the generation
    // guard only drops their responses, it does not stop the calls).
    // `disposed` is set synchronously in the cleanup, so the queued refresh
    // becomes a no-op.
    let disposed = false
    const refreshAll = (): void => {
      if (pendingReset) return
      pendingReset = true
      queueMicrotask(() => {
        pendingReset = false
        if (disposed) return
        refresh()
        refreshCatalog()
      })
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refreshCatalog),
      ctx.on('connection/reset', refreshAll),
      ...(sessions === undefined ? [] : [sessions.list.subscribe(syncSession)]),
    ]
    return () => {
      disposed = true
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
  // the advisor card; the old Settings-nav section registration (the
  // "Fallbacks" nav entry) is removed — deleting the section registration
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

  // The General settings page status row (plan fallbacks-aux-seams T1): a
  // compact read-only row (enabled badge + recent-switch summary) in the
  // `settings.general.item` list slot — the same registration shape as the
  // upstream preference rows (locale language 0 / ui-theme appearance 10 /
  // ui-conversation composer-enter 20 / ui-agent-preset agent-preset -25).
  // id `fallbacks`, order 100: the informational row renders at the column
  // end, after every preference row (ascending stable sort, ui-slots). The
  // row consumes the SAME controller + useSnapshot as the card — the first
  // mount lazy-loads (idle guards inside the row) and the pushed
  // invalidations above keep it fresh once read; no new data path.
  ctx.slots.inject('settings.general.item', function* () {
    yield ctx.slots.register({
      name: 'settings.general.item',
      id: 'fallbacks',
      order: 100,
      locale: NS,
      inject: () => ({ controller, useSnapshot }),
    }, GeneralFallbacksRow)
  })

  // Conversation-level switch visibility (plan fallbacks-aux-seams T2,
  // D1+D2 seam): every `fallbacks/switch` event renders as a compact
  // system-style line in the chat transcript at its event seq — the user
  // sees each recovery happen in place. Two registrations, both render-only
  // (no model-context injection — C4 excluded):
  // - D1: the conversationEvents Definition registry accepts the
  //   `fallbacks-switch` node (kind `fallbacks-switch`, target `chat`,
  //   match on the non-surface `fallbacks/switch` event — today the
  //   `unknown-surface` fallback only admits append-surface events, so the
  //   transcript showed nothing);
  // - D2: the `conversation.chat.node` keyed seat dispatches the renderer
  //   by node kind (external registration shape `{ name, key, locale }` —
  //   ui-workflow-run / ui-tool / ui-goal precedent). No inject face: the
  //   node payload arrives through the keyed seat's `node` prop.
  // D1 (cont.): the registry's `register` returns an idempotent disposer
  // (`event-registry.ts:19-27`); wire it into an explicit effect so plugin
  // unload/HMR teardown is symmetric with the other subscriptions (same
  // pattern as the dictionaries effect above). The registry ALSO auto-
  // disposes through its own owner-effect (`definition-registry.ts:43-51`) —
  // the disposer is idempotent, so both teardown paths are safe, no
  // double-dispose.
  ctx.effect(
    () => ctx.conversationEvents.register(fallbackSwitchDefinition),
    'llm-fallbacks: conversation node definition',
  )
  ctx.slots.inject('conversation.chat.node', function* () {
    yield ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'fallbacks-switch',
      locale: NS,
    }, ConversationFallbackSwitch)
  })
}
