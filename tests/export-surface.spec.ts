/**
 * Library export-surface tests (plan fallbacks-consumer-api Task 1).
 *
 * Pins the package root (`src/index.ts`) as the public library API: every
 * runtime value/function the surface promises must exist, the pre-existing
 * plugin exports must not regress, and the key library functions must be
 * directly callable from the root module. Type-only exports are erased at
 * runtime, so they are pinned compile-time via `expectTypeOf` (no-op at
 * runtime); the emitted `dist/index.d.ts` (tsc build) is the full type
 * surface.
 *
 * `LIBRARY_EXPORT_KEYS` below is the SSOT for the export inventory in
 * docs/consumer-api.md (函数导出清单 / 值导出 / 插件既有导出): the docs
 * tables must list exactly these runtime keys (S-3 mechanical drift guard).
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as index from '../src/index.ts'

/**
 * SSOT for the docs/consumer-api.md export inventory — the runtime keys its
 * 函数导出清单 / 值导出 / 插件既有导出 tables list. S-3 mechanical drift
 * guard: the runtime existence assertions iterate over this array, and the
 * type map below must cover exactly this set, so a docs/table/export drift
 * fails CI instead of rotting silently.
 */
const LIBRARY_EXPORT_KEYS = [
  // Pre-existing plugin surface — zero regression.
  'name',
  'Config',
  'stateStore',
  'apply',
  // Library API functions (plan fallbacks-consumer-api T1).
  'resolveCandidate',
  'resolveChainViews',
  'selectCandidates',
  'resolveChain',
  'hasWildcardEntry',
  'createCandidateFilter',
  'annotateCandidates',
  'validateFallbacksConfig',
  'detectLegacyKeys',
  'parseSelector',
  // Library API values — `defaultFallbacksConfig` is a T1 re-export (NOT
  // part of the pre-existing plugin surface; S-1); `provide` is the
  // declarative service metadata added in T2 (F-004).
  'INHERIT_ROLE_ID',
  'ROLE_ID_PATTERN',
  'defaultFallbacksConfig',
  'provide',
  'SelectorError',
  // Role-seeds surface (plan fallbacks-role-seeds T2) — the seed manager
  // class is the only runtime value among the seeds exports; the §9.1 types
  // are compile-time only (pinned in the type-exports block below).
  'FallbacksSeedManager',
  // Bundled preset roles (plan fallbacks-preset-roles T3) — the 5 preset
  // declarations re-exported from the package root (pure data module).
  'presetRoles',
  // Session-projection key + value guard (plan agent-role-getter) — the role
  // pill's public contract, re-exported so consumers stop hard-coding the
  // literal or re-implementing the blank-string guard.
  'ROLE_PROJECTION_KEY',
  'readRoleProjectionValue',
] as const

describe('export surface: runtime values', () => {
  // Export key → expected `typeof` result. `Config` (schemastery schema) and
  // the `SelectorError` class are callable values → 'function'; `provide` is
  // a `readonly ['llm-fallbacks']` array → 'object'.
  const valueExports: Record<string, string> = {
    name: 'string',
    Config: 'function',
    stateStore: 'function',
    apply: 'function',
    resolveCandidate: 'function',
    resolveChainViews: 'function',
    selectCandidates: 'function',
    resolveChain: 'function',
    hasWildcardEntry: 'function',
    createCandidateFilter: 'function',
    annotateCandidates: 'function',
    validateFallbacksConfig: 'function',
    detectLegacyKeys: 'function',
    parseSelector: 'function',
    INHERIT_ROLE_ID: 'string',
    ROLE_ID_PATTERN: 'object',
    defaultFallbacksConfig: 'object',
    provide: 'object',
    SelectorError: 'function',
    FallbacksSeedManager: 'function',
    presetRoles: 'object',
    ROLE_PROJECTION_KEY: 'string',
    readRoleProjectionValue: 'function',
  }

  // The type map and the docs-inventory SSOT must cover EXACTLY the same
  // keys — drift in either direction is a contract change (S-3).
  it('the type map covers exactly the docs-inventory keys (LIBRARY_EXPORT_KEYS)', () => {
    expect(Object.keys(valueExports).sort()).toEqual([...LIBRARY_EXPORT_KEYS].sort())
  })

  it.each(LIBRARY_EXPORT_KEYS.map((key) => [key, valueExports[key]] as const))(
    'exports %s (%s)',
    (key, expectedType) => {
      expect(index).toHaveProperty(key)
      expect(typeof (index as unknown as Record<string, unknown>)[key]).toBe(expectedType)
    },
  )

  it('exports the canonical value constants with their expected contents', () => {
    expect(index.name).toBe('llm-fallbacks')
    expect(index.INHERIT_ROLE_ID).toBe('inherit')
    expect(index.ROLE_ID_PATTERN).toBeInstanceOf(RegExp)
    expect('enabled' in index.defaultFallbacksConfig).toBe(false)
    // Direction C removed both mechanisms; the exported defaults must not
    // resurrect them.
    expect('alwaysModeRetryCap' in index.defaultFallbacksConfig).toBe(false)
    expect('roleAutoMatch' in index.defaultFallbacksConfig).toBe(false)
    expect(index.defaultFallbacksConfig.triggerCodes).toEqual(['AUTH', 'QUOTA', 'RATE_LIMIT'])
  })
})

