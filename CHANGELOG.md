# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.1.0-alpha.1] - 2026-08-13

### Added

- Initial plugin release: automatic provider/model fallback chains (cooldown, role-based resolution) wired into the dsh host via cordis, a web settings page, and dsh role patches that auto-apply on plugin install.
- Two-block configuration model: `rootChain` plus role entities, with migration from the legacy single-chain shape and save-time validation.

### Changed

- Feedback round: role-requires-model-config save guard, downgrade-clear switch copy, and diagnostics/reporting improvements.

### CI / Ops

- GitHub Actions verify pipeline (tests + build) on the pnpm-native toolchain.
