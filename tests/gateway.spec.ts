/**
 * T1 (plan llm-fallbacks-settings-gateway) — host-side `fallbacks` config
 * gateway (`/api/fallbacks/get` + `/api/fallbacks/set` +
 * `/api/fallbacks/reset` via explicit `ctx.typert.register` contribution —
 * `ctx.typert.local` is what the typertGateway claims first).
 *
 * Contract under test (`FallbacksConfigGateway`, src/gateway.ts):
 * ① No settings service (plain cordis ctx) — `get` returns the entry
 *    composed value (schema defaults → entry base), and `set`/`reset` fail
 *    cleanly (the settings service is unavailable — KD-G5 error path).
 * ② With a settings service mounted — `set` writes the USER layer (visible in
 *    `describe().user`), the composed value changes (base defaults the patch
 *    did not touch are kept), the write is LIVE (the bridge source reflects
 *    it), `set` returns the new composed value, and `reset` clears the user
 *    layer so the composition defaults reapply.
 * ③ `set` with an unknown key is rejected by the `Config` schema
 *    (unknown-key rejection unchanged) and nothing is persisted — including
 *    prototype-chain names (`__proto__`, `constructor`) that used to bypass
 *    the `in` guard (F-001, own-key membership) and never wipe the user layer.
 * ④ Containment (guide §10): a malformed stored user layer that the
 *    non-strict settings schema let through (an unknown key) never fails
 *    `get` — only schema-declared keys cross the wire, and a schema key
 *    whose composed value is `undefined` is omitted, never
 *    present-as-undefined (readConfig wire normalization, F-002).
 * ⑤ Endpoint claims: the explicit typert registration (the same
 *    `ctx.typert.local` store `claimsEndpoint` checks FIRST) claims
 *    `/api/fallbacks/get` + `/api/fallbacks/set` + `/api/fallbacks/reset`;
 *    the payload contract is exactly one plain-object `args` field; dispatch
 *    through the recorded `/api` interceptor and direct
 *    `ctx.typertGateway.invoke` both work.
 * ⑥ Composed end-to-end: the real plugin `apply` wires the gateway; the
 *    typertGateway dispatches get/set/reset against the live composed config.
 * ⑦ `get` carries the incremental `legacyKeys: string[]` field (spec §9) —
 *    empty for a clean two-block config, populated for legacy
 *    `chains`/`roles.default`/undeclared rule-role leftovers on the composed
 *    source; the wire config itself stays the new shape.
 * ⑧ `set`/`reset` return the same `{ config, legacyKeys }` shape computed on
 *    the POST-WRITE composed source (W-1/F-1): the settings merge retains a
 *    legacy user layer, so a save keeps re-reporting it; reset drops the user
 *    layer but re-reports entry-base leftovers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { apply } from '../src/index.ts'
import { Config } from '../src/schema.ts'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { OFFICIAL_V4_FLASH, OFFICIAL_V4_PRO } from '../src/time-slots.ts'
import {
  FALLBACKS_SETTINGS_NAMESPACE,
  FallbacksConfigGateway,
  fallbacksTypertContribution,
  type FallbacksSettingsBridge,
} from '../src/gateway.ts'
import { FallbacksSeedManager } from '../src/seeds.ts'
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

/** Full entry (plugin-row) config shape, merged over the schema defaults. */
function entryConfig(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return { ...defaultFallbacksConfig, ...overrides }
}

/**
 * An empty seed manager for gateway tests that do not exercise the seeds
 * wire (the ctor requires the manager; an empty registry yields `seeds: []`).
 */
function makeSeeds(): FallbacksSeedManager {
  return new FallbacksSeedManager({ warn: vi.fn() })
}

/**
 * Build the `FallbacksSettingsBridge` exactly the way `apply()` wires it (the
 * same `installSettingsSection` + setSource/onChange hooks) — the gateway
 * under test consumes this live source.
 */
function installFallbacksBridge(ctx: Context, entry: FallbacksConfig): FallbacksSettingsBridge {
  let source = (): FallbacksConfig => entry
  installSettingsSection(ctx, FALLBACKS_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (current) => {
      source = current
    },
    onChange: () => {
      // no bridge fan-out — the gateway reads source() live per call
    },
  })
  return {
    source: (): FallbacksConfig => source(),
  }
}

/** Read the gateway's internal settings capture (activated inject child). */
function settingsOf(gateway: FallbacksConfigGateway): unknown {
  return (gateway as unknown as { settings?: unknown }).settings
}

/** Wait until the conditional `ctx.inject(['settings'], ...)` child registered the namespace. */
async function waitRegistered(ctx: Context): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.settings.describe().some((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)).toBe(true)
  })
}

/**
 * Narrow a typertGateway invoke result to its `{ config }` payload — the
 * gateway wire contract (guide §2). Guards the shape before the single cast.
 */
function invokeConfig(result: unknown): FallbacksConfig {
  if (result === null || typeof result !== 'object' || !('config' in result)) {
    throw new TypeError('expected a typertGateway result of the shape { config }')
  }
  const { config } = result as { config: FallbacksConfig }
  return config
}

// ---------------------------------------------------------------------------
// ① no settings service → entry fallback (get works, set/reset fail cleanly)
// ---------------------------------------------------------------------------

