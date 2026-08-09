/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-settings` seam consumed
 * by `dsh-llm-fallbacks`.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — `installSettingsSection` / `settingsNamespace` / `SettingsScope` /
 * `SettingsRegisterOptions` / `SettingsSectionHooks`. Mirrors dsh-private
 * commit b8343cb (2026-08-09 snapshot); keep in sync when the dsh baseline
 * moves.
 *
 * Runtime access in tests is aliased (vitest `resolve.alias`) to
 * `tests/support/settings-stub.ts`; this stub only types the plugin source.
 */
import type { Context } from 'cordis'
import type z from 'schemastery'

/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = string & { readonly __brand?: 'SettingsNamespace' }

/** Brand a raw string as a {@link SettingsNamespace}. */
export function settingsNamespace(value: string): SettingsNamespace

/** When a namespace's changes take effect for its owner. */
export type SettingsApplies = 'live' | 'restart'

/** Registration options beyond the namespace schema. */
export interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
  /** Reject a resolved section the owner could not act on (cross-field constraints). */
  validate?: (value: T) => void
}

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** Hooks a consumer hands to {@link installSettingsSection}. */
export interface SettingsSectionHooks<T> {
  /** Receive the active configuration source (scope while attached, composition entry otherwise). */
  setSource(current: () => T): void
  /** Re-judge anything derived from the source after attach/detach/committed change. */
  onChange(): void
  /** Reject a resolved section this consumer could not act on. */
  validate?: (value: T) => void
}

/**
 * Install the canonical optional-settings consumer wiring: while a settings
 * service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the
 * service goes away, fall back to the entry.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void
