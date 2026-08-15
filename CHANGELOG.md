# Changelog

<!-- release v0.1.0-alpha.2 -->

All notable changes to this project are documented in this file.

## [Unreleased]

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
