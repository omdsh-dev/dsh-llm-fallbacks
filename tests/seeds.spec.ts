/**
 * Role-seeds domain module tests (plan fallbacks-role-seeds Task 1;
 * provenance labels added by seed-source-provenance Task 3):
 * per-id validation as declared (AC-5), the spec §9.2 materialization
 * table, replacement semantics, idempotent no-write (AC-1), revert →
 * current default (AC-3), removal keeps rows (AC-2), attach conflicts
 * never overwrite (AC-2/4), R4 chain/fallback/prompt/permissions
 * preservation on every write path, derived readback state, the
 * `llm-fallbacks: seeds:` warn prefix (spec §9.7), and the spec §2
 * per-row provenance `source` labels (named set / bundled marker /
 * external degrade / user / provenance-only no-write).
 *
 * The manager is exercised through a fake `SeedsIo` capturing writes —
 * no `@deepseek-ai/*` packages on this path (bundle purity gate).
 */

import { describe, expect, it, vi } from 'vitest'
import { FallbacksSeedManager, type SeedsDeclareOptions, type SeedsIo } from '../src/seeds.ts'
// Config types come from `./config.ts` — the SSOT (not re-exported by
// seeds.ts; `tsconfig` includes src only, so type-only imports here are
// erased at runtime, but importing from the SSOT keeps the hygiene).
import {
  INHERIT_ROLE_ID,
  defaultFallbacksConfig,
  type FallbacksConfig,
  type FallbacksRoles,
} from '../src/config.ts'

/** Warn-only logger double mirroring `tests/config.spec.ts` conventions. */
function warnLogger() {
  const warn = vi.fn()
  return { warn, logger: { warn } }
}

function messagesOf(logger: { warn: ReturnType<typeof vi.fn> }): string[] {
  return logger.warn.mock.calls.map((call) => String(call[0]))
}

/** Base config for the fake io (defaults + optional roles). */
function baseConfig(roles?: FallbacksRoles): FallbacksConfig {
  return { ...defaultFallbacksConfig, roles: roles ?? { list: [], rules: [] } }
}

interface FakeIo {
  io: SeedsIo
  /** Every `writeRoles` payload, in order. */
  writes: FallbacksRoles[]
  /** Simulate an operator config edit — not counted as a seed write. */
  edit(roles: FallbacksRoles): void
  failWrites(): void
  recoverWrites(): void
}

/** Fake io over an in-memory config; writes are captured and applied. */
function fakeIo(initial: FallbacksConfig): FakeIo {
  const writes: FallbacksRoles[] = []
  let config = initial
  let fail = false
  return {
    io: {
      read: () => config,
      writeRoles: async (roles) => {
        if (fail) throw new Error('settings write channel unavailable')
        writes.push(roles)
        config = { ...config, roles }
      },
    },
    writes,
    edit: (roles) => {
      config = { ...config, roles }
    },
    failWrites: () => {
      fail = true
    },
    recoverWrites: () => {
      fail = false
    },
  }
}

describe('FallbacksSeedManager — per-id validation (AC-5, spec §9.3)', () => {
  it('rejects illegal ids as declared (skip + warn, zero coercion); valid siblings still apply', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig())
    const longId = 'a'.repeat(33)
    const outcome = await manager.declare([
      { id: ' architect ', persona: 'p' },                     // padded
      { id: 'Architect', persona: 'p' },                       // uppercase
      { id: 'foo_bar', persona: 'p' },                         // underscore
      { id: longId, persona: 'p' },                            // >32 chars
      { id: '', persona: 'p' },                                // empty
      { id: 42 as unknown as string, persona: 'p' },           // non-string
      { id: INHERIT_ROLE_ID, persona: 'p' },                   // reserved
      { id: 'coder', persona: 'p' },                           // valid sibling
    ], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.skipped).toEqual([
      { id: ' architect ', reason: 'invalid-id' },
      { id: 'Architect', reason: 'invalid-id' },
      { id: 'foo_bar', reason: 'invalid-id' },
      { id: longId, reason: 'invalid-id' },
      { id: '', reason: 'invalid-id' },
      { id: '42', reason: 'invalid-id' },
      { id: INHERIT_ROLE_ID, reason: 'reserved-id' },
    ])
    expect(outcome.conflicts).toEqual([])
    // Only the valid sibling materializes — exactly one two-key row.
    expect(f.writes).toHaveLength(1)
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'p' }])
    // Every skip warns once, with the mandated prefix.
    const messages = messagesOf(logger)
    expect(messages).toHaveLength(7)
    for (const message of messages) {
      expect(message).toMatch(/^llm-fallbacks: seeds: skipping seed id /)
    }
  })

  it('skips duplicate ids within one batch — first wins (AC-2)', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig())
    const outcome = await manager.declare([
      { id: 'coder', persona: 'first' },
      { id: 'coder', persona: 'second' },
    ], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.skipped).toEqual([{ id: 'coder', reason: 'duplicate-in-batch' }])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'first' }])
    expect(messagesOf(logger)).toEqual([
      'llm-fallbacks: seeds: skipping seed id "coder" — duplicate-in-batch (first wins)',
    ])
  })

  it('a fully illegal batch skips everything and writes nothing', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    const outcome = await manager.declare([
      { id: 'Bad_Id', persona: 'p' },
      { id: '', persona: 'p' },
    ], f.io)

    expect(outcome.applied).toEqual([])
    expect(outcome.skipped).toHaveLength(2)
    expect(f.writes).toHaveLength(0)
    expect(f.io.read().roles.list).toEqual([])
  })
})

