# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh web](https://img.shields.io/badge/dsh%20web-compatible-4B32C3.svg)
![dsh tui](https://img.shields.io/badge/dsh%20tui-compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-llm-fallbacks?lang=en)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-llm-fallbacks?ref=badge)

Automatic provider/model fallback chains for dsh (DeepSeek Harness): when an agent's LLM requests keep failing — retries exhausted, auth errors, quota exceeded, rate limiting (429) — the plugin switches provider/model along the fallback chain for the current role, and the current step/turn continues on the target model: tasks are not interrupted by model problems.

Works in both dsh front ends: the **web** profile (Settings → 插件配置 → Fallbacks card) and the **dsh-tui** terminal profile (`/fallbacks` + `/fallbacks config`).

## Quick start

### Install

```sh
dsh plugin --profile web add dsh-llm-fallbacks      # web profile (Settings → Fallbacks card)
dsh plugin --profile dsh-tui add dsh-llm-fallbacks  # dsh-tui terminal profile
```

Same plugin, either front end — the only difference is the `--profile` flag. Pin a version with `@<version>`. A registry install fetches the **built package** (`dist/`), nothing builds on the target machine. Registry / git / local-directory variants, uninstall, and `--dump-config` verification → [docs/install.md](docs/install.md).

### Repair existing sessions (versions before 0.2.2)

Versions before 0.2.2 wrote durable `fallbacks/switch` session events that newer dsh releases refuse to load (issue #52 — the apply()-time event-type registration is ineffective because plugin and host resolve different module instances). If existing sessions fail to open after an upgrade, clone this repository and repair the logs (stop dsh first):

```sh
git clone https://github.com/omdsh-dev/dsh-llm-fallbacks.git
cd dsh-llm-fallbacks
pnpm install
pnpm repair:fallbacks-switch-logs -- --dry-run            # preview which sessions would change
pnpm repair:fallbacks-switch-logs -- --apply --backup     # mark legacy events ignorable
```

The script scans `~/.dsh/sessions` by default (override with `--root <dir>`), marks legacy `fallbacks/switch` events `ignorable: true` so the host read path accepts the session again, and keeps a `<file>.bak` per repaired log. `--apply` requires `--backup` and must run with dsh stopped. From 0.2.2 on, the plugin stops writing durable switch events, so no new sessions need repair.

### Minimal configuration

Add a `fallbacks:` section to the dsh settings document (default `$DSH_HOME/settings.yaml`):

```yaml
fallbacks:
  enabled: true            # feature switch; defaults to false — set explicitly to enable
  rootChain:               # block 1: root agent's chain, tried in order after the primary model fails
    - anthropic/claude-3-5-sonnet
    - openai/*
  roles:                   # block 2: declare role entities first, then let rules reference them
    list:
      - id: reviewer       # unique id (/^[a-z0-9-]{1,32}$/); "inherit" is reserved
        persona: Code-review subagents
        chain:
          - openai/gpt-4o-mini
        fallback: inherit-root   # default: role chain, then append rootChain
    rules:
      - origin: subagent   # all subagents → reviewer role (own chain + inherited root)
        role: reviewer
```

No rule match → the built-in `inherit` → `rootChain`. `enabled` defaults to **off** — with no chains configured the plugin is a complete no-op. Full reference (role entities, fallback strategies, rules, selectors, preset roles) → [docs/configuration.md](docs/configuration.md).

> **Upgrade note (behavior change)**: an existing `fallbacks:` section **without an explicit `enabled` key** resolves to `false` after upgrading — add `enabled: true` to keep the plugin active.

### Verify

Save and restart the session, then type `/fallbacks` — the read-only in-session diagnostics (origin, resolved role, chain, recent `fallbacks/switch` events, cooldown status). The plugin no longer writes durable `fallbacks/switch` session events (issue #52 — the apply()-time registration was proven ineffective), so new switches show up in the info logs, not in the recent-switch surfaces; sessions written by older plugin versions that contain `fallbacks/switch` events are repaired with `scripts/repair-fallbacks-switch-logs.ts`, which marks legacy events ignorable so those sessions load again (see the Features note below). In a dsh-tui profile, `/fallbacks config` additionally reads back the composed configuration (the TUI has no settings page — config is file-only; see [docs/configuration.md](docs/configuration.md)).

## Features

- **Automatic fallback for root and subagents**: any agent switches down the chain to the next available provider/model on model failure — no manual model switching.
- **Two-block config**: `rootChain` for the root agent; declared role entities (`roles.list`) referenced by `roles.rules` (or the built-in `inherit`).
- **Chain as root primary from the picker**: when `enabled` is on and the all-day `rootChain` is conforming, the host model picker (web and TUI alike) shows a virtual `FallbacksChain` row — selecting it uses the configured chain as the root primary; selecting a real model keeps fallback-only (see [FallbacksChain in the model picker](#fallbackschain-in-the-model-picker)).
- **Dispatch-time role resolution**: on a subagent's first request its role is resolved in three stages — explicit (`agentPreset` matches a declared role id) → deterministic rules (unchanged) → LLM auto-match from the declared role taxonomy (`fallbacks.roleAutoMatch`, default `true`). The resolved role's chain-head model is injected into the first request and recorded via an explicit `role → model` log line (no durable `fallbacks/switch` event is written — issue #52 stop-write); set `roleAutoMatch: false` to disable the LLM auto-match stage (the explicit `agentPreset` stage still applies — with no explicit role this reproduces the previous rules-only behavior). The settings card always renders an **Enable role auto-match** switch (default `true`) to toggle it — the schema default applies even to legacy configs that never declared the key.
- **Cooldown and revert**: failed / switched-away models are not re-selected during cooldown; `revertPolicy: cooldown-expiry` returns to the primary model automatically.
- **Visible behavior**: every switch is recorded in an info-level log line (from/to/role/reason) — no silent model switching. The plugin deliberately writes **no** durable `fallbacks/switch` session events (issue #52: the apply()-time event-type registration was proven ineffective, and a session containing the event refused to load after a dsh restart). Sessions written by older plugin versions that contain such events are repaired by `scripts/repair-fallbacks-switch-logs.ts`, which marks legacy events ignorable so affected sessions load again.
- **Safety valves**: `maxSwitchesPerStep` caps switches per step and `alwaysModeRetryCap` caps always-mode retries — chain loops cannot amplify latency.
- **No-config no-op**: `enabled` defaults to off; with no chains configured the plugin behaves exactly like not being installed.

## FallbacksChain in the model picker

When `enabled: true` and the all-day `rootChain` is **conforming** — exactly one official V4 model, `deepseek-official/deepseek-v4-flash` or `deepseek-official/deepseek-v4-pro` — the plugin registers a virtual provider, `fallbacks`, with a single catalog row: **FallbacksChain**. The web profile and dsh-tui both see the row: they share the same adapter catalog, so no TUI settings page or host patch is involved.

Selecting **FallbacksChain** uses the configured chain as the root **primary**: root requests route to the effective chain's first exact `provider/model` at request time, and the fallback engine degrades from that head as usual. Selecting any real catalog model keeps the v0.2.2 fallback-only behavior — the session model is primary and the chain engages only after it fails.

There is **no `rootMode` switch** — no config key, YAML field, settings toggle, or gateway flag. The mode is the session's `{provider, model}` selection itself: `FallbacksChain` = chain primary; any real model = fallback-only.

Notes:

- **Root only**: the row is about the root agent. Subagent role resolution and injection are unchanged; a subagent session that inherits the selection still routes through the chain head — the virtual row is a thin delegate, never a second routing engine.
- **Conformance gate**: a legacy multi-model `rootChain` earns no row; the all-day chain must be exactly one official V4 model. Disabling the plugin or losing conformance hides the row again (slot-row edits never churn it).
- **Stale selection**: if the row disappears (plugin disabled / all-day chain emptied or non-conforming) while `FallbacksChain` is selected, the session keeps showing it as the current model with `routable: false` — pick a real model from the catalog to continue (host-native catalog semantics).
- **Capabilities follow the head**: the row's model metadata (context window, modalities, reasoning) mirrors the current effective head; retry attribution follows the permissive default — retries/failures are accounted to the real head pair, not to `fallbacks`. Full semantics → [docs/configuration.md](docs/configuration.md).

## Preset roles

The plugin ships **7 bundled generic subagent roles** out of the box — `designer` / `librarian` / `reviewer` / `scout` / `security-reviewer` / `sonic` / `task` — declared automatically on `apply` as seeded `roles.list` rows (`{ id, persona }`): idempotent, and never overwriting an operator persona. They appear in the Settings card (seed badge, id immutable) and in the `/fallbacks config` role summary, ready for `roles.rules` to reference.

- **Switch**: `fallbacks.presets` — `'bundled'` (default) declares the preset roles on apply; `'none'` disables the automatic declaration (already-materialized rows stay).
- Full semantics (upgrade behavior, conflict handling, library reuse of `presetRoles`) → [docs/configuration.md](docs/configuration.md).

## Mount-only (no dsh modification)

The plugin installs as a **pure mount**: bundle insert + client inject + its own gateway channel (`/api/fallbacks/get|set|reset`) — no dsh patches, no postinstall step, and dsh upgrades never require re-patching. Stale leftover patches from an older patched install are harmless.

## Documentation

| Doc | Content |
|---|---|
| [docs/install.md](docs/install.md) | profile install (web + dsh-tui) / registry / git / local variants / uninstall / `--dump-config` verification |
| [docs/configuration.md](docs/configuration.md) | full `fallbacks` namespace reference, selector syntax, example YAML, plugin-config card usage, TUI readback, behavior notes, preset roles |
| [docs/consumer-api.md](docs/consumer-api.md) | developer consumption contract: library API + named `llm-fallbacks` service + role seeds, export inventory, lifecycle, typing |
| [docs/release.md](docs/release.md) | release process: Trusted Publishing setup, Release prep SOP, fragment format, rollback |
| [docs/verification.md](docs/verification.md) | verification records (test matrix, bundle layer order, runtime contracts, QA gate script) |

## License

Released under the **MIT** License — see [LICENSE](LICENSE). The LICENSE file is authoritative for copyright and license terms.
