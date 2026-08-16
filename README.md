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

Save and restart the session, then type `/fallbacks` — the read-only in-session diagnostics (origin, resolved role, chain, recent `fallbacks/switch` events, cooldown status). Sessions containing `fallbacks/switch` events load after a restart because the plugin registers the event type at startup (rc.6 runtime registration; an upstream registration surface is pending) — without the plugin installed, such sessions refuse to load again until the upstream surface lands (see the Features note below). In a dsh-tui profile, `/fallbacks config` additionally reads back the composed configuration (the TUI has no settings page — config is file-only; see [docs/configuration.md](docs/configuration.md)).

## Features

- **Automatic fallback for root and subagents**: any agent switches down the chain to the next available provider/model on model failure — no manual model switching.
- **Two-block config**: `rootChain` for the root agent; declared role entities (`roles.list`) referenced by `roles.rules` (or the built-in `inherit`).
- **Cooldown and revert**: failed / switched-away models are not re-selected during cooldown; `revertPolicy: cooldown-expiry` returns to the primary model automatically.
- **Visible behavior**: every switch appends a persisted `fallbacks/switch` session event (from/to/role/reason) with info-level logs — no silent model switching. The event type is registered with the harness at plugin startup (rc.6 runtime registration; an upstream registration surface is pending), so persisted events stay loadable across restarts while the plugin is installed.
- **Safety valves**: `maxSwitchesPerStep` caps switches per step and `alwaysModeRetryCap` caps always-mode retries — chain loops cannot amplify latency.
- **No-config no-op**: `enabled` defaults to off; with no chains configured the plugin behaves exactly like not being installed.

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