describe('no settings service (entry fallback)', () => {
  it('get returns the entry composed value; the gateway is a registered service', () => {
    const ctx = track(new Context())
    const entry = entryConfig({ enabled: true, rootChain: ['other/gpt-4o'], cooldownMs: 120_000 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())

    expect(ctx.reflect.props['fallbacks']).toEqual({ type: 'service' })
    expect(gateway.get()).toEqual({ config: entry, legacyKeys: [], seeds: [] })
  })

  it('the seeds wire field is additive — config/legacyKeys consumers are untouched (legacyKeys precedent)', () => {
    // Spec §9.4: the `seeds` badge state rides every read response as an
    // incremental field, exactly like `legacyKeys` — a client that predates
    // seeds (or ignores the field) keeps reading config/legacyKeys unchanged.
    const ctx = track(new Context())
    const entry = entryConfig({ enabled: true, rootChain: ['other/gpt-4o'] })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())

    const result = gateway.get()
    // The full wire shape is exactly the three declared fields — nothing more.
    expect(Object.keys(result)).toEqual(['config', 'legacyKeys', 'seeds'])
    // The pre-existing fields are byte-identical to the pre-seeds contract.
    expect(result.config).toEqual(entry)
    expect(result.legacyKeys).toEqual([])
    // An empty seed registry reports an empty badge list.
    expect(result.seeds).toEqual([])
  })

  it('set fails cleanly when no settings service is composed (KD-G5 error path)', async () => {
    const ctx = track(new Context())
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await expect(gateway.set({ enabled: true })).rejects.toThrow(/settings service is unavailable/)
  })

  it('reset fails cleanly when no settings service is composed (KD-G5 error path)', async () => {
    const ctx = track(new Context())
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await expect(gateway.reset()).rejects.toThrow(/settings service is unavailable/)
  })

  it('revertSeed business failures are values without a settings service; a needed write throws (KD-G5)', async () => {
    // Spec §9.1: a non-seeded id never writes, so it succeeds even without a
    // settings service; only a revert that NEEDS a write channel fails loud.
    const ctx = track(new Context())
    const bridge = installFallbacksBridge(ctx, entryConfig())
    const seeds = makeSeeds()
    const gateway = new FallbacksConfigGateway(ctx, bridge, seeds)

    await expect(gateway.revertSeed('nobody')).resolves.toMatchObject({
      outcome: { reverted: false, reason: 'not-seeded' },
    })

    // A seeded-but-overridden row whose revert needs a write: seed the
    // manager through the bridge (declare attaches to the existing differing
    // row with NO delta — no write needed to commit the registry), then the
    // gateway revert must hit the unavailable channel loudly. Separate
    // context — the gateway registers the `fallbacks` service key (dedupe).
    const seededCtx = track(new Context())
    const operatorRow: FallbacksConfig = {
      ...entryConfig(),
      roles: { list: [{ id: 'architect', persona: 'operator edit' }], rules: [] },
    }
    const seededBridge = installFallbacksBridge(seededCtx, operatorRow)
    const seeded = makeSeeds()
    await seeded.declare([{ id: 'architect', persona: 'seed default' }], {
      read: () => seededBridge.source(),
      // The attach path writes nothing (row untouched) — this only asserts no
      // unexpected write on declare.
      writeRoles: async () => {
        throw new Error('declare must not write on a no-delta attach')
      },
    })
    const overriddenGateway = new FallbacksConfigGateway(seededCtx, seededBridge, seeded)
    await expect(overriddenGateway.revertSeed('architect')).rejects.toThrow(/settings service is unavailable/)
    // Nothing was written: the row still carries the operator persona.
    expect(overriddenGateway.get().config.roles.list[0]).toMatchObject({ persona: 'operator edit' })
  })

  it('revertSeed rejects a non-string id with a TypeError', async () => {
    const ctx = track(new Context())
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await expect(gateway.revertSeed(42 as never)).rejects.toThrow(TypeError)
    await expect(gateway.revertSeed(42 as never)).rejects.toThrow(/id must be a string/)
  })

  it('a second gateway on the same context fails loud (multi-fiber dedupe relies on this)', () => {
    const ctx = track(new Context())
    const entry = entryConfig()
    new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    expect(() => new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds()))
      .toThrow(/has been registered/)
  })
})

// ---------------------------------------------------------------------------
// ② with a settings service → set writes the user layer, reset clears it
// ---------------------------------------------------------------------------

