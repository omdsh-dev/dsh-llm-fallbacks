/**
 * `fallbacks/switch` event contract (plan Task 3 Step 1/6).
 *
 * The augmentation makes the plugin's data type the session-event-map payload
 * for the key (the llm-retry "keeps the payload identical to the session
 * event" assertion pattern), and the payload itself must be lossless-JSON —
 * `Session.append` runtime-validates every event with `isJsonValue`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { FallbacksSwitchEventData, FallbackSwitchReason } from '../src/events.ts'

describe('fallbacks/switch session event', () => {
  it('augments SessionEventMap with the exact event payload type', () => {
    expectTypeOf<SessionEventMap['fallbacks/switch']>().toEqualTypeOf<FallbacksSwitchEventData>()
  })

  it('carries turn/step/from/to/role/reason fields', () => {
    const data: FallbacksSwitchEventData = {
      turn: 1,
      step: 2,
      from: { provider: 'mock', model: 'gpt-4o' },
      to: { provider: 'other', model: 'gpt-4o' },
      role: 'default',
      reason: 'trigger-code',
    }
    expect(data.from).toEqual({ provider: 'mock', model: 'gpt-4o' })
    expect(data.to).toEqual({ provider: 'other', model: 'gpt-4o' })
    expect(data.role).toBe('default')
    expect(['trigger-code', 'always-cap']).toContain(data.reason)
  })

  it('round-trips through JSON (Session.append isJsonValue-safe)', () => {
    const data: FallbacksSwitchEventData = {
      turn: 7,
      step: 3,
      from: { provider: 'a', model: 'm1' },
      to: { provider: 'b', model: 'm2' },
      role: 'reviewer',
      reason: 'always-cap',
    }
    expect(JSON.parse(JSON.stringify(data))).toEqual(data)
  })

  it('only admits the two spec reasons', () => {
    const reasons: FallbackSwitchReason[] = ['trigger-code', 'always-cap']
    expect(reasons).toHaveLength(2)
  })
})
