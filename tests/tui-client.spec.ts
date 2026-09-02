/**
 * TUI client surface tests (plan fallbacks-tui-client Task 1, AC-1): the
 * `tuiCommandTrees` `/fallbacks` provider — registration shape, completion
 * children, absent-service no-op, and the `serviceOwned` first-fiber gate.
 *
 * The stub registry mirrors dsh-TUI's `TuiCommandTreeRuntime` (read-only
 * reference @ 557a27a, `src/dsh-adapter/command-trees.ts`) — root
 * normalization (trim + lowercase), the root regex, and the duplicate-root
 * throw — so the provider contract is pinned against the same rules the real
 * host enforces. No dsh-tui peer is involved (plan constraint: zero new
 * peer/dependency; shapes replicated structurally in `src/tui.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { apply } from '../src/index.ts'
import {
  FALLBACKS_TUI_ROOT,
  installTuiClient,
  type TuiCommandCompletionNode,
  type TuiCommandTreeProvider,
} from '../src/tui.ts'
import { FALLBACKS_COMMAND_LOCALES } from '../src/commands.ts'
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
import { cfg, makeAgent } from './support/harness.ts'
import { MemorySettings } from './support/memory-settings.ts'

/**
 * Faithful test double of dsh-TUI's `TuiCommandTreeRuntime`: records
 * providers and mirrors the host's root normalization, root regex, and
 * duplicate-root throw (`command-trees.ts:31-57`). `children` delegates to
 * the registered provider and swallows provider throws (completion is
 * optional UI metadata — never blocks execution).
 */
class TuiCommandTreesStub {
  readonly providers = new Map<string, TuiCommandTreeProvider>()
  /** Registration order of provider roots (normalized, as the host stores them). */
  readonly roots: string[] = []
  /** The disposer returned by the most recent `register` call. */
  lastDisposer: (() => void) | undefined

  register(provider: TuiCommandTreeProvider): () => void {
    const root = provider.root.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(root)) throw new TypeError(`invalid TUI command-tree root: ${provider.root}`)
    if (this.providers.has(root)) throw new Error(`TUI command-tree root "${root}" is already registered`)
    const normalized = { ...provider, root }
    this.providers.set(root, normalized)
    this.roots.push(root)
    this.lastDisposer = () => {
      if (this.providers.get(root) === normalized) this.providers.delete(root)
    }
    return this.lastDisposer
  }

  children(canonicalPath: readonly string[]): readonly TuiCommandCompletionNode[] {
    const root = canonicalPath[0]?.toLowerCase()
    if (root === undefined) return []
    const provider = this.providers.get(root)
    if (provider === undefined) return []
    try {
      return provider.children(canonicalPath)
    } catch {
      return []
    }
  }
}

/**
 * A stub Context whose `inject` mirrors cordis' child-activation contract:
 * with a service present the child activates immediately (receiving the
 * service bag), and its returned disposer is captured; with no service the
 * child never activates. The child bag carries the service + a logger
 * surface (the minimal slice of a real child context the dedupe guard logs
 * through). The stub ctx is cast to `Context` — the real `Context` surface
 * is not needed, `installTuiClient` only touches `inject`.
 */
function makeStubContext(service: TuiCommandTreesStub | undefined): {
  ctx: Context
  disposer: (() => void) | undefined
  debugLog: ReturnType<typeof vi.fn>
} {
  let disposer: (() => void) | undefined
  const debugLog = vi.fn()
  const ctx = {
    inject(names: readonly string[], callback: (tctx: unknown) => unknown) {
      if (service === undefined) return
      const returned = callback({ tuiCommandTrees: service, logger: () => ({ debug: debugLog }) })
      if (typeof returned === 'function') disposer = returned as () => void
    },
  } as unknown as Context
  return {
    ctx,
    // Read live: `inject` activates synchronously inside `installTuiClient`,
    // after this object is constructed.
    get disposer() {
      return disposer
    },
    debugLog,
  }
}

