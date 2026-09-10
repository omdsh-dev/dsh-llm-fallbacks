// @vitest-environment jsdom
/**
 * Session-header subagent role badge (plan subagent-role-badge T3 + T4 case f;
 * durable channel plan role-based-subagent-adoption Task 3b).
 *
 * The badge is rendered over the REAL session-kit seat shape: a scripted
 * `useProjection(key)` reader, i.e. exactly what the ui-session binding hands a
 * `scope: 'session'` occupant (`binding.session.projections.faceOf(key)`). Pins:
 *
 * - a present `fallbacksSubagentRole` value renders the role pill; the hover is
 *   `role → provider/model (latest request route)`, taken from the host's
 *   EXISTING `modelSelection` projection (`lastUsed`) — NOT from the role
 *   projection, which carries no route.
 * - the pill renders ROLE-ONLY (title = the role) when no route is known.
 * - an absent/foreign/blank value, a `null` wire value and an `inherit` value
 *   render NOTHING — degrade-never-crash.
 * - a version-skewed host without the session standard kit renders nothing and
 *   reads no projection at all.
 *
 * The probe loop, the gateway round-trip and the `sessionId` plumbing are GONE
 * (Task 3b): the host pushes the value into the session's projection store, so
 * there is nothing left to poll and no rpc to script. The live half (a settled
 * child's opening frame really carrying the key) is QA's item.
 */

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

/** The host's model-selection projection value carrying a latest request route. */
function selection(provider: string, model: string): unknown {
  return { lastUsed: { provider, model }, next: null }
}

/**
 * The props the utilities-slot outlet would bind: runtime share (the
 * conversation-merged standard-kit members are `as never` — the card/row spec
 * pattern; `useProjection` is the ui-session merge NOT carried by this program's
 * peer types, so the real seat crosses the same structural cast the component
 * reads it through) plus the locale seat.
 */
function badgeProps(projections: Record<string, unknown>): SubagentRoleBadgeProps {
  const useProjection = vi.fn((key: string) => projections[key])
  return {
    t,
    useProjection: useProjection as never,
    useWorkspaces: undefined as never,
    useConversation: undefined as never,
    useInput: undefined as never,
    inputActions: undefined as never,
  }
}

describe('SubagentRoleBadge — projection value', () => {
  it('renders the role pill with the role → latest request route hover', () => {
    render(<SubagentRoleBadge {...badgeProps({
      [ROLE_PROJECTION_KEY]: 'coder',
      modelSelection: selection('anthropic', 'claude-sonnet-4'),
    })} />)

    const pill = screen.getByText('coder')
    expect(pill.getAttribute('title')).toBe('coder → anthropic/claude-sonnet-4 (latest request route)')
  })

  it('renders role-only (title = the role) when no route is known', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({ [ROLE_PROJECTION_KEY]: 'scout' })} />)

    const pill = container.querySelector('span')
    expect(pill?.textContent).toBe('scout')
    expect(pill?.getAttribute('title')).toBe('scout')
  })

  it('drops a malformed route instead of rendering a wrong one', () => {
    const cases: unknown[] = [
      null,
      42,
      {},
      { lastUsed: null },
      { lastUsed: {} },
      { lastUsed: { provider: 'anthropic' } },
      { lastUsed: { provider: '', model: 'claude-sonnet-4' } },
      { lastUsed: { provider: 'anthropic', model: 7 } },
    ]
    for (const modelSelection of cases) {
      cleanup()
      render(<SubagentRoleBadge {...badgeProps({ [ROLE_PROJECTION_KEY]: 'coder', modelSelection })} />)
      expect(screen.getByText('coder').getAttribute('title')).toBe('coder')
    }
  })

  it('renders nothing for an absent, null, blank or foreign projection value', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { [ROLE_PROJECTION_KEY]: undefined },
      { [ROLE_PROJECTION_KEY]: null },
      { [ROLE_PROJECTION_KEY]: '' },
      { [ROLE_PROJECTION_KEY]: '   ' },
      { [ROLE_PROJECTION_KEY]: 42 },
      { [ROLE_PROJECTION_KEY]: { role: 'coder' } },
      // The writer never records `inherit` (Task 1 resolves it to no role), so a
      // wire value claiming it is skew — never badge it.
      { [ROLE_PROJECTION_KEY]: 'inherit' },
    ]
    for (const projections of cases) {
      cleanup()
      const { container } = render(<SubagentRoleBadge {...badgeProps(projections)} />)
      expect(container.firstChild).toBeNull()
    }
  })

  it('renders a padded DECLARED role id verbatim (the projection carries the raw id)', () => {
    const { container } = render(<SubagentRoleBadge {...badgeProps({ [ROLE_PROJECTION_KEY]: ' padded ' })} />)
    expect(container.querySelector('span')?.textContent).toBe(' padded ')
  })
})

describe('SubagentRoleBadge — version-skewed host', () => {
  it('renders nothing and reads no projection without the session-kit seat', () => {
    // A host whose slot machinery does not bind `useProjection` at all: the
    // component must not throw and must not fabricate a value.
    const props = {
      t,
      useWorkspaces: undefined as never,
      useConversation: undefined as never,
      useInput: undefined as never,
      inputActions: undefined as never,
    } as SubagentRoleBadgeProps
    const { container } = render(<SubagentRoleBadge {...props} />)
    expect(container.firstChild).toBeNull()
  })
})
