# AGENTS.md — dsh-llm-fallbacks

Project-level rules for coding agents in this repository. This file is the
**project layer**; the Morning Star harness lives under `.mstar/` (see
[Process artifacts](#process-artifacts)).

## Source priority

1. The current user instruction
2. This file (project rules)
3. `.mstar/` harness rules (`mstar-*` skills)
4. Role references (`mstar-roles`)

## Repository

`dsh-llm-fallbacks` is a TypeScript plugin for dsh (DeepSeek Harness): it
builds automatic provider/model fallback chains so agent steps keep running
when LLM requests fail (retry exhausted, auth, quota, rate limit). It mounts
into dsh as a **pure mount** — see [Code constraints](#code-constraints).

- Runtime: Node >= 22, pnpm >= 10 (project stack: pnpm 11.21+).
- Package manager: pnpm; CI installs with `pnpm install --frozen-lockfile`.
- License: MIT (`LICENSE` is authoritative).

## Build & test interface

- `pnpm test` — vitest run (full suite; includes the release-script
  contract tests in `tests/release-scripts.spec.ts`).
- `pnpm build` — full build: `tsc -p tsconfig.build.json` → `tsdown` →
  `build-client` → `tsc` → `verify-dist`.
- `pnpm release:prepare [-- <version> | -- --patch]` — release prep
  (see [Release flow](#release-flow)).
- `pnpm release:validate -- v<version>` — version/tag consistency check.
- Local workflow lint (not in CI): `actionlint .github/workflows/*.yml`
  (ci + release-prep + release).
- CI (`.github/workflows/ci.yml`): `pnpm test` + `pnpm build` on
  PR / push to main / manual.

## Changelog fragments (`.changes/`)

Every **user-visible change** MUST ship with a fragment in
`.changes/unreleased/` — fragments are what the changelog is made of.
`pnpm release:prepare` assembles them into `CHANGELOG.md` and archives them
to `.changes/archive/<version>/`. **A release with zero fragments fails at
publish time**: the changelog section is empty, and the Release workflow
refuses to create an empty GitHub Release.

Rules:

- **One file per change**: filename is any slug ending in `.md`
  (e.g. `add-foo.md`). `.changes/unreleased/README.md` and `.gitkeep` are
  ignored by the assembler.
- **Frontmatter**: optional `category:` key — one file carries ONE category
  (`Added`, `Changed`, `Fixed`, ...). It groups the fragment's bullets under
  a `### <category>` heading in the changelog. Default: `Changed`.
- **Body**: one or more **English bullet lines** (`- ` prefix). The changelog
  is single-language (English) and the body is rendered **verbatim** into
  `CHANGELOG.md`. Non-bullet lines (e.g. `<!-- CN -->`) are rendered verbatim
  too and garble the changelog — never put them in a fragment.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

- Keep each fragment focused on a single user-visible change.

## Documentation language

- **English only** for docs and user-facing text (decision 2026-08-14).
  `README.md` is the English main file; `README.zh-CN.md` is the Chinese
  translation. All `docs/*.md` are English.
- Never add Chinese prose to `README.md`, `docs/`, `CHANGELOG.md`, or
  fragments.

## Release flow

PR-driven, two steps — merging the release PR is the ONLY publish path
(no `push:tags` auto-publish):

1. **Release prep** (manual: Actions → Release prep → Run workflow): assembles
   fragments, bumps `package.json`, builds, and opens/updates a
   `release vX.Y.Z` PR (base `main`, label `release`). Pass an explicit
   version (the first release is `0.1.0-alpha.2`) or leave the input empty
   for an auto `--patch` bump.
2. **Merge the PR** → `release.yml` runs on the merge commit: validate →
   build → `npm publish --provenance --access public --tag latest` →
   tag `vX.Y.Z` → GitHub Release (prerelease when the version contains `-`).

Secrets: **zero long-term secrets**. npm auth is Trusted Publishing (OIDC,
tokenless) once the package exists; the one-time `NODE_AUTH_TOKEN` bootstrap
secret is only for the first publish and is deleted afterwards. Workflows use
only the built-in `GITHUB_TOKEN`. Release workflows run Node 24.19.0 /
pnpm 11.21.0.

Full SOP, npm auth setup, and rollback → `docs/release.md`.

## Code constraints

- **Mount-only**: the plugin never modifies the dsh source tree (bundle
  insert + client inject + own gateway; no patches, no postinstall step).
  Keep it that way.
- **Peers from the public registry**: all `@deepseek-ai/*` packages are
  `peerDependencies` ONLY — resolved from the npm registry at dev time
  (`autoInstallPeers` + user-level `~/.npmrc` token), never added to
  `dependencies`/`devDependencies`, never linked locally.
  `tests/peer-deps.test.ts` enforces this contract.
- **English commit messages**, conventional style (`feat:`, `fix:`,
  `docs:`, `chore:`, ...).
- **Feature branch → PR → main** for all changes; never commit directly to
  `main`.
- Match existing patterns and keep diffs surgical.

## Process artifacts

`.mstar/` is the Morning Star harness's local process SSOT: process artifacts
(`plans/`, `sdd/`, `status.json`, `iterations/`, ...) are **gitignored**;
tracked results are `.mstar/knowledge/` and `.mstar/specs/`. Harness rules
live in the `mstar-*` skills. This file intentionally carries no dynamic
state, current progress, or review details.
