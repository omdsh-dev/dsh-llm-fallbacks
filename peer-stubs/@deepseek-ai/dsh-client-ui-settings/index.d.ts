/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-client-ui-settings` seam
 * consumed by the `dsh-llm-fallbacks` client half.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — the `settings.section` SlotMap row and its `SettingsSectionOwnerProps`
 * owner share (the shell owns the slot contract; a section receives nothing
 * but the render site — data arrives through its own store). Mirrors
 * dsh-private commit b8343cb (2026-08-09 snapshot,
 * `packages/client/ui-settings/src/client/contract/slots.ts`); keep in sync
 * when the dsh baseline moves.
 */
import type { SlotEntryDef } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text). Sections render
     * inside the panel content column.
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
  }
}

/** Owner share of a settings section entry (intentionally empty — see contract). */
export interface SettingsSectionOwnerProps {
  /** Marker field: section owner props are intentionally empty for now. */
  children?: never
}

export type { SlotEntryDef }
