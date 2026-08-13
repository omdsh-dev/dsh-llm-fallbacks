/**
 * T1 (plan llm-fallbacks-settings-gateway) — host-side `fallbacks` config
 * gateway: the `/api/fallbacks/get` + `/api/fallbacks/set` +
 * `/api/fallbacks/reset` Remote endpoints.
 *
 * Transport: the typertGateway `/api` interceptor is the single host-wide RPC
 * slot (a plugin must NOT `connection.rpc.intercept('/api')` again — it would
 * throw). Instead this service declares a typertGateway binding (via the
 * `TypertRemoteService` base) plus `@Remote` method markers; the gateway's SRC
 * discovery (`claimsEndpoint` — `ctx.reflect.props` + `remoteMethods`) claims
 * `/api/fallbacks/<method>`, and the payload contract is exactly one
 * plain-object `args` field whose keys are the method parameter names
 * (`get()` → `{ args: {} }`; `set(patch)` → `{ args: { patch } }`;
 * `reset()` → `{ args: {} }`).
 *
 * Data: `get` reads the `FallbacksSettingsBridge` source — the same live
 * composed config the runtime reads (schema defaults → plugin-row base →
 * settings user layer). There is NO hard-gate resolver (unlike advisor's
 * `resolveAdvisorConfig`): the fallbacks decision path runs at
 * `agent/request` time in `src/index.ts`, so the gateway returns the raw
 * composed config — `enabled` is a plain config field, not a gate output.
 * `set` validates the patch against the `Config` schema first (unknown-key
 * rejection unchanged — the settings service itself is non-strict and would
 * merge the unknown key through), then writes the USER layer in-process via
 * `ctx.settings.update` (no exposed-namespace gate on the in-process write —
 * the wire-level `exposedNamespaces()` check only guards the apiproxy path),
 * and returns the new composed value. `reset` (fallbacks-specific third
 * method — advisor has only get/set) clears the user layer via
 * `ctx.settings.replace(ns, {})`: `set` is merge-only and cannot express
 * "reset to composition defaults" (sending default VALUES as a patch would
 * pin stale defaults into the user layer).
 *
 * The settings service is OPTIONAL (no settings service → the bridge source
 * stays the entry, `get` still works; `set`/`reset` fail with a clear
 * error — KD-G5 fallback). The gateway captures the service through a
 * conditional `ctx.inject(['settings'], ...)` child (the same activation
 * pattern as `installSettingsSection`), because `ctx.settings` is only
 * resolvable from a fiber that declares it.
 *
 * The returned config is normalized to the typertGateway JSON wire boundary:
 * only schema-declared keys cross the wire, and absent values are OMITTED,
 * never present-as-undefined (the gateway's result validation rejects
 * undefined values).
 *
 * @module dsh-llm-fallbacks/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { Config } from './config'
import type { FallbacksConfig } from './config'

/** The `fallbacks` settings namespace (registered when a settings service exists). */
export const FALLBACKS_SETTINGS_NAMESPACE = settingsNamespace('fallbacks')

/**
 * The live configuration source for the gateway (guide §7 — the same bridge
 * shape the runtime reads through). `source()` returns the live composed
 * config (schema defaults → plugin-row base → settings user layer). The
 * gateway reads it LIVE on every call, so no change notification is needed
 * (the bridge stays minimal: source + the settings write channel; the dead
 * `onChange` fan-out was removed in the QC fix wave — nothing subscribed).
 */
export interface FallbacksSettingsBridge {
  source(): FallbacksConfig
}

/** Patch shape accepted by `fallbacks.set` — any subset of the config keys. */
export type FallbacksConfigPatch = Partial<FallbacksConfig>

/**
 * Complete configuration key lookup for strict unknown-key rejection. The
 * schemastery object resolver merges unknown keys by default, so the gateway
 * rejects them explicitly — same strictness as advisor and the Loader.
 */
const CONFIG_KEYS: Record<string, true> = {
  enabled: true,
  triggerCodes: true,
  chains: true,
  roles: true,
  cooldownMs: true,
  revertPolicy: true,
  maxSwitchesPerStep: true,
  alwaysModeRetryCap: true,
}

/**
 * The host-side `fallbacks` config gateway (`/api/fallbacks/get` +
 * `/api/fallbacks/set` + `/api/fallbacks/reset`). Registered as the cordis
 * service key `'fallbacks'` (namespace defaults to the service key), so the
 * typertGateway SRC discovery claims the `fallbacks/<method>` endpoints.
 */
export class FallbacksConfigGateway extends TypertRemoteService {
  private readonly bridge: FallbacksSettingsBridge
  /** The live settings service once the optional inject child activates. */
  private settings: SettingsProvider | undefined

