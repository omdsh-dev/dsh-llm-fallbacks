/**
 * The `fallbacks` settings namespace: plugin config schema + defaults.
 *
 * Two-block config model (plan fallbacks-role-config-model): block 1
 * `rootChain` — the root agent's single fallback chain (empty = no
 * degradation) — plus block 2 declared role entities: `roles.list`
 * (id/label/description/prompt?/permissions?/chain?/fallback) and
 * `roles.rules` enum references into the declared ids (or the built-in
 * `'inherit'` role). The legacy `chains` / `roles.default` keys are gone
 * from the schema and type (zero residual, migration table excepted); the
 * runtime consumes the new shape directly and flags surviving legacy keys
 * at startup via `detectLegacyKeys` (see `src/index.ts` apply()).
 *
 * Spec §4 is authoritative for field names and default values — notably
 * `triggerCodes` defaults to dsh's stable failure codes `['AUTH', 'QUOTA',
 * 'RATE_LIMIT']` (there is no `QUOTA_EXCEEDED` code in dsh), and an
 * unconfigured install (`enabled: false`, empty `rootChain`, empty roles)
 * is a no-op pass-through exactly like an uninstalled plugin (AC-8).
 *
 * This module is pure logic: it must not import any `@deepseek-ai/*` package
 * (types included) — `FallbacksConfig` is the plugin's own type. Task 3
 * registers this schema with `installSettingsSection` under the `fallbacks`
 * settings namespace.
 *
 * @module dsh-llm-fallbacks/config
 */

import z from '@deepseek-ai/schemastery'
import { parseSelector } from './selectors.ts'

/** How a cooled-down model comes back (spec §4). */
export type RevertPolicy = 'cooldown-expiry' | 'never'

/** A single role rule: match on origin/provider/model patterns (spec §3). */
export interface FallbacksRoleRule {
  origin?: 'root' | 'subagent'
  provider?: string
  model?: string
  role: string
}

/**
 * Chain-append strategy of a declared role entity: `inherit-root` (the
 * default) runs the role's own chain and then appends `rootChain`;
 * `none` uses only the role's own chain.
 */
export type FallbackStrategy = 'inherit-root' | 'none'

/**
 * A declared role entity (plan fallbacks-role-config-model Task 1).
 *
 * `prompt` / `permissions` are schema-reserved for the next iteration
 * (fallbacks-explicit-role-tool) — no consumer this round, and writing them
 * does NOT change this round's degradation behavior.
 */
export interface FallbacksRole {
  id: string
  label: string
  description: string
  /** Reserved for next iteration — no consumer this round. */
  prompt?: string
  /** Reserved for next iteration — no consumer this round. */
  permissions?: { allow?: string[]; deny?: string[] }
  chain?: string[]
  fallback?: FallbackStrategy
}

/** Role grouping for fallback chains: declared entities + enum references. */
export interface FallbacksRoles {
  list: FallbacksRole[]
  rules: FallbacksRoleRule[]
}

/**
 * The full `fallbacks` settings shape (two-block config model, verbatim
 * field names).
 */
