/**
 * Bundled preset self-declaration integration tests (plan fallbacks-preset-roles
 * Task 3): real `Context` + `MemorySettings` + `apply()` — the apply() tail
 * settings child fires `seeds.declare(presetRoles, seedsIo, { bundled: true })`
 * one tick after apply (spec §9.3 D9.3-a; the internal marker labels the
 * batch's provenance `bundled`), so EVERY assertion on the materialized rows
 * must waitFor (same compose/vi.waitFor pattern as
 * tests/seeds-integration.spec.ts).
 *
 * Covers (spec §9.5):
 * - default apply → 5 two-key rows materialized (persona = §9.2 via the same
 *   presetRoles source) + gateway `seeds` badge all seeded `bundled` (AC-1);
 * - repeated apply / dispose→re-apply → no-delta zero write + single rows (AC-1);
 * - `presets: 'none'` → zero declaration, zero write (AC-2);
 * - operator same-name row → persona kept + `llm-fallbacks: seeds:` conflict
 *   warn (AC-4);
 * - headless (no settings service) → no service at all (D1), no fire, no
 *   seeds write, no materialized rows from any seed source, no error log, no
 *   unhandled rejection, runtime dispatches (D9.3-b headless boundary);
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
import { settle } from './support/settle.ts'
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

/** §9.2 frozen text anchor — the scout persona verbatim (implementer SSOT copy). */
const SCOUT_PERSONA =
  'Read-only scout for exploratory codebase research, rapid analysis, and broad pattern search. Return compressed, structured findings another agent can reuse without re-reading the tree. Run searches in parallel; if a search is empty, try at least one alternate strategy before concluding the target is absent. Infer thoroughness from the task (quick, medium, or thorough; default medium); never write, edit, or run state-changing commands.'

