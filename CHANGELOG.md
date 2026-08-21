# Changelog

<!-- release v0.1.0-alpha.2 -->

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.3.3] - 2026-08-21

### Fixed

- Register the `settings.plugin.item` card with `id` alongside `key` so it mounts on dsh hosts that still declare the slot as a list (pre-rc.7) instead of failing with `list slot "settings.plugin.item" requires options.id`.

### Changed

- Upgrade every `@deepseek-ai/dsh-*` peer dependency to `^0.1.1-rc.1` (dsh 0.1.1-rc.1, 2026-08-21); no breaking seam consumed by this plugin changed, so no source migration was required.

## [0.3.2] - 2026-08-20

### Added

- Add a `/settings` write surface for llm-fallbacks in dsh-tui profiles: the fallbacks section edits every web settings-card capability (JSON text fields for complex config), with full parity to the web card. Requires dsh-tui >= v0.8.5 (commit `c51661f`).
- Add `/fallbacks config revert-seed <role-id>` (restores a seeded role's persona) and enrich the `/fallbacks config` readback with time slots, timezone, and role rules.

### Fixed

- Support selectors whose model id contains `/` (e.g. NVIDIA NIM `nvidia/minimaxai/minimax-m3`), previously rejected as an "extra separator".

## [0.3.1] - 2026-08-20

### Changed

- The English README uses the plugin's English UI labels only (Main agent, Time slots, Default model, Default fallback chain, time-slot switch / fallback switch) and no longer mixes Chinese terms. The language switcher keeps the `[中文]` label as the sole Chinese in that file.
- Upgrade every `@deepseek-ai/dsh-*` peer dependency to `^0.1.0-rc.8` (dsh 0.1.0-rc.8, 2026-08-19).
- Replace the deleted `@deepseek-ai/dsh-client-web-react` dependency: the uSES snapshot bind is vendored in the client half (`src/client/use-snapshot.ts`, same contract as rc.7) and `SnapshotSelectorHook` is imported from `@deepseek-ai/dsh-client-ui-slots`; the client bundle's loader-table externals follow the rc.8 platform table.
- Add `use-sync-external-store` as a runtime dependency for the vendored snapshot hook.

## [0.3.0] - 2026-08-18

### Changed

- README now features the time-slot model (分时切换): peak/valley preset windows (Liang Peak / Liang Valley / GLM Peak / GLM Valley) and custom slots each carry their own fallback chain, the first matching row wins, and the all-day chain stays as the last resort with an official V4 tail (Flash XOR Pro). The English README introduces the feature as Time slots with a language-matched screenshot; the Chinese README leads with the 峰谷无忧 name; docs/configuration.md names the same model in its Time slots section.
- The all-day `rootChain` now ends with the default model (official V4 Flash or Pro) as the last-resort fallback; the default fallback chain is walked first. Card copy, save validation, and the gateway match this order (UI top-to-bottom = walk order).
- Settings card: the new 主代理 section groups 分时槽设置 (slot rows + an in-section timezone picker that locks to Asia/Shanghai while any preset row exists; rows are drag-reorderable and collapsible to name + first model; custom rows carry an editable name), 默认降级链 (the all-day chain as a configurable provider/model selector list — the old preemption hints are removed) and 默认模型 (the official V4 Flash | Pro head panel); zh preset labels are 梁文峰 / 梁文谷 / GLM峰 / GLM谷, with a zai-coding-cn validity caveat on the GLM presets.
- Role rules are now subagent-only: the origin control is removed from the settings card, root requests never match rules, and a persisted legacy rule `origin` is ignored at match time; role panels are collapsible to id + first chain model (or inherit-root).
- The host model picker labels the virtual row `Auto: <displayName>[<slot>]` (e.g. `Auto: DeepSeek V4 Flash[Liang Peak]`) using the catalog display name, not the model id; the catalog id stays `Auto`.
- Custom time-slot rows show the host timezone as a read-only label (`Asia/Shanghai (UTC+8)`); there is no timezone picker. Preset-only configs hide the label; mixed configs show Asia/Shanghai. Saving a custom-only config persists the host timezone.
- Settings card: the card footer is gone — Save/Discard now live beside the 主代理 and 子代理 section headings (and inside the expanded 高级选项 body, where the global Reset also lives), and validation / save errors render under the section that owns them (a store write failure renders under the section whose Save was clicked). Role cards default collapsed (the whole first row is the toggle, with a separate drag handle on time-slot rows so click ≠ drag), and collapsed time-slot rows stay drag-reorderable.
- Settings card (PR #62 UX round 3): the Reset-to-defaults button and its confirmation dialog are gone from the card (the gateway `fallbacks/reset` RPC and store `resetToDefaults()` stay as host APIs), and each big section (主代理 / 子代理 / 高级选项) now saves ONLY its own fields — 主代理 persists `rootChain` / `timeSlots` / `tz` (+ the card-level `enabled`), 子代理 persists `roles`, 高级选项 persists the advanced scalars — with every other section's value taken from the last accepted config, so one section's Save never rides along (or clobbers) another section's unsaved edits; validation and Discard are per-section too, and after a save only clean sections re-seed from the accepted config.

### Added

- A virtual `FallbacksChain` provider with a single `Auto` row appears in the model picker whenever fallbacks is enabled (no conformance requirement for the row itself); selecting it uses the configured chain as the root primary — a conforming all-day head (exactly one official V4 model) is still required for the override/delegate to succeed — while selecting a real model keeps fallback-only behavior.
- Time-slot rows (`fallbacks.timeSlots`) rotate the effective root chain by wall-clock windows: four frozen UTC+8 presets (Liang Peak / Liang Valley / GLM Peak / GLM Valley; windows are code constants, models-only edits) or custom `start`/`end`/`days` windows; the first matching row wins and the all-day row is always last. The all-day `rootChain` head must be exactly one official V4 model (`deepseek-official/deepseek-v4-flash` or `deepseek-official/deepseek-v4-pro`; trailing entries allowed) — enforced by the settings card and the gateway on save (a legacy multi-model chain warns at startup, keeps the fallback-only walk, and cannot be saved as-is). Slot changes apply on the next root request and are logged as time-slot switches (分时切换 / time-slot switch) — a routing seed exempt from cooldown and switch caps — never as fallback switches (降级切换 / fallback switch).
- Settings card: preset peak time-slot rows (Liang Peak / GLM Peak) now carry compact cost tags in their collapsed title — a red 高消耗 / High Cost chip plus a yellow x2 (Liang Peak) or x3 (GLM Peak) multiplier chip (valley and custom rows render none) — and the currently-active slot row (resolved with the runtime's `resolveSlotState`, the P5 single source) shows an 激活 / Active chip; when the active surface is the all-day chain no row is tagged. The chips were restyled as semi-transparent outlined pills hugging the slot name (the first-model meta is right-aligned), and the GLM presets (GLM Peak / GLM Valley) are unselectable in the preset picker until zai-coding-cn is configured (the options stay visible with a 需配置 zai-coding-cn / requires zai-coding-cn suffix, and the add action refuses a GLM preset defensively).

### Fixed

- Clicking "Restore default persona" on a seeded role now resets the in-card draft even when the saved value is already the seed default (issue #59).
- Time-slot panels in the settings card stay collapsed by default: they no longer re-expand after a save (role cards already behaved this way; a freshly added row still opens for editing).
- Release prep no longer calls `gh pr reopen` on a closed release PR; it updates an open PR or creates a new one instead.

## [0.2.2] - 2026-08-17

### Fixed

- dsh 0.1.0-rc.7 loads the plugin again: the Fallbacks card registers into the keyed `settings.plugin.item` slot with `key: 'fallbacks'` (the old list-slot `id`/`order` options are gone).
- Every `@deepseek-ai/dsh-*` peer dependency is floored to `^0.1.0-rc.7` (`cordis` / `schemastery` / `react` unchanged).
- Sessions containing `fallbacks/switch` events no longer refuse to load: the plugin stops writing durable switch events, and `scripts/repair-fallbacks-switch-logs.ts` marks legacy events ignorable so affected sessions load again.
- The ineffective apply()-time event-type registration stopgap is removed.

### Added

- Dispatch-time role resolution: on a subagent's first request its role is now resolved in three stages — explicit (`agentPreset` matches a declared role id) → deterministic rules (unchanged) → LLM auto-match from the declared role taxonomy (`fallbacks.roleAutoMatch`, default `true`). Setting `roleAutoMatch: false` disables only the LLM auto-match stage; it reproduces the previous rules-only behavior when there is no explicit role (the explicit `agentPreset` stage is independent new behavior, not gated by the toggle).
- The resolved role's chain-head model is injected into the subagent's first request and recorded via an explicit `role → model` log line (no durable `fallbacks/switch` event is written — issue #52 stop-write; the `role-inject` reason survives only in the event vocabulary for legacy events).

### Changed

- The web settings card's root-chain section makes explicit that the root chain engages **only after the current session's selected model fails** — it never preempts the session model — and shows a prefer-session-model hint only when the plugin is enabled and a root chain is configured.
- The card's read-only status block is trimmed to the **recent switch** only: the "current effective model" line and the `selectionNote` degradation line were removed from the card (the documented model-selection degradation is re-homed to `docs/verification.md` §4.7).
- The settings card now always renders an **Enable role auto-match** switch for `fallbacks.roleAutoMatch` (default `true`), reading and writing the existing config key — the schema default applies even to legacy configs that never declared the key, so the toggle always shows (default on) and a legacy config's first save persists `roleAutoMatch: true`.
- The conversation `fallbacks-switch` node now shows an explicit **role badge + `role → model`**, and `role-inject` switches display a localized reason rather than the raw string.

## [0.2.1] - 2026-08-16

### Fixed

- Sessions containing `fallbacks/switch` events no longer refuse to load after a dsh restart: the plugin registers its session event type at startup (a stopgap until the upstream registration surface lands; tracked in the .mstar plans).
- When registration is unavailable, the switch still applies but the durable event is skipped — a session log is never written with an unregistered event type.

## [0.2.0] - 2026-08-16

### Added

- dsh-tui profile support: the plugin now has a first-class client surface in the terminal TUI — `/fallbacks` and the new read-only `/fallbacks config` subcommand appear in the TUI `/` menu with localized descriptions and `config` completion (via the `tuiCommandTrees` service; zero dsh-TUI changes).
- `/fallbacks config` read-only subcommand: prints the composed configuration summary (enabled / trigger codes / root chain / roles / cooldown / revert / caps / presets) with file-edit hints — the TUI settings readback (the TUI has no settings page; configuration stays file-based).

### Changed

- Split the README compatibility badge into two: `dsh web` and `dsh tui` (simplified text).
- Refactor README: unified client-agnostic install (copyable `--profile web|dsh-tui` lines), condensed Quick start / Features / Mount-only; details moved to `docs/` (install variants, TUI profile, consumer API); condensed Preset roles section retained (7 bundled roles + `presets` switch).

### Fixed

- `/fallbacks` command registration no longer uses an empty `input.hint` — the real dsh-commands registry rejects empty hints, so the command silently never appeared in any profile; it now registers in both web and dsh-tui profiles.

## [0.1.7] - 2026-08-16

### Changed

- Settings card: seeded role ids are now immutable — the id input of any seed/preset role row is disabled; non-seeded rows keep editable ids.

## [0.1.6] - 2026-08-15

### Added

- Preset roles: bundle 7 omp-style generic subagent roles (designer, librarian, reviewer, scout, security-reviewer, sonic, task) declared automatically on apply via the role-seeds surface (config `presets: 'bundled' | 'none'`, default `bundled`); `presetRoles` exported from the package root.

## [0.1.5] - 2026-08-15

### Added

- Role seeds: the `llm-fallbacks` service grows three additive methods — `declareSeeds` (a, declare `[{ id, persona }]`), `getEffectiveRoles` (b, read back effective roles with seeded / persona-overridden state), and `revertSeededPersona` (c, revert one id to its currently declared seed default) — the service shape grows from six to nine keys, strictly additively.
- Role seeds: the `fallbacks/get` gateway response (and the post-write `set` / `reset` responses) gains an additive `seeds` badge field, and a new `fallbacks/revert-seed` gateway endpoint reverts one seeded role to its seed default.
- Settings card: seeded roles show a seed-default / override badge with a revert button, and saving a seeded role with an empty chain is allowed (seeds never write chains).

## [0.1.4] - 2026-08-15

### Added

- Add the dshfind plugin-directory badge to the README (English and Chinese).

### Fixed

- Fixed the Fallbacks settings card occasionally showing stale configuration after Save when a settings refresh overlapped the write.

### Changed

- README release status now reflects the current package version (0.1.3).
- Settings card: role persona is now a multiline text field.
- Settings card: role model chains no longer offer a provider wildcard (`provider/*`) — existing wildcard entries read back with a conversion hint and become exact entries when a model is picked.
- Settings card: the Advanced options section is collapsible and starts collapsed.

## [0.1.3] - 2026-08-15

### Fixed

- Fixed the web settings card failing to load with "client-modules: require(&quot;@deepseek-ai/schemastery&quot;) missed the module table": the `Config` schema moved to a host-only module (`src/schema.ts`) and the client bundle no longer externalizes `@deepseek-ai/schemastery` — the client graph now reaches it type-only, and the bundle purity gate guards the split.

### Changed

- Role entities now carry only an `id` plus a `persona` (personality hint): the `label` field is removed and `description` is renamed to `persona`. Existing `label` / `description` keys are flagged as legacy (`legacyKeys` + startup warning) and stay inert until manually removed (migration rows in `docs/configuration.md`).
- The settings card reorders its form: the root agent fallback chain, role entities, and role rules come first, with trigger failure codes, cooldown and switch-limit options grouped under an "Advanced options" heading at the end.
- The root agent's chain editor no longer offers `provider/*` wildcard entries — the root chain stays provider/model lines and provider-any matching lives in the role rules (role chain editors keep the wildcard, and existing YAML `provider/*` entries remain valid).

## [0.1.2] - 2026-08-15

## [0.1.0-alpha.4] - 2026-08-14

### Changed

- npm publishing is now pure OIDC (Trusted Publishing): the bootstrap `NODE_AUTH_TOKEN` mode and the optional secret env were removed after the npm-side trusted publisher was configured; `npm publish --provenance` authenticates entirely via the GitHub OIDC id-token.

## [0.1.0-alpha.3] - 2026-08-14

### Fixed

- Published package now ships `schemastery` as a runtime dependency: the shipped `dist/*.d.ts` type declarations reference it, and consumers without `skipLibCheck` could not resolve the package types (devDependencies are not installed for consumers). Type resolution verified against a fresh consumer install.

## [0.1.0-alpha.2] - 2026-08-14

### Changed

- In-conversation fallback switch notice now reads 模型已降级 / Model downgraded with a warn-tone title (was neutral 模型切换 / Model switch).
- Declared roles must configure a model chain: the settings card blocks saving a chain-less role (inline hint + banner), and host config validation warns on a missing/empty role chain (never crashes; runtime fallback to `rootChain` preserved).

### Added

- PR-driven npm release pipeline: GitHub Actions `release-prep` (changelog fragments → `release vX.Y.Z` PR) + `release` (Trusted Publishing publish with provenance, tag, GitHub Release), zero long-term secrets.
- Consumer surface: full runtime library API re-exported from the package root (`resolveRole` / `resolveChain` / `validateFallbacksConfig` / `detectLegacyKeys` / types) plus a named cordis service `llm-fallbacks` (`ctx.get('llm-fallbacks')` capability probe).
- GitHub Actions CI verify pipeline (tests + full build) on PRs and `main` pushes.
- Changelog fragment mechanism (`.changes/unreleased/`) with English `CHANGELOG.md`.

## [0.1.0-alpha.1] - 2026-08-13

### Added

- Initial plugin release: automatic provider/model fallback chains (cooldown, role-based resolution) wired into the dsh host via cordis, a web settings page, and dsh role patches that auto-apply on plugin install.
- Two-block configuration model: `rootChain` plus role entities, with migration from the legacy single-chain shape and save-time validation.

### Changed

- Feedback round: role-requires-model-config save guard, downgrade-clear switch copy, and diagnostics/reporting improvements.

### CI / Ops

- GitHub Actions verify pipeline (tests + build) on the pnpm-native toolchain.
