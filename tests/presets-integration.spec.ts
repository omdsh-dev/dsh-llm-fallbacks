/**
 * Bundled preset self-declaration integration tests (plan fallbacks-preset-roles
 * Task 3): real `Context` + `MemorySettings` + `apply()` — the apply() tail
 * settings child fires `seeds.declare(presetRoles, seedsIo)` one tick after
 * apply (spec §9.3 D9.3-a), so EVERY assertion on the materialized rows must
 * waitFor (same compose/vi.waitFor pattern as tests/seeds-integration.spec.ts).
 *
 * Covers (spec §9.5):
 * - default apply → 7 two-key rows materialized (persona = §9.2 via the same
 *   presetRoles source) + gateway `seeds` badge all seeded (AC-1);
 * - repeated apply / dispose→re-apply → no-delta zero write + single rows (AC-1);
 * - `presets: 'none'` → zero declaration, zero write (AC-2);
 * - operator same-name row → persona kept + `llm-fallbacks: seeds:` conflict
 *   warn (AC-4);
 * - headless (no settings service) → no fire, no seeds write, no error log,
 *   no unhandled rejection, runtime dispatches (D9.3-b headless boundary);
 * - write failure (persist rejects) → exactly one `llm-fallbacks: seeds:`
 *   logger.error, registry not committed, apply/runtime unaffected (D9.3-b);
 * - multi-fiber: same-root second apply does NOT re-fire (no second conflict
 *   warn, write count unchanged) (D9.3-a W-1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, defaultFallbacksConfig, type FallbacksService } from '../src/index.ts'
import { FALLBACKS_SETTINGS_NAMESPACE, type FallbacksConfigGateway } from '../src/gateway.ts'
import { presetRoles } from '../src/presets.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg, dispatchRequestError, makeAgent } from './support/harness.ts'

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

/** The raw user-layer roles section of the fallbacks settings namespace. */
function userSection(ctx: Context): { roles: { list: Array<{ id: string; persona: string }>; rules: unknown[] } } | undefined {
  return ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)?.user
}

/** Capture every ctx.logger export (info/warn/...) from this point on (seeds-integration pattern). */
function captureLogs(ctx: Context): Array<{ type: string; args: unknown[] }> {
  const logs: Array<{ type: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
}

/** In-memory provider that counts raw-document persists (no-delta write probe). */
class CountingSettings extends MemorySettings {
  writes = 0
  protected override async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.writes += 1
    await super.persist(ns, section)
  }
}

/** In-memory provider whose raw-document persist ALWAYS rejects (failure face B). */
class RejectingSettings extends MemorySettings {
  protected override async persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    throw new Error('persist boom')
  }
}

/** Let pending microtasks/macrotasks settle (negative-assertion window). */
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 50)
  return promise
}

/** §9.2 frozen text anchor — the designer persona verbatim (implementer SSOT copy). */
const DESIGNER_PERSONA =
  'UI/UX specialist for design implementation, review, and visual refinement. Analyze the existing design system first (tokens, theme, and primitives) and compose with it; if none exists, define a minimal system before implementing. Cover loading, empty, error, disabled, hover, and focus states; verify accessibility (contrast, focus rings, semantic HTML) and responsive layout. Avoid generic AI-slop patterns; in review, cite file and line with a concrete issue and a specific fix.'