export interface FallbacksConfig {
  enabled: boolean
  triggerCodes: string[]
  rootChain: string[]
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
 * unconfigured install (`enabled: false`, empty rootChain, empty roles)
 * behaves exactly like an uninstalled plugin (AC-3 / no-op invariant).
 */
export const defaultFallbacksConfig: FallbacksConfig = {
  enabled: false,
  triggerCodes: ['AUTH', 'QUOTA', 'RATE_LIMIT'],
  rootChain: [],
  roles: { list: [], rules: [] },
  cooldownMs: 300_000,
  revertPolicy: 'cooldown-expiry',
  maxSwitchesPerStep: 8,
  alwaysModeRetryCap: 5,
}

/**
 * Reserved role id: legal as a rule target (`roles.rules[].role`) and as
 * the no-rule-match fallback, but FORBIDDEN in `roles.list[].id`.
 */
export const INHERIT_ROLE_ID = 'inherit'

/** Role id format (aligned with yet-another-subagent `isValidProfileId`). */
export const ROLE_ID_PATTERN = /^[a-z0-9-]{1,32}$/

/**
 * Minimal logger surface {@link validateFallbacksConfig} warns through —
 * keeps this module free of `@deepseek-ai/*` imports (a cordis Logger is
 * structurally compatible).
 */
export interface FallbacksConfigLogger {
  warn(message: string): void
}

/**
 * Validate a fallbacks config (pure, warn-only — never throws, never
 * mutates): role id format/uniqueness/reserved word, rule role references
 * (declared ids + the built-in `'inherit'`), the `fallback` enum,
 * `rootChain`/role-chain selector legality, and the role model-config
 * requirement (a declared role with a missing/empty chain warns — a role
 * without a model config is meaningless, plan fallbacks-feedback-round
 * T2). `label`/`description` are free text and are deliberately not
 * validated. Each violation emits one `llm-fallbacks: ...` warn and "does
 * not take effect" — the config stays usable (spec §4 / AC-4
 * warn-not-crash semantics).
 */
export function validateFallbacksConfig(config: FallbacksConfig, logger: FallbacksConfigLogger): void {
  const declaredIds = new Set<string>()
  for (const role of config.roles.list) {
    // Client-canonical trim alignment (qc2 S-3): the UI rebuilds ids with
    // `row.id.trim()` (rowsToRoles) and validates the trimmed value, so the
    // host validator must too — a padded id in YAML resolves exactly like
    // the UI's canonical form (format/reserved/duplicate checks + the
    // declared-id set), never as a raw-string mismatch that would produce a
    // duplicate/undeclared warn against a trimmed sibling. Warn messages
    // still name the raw stored id so the user can locate it in the file.
    const id = role.id.trim()
    if (!ROLE_ID_PATTERN.test(id)) {
      logger.warn(`llm-fallbacks: invalid role id "${role.id}" — must match /^[a-z0-9-]{1,32}$/`)
    }
    if (id === INHERIT_ROLE_ID) {
      logger.warn(`llm-fallbacks: role id "${role.id}" is reserved — "inherit" cannot be declared in roles.list`)
    }
    if (declaredIds.has(id)) {
      logger.warn(`llm-fallbacks: duplicate role id "${role.id}" — role ids must be unique`)
    }
    declaredIds.add(id)
    for (const entry of role.chain ?? []) {
      try {
        parseSelector(entry)
      } catch (error) {
        logger.warn(
          `llm-fallbacks: ignoring invalid chain entry "${entry}" in role "${role.id}": ${(error as Error).message}`,
        )
      }
    }
    // A declared role with no model config is meaningless: the settings
    // card blocks saving one, and hand-written YAML gets this startup warn
    // (warn-only — never throws; the runtime still falls back to
    // rootChain defensively, plan fallbacks-feedback-round T2).
    if ((role.chain ?? []).length === 0) {
      logger.warn(
        `llm-fallbacks: role "${role.id}" has no model config — declare at least one chain entry, or use the built-in "inherit" rule target instead`,
      )
    }
    if (role.fallback !== undefined && role.fallback !== 'inherit-root' && role.fallback !== 'none') {
      logger.warn(
        `llm-fallbacks: role "${role.id}" has invalid fallback "${String(role.fallback)}" — expected "inherit-root" or "none"`,
      )
    }
  }
  for (const entry of config.rootChain) {
    try {
      parseSelector(entry)
    } catch (error) {
      logger.warn(`llm-fallbacks: ignoring invalid rootChain entry "${entry}": ${(error as Error).message}`)
    }
  }
  const validTargets = new Set([...declaredIds, INHERIT_ROLE_ID])
  for (const rule of config.roles.rules) {
    // Same canonical trim as the declared side (rowsToRules trims rule
    // roles on the client) — a padded reference resolves against a padded
    // declaration exactly as the UI would.
    if (!validTargets.has(rule.role.trim())) {
      logger.warn(
        `llm-fallbacks: rule references undeclared role "${rule.role}" — expected one of roles.list ids or "inherit"`,
      )
    }
  }
}

/**
 * Detect legacy (two-block-era) leftovers in a config SOURCE — the composed
 * object `source()` returns, or a raw settings document. Recognizes the
 * removed `chains` key, the removed `roles.default` field, and
 * `roles.rules[].role` values that reference no declared `roles.list` id
 * and are not the built-in `'inherit'`. Returns descriptive key/role names;
 * the gateway attaches them as `get().legacyKeys` so the client can show a
 * migration banner (spec §9 — the source is read directly because
 * schemastery retains unknown keys, verified plan Task 1 Step 1).
 */
export function detectLegacyKeys(source: Record<string, unknown>): string[] {
  const keys: string[] = []
  if (Object.hasOwn(source, 'chains')) keys.push('chains')
  const roles = source.roles
  if (isRecordLike(roles)) {
    if (Object.hasOwn(roles, 'default')) keys.push('roles.default')
    const declared = new Set<string>()
    if (Array.isArray(roles.list)) {
      for (const item of roles.list) {
        if (isRecordLike(item) && typeof item.id === 'string') declared.add(item.id)
      }
    }
    if (Array.isArray(roles.rules)) {
      for (const rule of roles.rules) {
        if (
          isRecordLike(rule)
          && typeof rule.role === 'string'
          && rule.role !== INHERIT_ROLE_ID
          && !declared.has(rule.role)
        ) {
          keys.push(`roles.rules[].role: ${rule.role}`)
        }
      }
    }
  }
  return keys
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Plugin Config schema (schemastery), mirroring {@link FallbacksConfig}.
 * Object fields are optional by default in schemastery; `.default()` fills
 * the spec defaults, `.required()` keeps mandatory fields. Unknown keys are
 * RETAINED by the composition (verified plan Task 1 Step 1) — that is what
 * lets `detectLegacyKeys` flag two-block-era leftovers (`chains` /
 * `roles.default`) on the composed object at startup (warn + gateway
 * `legacyKeys`, see `src/index.ts` apply()).
 */
export const Config = z.object({
  enabled: z.boolean().default(false),
  triggerCodes: z.array(z.string()).default(['AUTH', 'QUOTA', 'RATE_LIMIT']),
  rootChain: z.array(z.string()).default([]),
  roles: z
    .object({
      list: z
        .array(
          z.object({
            id: z.string().required(),
            label: z.string().default(''),
            description: z.string().default(''),
            prompt: z.string(),
            permissions: z.object({
              allow: z.array(z.string()),
              deny: z.array(z.string()),
            }),
            chain: z.array(z.string()),
            fallback: z.union([z.const('inherit-root'), z.const('none')]).default('inherit-root'),
          }),
        )
        .default([]),
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
    .default({ list: [], rules: [] }),
  cooldownMs: z.number().default(300_000),
  revertPolicy: z.union([z.const('cooldown-expiry'), z.const('never')]).default('cooldown-expiry'),
  maxSwitchesPerStep: z.number().default(8),
  alwaysModeRetryCap: z.number().default(5),
}) as unknown as z<FallbacksConfig>
