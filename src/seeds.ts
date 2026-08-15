/**
 * Role-seeds domain module (plan fallbacks-role-seeds Task 1).
 *
 * A companion plugin declares `[{ id, persona }]` seeds; this module
 * validates each id AS DECLARED (`ROLE_ID_PATTERN`, reserved `inherit`),
 * merges the declarations into the role taxonomy with immutable-id /
 * override / revert semantics, and writes through a narrow IO seam
 * (`SeedsIo`). It is free of `@deepseek-ai/*` value imports (bundle
 * purity gate) — the client may type-only import from here.
 *
 * State model (spec §9.2) — two stores, strictly separated:
 * 1. operator config rows (persisted; a seeded role is a plain
 *    `roles.list` row `{ id, persona }`), and
 * 2. an in-memory per-apply seed registry (`Map<id, seedPersona>`),
 *    declare = replacement (the batch is the companion's full current set).
 * `seeded` / `personaOverridden` are DERIVED at read time, never stored —
 * a config round-trip cannot orphan an override (AC-3).
 *
 * Materialization (spec §9.2): append `{ id, persona }` (two keys only,
 * R4) / attach row untouched / at-default tracking / override preserved +
 * `'persona-source'` conflict / omitted id drops from the registry while
 * the row stays (R2). No delta → no settings write (idempotent, AC-1).
 * Compute → write → commit registry: a failed write throws and leaves the
 * registry unchanged (retry-safe).
 *
 * @module dsh-llm-fallbacks/seeds
 */

import {
  INHERIT_ROLE_ID,
  ROLE_ID_PATTERN,
  type FallbackStrategy,
  type FallbacksConfig,
  type FallbacksConfigLogger,
  type FallbacksRole,
  type FallbacksRoles,
} from './config.ts'

/** A seed declaration from a companion plugin (spec §9.1). */
export interface SeedDeclaration {
  id: string
  persona: string
}

/**
 * Why one declared id was skipped (spec §9.1). Per-id skip + warn, never
 * coercion — valid siblings in the same batch still apply (AC-5).
 */
export type SeedSkipReason =
  | 'invalid-id'          // fails ROLE_ID_PATTERN AS DECLARED (padded/uppercase/underscore/>32/empty/non-string)
  | 'reserved-id'         // === INHERIT_ROLE_ID
  | 'duplicate-in-batch'  // second occurrence of the same id in one batch — first wins

/**
 * A loud, non-destructive conflict (AC-2): never silently duplicated or
 * merged.
 */
export interface SeedConflict {
  id: string
  /** Existing row persona differs from the seed default — operator override retained, never overwritten. */
  kind: 'persona-source'
}

/** Structured result of one `declare()` (spec §9.1) — the readable status channel. */
export interface SeedDeclareOutcome {
  applied: string[]
  skipped: Array<{ id: string; reason: SeedSkipReason }>
  conflicts: SeedConflict[]
}

/** Effective role readback entry (spec §9.1) — `chain`/`fallback` passthrough (R4). */
export interface EffectiveRole {
  /** The config row id (raw declared form). */
  id: string
  /** Effective row persona. */
  persona: string
  /** Passthrough — never touched by seeds (R4). */
  chain?: string[]
  /** Passthrough — never touched by seeds (R4). */
  fallback?: FallbackStrategy
  /** Id is in the live declaration set (trimmed row-id match). */
  seeded: boolean
  /** `seeded` && row persona !== current seed default. */
  personaOverridden: boolean
  /** Present iff seeded. */
  seedPersona?: string
}

/** Service readback (b): effective taxonomy with seed annotations. */
export interface EffectiveRolesReadback {
  roles: EffectiveRole[]
}

export type SeedRevertFailReason = 'not-seeded' | 'row-absent' | 'settings-unavailable'

export interface SeedRevertOutcome {
  reverted: boolean
  /** Restored current seed default — present iff reverted. */
  persona?: string
  reason?: SeedRevertFailReason
}

/** Gateway wire entry (card badge state, spec §9.4). */
export interface SeedsWireStatus {
  id: string
  overridden: boolean
}

