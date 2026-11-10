/**
 * The `fallbacks` settings namespace: config types + defaults (the
 * schemastery `Config` schema lives in `./schema.ts`, host-only — this
 * module must stay free of `@deepseek-ai/*` value imports so the client
 * bundle never reaches schemastery).
 *
 * Named virtual chains (config v2, plan named-virtual-chains): N named
 * chains each selectable as `FallbacksChain/<chain id>`, carrying their own
 * `entries` (默认降级链 + 链尾) and `timeSlots`. Declared roles keep identity
 * (`id`/`persona`/`prompt?`/`permissions?`) plus an OPTIONAL `chain`
 * POINTER — a manually specified chain id (「指定降级链」), never an auto
 * mode: absent/empty = NOT SPECIFIED, the plugin does not intervene and the
 * child inherits the delegating agent's route. The v1 two-block model
 * (`rootChain` + per-role inline chains + `roles.rules`) is deleted; the
 * runtime consumes the v2 shape directly and flags surviving v1 keys at
 * startup via `detectLegacyKeys` (warn-only migration — no auto-write).
 *
 * Spec §1 is authoritative for field names and default values — notably
 * `triggerCodes` defaults to dsh's stable failure codes `['AUTH', 'QUOTA',
 * 'RATE_LIMIT']`. An unconfigured install (empty `chains`) is a no-op
 * pass-through exactly like an uninstalled plugin — there is NO config-level
 * `enabled` switch: the Plugins-page row toggle is the master switch and the
 * runtime gates re-key to `isFallbackActive` (`chains.length > 0`). Nothing
 * pre-creates a default chain: empty `chains` is the ONLY first-run state.
 *
 * This module is pure logic: it must not import any `@deepseek-ai/*` package
 * (types included) — `FallbacksConfig` is the plugin's own type.
 *
 * @module dsh-llm-fallbacks/config
 */

import { parseSelector } from './selectors.ts'
import { PRESETS, isAllDayConforming, officialTailIdsText } from './time-slots.ts'
import type { SlotRowConfig } from './time-slots.ts'
import { ESCALATION_CAP_MS } from './recovery.ts'

/** How an expired cooldown recovers the route (plan fallbacks-half-open-recovery Task 1). */
export type RecoveryPolicy = 'timer' | 'half-open'
/** How a cooled-down model comes back (spec §4). */
export type RevertPolicy = 'cooldown-expiry' | 'never'

/** Chain id format (v2): case-sensitive, uppercase allowed so the migrated
 * default id is exactly `Auto`. Deliberately NOT {@link ROLE_ID_PATTERN},
 * which keeps governing role ids. */
export const CHAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/

/**
 * One named virtual chain (v2). `id` doubles as the picker model id —
 * renaming it would orphan every saved selection, so only `label` is
 * editable in the UI. The LAST `entries` element is the 链尾: exactly one
 * official model. The FIRST matching `timeSlots` row REPLACES `entries`.
 */
export interface NamedChain {
  id: string
  /** Settings tab title + picker display prefix (display-only). */
  label: string
  /** 默认降级链 + 链尾. */
  entries: string[]
  /** 分时 rows scoped to this chain; first match replaces {@link entries}. */
  timeSlots?: SlotRowConfig[]
}

/**
 * A declared role entity (v2): identity + an optional chain POINTER.
 *
 * `prompt` / `permissions` are schema-reserved for the next iteration
 * — no consumer this round, and writing them does NOT change this
 * round's degradation behavior.
 */
export interface FallbacksRole {
  id: string
  /** Personality hint (人格提示) — free text, never validated. */
  persona: string
  /** Reserved for next iteration — no consumer this round. */
  prompt?: string
  /** Reserved for next iteration — no consumer this round. */
  permissions?: { allow?: string[]; deny?: string[] }
  /**
   * Manually specified named chain id for children dispatched under this
   * role (「指定降级链」) — a POINTER into `chains[]`, never a chain
   * definition. Absent or empty ⇒ NOT SPECIFIED: the plugin does not
   * intervene and the child inherits the delegating agent's route. The
   * plugin never picks a chain on its own.
   */
  chain?: string
}

/** Role grouping (v2): declared entities only — `rules` is deleted. */
export interface FallbacksRoles {
  list: FallbacksRole[]
}

