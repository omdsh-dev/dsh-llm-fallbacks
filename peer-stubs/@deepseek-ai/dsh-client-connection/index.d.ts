/**
 * Dev-time type-only stub for the `@deepseek-ai/dsh-client-connection` seam
 * consumed by the `dsh-llm-fallbacks` client half.
 *
 * The real package is private (not on the npm registry) and ships from the
 * composed dsh app at runtime; only the consumed type surface is declared
 * here — the settings domain of `IApiClient` (`describe` / `update` /
 * `replace` / `mutate` with the `expectedRevision` conflict semantics), the
 * `SettingsNamespaceView` descriptor, and the `ConnectionHandle`. Mirrors
 * dsh-private commit b8343cb (2026-08-09 snapshot,
 * `packages/host/apiproxy/lib/types/api/settings.d.ts` +
 * `packages/client/connection/src/client/index.ts`); keep in sync when the
 * dsh baseline moves.
 */

/** One wire error: stable machine code plus message and typed details. */
export interface RpcError {
  code: string
  message: string
  details?: unknown
}

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[]
  /** Whether the slot currently holds a value (the value itself never rides). */
  set: boolean
}

/** Wire view of one registered settings namespace. */
export interface SettingsNamespaceView {
  /** Namespace key (`fallbacks`, …). */
  ns: string
  /** Serialized schemastery schema envelope (`schema.toJSON()`). */
  schema: unknown
  /** Redacted resolved value (schema defaults → composition base → user layer). */
  value: unknown
  /** Redacted composition base layer, when the registrant declared one. */
  base?: unknown
  /** Redacted raw user section, when one exists. */
  user?: unknown
  /** When the owner applies changes. */
  applies: 'live' | 'restart'
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[]
  /** Monotonic revision of the raw user section; send back as `expectedRevision` on a write. */
  revision: number
}

/** One path-addressed edit carried by `settings.mutate`. */
export type SettingsPathOpView = {
  op: 'set'
  path: string[]
  value: unknown
} | {
  op: 'unset'
  path: string[]
}

/** RPC response envelope (rpc.ts mirror, consumed surface). */
export interface RpcResponse<V> {
  result: { ok: true; value: V } | { ok: false; error: RpcError }
}

/** Settings-domain unary methods of `IApiClient` (the map keys settings.* of RpcMethodMap). */
export interface SettingsApi {
  /** Describe every registered namespace: redacted layered values plus the serialized schema. */
  describe(payload: {}, signal?: AbortSignal): Promise<RpcResponse<{
    writable: boolean
    hasDocument: boolean
    namespaces: SettingsNamespaceView[]
  }>>
  /** Merge a patch into one namespace's user layer (validate → persist → commit). */
  update(payload: {
    ns: string
    patch: object
    expectedRevision?: number
  }, signal?: AbortSignal): Promise<RpcResponse<SettingsNamespaceView>>
  /** Replace one namespace's user section wholesale (`section: {}` resets to composition defaults). */
  replace(payload: {
    ns: string
    section: object
    expectedRevision?: number
  }, signal?: AbortSignal): Promise<RpcResponse<SettingsNamespaceView>>
  /** Apply path-addressed edits to one namespace's user section. */
  mutate(payload: {
    ns: string
    ops: SettingsPathOpView[]
    expectedRevision?: number
  }, signal?: AbortSignal): Promise<RpcResponse<SettingsNamespaceView>>
}

/** Client consumption face of the contract — the settings domain only (fetch/client.ts mirror). */
export interface IApiClient {
  settings: SettingsApi
}

/** One connection handle the web runtime installs as the `connection` service. */
export interface ConnectionHandle {
  /** The payload-direct API client. */
  readonly api: IApiClient
  /** Whether this connection talks to the local loopback host. */
  readonly isLoopback: boolean
}