describe('installTuiClient — registration shape (AC-1)', () => {
  it('registers exactly one /fallbacks provider with zh/en descriptions when serviceOwned', () => {
    const registry = new TuiCommandTreesStub()
    const { ctx } = makeStubContext(registry)

    installTuiClient(ctx, { serviceOwned: true })

    expect(registry.roots).toEqual([FALLBACKS_TUI_ROOT])
    expect(registry.providers.size).toBe(1)
    const provider = registry.providers.get(FALLBACKS_TUI_ROOT)
    expect(provider?.root).toBe(FALLBACKS_TUI_ROOT)
    // Root descriptions reuse the command copy (zh + en), non-empty.
    expect(provider?.descriptions?.zh).toBe(FALLBACKS_COMMAND_LOCALES.zh.description)
    expect(provider?.descriptions?.en).toBe(FALLBACKS_COMMAND_LOCALES.en.description)
    expect(provider?.descriptions?.zh?.length).toBeGreaterThan(0)
    expect(provider?.descriptions?.en?.length).toBeGreaterThan(0)
  })

  it('returns the registry disposer from the inject child (withdrawal on unload)', () => {
    const registry = new TuiCommandTreesStub()
    const stub = makeStubContext(registry)

    installTuiClient(stub.ctx, { serviceOwned: true })

    // The child's returned disposer is the stub's own — cordis runs it on
    // child unload, withdrawing the registration.
    const disposer = stub.disposer
    expect(typeof disposer).toBe('function')
    expect(disposer).toBe(registry.lastDisposer)
    disposer()
    expect(registry.providers.size).toBe(0)
  })

  it('skips registration entirely when the fiber does not own the service', () => {
    const registry = new TuiCommandTreesStub()
    const { ctx } = makeStubContext(registry)

    installTuiClient(ctx, { serviceOwned: false })

    expect(registry.roots).toHaveLength(0)
    expect(registry.providers.size).toBe(0)
  })

  it('no-ops without error when no tuiCommandTrees service is composed', () => {
    const registry = new TuiCommandTreesStub()
    const { ctx } = makeStubContext(undefined)

    expect(() => installTuiClient(ctx, { serviceOwned: true })).not.toThrow()
    expect(registry.roots).toHaveLength(0)
    expect(registry.providers.size).toBe(0)
  })

  it('degrades to a no-op disposer when another provider already owns the root (M-1 dedupe guard)', () => {
    const registry = new TuiCommandTreesStub()
    // Cross-plugin conflict: a sibling provider claimed the root first — the
    // host duplicate-root throw inside the inject child.
    registry.register({ root: FALLBACKS_TUI_ROOT, children: () => [] })
    const stub = makeStubContext(registry)

    expect(() => installTuiClient(stub.ctx, { serviceOwned: true })).not.toThrow()
    // The dedupe catch logged the degradation at debug level...
    expect(stub.debugLog).toHaveBeenCalledWith(
      'llm-fallbacks: tui command tree already registered — no provider on this fiber',
    )
    // ...and returned a no-op disposer (nothing was registered to withdraw).
    expect(typeof stub.disposer).toBe('function')
    expect(stub.disposer).not.toBe(registry.lastDisposer)
    stub.disposer!()
    expect(registry.providers.size).toBe(1)
    expect(registry.roots).toEqual([FALLBACKS_TUI_ROOT])
  })

  it('rethrows non-duplicate registration errors (only "already registered" degrades)', () => {
    const ctx = {
      inject(_names: readonly string[], callback: (tctx: unknown) => unknown) {
        callback({
          tuiCommandTrees: {
            register: () => {
              throw new TypeError('invalid root')
            },
          },
          logger: () => ({ debug: vi.fn() }),
        })
      },
    } as unknown as Context

    expect(() => installTuiClient(ctx, { serviceOwned: true })).toThrow(/invalid root/)
  })
})