describe('export surface: callable smokes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolveChain walks the given chain entries from the package root', () => {
    expect(
      index.resolveChain(['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'], 'openai', 'gpt-4o').map(candidate => candidate.raw),
    ).toEqual(['openai/gpt-4o', 'anthropic/claude-3-5-sonnet'])
  })

  it('validateFallbacksConfig accepts a valid v2 config without warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const validConfig: index.FallbacksConfig = {
      ...index.defaultFallbacksConfig,
      chains: [{
        id: 'Auto',
        label: 'Default chain',
        entries: ['anthropic/claude-3-5-sonnet', 'deepseek-official/deepseek-flash'],
        timeSlots: [],
      }],
      roles: { list: [{ id: 'coder', persona: '', chain: 'Auto' }] },
    }
    index.validateFallbacksConfig(validConfig, { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('detectLegacyKeys flags the removed v1 keys', () => {
    expect(index.detectLegacyKeys({ rootChain: [], timeSlots: [] })).toEqual(['rootChain', 'timeSlots'])
  })
})

describe('export surface: type exports (compile-time only)', () => {
  it('re-exports the library types from the package root', () => {
    // DEV-TIME pin (F-001/S-2): vitest's esbuild never typechecks tests and
    // CI runs test+build only (build `tsc` covers src), so this block is
    // INERT in CI — it exists for local `tsc` validation (a scratch tsconfig
    // including tests/, or in-editor diagnostics). Keep it in sync when the
    // type surface changes; it is NOT the CI type guard.
    expectTypeOf<index.Selector>().toEqualTypeOf<{ provider: string; model?: string; raw: string }>()
    expectTypeOf<index.FailingModel>().toEqualTypeOf<{ provider: string; model: string }>()
    expectTypeOf<index.RecoveryPolicy>().toEqualTypeOf<'timer' | 'half-open'>()
    expectTypeOf<index.RevertPolicy>().toEqualTypeOf<'cooldown-expiry' | 'never'>()
    expectTypeOf<index.CandidateSkipReason>().toEqualTypeOf<
      'same-as-current' | 'cooldown' | 'step-failed' | 'context-window' | 'missing-id'
    >()
    expectTypeOf<index.FallbacksConfigLogger>().toMatchTypeOf<{ warn: (message: string) => void }>()
    expectTypeOf<index.NamedChain>().toMatchTypeOf<{
      id: string
      label: string
      entries: string[]
      timeSlots?: NonNullable<index.NamedChain['timeSlots']>
    }>()
    expectTypeOf<index.FallbacksRole>().toMatchTypeOf<{
      id: string
      persona: string
      /** The manually specified named-chain POINTER (「指定降级链」). */
      chain?: string
    }>()
    expectTypeOf<index.FallbacksRoles>().toEqualTypeOf<{ list: index.FallbacksRole[] }>()
    expectTypeOf<index.FallbacksConfig>().toMatchTypeOf<{
      // No `enabled` key (plan fallbacks-web-ux-alignment T2 — removed).
      chains: index.NamedChain[]
      cooldownMs: number
    }>()
    expectTypeOf<index.CandidateFilterOptions>().toMatchTypeOf<{ current: index.FailingModel }>()
    expectTypeOf<index.AnnotatedCandidate>().toMatchTypeOf<{
      candidate: index.Selector
      skip?: index.CandidateSkipReason
    }>()
    expectTypeOf<index.SelectorError>().toMatchTypeOf<Error>()
    // Pre-existing plugin type exports — zero regression.
    expectTypeOf<index.Config>().toEqualTypeOf<index.FallbacksConfig>()
    expectTypeOf<index.FallbackSwitchReason>().toEqualTypeOf<'trigger-code' | 'always-cap'>()
    expectTypeOf<index.FallbacksSwitchEventData>().toMatchTypeOf<{ turn: number; step: number }>()
    expectTypeOf<index.AgentFallbackState>().toMatchTypeOf<{ cooldown: object; recovery: object }>()
    expectTypeOf<index.FallbackStateStore>().toMatchTypeOf<object>()
    // Service contract (plan fallbacks-consumer-api T2 + fallbacks-role-seeds
    // T2 + seed-source-provenance T2): the static `provide` metadata value and
    // the `FallbacksService` interface (the typed `ctx.get('llm-fallbacks')`
    // surface via the cordis Context merge). Ten keys — the six-key face plus
    // the three additive seed methods and the additive `getAgentRole` (D7);
    // `declareSeeds` takes the PUBLIC options face (`set` only — no
    // `bundled`, reserved for the plugin's own preset self-declare).
    expectTypeOf(index.provide).toEqualTypeOf<readonly ['llm-fallbacks']>()
    expectTypeOf<index.FallbacksService>().toEqualTypeOf<{
      name: 'llm-fallbacks'
      version: string
      resolveChain: typeof index.resolveChain
      validateFallbacksConfig: typeof index.validateFallbacksConfig
      detectLegacyKeys: typeof index.detectLegacyKeys
      declareSeeds: (
        seeds: readonly index.SeedDeclaration[],
        options?: index.SeedsDeclareOptions,
      ) => Promise<index.SeedDeclareOutcome>
      getEffectiveRoles: () => index.EffectiveRolesReadback
      revertSeededPersona: (id: string) => Promise<index.SeedRevertOutcome>
      getAgentRole: (agentId: string) => string | null
    }>()
    // Session-projection key + guard (plan agent-role-getter): the two
    // package-root re-exports, pinned to their exact literal/signature
    // (`typeof` — value inference would widen the string literal to `string`).
    expectTypeOf<typeof index.ROLE_PROJECTION_KEY>().toEqualTypeOf<'fallbacksSubagentRole'>()
    expectTypeOf<typeof index.readRoleProjectionValue>().toEqualTypeOf<(value: unknown) => string | undefined>()
    // Role-seeds surface (plan fallbacks-role-seeds T2): the §9.1 types
    // re-exported from the package root.
    expectTypeOf<index.SeedDeclaration>().toEqualTypeOf<{ id: string; persona: string }>()
    expectTypeOf<index.SeedSkipReason>().toEqualTypeOf<'invalid-id' | 'reserved-id' | 'duplicate-in-batch'>()
    expectTypeOf<index.SeedConflict>().toEqualTypeOf<{ id: string; kind: 'persona-source' }>()
    expectTypeOf<index.SeedDeclareOutcome>().toEqualTypeOf<{
      applied: string[]
      skipped: Array<{ id: string; reason: index.SeedSkipReason }>
      conflicts: index.SeedConflict[]
    }>()
    expectTypeOf<index.EffectiveRole>().toMatchTypeOf<{
      id: string
      persona: string
      seeded: boolean
      personaOverridden: boolean
      source: index.SeedSource
      seedPersona?: string
    }>()
    expectTypeOf<index.EffectiveRolesReadback>().toEqualTypeOf<{ roles: index.EffectiveRole[] }>()
    expectTypeOf<index.SeedRevertFailReason>().toEqualTypeOf<'not-seeded' | 'row-absent' | 'settings-unavailable'>()
    expectTypeOf<index.SeedRevertOutcome>().toMatchTypeOf<{
      reverted: boolean
      persona?: string
      reason?: index.SeedRevertFailReason
    }>()
    // Seed provenance (seed-source-provenance plan): the per-row source
    // label, the public declare options face (`set` only — the INTERNAL
    // `bundled` marker is module-internal to seeds.ts and never re-exported),
    // and the wire status. `source` is OPTIONAL on the wire: a gateway
    // predating the field (version skew) omits it — consumers treat a
    // missing label as "no badge" (`EffectiveRole.source` stays required).
    expectTypeOf<index.SeedSource>().toEqualTypeOf<'bundled' | 'external' | 'user' | (string & {})>()
    expectTypeOf<index.SeedsDeclareOptions>().toEqualTypeOf<{ set?: string }>()
    expectTypeOf<index.SeedsWireStatus>().toEqualTypeOf<{
      id: string
      overridden: boolean
      source?: index.SeedSource
    }>()
    expectTypeOf<index.SeedsIo>().toEqualTypeOf<{
      read: () => index.FallbacksConfig
      writeRoles: (roles: index.FallbacksRoles) => Promise<void>
    }>()
    expectTypeOf<index.FallbacksSeedManager>().toMatchTypeOf<{
      declare(seeds: readonly index.SeedDeclaration[], io: index.SeedsIo): Promise<index.SeedDeclareOutcome>
      effectiveRoles(io: index.SeedsIo): index.EffectiveRolesReadback
      revert(id: string, io: index.SeedsIo): Promise<index.SeedRevertOutcome>
    }>()
  })
})
