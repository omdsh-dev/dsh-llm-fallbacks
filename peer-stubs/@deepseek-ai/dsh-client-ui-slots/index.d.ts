/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-client-ui-slots` seam
 * consumed by the `dsh-llm-fallbacks` client half.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — the slot-contract machinery the settings section registration relies
 * on: `SlotMap` / `LocaleNamespaceMap` merge targets, `PropsRuntime` /
 * `PropsLocale` / `PropsRenderSlots`, `SlotLabel`, `SlotComponent`,
 * `InjectFace`, `HostObservable`. Mirrors dsh-private commit b8343cb
 * (2026-08-09 snapshot); keep in sync when the dsh baseline moves.
 *
 * The `settings.section` SlotMap row is declared by the
 * `@deepseek-ai/dsh-client-ui-settings` stub (the shell owns the contract,
 * exactly as in the real source); the locale-namespace merge for the
 * `fallbacks` dictionary lives in `src/client/locales.ts`.
 */
import type { ReactNode } from 'react'

/** Slot contract table. Owners extend via declaration merging. */
export interface SlotMap {}

/** Locale namespace table. Dictionary owners extend via declaration merging. */
export interface LocaleNamespaceMap {}

/** Minimal observable snapshot source (renderer.ts mirror). */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** Selector hook over one observable snapshot (store.ts mirror). */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/** Translate a dictionary key with optional `{name}` template params. */
export type Translate<K extends string = string> =
  (key: K, params?: Record<string, unknown>) => string

/** Shared `common` vocabulary keys as merged by the locale plugin; `never` without the merge. */
export type CommonKeyOf = LocaleNamespaceMap extends { common: infer C } ? C & string : never

/** Key domain of a namespace-bound translate. */
export type LocaleKeysOf<N extends keyof LocaleNamespaceMap & string> =
  (LocaleNamespaceMap[N] & string) | CommonKeyOf

/** Namespace-addressed translate — the developer-facing alias over {@link Translate}. */
export type TranslateNS<N extends keyof LocaleNamespaceMap & string> = Translate<LocaleKeysOf<N>>

/** Dictionary shape for a declared namespace. */
export type LocaleDictOf<N extends keyof LocaleNamespaceMap & string> =
  Record<LocaleNamespaceMap[N] & string, string>

/** Locale share of the composed component props: the framework-injected `t` seat. */
export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string
  ? { t: TranslateNS<N> }
  : object

/** Slot cardinality. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
/** Slot data context. */
export type SlotScope = 'root' | 'session-maybe' | 'session'

/** One SlotMap entry (index.ts mirror, consumed surface only). */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
  keyProps?: Record<string, object>
  hookContext?: unknown
  inject?: object
}

/** Runtime dispatch spec for one slot, recorded from a register call's `children`. */
export type SlotSpec<E extends SlotEntryDef> = {
  kind: E['kind']
  scope: E['scope']
} & ('inject' extends keyof E
  ? E extends { inject: infer Injected extends object }
    ? { inject: Injected }
    : { inject?: object }
  : { inject?: never })

/** Child-slot declaration table for register(). */
export type ChildrenDecl = { [P in keyof SlotMap & string]?: SlotSpec<SlotMap[P]> }

/** Owner-supplied props share for a slot key. */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

/** Registration/dispatch key domain of one keyed slot. */
export type EntryKeyOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
    ? keyof P & string
    : string

/** Key-dependent props supplied by the owner at one keyed dispatch site. */
export type KeyPropsOf<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
> = SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
  ? EntryKey extends keyof P
    ? P[EntryKey] extends object ? P[EntryKey] : never
    : never
  : object

/** Opaque per-render occurrence context declared by one slot. */
export type HookContextOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { hookContext: infer Context } ? Context : never

/** Common render-occurrence inject face declared by one slot. */
export type SlotInjectOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { inject: infer Injected extends object } ? Injected : object

/** Scope axis of a slot key's SlotMap entry. */
export type ScopeOf<K extends keyof SlotMap & string> = SlotMap[K]['scope']

/** Framework standard kit delivered to EVERY slot component (empty here; the runtime merges). */
export interface GlobalStandardProps {}
/** Framework standard kit for session-scope slots (empty here). */
export interface SessionStandardProps {}
/** Framework standard kit for session-maybe slots (empty here). */
export interface SessionMaybeStandardProps {}

/** The session id type (falls back to `string` without the runtime merge). */
export type SessionIdOf = SessionStandardProps extends { sessionId: infer S } ? S : string

/** Runtime props share for a slot key: owner share + session kit + the global seat. */
export type PropsRuntime<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
> =
  OwnerOf<K> &
  KeyPropsOf<K, EntryKey> &
  SlotInjectFace<SlotInjectOf<K>> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/** renderSlot dispatch options. */
export interface RenderOpts<EntryKey extends string = string> {
  entryKey?: EntryKey
  only?: string
  fallback?: ReactNode
  hookContext?: unknown
}

/** Keys of a slot-key union whose SlotMap entry is chain-kind. */
export type ChainKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S]['kind'] extends 'chain' ? S : never) : never

/** Keys in a render share whose dispatch occurrence requires hookContext. */
type ContextualKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S] extends { hookContext: unknown } ? S : never) : never

/** Keys in a render share with the ordinary optional options bag. */
type OrdinaryKeysOf<S extends keyof SlotMap & string> = Exclude<S, ContextualKeysOf<S>>

type RenderSlotFn<S extends keyof SlotMap & string> =
  ([ContextualKeysOf<S>] extends [never] ? object : {
    <
      K extends ContextualKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts: RenderOpts<EntryKey> & { hookContext: HookContextOf<K> },
    ): ReactNode
  }) &
  ([OrdinaryKeysOf<S>] extends [never] ? object : {
    <
      K extends OrdinaryKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts?: Omit<RenderOpts<EntryKey>, 'hookContext'>,
    ): ReactNode
  })

/** Child-slot render share: `renderSlot` statically narrowed to declared children keys. */
export type PropsRenderSlots<S extends keyof SlotMap & string> = {
  renderSlot: RenderSlotFn<Exclude<S, ChainKeysOf<S>>>
  readonly __renders?: ((key: S) => void) | undefined
} & ([ChainKeysOf<S>] extends [never] ? object : {
  renderSlotChain: <K extends ChainKeysOf<S>>(key: K, owner: OwnerOf<K>, opts?: { fallback?: ReactNode; overlay?: boolean }) => ReactNode
}) & ('session' extends ScopeOf<S> ? { SessionProvider: (props: { empty?: () => ReactNode; children: (sessionId: SessionIdOf) => ReactNode }) => ReactNode } : object)

/** Registration-position component shape: the bare call signature. */
export type SlotComponent<P> = (props: P) => ReactNode

/** Registrant hooks compartment. */
export type HooksSources = Record<string, HostObservable<unknown>>

/** Framework-owned props visible while a slot-level contextual Hook is bound. */
export type StandardPropsOf<K extends keyof SlotMap & string> =
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/** One function-valued slot-level inject.hooks member factory. */
export type SlotHookFactory<
  K extends keyof SlotMap & string,
  Hook extends (...args: never[]) => unknown,
> = (
  standard: StandardPropsOf<K>,
  hookContext: HookContextOf<K>,
) => Hook

type BoundHookOf<Definition> =
  Definition extends HostObservable<infer Snapshot>
    ? SnapshotSelectorHook<Snapshot>
    : Definition extends (...args: never[]) => infer Hook
      ? Hook extends (...args: never[]) => unknown ? Hook : never
      : never

/** Selector-hook share synthesized from a hooks compartment. */
export type PropsSlotHooks<HS extends object> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  BoundHookOf<HS[N]>
}

/** Component-side view of a slot dispatcher's common inject face. */
export type SlotInjectFace<I extends object> =
  I extends { hooks: infer HS extends object } ? Omit<I, 'hooks'> & PropsSlotHooks<HS> : I

/** Selector-hook share synthesized from an entry inject hooks compartment. */
export type PropsHooks<HS extends HooksSources> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  SnapshotSelectorHook<HS[N] extends HostObservable<infer T> ? T : never>
}

/** The component-side view of an inject face. */
export type InjectFace<I extends object> =
  I extends { hooks: infer HS extends HooksSources } ? Omit<I, 'hooks'> & PropsHooks<HS> : I

/** A list-entry display label: a plain string, or a thunk re-evaluated per read. */
export type SlotLabel = string | (() => string)

/** Kind shape fields carried in register options (list kind: id/order/label). */
export type KindOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  M = never,
> =
  SlotMap[K]['kind'] extends 'keyed' ? { key: EntryKey }
    : SlotMap[K]['kind'] extends 'list' ? { id: string; order?: number; label?: SlotLabel }
      : SlotMap[K]['kind'] extends 'chain' ? {
          select: ChainSelect<SlotMap[K] extends { owner: infer O extends object } ? O : object, M>
          priority?: number
        }
        : object

/** Chain-entry selector (chain kind only). */
export type ChainSelect<O extends object, M> = (owner: O) => M | null

/** Resolve a possibly-thunked list label at read time. */
export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}
