/**
 * Regression: the `plugins.bundle.config` card must register with the package-name
 * `key` (rc.7+ keyed-slot hosts) and `id` (pre-rc.7 list-slot hosts whose
 * loader throws "list slot ... requires options.id"). Without the id, the
 * card fails to load on pre-rc.7 dsh hosts and the plugin reports a loader
 * entry failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyClient, inject } from '../src/client/index.ts'
import type { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'

/**
 * One recorded slot registration. The card's inject face is the only handle on
 * the store `apply()` constructs, so it is how the warm-up is observed.
 */
interface Registered {
  name: string
  key?: string
  id?: string
  inject?: () => { controller: FallbacksSettingsController }
}

let ctx: Context

/** Remote-namespace spies: the client-start store warm-up must call each once. */
let spies: {
  describe: ReturnType<typeof vi.fn>
  listConfigurableProviders: ReturnType<typeof vi.fn>
  modelCatalog: ReturnType<typeof vi.fn>
  rpcCall: ReturnType<typeof vi.fn>
}

/** The slots double every `applyClient` test needs (the registrations run at apply). */
function provideSlots(registered: Registered[] = []): void {
  ctx.provide('slots', {
    inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
    register: (options: Registered) => {
      registered.push(options)
      return {}
    },
  })
}

beforeEach(() => {
  ctx = new Context()
  // `uiConversation` service double (the D1 Definition registry's home since
  // 0.1.2): apply() registers the `fallbacks-switch` node Definition through
  // `ctx.uiConversation.events`.
  ctx.provide('uiConversation', { events: { register: () => () => {}, registerFallback: () => () => {} } })
  // Locale service double: register + bind (bind returns a translate thunk).
  ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
  // Sessions service double: empty `SessionListState` (0.1.7-rc.1 shape — no
  // `current` field; the viewed session is the `mainView`-retained row).
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
      subscribe: () => () => {},
    },
  })
  spies = {
    describe: vi.fn(async () => ({ ok: true as const, value: { writable: false, namespaces: [] } })),
    listConfigurableProviders: vi.fn(async () => ({ ok: true as const, value: [] })),
    modelCatalog: vi.fn(async () => ({ ok: true as const, value: { groups: [], failures: [] } })),
    rpcCall: vi.fn(async () => ({ ok: true as const, value: { config: undefined } })),
  }
  ctx.provide('connection', {
    api: {
      settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
      llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
      sessions: { history: vi.fn() },
    },
    rpc: { call: spies.rpcCall },
  })
  // rc.1 dotted-namespace contract: each client Remote namespace is a
  // child-fiber service named `remote.<ns>` (upstream `remoteServiceKey`);
  // provide the dotted services (empty faces — this spec never reads
  // namespaces) so the declared injects resolve like production.
  ctx.provide('remote.llm', { listConfigurableProviders: spies.listConfigurableProviders })
  ctx.provide('remote.settings', { describe: spies.describe })
  ctx.provide('remote.session', { modelCatalog: spies.modelCatalog })
  // The assembly face forwards namespace reads to the dotted child services,
  // mirroring the traceable proxy (`ctx.remote.settings` → `ctx['remote.settings']`).
  ctx.provide('remote', {
    $on: () => () => {},
    get settings() { return ctx.get('remote.settings') as unknown },
    get llm() { return ctx.get('remote.llm') as unknown },
    get session() { return ctx.get('remote.session') as unknown },
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('client slot registration', () => {
  it('declares the dotted remote namespace injects (rc.1 contract)', () => {
    // Regression pin (upstream apply.client.spec.ts asserts the array
    // literally): each client Remote namespace is a child-fiber service
    // named `remote.<ns>`; without the dotted names the fiber walk throws
    // `cannot get property "remote.llm" without inject` at card load.
    expect(inject).toEqual([
      'slots', 'locale', 'connection', 'remote', 'uiConversation',
      'remote.llm', 'remote.settings', 'remote.session',
    ])
  })

  it('registers the plugins.bundle.config card with package-name key', () => {
    const registered: Registered[] = []
    provideSlots(registered)
    applyClient(ctx)
    const card = registered.find((entry) => entry.name === 'plugins.bundle.config')
    expect(card).toBeDefined()
    expect(card!.key).toBe('dsh-llm-fallbacks')
    expect(card!.id).toBeUndefined()
  })

  it('warms the shared settings store once at client start (badge repaint trigger)', async () => {
    // The settings card's mount used to be the only load trigger, so the
    // session-header badge stayed cold for any session that never opened the
    // plugin page. apply() now loads config + catalog once; the `refresh*IfLoaded`
    // invalidations keep it fresh without a retry loop.
    const registered: Registered[] = []
    provideSlots(registered)
    applyClient(ctx)

    // Once per read, at apply: a retry loop would double these.
    expect(spies.describe).toHaveBeenCalledTimes(1)
    expect(spies.modelCatalog).toHaveBeenCalledTimes(1)

    // The product face of the warm-up: the badge's store is ready without any
    // card ever mounting (a macrotask drains the two in-flight reads).
    const { controller } = registered.find(entry => entry.name === 'plugins.bundle.config')!.inject!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().catalogStatus).toBe('ready')
  })
})