/**
 * One declared role as the SCHEMA may compose it: identical to
 * {@link FallbacksRole} except that a v1 profile still carries the ARRAY form
 * of `chain`. The schema must accept it (composition happens in cordis BEFORE
 * `apply()`, so a rejection there kills the fiber and no migration can run);
 * {@link migrateLegacyConfig} narrows it to the string pointer.
 */
export interface FallbacksRoleSource extends Omit<FallbacksRole, 'chain'> {
  chain?: string | string[]
}

/**
 * The composed settings shape produced by the schemastery `Config` — the input
 * of {@link migrateLegacyConfig}, not the shape the runtime consumes.
 */
export interface FallbacksConfigSource extends Omit<FallbacksConfig, 'roles'> {
  roles: { list: FallbacksRoleSource[] }
}

/**
 * The full `fallbacks` settings shape (named virtual chains, verbatim
 * field names).
 */
export interface FallbacksConfig {
  triggerCodes: string[]
  chains: NamedChain[]
  roles: FallbacksRoles
  cooldownMs: number
  revertPolicy: RevertPolicy
  maxSwitchesPerStep: number
  /**
   * Preset-role injection switch: `'bundled'` declares the 5 preset roles
   * (spec §9.2) as seed rows on apply; `'none'` disables declaration.
   * Optional on purpose — a required field would break library consumers
   * that construct `FallbacksConfig` literals. The value domain is guarded
   * by the schema (`Config` in `src/schema.ts`), NOT by
   * `validateFallbacksConfig`, and every resolved config carries a value
   * via the schema default.
   */
  presets?: 'bundled' | 'none'
  /**
   * Config-level timezone for slot matching (default `Asia/Shanghai`,
   * UTC+8). Not per-slot.
   */
  tz?: string
  /**
   * Cooldown-expiry recovery mode (plan fallbacks-half-open-recovery Task
   * 1): `'timer'` restores the preferred candidate when the cooldown
   * expires (today's behavior); `'half-open'` leaves the route half-open
   * for one logged probe instead. Optional on purpose, mirroring
   * `presets`. The value domain is guarded by the schema, NOT by
   * `validateFallbacksConfig`, and every resolved config carries a value
   * via the schema default.
   */
  recovery?: RecoveryPolicy
}

/**
 * Spec §1 defaults — `Config({})` must equal this (no-op install).
 * Empty `chains` is the ONLY first-run state: nothing pre-creates an
 * `Auto` chain and nothing seeds `entries` — the picker row appears only
 * after the user creates a chain in the card. The migrated/seeded default
 * chain (`{ id: 'Auto', label: '默认链', entries, timeSlots }`) exists only
 * in the migration table (docs) applied by hand — warn-only migration.
 */
export const defaultFallbacksConfig: FallbacksConfig = {
  triggerCodes: ['AUTH', 'QUOTA', 'RATE_LIMIT'],
  chains: [],
  roles: { list: [] },
  cooldownMs: 300_000,
  revertPolicy: 'cooldown-expiry',
  maxSwitchesPerStep: 8,
  presets: 'bundled',
  tz: 'Asia/Shanghai',
  recovery: 'timer',
}

/** Role id format (aligned with yet-another-subagent `isValidProfileId`). */
export const ROLE_ID_PATTERN = /^[a-z0-9-]{1,32}$/

/**
 * Reserved role id: FORBIDDEN in `roles.list[].id` (the validator's reserved
 * warn) and in seed declarations (`seeds.ts` reserved-id skip). `rules` that
 * could target it are deleted (v2), but the id itself stays reserved so a
 * declared role can never shadow the "no specific role" meaning.
 */
export const INHERIT_ROLE_ID = 'inherit'

/**
 * The no-op gate (AC-8): the plugin intervenes exactly when at least one
 * named chain is configured. Roles alone no longer activate (a role
 * without a chain is pure identity). An inactive config is a pass-through
 * exactly like an uninstalled plugin; the Plugins-page row toggle remains
 * the master switch (row disable = fiber destroy). A non-empty chain with
 * empty `entries` still registers the picker row (content presence) but
 * refuses to delegate (conformance gate in the walk).
 */
