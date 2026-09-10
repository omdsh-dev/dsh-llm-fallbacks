/**
 * Durable role visibility for the session-header badge (plan
 * role-based-subagent-adoption Task 3b).
 *
 * STEP 0 (blocking, in-process): the FIRST describe proves the channel the task
 * deletes other code for — the unit really registers on the REAL
 * `ctx.sessionProjections` registry through `ctx.inject([...])`, its pure fold
 * really derives the role from a REAL Task 3 notice row, and the value really is
 * exposed under the projection key as the client-visible wire value. The LIVE
 * half (a settled child's `/api/session/follow` opening frame carrying the key
 * for a `kind: 'subagent'` address) stays QA's item — it needs a running host.
 *
 * The remaining cases pin the fold's contract: role parsed from the CONTENT when
 * the summary is truncated, foreign/malformed rows ignored (never a wrong role),
 * idempotence (the same state reference, so the registry publishes nothing), the
 * persisted-state guard, and the contained degrade when the registry refuses or
 * a second apply shares the key.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.ts'
import { buildRoleNotice, ROLE_NOTICE_PLUGIN } from '../src/role-notice.ts'
import { installRoleProjection, roleProjectionUnit, ROLE_PROJECTION_STATE_VERSION } from '../src/role-projection.ts'
import { ROLE_PROJECTION_KEY } from '../src/role-projection-key.ts'
import { MemorySettings } from './support/memory-settings.ts'
import { cfg } from './support/harness.ts'

/**
 * The registry READ faces this spec asserts through (the registry's own typed
 * `snapshot`/`stateOf` are keyed by the host's merged `SessionProjectionMap`,
 * which does not carry a third-party key — the same structural read the badge
 * does with `useProjection`).
 */
interface RegistryReadView {
  stateOf(session: Session, key: string): unknown
  snapshot(session: Session, keys?: readonly string[]): { asOfSeq: number; values: Record<string, unknown> }
}

/** One committed `user/message` event carrying a real message value. */
function messageEvent(seq: number, message: UserMessage): SessionEvent {
  return { type: 'user/message', seq, time: 1_725_900_000_000 + seq, data: message } as unknown as SessionEvent
}

/**
 * Minimal Session stand-in for the registry's read path: `header`,
 * `inheritedEventCount`, `seq` (the NEXT event's number), `snapshotEvents` and
 * `eventAt` — the complete surface `buildCell` / `advanceCell` touch.
 */
function fakeSession(events: readonly SessionEvent[]): Session {
  const log = [...events]
  return {
    header: { origin: 'subagent' },
    inheritedEventCount: 0,
    get seq() {
      return log.length
    },
    snapshotEvents: (from = 0, to = log.length) => log.slice(from as number, to as number),
    eventAt: (seq: number) => log[seq],
  } as unknown as Session
}

/** A message from ANOTHER plugin carrying the same text shape (the foreign row). */
function foreignNotice(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'someone-else', form: 'notice', summary: text },
  })
}

/** A message from THIS plugin whose content is not a notice. */
function ownNonNoticeRow(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN, form: 'notice', summary: text },
  })
}

let ctx: Context

afterEach(async () => {
  await ctx?.fiber.dispose()
})

/** Register the real registry and return its read face + the fold's key state. */
function withRegistry(): { registry: RegistryReadView } {
  ctx = new Context()
  new SessionProjectionRegistry(ctx)
  return { registry: ctx.sessionProjections as unknown as RegistryReadView }
}