describe('FallbacksSeedManager — materialization (spec §9.2 table)', () => {
  it('appends a new row with exactly { id, persona } — other keys omitted (R4)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig({ list: [{ id: 'reviewer', persona: 'r', chain: ['a'] }], rules: [] }))
    const outcome = await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([])
    expect(f.writes).toHaveLength(1)
    const row = f.io.read().roles.list.find((r) => r.id === 'coder')!
    expect(row).toEqual({ id: 'coder', persona: 'Coder' })
    expect(Object.keys(row).sort()).toEqual(['id', 'persona'])
    // The pre-existing row is untouched.
    expect(f.io.read().roles.list.find((r) => r.id === 'reviewer'))
      .toEqual({ id: 'reviewer', persona: 'r', chain: ['a'] })
  })

  it('row exists without a previous default (post-restart) — untouched; differing persona → persona-source conflict', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig({ list: [{ id: 'coder', persona: 'operator-edited', chain: ['op'] }], rules: [] }))
    const outcome = await manager.declare([{ id: 'coder', persona: 'seed-default' }], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    // No row change → no write, but the registry commits the default.
    expect(f.writes).toHaveLength(0)
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'operator-edited', chain: ['op'] }])
    expect(messagesOf(logger)).toEqual([
      'llm-fallbacks: seeds: persona-source conflict for seed id "coder" — operator row persona kept (never overwritten)',
    ])
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({
      seeded: true,
      personaOverridden: true,
      seedPersona: 'seed-default',
    })
  })

  it('row exists without a previous default and equal persona — quiet attach, no conflict', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig({ list: [{ id: 'coder', persona: 'same' }], rules: [] }))
    const outcome = await manager.declare([{ id: 'coder', persona: 'same' }], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([])
    expect(f.writes).toHaveLength(0)
  })

  it('attach conflict leaves the operator row AND the rules untouched, writing nothing (AC-2 combined pin)', async () => {
    // One end-to-end assertion of the conflict contract: the row is copied
    // verbatim (persona/chain/prompt/permissions), the operator rules are
    // intact, and the no-delta gate suppresses the settings write.
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig({
      list: [{
        id: 'coder',
        persona: 'operator-edited',
        chain: ['op-chain'],
        prompt: 'operator prompt',
        permissions: { allow: ['a'] },
      }],
      rules: [{ role: 'coder' }],
    }))
    const outcome = await manager.declare([{ id: 'coder', persona: 'seed-default' }], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.writes).toHaveLength(0)
    expect(f.io.read().roles).toEqual({
      list: [{
        id: 'coder',
        persona: 'operator-edited',
        chain: ['op-chain'],
        prompt: 'operator prompt',
        permissions: { allow: ['a'] },
      }],
      rules: [{ role: 'coder' }],
    })
  })

  it('row at the previous default tracks a companion persona update — chain preserved (R4)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    // Operator adds a chain; persona untouched → still at default.
    f.edit({ list: [{ id: 'coder', persona: 'v1', chain: ['op-chain'] }], rules: [] })
    const outcome = await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)

    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v2', chain: ['op-chain'] }])
    expect(f.writes).toHaveLength(2)
  })

  it('declare tracking-update preserves prompt/permissions/chain/fallback byte-for-byte (R4)', async () => {
    // The `{ ...row, persona }` tracking path is pinned explicitly — not
    // just the revert path — so a future spread change cannot silently
    // drop the schema-reserved role fields.
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({
      list: [{
        id: 'coder',
        persona: 'v1',
        chain: ['openai/gpt-4o', 'other/claude'],
        fallback: 'none',
        prompt: 'custom prompt',
        permissions: { allow: ['a'], deny: ['b'] },
      }],
      rules: [{ role: 'coder' }],
    })

    const outcome = await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)
    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([])
    expect(f.io.read().roles).toEqual({
      list: [{
        id: 'coder',
        persona: 'v2',
        chain: ['openai/gpt-4o', 'other/claude'],
        fallback: 'none',
        prompt: 'custom prompt',
        permissions: { allow: ['a'], deny: ['b'] },
      }],
      rules: [{ role: 'coder' }],
    })
  })

  it('operator override preserved on re-declare; conflict iff persona differs from the incoming default', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [{ id: 'coder', persona: 'operator', chain: ['op'] }], rules: [] })

    const outcome = await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)
    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'operator', chain: ['op'] }])
    expect(f.writes).toHaveLength(1) // only the first declare wrote

    // Override resolved: operator persona equals the new default → quiet, still no write.
    const outcome2 = await manager.declare([{ id: 'coder', persona: 'operator' }], f.io)
    expect(outcome2.conflicts).toEqual([])
    expect(f.writes).toHaveLength(1)
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({
      seeded: true,
      personaOverridden: false,
      seedPersona: 'operator',
    })
  })

  it('attach matches rows by trimmed id — a padded operator row attaches instead of duplicating', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig({ list: [{ id: ' coder ', persona: 'op' }], rules: [] }))
    const outcome = await manager.declare([{ id: 'coder', persona: 'seed' }], f.io)

    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.io.read().roles.list).toEqual([{ id: ' coder ', persona: 'op' }])
    expect(f.io.read().roles.list).toHaveLength(1)
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({
      id: ' coder ',
      seeded: true,
      personaOverridden: true,
      seedPersona: 'seed',
    })
  })

  it('removing a declaration keeps the row and drops the seed state (AC-2)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([
      { id: 'coder', persona: 'v1' },
      { id: 'reviewer', persona: 'r' },
    ], f.io)

    const outcome = await manager.declare([{ id: 'reviewer', persona: 'r' }], f.io)
    expect(outcome.applied).toEqual(['reviewer'])
    expect(f.io.read().roles.list).toEqual([
      { id: 'coder', persona: 'v1' },       // row remains (R2)
      { id: 'reviewer', persona: 'r' },
    ])
    expect(f.writes).toHaveLength(1)        // no delta → no write
    const readback = manager.effectiveRoles(f.io)
    expect(readback.roles.find((r) => r.id === 'coder')).toMatchObject({
      seeded: false,
      personaOverridden: false,
    })
    expect(readback.roles.find((r) => r.id === 'coder')!.seedPersona).toBeUndefined()
    expect(manager.wireStatus(f.io)).toEqual([{ id: 'reviewer', overridden: false, source: 'external' }])
  })

  it('re-declaring a previously dropped id re-materializes conservatively (spec §9.2 honest limitation)', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig())
    await manager.declare([
      { id: 'coder', persona: 'v1' },
      { id: 'reviewer', persona: 'r' },
    ], f.io)
    await manager.declare([{ id: 'reviewer', persona: 'r' }], f.io) // coder dropped

    const outcome = await manager.declare([{ id: 'coder', persona: 'v2' }, { id: 'reviewer', persona: 'r' }], f.io)
    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.io.read().roles.list.find((r) => r.id === 'coder')).toEqual({ id: 'coder', persona: 'v1' })
    expect(manager.effectiveRoles(f.io).roles.find((r) => r.id === 'coder')).toMatchObject({
      seeded: true,
      personaOverridden: true,
      seedPersona: 'v2',
    })
  })

  it('declaring an empty batch clears the registry without touching rows', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)

    const outcome = await manager.declare([], f.io)
    expect(outcome).toEqual({ applied: [], skipped: [], conflicts: [] })
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v1' }])
    expect(f.writes).toHaveLength(1)
    expect(manager.effectiveRoles(f.io).roles[0].seeded).toBe(false)
    expect(manager.wireStatus(f.io)).toEqual([])
  })
})