/**
 * The narrow IO seam this module writes through — keeps `src/seeds.ts`
 * free of `@deepseek-ai/*` value imports (bundle purity gate).
 */
export interface SeedsIo {
  /** Fresh composed config read (the same source the gateway reads). */
  read(): FallbacksConfig
  /** Persist a full `{ list, rules }` to the settings user layer. */
  writeRoles(roles: FallbacksRoles): Promise<void>
}

/**
 * In-memory per-apply seed manager (spec §9.2): declare / readback /
 * revert over the operator config through a `SeedsIo` seam. Created in
 * `apply()` (per-apply, no module-level global) with a structured logger;
 * warn messages carry the `llm-fallbacks: seeds:` prefix (spec §9.7).
 */
export class FallbacksSeedManager {
  private registry = new Map<string, string>()

  constructor(private readonly logger: FallbacksConfigLogger) {}

  /**
   * Declare seeds with replacement semantics — the batch is the
   * companion's FULL current declaration set; ids omitted from the batch
   * drop out of the registry while their rows remain (R2).
   *
   * Per-id validation AS DECLARED (spec §9.3): non-string / pattern miss /
   * reserved `inherit` / duplicate-in-batch → skip + warn; valid siblings
   * still apply (AC-5). Materializes per spec §9.2, writes only when the
   * computed `{ list, rules }` differs from the current composed roles
   * (idempotent, AC-1), and commits the registry only after a successful
   * write (compute → write → commit; retry-safe).
   */
  async declare(seeds: readonly SeedDeclaration[], io: SeedsIo): Promise<SeedDeclareOutcome> {
    const outcome: SeedDeclareOutcome = { applied: [], skipped: [], conflicts: [] }
    const registry = new Map<string, string>()
    for (const seed of seeds) {
      if (typeof seed.id !== 'string' || !ROLE_ID_PATTERN.test(seed.id)) {
        outcome.skipped.push({ id: String(seed.id), reason: 'invalid-id' })
        this.warnSkip(seed.id, 'invalid-id')
        continue
      }
      if (seed.id === INHERIT_ROLE_ID) {
        outcome.skipped.push({ id: seed.id, reason: 'reserved-id' })
        this.warnSkip(seed.id, 'reserved-id')
        continue
      }
      if (registry.has(seed.id)) {
        outcome.skipped.push({ id: seed.id, reason: 'duplicate-in-batch' })
        this.warnSkip(seed.id, 'duplicate-in-batch')
        continue
      }
      registry.set(seed.id, seed.persona)
      outcome.applied.push(seed.id)
    }

    const config = io.read()
    const newList = materialize(config.roles.list, registry, this.registry, outcome.conflicts)
    for (const conflict of outcome.conflicts) {
      this.logger.warn(
        `llm-fallbacks: seeds: persona-source conflict for seed id ${JSON.stringify(conflict.id)} — operator row persona kept (never overwritten)`,
      )
    }
    const computed: FallbacksRoles = { list: newList, rules: config.roles.rules }
    if (!deepEqual(computed, config.roles)) {
      // A rejected write throws — the registry below is NOT committed
      // (retry-safe: the next declare re-computes from the fresh read).
      await io.writeRoles(computed)
    }
    this.registry = registry
    return outcome
  }

  /**
   * Readback (b) — sync, derived: every config row annotated with
   * `seeded` / `personaOverridden` / `seedPersona` (trimmed row-id
   * membership in the live declaration set; persona inequality). Nothing
   * override-shaped is stored, so a config round-trip cannot orphan state.
   */
  effectiveRoles(io: SeedsIo): EffectiveRolesReadback {
    const { list } = io.read().roles
    const roles: EffectiveRole[] = list.map((row) => {
      const seedPersona = this.registry.get(row.id.trim())
      const seeded = seedPersona !== undefined
      const effective: EffectiveRole = {
        id: row.id,
        persona: row.persona,
        seeded,
        personaOverridden: seeded && row.persona !== seedPersona,
      }
      if (seeded) effective.seedPersona = seedPersona
      if (row.chain !== undefined) effective.chain = row.chain
      if (row.fallback !== undefined) effective.fallback = row.fallback
      return effective
    })
    return { roles }
  }

