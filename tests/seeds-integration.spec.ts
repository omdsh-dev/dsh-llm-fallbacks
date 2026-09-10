/**
 * Role-seeds gateway integration tests (plan fallbacks-role-seeds Task 3):
 * real `Context` + `MemorySettings` + `apply()` (service.spec.ts pattern) —
 * the full declare → materialize → readback → revert loop through BOTH the
 * named service and the settings gateway.
 *
 * Covers:
 * - declare → gateway `get` sees the materialized rows AND the additive
 *   `seeds` badge field (AC-6a/b);
 * - declaring the same payload twice yields exactly one row per id (AC-1);
 * - fiber swap (`ctx.fiber.dispose()` → new fiber re-apply + re-declare)
 *   keeps rows single and preserves an operator override edited during the
 *   swap (AC-1);
 * - skip/conflict warns carry the `llm-fallbacks: seeds:` prefix (AC-2/5);
 * - service-side and gateway-side revert both restore the CURRENT declared
 *   seed default; a companion re-declare of a new persona moves the revert
 *   target (AC-3/6c);
 * - provenance labels (seed-source-provenance Task 3, spec §2): a named
 *   `declareSeeds(seeds, { set })` batch carries the set name as the wire
 *   `source`, rows outside any live batch read back `user` (a/c); a
 *   plain-JS `{ bundled: true }` forge attempt through the SERVICE FACE
 *   degrades to `external` — the reserved label is runtime-unreachable
 *   (qc2 W-001: the face whitelists `{ set }` only);
 * - the designer/librarian trim upgrade (spec §3): a pre-trim persisted
 *   layer survives the 5-id bundled declare untouched — the trimmed rows
 *   read back `user` with zero `llm-fallbacks: seeds:` warns (g/i).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, defaultFallbacksConfig, type FallbacksService } from '../src/index.ts'
import {
  FALLBACKS_SETTINGS_NAMESPACE,
  type FallbacksConfigGateway,
} from '../src/gateway.ts'
import { presetRoles } from '../src/presets.ts'
import type { SeedDeclareOutcome, SeedsDeclareOptions } from '../src/seeds.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { settle } from './support/settle.ts'

/** Track every test context and dispose it after the case (settings/gateway effects hygiene). */
const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) {
    await ctx.fiber.dispose()
  }
  contexts.clear()
})

function track(ctx: Context): Context {
  contexts.add(ctx)
  return ctx
}

/** Compose the real plugin on a fresh context (settings service + apply). */
async function compose(): Promise<Context> {
  const ctx = track(new Context())
  await ctx.plugin(MemorySettings)
  // Pin to `presets: 'none'` (fallbacks-preset-roles QC fix wave F-001): the
  // bundled preset self-declaration would otherwise materialize 5 preset rows
  // on apply and race the exact row-count/badge assertions below (same
  // rationale as the T3 pins elsewhere in this file). This suite exercises
  // companion-declared seeds, not presets.
  apply(ctx, { ...defaultFallbacksConfig, presets: 'none' })
  await vi.waitFor(() => {
    expect(ctx.get('llm-fallbacks')).toBeDefined()
  })
  return ctx
}

function service(ctx: Context): FallbacksService {
  return ctx.get('llm-fallbacks')!
}

function gateway(ctx: Context): FallbacksConfigGateway {
  return ctx.get('fallbacks') as FallbacksConfigGateway
}

/**
 * Declare through the service. The service itself becomes visible only after
 * the settings inject child settles (seeds-declare-window) — and visibility
 * implies the write channel is bound (issue #105), so a declare through a
 * VISIBLE service resolves on the first attempt; the waitFor below is the
 * visibility wait.
 */
async function declare(
  ctx: Context,
  seeds: Array<{ id: string; persona: string }>,
  options?: { set?: string },
): Promise<SeedDeclareOutcome> {
  return vi.waitFor(async () => service(ctx).declareSeeds(seeds, options))
}

/** The raw user-layer roles section of the fallbacks settings namespace. */
function userSection(ctx: Context): { roles: { list: Array<{ id: string; persona: string }>; rules: unknown[] } } | undefined {
  return ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)?.user
}

