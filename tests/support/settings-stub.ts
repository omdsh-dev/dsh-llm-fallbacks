/**
 * Instrumented double for the `@deepseek-ai/dsh-settings` runtime seam
 * (vitest `resolve.alias`, see `vitest.config.ts` and pm-note-type-access.md).
 *
 * The plugin consumes exactly two exports:
 * - `installSettingsSection(ctx, ns, schema, entry, hooks)` — the real
 *   implementation registers a namespace with the settings service and wires
 *   `setSource` / `onChange`. This double records every registration and
 *   simulates a mounted service: the source resolves the composition entry
 *   and `onChange` runs once at attach (startup selector validation).
 * - `settingsNamespace(value)` — plain identity (the real one validates the
 *   kebab-case pattern; `'fallbacks'` passes either way).
 *
 * Tests drive settings changes through the recorded `hooks.setSource` /
 * `hooks.onChange` to prove the runtime re-reads live config.
 */
import type { Context } from 'cordis'

/** Mirrors the peer-stub surface the plugin type-checks against. */
export interface SettingsSectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
  validate?: (value: T) => void
}

/** One recorded `installSettingsSection` invocation. */
export interface SettingsRegistration<T = unknown> {
  ctx: Context
  ns: string
  schema: unknown
  entry: T
  hooks: SettingsSectionHooks<T>
}

/** Registrations in attach order; reset per test. */
export const registrations: SettingsRegistration<any>[] = []

/** Plain identity stand-in for the branded namespace helper. */
export function settingsNamespace(value: string): string {
  return value
}

/** Record the registration and simulate a mounted settings service. */
export function installSettingsSection<T>(
  ctx: Context,
  ns: string,
  schema: unknown,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  registrations.push({ ctx, ns, schema, entry, hooks })
  hooks.setSource(() => entry)
  hooks.onChange()
}

/** Clear recorded registrations between tests. */
export function resetSettingsStub(): void {
  registrations.length = 0
}
