/**
 * In-memory settings-service test double for the 0.1.7-rc.1 `SettingsForms`
 * form service (the 0.1.5-era `SettingsProvider` base class is gone). The
 * double stands in for the host's form service with a synchronous in-memory
 * document and the SAME observable contract the plugin consumes:
 *
 * - `update` / `replace` / `describe` (the `SettingsForms` face the gateway
 *   and the plugin's settings child write and read through);
 * - the `settings/document-updated(ns, revision)` cordis event after every
 *   committed write — the plugin's child refreshes its composed view and
 *   re-derives the runtime caches from it (the old `installSection`
 *   `onChange` hook, now event-carried);
 * - `seed` (pre-apply document pre-population, the dev-time mirror of a
 *   profile patch that already carries the section) and `get` (readiness
 *   probes) as test conveniences;
 * - a `describeCalls` counter — the ONLY observable of the plugin's binding
 *   child having fired (the child's bind-time `describe()` is the new
 *   "the section is registered" signal; there is no registration step);
 * - a `persist` raw-document hook subclasses override to count writes or
 *   force write failures (the old double's seam, same contract).
 *
 * Composition: the double stores RAW sections only (no schema, no entry —
 * the real service projects the Loader's entry config). The plugin merges a
 * descriptor's `value` over its own normalized entry (`mergeConfigLayer` in
 * `src/index.ts`), which reproduces the old defaults → entry → user layering
 * for the plain-config test path; `value` is therefore the stored section.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** One stored section plus its monotonic revision. */
interface StoredSection {
  raw: Record<string, unknown>
  revision: number
}

export class MemorySettings extends Service {
  /** In-memory storage never refuses a write. */
  readonly writable = true

  /** How many times `describe()` ran — the binding-child-fired probe. */
  describeCalls = 0

  private sections = new Map<string, StoredSection>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /**
   * The raw-document commit hook: storage is abstract here, exactly like the
   * old double (and the real service's profile patch). Subclasses count
   * commits or turn this into the failure face; `seed` bypasses it (a
   * pre-seed is document state, not a write).
   */
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.store(ns, section)
  }

  /**
   * Pre-seed a section BEFORE its plugin applies — the dev-time mirror of a
   * profile patch already carrying the section when the plugin loads. Bumps
   * the revision and emits the change event like any write, but never
   * crosses {@link persist} (a seed is not a write).
   */
  seed(ns: SettingsNamespace, section: Record<string, unknown>): void {
    this.commit(ns, structuredClone(section))
  }

  /** Read one stored raw section (readiness probe; `undefined` when absent). */
  get(ns: SettingsNamespace): Record<string, unknown> | undefined {
    const stored = this.sections.get(ns)
    return stored === undefined ? undefined : structuredClone(stored.raw)
  }

  /** Merge editable fields into a section (the `SettingsForms` face). */
  async update(ns: SettingsNamespace, patch: object): Promise<void> {
    const current = this.sections.get(ns)?.raw ?? {}
    await this.persist(ns, { ...structuredClone(current), ...structuredClone(patch) })
    this.emitCommitted(ns)
  }

  /** Reset a section, then set the supplied fields (the `SettingsForms` face). */
  async replace(ns: SettingsNamespace, section: object): Promise<void> {
    await this.persist(ns, structuredClone(section))
    this.emitCommitted(ns)
  }

  /**
   * Read the stored sections as descriptors. `value` is the raw section (the
   * real service projects the Loader entry config; the plugin merges it over
   * its own entry — see the module docblock), `user` mirrors it (the raw
   * patch section IS the user-visible override here), `base` stays undefined
   * (no schema/entry layers exist in the double).
   */
  describe(): {
    ns: SettingsNamespace
    autoGenerate: boolean
    value: unknown
    base?: unknown
    user?: unknown
    revision: number
    applies: 'live'
  }[] {
    this.describeCalls += 1
    return [...this.sections.entries()].map(([ns, stored]) => ({
      ns: ns as SettingsNamespace,
      autoGenerate: true,
      value: structuredClone(stored.raw),
      user: structuredClone(stored.raw),
      revision: stored.revision,
      applies: 'live' as const,
    }))
  }

  /** Store one section without emitting (the persist-hook default). */
  private store(ns: SettingsNamespace, raw: Record<string, unknown>): void {
    const previous = this.sections.get(ns)
    this.sections.set(ns, { raw, revision: (previous?.revision ?? 0) + 1 })
  }

  /** Store + emit: the post-commit notification the plugin's child follows. */
  private commit(ns: SettingsNamespace, raw: Record<string, unknown>): void {
    this.store(ns, raw)
    this.emitCommitted(ns)
  }

  /** Emit the settings seam's change event for one committed section. */
  private emitCommitted(ns: SettingsNamespace): void {
    this.ctx.emit('settings/document-updated', ns, this.sections.get(ns)!.revision)
  }
}