/** Capture every ctx.logger export (info/warn/...) from this point on (runtime.spec.ts pattern). */
function captureLogs(ctx: Context): Array<{ type: string; args: unknown[] }> {
  const logs: Array<{ type: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
}

describe('seeds → gateway integration (real apply)', () => {
  it('declare materializes rows; gateway get exposes them plus the seeds wire field (AC-6a/b)', async () => {
    const ctx = await compose()
    await declare(ctx, [
      { id: 'architect', persona: 'Architects the fallback flow' },
      { id: 'qa-engineer', persona: 'Guards release quality' },
    ])

    const result = gateway(ctx).get()
    // The WIRE rows are the schema-resolved composition (defaults filled for
    // chain/fallback/permissions); the RAW two-key write shape is pinned on
    // the user layer in the AC-1 test below. The integration facts: exactly
    // the two declared rows exist with the declared personas (R4 — no chain
    // invented for the new rows).
    expect(result.config.roles.list).toHaveLength(2)
    expect(result.config.roles.list[0]).toMatchObject({ id: 'architect', persona: 'Architects the fallback flow' })
    expect(result.config.roles.list[1]).toMatchObject({ id: 'qa-engineer', persona: 'Guards release quality' })
    // The additive badge state reports both ids at their seed default.
    expect(result.seeds).toEqual([
      { id: 'architect', overridden: false, source: 'external' },
      { id: 'qa-engineer', overridden: false, source: 'external' },
    ])
    // The service readback agrees with the gateway wire (single point of truth).
    expect(service(ctx).getEffectiveRoles().roles.map((role) => role.id)).toEqual(['architect', 'qa-engineer'])
  })

  it('declaring the same payload twice yields exactly one row per id (AC-1)', async () => {
    const ctx = await compose()
    await declare(ctx, [{ id: 'architect', persona: 'default' }])
    await declare(ctx, [{ id: 'architect', persona: 'default' }])

    // One row per id — the second declare is an idempotent no-op.
    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'architect', persona: 'default' })
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'architect', overridden: false, source: 'external' }])
    // The user layer holds exactly the one materialized RAW row — the
    // two-key `{ id, persona }` write shape (R4 — chain/fallback/prompt/
    // permissions keys omitted on insert), and no revision churn from the
    // second declare.
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ roles: { list: [{ id: 'architect', persona: 'default' }], rules: [] } })
  })

  it('fiber swap: dispose + re-apply + re-declare keeps rows single and preserves an operator override (AC-1)', async () => {
    const first = track(new Context())
    await first.plugin(MemorySettings)
    // Pin to `presets: 'none'` (fallbacks-preset-roles T3): the bundled
    // preset self-declaration would otherwise materialize 5 preset rows on
    // each apply and break the exact row-count/badge assertions below — this
    // test exercises the fiber-swap seed semantics, not presets.
    apply(first, { ...defaultFallbacksConfig, presets: 'none' })
    // The service appears only after the settings inject child settles
    // (seeds-declare-window) — wait for visibility before grabbing it.
    await vi.waitFor(() => {
      expect(first.get('llm-fallbacks')).toBeDefined()
    })
    const fb = service(first)
    await vi.waitFor(async () => {
      await expect(fb.declareSeeds([{ id: 'architect', persona: 'seed default' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [],
      })
    })

    // The operator edits the row persona while the fiber is alive.
    await first.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit', chain: ['op-chain'] }], rules: [] },
    })
    expect(fb.getEffectiveRoles().roles[0]).toMatchObject({
      persona: 'operator edit',
      personaOverridden: true,
    })

    // Capture the persisted user layer before the fiber dies — the
    // in-memory settings store is per-context; a real file-backed provider
    // keeps it across HMR, which the seed below mirrors (dev-time
    // seed-before-register pattern from gateway.spec.ts).
    const persisted = first.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!.user
    await first.fiber.dispose()

    // Fiber swap: a NEW fiber over the SAME persisted user layer.
    const second = track(new Context())
    await second.plugin(MemorySettings)
    ;(second.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, persisted)
    apply(second, { ...defaultFallbacksConfig, presets: 'none' })

    // Re-declare on the fresh fiber: the row exists with no previous default
    // in the fresh registry → conservative row-untouched, and the differing
    // persona is flagged loudly (spec §9.2 honest limitation).
    await vi.waitFor(async () => {
      await expect(service(second).declareSeeds([{ id: 'architect', persona: 'seed default' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [{ id: 'architect', kind: 'persona-source' }],
      })
    })

    // Still exactly one row per id — no duplicates across the swap — and the
    // operator override (persona + chain) is preserved byte-for-byte (R4).
    const rows = gateway(second).get().config.roles.list
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'architect', persona: 'operator edit', chain: ['op-chain'] })
    // The badge reflects the override, not a lost row.
    expect(gateway(second).get().seeds).toEqual([{ id: 'architect', overridden: true, source: 'external' }])
  })

  it('skip + conflict warns carry the llm-fallbacks: seeds: prefix (AC-2/5)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const logs = captureLogs(ctx)
    // Pin to `presets: 'none'` (fallbacks-preset-roles T3): the bundled
    // preset self-declaration would otherwise pre-materialize 5 preset rows
    // and break the exact single-row assertion below — this test exercises
    // the declare skip/conflict warn channel, not presets.
    apply(ctx, { ...defaultFallbacksConfig, presets: 'none' })
    // The service appears only after the settings inject child settles
    // (seeds-declare-window) — wait for visibility before grabbing it.
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })
    const fb = service(ctx)

    // Grab the service reference AFTER it is visible (above): a visible
    // service implies the write channel is bound (issue #105), so the first
    // declare below resolves on the first attempt and the warns collected
    // after the reset come from exactly ONE declare.
    await expect(fb.declareSeeds([{ id: 'architect', persona: 'v1' }])).resolves.toEqual({
      applied: ['architect'],
      skipped: [],
      conflicts: [],
    })
    logs.length = 0

    // Invalid ids are skipped PER-ID with a warn; valid siblings still apply
    // (AC-5 — zero coercion, reserved id rejected).
    await expect(fb.declareSeeds([
      { id: 'Architect', persona: 'uppercase' },
      { id: 'foo_bar', persona: 'underscore' },
      { id: 'inherit', persona: 'reserved' },
      { id: 'architect', persona: 'v1' },
    ])).resolves.toEqual({
      applied: ['architect'],
      skipped: [
        { id: 'Architect', reason: 'invalid-id' },
        { id: 'foo_bar', reason: 'invalid-id' },
        { id: 'inherit', reason: 'reserved-id' },
      ],
      conflicts: [],
    })
    expect(gateway(ctx).get().config.roles.list).toMatchObject([{ id: 'architect', persona: 'v1' }])

    // Operator override then re-declare → loud persona-source conflict, row
    // never overwritten (AC-2).
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit' }], rules: [] },
    })
    await expect(fb.declareSeeds([{ id: 'architect', persona: 'v2' }])).resolves.toEqual({
      applied: ['architect'],
      skipped: [],
      conflicts: [{ id: 'architect', kind: 'persona-source' }],
    })

    const warns = logs.filter((message) => message.type === 'warn').map((message) => String(message.args[0]))
    expect(warns.filter((message) => message.startsWith('llm-fallbacks: seeds: skipping seed id '))).toHaveLength(3)
    expect(warns).toContain(
      'llm-fallbacks: seeds: persona-source conflict for seed id "architect" — operator row persona kept (never overwritten)',
    )
  })

  it('service and gateway reverts both restore the CURRENT declared default; a new declare moves the target (AC-3/6c)', async () => {
    const ctx = await compose()
    await declare(ctx, [{ id: 'architect', persona: 'v1' }])

    // Operator edit → override visible on the wire badge.
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit' }], rules: [] },
    })
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'architect', overridden: true, source: 'external' }])

    // Service-side revert (surface (c)) restores the declared default.
    await expect(service(ctx).revertSeededPersona('architect')).resolves.toEqual({ reverted: true, persona: 'v1' })
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'architect', overridden: false, source: 'external' }])

    // Operator edits again; gateway-side revert (the card endpoint) restores
    // the same current default and reports the post-write read result.
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit 2' }], rules: [] },
    })
    const viaGateway = await gateway(ctx).revertSeed('architect')
    expect(viaGateway.outcome).toEqual({ reverted: true, persona: 'v1' })
    expect(viaGateway.config.roles.list).toMatchObject([{ id: 'architect', persona: 'v1' }])
    expect(viaGateway.seeds).toEqual([{ id: 'architect', overridden: false, source: 'external' }])

    // The companion re-declares a NEW persona → revert goes to the NEW
    // default, never a historical snapshot (R3).
    await declare(ctx, [{ id: 'architect', persona: 'v2' }])
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit 3' }], rules: [] },
    })
    await expect(gateway(ctx).revertSeed('architect')).resolves.toMatchObject({
      outcome: { reverted: true, persona: 'v2' },
      seeds: [{ id: 'architect', overridden: false }],
    })

    // Business failures are values, not throws (spec §9.1).
    await expect(service(ctx).revertSeededPersona('nobody')).resolves.toEqual({ reverted: false, reason: 'not-seeded' })
    const missing = await gateway(ctx).revertSeed('nobody')
    expect(missing.outcome).toEqual({ reverted: false, reason: 'not-seeded' })
    expect(missing.seeds).toEqual([{ id: 'architect', overridden: false, source: 'external' }])
  })
})