describe('FallbacksSeedManager — idempotency (AC-1)', () => {
  it('re-declaring the same batch is a no-op: no extra rows, no write', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    expect(f.writes).toHaveLength(1)

    const outcome = await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    expect(f.writes).toHaveLength(1) // zero writes on the second declare
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v1' }])
    expect(f.io.read().roles.list).toHaveLength(1)
    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([])
  })

  it('re-declaring multiple ids twice produces exactly one row per id', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    const batch = [
      { id: 'architect', persona: 'a' },
      { id: 'code-reviewer', persona: 'c' },
      { id: 'frontend-dev', persona: 'f' },
    ]
    await manager.declare(batch, f.io)
    await manager.declare(batch, f.io)
    expect(f.io.read().roles.list).toEqual(batch)
    expect(f.writes).toHaveLength(1)
  })

  it('double re-declare over an operator override keeps the override with zero writes (AC-1)', async () => {
    // The AC-1 no-delta clause with an override present: re-declaring the
    // SAME batch (not a changed default) over an operator override must
    // leave the row overridden and issue no settings write.
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [{ id: 'coder', persona: 'operator' }], rules: [] })

    await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)
    expect(f.writes).toHaveLength(1) // only the first declare wrote

    const outcome = await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)
    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'operator' }])
    expect(f.writes).toHaveLength(1) // identical batch over the override → still zero writes
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({
      seeded: true,
      personaOverridden: true,
      seedPersona: 'v2',
    })
  })

  it('retained legacy keys on the composed roles never churn a write (member-wise delta, qc2 S-2)', async () => {
    // A transitional legacy user layer can keep `roles.default` (schemastery
    // retains unknown keys). The no-delta check must compare only the
    // `list`/`rules` members — otherwise every declare issues a settings
    // write (revision churn) despite an unchanged list.
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig({
      list: [{ id: 'coder', persona: 'v1' }],
      rules: [],
      default: { persona: 'legacy default' },
    } as unknown as FallbacksRoles))
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    expect(f.writes).toHaveLength(0) // row already matches → no delta → no write

    const outcome = await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    expect(outcome.applied).toEqual(['coder'])
    expect(f.writes).toHaveLength(0) // the legacy key still does not churn a write
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v1' }])
  })
})

