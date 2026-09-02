# Installation Guide

This document explains how to load `dsh-llm-fallbacks` into a dsh profile, verify the installation, and uninstall it.

## Prerequisites

- A working dsh runtime environment (`$DSH_HOME`, defaults to `~/.dsh`); development-time type checking and tests need the `@deepseek-ai/*@0.1.2-alpha.5` peer dependencies resolved (see "Development-time `@deepseek-ai/*` peer resolution" below).
- Building requires **node** (`>= 22`) and **pnpm** (`>= 10`) — needed **only for local directory installs** (development): the plugin's `prepare` script self-builds (`pnpm run build`, tsdown + tsc, pnpm stack without bun); registry installs deliver built artifacts, so the target machine does not build anything.
- The target profile (e.g. `web`) is readable/writable, and a dsh session restart is required after installation.

## Development-time `@deepseek-ai/*` peer resolution

`@deepseek-ai/*` is a private package family: at runtime it is provided by the host dsh box as a bundle (`peerDependencies` contract; `@deepseek-ai/*` is externalized at tsdown build time). During development the real packages (`0.1.2-alpha.5`) resolve in one of two supported ways:

- **npm registry (current)**: 0.1.2-alpha.5 is on the npm registry — `autoInstallPeers: true` in `pnpm-workspace.yaml` + an auth token in the user-level `~/.npmrc` — `pnpm install` pulls in the peer dependencies automatically, so type checking, tests, and navigation all run against the real published code (no local link farm).
- **Local link (alternative)**: when the target dsh line is not yet on npm, development links the sibling dsh source checkout's `@deepseek-ai/*` packages into `node_modules` (type checking, tests, and navigation run against that linked tree; it is tsc-built into `lib/types/` only — its exports-mapped `lib/index.js` bundles do not exist — so the vitest config aliases the packages the test graph VALUE-imports, see the "Client store seam" bullet below).
- **Authentication (pnpm 11)**: applies to the npm-registry mode. As of pnpm 11, credentials in a project-level `.npmrc` **no longer expand environment variables** (`${NPM_TOKEN}` is invalid and warns). The token must live in the **user-level** `~/.npmrc`: `@deepseek-ai:registry=https://registry.npmjs.org/` + `//registry.npmjs.org/:_authToken=<token>` (or `pnpm config set "//registry.npmjs.org/:_authToken" <token>`); `NPM_TOKEN` remains the read-only token source for the restricted scope.
- **Version**: `peerDependencies` is pinned to `^0.1.2-alpha.5` (aligned with the dlx host's 0.1.2-alpha.5); bump the peer version in sync after a dsh upgrade.
- **pnpm version**: pnpm 11.21+ (this project's stack). Since 11.21 the minimum-release-age supply-chain gate is enabled by default; the `minimumReleaseAgeExclude` table in `pnpm-workspace.yaml` is a **pnpm-maintained** exemption table covering the published dsh package line (rc versions and cordis 4.0.2), with the `0.1.2-alpha.5` entries covering that line's first registry publish; **do not delete the block manually**: a resolved lockfile hard-fails without the exemptions (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`; re-resolve with `pnpm clean --lockfile`).
- **Client store seam**: the client half's one runtime VALUE import is `@deepseek-ai/dsh-client-store` (the snapshot-store engine — a frozen loader-table module in the 0.1.2 host, so the client bundle stays external on it); tests run the real linked implementation through a vitest alias (`vitest.config.ts`), because the linked 0.1.2 tree is tsc-built into `lib/types/` and its exports-mapped `lib/index.js` bundles do not exist yet.

## 1. Local directory install (recommended)

```sh
# 1) Build in the plugin repo directory (prepare self-build, produces dist/)
pnpm install        # or explicit: pnpm build
# 2) Load into the target profile
dsh plugin --profile web add .
```

`dsh plugin` forwards its arguments to the pnpm in the profile directory (`add`, `remove`, `why`, etc. all work) and appends `dsh-llm-fallbacks` to the profile's bundle layer list (`dsh.profile.bundles`). The plugin is **mount-only**: installation = bundle row insert + client inject (`dsh.client.inject`), **zero modification of the dsh source tree, no patch steps**; dsh upgrades never require re-patching.

### Bundle layer order (hard requirement)

A dsh profile is composed of ordered bundle layers: `@deepseek-ai/dsh-base` (contains the llm-retry plugin) → `@deepseek-ai/dsh-web-app` → `@mstar-harness/dsh` → `dsh-llm-fallbacks` (appended by `add`).

**`dsh-llm-fallbacks` must be ordered after llm-retry (inside the `@deepseek-ai/dsh-base` layer)**: the plugin's `agent/request-error` listener must compose after llm-retry so it only steps in after the retry budget is exhausted (normal mode) or after llm-retry has delegated downstream first (always mode); a reversed order would let retryable failures reach this plugin first and preempt llm-retry's backoff.

`add` appends to the end of the list by default, which satisfies this order — no manual change needed; if you edit the `dsh.profile.bundles` of `$DSH_HOME/profiles/web/package.json` by hand, keep `@deepseek-ai/dsh-base` before this plugin.

## 2. Registry install

```sh
dsh plugin --profile web add dsh-llm-fallbacks   # pin an exact version: add @<version>
```

Registry install notes:

- **Built artifacts, no self-build**: the registry package ships built artifacts (`dist/`) — the target machine needs **no node / pnpm** and there is no `prepare` self-build.
- **No pnpm ≥ 10 build approval**: the build interception (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) applies to git dependencies only; registry packages run no build scripts, so `onlyBuiltDependencies` / `approve-builds` are not needed.
- **Version**: follows the npm dist-tag (default `latest`); pinning an exact version `dsh-llm-fallbacks@<version>` prevents a later publish from silently changing the code that actually runs.
- **Mount-only, no patch steps**: a registry install is complete as-is — the plugin makes zero modifications to the dsh source tree (bundle row insert + client inject + its own gateway), no apply/revert scripts, and nothing to re-patch after a dsh upgrade.

> **Release channels**: stable releases publish under the `latest` dist-tag (the default for `npm i dsh-llm-fallbacks`); prereleases publish under their channel dist-tag — install a prerelease line via its channel, e.g. `npm i dsh-llm-fallbacks@alpha`. npm authentication is tokenless Trusted Publishing. Release process → [docs/release.md](docs/release.md).

## 3. npm / pnpm package install

```sh
npm install dsh-llm-fallbacks   # or: pnpm add dsh-llm-fallbacks
```

> The package ships built artifacts (`dist/`); the consumer surface (library function imports, named service) is documented in [docs/consumer-api.md](docs/consumer-api.md).

## 4. Git install (currently available)

```sh
dsh plugin --profile web add github:omdsh-dev/dsh-llm-fallbacks   # pin a commit: add #<sha>
# Equivalent full-URL form (or add #<branch|tag|commit> to pin a ref):
# dsh plugin --profile web add https://github.com/omdsh-dev/dsh-llm-fallbacks.git
```

Git install notes:

- **prepare self-build**: when installing a git dependency, pnpm runs the package's `prepare` script (`pnpm run build`) to self-build, so the installing machine needs node and pnpm; a failed build installs an unbuilt package.
- **pnpm ≥ 10 build approval (every first `add` hits it)**: pnpm ≥ 10 does not run a git dependency's build scripts (including `prepare`/`postinstall`) by default. The first `add` fails and prints `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` together with the exact package key (`dsh-llm-fallbacks`). Add that key to this profile's `pnpm-workspace.yaml`:

  ```yaml
  # $DSH_HOME/profiles/web/pnpm-workspace.yaml
  onlyBuiltDependencies:
    - dsh-llm-fallbacks
  ```

  Then re-run `add`; alternatively allow it interactively with `dsh plugin --profile web approve-builds`. The approval means that package's code is allowed to execute on your machine at install time — pinning a commit (`github:omdsh-dev/dsh-llm-fallbacks#<sha>`) is recommended to prevent a later push from silently changing the code that actually runs. Exact behavior follows the policy of the pnpm version you use.
- **Mount-only, no patch steps**: a git install executes `prepare` (build) and is done — the plugin makes zero modifications to the dsh source tree (bundle row insert + client inject + its own gateway), no apply/revert scripts, and nothing to re-patch after a dsh upgrade.

## 5. dsh-tui profile (terminal TUI)

A terminal (`dsh-tui`) profile loads the plugin with the same `add` mechanics — pass `--profile dsh-tui` instead of `--profile web`:

```sh
dsh plugin --profile dsh-tui add dsh-llm-fallbacks   # registry; pin an exact version: add @<version>
# or a source install (local directory, build first — see §1; git, see §4):
dsh plugin --profile dsh-tui add .
dsh plugin --profile dsh-tui add github:omdsh-dev/dsh-llm-fallbacks
```

If no dsh-tui profile exists yet, create it first: `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui` (the launcher also self-bootstraps the profile on first run if absent).

`add` reads the package's `dsh.bundle.patch` (`bundle/cordis.patch.yml`) and appends it as a composition layer over the dsh-tui profile's bundle stack — the `- insert: id: llm-fallbacks` row lands in the profile, with the same mount-only guarantees as every other profile (zero dsh source-tree modification, no patch steps, nothing to re-patch after a dsh upgrade).

**Restart the dsh-tui session after installing.** In the terminal:

- The `/` menu lists `/fallbacks` (session diagnostics) and `/fallbacks config` (composed-config readback) with subcommand completion, including the `config` → `revert-seed <role-id>` leaf — this needs the profile's `tuiCommandTrees` service (the `dsh-tui-command-trees` bundle row; the shipped dsh-tui bundle has it).
- **Editing**: the TUI's write surface is the **`/settings`** screen — with **dsh-tui ≥ v0.8.5** (commit `c51661f` or later; the settings seam shipped in v0.8.0, the groups shape in v0.8.5) `/settings` shows a **fallbacks** section with full parity to the web Settings → 插件配置 → Fallbacks card (see [docs/configuration.md](docs/configuration.md) § TUI readback). On an older dsh-tui the section is absent and file editing remains the only TUI surface. File editing still works everywhere: the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section, the same file the web card writes) for global settings, or the profile patch `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (an `- id: llm-fallbacks` row with `config:` overrides) for dsh-tui-specific values. Note: a patch row **replaces** the targeted row's whole `config` — restate every field you want to keep (schema defaults fill the rest).
- Read the composed result back with `/fallbacks config` (config namespace + TUI readback → [docs/configuration.md](docs/configuration.md)); verify the layer with `dsh --profile dsh-tui --dump-config` (the `llm-fallbacks` row appears over the profile bundle stack).

## 6. Verify the installation

```sh
dsh --profile web --dump-config
```

The plugin's own layer should appear at the end of the merged configuration tree:

```yaml
# == dsh-llm-fallbacks
- id: llm-fallbacks
  name: dsh-llm-fallbacks
  config: {}
```

And the layer **before** it includes llm-retry (from `@deepseek-ai/dsh-base`) — the layer order is the waterfall registration order (see the bundle layer order above).

Then **restart the dsh web session** (`dsh web`, or restart the running session) so that both the host half and the client half (the plugin config card) load:

- The web settings GUI's Settings → **插件配置** page should show the **Fallbacks card**, **always available** — the card skeleton also renders on first open (before any `fallbacks` config exists).
- The card is readable, editable, and saveable; the feature switch `enabled` **defaults to OFF** (hiding the config form body while off) — turning the switch on reveals the full config form; with no chains configured the behavior is a no-op (see [docs/configuration.md](docs/configuration.md)).
- In-session, type `/fallbacks` directly to inspect the current session's diagnostics (role → chain → recent switches → cooldown); see the README's `/fallbacks` section.

## 7. Uninstall

```sh
dsh plugin --profile web remove dsh-llm-fallbacks
dsh --profile web --dump-config   # confirm the llm-fallbacks layer is gone
```

Restart the dsh web session for the uninstall to take effect. After uninstalling, the plugin no longer participates in any request/error path. Note: the plugin writes no durable `fallbacks/switch` session events (issue #52 — the apply()-time registration was proven ineffective), so new sessions are never affected. Sessions written by older plugin versions that contain such events are repaired with `scripts/repair-fallbacks-switch-logs.ts` (from the plugin repo; marks legacy events ignorable so affected sessions load again — see the README Features note).
