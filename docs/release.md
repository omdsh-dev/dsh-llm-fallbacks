# Release Guide

This document describes the `dsh-llm-fallbacks` release process: npm authentication (pure OIDC Trusted Publishing), the release SOP (trigger → review → merge), changelog fragment format, the release checklist, and rollback / re-run instructions.

## Release model (PR-driven)

Releases are **two-step**, not a one-click black box:

1. **Release prep** (manual trigger) → generates a reviewable `release vX.Y.Z` PR (version bump + English changelog + fragment archive).
2. **Merging that PR is what publishes** → the `Release` workflow automatically publishes + tags + creates the GitHub Release.

The repository **does not declare `NPM_TOKEN`** and **no longer carries any token secret**: publishing authenticates to npm purely via Trusted Publishing (OIDC `id-token` + `npm publish --provenance`, tokenless). The first-publish bootstrap token mode (a one-time `NODE_AUTH_TOKEN`) was retired on 2026-08-14 after the npm-side Trusted Publisher was configured — see the "npm authentication" section for history. On the GitHub side only the built-in `GITHUB_TOKEN` is used. **There is no `push:tags` auto-publish path** — a manual `git tag && git push --tags` does not publish; the only publishing entry point is merging a `release vX.Y.Z` PR.

Related workflows:

| Workflow | File | Trigger |
|---|---|---|
| CI | `.github/workflows/ci.yml` | PR / push to main / manual |
| Release prep | `.github/workflows/release-prep.yml` | manual (Actions → Release prep → Run workflow) |
| Release | `.github/workflows/release.yml` | merging a PR titled `release v*` |

## npm authentication: Trusted Publishing (OIDC, pure tokenless)

npm Trusted Publishing (OIDC) can only be configured for an **existing package** — there is no pre-registration path. History: the first release (`0.1.0-alpha.2`) used a one-time bootstrap Granular Access Token (`NODE_AUTH_TOKEN` secret); after the first release, the Trusted Publisher was configured in the npm package settings and the token mode was **retired** (secret deleted, workflow env removed, 2026-08-14). Publishing is now **zero-secrets**: npm exchanges the GitHub OIDC id-token (from `setup-node`'s `registry-url` + the workflow's `id-token: write`) for registry authentication against the npm-side Trusted Publisher entry, and `--provenance` signs the build source.

> The workflow declares **no token env at all** (`NODE_AUTH_TOKEN` / `NPM_TOKEN`); if the npm-side Trusted Publisher entry is ever removed, publishing fails loudly (ENEEDAUTH) instead of silently falling back to a token.

### Configure the Trusted Publisher in the npm package settings (user action, tokenless)

The package only gets a Settings page on npm after the first release succeeds:

1. Sign in to [npmjs.com](https://www.npmjs.com) → **Packages** → `dsh-llm-fallbacks` → **Settings** → **Trusted publishing**.
2. **Select your publisher** → choose **GitHub Actions**.
3. Fill in the fields:
   - **Organization or user** (required): `omdsh-dev` (GitHub org/user);
   - **Repository** (required): `dsh-llm-fallbacks`;
   - **Workflow filename** (required): `release.yml` — **the filename only**, no path, and it must include the `.yml`/`.yaml` extension; the workflow must exist under the repository's `.github/workflows/`;
   - **Environment name** (optional): fill in only if the publish job uses GitHub environment protection;
   - **Allowed actions** (required): check **`npm publish`** (this repository publishes directly with `npm publish --provenance`, no staged publish).
4. Save. This configuration **creates no token** — npm accepts OIDC publishing from that workflow (tokenless by design).

> A package can only have one trusted publisher configuration at a time; it can be edited/deleted at any time (deleting returns to token authentication).

### Notes

- npm **provenance** requires the package to be public (the publish command in the workflow already uses `--access public`).
- **No extra configuration on the GitHub side**: the OIDC token (`permissions: id-token: write`) is issued by Actions automatically; `contents: write` / `pull-requests: write` are already declared in the workflow.
- **No token secrets exist** (the bootstrap `NODE_AUTH_TOKEN` was deleted 2026-08-14); publishing fails loudly if the npm-side Trusted Publisher entry is missing.
- The first release used **explicit** `0.1.0-alpha.2` (see the SOP below); `--patch` auto is left for later releases.

## Release SOP

### 1. Write a changelog fragment

For every **user-visible change**, add a fragment under `.changes/unreleased/` (format in the next section; **one file, one category**, English bullets — non-bullet lines such as `<!-- CN -->` are rendered into the CHANGELOG verbatim).

**At least one fragment is mandatory**: `release.yml` fails outright when the changelog extraction is empty (an empty version section cannot be published). Before the first release in particular, verify that `.changes/unreleased/` is non-empty (this repository's first-release fragments were committed together with the features).

### 2. Trigger Release prep

Repository → **Actions** → **Release prep** in the sidebar → **Run workflow**:

- **Version input**:
  - **First release**: fill in `0.1.0-alpha.2` explicitly (validate the pipeline first; the stable version is left for the next iteration).
  - **Later**: leave blank = auto bump (`--patch`) — when the current version is a prerelease with a numeric tail (`X.Y.Z-pre.N`), only N is incremented (`0.1.0-alpha.1` → `0.1.0-alpha.2`, **staying on the prerelease line**); without a prerelease, patch+1 (`0.1.0` → `0.1.1`); a non-numeric prerelease tail errors out — use an explicit version instead.

The workflow then runs, in order:

1. **Rejects already-released versions**: with an explicit version and an existing git tag `v<v>` → errors and exits (a released version cannot re-run prep).
2. `pnpm release:prepare`: bumps the `package.json` version, assembles the `.changes/unreleased/` fragments into a `## [<version>] - <date>` section inserted into `CHANGELOG.md` (below `## [Unreleased]`), and archives the fragments to `.changes/archive/<version>/`.
   - **The date is UTC**: the script uses `new Date().toISOString().slice(0, 10)`, so the section date is fixed to the UTC day; a local prep late at night in a positive timezone may display "yesterday" — UTC is authoritative.
3. `pnpm release:validate -- v<v>`: package.json version matches the tag + the tag does not already exist (belt and suspenders).
4. `pnpm build` smoke test.
5. Commits `chore(release): prepare v<v>` to the `release/v<v>` branch and pushes (force-with-lease).
6. Opens the PR `release v<v>` (base `main`, label `release`); **updates it if an open PR already exists**, otherwise **creates a new PR** (including when a closed PR exists for the same head branch — closed release PRs are never reopened).

### 3. Review the release PR

Before merging, verify:

- [ ] `package.json` `version` is the expected version;
- [ ] `CHANGELOG.md` has a `## [<version>] - <date>` section under `## [Unreleased]` with correct, English fragment bullets;
- [ ] the `.changes/unreleased/` fragments are archived to `.changes/archive/<version>/`;
- [ ] the diff contains only version / changelog / archive changes (plus any direct commits on the branch; with none it should be those three blocks).

### 4. Merge → automatic publish

After the merge, `release.yml` triggers (`pull_request: closed` + `merged == true` + title with the `release v` prefix):

1. Checks out the merge commit → `release:validate` → `pnpm build`;
2. `npm publish --provenance --access public --tag <dist-tag>` — **the dist-tag is derived from the version**: stable `X.Y.Z` publishes under `latest`; prerelease `X.Y.Z-<channel>.N` publishes under `<channel>` (e.g. `0.4.0-alpha.1` → `alpha`, `1.0.0-rc.1` → `rc`), so a prerelease never steals `latest` from the newest stable (an explicit `--tag` is also required by npm ≥ 11, bundled with Node 24, when publishing a prerelease). The `next` tag is not used. npm authentication is pure OIDC (Trusted Publishing configured on the npm side; see the "npm authentication" section);
3. Tags `v<v>` and pushes (skipped if it exists);
4. Creates the GitHub Release from the changelog section — **always a regular release** (no Pre-release marker, user decision 2026-08-14); the channel signal is the version-derived npm dist-tag (`latest` for stable, the prerelease channel such as `alpha` for prereleases), the GitHub Release is the visible record.

## Changelog fragment format

Each file under `.changes/unreleased/` is one fragment (`.changes/unreleased/README.md` is the explainer file and `.gitkeep` is a placeholder — both are ignored):

- **Filename**: any slug ending in `.md` (e.g. `add-foo.md`).
- **Frontmatter (optional)**: the `category:` key groups the fragment's bullets under a `### <category>` subheading in the changelog (default `Changed`).
- **Body**: one or more English bullet lines (`- ` prefix), rendered verbatim.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

Each fragment focuses on one user-visible change.

## Release checklist

- [ ] `pnpm test` all green (460 test baseline across 23 files, vitest run)
- [ ] `pnpm build` all green (tsc + tsdown + build-client + verify-dist)
- [ ] `actionlint .github/workflows/*.yml` clean (ci + release-prep + release)
- [ ] `pnpm release:validate -- v<version>` passes (local preview before releasing)
- [ ] version matches the CHANGELOG section; fragments archived
- [ ] npm authentication ready: Trusted Publisher bound to `release.yml` in the npm package settings; no token secrets exist (see the "npm authentication" section)

## Rollback / re-run

- **PR stage (not merged)**: wrong version or content → simply **close the PR**, or **re-run Release prep**. Re-running is idempotent: re-running with the same version regenerates the `release/v<v>` branch (force-with-lease push) and handles the PR — **updates it if an open PR exists**; **creates a new PR if none is open** (a previously closed release PR stays closed and is never reopened).
- **Failed mid-publish after merge**: if `npm publish` succeeded but the tag / GitHub Release steps failed — **do not re-run the Release workflow directly**: `npm publish` would fail because the version already exists on the registry. Fixes:
  - manually add the tag and Release: `git tag -a -m "release v<v>" v<v> && git push origin v<v>`, then create the GitHub Release manually from the changelog section; or
  - fix-forward: go straight to the next version (see below).
- **Published but wrong content**: npm **does not allow re-publishing the same version**; `npm unpublish` is only possible within 72 hours of publishing and without dependents (policy-limited). **fix-forward is recommended**: fix the content, bump to the next version (on the prerelease line, e.g. `0.1.0-alpha.3`), and re-run the SOP. The GitHub Release can be edited/deleted at any time; the tag can be deleted once you confirm no one depends on it (`git push origin :refs/tags/v<v>`).
- **Semantics**: the two-step model (prep PR + merge) is itself the rollback gate — if something is wrong, just don't merge and nothing happens.

## Related files

| File | Purpose |
|---|---|
| `.github/workflows/release-prep.yml` | manual entry: bump + changelog + open/update the release PR |
| `.github/workflows/release.yml` | automatic publish + tag + GitHub Release after merge |
| `scripts/prepare-release.ts` | version resolution (explicit / `--patch` auto), fragment assembly, bump, archive |
| `scripts/validate-release-version.ts` | version consistency + tag-not-exists validation |
| `CHANGELOG.md` | English changelog (`## [Unreleased]` + version sections) |
| `.changes/unreleased/` | pending fragments |
| `.changes/archive/<version>/` | consumed fragment archive |