describe('provider completion children — config node (AC-1)', () => {
  function registeredProvider(): TuiCommandTreeProvider {
    const registry = new TuiCommandTreesStub()
    const { ctx } = makeStubContext(registry)
    installTuiClient(ctx, { serviceOwned: true })
    const provider = registry.providers.get(FALLBACKS_TUI_ROOT)
    expect(provider).toBeDefined()
    return provider!
  }

  it("children(['fallbacks']) returns exactly the config node with zh/en copy", () => {
    const provider = registeredProvider()

    const children = provider.children([FALLBACKS_TUI_ROOT])
    expect(children).toHaveLength(1)
    const config = children[0]!
    expect(config.name).toBe('config')
    expect(config.description).toBe(FALLBACKS_COMMAND_LOCALES.zh.usageConfig)
    expect(config.descriptions?.zh).toBe(FALLBACKS_COMMAND_LOCALES.zh.usageConfig)
    expect(config.descriptions?.en).toBe(FALLBACKS_COMMAND_LOCALES.en.usageConfig)
  })

  it('serves the revert-seed leaf under config (depth 2) and never throws on unknown paths', () => {
    const provider = registeredProvider()

    // config (depth 1) → the revert-seed leaf (depth 2); deeper stays a leaf.
    const children = provider.children([FALLBACKS_TUI_ROOT, 'config'])
    expect(children).toHaveLength(1)
    const revertSeed = children[0]!
    expect(revertSeed.name).toBe('revert-seed')
    expect(revertSeed.description).toBe(FALLBACKS_COMMAND_LOCALES.zh.usageRevertSeed)
    expect(revertSeed.descriptions?.zh).toBe(FALLBACKS_COMMAND_LOCALES.zh.usageRevertSeed)
    expect(revertSeed.descriptions?.en).toBe(FALLBACKS_COMMAND_LOCALES.en.usageRevertSeed)
    expect(provider.children([FALLBACKS_TUI_ROOT, 'config', 'deep'])).toEqual([])
    // Unknown / malformed paths: [] without throwing.
    expect(provider.children([])).toEqual([])
    expect(provider.children(['other'])).toEqual([])
    expect(provider.children([FALLBACKS_TUI_ROOT, 'unknown'])).toEqual([])
    expect(provider.children(['Fallbacks'])).toEqual([])
  })

  it('returns a fresh children array per call — never the shared constant by reference (qc3 N-3)', () => {
    const provider = registeredProvider()

    const first = provider.children([FALLBACKS_TUI_ROOT])
    const second = provider.children([FALLBACKS_TUI_ROOT])
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    // Mutating a caller's copy must not corrupt the next caller's view.
    ;(first as TuiCommandCompletionNode[]).push({ name: 'tampered', description: 'x' })
    expect(provider.children([FALLBACKS_TUI_ROOT])).toHaveLength(1)
  })

  it('serves the same completion through the registry lookup path', () => {
    const registry = new TuiCommandTreesStub()
    const { ctx } = makeStubContext(registry)
    installTuiClient(ctx, { serviceOwned: true })

    expect(registry.children(['fallbacks'])).toHaveLength(1)
    expect(registry.children(['fallbacks', 'config'])).toHaveLength(1)
    expect(registry.children(['fallbacks', 'config'])[0]!.name).toBe('revert-seed')
    expect(registry.children([])).toEqual([])
    expect(registry.children(['other'])).toEqual([])
  })
})

