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
  'countRetryEvents',
  'apply',
  // Library API functions (plan fallbacks-consumer-api T1).
  'resolveRole',
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
  // Bundled preset roles (plan fallbacks-preset-roles T3) — the 7 preset
  // declarations re-exported from the package root (pure data module).
  'presetRoles',
] as const

describe('export surface: runtime values', () => {
  // Export key → expected `typeof` result. `Config` (schemastery schema) and
  // the `SelectorError` class are callable values → 'function'; `provide` is
  // a `readonly ['llm-fallbacks']` array → 'object'.
  const valueExports: Record<string, string> = {
    name: 'string',
    Config: 'function',
    stateStore: 'function',
    countRetryEvents: 'function',
    apply: 'function',
    resolveRole: 'function',
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
    expect(index.defaultFallbacksConfig.enabled).toBe(false)
    expect(index.defaultFallbacksConfig.triggerCodes).toEqual(['AUTH', 'QUOTA', 'RATE_LIMIT'])
  })
})

describe('export surface: callable smokes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolveRole resolves a rule hit from the package root (subagent + provider match)', () => {
    // PR #62 feedback: rules are subagent-only — root requests never match.
    const agent: index.AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'subagent' } },
    }
    expect(
      index.resolveRole(agent, [{ provider: 'openai', role: 'coder' }], new Map([['coder', 'coder']])),
    ).toBe('coder')
  })

  it('validateFallbacksConfig accepts a valid config without warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const validConfig: index.FallbacksConfig = {
      ...index.defaultFallbacksConfig,
      enabled: true,
      // Conforming all-day head (P6): rootChain must start with one official
      // V4 model — a legacy non-official-head chain would now earn a warn.
      rootChain: ['deepseek-official/deepseek-v4-flash'],
      roles: {
        list: [{ id: 'coder', persona: '', chain: ['anthropic/claude-3-5-sonnet'] }],
        rules: [{ origin: 'root', role: 'coder' }],
      },
    }
    index.validateFallbacksConfig(validConfig, { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('detectLegacyKeys flags the removed `chains` key', () => {
    expect(index.detectLegacyKeys({ chains: [] })).toContain('chains')
  })
})

describe('export surface: type exports (compile-time only)', () => {
  it('re-exports the library types from the package root', () => {
    // DEV-TIME pin (F-001/S-2): vitest's esbuild never typechecks tests and
    // CI runs test+build only (build `tsc` covers src), so this block is
    // INERT in CI — it exists for local `tsc` validation (a scratch tsconfig
    // including tests/, or in-editor diagnostics). Keep it in sync when the
    // type surface changes; it is NOT the CI type guard.
    expectTypeOf<index.Origin>().toEqualTypeOf<'root' | 'subagent'>()
    expectTypeOf<index.AgentLike>().toMatchTypeOf<{ options?: { provider?: string } }>()
    expectTypeOf<index.Selector>().toEqualTypeOf<{ provider: string; model?: string; raw: string }>()
    expectTypeOf<index.FailingModel>().toEqualTypeOf<{ provider: string; model: string }>()
    expectTypeOf<index.FallbackStrategy>().toEqualTypeOf<'inherit-root' | 'none'>()
    expectTypeOf<index.RevertPolicy>().toEqualTypeOf<'cooldown-expiry' | 'never'>()
    expectTypeOf<index.CandidateSkipReason>().toEqualTypeOf<
      'same-as-current' | 'cooldown' | 'step-failed' | 'missing-id'
    >()
    expectTypeOf<index.FallbacksConfigLogger>().toMatchTypeOf<{ warn: (message: string) => void }>()
    expectTypeOf<index.FallbacksRoleRule>().toMatchTypeOf<{ role: string; origin?: 'root' | 'subagent' }>()
    expectTypeOf<index.FallbacksRole>().toMatchTypeOf<{
      id: string
      chain?: string[]
      fallback?: index.FallbackStrategy
    }>()
    expectTypeOf<index.FallbacksRoles>().toMatchTypeOf<{
      list: index.FallbacksRole[]
      rules: index.FallbacksRoleRule[]
    }>()
    expectTypeOf<index.FallbacksConfig>().toMatchTypeOf<{
      enabled: boolean
      rootChain: string[]
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
    expectTypeOf<index.PendingSwitch>().toMatchTypeOf<{ role: string; reason: index.FallbackSwitchReason }>()
    expectTypeOf<index.AgentFallbackState>().toMatchTypeOf<{ pendingSwitch?: index.PendingSwitch }>()
    expectTypeOf<index.StepFailures>().toMatchTypeOf<{ turn: number; step: number }>()
    expectTypeOf<index.FallbackStateStore>().toMatchTypeOf<object>()
    // Service contract (plan fallbacks-consumer-api T2 + fallbacks-role-seeds
    // T2): the static `provide` metadata value and the `FallbacksService`
    // interface (the typed `ctx.get('llm-fallbacks')` surface via the cordis
    // Context merge). Nine keys — the six-key face plus the three additive
    // seed methods (D7).
    expectTypeOf(index.provide).toEqualTypeOf<readonly ['llm-fallbacks']>()
    expectTypeOf<index.FallbacksService>().toEqualTypeOf<{
      name: 'llm-fallbacks'
      version: string
      resolveRole: typeof index.resolveRole
      resolveChain: typeof index.resolveChain
      validateFallbacksConfig: typeof index.validateFallbacksConfig
      detectLegacyKeys: typeof index.detectLegacyKeys
      declareSeeds: (seeds: readonly index.SeedDeclaration[]) => Promise<index.SeedDeclareOutcome>
      getEffectiveRoles: () => index.EffectiveRolesReadback
      revertSeededPersona: (id: string) => Promise<index.SeedRevertOutcome>
    }>()
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
      seedPersona?: string
    }>()
    expectTypeOf<index.EffectiveRolesReadback>().toEqualTypeOf<{ roles: index.EffectiveRole[] }>()
    expectTypeOf<index.SeedRevertFailReason>().toEqualTypeOf<'not-seeded' | 'row-absent' | 'settings-unavailable'>()
    expectTypeOf<index.SeedRevertOutcome>().toMatchTypeOf<{
      reverted: boolean
      persona?: string
      reason?: index.SeedRevertFailReason
    }>()
    expectTypeOf<index.SeedsWireStatus>().toEqualTypeOf<{ id: string; overridden: boolean }>()
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