describe('with a settings service (set writes the user layer)', () => {
  it('set writes the user layer (describe visible), the composed value changes live, and set returns it', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ rootChain: ['other/gpt-4o'], cooldownMs: 120_000 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    await waitRegistered(ctx)
    // The gateway's own inject child must have captured the settings service.
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    const result = await gateway.set({ enabled: true })

    // describe exposes the raw user layer (what the UI form wrote).
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ enabled: true })
    // The composed value keeps the base defaults the patch did not override.
    const composed: FallbacksConfig = { ...entry, enabled: true }
    // Live: the bridge source the runtime reads reflects the write.
    expect(gateway.get()).toEqual({ config: composed, legacyKeys: [], seeds: [] })
    // set returns the same { config, legacyKeys, seeds } shape as get (W-1/F-1).
    expect(result).toEqual({ config: composed, legacyKeys: [], seeds: [] })
  })

  it('a patch changing only one key leaves the other base values intact', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ cooldownMs: 120_000, maxSwitchesPerStep: 8 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ maxSwitchesPerStep: 3 })
    expect(gateway.get()).toEqual({ config: { ...entry, maxSwitchesPerStep: 3 }, legacyKeys: [], seeds: [] })
  })

  it('a second set MERGES into the existing user layer (merge, not replace semantics)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ enabled: true, cooldownMs: 120_000 })
    await gateway.set({ maxSwitchesPerStep: 3 })

    // The user layer keeps ALL keys written across the two calls — a
    // replace-semantics write would have dropped the earlier pair.
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ enabled: true, cooldownMs: 120_000, maxSwitchesPerStep: 3 })
    expect(gateway.get().config).toEqual({
      ...defaultFallbacksConfig,
      enabled: true,
      cooldownMs: 120_000,
      maxSwitchesPerStep: 3,
    })
  })

  it('an empty patch is a no-op: returns the current composed value without touching the user layer', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, cooldownMs: 120_000 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    const result = await gateway.set({})
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
    // A no-op set reports the unchanged composed source exactly like get
    // (W-1/F-1: every set/reset response carries the post-write legacyKeys).
    expect(result).toEqual(gateway.get())
    expect(result.config.enabled).toBe(true)
  })

  it('strips null-valued patch keys before the write (raw null never lands in the user layer)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, cooldownMs: 120_000 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ cooldownMs: null, maxSwitchesPerStep: 3 } as never)
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ maxSwitchesPerStep: 3 })
    // Dropping the null did not clear the base-pinned cooldown: the composed
    // config keeps it and the new cap.
    expect(gateway.get().config).toEqual({ ...entry, maxSwitchesPerStep: 3 })
  })

  it('an all-null patch is a no-op: nothing written, composed value unchanged', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, cooldownMs: 120_000 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ enabled: null, cooldownMs: null } as never)
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
    expect(gateway.get().config).toEqual(entry)
  })

  it('reset clears the user layer (section {}) and returns the composition-defaults config', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, rootChain: ['other/gpt-4o'], cooldownMs: 120_000 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entry), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ enabled: false, maxSwitchesPerStep: 3 })
    expect(gateway.get().config).toEqual({ ...entry, enabled: false, maxSwitchesPerStep: 3 })

    const result = await gateway.reset()

    // The user layer is cleared: the composed value returns to the
    // composition base (entry), so the earlier write no longer influences it.
    const after = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(after.user).toEqual({})
    expect(gateway.get()).toEqual({ config: entry, legacyKeys: [], seeds: [] })
    // reset returns the same { config, legacyKeys, seeds } shape as get (W-1/F-1).
    expect(result).toEqual({ config: entry, legacyKeys: [], seeds: [] })
  })

  it('set fails cleanly after the settings service is disposed (the inject child disposer clears the capture)', async () => {
    // The inject child's returned disposer mirrors installSettingsSection's
    // detach path: when the settings service goes away, the captured reference
    // is cleared, so `set` fails with the KD-G5 error instead of holding a
    // stale service reference (which would throw from inside the settings
    // package after disposal).
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    ctx.registry.delete(MemorySettings)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeUndefined())
    await expect(gateway.set({ enabled: true })).rejects.toThrow(/settings service is unavailable/)
  })

  it('set/reset responses carry POST-WRITE seeds (W-1/F-1, legacyKeys precedent)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const bridge = installFallbacksBridge(ctx, entryConfig())
    const seeds = makeSeeds()
    const gateway = new FallbacksConfigGateway(ctx, bridge, seeds)
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    // Drive a declare through the manager's public surface with the same
    // bridge + settings write channel the gateway uses (single point of
    // truth — the gateway never re-implements materialization).
    const outcome = await seeds.declare([{ id: 'architect', persona: 'seed default' }], {
      read: () => bridge.source(),
      writeRoles: async (roles) => {
        await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, { roles })
      },
    })
    expect(outcome).toEqual({ applied: ['architect'], skipped: [], conflicts: [] })
    expect(gateway.get().seeds).toEqual([{ id: 'architect', overridden: false }])

    // An operator edit flips the badge to override; the set response reports
    // the POST-WRITE state (the merge keeps the rows — set is not a reset).
    await ctx.settings.update(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'architect', persona: 'operator edit' }], rules: [] },
    })
    const setResult = await gateway.set({ enabled: true })
    expect(setResult.seeds).toEqual([{ id: 'architect', overridden: true }])
    expect(gateway.get().seeds).toEqual([{ id: 'architect', overridden: true }])

    // reset clears the user layer — the materialized seed rows go with it,
    // so the honest post-write badge state is empty (the in-memory registry
    // survives; the next declare re-materializes per AC-1).
    const resetResult = await gateway.reset()
    expect(resetResult.seeds).toEqual([])
    expect(gateway.get().seeds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ③ set unknown key / schema violation → rejected (Config schema, nothing persisted)
// ---------------------------------------------------------------------------

describe('set validation (Config schema, unknown-key rejection unchanged)', () => {
  it('an unknown key is rejected before anything is written', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await expect(gateway.set({ bogus: 1 } as never)).rejects.toThrow(/unknown config key "bogus"/)
    // Nothing was persisted: the user layer stays absent.
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
  })

  it('accepts the roleAutoMatch switch (plan fallbacks-role-automatch Task 1 — toggleable)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    // The key is a declared config key (not rejected as unknown) and lands
    // on the composed config — the write path the settings UI will use.
    const setResult = await gateway.set({ roleAutoMatch: false })
    expect(setResult.config.roleAutoMatch).toBe(false)
    expect(gateway.get().config.roleAutoMatch).toBe(false)
  })

  it('rejects an own __proto__ key (prototype-chain bypass of the unknown-key gate — F-001)', async () => {
    // An object LITERAL cannot carry an own `__proto__` key (it sets the
    // prototype instead), but JSON.parse / Object.fromEntries can — the
    // third-party RPC caller shape. `'__proto__' in CONFIG_KEYS` is true via
    // Object.prototype, so the old `in` guard let it through; the user layer
    // write then corrupted the settings merge (config wipe). Own-key
    // membership must reject it.
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    const poisoned = Object.fromEntries([['__proto__', { enabled: true }]])
    await expect(gateway.set(poisoned as never)).rejects.toThrow(/unknown config key "__proto__"/)
    // Nothing was persisted: the user layer stays absent (no wipe, no junk).
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
  })

  it('rejects a constructor key (prototype-chain name, not a config key)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await expect(gateway.set({ constructor: { enabled: true } } as never)).rejects.toThrow(/unknown config key "constructor"/)
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
  })

  it('the user layer survives an attempted __proto__ wipe (F-001)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    // A real write first: the user layer holds a legitimate config.
    await gateway.set({ enabled: true, cooldownMs: 120_000 })

    // The poisoned patch is rejected — and the pre-existing user layer is
    // untouched (the old `in` guard would have merged it and let the
    // settings layer wipe the section).
    const poisoned = Object.fromEntries([['__proto__', { enabled: true }]])
    await expect(gateway.set(poisoned as never)).rejects.toThrow(/unknown config key "__proto__"/)

    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ enabled: true, cooldownMs: 120_000 })
    expect(gateway.get().config).toEqual({ ...entryConfig(), enabled: true, cooldownMs: 120_000 })
  })

  it('a patch violating the schema types is rejected', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    // The matcher pins the rejecting stage: the schemastery `Config` type
    // check (`$.cooldownMs expected number but got nope`) must be what
    // rejects — a regression that pushed the rejection to some other stage
    // while `validateConfigPatch` silently passed would no longer match.
    await expect(gateway.set({ cooldownMs: 'nope' } as never)).rejects.toThrow(/cooldownMs/)
  })

  it('rejects the removed legacy chains key (new CONFIG_KEYS set)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await expect(gateway.set({ chains: { default: ['other/gpt-4o'] } } as never)).rejects.toThrow(
      /unknown config key "chains"/,
    )
    // Nothing was persisted: the user layer stays absent.
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
  })

  it('a non-object patch is rejected as malformed input', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await expect(gateway.set('nope' as never)).rejects.toThrow(/plain object/)
  })

  it('rejects unknown NESTED roles keys (roles.default would re-arm the legacy banner — qc2 S-1)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    // The top-level guard does not recurse: schemastery retains unknown
    // NESTED keys too, so a `roles.default` patch would be persisted by the
    // settings merge and re-arm the migration banner from a write the UI
    // never makes. The API boundary must reject it (same strictness as the
    // top-level unknown-key guard).
    await expect(gateway.set({ roles: { default: 'reviewer' } } as never))
      .rejects.toThrow(/unknown config key "roles\.default"/)
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
  })

  it('accepts only the declared roles nested keys (list/rules patch passes)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({
      roles: { list: [{ id: 'coder', persona: 'Coding subagent' }], rules: [{ role: 'coder' }] },
    } as never)
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({
      roles: {
        list: [{ id: 'coder', persona: 'Coding subagent' }],
        rules: [{ role: 'coder' }],
      },
    })
    expect(gateway.get().legacyKeys).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ⑩ plan fallbacks-timeslots Task 3: time-slot rows + all-day head