describe('seed provenance — source labels on the wire (seed-source-provenance, spec §2)', () => {
  it('declareSeeds(seeds, { set }) carries the set name as the wire source; rows outside any batch read back user (a/c)', async () => {
    const ctx = await compose()
    // An operator row that no companion ever declares — its provenance must
    // stay `user` while the declared batch carries the set name.
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'solo', persona: 'operator row' }], rules: [] },
    })
    await declare(ctx, [
      { id: 'coder', persona: 'Coders the flow' },
      { id: 'reviewer', persona: 'Reviews the flow' },
    ], { set: 'mstar' })

    // The gateway wire entries carry the declared set name...
    expect(gateway(ctx).get().seeds).toEqual([
      { id: 'coder', overridden: false, source: 'mstar' },
      { id: 'reviewer', overridden: false, source: 'mstar' },
    ])
    // ...and the service readback marks the never-declared row `user`.
    const roles = service(ctx).getEffectiveRoles().roles
    expect(roles.find((role) => role.id === 'solo')).toMatchObject({ seeded: false, source: 'user' })
    expect(roles.find((role) => role.id === 'coder')).toMatchObject({ seeded: true, source: 'mstar' })

    // A later unnamed declare replaces only its own (external) slice
    // (per-producer replacement semantics, plan seeds-source-and-persona-width
    // Decisions #1): coder degrades to `external`, while the mstar slice —
    // and reviewer with it — is untouched.
    await declare(ctx, [{ id: 'coder', persona: 'Coders the flow' }])
    expect(gateway(ctx).get().seeds).toEqual([
      { id: 'coder', overridden: false, source: 'external' },
      { id: 'reviewer', overridden: false, source: 'mstar' },
    ])
    expect(service(ctx).getEffectiveRoles().roles.find((role) => role.id === 'reviewer')).toMatchObject({
      seeded: true,
      source: 'mstar',
    })
  })

  it('a plain-JS { bundled: true } forge attempt through the SERVICE FACE yields external, never bundled (qc2 W-001: the face whitelists { set })', async () => {
    // A plain-JS companion (dsh plugins need not be TypeScript) rides the
    // internal marker past the TypeScript type system; the service-face
    // closure forwards ONLY `{ set }` to the manager, so the marker never
    // reaches `resolveSource`. The `{ bundled: true }` channel is the
    // preset child's alone (it calls the manager directly).
    const ctx = await compose()
    const forged = { bundled: true } as unknown as SeedsDeclareOptions
    await expect(
      service(ctx).declareSeeds([{ id: 'scout', persona: 'Scouts the flow' }], forged),
    ).resolves.toEqual({ applied: ['scout'], skipped: [], conflicts: [] })
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'scout', overridden: false, source: 'external' }])
    expect(service(ctx).getEffectiveRoles().roles[0]).toMatchObject({ seeded: true, source: 'external' })

    // The public channel stays intact: a legitimate `set` is honored even
    // when a forged `bundled` rides alongside it (extra key stripped).
    await expect(service(ctx).declareSeeds([{ id: 'scout', persona: 'Scouts the flow' }], {
      set: 'mstar',
      bundled: true,
    } as unknown as SeedsDeclareOptions)).resolves.toEqual({ applied: ['scout'], skipped: [], conflicts: [] })
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'scout', overridden: false, source: 'mstar' }])
    expect(service(ctx).getEffectiveRoles().roles[0]).toMatchObject({ seeded: true, source: 'mstar' })
  })
})

