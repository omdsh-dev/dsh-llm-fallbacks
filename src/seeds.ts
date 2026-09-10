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
 * 2. an in-memory per-apply seed registry keyed by PRODUCER LABEL
 *    (`bundled` | set name | `external`), each slice holding that
 *    producer's current id → `{ persona, set }` declarations. Declare =
 *    replacement PER PRODUCER: a declare replaces only its own slice, so
 *    the plugin's bundled presets stay `bundled` even when a companion
 *    merge-preserves them into its own batch (plan
 *    seeds-source-and-persona-width, Decisions #1).
 * `seeded` / `personaOverridden` / `source` are DERIVED at read time, never
 * stored — a config round-trip cannot orphan an override (AC-3), and
 * provenance rides the in-memory registry only, so it can never churn a
 * settings write.
 *
 * Resolution precedence (Decisions #2): `bundled` wins for any id the
 * plugin's own preset self-declare currently declares; otherwise the most
 * recent non-bundled producer declaring the id wins (its set name, or
 * `external` when unnamed); no live declaration ⇒ `user`. Unnamed producers
 * share the `external` slice (Decisions #3); `{ set }` is the remedy.
 *
 * Materialization (spec §9.2): append `{ id, persona }` (two keys only,
 * R4) / attach row untouched / at-default tracking / override preserved +
 * `'persona-source'` conflict / omitted id drops from the declaring
 * producer's slice while the row stays (R2). Tracking is driven by the
 * id's RESOLVED effective default — `prior` = resolved before the
 * declare, `incoming` = resolved after the candidate slice commit — so a
 * producer that is not the resolution winner for an id it declares never
 * rewrites the row (F-001). No delta → no settings write (idempotent,
 * AC-1). Compute → write → commit registry: a failed write throws and
 * leaves the registry unchanged (retry-safe).
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
  type FallbacksRoleRule,
  type FallbacksRoles,
} from './config.ts'

/** A seed declaration from a companion plugin (spec §9.1). */
export interface SeedDeclaration {
  id: string
  persona: string
}

/**
 * Per-row provenance label (spec §2). The fixed labels: `bundled` (the
 * plugin's own bundled preset self-declare), `external` (a companion
 * declare without a set name — or with an invalid one, degraded), `user`
 * (no live declaration). Any other value is a declared set name; the
 * reserved names can never be declared as a set, so the fixed labels are
 * unambiguous.
 */
export type SeedSource = 'bundled' | 'external' | 'user' | (string & {})

/**
 * Optional provenance for one `declare()` call (spec §2) — the PUBLIC
 * options face (a companion's registered set name). This is also the type
 * of the `FallbacksService.declareSeeds` second parameter: consumers can
 * never label a declare `bundled` (reserved).
 */
export interface SeedsDeclareOptions {
  /**
   * Registered set name — trimmed. Empty after trim, non-string, or a
   * reserved value (`bundled` / `user` / `external`) warns once and
   * degrades the batch to the unnamed `external` source; the seeds still
   * apply (a bad label must never drop roles).
   */
  set?: string
}

/**
 * The manager-level declare options — the public face plus the INTERNAL
 * bundled marker for the plugin's own preset self-declare. Module-internal
 * (never exported, never re-exported from the package root): only the
 * preset child call site passes `bundled`, and only a structurally-checked
 * object literal at that — the type itself is not nameable by consumers.
 */
interface SeedsInternalDeclareOptions extends SeedsDeclareOptions {
  /** INTERNAL — bundled preset self-declare provenance. Not a consumer option. */
  bundled?: true
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
  /** Where the row's seed state comes from (read-time derived, never persisted) — `user` iff not seeded. */
  source: SeedSource
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
  /**
   * Provenance label (spec §2) — additive and OPTIONAL on the wire: a
   * gateway predating the field (version skew) sends entries without it;
   * consumers treat a missing label as "no badge".
   */
  source?: SeedSource
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

/** Internal registry value (never persisted): the declared persona + its provenance label. */
interface SeedRegistryEntry {
  persona: string
  set: SeedSource
}

/**
 * One producer's current declaration slice (never persisted): the id →
 * entry map plus the monotonic declare sequence that makes "most recent
 * producer" decidable for resolution precedence (Decisions #2).
 */
interface SeedRegistrySlice {
  /** Monotonic declare sequence — the most recent non-bundled producer wins on id collisions. */
  seq: number
  /** The producer's current id → persona slice. */
  entries: Map<string, SeedRegistryEntry>
}

/**
 * In-memory per-apply seed manager (spec §9.2): declare / readback /
 * revert over the operator config through a `SeedsIo` seam. Created in
 * `apply()` (per-apply, no module-level global) with a structured logger;
 * warn messages carry the `llm-fallbacks: seeds:` prefix (spec §9.7).
 */
export class FallbacksSeedManager {
  /**
   * Per-producer declaration registry: producer label (`bundled` | set
   * name | `external`) → that producer's current slice. A declare replaces
   * only its own slice; an empty batch drops the slice.
   */
  private registry = new Map<string, SeedRegistrySlice>()
  /** Monotonic declare counter — "most recent producer" for resolution precedence. */
  private declareSeq = 0

  constructor(private readonly logger: FallbacksConfigLogger) {}

  /**
   * Declare seeds with replacement semantics PER PRODUCER — the batch is
   * the producer's FULL current declaration set; ids omitted from the
   * batch drop out of that producer's slice while their rows remain (R2).
   * Other producers' slices are untouched, so a companion merge-preserving
   * the bundled presets into its own batch never re-labels them (Decisions
   * #1).
   *
   * `options` labels the whole batch's provenance (spec §2), resolved once
   * per call: an invalid set name warns once and degrades to the unnamed
   * `external` case — the seeds still apply.
   *
   * Per-id validation AS DECLARED (spec §9.3): non-string / pattern miss /
   * reserved `inherit` / duplicate-in-batch → skip + warn; valid siblings
   * still apply (AC-5). Materializes per spec §9.2 against the id's
   * RESOLVED effective default before/after the candidate slice commit
   * (at-default tracking follows the resolution winner — a producer that
   * is not the winner for an id it declares never rewrites the row),
   * writes only when the computed `{ list, rules }` differs from the
   * current composed roles (idempotent, AC-1), and commits the slice only
   * after a successful write (compute → write → commit; retry-safe). An
   * empty batch drops the producer's slice.
   */
  async declare(
    seeds: readonly SeedDeclaration[],
    io: SeedsIo,
    options?: SeedsInternalDeclareOptions,
  ): Promise<SeedDeclareOutcome> {
    const outcome: SeedDeclareOutcome = { applied: [], skipped: [], conflicts: [] }
    const source = resolveSource(options, this.logger)
    const entries = new Map<string, SeedRegistryEntry>()
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
      if (entries.has(seed.id)) {
        outcome.skipped.push({ id: seed.id, reason: 'duplicate-in-batch' })
        this.warnSkip(seed.id, 'duplicate-in-batch')
        continue
      }
      entries.set(seed.id, { persona: seed.persona, set: source })
      outcome.applied.push(seed.id)
    }

    const config = io.read()
    // Containment (guide §10, qc2 S-1): the write paths tolerate the same
    // malformed/legacy `roles` shape the read paths guard against
    // (`roleRows` / `roleRules` degrade to empty) instead of throwing a
    // raw TypeError. Loud failure modes are unchanged — a rejected
    // settings write still throws (retry-safe, KD-G5).
    const currentList = roleRows(config)
    const currentRules = roleRules(config)
    // Candidate registry: this registry with the declaring slice replaced
    // (or deleted for an empty batch) — the state resolution would see
    // after this declare commits. Tracking is driven by the id's RESOLVED
    // effective default (F-001): `prior` = resolved BEFORE the declare,
    // `incoming` = resolved AFTER the candidate commit. A producer that is
    // not the resolution winner for an id it declares never rewrites the
    // row, so the row persona, badge, `seedPersona`, and revert target
    // stay mutually consistent.
    const candidate = new Map(this.registry)
    if (entries.size === 0) {
      candidate.delete(source)
    } else {
      candidate.set(source, { seq: this.declareSeq + 1, entries })
    }
    const prior = new Map<string, string>()
    const incoming = new Map<string, string>()
    for (const id of entries.keys()) {
      const before = this.resolveDeclared(id)?.persona
      const after = this.resolveDeclared(id, candidate)?.persona
      if (before !== undefined) prior.set(id, before)
      if (after !== undefined) incoming.set(id, after)
    }
    const newList = materialize(currentList, incoming, prior, outcome.conflicts)
    for (const conflict of outcome.conflicts) {
      this.logger.warn(
        `llm-fallbacks: seeds: persona-source conflict for seed id ${JSON.stringify(conflict.id)} — operator row persona kept (never overwritten)`,
      )
    }
    const computed: FallbacksRoles = { list: newList, rules: currentRules }
    // AC-1 no-delta check over the `{ list, rules }` members only (qc2
    // S-2): a composed `config.roles` may retain legacy keys
    // (`roles.default` etc.), which must not churn a settings write on
    // every declare for a transitional legacy user layer. Materialization
    // never touches `rules`, so the list is the only possible delta source.
    if (!deepEqual(newList, currentList)) {
      // A rejected write throws — the registry below is NOT committed
      // (retry-safe: the next declare re-computes from the fresh read).
      await io.writeRoles(computed)
    }
    // Commit: replace only this producer's slice (an empty batch drops it).
    if (entries.size === 0) {
      this.registry.delete(source)
    } else {
      this.registry.set(source, { seq: ++this.declareSeq, entries })
    }
    return outcome
  }

  /**
   * Resolve one id's live declaration across producer slices (spec §2,
   * Decisions #2): the bundled preset self-declare wins for any id it
   * currently declares; otherwise the most recent non-bundled producer
   * declaring the id wins (its set name, or `external` when unnamed); no
   * live declaration ⇒ `undefined` (the row reads `user`). Single place —
   * `effectiveRoles`, `wireStatus`, and `revert` can never disagree. The
   * optional `registry` argument resolves against a CANDIDATE registry
   * (the declaring slice already replaced) — the same precedence, used by
   * `declare` to compute the post-commit effective default for tracking.
   */
  private resolveDeclared(
    id: string,
    registry: ReadonlyMap<string, SeedRegistrySlice> = this.registry,
  ): { persona: string; source: SeedSource } | undefined {
    const bundled = registry.get('bundled')?.entries.get(id)
    if (bundled !== undefined) return { persona: bundled.persona, source: 'bundled' }
    let winner: { persona: string; source: SeedSource; seq: number } | undefined
    for (const [label, slice] of registry) {
      if (label === 'bundled') continue
      const entry = slice.entries.get(id)
      if (entry === undefined) continue
      if (winner === undefined || slice.seq > winner.seq) {
        winner = { persona: entry.persona, source: label, seq: slice.seq }
      }
    }
    if (winner === undefined) return undefined
    return { persona: winner.persona, source: winner.source }
  }

  /**
   * Readback (b) — sync, derived: every config row annotated with
   * `seeded` / `personaOverridden` / `seedPersona` (trimmed row-id
   * membership in the live declaration set; persona inequality) plus the
   * row's provenance `source` (spec §2): the winning producer's label per
   * `resolveDeclared`, or `user` when no live declaration covers the row.
   * Nothing override-shaped is stored, so a config round-trip cannot
   * orphan state.
   */
  effectiveRoles(io: SeedsIo): EffectiveRolesReadback {
    const roles: EffectiveRole[] = roleRows(io.read()).map((row) => {
      const declared = this.resolveDeclared(row.id.trim())
      const seeded = declared !== undefined
      const effective: EffectiveRole = {
        id: row.id,
        persona: row.persona,
        seeded,
        personaOverridden: seeded && row.persona !== declared.persona,
        source: seeded ? declared.source : 'user',
      }
      if (seeded) effective.seedPersona = declared.persona
      if (row.chain !== undefined) effective.chain = row.chain
      if (row.fallback !== undefined) effective.fallback = row.fallback
      return effective
    })
    return { roles }
  }

  /** Card badge state (spec §9.4): seeded rows, with the override flag and the provenance label. */
  wireStatus(io: SeedsIo): SeedsWireStatus[] {
    const status: SeedsWireStatus[] = []
    for (const row of roleRows(io.read())) {
      const declared = this.resolveDeclared(row.id.trim())
      if (declared === undefined) continue
      status.push({ id: row.id, overridden: row.persona !== declared.persona, source: declared.source })
    }
    return status
  }

  /**
   * Revert one id to the CURRENT declared seed default (AC-3) — resolved
   * through the same precedence as the readbacks, so a preserved bundled id
   * reverts to the bundled persona, never a companion's copy. Writes
   * persona only — the row is otherwise copied verbatim (R4). Ids with no
   * live declaration (`not-seeded`) or with a deleted row (`row-absent`)
   * return a non-reverted outcome without throwing; a failed settings
   * write propagates loudly (spec §9.1).
   */
  async revert(id: string, io: SeedsIo): Promise<SeedRevertOutcome> {
    const seedId = id.trim()
    const declared = this.resolveDeclared(seedId)
    if (declared === undefined) return { reverted: false, reason: 'not-seeded' }
    // Same containment guard as `declare` (qc2 S-1): a malformed/legacy
    // `roles` shape degrades to empty rows instead of throwing — the id
    // is then simply absent, and the business outcome stays a value.
    const config = io.read()
    const rows = roleRows(config)
    const rules = roleRules(config)
    const index = rows.findIndex((row) => row.id.trim() === seedId)
    if (index === -1) return { reverted: false, reason: 'row-absent' }
    if (rows[index].persona === declared.persona) return { reverted: true, persona: declared.persona }
    const nextList = rows.map((row, i) => (i === index ? { ...row, persona: declared.persona } : row))
    await io.writeRoles({ list: nextList, rules })
    return { reverted: true, persona: declared.persona }
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

/** Reserved provenance labels (spec §2) — no declare may claim them as a set name. */
const RESERVED_SET_NAMES: readonly string[] = ['bundled', 'user', 'external']

/**
 * Resolve one declare call's provenance label (spec §2): the internal
 * bundled marker wins; an absent `set` is the unnamed external case;
 * otherwise the name is trimmed and validated — empty after trim,
 * non-string, or reserved warns ONCE and degrades to `external` (the
 * seeds still apply — a bad label must never drop roles).
 */
function resolveSource(
  options: SeedsInternalDeclareOptions | undefined,
  logger: FallbacksConfigLogger,
): SeedSource {
  if (options?.bundled === true) return 'bundled'
  const raw = options?.set
  if (raw === undefined) return 'external'
  if (typeof raw === 'string' && raw.trim() !== '' && !RESERVED_SET_NAMES.includes(raw.trim())) return raw.trim()
  const shown = typeof raw === 'string' ? JSON.stringify(raw) : String(raw)
  const reserved = RESERVED_SET_NAMES.map((name) => JSON.stringify(name)).join(' / ')
  logger.warn(
    `llm-fallbacks: seeds: ignoring declare set name ${shown} — invalid (empty after trim, non-string, or a reserved label ${reserved}); provenance degrades to "external", the seeds still apply`,
  )
  return 'external'
}

/**
 * Materialize the row list for a declare (spec §9.2 table): existing rows
 * are copied verbatim or persona-tracked, then rows are appended for
 * declared ids with no trimmed-id match. `prior` is the id's RESOLVED
 * effective default BEFORE the declare and `incoming` the RESOLVED
 * effective default AFTER the candidate slice commit (F-001) — a row
 * tracks only when it sits at `prior` AND the effective default actually
 * changed, so a producer that is not the resolution winner for an id it
 * declares never rewrites the row. New rows append with the effective
 * persona.
 */
function materialize(
  rows: readonly FallbacksRole[],
  incoming: ReadonlyMap<string, string>,
  prior: ReadonlyMap<string, string>,
  conflicts: SeedConflict[],
): FallbacksRole[] {
  const next: FallbacksRole[] = []
  for (const row of rows) {
    const seedId = row.id.trim()
    const inc = incoming.get(seedId)
    if (inc === undefined) {
      // Id omitted from the batch — row untouched (R2).
      next.push(row)
      continue
    }
    const before = prior.get(seedId)
    if (before === undefined) {
      // No resolved default before the declare (post-restart/HMR or
      // re-declared after a drop): conservative row-untouched — a differing
      // persona is flagged as an operator override (spec §9.2).
      if (row.persona !== inc) conflicts.push({ id: seedId, kind: 'persona-source' })
      next.push(row)
      continue
    }
    if (row.persona === before && inc !== before) {
      // Row at the previous EFFECTIVE default and the effective default
      // actually changed → tracks the winner's update (not an operator
      // edit); the row is otherwise copied verbatim (R4).
      next.push({ ...row, persona: inc })
      continue
    }
    // Operator override, or no effective default change — preserved;
    // conflict iff it differs from the incoming effective default (equal →
    // override resolved, quiet).
    if (row.persona !== inc) conflicts.push({ id: seedId, kind: 'persona-source' })
    next.push(row)
  }
  for (const [id, persona] of incoming) {
    if (!rows.some((row) => row.id.trim() === id)) next.push({ id, persona })
  }
  return next
}

/**
 * The materialized role rows of a composed config, tolerating a malformed
 * `roles` shape (guide §10 containment): a legacy two-block-era source can
 * carry `roles.default` without `roles.list` (schemastery retains unknown
 * keys), and the non-strict settings layer can store anything — the seed
 * readbacks and write paths must never crash on it. Schema-resolved
 * sources always have an array `list`; this guard only fires on
 * malformed/legacy input.
 */
function roleRows(config: FallbacksConfig): FallbacksRole[] {
  const list = (config.roles as { list?: unknown } | undefined)?.list
  return Array.isArray(list) ? list : []
}

/**
 * The materialized rule list of a composed config — the `roleRows()` twin
 * for the `rules` member (guide §10 containment): the write paths must
 * tolerate the same malformed/legacy `roles` shape the read paths do.
 */
function roleRules(config: FallbacksConfig): FallbacksRoleRule[] {
  const rules = (config.roles as { rules?: unknown } | undefined)?.rules
  return Array.isArray(rules) ? rules : []
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