describe('FallbacksSeedManager — malformed/legacy roles containment (guide §10)', () => {
  it('declare degrades a legacy roles shape without list to empty rows instead of throwing', async () => {
    // Two-block-era source: `roles.default` without `roles.list` — the
    // write path must tolerate the same shape the readbacks guard via
    // roleRows() (no raw TypeError), degrading conservatively (qc2 S-1).
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo({
      ...defaultFallbacksConfig,
      roles: { default: { persona: 'legacy' } },
    } as unknown as FallbacksConfig)

    const outcome = await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io)
    expect(outcome.applied).toEqual(['coder'])
    expect(outcome.conflicts).toEqual([])
    expect(f.writes).toHaveLength(1)
    expect(f.io.read().roles).toEqual({ list: [{ id: 'coder', persona: 'Coder' }], rules: [] })
  })

  it('revert on a non-array list degrades to row-absent instead of throwing', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: 'junk' } as unknown as FallbacksRoles)

    const outcome = await manager.revert('coder', f.io)
    expect(outcome).toEqual({ reverted: false, reason: 'row-absent' })
    expect(f.writes).toHaveLength(1) // only the declare wrote
  })

  it('revert tolerates a non-array rules member (degrades to []) and still reverts the persona', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [{ id: 'coder', persona: 'operator' }], rules: 'junk' } as unknown as FallbacksRoles)

    const outcome = await manager.revert('coder', f.io)
    expect(outcome).toEqual({ reverted: true, persona: 'v1' })
    // The write payload is well-formed: degraded rules never reach the
    // settings layer as a malformed value.
    expect(f.io.read().roles).toEqual({ list: [{ id: 'coder', persona: 'v1' }], rules: [] })
  })
})

describe('FallbacksSeedManager — revert (AC-3, spec §9.1)', () => {
  it('revert restores the current declared default; a re-declared persona becomes the new revert target', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [{ id: 'coder', persona: 'operator' }], rules: [] })

    const outcome = await manager.revert('coder', f.io)
    expect(outcome).toEqual({ reverted: true, persona: 'v1' })
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v1' }])

    // Companion re-declares a NEW default while the operator is at default —
    // the row tracks it, and revert now restores the NEW default (AC-3).
    await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v2' }])
    f.edit({ list: [{ id: 'coder', persona: 'operator2' }], rules: [] })

    const outcome2 = await manager.revert('coder', f.io)
    expect(outcome2).toEqual({ reverted: true, persona: 'v2' })
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v2' }])
  })

  it('revert writes persona only — chain/fallback/prompt/permissions preserved byte-for-byte (R4)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({
      list: [{
        id: 'coder',
        persona: 'operator',
        chain: ['openai/gpt-4o', 'other/claude'],
        fallback: 'none',
        prompt: 'custom prompt',
        permissions: { allow: ['a'], deny: ['b'] },
      }],
      rules: [{ role: 'coder' }],
    })

    const outcome = await manager.revert('coder', f.io)
    expect(outcome).toEqual({ reverted: true, persona: 'v1' })
    expect(f.io.read().roles.list).toEqual([{
      id: 'coder',
      persona: 'v1',
      chain: ['openai/gpt-4o', 'other/claude'],
      fallback: 'none',
      prompt: 'custom prompt',
      permissions: { allow: ['a'], deny: ['b'] },
    }])
    expect(f.io.read().roles.rules).toEqual([{ role: 'coder' }])
  })

  it('revert of an unseeded id → not-seeded; live declaration with deleted row → row-absent (no throw, no write)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())

    expect(await manager.revert('coder', f.io)).toEqual({ reverted: false, reason: 'not-seeded' })

    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [], rules: [] }) // operator deleted the row
    expect(await manager.revert('coder', f.io)).toEqual({ reverted: false, reason: 'row-absent' })
    expect(f.writes).toHaveLength(1) // only the declare wrote
  })

  it('revert looks up by trimmed id', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [{ id: ' coder ', persona: 'op' }], rules: [] })

    const outcome = await manager.revert(' coder ', f.io)
    expect(outcome).toEqual({ reverted: true, persona: 'v1' })
    expect(f.io.read().roles.list).toEqual([{ id: ' coder ', persona: 'v1' }])
  })

  it('revert at the current default is a no-write no-op with a reverted outcome', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    expect(f.writes).toHaveLength(1)

    const outcome = await manager.revert('coder', f.io)
    expect(outcome).toEqual({ reverted: true, persona: 'v1' })
    expect(f.writes).toHaveLength(1)
  })
})

