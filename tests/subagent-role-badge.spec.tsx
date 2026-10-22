// @vitest-environment jsdom
/**
 * Session-header subagent role/model badge (plan subagent-role-badge T3 + T4
 * case f; plan subagent-role-model extends it with the model half).
 *
 * The badge is rendered over the REAL session-kit seat shapes: a scripted
 * `useProjection(key)` reader plus a scripted `useSessions(selector)` store, i.e.
 * exactly what the ui-session binding hands a `scope: 'session'` occupant. Pins:
 *
 * - the badge belongs to the viewed CHILD session: a root session renders
 *   nothing even when its own `modelSelection` carries a route (its composer
 *   owns that control);
 * - a child with a role and a route renders `role · provider/model`; the hover
 *   is `role → provider/model (request route)`;
 * - the route is `modelSelection.next` (the route the next request uses),
 *   falling back to `lastUsed`; either half alone still renders, and a malformed
 *   route is dropped instead of rendered wrong;
 * - an absent/foreign/blank role, a `null` wire value and an `inherit` value
 *   simply omit the role half — degrade-never-crash, never a placeholder;
 * - a version-skewed host without the session standard kit renders nothing and
 *   reads no projection at all;
 * - the seats are REAL hooks, so the projection reads are unconditional and the
 *   hook count is constant across re-renders: a role that APPEARS on an in-place
 *   re-render (the running child whose notice row just landed) and one that
 *   disappears must both render without React's "Rendered more hooks than
 *   during the previous render" invariant (Task 3b L2 review C-1).
 */

import { useSyncExternalStore } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubagentRoleBadge } from '../src/client/SubagentRoleBadge.tsx'
import type { SubagentRoleBadgeProps } from '../src/client/SubagentRoleBadge.tsx'
import { ROLE_PROJECTION_KEY } from '../src/role-projection-key.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Interpolating en `t` seat (the conversation-switch spec pattern): the real
 * framework seat synthesizes `{name}` interpolation from the dictionary's
 * declared placeholders — `subagentRole.hover` needs it.
 */
const t = ((key: string, params?: Record<string, unknown>) => {
  let text: string = en[key as keyof typeof en]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  }
  return text
}) as SubagentRoleBadgeProps['t']

/** The host's model-selection projection value carrying a route. */
function selection(provider: string, model: string, lastUsed: string | null = null): unknown {
  return {
    next: { provider, model },
    lastUsed: lastUsed === null ? null : { provider, model: lastUsed },
  }
}

/**
 * The viewed session's store row, as the shared Session store publishes it:
 * `origin` is `'subagent'` only for a subagent row, root rows simply omit the
 * key (`SessionSummary.origin?: 'subagent'`), and `empty` is the
 * pre-materialization window.
 */
function sessionsStore(kind: 'subagent' | 'root' | 'empty'): unknown {
  if (kind === 'empty') return { byId: {} }
  if (kind === 'root') return { byId: { 'viewed-session': {} } }
  return { byId: { 'viewed-session': { origin: 'subagent' } } }
}

/** The scripted `useSessions` seat: a selector over one fixed store row. */
function sessionsSeat(kind: 'subagent' | 'root' | 'empty'): SubagentRoleBadgeProps['useSessions'] {
  return ((selector: (state: unknown) => unknown) => selector(sessionsStore(kind))) as never
}

/**
 * The props the actions-slot outlet would bind: runtime share (the
 * conversation-merged standard-kit members are `as never` — the card/row spec
 * pattern; `useProjection` / `useSessions` are the ui-session merge NOT carried by
 * this program's peer types, so the real seats cross the same structural cast the
 * component reads them through) plus the locale seat.
 */
function propsWithSeat(
  useProjection: (key: string) => unknown,
  origin: 'subagent' | 'root' | 'empty' = 'subagent',
  useSessions: unknown = sessionsSeat(origin),
): SubagentRoleBadgeProps {
  return {
    t,
    sessionId: 'viewed-session',
    useProjection: useProjection as never,
    useSessions: useSessions as never,
    useWorkspaces: undefined as never,
    useConversation: undefined as never,
    useInput: undefined as never,
    inputActions: undefined as never,
  } as never as SubagentRoleBadgeProps
}

/** The scripted seat: a `key → value` map lookup, no React hook involved. */
function badgeProps(
  projections: Record<string, unknown>,
  origin: 'subagent' | 'root' | 'empty' = 'subagent',
): SubagentRoleBadgeProps {
  return propsWithSeat(vi.fn((key: string) => projections[key]), origin)
}

/** The rendered pill (the outer span; the route is its only child span). */
function pillOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('span')
}

/** A subscription that never fires: the transitions under test are re-renders. */
const neverNotifies = (): (() => void) => () => {}

/**
 * The seat shape the HOST binds: `useProjection` is not a plain getter, it is
 * `keyedObservableHook` → `observableHook` → `useSyncExternalStore` — one real
 * React hook per call, at a fixed call position
 * (`dsh-client-ui-renderer/lib/client.js:233-241`). The scripted seat below
 * therefore calls a genuine React store hook, which is exactly what turns a
 * variable seat-call count into the framework invariant instead of an invisible
 * test artifact.
 */