describe('bundled preset self-declaration (real apply)', () => {
  it('default apply materializes the 7 two-key preset rows; gateway seeds badge all seeded (AC-1)', async () => {
    const ctx = await compose()

    // The fire happens in the tail settings child — a tick after apply, so
    // the rows are only observable via waitFor.
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })

    // The WIRE rows are the schema-resolved composition; personas equal the
    // presetRoles source (T1 pins those verbatim to spec §9.2).
    const rows = gateway(ctx).get().config.roles.list
    expect(rows.map((row) => row.id)).toEqual(presetRoles.map((preset) => preset.id))
    expect(rows.map((row) => row.persona)).toEqual(presetRoles.map((preset) => preset.persona))
    // §9.2 frozen-text anchor (verbatim copy, designer).
    expect(rows.find((row) => row.id === 'designer')!.persona).toBe(DESIGNER_PERSONA)
    // The RAW write shape is the two-key `{ id, persona }` (R4 — no
    // chain/fallback/prompt/permissions invented on insert).
    expect(userSection(ctx)).toEqual({
      roles: { list: presetRoles.map((preset) => ({ id: preset.id, persona: preset.persona })), rules: [] },
    })
    // Badge: all seven rows seeded at their default (nothing overridden).
    expect(gateway(ctx).get().seeds).toEqual(
      presetRoles.map((preset) => ({ id: preset.id, overridden: false })),
    )
    // The service readback agrees (single point of truth).
    expect(service(ctx).getEffectiveRoles().roles.map((role) => role.id)).toEqual(presetRoles.map((preset) => preset.id))
  })

  it('repeated apply over the same root re-fires nothing: no-delta, zero extra write, single rows (AC-1)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(CountingSettings)
    const settings = ctx.settings as unknown as CountingSettings
    apply(ctx)
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })
    expect(settings.writes).toBe(1)
    const snapshot = structuredClone(userSection(ctx))

    // Same-root second apply: the service provide dedupes, so the second
    // fiber does not own the service and its tail child must not fire.
    apply(ctx)
    await vi.waitFor(() => {
      expect(service(ctx).getEffectiveRoles().roles).toHaveLength(presetRoles.length)
    })
    expect(settings.writes).toBe(1)
    expect(userSection(ctx)).toEqual(snapshot)

    // Still exactly one row per preset id — no duplicates across applies.
    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length)
    expect(new Set(rows.map((row) => row.id)).size).toBe(presetRoles.length)
    expect(rows.map((row) => row.persona)).toEqual(presetRoles.map((preset) => preset.persona))
  })

  it('dispose → re-apply (fiber swap) is an idempotent no-delta: zero write, single rows (AC-1)', async () => {
    const first = track(new Context())
    await first.plugin(CountingSettings)
    const firstSettings = first.settings as unknown as CountingSettings
    apply(first)
    await vi.waitFor(() => {
      expect(gateway(first).get().config.roles.list).toHaveLength(presetRoles.length)
    })
    expect(firstSettings.writes).toBe(1)
    // Persist the user layer before the fiber dies (HMR mirror — the
    // file-backed provider keeps the document across a fiber swap).
    const persisted = userSection(first)
    await first.fiber.dispose()

    // Fresh fiber over the SAME persisted user layer (seeds-integration
    // fiber-swap pattern): the re-fire is a no-delta declare — zero writes.
    const second = track(new Context())
    await second.plugin(CountingSettings)
    ;(second.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, persisted!)
    apply(second)
    await vi.waitFor(() => {
      expect(gateway(second).get().config.roles.list).toHaveLength(presetRoles.length)
    })
    expect((second.settings as unknown as CountingSettings).writes).toBe(0)
    expect(userSection(second)).toEqual(persisted)

    const rows = gateway(second).get().config.roles.list
    expect(rows.map((row) => row.id)).toEqual(presetRoles.map((preset) => preset.id))
    expect(rows.map((row) => row.persona)).toEqual(presetRoles.map((preset) => preset.persona))
  })

  it("presets: 'none' short-circuits before declare: zero declaration, zero write (AC-2)", async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    apply(ctx, { ...defaultFallbacksConfig, presets: 'none' })
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })
    // Give the tail settings child its activation window (a tick + settle):
    // if it fired, the write would land in the user layer by now.
    await settle()

    expect(userSection(ctx)).toBeUndefined()
    expect(gateway(ctx).get().config.roles.list).toEqual([])
    expect(gateway(ctx).get().seeds).toEqual([])
    expect(service(ctx).getEffectiveRoles().roles).toEqual([])
  })

  it('operator same-name row: persona kept + llm-fallbacks: seeds: conflict warn (AC-4)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // Pre-seed an operator user-layer row BEFORE the namespace registers —
    // the dev-time mirror of a provider whose document already carries the
    // row when the owning plugin loads.
    ;(ctx.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'designer', persona: 'operator persona' }], rules: [] },
    })
    const logs = captureLogs(ctx)
    apply(ctx)
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })

    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length)
    // The operator persona survives; the preset default is NOT written over it.
    expect(rows.find((row) => row.id === 'designer')!.persona).toBe('operator persona')
    // The badge marks the override (derived, not persisted).
    expect(gateway(ctx).get().seeds.find((seed) => seed.id === 'designer')).toEqual({ id: 'designer', overridden: true })

    const warns = logs.filter((message) => message.type === 'warn').map((message) => String(message.args[0]))
    expect(warns).toContain(
      'llm-fallbacks: seeds: persona-source conflict for seed id "designer" — operator row persona kept (never overwritten)',
    )
  })

  it('headless (no settings service): child never activates — no fire, no write, no error, runtime dispatches (D9.3-b)', async () => {
    const ctx = track(new Context())
    const logs = captureLogs(ctx)
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'] }))
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })

    // The fallback runtime dispatches normally without a settings service.
    const { agent } = makeAgent('headless-agent', { provider: 'mock', model: 'gpt-4o' })
    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })
    expect(action).toEqual({ kind: 'retry' })

    // Zero declaration, zero write, zero error log — the child never fired.
    expect(service(ctx).getEffectiveRoles().roles).toEqual([])
    const errors = logs.filter((message) => message.type === 'error')
    expect(errors).toHaveLength(0)
  })

  it('write failure: exactly one llm-fallbacks: seeds: error, registry not committed, runtime unaffected (D9.3-b)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(RejectingSettings)
    const logs = captureLogs(ctx)
    apply(ctx)
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })
    // The fire's terminal catch must log the failure (the only error exit).
    await vi.waitFor(() => {
      expect(
        logs.some((message) => message.type === 'error' && String(message.args[0]).startsWith('llm-fallbacks: seeds:')),
      ).toBe(true)
    })

    const errors = logs.filter(
      (message) => message.type === 'error' && String(message.args[0]).startsWith('llm-fallbacks: seeds:'),
    )
    expect(errors).toHaveLength(1)
    expect(String(errors[0]!.args[0])).toContain('preset role declaration failed')
    expect(String(errors[0]!.args[1])).toContain('persist boom')

    // The failed write never commits the registry: nothing is seeded and no
    // rows were materialized (badge/revert cannot misreport).
    expect(service(ctx).getEffectiveRoles().roles).toEqual([])
    expect(gateway(ctx).get().config.roles.list).toEqual([])
    expect(gateway(ctx).get().seeds).toEqual([])
    // apply/runtime unaffected: the service stays defined and callable.
    expect(ctx.get('llm-fallbacks')).toBeDefined()
    expect(service(ctx).resolveRole).toBeDefined()
  })

  it('multi-fiber: same-root second apply does not re-fire (no second conflict warn, no extra write) (D9.3-a W-1)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(CountingSettings)
    const settings = ctx.settings as unknown as CountingSettings
    // A conflict on the FIRST fire makes a second fire observable via warns.
    ;(ctx.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'designer', persona: 'operator persona' }], rules: [] },
    })
    const logs = captureLogs(ctx)
    apply(ctx)
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })
    expect(settings.writes).toBe(1)
    expect(
      logs.filter(
        (message) =>
          message.type === 'warn'
          && String(message.args[0]).startsWith('llm-fallbacks: seeds: persona-source conflict'),
      ),
    ).toHaveLength(1)

    // Second apply over the same root: the deduped fiber must not fire.
    apply(ctx)
    await vi.waitFor(() => {
      expect(service(ctx).getEffectiveRoles().roles).toHaveLength(presetRoles.length)
    })
    await settle()

    expect(settings.writes).toBe(1)
    expect(
      logs.filter(
        (message) =>
          message.type === 'warn'
          && String(message.args[0]).startsWith('llm-fallbacks: seeds: persona-source conflict'),
      ),
    ).toHaveLength(1)
    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length)
    expect(rows.find((row) => row.id === 'designer')!.persona).toBe('operator persona')
  })
})
