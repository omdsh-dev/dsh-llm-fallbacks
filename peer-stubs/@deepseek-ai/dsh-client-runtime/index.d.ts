/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-client-runtime` seam
 * consumed by the `dsh-llm-fallbacks` client half.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — `ClientContext`, the `slots` Context merge (the `SlotsService`
 * register/inject face the settings section registration uses), the
 * `settings/changed` + `connection/reset` event merges, and the
 * `createSnapshotStore` / `SnapshotStore` store engine. Mirrors dsh-private
 * commit b8343cb (2026-08-09 snapshot,
 * `packages/client/runtime/src/client/index.ts` + `src/client/slots.ts`);
 * keep in sync when the dsh baseline moves.
 *
 * Runtime access in tests is aliased (vitest `resolve.alias`) to
 * `tests/support/runtime-stub.ts`; this stub only types the plugin source.
 */
import type { Context } from 'cordis'
import type {
  EntryKeyOf, InjectFace, KindOptions, LocaleNamespaceMap, PropsLocale, PropsRuntime,
  SlotComponent, SlotLabel, SlotMap,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Client-side Cordis context after declaration merging. */
export type ClientContext = Context

/** Minimal observable snapshot source. */
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }

/** Writable snapshot store (bare data face; React selector hooks live in web-react). */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

/** Create a snapshot store (engine contract, consumed surface). */
export function createSnapshotStore<T>(
  init: T, opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } }): SnapshotStore<T>

/** The slot-service face the plugin consumes (runtime `SlotsService` mirror). */
export class SlotsService {
  /**
   * The single registration API. List-kind registrations carry
   * `id`/`order`/`label`; the component is checked against the composed props
   * (runtime + locale seats + the inject business face).
   */
  register<
    K extends keyof SlotMap & string,
    EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
  >(
    options: { name: K; locale?: N } & KindOptions<K, EntryKey>,
    component: SlotComponent<PropsRuntime<K, EntryKey> & PropsLocale<N>>,
  ): () => void
  register<
    K extends keyof SlotMap & string,
    I extends object,
    EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
  >(
    options: { name: K; locale?: N; inject: (...args: never[]) => I } & KindOptions<K, EntryKey>,
    component: SlotComponent<PropsRuntime<K, EntryKey> & InjectFace<I> & PropsLocale<N>>,
  ): () => void
  /**
   * Inject a registration callback that runs once the target slot's
   * declaration is on the ledger; returns a disposer.
   */
  inject(key: keyof SlotMap & string, callback: () => (() => void) | Iterable<() => void>): () => void
}

declare module 'cordis' {
  interface Events {
    /** A settings namespace changed (host-pushed wire event). @mode emit */
    'settings/changed'(ns: string): void
    /** A connection generation was (re-)established. @mode emit */
    'connection/reset'(): void
  }
  interface Context {
    /** The slot system's cordis Service layer. */
    slots: SlotsService
  }
}

export type { SlotLabel }
