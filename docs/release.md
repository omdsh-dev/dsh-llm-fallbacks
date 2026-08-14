# Release Guide

This document describes the `dsh-llm-fallbacks` release process: npm authentication (first-release bootstrap token → Trusted Publishing afterwards), the release SOP (trigger → review → merge), changelog fragment format, the release checklist, and rollback / re-run instructions.

## Release model (PR-driven)

Releases are **two-step**, not a one-click black box:

1. **Release prep** (manual trigger) → generates a reviewable `release vX.Y.Z` PR (version bump + English changelog + fragment archive).
2. **Merging that PR is what publishes** → the `Release` workflow automatically publishes + tags + creates the GitHub Release.

The repository **does not declare `NPM_TOKEN`**: routine publishing authenticates to npm via Trusted Publishing (OIDC `id-token` + `npm publish --provenance`, tokenless); **the first release is the exception** — npm TP can only be configured for an existing package, so the first version is published with a one-time `NODE_AUTH_TOKEN` secret (see the "npm authentication" section). On the GitHub side only the built-in `GITHUB_TOKEN` is used. **There is no `push:tags` auto-publish path** — a manual `git tag && git push --tags` does not publish; the only publishing entry point is merging a `release vX.Y.Z` PR.

Related workflows:

| Workflow | File | Trigger |
|---|---|---|
| CI | `.github/workflows/ci.yml` | PR / push to main / manual |
| Release prep | `.github/workflows/release-prep.yml` | manual (Actions → Release prep → Run workflow) |
| Release | `.github/workflows/release.yml` | merging a PR titled `release v*` |

## npm authentication: first-release bootstrap token → Trusted Publishing (user action)

npm Trusted Publishing (OIDC) can only be configured for an **existing package** — there is no pre-registration path, and since `dsh-llm-fallbacks` is not published yet, the first release cannot use TP (it would hit ENEEDAUTH/404). Authentication is therefore split into two phases:

- **First release (bootstrap)**: a one-time Granular Access Token is stored in the `NODE_AUTH_TOKEN` secret to publish `0.1.0-alpha.2`.
- **Subsequent releases**: once the first release has succeeded, configure a Trusted Publisher bound to `release.yml` in the npm package settings; afterwards publishing is **zero-secrets** (OIDC auto-authentication; the token can be deleted).

> **The bootstrap token is a one-time mechanism, not a long-term solution**: once TP is configured, delete the `NODE_AUTH_TOKEN` secret from GitHub (npm also recommends restricting traditional tokens' publish permission after configuring TP).
>
> Both steps can only be performed by the npm account owner (maintainer) on the npm website — they cannot be automated from the repository, and repository code cannot do them on your behalf.

### First release: one-time Granular Access Token (user action)

1. Sign in to [npmjs.com](https://www.npmjs.com) → avatar (top right) → **Access Tokens** → **Generate New Token** → choose **Granular Access Token** as the type.
2. Fill in a name (e.g. `dsh-llm-fallbacks-bootstrap`); select `dsh-llm-fallbacks` as the Package; select **Read and write** as the permission.
   - If the package is not yet published and `dsh-llm-fallbacks` is not yet in npm's package picker list: use an **org-level publish scope** instead (select that package / all packages under e.g. `omdsh-dev`), or take the "manual token path" — create a **Granular Access Token** **without restricting the package** (or select Any package) and rely on that token's publish permission at publish time.
3. Copy the token and create a repository secret in GitHub at **Settings → Secrets and variables → Actions** named **`NODE_AUTH_TOKEN`**, pasting the token as its value.
4. The publish step of `release.yml` reads it automatically via `env: NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }}` (`setup-node`'s `registry-url` writes the value into `.npmrc`, which npm uses automatically); when the secret is absent the env is empty → the OIDC/provenance path is used.

### Subsequent releases: configure a Trusted Publisher in the npm package settings (user action, tokenless)

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
- Delete the `NODE_AUTH_TOKEN` secret once TP is ready: the npm CLI prefers OIDC in an OIDC environment; the token is only the fallback path during the bootstrap period.
- The first release uses **explicit** `0.1.0-alpha.2` (see the SOP below); `--patch` auto is left for later releases.

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
6. Opens the PR `release v<v>` (base `main`, label `release`); **updates it if an open PR already exists**, **reopens then updates a closed PR if one exists**, and only creates a new PR when neither exists.

### 3. Review the release PR

Before merging, verify:

- [ ] `package.json` `version` is the expected version;
- [ ] `CHANGELOG.md` has a `## [<version>] - <date>` section under `## [Unreleased]` with correct, English fragment bullets;
- [ ] the `.changes/unreleased/` fragments are archived to `.changes/archive/<version>/`;
- [ ] the diff contains only version / changelog / archive changes (plus any direct commits on the branch; with none it should be those three blocks).

### 4. Merge → automatic publish

After the merge, `release.yml` triggers (`pull_request: closed` + `merged == true` + title with the `release v` prefix):

1. Checks out the merge commit → `release:validate` → `pnpm build`;
2. `npm publish --provenance --access public --tag latest` — **explicit `--tag latest`**: npm ≥ 11 (bundled with Node 24) requires an explicit `--tag` when publishing a prerelease, otherwise it hard-throws; the first version (`0.1.0-alpha.2`) lands on the default `latest` dist-tag (`npm i dsh-llm-fallbacks` resolves), and the later stable `0.1.0` naturally takes over `latest`. npm authentication is selected automatically: TP configured → OIDC; bootstrap period → `NODE_AUTH_TOKEN` (see the "npm authentication" section);
3. Tags `v<v>` and pushes (skipped if it exists);
4. Creates the GitHub Release from the changelog section (`prerelease: true` when the version contains `-`).

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

- [ ] `pnpm test` all green (409 test baseline, vitest run)
- [ ] `pnpm build` all green (tsc + tsdown + build-client + verify-dist)
- [ ] `actionlint .github/workflows/*.yml` clean (ci + release-prep + release)
- [ ] `pnpm release:validate -- v<version>` passes (local preview before releasing)
- [ ] version matches the CHANGELOG section; fragments archived
- [ ] npm authentication ready: first release = `NODE_AUTH_TOKEN` secret configured; later releases = Trusted Publisher bound to `release.yml` (see the "npm authentication" section)

## Rollback / re-run

- **PR stage (not merged)**: wrong version or content → simply **close the PR**, or **re-run Release prep**. Re-running is idempotent: re-running with the same version regenerates the `release/v<v>` branch (force-with-lease push) and handles the PR — **updates it if an open PR exists**; **reopens the PR with `gh pr reopen` and updates the body if a closed PR exists**; creates a new one only when neither exists. **A closed PR is never edited in place** (that would silently stall the release).
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
