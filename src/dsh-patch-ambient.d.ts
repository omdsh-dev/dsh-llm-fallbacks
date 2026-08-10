/**
 * Ambient types for the dsh patches this plugin ships (patches/).
 *
 * The RUNTIME truth is the applied patch: a patched @deepseek-ai/dsh-agent
 * exports `markFallbackRouted` (spec §2.5 D-1) and a patched
 * @deepseek-ai/dsh-settings accepts the registration option
 * `exposeToWebClients` on `SettingsSectionHooks`. The dev-time link farm
 * (`scripts/setup-dsh-links.mjs`) resolves the UNPATCHED dsh tree, whose
 * types lack both — so without these declarations the plugin's own build
 * would fail (TS2614 / TS2353) against a perfectly valid unpatched host.
 *
 * These declarations keep the plugin's build green against an unpatched
 * linked dsh. They are compile-time only (ambient, no runtime emit); after
 * the patch is applied and the host rebuilt, the real host types are the
 * source of truth — re-verified by the QA gate (docs/verification.md §6).
 * The runtime degrade path for an absent `markFallbackRouted` is guarded in
 * src/index.ts (optional call → pre-branch semantics, never throws) and
 * pinned by tests/unpatched-host.spec.ts.
 */
export {}

declare module '@deepseek-ai/dsh-agent' {
  export function markFallbackRouted(config: import('@deepseek-ai/dsh-llm').LlmCallConfig): import('@deepseek-ai/dsh-llm').LlmCallConfig
}

declare module '@deepseek-ai/dsh-settings' {
  interface SettingsSectionHooks<T> {
    exposeToWebClients?: boolean
  }
}