describe('role projection — Step 0 channel proof (registry + ctx.inject + key exposure)', () => {
  it('registers on ctx.sessionProjections through ctx.inject and exposes the folded role under the key', async () => {
    const { registry } = withRegistry()
    const session = fakeSession([messageEvent(0, buildRoleNotice('coder', false))])
    const before = registry.snapshot(session, [ROLE_PROJECTION_KEY])

    // Before the install the key is not registered at all: stateOf answers
    // `undefined` and the wire block omits the key (capability absence).
    expect(registry.stateOf(session, ROLE_PROJECTION_KEY)).toBeUndefined()
    expect(ROLE_PROJECTION_KEY in before.values).toBe(false)

    installRoleProjection(ctx)
    // The conditional-inject child applies on its own fiber.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // (i) registered, (ii) the fold derived the role from the notice row,
    // (iii) the value is exposed under the projection key. `stateOf` is the host
    // FOLD state; the wire block carries the role id itself, which is what the
    // client's `useProjection` seat reads.
    expect(registry.stateOf(session, ROLE_PROJECTION_KEY)).toEqual({ role: 'coder' })
    const after = registry.snapshot(session, [ROLE_PROJECTION_KEY])
    expect(after.values[ROLE_PROJECTION_KEY]).toBe('coder')
    // The wire value is produced at the cut of the last folded event — proving
    // the value rides the same snapshot block a follow opening frame carries.
    expect(after.asOfSeq).toBe(0)
  })

  it('derives the role from the notice row content even when the summary is truncated', async () => {
    const { registry } = withRegistry()
    // A role id past the 120-char summary bound: the summary cannot carry it,
    // the content can. This is the discriminating case for the "never
    // source.summary" rule.
    const longRole = `role-${'x'.repeat(140)}`
    const notice = buildRoleNotice(longRole, false)
    expect(notice.source.kind).toBe('plugin')
    if (notice.source.kind !== 'plugin' || notice.source.form !== 'notice') throw new Error('unexpected notice source')
    expect(notice.source.summary.length).toBeLessThan(longRole.length)
    expect(notice.source.summary).not.toContain(longRole)

    installRoleProjection(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(registry.snapshot(fakeSession([messageEvent(0, notice)])).values[ROLE_PROJECTION_KEY]).toBe(longRole)

    // …and an EMPTY summary changes nothing: the fold never reads it at all, so
    // a row whose summary is missing/blank still yields the content's role.
    const noSummary = createUserMessage({
      content: [{ type: 'text', text: '[role: scout]' }],
      source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN, form: 'notice', summary: '' },
    })
    expect(registry.snapshot(fakeSession([messageEvent(0, noSummary)])).values[ROLE_PROJECTION_KEY]).toBe('scout')
  })

  it('answers null for a log with no notice row (and for an empty log)', async () => {
    const { registry } = withRegistry()
    installRoleProjection(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(registry.snapshot(fakeSession([])).values[ROLE_PROJECTION_KEY]).toBeNull()
    // A root session's own traffic carries the key too — always `null` unless a
    // notice row is present, so the badge never invents a role.
    const other = fakeSession([messageEvent(0, createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))])
    expect(registry.snapshot(other).values[ROLE_PROJECTION_KEY]).toBeNull()
  })
})

