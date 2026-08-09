/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-client-locale` seam
 * consumed by the `dsh-llm-fallbacks` client half.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — `LocaleService` (register/bind), the `locale` Context merge, and the
 * locale identifier/snapshot types. Mirrors dsh-private commit b8343cb
 * (2026-08-09 snapshot, `packages/client/locale/src/client/index.ts`); keep
 * in sync when the dsh baseline moves.
 */
import type { Context } from 'cordis'
import type {
  LocaleDictOf, LocaleNamespaceMap, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale identifier: the two shipped locales. */
export type LocaleId = 'zh' | 'en'

/** Immutable locale state published on every change. */
export interface LocaleSnapshot {
  /** Active locale id. */
  active: LocaleId
  /** Monotonic change counter. */
  revision: number
}

/** Dictionary registry plus locale preference (consumed surface). */
export class LocaleService {
  /** Register one namespace's dictionaries; returns the disposer. */
  register<N extends keyof LocaleNamespaceMap & string>(
    ns: N, dicts: Record<LocaleId, LocaleDictOf<N>>): () => void
  /** Bind a namespace to a translate function reading the active locale at call time. */
  bind<N extends keyof LocaleNamespaceMap & string>(ns: N): TranslateNS<N>
  /** Current locale snapshot. */
  getSnapshot(): LocaleSnapshot
  /** Subscribe to locale changes. */
  subscribe(fn: () => void): () => void
}

declare module 'cordis' {
  interface Context {
    locale: LocaleService
  }
}
