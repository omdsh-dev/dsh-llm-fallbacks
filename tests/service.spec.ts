/**
 * Named cordis service lifecycle tests (plan fallbacks-consumer-api Task 2;
 * ordering updated by plan seeds-declare-window Task 2, issue #105).
 *
 * Pins the responsive capability probe contract for consumers like
 * mstar-harness:
 * - the service is ABSENT synchronously after apply() and becomes visible only
 *   once the settings inject child settles — the provide lives inside that
 *   child (bind writeRoles FIRST, then provide, in the same callback body), so
 *   "the service probes non-undefined" implies "declareSeeds can write": a
 *   declare-on-probe consumer can no longer hit the settings-unavailable
 *   window (issue #105),
 * - the service methods are the SAME function references as the package-root
 *   re-exports (single point of truth — no copied logic),
 * - `version` matches the package.json manifest,
 * - the surface is the six-key pure function face + `name`/`version` metadata
 *   plus the three additive role-seed methods (exactly nine keys — no
 *   stateStore / event / filter helpers),
 * - dispose unregisters it: `ctx.get('llm-fallbacks')` is `undefined`
 *   afterwards (cordis 4.0.1 strict `get` on a missing impl — never throws;
 *   the provide disposer runs on the settings child's unload),
 * - without a settings service the service NEVER appears (D1) — the seed
 *   surface is unreachable rather than loud (the manager-level loud throw for
 *   an unbound channel stays pinned in tests/seeds.spec.ts),
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
  type FallbacksService,
} from '../src/index.ts'
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { settle } from './support/settle.ts'

let ctx: Context

beforeEach(() => {
  ctx = new Context()
  ctx.plugin(MemorySettings)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

const { version: packageVersion } = createRequire(import.meta.url)('../package.json')

/**
 * Apply and wait until the service is VISIBLE. Since seeds-declare-window the
 * provide lives inside the settings inject child: it is absent synchronously
 * after apply() and appears once that child settles (one macrotask). Waiting
 * for visibility is the precondition for every service probe — and visibility
 * implies the write channel is bound, so seed calls below need no retry.
 */
async function appliedService(config: FallbacksConfig = defaultFallbacksConfig): Promise<FallbacksService> {
  apply(ctx, config)
  await vi.waitFor(() => {
    expect(ctx.get('llm-fallbacks')).toBeDefined()
  })
  return ctx.get('llm-fallbacks')!
}