describe('FallbacksSeedManager — retry-safe writes (spec §9.1)', () => {
  it('a failed declare write throws and leaves the registry uncommitted; a retry succeeds', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    f.failWrites()

    await expect(manager.declare([{ id: 'coder', persona: 'v1' }], f.io))
      .rejects.toThrow('settings write channel unavailable')
    expect(f.io.read().roles.list).toEqual([]) // nothing materialized
    expect(manager.effectiveRoles(f.io).roles).toEqual([]) // registry NOT committed

    f.recoverWrites()
    const outcome = await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    expect(outcome.applied).toEqual(['coder'])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v1' }])
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({
      seeded: true,
      personaOverridden: false,
      seedPersona: 'v1',
    })
  })

  it('a failed revert write propagates loudly without changing the row', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io)
    f.edit({ list: [{ id: 'coder', persona: 'operator' }], rules: [] })
    f.failWrites()

    await expect(manager.revert('coder', f.io)).rejects.toThrow('settings write channel unavailable')
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'operator' }])
  })
})

describe('FallbacksSeedManager — derived readback state', () => {
  it('effectiveRoles derives seeded / personaOverridden / seedPersona and passes chain/fallback through', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig({
      list: [
        { id: 'coder', persona: 'seed', chain: ['c'], fallback: 'none' },
        { id: 'reviewer', persona: 'operator' },
        { id: 'plain', persona: 'x' },
      ],
      rules: [],
    }))
    const outcome = await manager.declare([
      { id: 'coder', persona: 'seed' },
      { id: 'reviewer', persona: 'default-r' },
    ], f.io)

    expect(outcome.conflicts).toEqual([{ id: 'reviewer', kind: 'persona-source' }])
    expect(manager.effectiveRoles(f.io).roles).toEqual([
      {
        id: 'coder',
        persona: 'seed',
        chain: ['c'],
        fallback: 'none',
        seeded: true,
        personaOverridden: false,
        source: 'external',
        seedPersona: 'seed',
      },
      {
        id: 'reviewer',
        persona: 'operator',
        seeded: true,
        personaOverridden: true,
        source: 'external',
        seedPersona: 'default-r',
      },
      {
        id: 'plain',
        persona: 'x',
        seeded: false,
        personaOverridden: false,
        source: 'user',
      },
    ])
  })

  it('wireStatus reports seeded rows with the override flag (card badge state)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig({ list: [{ id: 'coder', persona: 'op' }], rules: [] }))
    await manager.declare([{ id: 'coder', persona: 'seed' }], f.io)
    expect(manager.wireStatus(f.io)).toEqual([{ id: 'coder', overridden: true, source: 'external' }])

    await manager.revert('coder', f.io)
    expect(manager.wireStatus(f.io)).toEqual([{ id: 'coder', overridden: false, source: 'external' }])
  })
})