describe('apply() wiring — conditional tuiCommandTrees child', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers the /fallbacks provider once a tuiCommandTrees service is composed', async () => {
    const registry = new TuiCommandTreesStub()
    ctx.provide('tuiCommandTrees', registry as never)
    apply(ctx, cfg())
    await vi.waitFor(() => expect(registry.providers.size).toBe(1))
    expect(registry.roots).toEqual(['fallbacks'])
    expect(registry.providers.get('fallbacks')?.root).toBe('fallbacks')
  })

  it('stays a silent no-op when no tuiCommandTrees service exists (top-level inject unchanged)', async () => {
    const registry = new TuiCommandTreesStub()
    expect(() => apply(ctx, cfg())).not.toThrow()
    expect(registry.providers.size).toBe(0)
    // A registry composed later activates the child exactly once — never
    // eagerly at apply time, never twice.
    ctx.provide('tuiCommandTrees', registry as never)
    await vi.waitFor(() => expect(registry.providers.size).toBe(1))
    expect(registry.roots).toEqual(['fallbacks'])
  })

  it('serviceOwned: false — a deduped fiber registers no provider through the apply path (M-2b)', async () => {
    const registry = new TuiCommandTreesStub()
    // The `llm-fallbacks` service is already owned on the shared context
    // root: apply()'s provide hits cordis' duplicate-key failure, the catch
    // sets serviceOwned = false, and installTuiClient must NOT register —
    // even though the tuiCommandTrees service is composed (a second
    // registration would be the host duplicate-root throw).
    ctx.provide('llm-fallbacks', { name: 'llm-fallbacks' } as never)
    ctx.provide('tuiCommandTrees', registry as never)

    expect(() => apply(ctx, cfg())).not.toThrow()
    // Give any (incorrectly) scheduled activation a beat before asserting.
    await vi.waitFor(() => expect(registry.providers.size).toBe(0))
    expect(registry.roots).toHaveLength(0)
  })

  it('/fallbacks config reflects a live settings change (getConfig reads the composed source per call) (M-2a)', async () => {
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (def: CommandDefinition) => {
        registered.push(def)
        return () => {}
      },
    } as never)
    apply(ctx, cfg({ enabled: true, triggerCodes: ['AUTH'] }))
    await vi.waitFor(() => expect(registered).toHaveLength(1))

    const { agent } = makeAgent('cmd-live', { provider: 'mock', model: 'gpt-4o' })
    const invoke = (rawInput: string): string => {
      const result = registered[0]!.handler({
        commandId: 'x',
        agent,
        rawInput,
        signal: new AbortController().signal,
      } as unknown as CommandInvocation)
      return result.kind === 'success' ? (result.text ?? '') : ''
    }

    // At-apply composed values.
    expect(invoke(' config').split('\n')[0]).toBe('Fallbacks 配置: 已启用')
    expect(invoke(' config')).toContain('触发码: AUTH')

    // A live settings update mutates the user layer; the next readback must
    // reflect it — getConfig() shares the exact per-call source() accessor
    // the runtime reads (no cached readback).
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { triggerCodes: ['QUOTA'] })
    await vi.waitFor(() => expect(invoke(' config')).toContain('触发码: QUOTA'))
    expect(invoke(' config')).not.toContain('触发码: AUTH')
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { enabled: false })
    await vi.waitFor(() => expect(invoke(' config').split('\n')[0]).toBe('Fallbacks 配置: 未启用'))

    // Read-only: the readbacks never grow the session log.
    expect(agent.session.snapshotEvents()).toHaveLength(0)
  })

  it('registers the tuiCommandTrees child BEFORE the tail settings preset child (S-2 activation-order invariant)', () => {
    // The tail ctx.inject(['settings']) preset child must stay the LAST
    // registered child so its fire sees the composed live source and write
    // channel; a future reorder of installTuiClient after it would silently
    // break that guarantee. Pin the inject registration order via a
    // recording wrapper.
    const injectKeys: string[] = []
    const recorder = new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'inject') {
          return (deps: readonly string[], callback: unknown) => {
            injectKeys.push(deps.join(','))
            return Reflect.get(target, prop).call(target, deps, callback)
          }
        }
        return Reflect.get(target, prop)
      },
    })

    apply(recorder, cfg())

    const tuiIndex = injectKeys.indexOf('tuiCommandTrees')
    const lastSettings = injectKeys.lastIndexOf('settings')
    expect(tuiIndex).toBeGreaterThanOrEqual(0)
    // The preset child is the last-registered child overall...
    expect(lastSettings).toBe(injectKeys.length - 1)
    // ...and the TUI child precedes it.
    expect(tuiIndex).toBeLessThan(lastSettings)
  })
})