describe('llm-fallbacks named cordis service', () => {
  it('declares the static provide metadata (loader/tooling-visible)', () => {
    expect(provide).toEqual(['llm-fallbacks'])
  })

  it('is absent synchronously after apply and appears once the settings inject child settles', async () => {
    // Pre-apply lifecycle (F-003): before apply(), the strict get on the
    // missing impl is `undefined` — the service exists only while applied.
    expect(ctx.get('llm-fallbacks')).toBeUndefined()

    apply(ctx)

    // Deferred-child-settlement ordering (seeds-declare-window, issue #105):
    // the provide lives INSIDE the settings inject child, whose fiber stays
    // LOADING until bind+provide completed — the strict get is still
    // `undefined` right after apply() returns...
    expect(ctx.get('llm-fallbacks')).toBeUndefined()

    // ...and the service becomes visible only after that child settles.
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })
    const fb = ctx.get('llm-fallbacks')!
    expect(fb.name).toBe('llm-fallbacks')
    expect(fb.name).toBe(provide[0])
    expect(fb.version).toBe(packageVersion)
  })

  it('exposes exactly the pure function surface + name/version metadata + the three additive seed methods (no state fields)', async () => {
    const fb = await appliedService()
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

  it('references the SAME functions as the package-root re-exports (single point of truth)', async () => {
    const fb = await appliedService()
    expect(fb.resolveRole).toBe(resolveRole)
    expect(fb.resolveChain).toBe(resolveChain)
    expect(fb.validateFallbacksConfig).toBe(validateFallbacksConfig)
    expect(fb.detectLegacyKeys).toBe(detectLegacyKeys)
  })

  it('service functions are directly callable', async () => {
    const fb = await appliedService()
    // resolveRole — rule hit from a subagent + provider match (same minimal
    // fixture as tests/export-surface.spec.ts; PR #62 feedback: rules are
    // subagent-only, so a root agent would resolve to 'inherit').
    const agent: Parameters<typeof resolveRole>[0] = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
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
      // Conforming all-day head (P6): rootChain must start with one official
      // V4 model — a legacy non-official-head chain would now earn a warn.
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
    await appliedService()
    expect(ctx.get('llm-fallbacks')).toBeDefined()

    await ctx.fiber.dispose()

    // cordis 4.0.1: the provide disposer runs when the settings child's fiber
    // unloads (the child owns the service — seeds-declare-window) and deletes
    // the store entry; strict `get` on the missing impl returns `undefined`
    // (no throw).
    expect(ctx.get('llm-fallbacks')).toBeUndefined()
  })

  it('a second apply over the same context root does not throw; the first apply owns the service (multi-fiber dedupe)', async () => {
    const first = await appliedService()

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
    //
    // This is ALSO the issue #105 scenario, now green: a consumer waits for
    // the service to probe non-undefined and declares IMMEDIATELY — the
    // first attempt resolves `applied` (visible ⟹ the write channel is bound
    // by the same child callback that provided the service; no
    // settings-unavailable throw, no retry).
    const fb = await appliedService({ ...defaultFallbacksConfig, presets: 'none' })
    await expect(fb.declareSeeds([{ id: 'architect', persona: 'architects the fallback flow' }])).resolves.toEqual({
      applied: ['architect'],
      skipped: [],
      conflicts: [],
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
    // And the materialized row landed in the settings user layer (the write
    // channel the same child bound), not just in the manager registry.
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({
      roles: { list: [{ id: 'architect', persona: 'architects the fallback flow' }], rules: [] },
    })
  })

  it('revertSeededPersona restores the CURRENT declared seed default over an operator edit', async () => {
    // Pin to `presets: 'none'` (fallbacks-preset-roles QC fix wave, qc1 S-6):
    // the bundled preset self-declaration would otherwise materialize 7
    // preset rows and shadow the intended isolation — this test exercises
    // the service revert surface, not presets.
    const fb = await appliedService({ ...defaultFallbacksConfig, presets: 'none' })
    // Visible ⟹ writable (issue #105): the declare resolves on the first
    // attempt — no transient settings-unavailable throw to retry.
    await expect(fb.declareSeeds([{ id: 'architect', persona: 'seed default' }])).resolves.toEqual({
      applied: ['architect'],
      skipped: [],
      conflicts: [],
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
    const fb = await appliedService()
    expect(await fb.revertSeededPersona('nobody')).toEqual({ reverted: false, reason: 'not-seeded' })
  })

  it('a later apply shares the first apply\'s seed registry (multi-fiber dedupe)', async () => {
    // Same `presets: 'none'` pin as the declare-materialize test: this test
    // asserts the exact registry shape after a companion declare, which the
    // bundled preset self-declaration (T3) would otherwise widen.
    const first = await appliedService({ ...defaultFallbacksConfig, presets: 'none' })
    // Visible ⟹ writable (issue #105): first-attempt declare.
    await expect(first.declareSeeds([{ id: 'architect', persona: 'first default' }])).resolves.toEqual({
      applied: ['architect'],
      skipped: [],
      conflicts: [],
    })

    expect(() => apply(ctx)).not.toThrow()

    // The FIRST apply's service object and seed registry stay registered —
    // the second apply neither clobbers the identity nor resets the registry.
    expect(ctx.get('llm-fallbacks')).toBe(first)
    expect(first.getEffectiveRoles().roles).toEqual([
      expect.objectContaining({ id: 'architect', seeded: true, seedPersona: 'first default' }),
    ])
  })

  it('without a settings service the service never appears — the seed surface is unreachable, not loud (D1, ex-KD-G5)', async () => {
    // D1 (seeds-declare-window clarify): the provide lives INSIDE the
    // settings inject child, so a fiber without a settings service never
    // provides the service at all. Before the restructure the service was
    // visible here with a THROWING write channel (the KD-G5 window issue #105
    // consumers fell into); now consumers cannot obtain a service whose
    // write channel is unbound — visible ⟹ writable, both directions at rest.
    // The manager-level loud throw + retry-safety for an unbound channel stay
    // pinned in tests/seeds.spec.ts.
    const bareCtx = new Context()
    try {
      apply(bareCtx, {
        ...defaultFallbacksConfig,
        roles: {
          list: [{ id: 'architect', persona: 'operator edit' }],
          rules: [],
        },
      })

      // Absent synchronously AND after the settings child's settlement
      // window — the child never activates (negative-assertion window).
      expect(bareCtx.get('llm-fallbacks')).toBeUndefined()
      await settle()
      expect(bareCtx.get('llm-fallbacks')).toBeUndefined()
    } finally {
      await bareCtx.fiber.dispose()
    }
  })
})
