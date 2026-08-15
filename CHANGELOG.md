# Changelog

<!-- release v0.1.0-alpha.2 -->

All notable changes to this project are documented in this file.

## [Unreleased]

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
