/**
 * dsh-tui client surface (plan fallbacks-tui-client Task 1, AC-1 +
 * fallbacks-tui-settings Task 2): registers a `tuiCommandTrees` provider
 * for the `/fallbacks` command so the dsh-tui profile's `/` menu shows the
 * command with localized descriptions and `config` → `revert-seed`
 * subcommand completion — with ZERO dsh-TUI changes.
 *
 * The service and its shapes are consumed structurally (read-only reference:
 * dsh-TUI @ 557a27a, `src/dsh-adapter/command-trees.ts` +
 * `src/commands.ts`): the three types below are minimal local copies of the
 * host's `TuiCommandTreeProvider` / `LocalizedDescriptions` /
 * `CommandCompletionNode`, so no `@deepseek-harness-tui/dsh-tui` peer is
 * needed (plan constraint: zero new peer/dependency).
 *
 * Copy comes from the single command copy source: root descriptions reuse
 * `FALLBACKS_COMMAND_LOCALES.*.description`; the `config` completion node
 * reuses the `usageConfig` key (the same key Task 2's USAGE line consumes).
 */

import type { Context } from '@deepseek-ai/cordis'
import { FALLBACKS_COMMAND_LOCALES } from './commands.ts'

/** Localized copy map for a tree row (host `LocalizedDescriptions` shape). */
export type TuiLocalizedDescriptions = Readonly<Partial<Record<'zh' | 'en', string>>>

/** One child in a slash-command tree (host `CommandCompletionNode` shape). */
export interface TuiCommandCompletionNode {
  name: string
  aliases?: readonly string[]
  description: string
  descriptions?: TuiLocalizedDescriptions
  tag?: string
  /** Optional i18n key; plugin nodes normally rely on fallback text. */
  descriptionKey?: string
}

/** A `tuiCommandTrees` provider (host `TuiCommandTreeProvider` shape). */
export interface TuiCommandTreeProvider {
  /** Root command name without `/`. Must match the command registry entry. */
  root: string
  /** Provider-owned translations for the root command row. */
  descriptions?: TuiLocalizedDescriptions
  /** Children for the full canonical path, including `root` at index zero. */
  children(canonicalPath: readonly string[]): readonly TuiCommandCompletionNode[]
}

/** The provider's root — matches the command registry entry name `fallbacks`. */
export const FALLBACKS_TUI_ROOT = 'fallbacks'

/** The `config` completion node; copy from the shared `usageConfig` key. */
const FALLBACKS_CONFIG_NODE: TuiCommandCompletionNode = {
  name: 'config',
  description: FALLBACKS_COMMAND_LOCALES.zh.usageConfig,
  descriptions: {
    zh: FALLBACKS_COMMAND_LOCALES.zh.usageConfig,
    en: FALLBACKS_COMMAND_LOCALES.en.usageConfig,
  },
}

/**
 * The `revert-seed` completion node (leaf at depth 2, plan
 * fallbacks-tui-settings Task 2); copy from the shared `usageRevertSeed`
 * key (the same key the USAGE line consumes — single copy source).
 */
const REVERT_SEED_NODE: TuiCommandCompletionNode = {
  name: 'revert-seed',
  description: FALLBACKS_COMMAND_LOCALES.zh.usageRevertSeed,
  descriptions: {
    zh: FALLBACKS_COMMAND_LOCALES.zh.usageRevertSeed,
    en: FALLBACKS_COMMAND_LOCALES.en.usageRevertSeed,
  },
}

/**
 * Completion children for the `/fallbacks` tree. The host only passes
 * canonical paths (root at index 0, registered names), so any path whose
 * first element is not the canonical root — or that reaches past the
 * `config` → `revert-seed` leaf — is unknown and yields `[]`, never
 * throwing. The `config` row (depth 1) stays a node; its `revert-seed`
 * child (depth 2) is the leaf — the branch is extended, never flattened.
 *
 * Every row is returned in a FRESH array per call (qc3 N-3): callers
 * receive a copy, never the shared module constants by reference, so a
 * host-side mutation could never corrupt subsequent completions.
 */
function fallbacksChildren(canonicalPath: readonly string[]): readonly TuiCommandCompletionNode[] {
  if (canonicalPath[0] !== FALLBACKS_TUI_ROOT) return []
  if (canonicalPath.length === 1) return [FALLBACKS_CONFIG_NODE]
  if (canonicalPath.length === 2 && canonicalPath[1] === 'config') return [REVERT_SEED_NODE]
  return []
}

/** The `/fallbacks` provider handed to the host registry. */
const FALLBACKS_PROVIDER: TuiCommandTreeProvider = {
  root: FALLBACKS_TUI_ROOT,
  descriptions: {
    zh: FALLBACKS_COMMAND_LOCALES.zh.description,
    en: FALLBACKS_COMMAND_LOCALES.en.description,
  },
  children: fallbacksChildren,
}

/**
 * Register the `/fallbacks` provider on the optional `tuiCommandTrees`
 * service. First-fiber-only (`serviceOwned === true` — mirrors the
 * gateway/typert multi-fiber dedupe; the host registry throws on duplicate
 * roots, so a deduped later fiber must never register). The service is
 * optional: a composition without `dsh-tui-command-trees` keeps the plugin
 * working and simply omits the TUI surface.
 *
 * The inject child returns the registry disposer so cordis withdraws the
 * registration when this fiber (or the service) goes away.
 */
export function installTuiClient(ctx: Context, opts: { serviceOwned: boolean }): void {
  if (!opts.serviceOwned) return
  ctx.inject(['tuiCommandTrees'], (tctx) => {
    // Structural accessor: the inject key stays in the standard position
    // while the service is read through the narrow local shape — the key is
    // not on this repo's `Context`, so the child context is widened once.
    const tuiHost = tctx as unknown as {
      tuiCommandTrees?: { register(provider: TuiCommandTreeProvider): () => void }
    }
    const trees = tuiHost.tuiCommandTrees
    if (trees === undefined) return
    try {
      return trees.register(FALLBACKS_PROVIDER)
    } catch (error) {
      // M-1 (qc2): sibling dedupe guard — the host registry throws on a
      // duplicate root, and a cross-plugin (or future host) provider may
      // own `fallbacks` before this fiber. Degrade to a no-op disposer with
      // a debug log, mirroring the typert child idiom (src/index.ts); any
      // other error stays loud.
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      tctx.logger('llm-fallbacks').debug('llm-fallbacks: tui command tree already registered — no provider on this fiber')
      return () => {}
    }
  })
}
