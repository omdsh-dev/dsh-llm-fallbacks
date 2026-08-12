/**
 * Conversation-level fallback-switch visibility (plan fallbacks-aux-seams,
 * task 2, D1+D2 seam).
 *
 * Every `fallbacks/switch` session event becomes its own chat-transcript
 * node (`fallbacks-switch`), rendered as a compact system-style line at the
 * switch's event seq — the user sees the recovery happen in place
 * (provider/model A → B, role · reason), instead of the event existing only
 * in the raw `sessions.history` event feed (it is NOT a SurfaceEventType,
 * so the `unknown-surface` fallback never picked it up and the transcript
 * showed nothing).
 *
 * Contract notes (dsh-private, verified 2026-08-12):
 * - D1 registry: `ConversationEventRegistry.register(definition)` — service
 *   on the client Context (`runtime/src/client/index.ts:171,189-192`);
 *   external registration precedent `ui-workflow-run/src/client/index.ts:18-28`.
 *   The engine feeds EVERY session event to each definition's `match`
 *   (`runtime/src/client/sessions/conversation-assembler.ts:370-382`) —
 *   non-surface plugin events included — and the client session appends live
 *   events into the engine (`sessions/session.ts:673` `conversation.append`).
 * - D2 seat: `conversation.chat.node` is a keyed seat dispatched by
 *   `ChatConversationViewNode.kind` (`ui-conversation contract/slots.ts:56-63`;
 *   `chat/ChatNodeSeat.tsx:48-51`), externally registrable as
 *   `{ name, key, locale }` (precedents: ui-tool `tool-call`, ui-goal
 *   `command-input`, ui-workflow-run `workflow-run`).
 * - Purity: this file only type-imports `@deepseek-ai/dsh-client-runtime/client`
 *   and `@deepseek-ai/dsh-client-ui-conversation/client` (both erased at
 *   build); the renderer self-draws on `--dsw-alias-*` tokens. Render-only:
 *   the Definition is a pure view contribution — no message construction,
 *   no model-context injection (C4 excluded by scope).
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatConversationViewNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `conversation.chat.node` SlotMap entry + the
// `ChatNodeDataMap` merge seat (the keyed dispatch key domain). Same empty
// type-only pattern as the ui-settings / ui-plugin-config merges in index.ts.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FallbackSwitchReason } from '../events.ts'
import { SWITCH_REASON_KEYS } from './locales.ts'
import { isFallbacksSwitchData } from './switch-guard.ts'
import css from './ConversationFallbackSwitch.module.css'

/** Final chat payload of one decided fallback switch (snapshot of the event). */
export interface FallbacksSwitchChatData {
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step: number
  /** The model the request was using when the switch was decided. */
  readonly from: { readonly provider: string; readonly model: string }
  /** The chain candidate the switch moves to. */
  readonly to: { readonly provider: string; readonly model: string }
  /** The fallback-chain role the decision resolved for the agent. */
  readonly role: string
  readonly reason: FallbackSwitchReason
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One decided fallback provider/model switch, rendered at its event seq. */
    'fallbacks-switch': FallbacksSwitchChatData
  }
}

/**
 * One switch event → one chat node. Each `fallbacks/switch` event is its own
 * Context (id = event seq — the durable unique key), so every match is a
 * `start`; `update` is a passthrough (no aggregation — D3's per-Turn
 * counting is a separate, unselected seam).
 */
export const fallbackSwitchDefinition: ConversationNodeDefinition<FallbacksSwitchChatData> = {
  kind: 'fallbacks-switch',
  target: 'chat',
  // The engine feeds EVERY session event to every definition's `match`
  // (`conversation-assembler.ts:370-382`) with no try/catch, and a matched
  // start flows into `replayContext` → `definition.start` with no
  // containment either (`:535-539`) — a throw here breaks the WHOLE session
  // transcript assembly, not just this line. So `match` no-ops malformed
  // envelopes (missing/non-integer seq would produce the id `'undefined'`
  // and trip the engine's duplicate-start/non-appended invariants; a
  // non-object payload cannot be snapshotted) and `start` degrades instead
  // of throwing. Version skew must degrade the line, never crash it.
  match: (event) =>
    event.type === 'fallbacks/switch' &&
    Number.isInteger(event.seq) &&
    isFallbacksSwitchData(event.data)
      ? { id: String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => {
    if (match.event.type !== 'fallbacks/switch') {
      throw new Error('fallbacks-switch start requires a fallbacks/switch event')
    }
    const { seq, time } = match.event
    if (!Number.isInteger(seq) || !isFallbacksSwitchData(match.event.data)) {
      // Degraded snapshot — DEFINED (the engine's requireState rejects
      // undefined, `conversation-assembler.ts:793-801`) but missing the
      // summary fields, so the renderer's shared shape guard turns the line
      // into the title-only notice. The cast documents that the runtime
      // shape may intentionally deviate from the static well-formed type
      // (the version-skew premise this file degrades for).
      return { seq, time } as FallbacksSwitchChatData
    }
    const { turn, step, from, to, role, reason } = match.event.data
    return {
      seq,
      time,
      turn,
      step,
      from,
      to,
      role,
      reason,
    }
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'fallbacks-switch',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}

/**
 * Props delivered by the keyed chat-node seat: runtime share + the `fallbacks` locale seat.
 */
export type ConversationFallbackSwitchProps =
  PropsRuntime<'conversation.chat.node', 'fallbacks-switch'> & PropsLocale<'fallbacks'>

/**
 * Render one fallback switch as a compact system-style transcript line.
 *
 * Geometry follows the upstream chat system rows (the compaction boundary
 * notice: dim title + separator + ellipsized summary — `chat/MessageItem
 * .module.css:38-122`); every color resolves through a `--dsw-alias-*`
 * token. A reason outside the current union renders raw (forward-compatible
 * durable log, same rule as the card/general row summaries). A malformed or
 * partial payload (version skew) degrades to the title-only line instead of
 * throwing during interpolation — the transcript slot stays visible with a
 * truthful "a switch happened" notice and no summary details.
 * @param props - composed keyed seat props.
 * @returns the switch line element tree.
 */
export function ConversationFallbackSwitch({ node, t }: ConversationFallbackSwitchProps): ReactNode {
  const data = node.data
  if (!isFallbacksSwitchData(data)) {
    return (
      <div className={css.switchRow} role="status">
        <span className={css.switchTitle}>{t('chat.switch.title')}</span>
      </div>
    )
  }
  const reasonKey = SWITCH_REASON_KEYS[data.reason]
  const summary = t('chat.switch.summary', {
    from: `${data.from.provider}/${data.from.model}`,
    to: `${data.to.provider}/${data.to.model}`,
    role: data.role,
    reason: reasonKey === undefined ? data.reason : t(reasonKey),
  })
  return (
    <div className={css.switchRow} role="status">
      <span className={css.switchTitle}>{t('chat.switch.title')}</span>
      <span className={css.switchSep} aria-hidden="true" />
      <span className={css.switchSummary}>{summary}</span>
    </div>
  )
}
