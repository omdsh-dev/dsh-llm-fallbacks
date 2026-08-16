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
import { apply } from '../src/index.ts'
import {
  FALLBACKS_TUI_ROOT,
  installTuiClient,
  type TuiCommandCompletionNode,
  type TuiCommandTreeProvider,
} from '../src/tui.ts'
import { FALLBACKS_COMMAND_LOCALES } from '../src/commands.ts'
import { cfg } from './support/harness.ts'
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
 * child never activates. The stub ctx is cast to `Context` — the real
 * `Context` surface is not needed, `installTuiClient` only touches `inject`.
 */
function makeStubContext(service: TuiCommandTreesStub | undefined): {
  ctx: Context
  disposer: (() => void) | undefined
} {
  let disposer: (() => void) | undefined
  const ctx = {
    inject(names: readonly string[], callback: (tctx: unknown) => unknown) {
      if (service === undefined) return
      const returned = callback({ tuiCommandTrees: service })
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

  it('treats config as a leaf and never throws on unknown paths', () => {
    const provider = registeredProvider()

    // Deeper than the config node: leaf — no further children.
    expect(provider.children([FALLBACKS_TUI_ROOT, 'config'])).toEqual([])
    expect(provider.children([FALLBACKS_TUI_ROOT, 'config', 'deep'])).toEqual([])
    // Unknown / malformed paths: [] without throwing.
    expect(provider.children([])).toEqual([])
    expect(provider.children(['other'])).toEqual([])
    expect(provider.children([FALLBACKS_TUI_ROOT, 'unknown'])).toEqual([])
    expect(provider.children(['Fallbacks'])).toEqual([])
  })

  it('serves the same completion through the registry lookup path', () => {
    const registry = new TuiCommandTreesStub()
    const { ctx } = makeStubContext(registry)
    installTuiClient(ctx, { serviceOwned: true })

    expect(registry.children(['fallbacks'])).toHaveLength(1)
    expect(registry.children(['fallbacks', 'config'])).toEqual([])
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
})