export function isFallbackActive(config: FallbacksConfig): boolean {
  return config.chains.length > 0
}

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
 * mutates). Per chain: id format (case-sensitive, {@link CHAIN_ID_PATTERN})
 * + cross-chain uniqueness, tail conformance (the LAST entry must be
 * exactly one official model — a non-conforming chain's slot rows and
 * delegate stay inert), selector legality per entry, and the slot-row
 * guards (unknown preset, duplicate preset per chain, preset rows carrying
 * their own windows). Per role (after the chain loop, so the declared id
 * set is complete): the existing id format/reserved/duplicate warns, and a
 * non-empty `chain` pointer naming no declared chain id earns ONE warn and
 * behaves as NOT SPECIFIED. Each violation emits one `llm-fallbacks: ...`
 * warn — the config stays usable (warn-not-crash semantics). `persona` and
 * `label` are free text and deliberately not validated.
 */
export function validateFallbacksConfig(config: FallbacksConfig, logger: FallbacksConfigLogger): void {
  const declaredChainIds = new Set<string>()
  for (const chain of config.chains) {
    if (!CHAIN_ID_PATTERN.test(chain.id)) {
      logger.warn(`llm-fallbacks: invalid chain id "${chain.id}" — must match /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/`)
    }
    if (declaredChainIds.has(chain.id)) {
      logger.warn(`llm-fallbacks: duplicate chain id "${chain.id}" — chain ids must be unique (case-sensitive)`)
    }
    declaredChainIds.add(chain.id)
    // Per-chain tail conformance: the LAST entry (链尾) must be exactly one
    // official model — otherwise that chain's slot rows and delegate stay
    // inert (PR #62 semantics, per chain).
    if (chain.entries.length > 0 && !isAllDayConforming(chain.entries)) {
      logger.warn(
        `llm-fallbacks: chain "${chain.id}" must end with exactly one official model (${officialTailIdsText()}) — its time-slot rows and the virtual picker delegate stay inert until the tail conforms`,
      )
    }
    for (const entry of chain.entries) {
      try {
        parseSelector(entry)
      } catch (error) {
        logger.warn(
          `llm-fallbacks: ignoring invalid chain "${chain.id}" entry "${entry}": ${(error as Error).message}`,
        )
      }
    }
    // Slot-row guards, moved inside the chain loop (per chain): at most ONE
    // row per preset id per chain, known preset ids only, and preset rows
    // must not carry their own windows/day masks. The schema keeps the row
    // shape permissive on purpose — malformed rows warn here, never fail
    // composition; the resolver skips them defensively at request time.
    if (Array.isArray(chain.timeSlots)) {
      const seenSlotPresets = new Set<string>()
      for (const row of chain.timeSlots) {
        if (row.kind !== 'preset') continue
        const preset = row.preset
        if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) {
          logger.warn(
            `llm-fallbacks: chain "${chain.id}" has an unknown time-slot preset ${JSON.stringify(preset)} — row ignored`,
          )
          continue
        }
        if (seenSlotPresets.has(preset)) {
          logger.warn(
            `llm-fallbacks: chain "${chain.id}" has a duplicate time-slot preset "${preset}" — only the first row takes effect`,
          )
          continue
        }
        seenSlotPresets.add(preset)
        if (row.start !== undefined || row.end !== undefined || (row.days !== undefined && row.days.length > 0)) {
          logger.warn(
            `llm-fallbacks: chain "${chain.id}" preset "${preset}" carries its own window/day fields — preset windows are fixed code constants; the row is ignored`,
          )
        }
      }
    }
  }
  const declaredIds = new Set<string>()
  for (const role of config.roles.list) {
    // Client-canonical trim alignment (qc2 S-3): the UI rebuilds ids with
    // `row.id.trim()` and validates the trimmed value, so the host
    // validator must too. Warn messages still name the raw stored id.
    const id = role.id.trim()
    if (!ROLE_ID_PATTERN.test(id)) {
      logger.warn(`llm-fallbacks: invalid role id "${role.id}" — must match /^[a-z0-9-]{1,32}$/`)
    }
    if (id === 'inherit') {
      logger.warn(`llm-fallbacks: role id "${role.id}" is reserved — "inherit" cannot be declared in roles.list`)
    }
    if (declaredIds.has(id)) {
      logger.warn(`llm-fallbacks: duplicate role id "${role.id}" — role ids must be unique`)
    }
    declaredIds.add(id)
    // A non-empty chain pointer naming no declared chain id: ONE warn, and
    // the pointer behaves as NOT SPECIFIED (the child inherits the
    // delegating agent's route). Warn-not-crash — no error reaches the
    // child. Runs after the chain loop so the declared id set is complete.
    if (role.chain !== undefined && role.chain !== '' && !declaredChainIds.has(role.chain)) {
      logger.warn(
        `llm-fallbacks: role "${role.id}" specifies unknown chain "${role.chain}" — the child inherits the delegating agent's route`,
      )
    }
  }
  // Review point 3 (PR #87): with `recovery: 'half-open'` and a cooldown at
  // or above the 1-hour escalation cap, escalation is silently inert. Same
  // class as the other inert-configuration warns: one startup warn.
  if ((config.recovery ?? 'timer') === 'half-open' && config.cooldownMs >= ESCALATION_CAP_MS) {
    logger.warn(
      `llm-fallbacks: recovery "half-open" escalation is inert — cooldownMs (${config.cooldownMs} ms) is at or above the 1-hour escalation cap (${ESCALATION_CAP_MS} ms), so every suppression stays flat at cooldownMs`,
    )
  }
}

