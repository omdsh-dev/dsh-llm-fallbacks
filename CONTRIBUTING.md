# Contributing to dsh-llm-fallbacks

Thanks for taking the time to contribute. `dsh-llm-fallbacks` is a TypeScript
plugin for dsh (DeepSeek Harness) that builds automatic provider/model fallback
chains so agent steps keep running when LLM requests fail — see
[README.md](README.md) for what it does and
[CONCEPTS.md](CONCEPTS.md) for how it is put together.

This document covers the practical mechanics: prerequisites, setup, the build
and test commands, the change workflow, and the code constraints this repository
enforces.

## Before you start

- Participation in this project is covered by
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant v2.1).
  Unacceptable behavior can be reported to tech@btang.cn.
- Bug reports, feature requests, and questions go to
  [the issue tracker](https://github.com/omdsh-dev/dsh-llm-fallbacks/issues).
  This repository does not currently ship GitHub issue templates or a pull
  request template, so open a plain issue or pull request and describe the
  change directly.
- **Security problems do not go through public issues.** Report them privately
  as described in [SECURITY.md](SECURITY.md).

## Prerequisites

- **Node >= 22** — declared in `package.json` under `engines.node`.
- **pnpm >= 10** — the project stack is pnpm 11.21+; CI installs with pnpm
  11.21.0 (`.github/workflows/ci.yml`).
- **Peer resolution at development time.** The `@deepseek-ai/*` packages are
  private to the dsh host and declared as `peerDependencies` (`^0.1.5-rc.1`).
  They resolve from the npm registry during development through
  `autoInstallPeers: true` in `pnpm-workspace.yaml` plus an authentication token
  in your user-level `~/.npmrc`. The full setup (including the pnpm 11
  credential rule) is described in [docs/install.md](docs/install.md).

## Setup

```sh
git clone https://github.com/omdsh-dev/dsh-llm-fallbacks.git
cd dsh-llm-fallbacks
pnpm install
```

CI installs with `pnpm install --frozen-lockfile`
(`.github/workflows/ci.yml`), so when a change touches dependencies, commit the
matching `pnpm-lock.yaml` update together with `package.json`.

## Build and test commands

| Command | What it does |
|---|---|
| `pnpm test` | vitest run — the full suite, including the release-script contract tests in `tests/release-scripts.spec.ts`. |
| `pnpm build` | Full build: `tsc -p tsconfig.build.json` → `tsdown` → `build-client` → `tsc` → `verify-dist`. |
| `pnpm typecheck` | TypeScript only (host build config + project emit check, then `typecheck:scripts` over `scripts/**`); faster than the full build. |
| `pnpm release:prepare [-- <version> \| -- --patch]` | Release prep: bump the version, assemble `.changes/unreleased/` fragments into `CHANGELOG.md`, archive them, and open/update the `release vX.Y.Z` PR (normally run through the Release prep workflow). |
| `pnpm release:validate -- v<version>` | Version/tag consistency check. |
| `actionlint .github/workflows/*.yml` | Workflow lint for the ci, release-prep, and release workflows. Local-only — this step is not part of CI. |

`pnpm test` covers the repair-script fixture suites; CI additionally installs
the `zstd` binary for them (`.github/workflows/ci.yml`), so install `zstd`
locally if those suites fail for you with a missing-binary error.

## Change workflow

1. **Branch from `main` and open a pull request.** All changes land through a
   PR into `main`; never commit directly to `main`.
2. **Keep the diff surgical** and match the patterns already in the codebase.
   Prefer extending an existing module over introducing a second convention
   beside it.
3. **Write conventional English commit messages**: `feat:`, `fix:`, `docs:`,
   `chore:`, and so on.
4. **Run the checks before opening the PR**: `pnpm test`, `pnpm build`, and
   `pnpm typecheck`. CI runs `pnpm test`, `pnpm typecheck` and `pnpm build` on
   every PR (`.github/workflows/ci.yml`).
5. **Add a changelog fragment** for any user-visible change (next section).

## Changelog fragments

Every user-visible change ships with one fragment file in
`.changes/unreleased/`. The fragments are what the changelog is made of:
`pnpm release:prepare` assembles them into `CHANGELOG.md` and archives them to
`.changes/archive/<version>/`.

- **One file per change.** The filename is any slug ending in `.md`
  (for example `add-foo.md`). `README.md` and `.gitkeep` are ignored.
- **Optional frontmatter.** A `category:` key groups the fragment's bullets
  under a `### <category>` heading in the changelog (`Added`, `Changed`,
  `Fixed`, ...); one file carries exactly one category. The default is
  `Changed`.
- **Body: English `- ` bullet lines only.** The body is rendered verbatim into
  `CHANGELOG.md`. Non-bullet lines are rendered verbatim too and garble the
  changelog, so never put them in a fragment.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
```

A release with zero fragments fails at publish time — the changelog section
would be empty and the Release workflow refuses to create an empty GitHub
Release. Format reference: [.changes/unreleased/README.md](.changes/unreleased/README.md)
and [docs/release.md](docs/release.md).

## Code constraints

- **Mount-only.** The plugin never modifies the dsh source tree — it works by
  bundle insert + client inject + its own gateway, with no patch steps and no
  `postinstall`. Keep it that way.
- **`@deepseek-ai/*` packages are `peerDependencies` only.** Never add them to
  `dependencies`, `devDependencies`, or `optionalDependencies`, and never
  reintroduce a local link farm. `tests/peer-deps.test.ts` enforces this
  contract: peer-only placement of every `@deepseek-ai/*` entry,
  `autoInstallPeers: true`, and the absence of the retired `dsh:link` /
  link-farm scripts.
- **Match existing patterns and keep diffs surgical.**

## Documentation language

English only for docs and user-facing text (project decision 2026-08-14).
`README.md` is the English main file and `README.zh-CN.md` is its Chinese
translation; all files under `docs/` are English. Never add Chinese prose to
`README.md`, `docs/`, `CHANGELOG.md`, or changelog fragments — new Chinese
prose belongs in `README.zh-CN.md` only.

## Release flow

Releases are PR-driven and two-step, and **merging the release PR is the only
publish path** — a manual `git tag` does not publish:

1. **Release prep** (manual: Actions → Release prep → Run workflow) assembles
   the fragments, bumps `package.json`, builds, and opens or updates a
   `release vX.Y.Z` PR targeting `main`.
2. **Merge that PR** → the Release workflow validates, builds, publishes to npm
   with `--provenance --access public` and a version-derived dist-tag, tags
   `vX.Y.Z`, and creates the GitHub Release.

Publishing authenticates through npm Trusted Publishing (OIDC) with zero
long-term secrets, and the workflows use only the built-in `GITHUB_TOKEN`.
Contributions are accepted under the project's MIT license (see
[LICENSE](LICENSE)). The full SOP — npm authentication, checklist, and
rollback — is in [docs/release.md](docs/release.md).

## Questions and getting help

If something in this guide is unclear or appears to contradict the repository,
open an issue at
[https://github.com/omdsh-dev/dsh-llm-fallbacks/issues](https://github.com/omdsh-dev/dsh-llm-fallbacks/issues)
and describe what you were trying to do.
