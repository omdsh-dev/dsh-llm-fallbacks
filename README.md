# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-llm-fallbacks?lang=en)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-llm-fallbacks?ref=badge)

Automatic provider/model fallback chains for dsh (DeepSeek Harness): when an agent's LLM requests keep failing — retries exhausted, auth errors, quota exceeded, rate limiting (429) — the plugin switches provider/model along the fallback chain for the current role, and the current step/turn continues on the target model: tasks are not interrupted by model problems.

Install with a single command (see [Install](#install)):

```sh
dsh plugin --profile web add dsh-llm-fallbacks   # pin a version with @<version>
```

## Features

- **Automatic fallback for root and subagents**: any agent switches down the chain to the next available provider/model on model failure — no manual model switching.
- **Two-block config**: block 1 `rootChain` — the root agent's single fallback chain (empty = root does not fall back); block 2 declared roles — `roles.list` role entities (id/persona/chain/fallback) that `roles.rules` reference by id (or the built-in `inherit`); no rule match → `inherit` → `rootChain`.
- **Entry syntax**: chain entries are `provider/model` (exact switch) or `provider/*` (keep the failed model id, switch provider only) — the old chain-key namespace (provider/model keys, role-name keys) is gone.
- **Cooldown and revert**: models that were switched away from / failed are not re-selected during the cooldown period; `revertPolicy: cooldown-expiry` automatically returns to the primary model when the cooldown expires, while `never` does not return within the session.
- **Visible behavior**: every switch appends a persisted session event `fallbacks/switch` (from/to/role/reason), alongside info-level logs (candidate attempt order and skip reasons) and the read-only status block on the Settings → 插件配置 → Fallbacks card — no silent model switching.
- **Safety valves**: switching stops and the original error semantics are kept once `maxSwitchesPerStep` is exceeded for a step, preventing chain loops from amplifying latency; `mode: 'always'` providers additionally have a retry cap (`alwaysModeRetryCap`).
- **No-config no-op**: `enabled` defaults to off (`false`); with no `rootChain`/role chains, unmatched trigger codes, or unresolved roles the plugin is a complete no-op — identical to not being installed, and no events are emitted.

## Install

### One-line install

```sh
dsh plugin --profile web add dsh-llm-fallbacks   # pin a version with @<version>
```

A registry install fetches the **built package** (`dist/`) — nothing is built on the target machine. The plugin is **mount-only**: it never modifies the dsh source tree, and no patch / postinstall step exists — dsh upgrades never require re-patching. Versioning follows npm dist-tags (`latest` by default); pin an exact version with `dsh plugin --profile web add dsh-llm-fallbacks@<version>`.

> **Release status**: published as `dsh-llm-fallbacks@0.1.3` (latest). The first publish used a one-time `NODE_AUTH_TOKEN` bootstrap secret; Trusted Publishing is configured afterwards for tokenless releases.

### Registry package (npm / pnpm)

```sh
npm install dsh-llm-fallbacks   # or: pnpm add dsh-llm-fallbacks
```

> Release process → [docs/release.md](docs/release.md).

### Git install (works today)

```sh
dsh plugin --profile web add github:omdsh-dev/dsh-llm-fallbacks   # pin a commit with #<sha>
```

A git install fetches **sources, not built artifacts** — the bundle builds itself on install (`prepare` self-build), so the target machine needs node + pnpm. pnpm ≥ 10 blocks a git dependency's `prepare` by default (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`); allow the build in the profile's `pnpm-workspace.yaml` and re-run the `add` (details in [docs/install.md](docs/install.md)).

### Local directory install (recommended for development / verification)

```sh
# 1) Build in the plugin repo (the prepare self-build runs the pnpm toolchain: tsdown + tsc, no bun)
pnpm install
# 2) Add to the target profile (example: web)
dsh plugin --profile web add .
```

> **Development prerequisite**: type-checking and tests resolve the real
> `@deepseek-ai/*` packages (peer deps, host-provided at runtime) from the npm
> registry at `0.1.0-rc.6` — `autoInstallPeers` + the registry auth token in
> the user-level `~/.npmrc` (pnpm 11 no longer expands `${NPM_TOKEN}` from a
> project `.npmrc`), no local link farm.

> Both methods, uninstall, and `--dump-config` verification — including the bundle-layer ordering requirements — are covered in [docs/install.md](docs/install.md).

### dsh-tui profile (terminal TUI)

The plugin also runs in a terminal (`dsh-tui`) profile — install it the same way, pointing `--profile` at `dsh-tui`:

```sh
dsh plugin --profile dsh-tui add dsh-llm-fallbacks   # registry; pin a version with @<version>
# or, from this repository (build first — see "Local directory install" above):
dsh plugin --profile dsh-tui add .
```

- **Commands**: `/fallbacks` (session diagnostics) and `/fallbacks config` (composed-config readback) appear in the TUI `/` menu with `config` subcommand completion — this needs the profile's `tuiCommandTrees` service (the `dsh-tui-command-trees` bundle row; the shipped dsh-tui bundle has it).
- **Configuration is file-only**: the TUI has no settings page and no write surface — edit the shared `$DSH_HOME/settings.yaml` (`fallbacks:` section — the same file the web Settings card writes) for global settings, or the profile patch layer `~/.dsh/profiles/dsh-tui/cordis.patch.yml` (plugin-row `config:` overrides) for dsh-tui-specific values; read the composed result back with `/fallbacks config`. `enabled` still defaults to off (`false`).
- **Limitation**: the web Settings → 插件配置 → Fallbacks card is web-only — in the TUI there is no card and no settings page; config changes are file edits, with `/fallbacks config` as the readback.

## Quick start

### Minimal configuration

Add a `fallbacks:` section to the dsh settings document (default `$DSH_HOME/settings.yaml`):

```yaml
fallbacks:
  enabled: true            # feature switch; defaults to false — set explicitly to enable
  rootChain:               # block 1: root agent's chain; tried in order after the primary model fails
    - anthropic/claude-3-5-sonnet
    - openai/*
  roles:                   # block 2: declare roles first, then let rules reference them
    list:
      - id: reviewer       # role entity: unique id (/^[a-z0-9-]{1,32}$/); "inherit" is reserved
        persona: Code-review subagents
        chain:
          - openai/gpt-4o-mini
        fallback: inherit-root   # default: role chain, then append rootChain
    rules:
      - origin: subagent   # all subagents → reviewer role (own chain + inherited root)
        role: reviewer
```

Roles are declared entities: `roles.list` holds role cards (id/persona + chain/fallback), and `roles.rules` match origin/provider/model in order to a declared role id or the built-in `inherit` (first match wins) — **no rule match → `inherit` → `rootChain`**. A declared role is only ever hit when a rule references it. A role without a chain is meaningless — the settings card blocks saving it and the host warns at startup; give every declared role a chain, or point its rules at the built-in `inherit`. (A hand-written YAML role with a missing/empty chain is not fatal: with `fallback: inherit-root` (the default) an empty chain still falls back to `rootChain`; with `fallback: none` an empty chain leaves no candidates and the request passes through untouched — either way it is only a startup warn.) The legacy chain-key namespace and role-default field are gone (migration table: [docs/configuration.md](docs/configuration.md)).

Save and restart the web session for the changes to take effect. The feature switch `fallbacks.enabled` **defaults to off (`false`)** — the plugin only engages once it is turned on; `triggerCodes` defaults to `AUTH` / `QUOTA` / `RATE_LIMIT`; and with **no `rootChain`/role chains configured the behavior is identical to not having the plugin installed**. More examples (role entities, fallback strategies, rules referencing `inherit`) → [docs/configuration.md](docs/configuration.md).

> **Upgrade note (behavior change)**: an existing `fallbacks:` section **without an explicit `enabled` key** now resolves to `false` after upgrading — add `enabled: true` to keep the plugin active.

## `/fallbacks` command (in-session diagnostics)

Type `/fallbacks` in any session to inspect this session's fallback state — no need to open the settings page:

- **Session origin** (`root` / `subagent`) and the **resolved role** (the `role` of the first matching `roles.rules` entry, otherwise the built-in `inherit`);
- the **resolved chain** for that role (the role's own chain entries, annotated `（inherit-root）` when `rootChain` is appended — `rootChain` entries render in full only when the role has no own chain; `fallback: none` with an empty own chain, or no chain at all, → `not configured`);
- the **recent switches** (`fallbacks/switch` events, newest first, up to 5): from/to provider/model, role, reason;
- the **cooldown status**: which `provider/model` keys are currently suppressed and until when.

The command is **read-only** — it never mutates fallback state (no cooldown reset, no pending-switch writes). It registers through a conditional `commands` child, so it appears only when the host composes the slash-command registry — with no registry the command is silently unavailable (no top-level inject pollution). Output is zh by default (the host carries no per-session locale signal); the en dictionary lives in the same copy table.

## Mount-only (no dsh modification)

The plugin installs as a **pure mount** — it never modifies the dsh source tree:

- **Install = bundle insert + client inject + own gateway**: `bundle/cordis.patch.yml`
  inserts the plugin row over the profile bundle stack, `dsh.client.inject` mounts
  the Fallbacks card on the Settings → 插件配置 page, and settings read/write/reset
  go through the plugin's own gateway channel (`/api/fallbacks/get|set|reset`).
- **No patches, no auto-apply step**: there are no dsh-body patch files and no install
  lifecycle step that applies one. A one-line registry install works as-is.
- **dsh upgrades never require re-patching**: a dsh upgrade that resets the source
  tree changes nothing for this plugin — it keeps working without any re-apply step.
- **Stale leftover patches are harmless**: the plugin never depends on a patch
  export (role resolution is rules-only; the model-selection marker coordination
  was removed), so a previously patched dsh tree can be left as-is or manually
  reverted — neither is required.

## Developer consumption

Beyond the dsh plugin mount, `dsh-llm-fallbacks` exposes a programmable consumer surface — both faces share the same function implementations (single point of truth, no copied logic):

- **Library API**: import the runtime functions and types from the package root — `import { resolveRole, resolveChain, validateFallbacksConfig } from 'dsh-llm-fallbacks'`.
- **Named cordis service**: while the plugin is applied, `ctx.get('llm-fallbacks')` returns a pure-function service (`{ name, version, resolveRole, resolveChain, validateFallbacksConfig, detectLegacyKeys, declareSeeds, getEffectiveRoles, revertSeededPersona }`); after the plugin is disposed it is `undefined`. Runtime state stays observable via `fallbacks/switch` events, not through the service.
- **Role seeds**: companion plugins auto-provision role rows with zero operator hand-edit — `declareSeeds([{ id, persona }])` declares the full current seed set (re-declaring is a no-op; ids failing `/^[a-z0-9-]{1,32}$/` or equal to `inherit` are skipped per-id with a warn, never coerced), `getEffectiveRoles()` reads back which roles are seeded and whether the persona is overridden, and `revertSeededPersona(id)` restores the **currently declared** seed default. The settings card shows a seed-default / override badge with a revert button, and renders a seeded role's id as a disabled (immutable) field — the id of any seed/preset role cannot be changed from the card (R2); persona, chain and fallback stay editable. Seeds never write `chain` / `fallback`.

Full contract (export inventory, minimal examples, lifecycle, typing) → [docs/consumer-api.md](docs/consumer-api.md).

## Preset roles

The plugin ships a **bundled taxonomy of 7 generic subagent roles** available out of the box — `designer` / `librarian` / `reviewer` / `scout` / `security-reviewer` / `sonic` / `task` — declared automatically on `apply` as seeded `roles.list` rows (`{ id, persona }`, two keys only): idempotent, and never overwriting an operator persona. Each persona is a concise instruction set distilled from the omp bundled agent prompts (`packages/coding-agent/src/prompts/agents/`, snapshot 2026-08-16).

- **Config switch**: `fallbacks.presets` — `'bundled'` (default) declares the preset roles on apply; `'none'` disables the automatic declaration (zero declarations, zero writes from this switch; already-materialized rows stay). Full semantics (upgrade behavior, conflict handling, honest deletion limitation) → [docs/configuration.md](docs/configuration.md).
- **Library reuse**: the same 7 declarations are exported from the package root — one line, the identical payload the plugin self-declares:

```ts
import { presetRoles } from 'dsh-llm-fallbacks'

const fb = ctx.get('llm-fallbacks')                       // plugin applied → service face
if (fb !== undefined) await fb.declareSeeds(presetRoles)  // or a FallbacksSeedManager
```

## Documentation

| Doc | Content |
|---|---|
| [docs/install.md](docs/install.md) | profile install (web + dsh-tui) / registry install / uninstall / `--dump-config` verification |
| [docs/release.md](docs/release.md) | release process: Trusted Publishing setup, Release prep SOP, fragment format, rollback |
| [docs/configuration.md](docs/configuration.md) | full `fallbacks` namespace reference, selector syntax, example YAML, plugin-config card usage, TUI readback pointer, behavior notes |
| [docs/consumer-api.md](docs/consumer-api.md) | developer consumption contract: export inventory, minimal examples, lifecycle, typing |
| [docs/verification.md](docs/verification.md) | verification records (test matrix, bundle layer order, runtime contracts, QA gate script) |

## License

Released under the **MIT** License — see [LICENSE](LICENSE). The LICENSE file is authoritative for copyright and license terms.