  /**
   * @param ctx - owning context (the plugin fiber's ctx inside `apply`).
   * @param bridge - the same `FallbacksSettingsBridge` the runtime reads, so
   *   get/set/reset always operate on the live composed config.
   */
  constructor(ctx: Context, bridge: FallbacksSettingsBridge) {
    super(ctx, 'fallbacks')
    this.bridge = bridge
    // The settings service is optional (no settings → entry fallback). The
    // inject child activates only when a settings service is composed,
    // mirroring installSettingsSection's conditional child; the returned
    // disposer mirrors its detach path — when the settings service goes away,
    // the write channel is gone with it, and `set`/`reset` must fail cleanly
    // (KD-G5) instead of holding a stale service reference.
    ctx.inject(['settings'], (sctx) => {
      this.settings = sctx.settings
      return () => {
        this.settings = undefined
      }
    })
  }

  /**
   * Read the current composed config (schema defaults → entry base → settings
   * user layer). No hard-gate resolver (ADR-2): the raw composed config is
   * the wire value — `enabled` is a plain field, not a gate output.
   * @returns the wire-normalized composed config.
   */
  @Remote('get')
  get(): { config: FallbacksConfig } {
    return { config: this.readConfig() }
  }

  /**
   * Validate a config patch and write it to the settings USER layer (live —
   * the runtime re-reads the same bridge source; no restart needed).
   * @param patch - any subset of the config keys; unknown keys are rejected
   *   by the `Config` schema before anything is written.
   * @returns the NEW composed config after the write.
   * @throws when the patch fails `Config` validation, or when no settings
   *   service is composed (KD-G5: the write channel is unavailable).
   */
  @Remote('set')
  async set(patch: FallbacksConfigPatch): Promise<{ config: FallbacksConfig }> {
    // Unknown-key rejection + type validation. The settings service schema is
    // non-strict (unknown keys merge through), so the explicit reject happens
    // here, before the write — same strictness as the Loader.
    validateConfigPatch(patch)
    // S2: an empty patch is a no-op — return the current composed value
    // without a pointless settings round-trip.
    if (Object.keys(patch).length === 0) return { config: this.readConfig() }
    const settings = this.settings
    if (settings === undefined) {
      throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
    }
    // Wire normalization: JSON cannot carry undefined, so a null-valued key
    // is a third-party client's way of saying "absent". Drop null values
    // before the write (an all-null patch is a no-op, like the empty patch).
    const normalized = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
    )
    if (Object.keys(normalized).length === 0) return { config: this.readConfig() }
    await settings.update(FALLBACKS_SETTINGS_NAMESPACE, normalized)
    return { config: this.readConfig() }
  }

  /**
   * Clear the fallbacks settings USER layer so the composition defaults
   * reapply (`settings.replace(ns, {})` — the in-process removal path a
   * merge-only `set` cannot express).
   * @returns the new composed config (composition defaults).
   * @throws when no settings service is composed (KD-G5: the write channel
   *   is unavailable).
   */
  @Remote('reset')
  async reset(): Promise<{ config: FallbacksConfig }> {
    const settings = this.settings
    if (settings === undefined) {
      throw new Error('fallbacks: settings service is unavailable — configuration cannot be written')
    }
    await settings.replace(FALLBACKS_SETTINGS_NAMESPACE, {})
    return { config: this.readConfig() }
  }

  /**
   * Read the live composed config and normalize it to the typertGateway JSON
   * wire boundary. Containment (guide §10): a malformed stored user layer
   * that the non-strict settings schema let through (e.g. an unknown key)
   * must never fail the RPC — only schema-declared keys cross the wire, and
   * absent values are omitted, never present-as-undefined (the result
   * validator rejects undefined values).
   */
  private readConfig(): FallbacksConfig {
    const source = this.bridge.source()
    const wire: Record<string, unknown> = {}
    for (const key of Object.keys(CONFIG_KEYS)) {
      const value = (source as unknown as Record<string, unknown>)[key]
      if (value !== undefined) wire[key] = value
    }
    return wire as unknown as FallbacksConfig
  }
}

/**
 * Reject a patch the `Config` schema cannot express: non-object input, unknown
 * top-level keys (schemastery merges them silently — the settings service
 * would accept them), and schema type violations.
 */
function validateConfigPatch(patch: unknown): void {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('dsh-llm-fallbacks: configuration patch must be a plain object')
  }
  for (const key of Object.keys(patch)) {
    // Own-key membership, never `in` — `in` walks the prototype chain, so a
    // patch with an own `__proto__`/`constructor`/`toString` key would pass
    // the guard (F-001, qc wave): an own `__proto__` key in particular can
    // corrupt the settings merge and wipe the user layer. Same strictness as
    // advisor's `CONFIG_KEYS.has(key)` on a Set.
    if (!Object.hasOwn(CONFIG_KEYS, key)) {
      throw new Error(`dsh-llm-fallbacks: unknown config key "${key}"`)
    }
  }
  // Type/bounds validation (schemastery fills defaults for absent keys; null
  // is treated as missing by defaulted fields, so it validates and is dropped
  // by the caller's wire normalization).
  Config(patch as unknown as FallbacksConfig)
}