function hookSeat(store: { values: Record<string, unknown> }): (key: string) => unknown {
  return (key) => useSyncExternalStore(neverNotifies, () => store.values[key])
}

describe('SubagentRoleBadge — projection value', () => {
  it('renders role · route with the role → request route hover', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: selection('anthropic', 'claude-sonnet-4'),
    })} />)

    const pill = pillOf(container)
    expect(pill?.textContent).toBe('coder · anthropic/claude-sonnet-4')
    expect(pill?.getAttribute('title')).toBe('coder → anthropic/claude-sonnet-4 (request route)')
  })

  it('prefers the next route over a DIFFERENT last used route', () => {
    // The one semantic this change introduces: `next ?? lastUsed`, never the
    // reverse. A flipped implementation must fail here.
    const { container } = render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: {
        next: { provider: 'next-provider', model: 'next-model' },
        lastUsed: { provider: 'used-provider', model: 'used-model' },
      },
    })} />)

    expect(pillOf(container)?.textContent).toBe('coder · next-provider/next-model')
  })

  it('falls through a malformed next route to the last used one', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: {
        next: { provider: '', model: 'broken' },
        lastUsed: { provider: 'used-provider', model: 'used-model' },
      },
    })} />)

    expect(pillOf(container)?.textContent).toBe('coder · used-provider/used-model')
  })

  it('falls back to the last used route when no next route is recorded', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: { next: null, lastUsed: { provider: 'anthropic', model: 'claude-sonnet-4' } },
    })} />)

    expect(pillOf(container)?.textContent).toBe('coder · anthropic/claude-sonnet-4')
  })

  it('renders role-only (title = the role) when no route is known', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({ [ROLE_PROJECTION_KEY]: 'scout' })} />)

    const pill = pillOf(container)
    expect(pill?.textContent).toBe('scout')
    expect(pill?.getAttribute('title')).toBe('scout')
  })

  it('renders route-only when the role is absent, null or inherit', () => {
    for (const role of [undefined, null, 'inherit']) {
      cleanup()
      const { container } = render(<SubagentRoleBadge {...badgeProps({
        [ROLE_PROJECTION_KEY]: role,
        modelSelection: selection('anthropic', 'claude-sonnet-4'),
      })} />)

      const pill = pillOf(container)
      expect(pill?.textContent).toBe('anthropic/claude-sonnet-4')
      expect(pill?.getAttribute('title')).toBe('anthropic/claude-sonnet-4')
    }
  })

  it('drops a malformed route instead of rendering a wrong one', () => {
    const cases: unknown[] = [
      null,
      42,
      {},
      { next: null, lastUsed: null },
      { next: {} },
      { next: { provider: 'anthropic' } },
      { next: { provider: '', model: 'claude-sonnet-4' } },
      { next: { provider: '   ', model: 'claude-sonnet-4' } },
      { next: { provider: 'anthropic', model: '   ' } },
      { next: { provider: 'anthropic', model: 7 } },
    ]
    for (const modelSelection of cases) {
      cleanup()
      const { container } = render(<SubagentRoleBadge {...badgeProps({ [ROLE_PROJECTION_KEY]: 'coder', modelSelection })} />)
      const pill = pillOf(container)
      expect(pill?.textContent).toBe('coder')
      expect(pill?.getAttribute('title')).toBe('coder')
    }
  })

  it('trims a padded route, leaving the display cap to the pill body', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: { next: { provider: ' anthropic ', model: ' claude-sonnet-4 ' } },
    })} />)
    expect(pillOf(container)?.textContent).toBe('coder · anthropic/claude-sonnet-4')
  })

  it('truncates a >120-char route in the pill body but keeps the whole route in the title', () => {
    // The body is display-capped; the native title is the hover recovery path, so
    // it must carry the full `provider/model` even beside a role half.
    const route = `anthropic/${'m'.repeat(200)}`
    const { container } = render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: { next: { provider: 'anthropic', model: 'm'.repeat(200) } },
    })} />)

    const pill = pillOf(container)
    expect(pill?.textContent).toBe(`coder · ${route.slice(0, 119)}…`)
    expect(pill?.textContent?.endsWith('…')).toBe(true)
    expect(pill?.getAttribute('title')).toBe(`coder → ${route} (request route)`)
  })

  it('renders nothing for an absent, null, blank or foreign role with no route', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { [ROLE_PROJECTION_KEY]: undefined },
      { [ROLE_PROJECTION_KEY]: null },
      { [ROLE_PROJECTION_KEY]: '' },
      { [ROLE_PROJECTION_KEY]: '   ' },
      { [ROLE_PROJECTION_KEY]: 42 },
      { [ROLE_PROJECTION_KEY]: { role: 'coder' } },
      // The writer never records `inherit` (Task 1 resolves it to no role), so a
      // wire value claiming it is skew — never badge it as a role.
      { [ROLE_PROJECTION_KEY]: 'inherit' },
    ]
    for (const projections of cases) {
      cleanup()
      const { container } = render(<SubagentRoleBadge {...badgeProps(projections)} />)
      expect(container.firstChild).toBeNull()
    }
  })

  it('renders nothing on a ROOT session, even when its own model route is known', () => {
    // Root rows OMIT `origin` (the host type is `origin?: 'subagent'`), and the
    // pre-materialization window has no row at all: neither may show the badge,
    // with a model route AND a role value both present.
    for (const origin of ['root', 'empty'] as const) {
      cleanup()
      const { container } = render(<SubagentRoleBadge {...badgeProps({
        [ROLE_PROJECTION_KEY]: 'coder',
        modelSelection: selection('anthropic', 'claude-sonnet-4'),
      }, origin)} />)
      expect(container.firstChild).toBeNull()
    }
  })

  it('renders a padded DECLARED role id verbatim (the projection carries the raw id)', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({ [ROLE_PROJECTION_KEY]: ' padded ' })} />)
    expect(pillOf(container)?.textContent).toBe(' padded ')
  })
})

