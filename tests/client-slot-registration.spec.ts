/**
 * Regression: the `settings.plugin.item` card must register with BOTH the
 * `key` (rc.7+ keyed-slot hosts) and `id` (pre-rc.7 list-slot hosts whose
 * loader throws "list slot ... requires options.id"). Without the id, the
 * card fails to load on pre-rc.7 dsh hosts and the plugin reports a loader
 * entry failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyClient, inject } from '../src/client/index.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  // `uiConversation` service double (the D1 Definition registry's home since
  // 0.1.2): apply() registers the `fallbacks-switch` node Definition through
  // `ctx.uiConversation.events`.
  ctx.provide('uiConversation', { events: { register: () => () => {}, registerFallback: () => () => {} } })
  // Locale service double: register + bind (bind returns a translate thunk).
  ctx.provide('locale', { register: () => () => {}, bind: () => () => '' })
  // Sessions service double: no current session.
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
  })
  ctx.provide('connection', {
    api: {
      settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
      llm: { providers: vi.fn(), models: vi.fn(), discoverModels: vi.fn() },
      sessions: { history: vi.fn() },
    },
    rpc: { call: vi.fn() },
  })
  // rc.1 dotted-namespace contract: each client Remote namespace is a
  // child-fiber service named `remote.<ns>` (upstream `remoteServiceKey`);
  // provide the dotted services (empty faces — this spec never reads
  // namespaces) so the declared injects resolve like production.
  ctx.provide('remote.llm', {})
  ctx.provide('remote.settings', {})
  ctx.provide('remote.session', {})
  ctx.provide('remote', { $on: () => () => {} })
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

  it('registers the settings.plugin.item card with both key and id', () => {
    const registered: Array<{ name: string; key?: string; id?: string }> = []
    ctx.provide('slots', {
      inject: (_name: string, thunk: () => Iterable<unknown>) => { for (const _dispose of thunk()) { /* run the registration generator */ } },
      register: (options: { name: string; key?: string; id?: string }) => {
        registered.push(options)
        return {}
      },
    })
    applyClient(ctx)
    const card = registered.find((entry) => entry.name === 'settings.plugin.item')
    expect(card).toBeDefined()
    expect(card!.key).toBe('fallbacks')
    expect(card!.id).toBe('fallbacks')
  })
})
