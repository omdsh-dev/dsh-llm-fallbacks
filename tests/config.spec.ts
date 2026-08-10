/**
 * Config schema invariants (spec §4; T2 review Minor #2 — persistent
 * regression protection for the AC-8 no-op default).
 */

import { describe, expect, it } from 'vitest'
import { Config, defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'

describe('fallbacks Config schema', () => {
  it('resolves the empty section to the spec defaults (AC-8 no-op invariant)', () => {
    // The schema call signature is typed for the resolved shape; the empty
    // section is what the settings service / bundle row actually hands it.
    expect(Config({} as FallbacksConfig)).toEqual(defaultFallbacksConfig)
  })

  it('layers partial input over the spec defaults', () => {
    const resolved = Config({
      cooldownMs: 1_000,
      chains: { default: ['other/gpt-4o'] },
    } as unknown as FallbacksConfig)
    expect(resolved.cooldownMs).toBe(1_000)
    expect(resolved.chains).toEqual({ default: ['other/gpt-4o'] })
    // The feature switch defaults OFF (readme-settings spec §1.2); a partial
    // input inherits the new default.
    expect(resolved.enabled).toBe(false)
    expect(resolved.triggerCodes).toEqual(['AUTH', 'QUOTA', 'RATE_LIMIT'])
  })
})