/**
 * Detect legacy config leftovers in a config SOURCE — the composed object
 * `source()` returns, or a raw settings document. Two generations:
 *
 * - Older removals: `alwaysModeRetryCap`, `roleAutoMatch` (direction C),
 *   `roles.default`, and the renamed role-entity fields
 *   `roles.list[].label` / `roles.list[].description`.
 * - v1 two-block keys (named-virtual-chains): `rootChain`, top-level
 *   `timeSlots`, `roles.rules`, `roles.list[].fallback`, and the v1 ARRAY
 *   form of `roles.list[].chain` (an array where v2 declares a string —
 *   stripped rather than coerced).
 *
 * Returns descriptive key names; the gateway attaches them as
 * `get().legacyKeys` so the client can show a migration banner. Warn-only:
 * no legacy value is ever read or re-persisted.
 */
export function detectLegacyKeys(source: Record<string, unknown>): string[] {
  // One entry per KEY, in first-seen order: a per-row key (`roles.list[].chain`)
  // would otherwise repeat once per role and swamp the banner.
  const keys = new Set<string>()
  if (Object.hasOwn(source, 'alwaysModeRetryCap')) keys.add('alwaysModeRetryCap')
  if (Object.hasOwn(source, 'roleAutoMatch')) keys.add('roleAutoMatch')
  if (Object.hasOwn(source, 'rootChain')) keys.add('rootChain')
  if (Object.hasOwn(source, 'timeSlots')) keys.add('timeSlots')
  const roles = source.roles
  if (isRecordLike(roles)) {
    if (Object.hasOwn(roles, 'default')) keys.add('roles.default')
    if (Object.hasOwn(roles, 'rules')) keys.add('roles.rules')
    if (Array.isArray(roles.list)) {
      for (const item of roles.list) {
        if (!isRecordLike(item)) continue
        if (Object.hasOwn(item, 'label')) keys.add('roles.list[].label')
        if (Object.hasOwn(item, 'description')) keys.add('roles.list[].description')
        if (Object.hasOwn(item, 'fallback')) keys.add('roles.list[].fallback')
        if (Array.isArray(item.chain)) keys.add('roles.list[].chain')
      }
    }
  }
  return [...keys]
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The chain a v1 `rootChain` migrates into (plan fallbacks-v1-auto-migration):
 * the id is stable so an already-selected `FallbacksChain/Auto` route keeps
 * resolving, and the label is display-only.
 */
export const MIGRATED_CHAIN_ID = 'Auto'
/** Display label of {@link MIGRATED_CHAIN_ID}. */
export const MIGRATED_CHAIN_LABEL = '默认链'

/**
 * Upgrade a config SOURCE to the v2 named-chain shape — in memory, at every
 * read. Pure, total, idempotent: a v2 config comes back unchanged, a v1 one is
 * converted, and any malformed shape degrades to the defaults instead of
 * throwing (the banner keeps reporting the raw leftovers, so honesty survives
 * the coercion).
 *
 * Conversion rules (plan §Goal):
 * 1. v1 `rootChain` + top-level `timeSlots` become chain #0
 *    (`{ id: 'Auto', label: '默认链', entries, timeSlots }`), so the picker
 *    route the user already selected keeps working.
 * 2. `roles.list[]` survive as identity rows (`id` / `persona` / reserved
 *    `prompt` / `permissions`); a v1 ARRAY `chain` is dropped (NOT SPECIFIED —
 *    the card's 指定降级链 select takes over) and `fallback` is dropped;
 *    `roles.rules` / `roles.default` / `enabled` never reach the output.
 * 3. A config that already carries a non-empty `chains` array keeps it and only
 *    loses the v1 leftovers. An EMPTY `chains` alongside a v1 `rootChain` is a
 *    profile that never had v2 content, so it migrates (otherwise the user's
 *    chain would silently vanish).
 *
 * No file is rewritten here — the next explicit save persists the v2 shape.
 * @param source - the composed config (schema defaults → plugin row → user
 *   layer) or any raw document.
 * @returns a complete {@link FallbacksConfig}; never the input object itself.
 */
export function migrateLegacyConfig(source: unknown): FallbacksConfig {
  const raw = isRecordLike(source) ? source : {}
  const defaults = defaultFallbacksConfig
  return {
    triggerCodes: stringArrayOf(raw['triggerCodes']) ?? [...defaults.triggerCodes],
    chains: migrateChains(raw),
    roles: { list: migrateRoles(raw['roles']) },
    cooldownMs: finiteNumberOr(raw['cooldownMs'], defaults.cooldownMs),
    revertPolicy: raw['revertPolicy'] === 'never' ? 'never' : defaults.revertPolicy,
    maxSwitchesPerStep: finiteNumberOr(raw['maxSwitchesPerStep'], defaults.maxSwitchesPerStep),
    presets: raw['presets'] === 'none' ? 'none' : defaults.presets,
    tz: typeof raw['tz'] === 'string' && raw['tz'] !== '' ? raw['tz'] : defaults.tz,
    recovery: raw['recovery'] === 'half-open' ? 'half-open' : defaults.recovery,
  }
}

function migrateChains(raw: Record<string, unknown>): NamedChain[] {
  const declared = Array.isArray(raw['chains']) ? raw['chains'] : undefined
  if (declared !== undefined && declared.length > 0) {
    const chains: NamedChain[] = []
    for (const entry of declared) {
      const chain = normalizeChain(entry)
      if (chain !== undefined) chains.push(chain)
    }
    return chains
  }
  const rootChain = stringArrayOf(raw['rootChain'])
  const legacyRows = Array.isArray(raw['timeSlots'])
    ? raw['timeSlots'].filter(isRecordLike).map((row) => ({ ...row }) as unknown as SlotRowConfig)
    : []
  // No v1 chain to convert: nothing to build (an empty `chains` stays empty).
  if (rootChain === undefined || rootChain.length === 0) return []
  return [{
    id: MIGRATED_CHAIN_ID,
    label: MIGRATED_CHAIN_LABEL,
    entries: [...rootChain],
    timeSlots: legacyRows,
  }]
}

function normalizeChain(value: unknown): NamedChain | undefined {
  if (!isRecordLike(value)) return undefined
  const id = typeof value['id'] === 'string' ? value['id'] : undefined
  if (id === undefined) return undefined
  const timeSlots = Array.isArray(value['timeSlots'])
    ? value['timeSlots'].filter(isRecordLike).map((row) => ({ ...row }) as unknown as SlotRowConfig)
    : []
  return {
    id,
    label: typeof value['label'] === 'string' ? value['label'] : id,
    entries: stringArrayOf(value['entries']) ?? [],
    timeSlots,
  }
}

function migrateRoles(value: unknown): FallbacksRole[] {
  if (!isRecordLike(value)) return []
  const list = Array.isArray(value['list']) ? value['list'] : []
  const roles: FallbacksRole[] = []
  for (const row of list) {
    if (!isRecordLike(row)) continue
    const id = typeof row['id'] === 'string' ? row['id'] : undefined
    if (id === undefined) continue
    // Unknown members are PRESERVED (a foreign key on a role row is not this
    // plugin's to delete — the write path relies on it); only the v1 fields
    // below are removed.
    const role: Record<string, unknown> = { ...row, id, persona: typeof row['persona'] === 'string' ? row['persona'] : '' }
    for (const stale of ['fallback', 'label', 'description'] as const) delete role[stale]
    // v2 declares a string POINTER; a v1 ARRAY is dropped (NOT SPECIFIED — the
    // card's 指定降级链 select takes over).
    if (typeof row['chain'] !== 'string' || row['chain'] === '') delete role['chain']
    roles.push(role as unknown as FallbacksRole)
  }
  return roles
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
