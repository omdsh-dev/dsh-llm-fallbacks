/**
 * Seeds declare-window integration pins (plan seeds-declare-window Task 2,
 * issue #105): the service-visibility ordering after the provide moved INSIDE
 * the settings inject child, and the optimistic-claim window it creates for
 * the TUI installers (T1(b)/(c)).
 *
 * Covers:
 * - ordinary boot with `tuiCommandTrees` / `tuiSettingsSections` composed →
 *   both TUI registrations land (exactly one attempt each) and the tail
 *   preset child still fires (T2g — guards the optimistic-claim restructure
 *   from silently dropping the TUI surfaces);
 * - a second apply issued BEFORE the first fiber's settings child settles
 *   (the optimistic-claim window: both fibers claim `serviceOwned`) degrades
 *   without aborting — the first fiber owns the service, both TUI
 *   registrations land exactly once (the duplicate attempts hit the host
 *   duplicate throw and degrade via the installers' `already registered`
 *   catches), and the preset self-declare fires exactly once (T2c/T2d).
 *
 * The registry doubles mirror the host rule that matters here — `register`
 * throws the host duplicate message on a second registration — with attempt
 * counting so the window test can tell "degraded duplicate" from "never
 * attempted". The faithful host-shape doubles stay in
 * tests/tui-client.spec.ts / tests/tui-settings.spec.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { FALLBACKS_SETTINGS_NAMESPACE } from '../src/gateway.ts'
import { FALLBACKS_TUI_ROOT } from '../src/tui.ts'
import { FALLBACKS_TUI_SECTION_NS } from '../src/tui-settings.ts'
import { presetRoles } from '../src/presets.ts'
import { MemorySettings } from './support/memory-settings.ts'

/** Minimal `tuiCommandTrees` double: attempt counting + the host duplicate-root throw. */
class CommandTreesRegistry {
  /** Successfully registered roots, in order. */
  readonly roots: string[] = []
  /** Every `register` call — successful or host-rejected. */
  attempts = 0

  register(provider: { root: string }): () => void {
    this.attempts += 1
    const root = provider.root.trim().toLowerCase()
    if (this.roots.includes(root)) throw new Error(`TUI command-tree root "${root}" is already registered`)
    this.roots.push(root)
    return () => {
      const index = this.roots.indexOf(root)
      if (index >= 0) this.roots.splice(index, 1)
    }
  }
}

/** Minimal `tuiSettingsSections` double: attempt counting + the host duplicate-ns throw. */
class SectionsRegistry {
  /** Successfully registered namespaces, in order. */
  readonly nss: string[] = []
  /** Every `register` call — successful or host-rejected. */
  attempts = 0

  register(section: { ns: string }): () => void {
    this.attempts += 1
    const ns = section.ns.trim()
    if (this.nss.includes(ns)) throw new Error(`TUI settings section "${ns}" is already registered`)
    this.nss.push(ns)
    return () => {
      const index = this.nss.indexOf(ns)
      if (index >= 0) this.nss.splice(index, 1)
    }
  }
}

/** Track every test context and dispose it after the case (settings/gateway effects hygiene). */
const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) {
    await ctx.fiber.dispose()
  }
  contexts.clear()
})

function track(ctx: Context): Context {
  contexts.add(ctx)
  return ctx
}

/** The raw user-layer roles section of the fallbacks settings namespace. */
function userSection(ctx: Context): { roles: { list: Array<{ id: string; persona: string }>; rules: unknown[] } } | undefined {
  return ctx.settings.describe().find((d) => d.ns === FALLBACKS_SETTINGS_NAMESPACE)?.user
}

/** Capture every ctx.logger export (info/warn/...) from this point on (seeds-integration pattern). */
function captureLogs(ctx: Context): Array<{ type: string; name: string; args: unknown[] }> {
  const logs: Array<{ type: string; name: string; args: unknown[] }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
  return logs
}

/** Let pending microtasks/macrotasks settle (negative-assertion window; presets-integration pattern). */
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 50)
  return promise
}