describe('SubagentRoleBadge — hook order across re-renders (C-1)', () => {
  it('renders the pill when the role APPEARS on an in-place re-render (absent → present)', () => {
    // The headline live path: a running child is viewed while its log still has
    // no notice row, then the row lands and the registry publishes — the seat
    // starts answering a role and the component re-renders IN PLACE. The pre-fix
    // component called the seat a SECOND time only on this render, so React 18
    // threw "Rendered more hooks than during the previous render" instead of
    // showing the pill.
    const store = { values: {} as Record<string, unknown> }
    const props = propsWithSeat(hookSeat(store))
    const { container, rerender } = render(<SubagentRoleBadge {...props} />)
    expect(container.firstChild).toBeNull()

    store.values[ROLE_PROJECTION_KEY] = 'coder'
    rerender(<SubagentRoleBadge {...props} />)

    expect(screen.getByText('coder')).toBeTruthy()
  })

  it('drops the pill when the role DISAPPEARS on an in-place re-render (present → absent)', () => {
    // The reverse transition is a hook-count change too (2 → 1 pre-fix): a
    // session whose value goes away while the occupant stays mounted.
    const store = { values: { [ROLE_PROJECTION_KEY]: 'coder' } as Record<string, unknown> }
    const props = propsWithSeat(hookSeat(store))
    const { container, rerender } = render(<SubagentRoleBadge {...props} />)
    expect(screen.getByText('coder')).toBeTruthy()

    store.values[ROLE_PROJECTION_KEY] = null
    rerender(<SubagentRoleBadge {...props} />)

    expect(container.firstChild).toBeNull()
  })

  it('renders the pill when a session MATERIALIZES as a subagent on an in-place re-render (empty → subagent)', () => {
    // The viewed session has no store row yet (the pre-materialization window),
    // then the store materializes it as a subagent AND the role lands on the
    // same re-render. A projection read below the child gate would change the
    // hook count here; the pill must simply appear.
    const projections = { values: {} as Record<string, unknown> }
    const sessions = { byId: {} as Record<string, { origin?: string }> }
    const useSessions = ((selector: (state: unknown) => unknown) =>
      useSyncExternalStore(neverNotifies, () => selector(sessions))) as never
    const props = propsWithSeat(hookSeat(projections), 'empty', useSessions)
    const { container, rerender } = render(<SubagentRoleBadge {...props} />)
    expect(container.firstChild).toBeNull()

    sessions.byId['viewed-session'] = { origin: 'subagent' }
    projections.values[ROLE_PROJECTION_KEY] = 'coder'
    rerender(<SubagentRoleBadge {...props} />)

    expect(screen.getByText('coder')).toBeTruthy()
  })

  it('reads BOTH projection seats on every render, even when the role is absent or inherit', () => {
    // Unconditional read, before any value guard — the hook count may not depend
    // on this render's projection value. The call ORDER is deliberately not
    // pinned: only "both keys were requested" is the invariant.
    const readKeys = (projections: Record<string, unknown>): string[] => {
      const keys: string[] = []
      const { container } = render(<SubagentRoleBadge {...propsWithSeat((key) => {
        keys.push(key)
        return projections[key]
      })} />)
      expect(container.firstChild).toBeNull()
      cleanup()
      return keys
    }

    for (const projections of [
      {},
      { [ROLE_PROJECTION_KEY]: 'inherit' },
      { [ROLE_PROJECTION_KEY]: 42 },
    ]) {
      expect(new Set(readKeys(projections))).toEqual(new Set([ROLE_PROJECTION_KEY, 'modelSelection']))
    }
  })
})

describe('SubagentRoleBadge — version-skewed host', () => {
  it('renders nothing and reads no projection without the session-kit seats', () => {
    // A host whose slot machinery does not bind `useProjection` / `useSessions`:
    // the component must not throw and must not fabricate a value.
    const props = {
      t,
      sessionId: 'viewed-session',
      useWorkspaces: undefined as never,
      useConversation: undefined as never,
      useInput: undefined as never,
      inputActions: undefined as never,
    } as never as SubagentRoleBadgeProps
    const { container } = render(<SubagentRoleBadge {...props} />)
    expect(container.firstChild).toBeNull()
  })
})
