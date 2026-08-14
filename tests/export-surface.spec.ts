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
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as index from '../src/index.ts'

describe('export surface: runtime values', () => {
  // Export key → expected `typeof` result. `Config` (schemastery schema) and
  // the `SelectorError` class are callable values → 'function'.
  const valueExports: Record<string, string> = {
    // Pre-existing plugin surface — zero regression.
    name: 'string',
    Config: 'function',
    defaultFallbacksConfig: 'object',
    stateStore: 'function',
    countRetryEvents: 'function',
    apply: 'function',
    // Library API functions (plan fallbacks-consumer-api T1).
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
    // Library API values.
    INHERIT_ROLE_ID: 'string',
    ROLE_ID_PATTERN: 'object',
    SelectorError: 'function',
  }

  it.each(Object.entries(valueExports))('exports %s (%s)', (key, expectedType) => {
    expect(index).toHaveProperty(key)
    expect(typeof (index as unknown as Record<string, unknown>)[key]).toBe(expectedType)
  })

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

  it('resolveRole resolves a rule hit from the package root (origin root + provider match)', () => {
    const agent: index.AgentLike = {
      options: { provider: 'openai', model: 'gpt-4o' },
      session: { header: { origin: 'root' } },
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
      rootChain: ['openai/gpt-4o'],
      roles: {
        list: [{ id: 'coder', label: 'Coder', description: '', chain: ['anthropic/claude-3-5-sonnet'] }],
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
  })
})