//    (gateway reject-on-save guards — the load side stays warn-not-crash)
// ---------------------------------------------------------------------------

describe('timeSlots + all-day set guards (plan fallbacks-timeslots Task 3)', () => {
  async function mountGateway(): Promise<{ gateway: FallbacksConfigGateway; ctx: Context }> {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())
    return { gateway, ctx }
  }

  it('accepts a conforming all-day chain (Flash or Pro, length 1)', async () => {
    const { gateway } = await mountGateway()
    const flash = await gateway.set({ rootChain: [OFFICIAL_V4_FLASH] })
    expect(flash.config.rootChain).toEqual([OFFICIAL_V4_FLASH])
    const pro = await gateway.set({ rootChain: [OFFICIAL_V4_PRO] })
    expect(pro.config.rootChain).toEqual([OFFICIAL_V4_PRO])
  })

  it('rejects a non-conforming all-day chain on save (legacy multi-model AND empty — P6)', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({ rootChain: ['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'] })).rejects
      .toThrow(/rootChain must end with exactly one official V4 model/)
    await expect(gateway.set({ rootChain: ['openai/gpt-4o'] })).rejects
      .toThrow(/rootChain must end with exactly one official V4 model/)
    // The empty default is the "no all-day" state — also rejected on save:
    // everything saved through the gateway is tail-conforming.
    await expect(gateway.set({ rootChain: [] })).rejects.toThrow(/rootChain must end with exactly one official V4 model/)
    // Nothing was persisted: the composed rootChain stays the entry default.
    expect(gateway.get().config.rootChain).toEqual([])
  })

  it('accepts valid preset rows (frozen windows, models-only) and custom rows', async () => {
    const { gateway } = await mountGateway()
    const patch = {
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', chain: ['openai/gpt-4o'] },
        { kind: 'custom', start: '22:00', end: '02:00', days: [1, 3, 5], chain: ['anthropic/claude-3-5-sonnet'] },
        { kind: 'custom', start: '09:00', end: '10:00', chain: ['openai/gpt-4o'] },
      ],
    }
    const result = await gateway.set(patch as never)
    // The composed rows carry the schema's materialized `days: []` (absent
    // array fields compose as []) — the shape every `get` and card load sees.
    expect(result.config.timeSlots).toEqual([
      { kind: 'preset', preset: 'liang-peak', days: [], chain: ['openai/gpt-4o'] },
      { kind: 'custom', start: '22:00', end: '02:00', days: [1, 3, 5], chain: ['anthropic/claude-3-5-sonnet'] },
      { kind: 'custom', start: '09:00', end: '10:00', days: [], chain: ['openai/gpt-4o'] },
    ])
  })

  it('rejects unknown nested keys inside a timeSlots row (ROLES_KEYS pattern)', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', chain: ['openai/gpt-4o'], bogus: 1 }],
    } as never)).rejects.toThrow(/unknown config key "timeSlots\[0\]\.bogus"/)
  })

  it('rejects an unknown preset id on save', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({
      timeSlots: [{ kind: 'preset', preset: 'not-a-preset', chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/preset must be one of the four frozen preset ids/)
  })

  it('rejects a duplicate preset row on save (two locked liang-peak rows)', async () => {
    const { gateway } = await mountGateway()
    const patch = {
      timeSlots: [
        { kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_V4_FLASH] },
        { kind: 'preset', preset: 'liang-peak', chain: [OFFICIAL_V4_PRO] },
      ],
    }
    await expect(gateway.set(patch as never)).rejects.toThrow(/duplicates preset "liang-peak"/)
  })

  it('rejects a preset row carrying its own window/day fields (windows are code constants — P4)', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({
      timeSlots: [{ kind: 'preset', preset: 'glm-peak', start: '10:00', end: '11:00', chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/cannot carry start\/end\/days/)
    await expect(gateway.set({
      timeSlots: [{ kind: 'preset', preset: 'glm-peak', days: [1, 2], chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/cannot carry start\/end\/days/)
  })

  it('rejects custom rows with a non-HH:mm or missing window', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({
      timeSlots: [{ kind: 'custom', start: '9:00', end: '10:00', chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/requires HH:mm start and end/)
    await expect(gateway.set({
      timeSlots: [{ kind: 'custom', start: '09:00', chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/requires HH:mm start and end/)
  })

  it('rejects out-of-range day entries', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', days: [7], chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/days must be an array of integers 0–6/)
    await expect(gateway.set({
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', days: ['1'], chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/days must be an array of integers 0–6/)
  })

  it('rejects an empty chain and an unknown kind', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({
      timeSlots: [{ kind: 'custom', start: '09:00', end: '10:00', chain: [] }],
    } as never)).rejects.toThrow(/chain must be a non-empty string array/)
    await expect(gateway.set({
      timeSlots: [{ kind: 'weird', chain: ['openai/gpt-4o'] }],
    } as never)).rejects.toThrow(/kind must be "preset" or "custom"/)
  })

  it('rejects a non-array timeSlots value', async () => {
    const { gateway } = await mountGateway()
    await expect(gateway.set({ timeSlots: 'nope' } as never)).rejects.toThrow(/timeSlots must be an array of slot rows/)
  })

  it('accepts tz as a config-level string and carries it through get', async () => {
    const { gateway } = await mountGateway()
    const result = await gateway.set({ tz: 'UTC' })
    expect(result.config.tz).toBe('UTC')
    expect(gateway.get().config.tz).toBe('UTC')
  })
})

// ---------------------------------------------------------------------------
// ④ containment: a malformed stored user layer never fails get (guide §10)
// ---------------------------------------------------------------------------

describe('containment (malformed stored user layer)', () => {
  it('a seeded unknown key survives the non-strict settings schema but never reaches the wire', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // Seed BEFORE the namespace registers — the dev-time mirror of a provider
    // whose raw document already contains the section when the plugin loads.
    // The non-strict settings schema merges the unknown key through.
    const settings = ctx.settings as unknown as MemorySettings
    settings.seed(FALLBACKS_SETTINGS_NAMESPACE, { enabled: true, bogus: 1 })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)

    const result = gateway.get()
    // get never fails on the bad user layer (no resolver to crash on it).
    expect(result.config.enabled).toBe(true)
    // Only schema-declared keys cross the wire — the bogus key is omitted.
    expect('bogus' in result.config).toBe(false)
    expect(result.config.rootChain).toEqual([])
    expect(result.config.cooldownMs).toBe(defaultFallbacksConfig.cooldownMs)
  })

  it('omits a schema key whose composed value is undefined (never present-as-undefined on the wire)', () => {
    // The gateway result validator rejects undefined values, so `readConfig`
    // must OMIT absent values instead of carrying them — a schema key whose
    // composed value is `undefined` is dropped, it does not ride the wire as
    // an own key with an undefined value (F-002, readConfig normalization).
    const ctx = track(new Context())
    const gateway = new FallbacksConfigGateway(ctx, {
      source: (): FallbacksConfig => ({
        ...defaultFallbacksConfig,
        cooldownMs: undefined as unknown as number,
      }),
    }, makeSeeds())

    const result = gateway.get()
    expect('cooldownMs' in result.config).toBe(false)
    // The remaining schema keys still cross the wire with their values.
    expect(result.config.enabled).toBe(false)
    expect(result.config.rootChain).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ⑦ get legacyKeys (spec §9 incremental field — legacy detection rides get)
// ---------------------------------------------------------------------------

describe('get legacyKeys detection (two-block-era leftovers)', () => {
  it('returns an empty list for a clean two-block config', () => {
    const ctx = track(new Context())
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig({ enabled: true })), makeSeeds())
    expect(gateway.get()).toEqual({
      config: entryConfig({ enabled: true }),
      legacyKeys: [],
      seeds: [],
    })
  })

  it('detects the removed chains / roles.default keys on the composed source', () => {
    const ctx = track(new Context())
    const legacy = {
      ...entryConfig(),
      chains: { default: ['other/gpt-4o'], reviewer: ['openai/gpt-4o-mini'] },
      roles: { default: 'default', rules: [] },
    } as never
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, legacy), makeSeeds())
    expect(gateway.get().legacyKeys).toEqual(['chains', 'roles.default'])
    // The wire config itself is the new shape — legacy keys never cross.
    expect('chains' in gateway.get().config).toBe(false)
    expect(gateway.get().config.rootChain).toEqual([])
    // Nested legacy keys are stripped too (reviewer T1 Important #1): the
    // wire roles object carries only its declared list/rules fields — a
    // consumer like Task 2's parseFallbacksConfig never misreads
    // roles.default as a live config value. Absent fields stay omitted
    // (wire boundary rule), so the legacy `{ default, rules }` object
    // normalizes to `{ rules }` — no `default`, and no invented `list`.
    expect('default' in gateway.get().config.roles).toBe(false)
    expect(Object.keys(gateway.get().config.roles)).toEqual(['rules'])
  })

  it('detects undeclared rule role references (roles.rules[].role)', () => {
    const ctx = track(new Context())
    const legacy = {
      ...entryConfig(),
      roles: { list: [{ id: 'coder' }], rules: [{ role: 'ghost' }, { role: 'coder' }, { role: 'inherit' }] },
    } as never
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, legacy), makeSeeds())
    expect(gateway.get().legacyKeys).toEqual(['roles.rules[].role: ghost'])
  })

  it('seeded legacy user layer survives the settings merge — composed source retains the keys and get reports them (qc3 F-2b)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // Seed BEFORE the namespace registers: the dev-time mirror of a legacy
    // user whose user layer holds the two-block-era keys (chains +
    // roles.default) when the upgraded plugin loads. This is the settings
    // USER-LAYER merge path — the exact path a real legacy user hits (the
    // entry-base composition tests prove only the schema-defaults path).
    const settings = ctx.settings as unknown as MemorySettings
    settings.seed(FALLBACKS_SETTINGS_NAMESPACE, {
      chains: { default: ['other/gpt-4o'] },
      roles: { default: 'reviewer', rules: [{ role: 'reviewer' }] },
    })
    const bridge = installFallbacksBridge(ctx, entryConfig())
    const gateway = new FallbacksConfigGateway(ctx, bridge, makeSeeds())
    await waitRegistered(ctx)

    // Merge-retention path: the composed source the runtime adapters read
    // (apply/onChange/decide/getSnapshot in src/index.ts) still carries the
    // legacy keys through the settings merge.
    const composed = bridge.source() as unknown as Record<string, unknown>
    expect(Object.hasOwn(composed, 'chains')).toBe(true)
    const roles = composed.roles as Record<string, unknown>
    expect(Object.hasOwn(roles, 'default')).toBe(true)
    expect(Array.isArray(roles.rules)).toBe(true)

    // get() reports all three legacy classes (spec §9) — the migration
    // banner source for a real upgraded user.
    expect(gateway.get().legacyKeys).toEqual(['chains', 'roles.default', 'roles.rules[].role: reviewer'])
    // The wire config stays the new shape (legacy keys never cross).
    const wire = gateway.get().config
    expect('chains' in wire).toBe(false)
    expect('default' in wire.roles).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ⑧ set/reset return post-write legacyKeys (W-1/F-1 — the merge survives)
// ---------------------------------------------------------------------------

describe('set/reset return post-write legacyKeys (W-1/F-1)', () => {
  it('a save on a legacy user layer keeps reporting the legacy keys (merge, not overwrite)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const settings = ctx.settings as unknown as MemorySettings
    settings.seed(FALLBACKS_SETTINGS_NAMESPACE, {
      chains: { default: ['other/gpt-4o'] },
      roles: { default: 'reviewer', rules: [{ role: 'reviewer' }] },
    })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    expect(gateway.get().legacyKeys).toEqual(['chains', 'roles.default', 'roles.rules[].role: reviewer'])

    // A new-shape save MERGES over the user layer: the legacy keys survive
    // the write, so the post-write response re-reports them — the client
    // banner stays honest instead of flickering off against server truth.
    const result = await gateway.set({ enabled: true })
    expect(result.config.enabled).toBe(true)
    expect(result.legacyKeys).toEqual(['chains', 'roles.default', 'roles.rules[].role: reviewer'])
    // The next get agrees (no flicker window).
    expect(gateway.get().legacyKeys).toEqual(['chains', 'roles.default', 'roles.rules[].role: reviewer'])
  })

  it('reset drops the user layer but re-reports legacy keys carried by the entry base', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const legacy = {
      ...entryConfig(),
      chains: { default: ['other/gpt-4o'] },
    } as never
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, legacy), makeSeeds())
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    const result = await gateway.reset()
    // settings.replace({}) cleared the user layer; the entry base still
    // carries the legacy key, and the post-write source re-reports it.
    expect(result.legacyKeys).toEqual(['chains'])
    expect(gateway.get().legacyKeys).toEqual(['chains'])
  })
})

// ---------------------------------------------------------------------------
// ⑨ legacy roleAutoMatch on the real gateway wire (AC-7 re-scope Option A —
//    PM decision 2026-08-17)
// ---------------------------------------------------------------------------

describe('legacy roleAutoMatch on the real gateway wire (AC-7 re-scope Option A)', () => {
  it('always emits roleAutoMatch: true for a seeded legacy user layer that never declared the key (F-001 proof)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // A pre-Plan-A user layer WITHOUT the roleAutoMatch key — the exact
    // upgrade shape the QC flag (qc1/qc2 F-001) traced: the unit tests only
    // exercised a hand-built absent-key wire that the real gateway never
    // produces.
    const settings = ctx.settings as unknown as MemorySettings
    settings.seed(FALLBACKS_SETTINGS_NAMESPACE, {
      enabled: true,
      rootChain: ['other/gpt-4o'],
    })
    const gateway = new FallbacksConfigGateway(ctx, installFallbacksBridge(ctx, entryConfig()), makeSeeds())
    await waitRegistered(ctx)

    // F-001 proof through the REAL path: the `Config` schema composition
    // (entry base → user layer → `resolve`) folds the schema default into
    // the merged source, and `readConfig` emits every non-undefined declared
    // key — so `get()` for a legacy user layer carries `roleAutoMatch: true`
    // even though the user layer never declared it. There is no
    // key-presence signal for the client to strip on (AC-7 re-scope Option
    // A: the toggle always renders, default on).
    const first = gateway.get()
    expect('roleAutoMatch' in first.config).toBe(true)
    expect(first.config.roleAutoMatch).toBe(true)

    // The client's assembled draft always carries the key (the toggle always
    // renders), so a save pins `roleAutoMatch: true` into the user layer —
    // semantically identical to the schema default.
    const result = await gateway.set({ roleAutoMatch: true, cooldownMs: 120_000 })
    expect(result.config.roleAutoMatch).toBe(true)
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toMatchObject({ roleAutoMatch: true, cooldownMs: 120_000 })
    // The next get agrees.
    expect(gateway.get().config.roleAutoMatch).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ⑤ endpoint claims (explicit typert registration + payload contract)
// ---------------------------------------------------------------------------

type FakeRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

type FakeRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<FakeRpcResult>

/** Records the `/api` interceptor the typertGateway mounts (advisor gateway.spec.ts pattern). */
class FakeConnectionService extends Service {
  channel: string | undefined
  authority: string | undefined
  matches: ((endpoint: string) => boolean) | undefined
  handler: FakeRpcHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    const owner = this.ctx
    return {
      intercept: (
        channel: string,
        matches: (endpoint: string) => boolean,
        handler: FakeRpcHandler,
        options: { readonly authority: string },
      ) =>
        owner.effect(() => {
          this.channel = channel
          this.authority = options.authority
          this.matches = matches
          this.handler = handler
          return () => {
            this.channel = undefined
            this.authority = undefined
            this.matches = undefined
            this.handler = undefined
          }
        }),
    }
  }
}

describe('typertGateway endpoint claims + payload contract', () => {
  async function composeGatewayHarness(seedUser?: Record<string, unknown>): Promise<{ ctx: Context; connection: FakeConnectionService }> {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    if (seedUser !== undefined) {
      // Pre-seed the fallbacks user section BEFORE the namespace registers —
      // the dev-time mirror of a file-backed provider whose raw document
      // already contains the section when the plugin loads.
      const settings = ctx.settings as unknown as MemorySettings
      settings.seed(FALLBACKS_SETTINGS_NAMESPACE, seedUser)
    }
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(FakeConnectionService)
    await ctx.plugin(TypertGatewayService)
    const bridge = installFallbacksBridge(ctx, entryConfig({ cooldownMs: 120_000, maxSwitchesPerStep: 5 }))
    new FallbacksConfigGateway(ctx, bridge, makeSeeds())
    ctx.typert.register(fallbacksTypertContribution())
    await waitRegistered(ctx)
    const connection = ctx.get('connection') as unknown as FakeConnectionService
    await vi.waitFor(() => expect(connection.channel).toBe('/api'))
    return { ctx, connection }
  }

  it('claims /api/fallbacks/get + set + reset + revert-seed through the explicit typert registration (ctx.typert.local)', async () => {
    const { ctx, connection } = await composeGatewayHarness()
    // The registration writes invocation descriptors into `ctx.typert.local`
    // — the store `claimsEndpoint` checks FIRST — and the gateway remains a
    // registered cordis service.
    expect(ctx.reflect.props['fallbacks']).toEqual({ type: 'service' })
    expect(ctx.typert.local.get('fallbacks/get')).toMatchObject({ service: 'fallbacks', namespace: 'fallbacks', method: 'get' })
    expect(ctx.typert.local.get('fallbacks/set')).toMatchObject({ service: 'fallbacks', namespace: 'fallbacks', method: 'set' })
    expect(ctx.typert.local.get('fallbacks/reset')).toMatchObject({ service: 'fallbacks', namespace: 'fallbacks', method: 'reset' })
    // The revert endpoint's wire method is the hyphenated endpoint name; the
    // actual service member is aliased through `implementation` (the
    // typertGateway dispatches `implementation ?? method`).
    expect(ctx.typert.local.get('fallbacks/revert-seed')).toMatchObject({
      service: 'fallbacks',
      namespace: 'fallbacks',
      method: 'revert-seed',
      implementation: 'revertSeed',
    })
    expect(ctx.typert.local.get('fallbacks/revert-seed')?.parameters).toEqual([
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'src-json' } },
    ])
    expect(connection.authority).toBe('trusted-host')
    expect(connection.matches!('fallbacks/get')).toBe(true)
    expect(connection.matches!('fallbacks/set')).toBe(true)
    expect(connection.matches!('fallbacks/reset')).toBe(true)
    expect(connection.matches!('fallbacks/revert-seed')).toBe(true)
    // Unrelated endpoints are NOT claimed (the interceptor falls through).
    expect(connection.matches!('fallbacks/other')).toBe(false)
    expect(connection.matches!('goals/create')).toBe(false)
  })

  it('dispatches get/set/reset through the /api interceptor with the { args } payload contract', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const got = await connection.handler!('fallbacks/get', { args: {} }, signal)
    expect(got).toEqual({
      ok: true,
      value: {
        config: { ...defaultFallbacksConfig, cooldownMs: 120_000, maxSwitchesPerStep: 5 },
        legacyKeys: [],
        seeds: [],
      },
    })

    const setResult = await connection.handler!(
      'fallbacks/set',
      { args: { patch: { enabled: true, rootChain: [OFFICIAL_V4_FLASH] } } },
      signal,
    )
    expect(setResult.ok).toBe(true)
    if (setResult.ok) {
      expect(setResult.value).toMatchObject({
        config: { enabled: true, rootChain: [OFFICIAL_V4_FLASH], cooldownMs: 120_000 },
      })
    }

    // The written value is visible on the next get.
    const gotAgain = await connection.handler!('fallbacks/get', { args: {} }, signal)
    expect(gotAgain).toMatchObject({
      ok: true,
      value: { config: { enabled: true, rootChain: [OFFICIAL_V4_FLASH] } },
    })

    // reset clears the user layer back to the composition base.
    const resetResult = await connection.handler!('fallbacks/reset', { args: {} }, signal)
    expect(resetResult.ok).toBe(true)
    if (resetResult.ok) {
      expect(resetResult.value).toMatchObject({
        config: { enabled: false, rootChain: [], cooldownMs: 120_000 },
      })
    }
  })

  it('dispatches fallbacks/revert-seed with the { args: { id } } payload contract; business failures are values', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    // A non-seeded id is a BUSINESS outcome, never an RPC failure: the
    // response is ok:true carrying the full read result plus the outcome.
    const result = await connection.handler!('fallbacks/revert-seed', { args: { id: 'nobody' } }, signal)
    expect(result).toEqual({
      ok: true,
      value: {
        config: { ...defaultFallbacksConfig, cooldownMs: 120_000, maxSwitchesPerStep: 5 },
        legacyKeys: [],
        seeds: [],
        outcome: { reverted: false, reason: 'not-seeded' },
      },
    })

    // The descriptor pins the wire param: exactly `id` (assertExactArguments
    // rejects unknown wire fields).
    const badWire = await connection.handler!('fallbacks/revert-seed', { args: { id: 'x', extra: 1 } }, signal)
    expect(badWire.ok).toBe(false)
    if (!badWire.ok) expect(badWire.error.message).toContain('args fields do not match the descriptor')
  })

  it('enforces the payload contract: exactly one plain-object args field', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const badArgs = await connection.handler!('fallbacks/set', { args: 'not-an-object' }, signal)
    expect(badArgs.ok).toBe(false)
    if (!badArgs.ok) expect(badArgs.error.message).toContain('plain-object args field')

    const unknownWire = await connection.handler!('fallbacks/set', { args: { wrong: 1 } }, signal)
    expect(unknownWire.ok).toBe(false)
    if (!unknownWire.ok) expect(unknownWire.error.message).toContain('args fields do not match the descriptor')
  })

  it('invokes directly through ctx.typertGateway (same strict descriptor path)', async () => {
    const { ctx } = await composeGatewayHarness()
    const result = await ctx.typertGateway.invoke({ namespace: 'fallbacks', method: 'get', args: {} })
    expect(result).toMatchObject({ config: { enabled: false, cooldownMs: 120_000 } })
  })

  it('rejects a business-invalid patch at the wire: ok:false + unknown config key', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const rejected = await connection.handler!('fallbacks/set', { args: { patch: { bogus: 1 } } }, signal)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.message).toContain('unknown config key "bogus"')
    }
    // The rejected write persisted nothing: the composed config is unchanged.
    const got = await connection.handler!('fallbacks/get', { args: {} }, signal)
    expect(got).toMatchObject({ ok: true, value: { config: { enabled: false } } })
  })
})