describe('role projection — fold contract', () => {
  it('ignores foreign, unrelated and textless rows (never a wrong role)', async () => {
    const { registry } = withRegistry()
    installRoleProjection(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const cases: UserMessage[] = [
      // Another plugin's notice with the exact text shape.
      foreignNotice('[role: evil]'),
      // Our provenance, but the content is not a notice.
      ownNonNoticeRow('just a note'),
      // Our provenance, notice text EMBEDDED in other text (a prose quote).
      ownNonNoticeRow('see [role: evil] in the docs'),
      // Our provenance, a notice with no captureable id.
      ownNonNoticeRow('[role: ]'),
      // Our provenance, a non-text block only.
      createUserMessage({ content: [{ type: 'image', attachment: { id: 'a1' } } as never], source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN, form: 'notice', summary: 'role: evil' } }),
    ]
    for (const [index, message] of cases.entries()) {
      expect(registry.snapshot(fakeSession([messageEvent(0, message)])).values[ROLE_PROJECTION_KEY]).toBeNull()
      // Positive control on the same fold path: the REAL notice in the same
      // position DOES yield a role, so "null" above is discrimination, not a
      // fold that never runs.
      expect(
        registry.snapshot(fakeSession([messageEvent(0, message), messageEvent(1, buildRoleNotice(`real-${index}`, false))]))
          .values[ROLE_PROJECTION_KEY],
      ).toBe(`real-${index}`)
    }
  })

  it('keeps the DECLARED RAW role id verbatim (padding included) and note the persona suffix', () => {
    const padded = roleProjectionUnit.apply(null, messageEvent(0, buildRoleNotice(' padded ', false)))
    expect(padded).toEqual({ role: ' padded ' })
    // ` (persona not applied)` is part of the row, not of the role.
    expect(roleProjectionUnit.apply(null, messageEvent(0, buildRoleNotice('coder', true))))
      .toEqual({ role: 'coder' })
  })

  it('is idempotent: any other event and a repeated notice return the SAME state reference', () => {
    const notice = messageEvent(0, buildRoleNotice('coder', false))
    const state = roleProjectionUnit.apply(null, notice)
    expect(state).toEqual({ role: 'coder' })
    // The registry publishes only when `!Object.is(next, previous)`, so the fold
    // must not allocate for an event it does not use — and a replayed notice must
    // not re-derive an equal-but-fresh state either.
    expect(roleProjectionUnit.apply(state, notice)).toBe(state)
    expect(roleProjectionUnit.apply(state, messageEvent(1, createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })))).toBe(state)
    expect(roleProjectionUnit.apply(state, { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: 'completed' } } as unknown as SessionEvent)).toBe(state)
    // A foreign notice is unusable, so the state stands too.
    expect(roleProjectionUnit.apply(state, messageEvent(3, foreignNotice('[role: evil]')))).toBe(state)
    // Last-wins when a LATER own notice names another role (a re-dispatch): a NEW
    // reference, which is what makes the registry republish.
    const reDispatched = roleProjectionUnit.apply(state, messageEvent(4, buildRoleNotice('reviewer', false)))
    expect(reDispatched).toEqual({ role: 'reviewer' })
    expect(reDispatched).not.toBe(state)
  })

  it('degrades on a malformed or reshaped event instead of throwing (the host folds unguarded)', () => {
    // The registry calls `def.apply` with NO try/catch inside the host's
    // `session/event` pipeline (`dsh-session-projection` `lib/index.js`), so a
    // repaired/foreign row must read as "not a notice" — a throw here would fail
    // the session read (plan Global Constraints: degrade-never-crash).
    const state = { role: 'coder' }
    const noticeText = (text: string, source: unknown): unknown => ({
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { content: [{ type: 'text', text }], source },
    })
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      {},
      { type: 'user/message' },
      { type: 'user/message', data: null },
      { type: 'user/message', data: 'nope' },
      { type: 'user/message', data: {} },
      // OUR provenance but no content at all.
      { type: 'user/message', data: { source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN } } },
      // A notice text with no source (a repaired row).
      { type: 'user/message', data: { content: [{ type: 'text', text: '[role: evil]' }] } },
      noticeText('[role: evil]', null),
      noticeText('[role: evil]', { kind: 'user' }),
      noticeText('[role: evil]', { kind: 'plugin' }),
      // OUR provenance, content of the wrong shape.
      { type: 'user/message', data: { content: 'not an array', source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN } } },
      { type: 'user/message', data: { content: [null, 42, { type: 'text' }, { type: 'text', text: 7 }], source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN } } },
    ]
    for (const event of malformed) {
      expect(() => roleProjectionUnit.apply(state, event as SessionEvent)).not.toThrow()
      // …and the state STANDS (the registry publishes only on `!Object.is`), so
      // an unexpected shape can never clear or invent a role.
      expect(roleProjectionUnit.apply(state, event as SessionEvent)).toBe(state)
    }
    // Positive control on the same fold path: the REAL notice still folds.
    expect(roleProjectionUnit.apply(state, messageEvent(9, buildRoleNotice('reviewer', false))))
      .toEqual({ role: 'reviewer' })
  })

  it('parses a role id that itself ends in the persona suffix, exactly (never trimmed)', () => {
    // The skip suffix is part of the notice GRAMMAR (an optional group AFTER the
    // closing bracket), never stripped off the text beforehand — so an id
    // DECLARED as ending in the suffix literal survives whole, with and without
    // the writer's appended skip suffix (Task 3b L2 review M-5).
    const id = 'audit (persona not applied)'
    expect(roleProjectionUnit.apply(null, messageEvent(0, buildRoleNotice(id, false))))
      .toEqual({ role: id })
    expect(roleProjectionUnit.apply(null, messageEvent(1, buildRoleNotice(id, true))))
      .toEqual({ role: id })
    // Exactness cuts both ways: a text the writer cannot produce (TWO appended
    // suffixes) is not the notice grammar, so it carries no role at all rather
    // than a half-trimmed one.
    expect(roleProjectionUnit.apply(null, {
      type: 'user/message',
      seq: 2,
      time: 0,
      data: {
        content: [{ type: 'text', text: '[role: scout] (persona not applied) (persona not applied)' }],
        source: { kind: 'plugin', plugin: ROLE_NOTICE_PLUGIN },
      },
    } as unknown as SessionEvent)).toBeNull()
  })

  it('validates the persisted state, so a corrupt checkpoint row is rejected instead of served', () => {
    expect(roleProjectionUnit.stateSchema.parse(null)).toBeNull()
    expect(roleProjectionUnit.stateSchema.parse({ role: 'coder', extra: 1 })).toEqual({ role: 'coder' })
    expect(() => roleProjectionUnit.stateSchema.parse('coder')).toThrow()
    expect(() => roleProjectionUnit.stateSchema.parse({ role: '' })).toThrow()
    expect(() => roleProjectionUnit.stateSchema.parse({ role: 42 })).toThrow()
    expect(() => roleProjectionUnit.stateSchema.parse(undefined)).toThrow()
    // The WIRE value carries the role id itself (not the fold's object shape),
    // and passes its own guard on every client-visible read.
    expect(roleProjectionUnit.wire.view(roleProjectionUnit.stateSchema.parse({ role: 'coder' }))).toBe('coder')
    expect(roleProjectionUnit.wire.view(null)).toBeNull()
    expect(() => roleProjectionUnit.wire.viewSchema.parse({ role: 'coder' })).toThrow()
    expect(() => roleProjectionUnit.wire.viewSchema.parse(42)).toThrow()
  })

  it('declares a safe stateVersion (the persisted-row invalidation key)', () => {
    // The registry REJECTS a non-safe-integer / negative version, and a version
    // bump is the only way a changed fold invalidates stored rows — so it is a
    // deliberate constant, pinned here rather than inlined at the definition.
    expect(roleProjectionUnit.stateVersion).toBe(ROLE_PROJECTION_STATE_VERSION)
    expect(Number.isSafeInteger(roleProjectionUnit.stateVersion)).toBe(true)
    expect(roleProjectionUnit.stateVersion).toBeGreaterThanOrEqual(0)
  })
})