describe('FallbacksSeedManager — provenance source (seed-source-provenance, spec §2)', () => {
  it('a named set labels the batch: readback source is the set name; rows outside the batch stay user (a/c)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig({ list: [{ id: 'solo', persona: 'operator row' }], rules: [] }))
    await manager.declare([
      { id: 'coder', persona: 'Coder' },
      { id: 'reviewer', persona: 'Reviewer' },
    ], f.io, { set: 'mstar' })

    const roles = manager.effectiveRoles(f.io).roles
    expect(roles.find((role) => role.id === 'coder')).toMatchObject({
      seeded: true,
      source: 'mstar',
      seedPersona: 'Coder',
    })
    expect(roles.find((role) => role.id === 'reviewer')).toMatchObject({ seeded: true, source: 'mstar' })
    // The pre-existing row is not in the batch → no live declaration → user (c).
    expect(roles.find((role) => role.id === 'solo')).toMatchObject({
      seeded: false,
      personaOverridden: false,
      source: 'user',
    })
    expect(manager.wireStatus(f.io)).toEqual([
      { id: 'coder', overridden: false, source: 'mstar' },
      { id: 'reviewer', overridden: false, source: 'mstar' },
    ])
  })

  it('a one-arg declare labels the batch external (d)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io)

    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({ seeded: true, source: 'external' })
    expect(manager.wireStatus(f.io)).toEqual([{ id: 'coder', overridden: false, source: 'external' }])
  })

  it('the internal bundled marker labels the self-declare bundled (b — mechanism pin; end-to-end in presets-integration)', async () => {
    // Mirrors the only legitimate call site (the preset child in apply(),
    // `src/index.ts`: `seeds.declare(presetRoles, seedsIo, { bundled: true })`).
    // The marker type is module-internal to seeds.ts — a structurally-checked
    // literal here, exactly like the src call site.
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'scout', persona: 'Scout' }], f.io, { bundled: true })

    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({ seeded: true, source: 'bundled' })
    expect(manager.wireStatus(f.io)).toEqual([{ id: 'scout', overridden: false, source: 'bundled' }])
  })

  it('invalid set names warn once and degrade to external — the seeds still apply (e)', async () => {
    // Empty after trim, whitespace-only, non-string, the three reserved
    // labels, and a padded reserved value (reserved is checked on the TRIMMED
    // name). Each declare: exactly one warn with the mandated prefix, the
    // batch applied in full, and the provenance degraded to `external` —
    // a bad label must never drop roles.
    const invalidSets: unknown[] = ['', '   ', 42, 'bundled', 'user', 'external', '  bundled  ']
    for (const set of invalidSets) {
      const { logger } = warnLogger()
      const manager = new FallbacksSeedManager(logger)
      const f = fakeIo(baseConfig())
      const outcome = await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io, {
        set,
      } as unknown as SeedsDeclareOptions)

      expect(outcome.applied).toEqual(['coder'])
      expect(outcome.skipped).toEqual([])
      expect(outcome.conflicts).toEqual([])
      expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'Coder' }])
      expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({ seeded: true, source: 'external' })
      expect(manager.wireStatus(f.io)).toEqual([{ id: 'coder', overridden: false, source: 'external' }])
      const messages = messagesOf(logger)
      expect(messages).toHaveLength(1) // warn ONCE per declare call
      expect(messages[0]).toMatch(/^llm-fallbacks: seeds: /)
    }
  })

  it('a valid padded set name is trimmed — no warn, source reads back trimmed', async () => {
    const { logger } = warnLogger()
    const manager = new FallbacksSeedManager(logger)
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io, { set: '  mstar  ' })

    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({ seeded: true, source: 'mstar' })
    expect(messagesOf(logger)).toEqual([])
  })

  it('a provenance-only re-declare performs no settings write — idempotency preserved (h)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io, { set: 'mstar' })
    expect(f.writes).toHaveLength(1)

    // Same batch, same label → no delta → no write.
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io, { set: 'mstar' })
    expect(f.writes).toHaveLength(1)

    // Provenance-ONLY change (mstar → unnamed external): the rows are
    // identical, so the no-delta gate suppresses the write — only the
    // read-time source flips (provenance is registry-only, never persisted).
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io)
    expect(f.writes).toHaveLength(1)
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({ seeded: true, source: 'external' })

    // And external → a different named set: still no write.
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io, { set: 'other' })
    expect(f.writes).toHaveLength(1)
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'Coder' }])
    expect(manager.effectiveRoles(f.io).roles[0]).toMatchObject({ seeded: true, source: 'other' })
    expect(manager.wireStatus(f.io)).toEqual([{ id: 'coder', overridden: false, source: 'other' }])
  })

  // ── per-producer registry (plan seeds-source-and-persona-width Task 1) ──
  // The 5 bundled preset ids (mirror of `src/presets.ts`; the unit surface
  // keeps the bundle-purity gate, so the ids are spelled out, not imported).
  const bundledPresets = [
    { id: 'task', persona: 'Task' },
    { id: 'sonic', persona: 'Sonic' },
    { id: 'scout', persona: 'Scout' },
    { id: 'reviewer', persona: 'Reviewer' },
    { id: 'security-reviewer', persona: 'Security Reviewer' },
  ]
  // The companion's own 13 ids (mstar-harness dsh companion shape).
  const companionOwn = [
    { id: 'architect', persona: 'Architect' },
    { id: 'code-reviewer', persona: 'Code Reviewer' },
    { id: 'frontend-dev', persona: 'Frontend Dev' },
    { id: 'fullstack-dev', persona: 'Fullstack Dev' },
    { id: 'backend-dev', persona: 'Backend Dev' },
    { id: 'data-engineer', persona: 'Data Engineer' },
    { id: 'ml-engineer', persona: 'ML Engineer' },
    { id: 'product-manager', persona: 'Product Manager' },
    { id: 'project-manager', persona: 'Project Manager' },
    { id: 'qa-engineer', persona: 'QA Engineer' },
    { id: 'ops-engineer', persona: 'Ops Engineer' },
    { id: 'writing-specialist', persona: 'Writing Specialist' },
    { id: 'prompt-engineer', persona: 'Prompt Engineer' },
  ]
  /** The companion's merge-preserve batch: its own ids + the seeded presets copied verbatim. */
  const mergePreserve = (presets: Array<{ id: string; persona: string }>) => [
    ...companionOwn.map((seed) => ({ ...seed })),
    ...presets.map((preset) => ({ ...preset })),
  ]

  it('repro: a companion merge-preserve declare leaves the 5 bundled presets bundled and its own ids external', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare(bundledPresets, f.io, { bundled: true })
    expect(f.writes).toHaveLength(1)

    // The companion rebuilds its batch from getEffectiveRoles() and
    // preserves the currently seeded non-own ids verbatim (mstar-harness
    // fallbacks-seeds protocol) — one-arg ⇒ external.
    await manager.declare(mergePreserve(bundledPresets), f.io)

    const roles = manager.effectiveRoles(f.io).roles
    for (const preset of bundledPresets) {
      expect(roles.find((role) => role.id === preset.id)).toMatchObject({
        seeded: true,
        source: 'bundled',
        seedPersona: preset.persona,
      })
    }
    for (const seed of companionOwn) {
      expect(roles.find((role) => role.id === seed.id)).toMatchObject({
        seeded: true,
        source: 'external',
        seedPersona: seed.persona,
      })
    }
    const wire = manager.wireStatus(f.io)
    for (const preset of bundledPresets) {
      expect(wire.find((entry) => entry.id === preset.id)).toMatchObject({ source: 'bundled' })
    }
    for (const seed of companionOwn) {
      expect(wire.find((entry) => entry.id === seed.id)).toMatchObject({ source: 'external' })
    }
  })

  it('repro: the companion-first declare order gives the same attribution (bundled wins regardless of order)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare(mergePreserve(bundledPresets), f.io)
    await manager.declare(bundledPresets, f.io, { bundled: true })

    const roles = manager.effectiveRoles(f.io).roles
    for (const preset of bundledPresets) {
      expect(roles.find((role) => role.id === preset.id)).toMatchObject({ seeded: true, source: 'bundled' })
    }
    for (const seed of companionOwn) {
      expect(roles.find((role) => role.id === seed.id)).toMatchObject({ seeded: true, source: 'external' })
    }
  })

  it('producer isolation: a companion declare that does not carry the bundled ids leaves them bundled AND seeded', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'scout', persona: 'Scout' }], f.io, { bundled: true })
    await manager.declare([{ id: 'architect', persona: 'Architect' }], f.io)

    const roles = manager.effectiveRoles(f.io).roles
    expect(roles.find((role) => role.id === 'scout')).toMatchObject({
      seeded: true,
      source: 'bundled',
      seedPersona: 'Scout',
    })
    expect(roles.find((role) => role.id === 'architect')).toMatchObject({ seeded: true, source: 'external' })
    expect(manager.wireStatus(f.io)).toEqual([
      { id: 'scout', overridden: false, source: 'bundled' },
      { id: 'architect', overridden: false, source: 'external' },
    ])
  })

  it("per-producer replacement: re-declaring producer A drops only A's omitted ids; producer B's slice is untouched", async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([
      { id: 'coder', persona: 'Coder' },
      { id: 'reviewer', persona: 'Reviewer' },
      { id: 'scout', persona: 'Scout' },
    ], f.io, { set: 'mstar' })
    await manager.declare([
      { id: 'coder', persona: 'Coder' },
      { id: 'scout', persona: 'Scout' },
    ], f.io) // unnamed external producer
    // External re-declares a smaller batch: scout drops out of the external
    // slice (falls back to the mstar producer), coder stays external.
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io)

    const roles = manager.effectiveRoles(f.io).roles
    expect(roles.find((role) => role.id === 'coder')).toMatchObject({ seeded: true, source: 'external' })
    expect(roles.find((role) => role.id === 'scout')).toMatchObject({ seeded: true, source: 'mstar' })
    expect(roles.find((role) => role.id === 'reviewer')).toMatchObject({ seeded: true, source: 'mstar' })
  })

  it('precedence: bundled wins over a companion collision; the most recent non-bundled producer wins; a bundled drop reveals the companion copy', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([
      { id: 'task', persona: 'Bundled Task' },
      { id: 'scout', persona: 'Bundled Scout' },
    ], f.io, { bundled: true })
    await manager.declare([{ id: 'task', persona: 'Mstar Task' }], f.io, { set: 'mstar' })
    await manager.declare([{ id: 'task', persona: 'External Task' }], f.io)

    // bundled wins over both companions.
    expect(manager.effectiveRoles(f.io).roles.find((role) => role.id === 'task')).toMatchObject({
      seeded: true,
      source: 'bundled',
      seedPersona: 'Bundled Task',
    })

    // Bundled drops task (keeps scout): the companion copy becomes visible —
    // the most recent non-bundled producer (external) wins over mstar.
    await manager.declare([{ id: 'scout', persona: 'Bundled Scout' }], f.io, { bundled: true })
    expect(manager.effectiveRoles(f.io).roles.find((role) => role.id === 'task')).toMatchObject({
      seeded: true,
      source: 'external',
      seedPersona: 'External Task',
    })
  })

  it("unnamed producers share one external slice: a second unnamed declare replaces the first's entries (documented; { set } is the remedy)", async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'coder', persona: 'Coder' }], f.io)
    await manager.declare([{ id: 'reviewer', persona: 'Reviewer' }], f.io)

    const roles = manager.effectiveRoles(f.io).roles
    expect(roles.find((role) => role.id === 'coder')).toMatchObject({ seeded: false, source: 'user' })
    expect(roles.find((role) => role.id === 'reviewer')).toMatchObject({ seeded: true, source: 'external' })
  })

  it('revert resolves through the same precedence: a preserved bundled id reverts to the bundled persona, never the companion copy', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare([{ id: 'scout', persona: 'Bundled Scout' }], f.io, { bundled: true })
    // The companion carries scout with its OWN persona (a collision, not a
    // verbatim copy) — the bundled origin must still win the revert target.
    await manager.declare([{ id: 'scout', persona: 'Companion Scout' }], f.io)
    f.edit({ list: [{ id: 'scout', persona: 'operator edit' }], rules: [] })

    const outcome = await manager.revert('scout', f.io)
    expect(outcome).toEqual({ reverted: true, persona: 'Bundled Scout' })
    expect(f.io.read().roles.list).toEqual([{ id: 'scout', persona: 'Bundled Scout' }])
  })

  it('the reproduction performs exactly the writes of the single-map design: bundled once, companion once, repeat zero (idempotency)', async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    await manager.declare(bundledPresets, f.io, { bundled: true })
    expect(f.writes).toHaveLength(1)
    await manager.declare(mergePreserve(bundledPresets), f.io)
    expect(f.writes).toHaveLength(2)
    await manager.declare(mergePreserve(bundledPresets), f.io)
    expect(f.writes).toHaveLength(2) // repeated batch → zero writes
  })

  it("materialize tracking is per producer: a producer's own at-default row tracks its update; a sibling collision never consumes the tracking; operator overrides survive", async () => {
    const manager = new FallbacksSeedManager({ warn: vi.fn() })
    const f = fakeIo(baseConfig())
    // A (mstar) declares coder/v1; B (external) collides with its own persona.
    // B has no prior slice of its own, so the row is conservatively untouched
    // (conflict) — the single-map design would have tracked B's update here.
    await manager.declare([{ id: 'coder', persona: 'v1' }], f.io, { set: 'mstar' })
    const outcome = await manager.declare([{ id: 'coder', persona: 'v2' }], f.io)
    expect(outcome.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v1' }])

    // A re-declares v3: the row is still at A's own default (v1) → tracks A's
    // update; B's collision did not consume the tracking.
    await manager.declare([{ id: 'coder', persona: 'v3' }], f.io, { set: 'mstar' })
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'v3' }])

    // Operator override: never overwritten by any producer.
    f.edit({ list: [{ id: 'coder', persona: 'operator' }], rules: [] })
    const outcome2 = await manager.declare([{ id: 'coder', persona: 'v4' }], f.io, { set: 'mstar' })
    expect(outcome2.conflicts).toEqual([{ id: 'coder', kind: 'persona-source' }])
    expect(f.io.read().roles.list).toEqual([{ id: 'coder', persona: 'operator' }])
  })
})
