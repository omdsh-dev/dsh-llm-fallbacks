/**
 * Named cordis service lifecycle tests (plan fallbacks-consumer-api Task 2).
 *
 * Pins the responsive capability probe contract for consumers like
 * mstar-harness:
 * - `ctx.get('llm-fallbacks')` is available while the plugin is applied,
 * - the service methods are the SAME function references as the package-root
 *   re-exports (single point of truth — no copied logic),
 * - `version` matches the package.json manifest,
 * - the surface is a pure function face + `name`/`version` metadata only
 *   (exactly six keys — no stateStore / event / filter helpers),
 * - dispose unregisters it: `ctx.get('llm-fallbacks')` is `undefined`
 *   afterwards (cordis 4.0.1 strict `get` on a missing impl — never throws).
 *
 * ctx construction follows `tests/plugin.spec.ts` / `tests/host-native.spec.ts`:
 * `new Context()` + `ctx.plugin(MemorySettings)` + direct `apply(ctx)` +
 * afterEach `await ctx.fiber.dispose()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  defaultFallbacksConfig,
  detectLegacyKeys,
  provide,
  resolveChain,
  resolveRole,
  validateFallbacksConfig,
  type FallbacksConfig,
} from '../src/index.ts'
import { MemorySettings } from './support/memory-settings.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

const { version: packageVersion } = createRequire(import.meta.url)('../package.json')

describe('llm-fallbacks named cordis service', () => {
  it('declares the static provide metadata (loader/tooling-visible)', () => {
    expect(provide).toEqual(['llm-fallbacks'])
  })

  it('is available through ctx.get while the plugin is applied', () => {
    // Pre-apply lifecycle (F-003): before apply(), the strict get on the
    // missing impl is `undefined` — the service exists only while applied.
    expect(ctx.get('llm-fallbacks')).toBeUndefined()

    apply(ctx)

    const service = ctx.get('llm-fallbacks')
    expect(service).toBeDefined()
    const fb = service!
    expect(fb.name).toBe('llm-fallbacks')
    expect(fb.name).toBe(provide[0])
    expect(fb.version).toBe(packageVersion)
  })

  it('exposes exactly the pure function surface + name/version metadata (no runtime state)', () => {
    apply(ctx)

    const fb = ctx.get('llm-fallbacks')!
    // The six-key shape pins both the full surface AND the absence of any
    // state-bearing field (stateStore / event emitters / filter helpers).
    expect(Object.keys(fb)).toEqual([
      'name',
      'version',
      'resolveRole',
      'resolveChain',
      'validateFallbacksConfig',
      'detectLegacyKeys',
    ])
  })

  it('references the SAME functions as the package-root re-exports (single point of truth)', () => {
    apply(ctx)

    const fb = ctx.get('llm-fallbacks')!
    expect(fb.resolveRole).toBe(resolveRole)
    expect(fb.resolveChain).toBe(resolveChain)
    expect(fb.validateFallbacksConfig).toBe(validateFallbacksConfig)
    expect(fb.detectLegacyKeys).toBe(detectLegacyKeys)
  })

  it('service functions are directly callable', () => {
    apply(ctx)

    const fb = ctx.get('llm-fallbacks')!
    // resolveRole — rule hit from origin root + provider match (same minimal
    // fixture as tests/export-surface.spec.ts).
    const agent: Parameters<typeof resolveRole>[0] = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'root' } },
    }
    expect(fb.resolveRole(agent, [{ provider: 'openai', role: 'coder' }], new Map([['coder', 'coder']]))).toBe('coder')
    // resolveChain — the rootChain candidate survives the default filter
    // when the current model differs.
    expect(
      fb.resolveChain([], ['openai/gpt-4o'], 'inherit', 'mock', 'gpt-4o').map((candidate) => candidate.raw),
    ).toEqual(['openai/gpt-4o'])
    // validateFallbacksConfig — a valid config warns nothing.
    const warn = vi.fn()
    // Spread the defaults so the fixture satisfies the full FallbacksConfig
    // shape (same pattern as tests/export-surface.spec.ts) — surfaced by the
    // dev-time tsc validation (F-001), pre-existing latent type error.
    const validConfig: FallbacksConfig = {
      ...defaultFallbacksConfig,
      enabled: true,
      rootChain: ['openai/gpt-4o'],
      roles: {
        list: [{ id: 'coder', label: 'Coder', description: '', chain: ['anthropic/claude-3-5-sonnet'] }],
        rules: [{ origin: 'root', role: 'coder' }],
      },
    }
    fb.validateFallbacksConfig(validConfig, { warn })
    expect(warn).not.toHaveBeenCalled()
    // detectLegacyKeys — the removed `chains` key is flagged.
    expect(fb.detectLegacyKeys({ chains: [] })).toContain('chains')
  })

  it('unregisters on dispose: ctx.get returns undefined afterwards', async () => {
    apply(ctx)
    expect(ctx.get('llm-fallbacks')).toBeDefined()

    await ctx.fiber.dispose()

    // cordis 4.0.1: the provide disposer runs on fiber unload and deletes the
    // store entry; strict `get` on the missing impl returns `undefined` (no throw).
    expect(ctx.get('llm-fallbacks')).toBeUndefined()
  })

  it('a second apply over the same context root does not throw; the first apply owns the service (multi-fiber dedupe)', () => {
    apply(ctx)
    const first = ctx.get('llm-fallbacks')!

    // A later fiber applying over a shared context root hits cordis' loud
    // duplicate-key failure on `provide` (`service "llm-fallbacks" has been
    // registered at <…>`). The guard (W-1) must let it degrade gracefully
    // instead of aborting apply() before the dedupe-guarded gateway/typert
    // registrations below — later fibers get NO service on their fiber.
    expect(() => apply(ctx)).not.toThrow()

    // The FIRST apply's service object stays registered: same identity and
    // same function references (no clobber by the second apply).
    expect(ctx.get('llm-fallbacks')).toBe(first)
    expect(first.resolveRole).toBe(resolveRole)
  })
})
