/**
 * Subagent policy reader tests (plan dsh-012-subagent-routing T1; spec D1).
 *
 * The reader is a pure, host-free module: plain event descriptors and a plain
 * settings snapshot in, an EffectivePolicy out. It never throws — a policy
 * that is present but unreadable resolves to `'unprovable'` (fail-closed) so
 * no plugin-originated route can be emitted without proof it is allowed.
 * The session event wins over settings (ADR read order).
 */

import { describe, expect, it } from 'vitest'
import { effectivePolicy, readSessionPolicyEvent } from '../src/subagent-policy.ts'
import type { EffectivePolicy, SessionPolicyEventRead } from '../src/subagent-policy.ts'

const routeA = { provider: 'deepseek', model: 'deepseek-chat' }
const routeB = { provider: 'openai', model: 'gpt-5.2' }

describe('readSessionPolicyEvent + effectivePolicy', () => {
  it('event present + valid payload → enabled with a detached list; the event wins over settings', () => {
    const payload = { allowedModels: [{ ...routeA }] }
    const read = readSessionPolicyEvent([{ type: 'subagent/model-selection-policy', data: payload }])
    expect(read).toEqual({ ok: true, allowedModels: [routeA] })
    // Detached: the result never aliases the session payload's route objects.
    if (read.ok) expect(read.allowedModels[0]).not.toBe(payload.allowedModels[0])

    const policy = effectivePolicy(read, { enabled: true, allowedModels: [routeB] })
    expect(policy).toEqual({ state: 'enabled', allowedModels: [routeA] })
    if (policy.state === 'enabled') expect(policy.allowedModels[0]).not.toBe(payload.allowedModels[0])
  })

  it('event absent + settings enabled:true + valid list → enabled', () => {
    const read = readSessionPolicyEvent([])
    expect(read).toEqual({ ok: false, present: false })
    const policy = effectivePolicy(read, { enabled: true, allowedModels: [routeA, routeB] })
    expect(policy).toEqual({ state: 'enabled', allowedModels: [routeA, routeB] })
  })

  it('event absent + settings absent or enabled:false → disabled', () => {
    const read = readSessionPolicyEvent([{ type: 'unrelated/event', data: { allowedModels: [routeA] } }])
    expect(read).toEqual({ ok: false, present: false })
    expect(effectivePolicy(read, undefined)).toEqual({ state: 'disabled' })
    expect(effectivePolicy(read, { enabled: false, allowedModels: [routeA] })).toEqual({ state: 'disabled' })
  })

  it('event present + malformed payload (non-array / non-string ids / empty list) → unprovable, no throw', () => {
    const malformedPayloads: unknown[] = [
      undefined,
      'allowedModels',
      { allowedModels: 'nope' },
      { allowedModels: [{ provider: 42, model: 'deepseek-chat' }] },
      { allowedModels: [{ provider: 'deepseek' }] },
      { allowedModels: [{ provider: '', model: 'deepseek-chat' }] },
      { allowedModels: [] },
    ]
    for (const data of malformedPayloads) {
      let read: SessionPolicyEventRead | undefined
      expect(() => { read = readSessionPolicyEvent([{ type: 'subagent/model-selection-policy', data }]) }).not.toThrow()
      expect(read).toEqual({ ok: false, present: true })
      // Fail-closed even when settings alone would prove an allowlist.
      expect(effectivePolicy(read!, { enabled: true, allowedModels: [routeA] })).toEqual({ state: 'unprovable' })
    }
  })

  it('settings enabled:true + malformed list → unprovable, no throw', () => {
    const read = readSessionPolicyEvent([])
    const malformedSettings: unknown[] = [
      'nope',
      [{ provider: 42, model: 'deepseek-chat' }],
      [{ provider: 'deepseek' }],
      [{ provider: '', model: 'deepseek-chat' }],
      [],
    ]
    for (const allowedModels of malformedSettings) {
      let policy: EffectivePolicy | undefined
      expect(() => {
        policy = effectivePolicy(read, { enabled: true, allowedModels: allowedModels as never })
      }).not.toThrow()
      expect(policy).toEqual({ state: 'unprovable' })
    }
  })
})
