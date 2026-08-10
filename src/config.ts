/**
 * The `fallbacks` settings namespace: plugin config schema + defaults.
 *
 * Spec §4 is authoritative for field names and default values — notably
 * `triggerCodes` defaults to dsh's stable failure codes `['AUTH', 'QUOTA',
 * 'RATE_LIMIT']` (there is no `QUOTA_EXCEEDED` code in dsh), and `chains`
 * defaults to `{}` so an unconfigured install is a no-op (AC-8).
 *
 * This module is pure logic: it must not import any `@deepseek-ai/*` package
 * (types included) — `FallbacksConfig` is the plugin's own type. Task 3
 * registers this schema with `installSettingsSection` under the `fallbacks`
 * settings namespace.
 *
 * @module dsh-llm-fallbacks/config
 */

import z from 'schemastery'

/** How a cooled-down model comes back (spec §4). */
export type RevertPolicy = 'cooldown-expiry' | 'never'

/** A single role rule: match on origin/provider/model patterns (spec §3). */
export interface FallbacksRoleRule {
  origin?: 'root' | 'subagent'
  provider?: string
  model?: string
  role: string
}

/** Role grouping for fallback chains (spec §3). */
export interface FallbacksRoles {
  default: string
  rules: FallbacksRoleRule[]
}

/**
 * The full `fallbacks` settings shape (spec §4, verbatim field names).
 */
export interface FallbacksConfig {
  enabled: boolean
  triggerCodes: string[]
  chains: Record<string, string[]>
  roles: FallbacksRoles
  cooldownMs: number
  revertPolicy: RevertPolicy
  maxSwitchesPerStep: number
  alwaysModeRetryCap: number
}

/**
 * Spec §4 defaults — `Config({})` must equal this (no-op install).
 * `enabled` defaults to `false` (readme-settings spec §1.2): the feature
 * switch is off until the user turns it on in the settings page; an
 * unconfigured install (`enabled: false`, empty chains) behaves exactly like
 * an uninstalled plugin (AC-3).
 */
export const defaultFallbacksConfig: FallbacksConfig = {
  enabled: false,
  triggerCodes: ['AUTH', 'QUOTA', 'RATE_LIMIT'],
  chains: {},
  roles: { default: 'default', rules: [] },
  cooldownMs: 300_000,
  revertPolicy: 'cooldown-expiry',
  maxSwitchesPerStep: 8,
  alwaysModeRetryCap: 5,
}

/**
 * Plugin Config schema (schemastery), mirroring {@link FallbacksConfig}.
 * Object fields are optional by default in schemastery; `.default()` fills
 * the spec defaults, `.required()` keeps `rules[].role` mandatory.
 */
export const Config = z.object({
  enabled: z.boolean().default(false),
  triggerCodes: z.array(z.string()).default(['AUTH', 'QUOTA', 'RATE_LIMIT']),
  chains: z.dict(z.array(z.string())).default({}),
  roles: z
    .object({
      default: z.string().default('default'),
      rules: z
        .array(
          z.object({
            origin: z.union([z.const('root'), z.const('subagent')]),
            provider: z.string(),
            model: z.string(),
            role: z.string().required(),
          }),
        )
        .default([]),
    })
    .default({ default: 'default', rules: [] }),
  cooldownMs: z.number().default(300_000),
  revertPolicy: z.union([z.const('cooldown-expiry'), z.const('never')]).default('cooldown-expiry'),
  maxSwitchesPerStep: z.number().default(8),
  alwaysModeRetryCap: z.number().default(5),
}) as unknown as z<FallbacksConfig>
