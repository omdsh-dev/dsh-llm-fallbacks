/**
 * Named cordis service lifecycle tests (plan fallbacks-consumer-api Task 2).
 *
 * Pins the responsive capability probe contract for consumers like
 * mstar-harness:
 * - `ctx.get('llm-fallbacks')` is available while the plugin is applied,
 * - the service methods are the SAME function references as the package-root
 *   re-exports (single point of truth — no copied logic),
 * - `version` matches the package.json manifest,
 * - the surface is the six-key pure function face + `name`/`version` metadata
 *   plus the three additive role-seed methods (exactly nine keys — no
 *   stateStore / event / filter helpers),
 * - dispose unregisters it: `ctx.get('llm-fallbacks')` is `undefined`
 *   afterwards (cordis 4.0.1 strict `get` on a missing impl — never throws).
 * - the seed methods delegate to the per-apply `FallbacksSeedManager`
 *   (single point of truth), and a later apply over the same context root
 *   shares the first apply's service + seed registry (W-1).
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
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
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

  it('exposes exactly the pure function surface + name/version metadata + the three additive seed methods (no state fields)', () => {
    apply(ctx)

    const fb = ctx.get('llm-fallbacks')!
    // The nine-key shape pins both the full surface AND the absence of any
    // state-bearing FIELD (stateStore / event emitters / filter helpers).
    // The seed methods are closures over the per-apply manager — state stays
    // behind the closure, never a property on the service object (spec §9.5).
    expect(Object.keys(fb)).toEqual([
      'name',
      'version',
      'resolveRole',
      'resolveChain',
      'validateFallbacksConfig',
      'detectLegacyKeys',
      'declareSeeds',
      'getEffectiveRoles',
      'revertSeededPersona',
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
      // Conforming all-day (P6): rootChain must be exactly one official V4
      // model — a legacy multi-model chain would now earn a conformance warn.
      rootChain: ['deepseek-official/deepseek-v4-flash'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-3-5-sonnet'] }],
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

  it('declareSeeds materializes rows and getEffectiveRoles reads them back (manager single point of truth)', async () => {
    // Pin to `presets: 'none'` (fallbacks-preset-roles T3): the bundled
    // preset self-declaration would otherwise add 7 preset rows to the
    // registry and break the exact-shape readback assertion below — this
    // test exercises the service seed surface, not presets.
    apply(ctx, { ...defaultFallbacksConfig, presets: 'none' })

    const fb = ctx.get('llm-fallbacks')!
    // The io write channel activates a tick after apply (conditional inject
    // child — gateway pattern); waitFor retries the transient
    // settings-unavailable throw. The manager is retry-safe (a failed write
    // never commits the registry), so the re-declare is an idempotent no-op.
    await vi.waitFor(async () => {
      await expect(fb.declareSeeds([{ id: 'architect', persona: 'architects the fallback flow' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [],
      })
    })

    const readback = fb.getEffectiveRoles()
    expect(readback.roles).toEqual([
      expect.objectContaining({
        id: 'architect',
        persona: 'architects the fallback flow',
        seeded: true,
        personaOverridden: false,
        seedPersona: 'architects the fallback flow',
      }),
    ])
  })

  it('revertSeededPersona restores the CURRENT declared seed default over an operator edit', async () => {
    // Pin to `presets: 'none'` (fallbacks-preset-roles QC fix wave, qc1 S-6):
    // the bundled preset self-declaration would otherwise materialize 7
    // preset rows and shadow the intended isolation — this test exercises
    // the service revert surface, not presets.
    apply(ctx, { ...defaultFallbacksConfig, presets: 'none' })

    const fb = ctx.get('llm-fallbacks')!
    // Same waitFor probe as the declare test above (inject child activation).
    await vi.waitFor(async () => {
      await expect(fb.declareSeeds([{ id: 'architect', persona: 'seed default' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [],
      })
    })

    // Operator edit through the settings user layer (the settings-card
    // channel) — the row persona IS the override; nothing override-shaped is
    // stored separately (spec §9.2).
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit' }], rules: [] },
    })
    expect(fb.getEffectiveRoles().roles[0]).toMatchObject({ personaOverridden: true })

    const outcome = await fb.revertSeededPersona('architect')
    expect(outcome).toEqual({ reverted: true, persona: 'seed default' })
    expect(fb.getEffectiveRoles().roles[0]).toMatchObject({ persona: 'seed default', personaOverridden: false })
  })

  it('revertSeededPersona of a non-seeded id reports not-seeded without writing', async () => {
    apply(ctx)

    const fb = ctx.get('llm-fallbacks')!
    expect(await fb.revertSeededPersona('nobody')).toEqual({ reverted: false, reason: 'not-seeded' })
  })

  it('a later apply shares the first apply\'s seed registry (multi-fiber dedupe)', async () => {
    // Same `presets: 'none'` pin as the declare-materialize test: this test
    // asserts the exact registry shape after a companion declare, which the
    // bundled preset self-declaration (T3) would otherwise widen.
    apply(ctx, { ...defaultFallbacksConfig, presets: 'none' })
    const first = ctx.get('llm-fallbacks')!
    // Same waitFor probe as the declare test above (inject child activation).
    await vi.waitFor(async () => {
      await expect(first.declareSeeds([{ id: 'architect', persona: 'first default' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [],
      })
    })

    expect(() => apply(ctx)).not.toThrow()

    // The FIRST apply's service object and seed registry stay registered —
    // the second apply neither clobbers the identity nor resets the registry.
    expect(ctx.get('llm-fallbacks')).toBe(first)
    expect(first.getEffectiveRoles().roles).toEqual([
      expect.objectContaining({ id: 'architect', seeded: true, seedPersona: 'first default' }),
    ])
  })

  it('declareSeeds and revertSeededPersona throw loudly when the settings inject child never activates (KD-G5)', async () => {
    // A fiber WITHOUT a settings service: the conditional inject child never
    // activates, so the io adapter's writeRoles stays in its loud default
    // failure state. The manager stays retry-safe — a failed write never
    // commits (declare) or mutates (revert) the registry.
    const bareCtx = new Context()
    try {
      apply(bareCtx, {
        ...defaultFallbacksConfig,
        roles: {
          list: [{ id: 'architect', persona: 'operator edit' }],
          rules: [],
        },
      })
      const fb = bareCtx.get('llm-fallbacks')!

      // declareSeeds needs a settings write (delta vs the composed roles) →
      // loud throw, and the registry is NOT committed.
      await expect(fb.declareSeeds([{ id: 'reviewer', persona: 'new role' }]))
        .rejects.toThrow('llm-fallbacks: seeds: settings service is unavailable — seed roles cannot be written')
      const afterFailedDeclare = fb.getEffectiveRoles()
      expect(afterFailedDeclare.roles).toHaveLength(1)
      expect(afterFailedDeclare.roles[0]).toMatchObject({ id: 'architect', seeded: false, personaOverridden: false })

      // Seed the registry via a NO-WRITE declare (the row already matches
      // the composed shape → no delta, AC-1); the conflict proves the
      // operator persona is retained.
      await expect(fb.declareSeeds([{ id: 'architect', persona: 'v1' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [{ id: 'architect', kind: 'persona-source' }],
      })

      // revertSeededPersona needs a write (row persona ≠ seed default) →
      // loud throw, and the registry stays unchanged (row still seeded).
      await expect(fb.revertSeededPersona('architect'))
        .rejects.toThrow('llm-fallbacks: seeds: settings service is unavailable — seed roles cannot be written')
      expect(fb.getEffectiveRoles().roles[0]).toMatchObject({
        id: 'architect',
        persona: 'operator edit',
        seeded: true,
        personaOverridden: true,
        seedPersona: 'v1',
      })
    } finally {
      await bareCtx.fiber.dispose()
    }
  })
})
