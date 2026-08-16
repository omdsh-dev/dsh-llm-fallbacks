/**
 * issue #52 regression pins — the runtime registration seam and the mirrored
 * persistence predicate.
 *
 * `fallbacks/switch` is a type-only augmentation (`src/events.ts`), erased at
 * runtime. The persistence read path (`dsh-session-persistence`
 * `assertEventsSupported`) refuses a log containing an event type outside the
 * host's baked `KNOWN_SESSION_EVENT_TYPES` catalog unless the event carries
 * the envelope's `ignorable` marker — which `Session.append` can never write.
 * The plugin therefore registers the type into the ROOT-exported catalog at
 * apply time; these pins freeze the exact predicate the read path uses, so a
 * future dsh that drops or freezes the mutable root export fails loudly here.
 * The append guard (registration unavailable → durable event skipped) lives
 * in `tests/session-event-registration-guard.spec.ts`.
 *
 * Vitest isolates each test file, so `KNOWN_SESSION_EVENT_TYPES` starts
 * UNREGISTERED in this file — the pre-registration assertions below must
 * stay before any `.add` in this file.
 */

import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { makeAgent, switchEvents } from './support/harness.ts'
import type { FallbacksSwitchEventData } from '../src/events.ts'

/**
 * The exact read-path refusal predicate, mirrored from
 * `dsh-session-persistence` `assertEventsSupported`: a log is refused when
 * the type is unknown AND the event is not marked ignorable.
 */
function refusedByReadPath(type: string, event: { ignorable?: true }): boolean {
  return !KNOWN_SESSION_EVENT_TYPES.has(type) && event.ignorable !== true
}

function switchData(): FallbacksSwitchEventData {
  return {
    turn: 1,
    step: 1,
    from: { provider: 'mock', model: 'gpt-4o' },
    to: { provider: 'other', model: 'gpt-4o' },
    role: 'inherit',
    reason: 'trigger-code',
  }
}

describe('fallbacks/switch registration predicate (issue #52)', () => {
  it('appended switch events carry no ignorable marker and are unknown pre-registration', () => {
    const { agent } = makeAgent('registration-pre', { provider: 'mock', model: 'gpt-4o' })
    agent.session.append('fallbacks/switch', switchData())
    const event = switchEvents(agent)[0] as SessionEvent<'fallbacks/switch'>
    // `Session.append` has no way to write the envelope's `ignorable` marker
    // (seed-only field) — a persisted `fallbacks/switch` is always "required".
    expect(event.ignorable).toBeUndefined()
    // Before the plugin's apply() registration, the baked catalog does not
    // know the type — the read path would refuse the whole session log.
    expect(KNOWN_SESSION_EVENT_TYPES.has('fallbacks/switch')).toBe(false)
    expect(refusedByReadPath('fallbacks/switch', event)).toBe(true)
  })

  it('registers into the mutable root-exported Set (the persistence predicate)', () => {
    // The root export is a plain, unfrozen Set at runtime (the .d.ts only
    // types it as ReadonlySet).
    expect(KNOWN_SESSION_EVENT_TYPES).toBeInstanceOf(Set)
    // Same cast the runtime uses in apply() (src/index.ts).
    const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
    known.add('fallbacks/switch')
    expect(known.has('fallbacks/switch')).toBe(true)
    // Registration flips the mirrored refusal predicate to false — a log
    // written with this event now passes `assertEventsSupported` on load.
    const { agent } = makeAgent('registration-post', { provider: 'mock', model: 'gpt-4o' })
    agent.session.append('fallbacks/switch', switchData())
    const event = switchEvents(agent)[0] as SessionEvent<'fallbacks/switch'>
    expect(event.ignorable).toBeUndefined()
    expect(refusedByReadPath('fallbacks/switch', event)).toBe(false)
  })

  it('registration is idempotent (multi-fiber / re-apply safe)', () => {
    const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
    known.add('fallbacks/switch')
    known.add('fallbacks/switch')
    expect(known.has('fallbacks/switch')).toBe(true)
  })
})