describe('role projection — install shape', () => {
  it('registers through the plugin install point and survives a second apply (shared-key dedupe)', async () => {
    const { registry } = withRegistry()
    await ctx.plugin(MemorySettings)
    const session = fakeSession([messageEvent(0, buildRoleNotice('scout', false))])

    apply(ctx, cfg())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registry.snapshot(session).values[ROLE_PROJECTION_KEY]).toBe('scout')

    // A later fiber over the same root: the seam is deduped, so the projection
    // is registered by the FIRST fiber only — and even a direct second install
    // would be counted by the registry (one unit per key+stateVersion). Neither
    // path may throw.
    expect(() => apply(ctx, cfg())).not.toThrow()
    installRoleProjection(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registry.snapshot(session).values[ROLE_PROJECTION_KEY]).toBe('scout')
  })

  it('degrades with ONE contained debug line when the registry refuses the unit', async () => {
    ctx = new Context()
    const debug = vi.fn()
    ctx.provide('sessionProjections', {
      register() {
        throw new Error('registry boom')
      },
    })

    expect(() => installRoleProjection(ctx, { debug })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('registry boom')
  })

  it('degrades with ONE contained debug line when the resolved service is not a registry', async () => {
    ctx = new Context()
    const debug = vi.fn()
    ctx.provide('sessionProjections', { notARegistry: true })

    installRoleProjection(ctx, { debug })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('not a registry')
  })

  it('withdraws the key when the install is disposed', async () => {
    const { registry } = withRegistry()
    const session = fakeSession([messageEvent(0, buildRoleNotice('coder', false))])
    const dispose = installRoleProjection(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registry.snapshot(session).values[ROLE_PROJECTION_KEY]).toBe('coder')

    dispose()
    // `Fiber.dispose()` settles asynchronously (cordis), so the key withdrawal
    // lands on the next tick — the plugin's own fiber teardown awaits the same
    // chain.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registry.snapshot(session).values[ROLE_PROJECTION_KEY]).toBeUndefined()
  })
})