  /** Card badge state (spec §9.4): seeded rows, with the override flag. */
  wireStatus(io: SeedsIo): SeedsWireStatus[] {
    const { list } = io.read().roles
    const status: SeedsWireStatus[] = []
    for (const row of list) {
      const seedPersona = this.registry.get(row.id.trim())
      if (seedPersona === undefined) continue
      status.push({ id: row.id, overridden: row.persona !== seedPersona })
    }
    return status
  }

  /**
   * Revert one id to the CURRENT declared seed default (AC-3). Writes
   * persona only — the row is otherwise copied verbatim (R4). Ids absent
   * from the registry (`not-seeded`) or with a deleted row (`row-absent`)
   * return a non-reverted outcome without throwing; a failed settings
   * write propagates loudly (spec §9.1).
   */
  async revert(id: string, io: SeedsIo): Promise<SeedRevertOutcome> {
    const seedId = id.trim()
    const seedPersona = this.registry.get(seedId)
    if (seedPersona === undefined) return { reverted: false, reason: 'not-seeded' }
    const { list, rules } = io.read().roles
    const index = list.findIndex((row) => row.id.trim() === seedId)
    if (index === -1) return { reverted: false, reason: 'row-absent' }
    if (list[index].persona === seedPersona) return { reverted: true, persona: seedPersona }
    const nextList = list.map((row, i) => (i === index ? { ...row, persona: seedPersona } : row))
    await io.writeRoles({ list: nextList, rules })
    return { reverted: true, persona: seedPersona }
  }

  private warnSkip(id: unknown, reason: SeedSkipReason): void {
    const shown = typeof id === 'string' ? JSON.stringify(id) : String(id)
    if (reason === 'invalid-id') {
      this.logger.warn(
        `llm-fallbacks: seeds: skipping seed id ${shown} — invalid-id (must match ${String(ROLE_ID_PATTERN)} as declared)`,
      )
    } else if (reason === 'reserved-id') {
      this.logger.warn(
        `llm-fallbacks: seeds: skipping seed id ${shown} — reserved-id ("${INHERIT_ROLE_ID}" is not a legal seed target)`,
      )
    } else {
      this.logger.warn(`llm-fallbacks: seeds: skipping seed id ${shown} — duplicate-in-batch (first wins)`)
    }
  }
}

/**
 * Materialize the row list for a declare (spec §9.2 table): existing rows
 * are copied verbatim or persona-tracked, then rows are appended for
 * declared ids with no trimmed-id match.
 */
function materialize(
  rows: readonly FallbacksRole[],
  registry: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string>,
  conflicts: SeedConflict[],
): FallbacksRole[] {
  const next: FallbacksRole[] = []
  for (const row of rows) {
    const seedId = row.id.trim()
    const incoming = registry.get(seedId)
    if (incoming === undefined) {
      // Id omitted from the batch — row untouched (R2).
      next.push(row)
      continue
    }
    const prior = previous.get(seedId)
    if (prior === undefined) {
      // Row exists, no previous default (post-restart/HMR or re-declared
      // after a drop): conservative row-untouched — a differing persona is
      // flagged as an operator override (spec §9.2).
      if (row.persona !== incoming) conflicts.push({ id: seedId, kind: 'persona-source' })
      next.push(row)
      continue
    }
    if (row.persona === prior) {
      // Still at the previous default → tracks companion updates (not an
      // operator edit); the row is otherwise copied verbatim (R4).
      next.push({ ...row, persona: incoming })
      continue
    }
    // Operator override — preserved; conflict iff it differs from the
    // incoming default (equal → override resolved, quiet).
    if (row.persona !== incoming) conflicts.push({ id: seedId, kind: 'persona-source' })
    next.push(row)
  }
  for (const [id, persona] of registry) {
    if (!rows.some((row) => row.id.trim() === id)) next.push({ id, persona })
  }
  return next
}

/** Structural equality over the `{ list, rules }` shape (idempotency delta check). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const aa = a as unknown[]
    const bb = b as unknown[]
    return aa.length === bb.length && aa.every((item, index) => deepEqual(item, bb[index]))
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}
