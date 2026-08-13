/**
 * In-memory `SettingsProvider` test double, extending the REAL abstract
 * `SettingsProvider` base class from `@deepseek-ai/dsh-settings` (pattern validated
 * by dsh-advisor, refactor/dev-real-dsh-links) — the base owns namespace
 * registration, composition resolution, validation, revisions, watchers, and
 * the `settings/updated` commit event; only raw-document storage is abstract.
 * This is the dev-time stand-in for the file-backed `@deepseek-ai/dsh-settings-file`,
 * so tests exercise the real settings semantics (`installSettingsSection`,
 * `scope.watch` → `onChange`, revision conflict rules) against a synchronous
 * in-memory document.
 */

import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

export class MemorySettings extends SettingsProvider {
  /** In-memory storage never refuses a write. */
  readonly writable = true

  private doc: Record<string, unknown> = {}

  protected async load(): Promise<Record<string, unknown>> {
    return structuredClone(this.doc)
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
  }

  /**
   * Pre-seed a user section BEFORE its namespace is registered — the dev-time
   * mirror of a provider whose raw document already contains the section when
   * the owning plugin loads (the real file-backed `settings-file` reads the
   * document at init; registration then validates whatever is stored).
   */
  seed(ns: SettingsNamespace, section: Record<string, unknown>): void {
    this.publish({ ...this.doc, [ns]: structuredClone(section) })
  }
}