describe('seeds declare window — service visibility ordering (issue #105)', () => {
  it('ordinary boot: both TUI registrations land and the preset child still fires (T2g)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    const trees = new CommandTreesRegistry()
    const sections = new SectionsRegistry()
    ctx.provide('tuiCommandTrees', trees as never)
    ctx.provide('tuiSettingsSections', sections as never)

    apply(ctx)

    // Both installers read the optimistic `serviceOwned` claim synchronously
    // during apply(); the registrations settle with their inject children.
    // The T1(b)/(c) restructure must not silently drop either TUI surface.
    await vi.waitFor(() => {
      expect(trees.roots).toEqual([FALLBACKS_TUI_ROOT])
      expect(sections.nss).toEqual([FALLBACKS_TUI_SECTION_NS])
    })
    expect(trees.attempts).toBe(1)
    expect(sections.attempts).toBe(1)

    // The service becomes visible once the settings child settles...
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })
    // ...and the tail preset child (last-registered) still fires after both
    // TUI children: the 7 bundled rows materialize as the two-key shape.
    await vi.waitFor(() => {
      expect(userSection(ctx)).toEqual({
        roles: { list: presetRoles.map((preset) => ({ id: preset.id, persona: preset.persona })), rules: [] },
      })
    })
  })

  it('optimistic-claim window: a second apply BEFORE the settings child settles degrades without aborting (T2c)', async () => {
    const ctx = track(new Context())
    await ctx.plugin(MemorySettings)
    // A conflict on the preset fire makes a wrongful SECOND fire observable
    // (presets-integration multi-fiber pattern): each fiber's manager is
    // fresh, so every fired declare emits its own designer conflict warn.
    ;(ctx.settings as unknown as MemorySettings).seed(FALLBACKS_SETTINGS_NAMESPACE, {
      roles: { list: [{ id: 'designer', persona: 'operator persona' }], rules: [] },
    })
    const logs = captureLogs(ctx)
    const trees = new CommandTreesRegistry()
    const sections = new SectionsRegistry()
    ctx.provide('tuiCommandTrees', trees as never)
    ctx.provide('tuiSettingsSections', sections as never)

    // First apply — its settings child has NOT settled yet, so the service
    // is still invisible.
    apply(ctx)
    expect(ctx.get('llm-fallbacks')).toBeUndefined()

    // Second apply INSIDE the optimistic-claim window: both fibers read
    // `serviceOwned === true`. Must not abort...
    expect(() => apply(ctx)).not.toThrow()

    // ...the FIRST fiber's provide child wins the registration (the second
    // child's provide hit the `has been registered` duplicate and degraded);
    // exactly one service exists after settlement.
    await vi.waitFor(() => {
      expect(ctx.get('llm-fallbacks')).toBeDefined()
    })

    // Both TUI fibers attempted their registration (the window claim) but
    // exactly ONE landed: the duplicate hit the host duplicate throw and
    // degraded via each installer's `already registered` catch.
    await settle()
    expect(trees.attempts).toBe(2)
    expect(trees.roots).toEqual([FALLBACKS_TUI_ROOT])
    expect(sections.attempts).toBe(2)
    expect(sections.nss).toEqual([FALLBACKS_TUI_SECTION_NS])

    // Exactly ONE preset conflict warn — the second fiber's tail child
    // skipped (its optimistic claim was corrected to false before it fired).
    const warns = logs.filter((message) => message.type === 'warn').map((message) => String(message.args[0]))
    expect(warns.filter((message) => message.startsWith('llm-fallbacks: seeds: persona-source conflict'))).toHaveLength(1)

    // No abort, no failed child, no unhandled rejection anywhere in the
    // window: the user layer holds exactly one row per preset id and the
    // operator persona survived.
    const rows = userSection(ctx)!.roles.list
    expect(rows).toHaveLength(presetRoles.length)
    expect(new Set(rows.map((row) => row.id)).size).toBe(presetRoles.length)
    expect(rows.find((row) => row.id === 'designer')!.persona).toBe('operator persona')
    // No llm-fallbacks child failed loud in the window: the plugin's own
    // surfaces all degrade via their dedupe catches. (The deduped fiber's
    // unconditional settings-section child still logs a PRE-EXISTING root
    // `settings namespace "fallbacks" is already registered` fiber error —
    // unchanged by this plan and out of scope here.)
    expect(
      logs.filter((message) => message.type === 'error' && message.name === 'llm-fallbacks'),
    ).toHaveLength(0)
  })
})