describe('bundled preset self-declaration (real apply)', () => {
  it('default apply materializes the 5 two-key preset rows; gateway seeds badge all seeded bundled (AC-1)', async () => {
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
    // §9.2 frozen-text anchor (verbatim copy, scout).
    expect(rows.find((row) => row.id === 'scout')!.persona).toBe(SCOUT_PERSONA)
    // The RAW write shape is the two-key `{ id, persona }` (R4 — no
    // chain/fallback/prompt/permissions invented on insert).
    expect(userSection(ctx)).toEqual({
      roles: { list: presetRoles.map((preset) => ({ id: preset.id, persona: preset.persona })), rules: [] },
    })
    // Badge: all five rows seeded at their default (nothing overridden), all
    // carrying the internal self-declare's `bundled` provenance.
    expect(gateway(ctx).get().seeds).toEqual(
      presetRoles.map((preset) => ({ id: preset.id, overridden: false, source: 'bundled' })),
    )
    // The service readback agrees (single point of truth).
    expect(service(ctx).getEffectiveRoles().roles.map((role) => role.id)).toEqual(presetRoles.map((preset) => preset.id))
  })

  it("enabled: false still materializes the 5 preset rows (D9.3-c — no `enabled` gate)", async () => {
    // Explicit `enabled: false` (the default): the preset fire is NOT gated
    // by `enabled` — docs/configuration.md "Not gated by enabled" (F-002).
    // The default-value coincidence in compose() must not be the only pin.
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    apply(ctx, { ...defaultFallbacksConfig, enabled: false })
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })

    const rows = gateway(ctx).get().config.roles.list
    expect(gateway(ctx).get().config.enabled).toBe(false)
    expect(rows.map((row) => row.id)).toEqual(presetRoles.map((preset) => preset.id))
    expect(rows.map((row) => row.persona)).toEqual(presetRoles.map((preset) => preset.persona))
    expect(userSection(ctx)).toEqual({
      roles: { list: presetRoles.map((preset) => ({ id: preset.id, persona: preset.persona })), rules: [] },
    })
    expect(gateway(ctx).get().seeds).toEqual(
      presetRoles.map((preset) => ({ id: preset.id, overridden: false, source: 'bundled' })),
    )
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

  it("gateway set({ presets: 'none' }) on the user layer short-circuits the next fiber's fire (F-003 / D9.3-c)", async () => {
    const first = track(new Context())
    await first.plugin(CountingSettings)
    const firstSettings = first.settings as unknown as CountingSettings
    apply(first)
    await vi.waitFor(() => {
      expect(gateway(first).get().config.roles.list).toHaveLength(presetRoles.length)
    })
    expect(firstSettings.writes).toBe(1)

    // The settings USER-LAYER path (vs the entry/plugin-row path the
    // `presets: 'none'` test above covers): gateway set accepts `presets`
    // (CONFIG_KEYS round-trip) and writes it into the user layer.
    const setResult = await gateway(first).set({ presets: 'none' })
    expect(setResult.config.presets).toBe('none')
    // Persist the user layer (HMR mirror — the file-backed provider keeps
    // the document across a fiber swap).
    const persisted = userSection(first)
    await first.fiber.dispose()

    // Fresh fiber over the SAME persisted user layer: the tail child's fire
    // reads the LIVE composed source — user-layer `presets: 'none'` — and
    // short-circuits before declare: zero declarations, zero writes.
    const second = track(new Context())
    await second.plugin(CountingSettings)
    ;(second.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, persisted!)
    const secondSettings = second.settings as unknown as CountingSettings
    apply(second)
    await vi.waitFor(() => {
      expect(second.get('llm-fallbacks')).toBeDefined()
    })
    await settle()

    expect(secondSettings.writes).toBe(0)
    // The registry never committed — the fire short-circuited (a fired
    // no-delta declare would still commit the badge).
    expect(gateway(second).get().seeds).toEqual([])
    // The persisted rows are untouched and still visible on the wire.
    expect(gateway(second).get().config.roles.list).toHaveLength(presetRoles.length)
  })

  it('operator same-name row: persona kept + llm-fallbacks: seeds: conflict warn (AC-4)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // Pre-seed an operator user-layer row BEFORE the namespace registers —
    // the dev-time mirror of a provider whose document already carries the
    // row when the owning plugin loads.
    ;(ctx.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'scout', persona: 'operator persona' }], rules: [] },
    })
    const logs = captureLogs(ctx)
    apply(ctx)
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })

    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length)
    // The operator persona survives; the preset default is NOT written over it.
    expect(rows.find((row) => row.id === 'scout')!.persona).toBe('operator persona')
    // The badge marks the override (derived, not persisted) with the preset
    // self-declare's `bundled` provenance.
    expect(gateway(ctx).get().seeds.find((seed) => seed.id === 'scout')).toEqual({ id: 'scout', overridden: true, source: 'bundled' })

    const warns = logs.filter((message) => message.type === 'warn').map((message) => String(message.args[0]))
    expect(warns).toContain(
      'llm-fallbacks: seeds: persona-source conflict for seed id "scout" — operator row persona kept (never overwritten)',
    )
  })

  it('headless (no settings service): no service, no fire, no error, no materialized rows, runtime dispatches (D9.3-b + D1)', async () => {
    const ctx = track(new Context())
    const logs = captureLogs(ctx)
    // presets stay BUNDLED (the default) on purpose: the pin below is only
    // load-bearing if a preset declare WOULD materialize when the tail child
    // wrongly fires — with `presets: 'none'` the no-rows assertion would
    // hold trivially even in that regression (qc1 S-003 re-home).
    apply(ctx, cfg({ rootChain: ['other/gpt-4o'], presets: 'bundled' }))

    // D1 (seeds-declare-window): the provide lives INSIDE the settings inject
    // child — headless, that child never activates and the service NEVER
    // appears (it used to be visible synchronously during apply with a
    // throwing write channel). Consumers cannot obtain a seed surface whose
    // write channel is unbound.
    await settle()
    expect(ctx.get('llm-fallbacks')).toBeUndefined()

    // The fallback runtime dispatches normally without a settings service.
    const { agent } = makeAgent('headless-agent', { provider: 'mock', model: 'gpt-4o' })
    const action = await dispatchRequestError(ctx, agent, { failure: { message: 'denied', code: 'AUTH' } })
    expect(action).toEqual({ kind: 'retry' })

    // Give any (incorrectly) scheduled fire its activation window (a tick +
    // settle, same negative-assertion style as the `presets: 'none'` case).
    await settle()

    // Zero error log — the preset child never fired, no unhandled rejection.
    const errors = logs.filter((message) => message.type === 'error')
    expect(errors).toHaveLength(0)

    // Zero materialization from any seed source: the composed roles.list is
    // exactly the entry's (empty — no preset rows appended) and the seeds
    // badge is empty. The gateway IS registered headless (an unconditional
    // provide in apply), so this readback replaces the dropped
    // getEffectiveRoles readback (no service exists to read through).
    expect(gateway(ctx).get().config.roles.list).toEqual([])
    expect(gateway(ctx).get().seeds).toEqual([])
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
      roles: { list: [{ id: 'scout', persona: 'operator persona' }], rules: [] },
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
    expect(rows.find((row) => row.id === 'scout')!.persona).toBe('operator persona')
  })

  it('settings service removal + restore (provider reload) re-fires the preset child: no duplicate rows, no-delta zero write, badge correct (F-005)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(CountingSettings)
    const firstSettings = ctx.settings as unknown as CountingSettings
    apply(ctx)
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toHaveLength(presetRoles.length)
    })
    expect(firstSettings.writes).toBe(1)
    // Mirror the file-backed document across the reload: capture the raw
    // user section before the provider goes away.
    const persisted = userSection(ctx)

    // Provider reload: the settings service detaches (gateway.spec
    // remove/restore pattern) — the inject children unload and the composed
    // source falls back to the entry base (no user-layer rows).
    ctx.registry.delete(CountingSettings as unknown as typeof MemorySettings)
    await vi.waitFor(() => {
      expect(gateway(ctx).get().config.roles.list).toEqual([])
    })
    // The settings child unload withdraws the service WITH it (the provide
    // disposer runs on the same child unload — seeds-declare-window teardown
    // semantics): consumers probing now see `undefined`, not a dead write
    // channel (case f).
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeUndefined()
    })
    // The write channel is gone while the provider is absent (KD-G5).
    await expect(gateway(ctx).set({ enabled: true })).rejects.toThrow(/settings service is unavailable/)

    // ... and comes back: a FRESH provider instance over the SAME persisted
    // document (file-backed HMR mirror). Manual construction + synchronous
    // seed keeps the raw document in place before the inject children
    // re-activate (a cordis-init publish would otherwise wipe the doc).
    const fresh = new CountingSettings(ctx)
    fresh.seed(FALLBACKS_SETTINGS_NAMESPACE, persisted!)

    // The re-fired settings child re-binds the write channel and re-provides
    // the service — the old registration was withdrawn with the child unload,
    // so the re-provide hits no duplicate-registration failure (case f).
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })

    // The re-activated preset child re-fires: declare reads the composed
    // source (entry + persisted user layer) → no-delta → zero writes, no
    // duplicate rows, badge still reports every preset seeded.
    await vi.waitFor(() => {
      expect(gateway(ctx).get().seeds).toHaveLength(presetRoles.length)
    })
    await settle()

    expect(fresh.writes).toBe(0)
    const rows = gateway(ctx).get().config.roles.list
    expect(rows).toHaveLength(presetRoles.length)
    expect(new Set(rows.map((row) => row.id)).size).toBe(presetRoles.length)
    expect(rows.map((row) => row.persona)).toEqual(presetRoles.map((preset) => preset.persona))
    expect(userSection(ctx)).toEqual(persisted)
    expect(gateway(ctx).get().seeds).toEqual(
      presetRoles.map((preset) => ({ id: preset.id, overridden: false, source: 'bundled' })),
    )
  })
})
