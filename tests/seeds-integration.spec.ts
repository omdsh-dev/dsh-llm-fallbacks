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
 *   target (AC-3/6c).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, type FallbacksService } from '../src/index.ts'
import {
  FALLBACKS_SETTINGS_NAMESPACE,
  type FallbacksConfigGateway,
} from '../src/gateway.ts'
import type { SeedDeclareOutcome } from '../src/seeds.ts'
import { MemorySettings } from './support/memory-settings.ts'

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
  apply(ctx)
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
 * Declare through the service. The seed io write channel activates a tick
 * after apply (conditional inject child — gateway pattern), so the first
 * attempt can hit the transient settings-unavailable throw; the manager is
 * retry-safe (a failed write never commits the registry), so the retried
 * declare re-computes from a fresh read.
 */
async function declare(ctx: Context, seeds: Array<{ id: string; persona: string }>): Promise<SeedDeclareOutcome> {
  return vi.waitFor(async () => service(ctx).declareSeeds(seeds))
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
      { id: 'architect', overridden: false },
      { id: 'qa-engineer', overridden: false },
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
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'architect', overridden: false }])
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
    apply(first)
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
    apply(second)

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
    expect(gateway(second).get().seeds).toEqual([{ id: 'architect', overridden: true }])
  })

  it('skip + conflict warns carry the llm-fallbacks: seeds: prefix (AC-2/5)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const logs = captureLogs(ctx)
    apply(ctx)
    const fb = service(ctx)

    // Activate the seed write channel first (the inject child settles a tick
    // after apply) so the warns below come from ONE declare attempt — the
    // waitFor retry of a channel-unavailable declare would re-emit the
    // validation warns per attempt.
    await vi.waitFor(async () => {
      await expect(fb.declareSeeds([{ id: 'architect', persona: 'v1' }])).resolves.toEqual({
        applied: ['architect'],
        skipped: [],
        conflicts: [],
      })
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
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'architect', overridden: true }])

    // Service-side revert (surface (c)) restores the declared default.
    await expect(service(ctx).revertSeededPersona('architect')).resolves.toEqual({ reverted: true, persona: 'v1' })
    expect(gateway(ctx).get().seeds).toEqual([{ id: 'architect', overridden: false }])

    // Operator edits again; gateway-side revert (the card endpoint) restores
    // the same current default and reports the post-write read result.
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit 2' }], rules: [] },
    })
    const viaGateway = await gateway(ctx).revertSeed('architect')
    expect(viaGateway.outcome).toEqual({ reverted: true, persona: 'v1' })
    expect(viaGateway.config.roles.list).toMatchObject([{ id: 'architect', persona: 'v1' }])
    expect(viaGateway.seeds).toEqual([{ id: 'architect', overridden: false }])

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
    expect(missing.seeds).toEqual([{ id: 'architect', overridden: false }])
  })
})
