/**
 * Ambient types for the dsh patches this plugin ships (patches/).
 *
 * The RUNTIME truth for `@deepseek-ai/dsh-agent` is the applied patch: a
 * patched host exports `markFallbackRouted` (spec §2.5 D-1). The dev-time
 * link farm (`scripts/setup-dsh-links.mjs`) resolves the UNPATCHED dsh
 * tree, whose types lack it — so without this declaration the plugin's own
 * build would fail (TS2614) against a perfectly valid unpatched host.
 *
 * The `@deepseek-ai/dsh-settings` augmentation below is EXPECTED DEAD CODE:
 * the dsh-settings exposure patch was removed in the
 * llm-fallbacks-settings-gateway plan (settings reach web clients through
 * the gateway channel instead), and nothing passes `exposeToWebClients`
 * anymore. The augmentation is retained only so stale host types that still
 * lack the option keep the plugin's build green until Plan B deletes this
 * file; it must NOT be read as license to use the option.
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
