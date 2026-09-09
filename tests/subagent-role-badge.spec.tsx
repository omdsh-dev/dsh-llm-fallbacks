// @vitest-environment jsdom
/**
 * Session-header subagent role badge (plan subagent-role-badge T3 + T4 case
 * f): rendered degrade-guard spec.
 *
 * The badge is rendered over the REAL `FallbacksSettingsController` riding a
 * scripted `/api` rpc face (the card-spec pattern), so the wire payload
 * travels the production path: `fetchSubagentRole` → `fetchSubagentRoleRecord`
 * → `parseSubagentRoleRecord` → the component guard. Pins:
 *
 * - (f) a well-formed record renders the role pill with the
 *   `role → provider/model` hover; a malformed payload or a missing record
 *   (unknown session id omitted by the gateway) renders NOTHING —
 *   degrade-never-crash.
 * - an `inherit` wire record renders nothing (the writer never records
 *   `inherit` — the component guard is skew defense in depth).
 * - a version-skewed host without the session standard kit (`sessionId` seat
 *   absent or empty) renders nothing and never touches the channel.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { SubagentRoleBadge } from '../src/client/SubagentRoleBadge.tsx'
import type { SubagentRoleBadgeProps } from '../src/client/SubagentRoleBadge.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** One gateway RPC success (the channel returns the unwrapped result). */
function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

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

/** The Remote namespace faces the controller constructor accepts (never read on this path). */
function makeApi() {
  return {
    settings: { describe: vi.fn() },
    llm: { listConfigurableProviders: vi.fn() },
    session: { modelCatalog: vi.fn(), follow: vi.fn() },
  }
}

/** One well-formed wire record (the gateway `subagentRoles` projection shape). */
function wireRoleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'coder',
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    at: 1_725_900_000_000,
    ...overrides,
  }
}

/**
 * The props the utilities-slot outlet would bind: runtime share (the
 * conversation-merged standard-kit members are `as never` — the card/row
 * spec pattern; `sessionId` is the ui-session merge NOT carried by this
 * program's peer types, so the real prop crosses the same structural cast the
 * component reads it through), the locale seat, and the controller inject.
 */
function badgeProps(controller: FallbacksSettingsController, sessionId?: string): SubagentRoleBadgeProps {
  return {
    controller,
    t,
    useWorkspaces: undefined as never,
    useConversation: undefined as never,
    useInput: undefined as never,
    inputActions: undefined as never,
    ...(sessionId === undefined ? {} : { sessionId: sessionId as never }),
  }
}

/** Render the badge over a real controller + scripted rpc (the production fetch path). */
function renderBadge(call: Mock, sessionId: string | undefined) {
  const controller = new FallbacksSettingsController(makeApi(), { call } as unknown as ClientConnectionRpc)
  return render(<SubagentRoleBadge {...badgeProps(controller, sessionId)} />)
}

describe('SubagentRoleBadge (plan subagent-role-badge T4 case f)', () => {
  it('renders the role pill with the role → model hover on a well-formed record', async () => {
    const call = vi.fn(() => Promise.resolve(ok({ 'sess-1': wireRoleRecord() })))
    renderBadge(call, 'sess-1')

    const pill = await screen.findByText('coder')
    expect(pill.getAttribute('title')).toBe('coder → anthropic/claude-sonnet-4')
    // The fetch rides the pinned T2 wire call shape, one id per mount.
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('/api', 'fallbacks/subagent-roles', { args: { ids: ['sess-1'] } })
  })

  it('renders nothing when the record is missing (unknown id omitted by the gateway)', async () => {
    const call = vi.fn(() => Promise.resolve(ok({})))
    const { container } = renderBadge(call, 'sess-1')

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing on a malformed payload (non-object value / malformed record)', async () => {
    const nonObject = vi.fn(() => Promise.resolve(ok('nope')))
    const { container: empty } = renderBadge(nonObject, 'sess-1')
    await waitFor(() => expect(nonObject).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(empty.firstChild).toBeNull()

    const malformedRecord = vi.fn(() => Promise.resolve(ok({ 'sess-1': { role: 42, at: 'nope' } })))
    const { container: degraded } = renderBadge(malformedRecord, 'sess-1')
    await waitFor(() => expect(malformedRecord).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(degraded.firstChild).toBeNull()
  })

  it('renders nothing when the readback fails (channel down — the never-reject contract)', async () => {
    const call = vi.fn(() => Promise.reject(new Error('gateway/method-unavailable')))
    const { container } = renderBadge(call, 'sess-1')

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing on an inherit wire record (writer-skew defense in depth)', async () => {
    const call = vi.fn(() => Promise.resolve(ok({ 'sess-1': wireRoleRecord({ role: 'inherit' }) })))
    const { container } = renderBadge(call, 'sess-1')

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing and fetches nothing without the sessionId seat (version-skewed host)', async () => {
    // Seat absent entirely …
    const absent = vi.fn(() => Promise.resolve(ok({ 'sess-1': wireRoleRecord() })))
    const { container: noSeat } = renderBadge(absent, undefined)
    await act(async () => {})
    expect(noSeat.firstChild).toBeNull()
    expect(absent).not.toHaveBeenCalled()

    // … or present but empty (the guard treats '' as no session).
    const blank = vi.fn(() => Promise.resolve(ok({ 'sess-1': wireRoleRecord() })))
    const { container: blankSeat } = renderBadge(blank, '')
    await act(async () => {})
    expect(blankSeat.firstChild).toBeNull()
    expect(blank).not.toHaveBeenCalled()
  })
})
