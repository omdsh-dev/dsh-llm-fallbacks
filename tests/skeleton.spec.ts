/**
 * Skeleton smoke test (Task 1): keeps the declared `test` script green and
 * pins the bundle contract the later tasks build on — the plugin row id, the
 * (empty) config schema, and the client entry surface.
 */

import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../src/index.ts'
import { apply as clientApply } from '../src/client/index.ts'

describe('dsh-llm-fallbacks skeleton', () => {
  it('exposes the bundle patch row id', () => {
    expect(name).toBe('llm-fallbacks')
  })

  it('accepts an empty config against the placeholder schema', () => {
    expect(() => Config({})).not.toThrow()
  })

  it('exports host and client apply entries', () => {
    expect(typeof apply).toBe('function')
    expect(typeof clientApply).toBe('function')
  })
})