// ---------------------------------------------------------------------------
// ⑥ composed end-to-end: real plugin apply wires the gateway
// ---------------------------------------------------------------------------

describe('composed plugin (apply wires the gateway)', () => {
  it('typertGateway dispatches get/set/reset against the live composed config', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    // Pin the entry to `presets: 'none'` (fallbacks-preset-roles T3): the
    // bundled preset self-declaration would otherwise materialize 7 preset
    // rows into the composed config and break every byte-identical entry
    // comparison below — this test exercises gateway mechanics, not presets.
    const entry = entryConfig({ cooldownMs: 120_000, presets: 'none' })
    apply(ctx, entry)
    await vi.waitFor(() => {
      expect(ctx.reflect.props['fallbacks']).toEqual({ type: 'service' })
    })
    await waitRegistered(ctx)

    const before = await ctx.typertGateway.invoke({ namespace: 'fallbacks', method: 'get', args: {} })
    expect(invokeConfig(before)).toEqual(entry)

    // The set child may activate a tick after the namespace registers; the
    // waitFor retries the transient settings-unavailable failure.
    await vi.waitFor(async () => {
      const result = await ctx.typertGateway.invoke({
        namespace: 'fallbacks',
        method: 'set',
        args: { patch: { enabled: true, rootChain: [OFFICIAL_V4_FLASH] } },
      })
      expect(invokeConfig(result).enabled).toBe(true)
      expect(invokeConfig(result).rootChain).toEqual([OFFICIAL_V4_FLASH])
    })

    const after = await ctx.typertGateway.invoke({ namespace: 'fallbacks', method: 'get', args: {} })
    expect(invokeConfig(after)).toEqual({ ...entry, enabled: true, rootChain: [OFFICIAL_V4_FLASH] })
    // describe shows the user layer written through the gateway.
    const descriptor = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ enabled: true, rootChain: [OFFICIAL_V4_FLASH] })

    // reset through the gateway returns the composition base (entry).
    const reset = await ctx.typertGateway.invoke({ namespace: 'fallbacks', method: 'reset', args: {} })
    expect(invokeConfig(reset)).toEqual(entry)
    const afterReset = ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)!
    expect(afterReset.user).toEqual({})
  })
})