describe('seed provenance — designer/librarian trim upgrade (seed-source-provenance, spec §3)', () => {
  /**
   * The two personas removed from the bundled set (grill D4), verbatim from
   * the pre-trim §9.2 frozen text — what a pre-trim version (<= 0.1.6)
   * persisted, i.e. exactly the upgrading-operator fixture.
   */
  const DESIGNER_PERSONA =
    'UI/UX specialist for design implementation, review, and visual refinement. Analyze the existing design system first (tokens, theme, and primitives) and compose with it; if none exists, define a minimal system before implementing. Cover loading, empty, error, disabled, hover, and focus states; verify accessibility (contrast, focus rings, semantic HTML) and responsive layout. Avoid generic AI-slop patterns; in review, cite file and line with a concrete issue and a specific fix.'
  const LIBRARIAN_PERSONA =
    "Research specialist for external libraries and APIs who returns definitive, source-verified answers. Treat source as truth, documentation as aspiration, and training data as history; prefer locally installed packages, then official docs. Cross-check at least two locations; copy API signatures verbatim and report the investigated version. Stay read-only on the user's project; if a lookup is empty, try at least two fallback strategies before concluding nothing exists."

  /** The full pre-trim user layer: the 5 surviving presets + the two trimmed rows. */
  function preTrimUserLayer(): { roles: { list: Array<{ id: string; persona: string }>; rules: unknown[] } } {
    return {
      roles: {
        list: [
          ...presetRoles.map((preset) => ({ id: preset.id, persona: preset.persona })),
          { id: 'designer', persona: DESIGNER_PERSONA },
          { id: 'librarian', persona: LIBRARIAN_PERSONA },
        ],
        rules: [],
      },
    }
  }

  /** Compose over a PRE-TRIM persisted user layer with presets BUNDLED (the upgrade path). */
  async function composeOverPreTrimLayer(): Promise<Context> {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    ;(ctx.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, preTrimUserLayer())
    apply(ctx)
    // The preset fire commits: exactly the 5 in-batch ids are seeded (the
    // trimmed ids are outside the batch, so the badge never covers them).
    await vi.waitFor(() => {
      expect(gateway(ctx).get().seeds).toHaveLength(presetRoles.length)
    })
    return ctx
  }

  it('upgrade fixture: persisted designer/librarian rows survive the trimmed declare and read back user (g)', async () => {
    const ctx = await composeOverPreTrimLayer()

    // All 7 rows survive — the trimmed ids are omitted from the batch, and
    // materialize leaves absent ids' rows untouched (R2, no destructive write).
    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length + 2)
    expect(rows.find((row) => row.id === 'designer')).toMatchObject({ persona: DESIGNER_PERSONA })
    expect(rows.find((row) => row.id === 'librarian')).toMatchObject({ persona: LIBRARIAN_PERSONA })

    // The wire badge covers ONLY the surviving bundled ids.
    expect(gateway(ctx).get().seeds).toEqual(
      presetRoles.map((preset) => ({ id: preset.id, overridden: false, source: 'bundled' })),
    )

    // The trimmed rows read back as plain operator rows (spec §3: source user).
    const roles = service(ctx).getEffectiveRoles().roles
    expect(roles.find((role) => role.id === 'designer')).toMatchObject({
      seeded: false,
      personaOverridden: false,
      source: 'user',
    })
    expect(roles.find((role) => role.id === 'librarian')).toMatchObject({ seeded: false, source: 'user' })

    // The persisted user layer is content-identical to the pre-trim document —
    // the fire was a no-delta declare, no rewrite, no row dropped.
    expect(userSection(ctx)).toEqual(preTrimUserLayer())
  })

  it('pre-trim restart at seed personas: the next declare logs no persona-source conflict for the trimmed ids (i)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // Pre-trim layer with every row AT ITS SEED PERSONA (5 surviving + the
    // 2 trimmed ids) — the honest upgrade/restart fixture.
    ;(ctx.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, preTrimUserLayer())
    const logs = captureLogs(ctx)
    apply(ctx)
    // The preset fire commits: exactly the 5 in-batch ids are seeded.
    await vi.waitFor(() => {
      expect(gateway(ctx).get().seeds).toHaveLength(presetRoles.length)
    })
    await settle()

    // ZERO `llm-fallbacks: seeds:` warns: the trimmed ids sit OUTSIDE the
    // batch (the R2 `incoming === undefined` path — no conflict), and every
    // in-batch row sits at its seed persona, so the post-restart conservative
    // branch (which only fires for in-batch ids whose persisted persona
    // differs from the incoming default) has nothing to flag either.
    const warns = logs.filter((message) => message.type === 'warn').map((message) => String(message.args[0]))
    expect(warns.filter((message) => message.startsWith('llm-fallbacks: seeds:'))).toEqual([])

    // The rows survive with personas intact.
    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length + 2)
    expect(rows.find((row) => row.id === 'designer')).toMatchObject({ persona: DESIGNER_PERSONA })
    expect(rows.find((row) => row.id === 'librarian')).toMatchObject({ persona: LIBRARIAN_PERSONA })
  })
})
