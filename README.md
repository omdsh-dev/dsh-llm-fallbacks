# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)

Automatic provider/model fallback chains for dsh (DeepSeek Harness): when an agent's LLM requests keep failing — retries exhausted, auth errors, quota exceeded, rate limiting (429) — the plugin switches provider/model along the fallback chain for the current role, and the current step/turn continues on the target model: tasks are not interrupted by model problems.

Install with a single command:

```sh
dsh plugin --profile web add https://github.com/dsh-external/dsh-llm-fallbacks.git
```

## Features

- **Automatic fallback for root and subagents**: any agent switches down the chain to the next available provider/model on model failure — no manual model switching.
- **Role-based chains**: subagents can use their own fallback chain, independent of the root agent — explicit `agent.options.role` (requires the dsh role patch) → `roles.rules` matching in order → `roles.default`; first match wins.
- **Chain specificity**: exact `provider/model` keys → `provider/*` keys → role chains → `default` chain; `provider/*` entries keep the failed model id and only switch provider.
- **Cooldown and revert**: models that were switched away from / failed are not re-selected during the cooldown period; `revertPolicy: cooldown-expiry` automatically returns to the primary model when the cooldown expires, while `never` does not return within the session.
- **Visible behavior**: every switch appends a persisted session event `fallbacks/switch` (from/to/role/reason), alongside info-level logs (candidate attempt order and skip reasons) and the read-only status block on the web settings page — no silent model switching.
- **Safety valves**: switching stops and the original error semantics are kept once `maxSwitchesPerStep` is exceeded for a step, preventing chain loops from amplifying latency; `mode: 'always'` providers additionally have a retry cap (`alwaysModeRetryCap`).
- **No-config no-op**: `enabled` defaults to off (`false`); with empty chains, unmatched trigger codes, or unresolved roles the plugin is a complete no-op — identical to not being installed, and no events are emitted.

## Install

### One-line URL install

```sh
dsh plugin --profile web add https://github.com/dsh-external/dsh-llm-fallbacks.git
```

### Local directory install (recommended for development / verification)

```sh
# 1) Build in the plugin repo (the prepare self-build runs the pnpm toolchain: tsdown + tsc, no bun)
pnpm install
# 2) Add to the target profile (example: web)
dsh plugin --profile web add .
```

> **Development prerequisite**: type-checking and tests resolve the real
> `@deepseek-ai/*` packages (peer deps, host-provided at runtime) from your dsh
> source tree — `$DSH_SOURCE_DIR`, default `${DSH_HOME}/source/current`
> (`scripts/setup-dsh-links.mjs` links them into `node_modules/` during
> `prepare`, including a bin-less shim for the in-box cordis). Run
> `pnpm dsh:link` to re-link after changing `$DSH_HOME`, and
> `pnpm dsh:link:check` to verify.

> No npm registry install command is provided (this iteration does not publish to npm). Both methods, uninstall, and `--dump-config` verification — including the bundle-layer ordering requirements — are covered in [docs/install.md](docs/install.md).

## Quick start

### Minimal configuration

Add a `fallbacks:` section to the dsh settings document (default `$DSH_HOME/settings.yaml`):

```yaml
fallbacks:
  enabled: true            # feature switch; defaults to false — set explicitly to enable
  chains:
    default:               # default role chain: tried in order after the primary model fails
      - anthropic/claude-3-5-sonnet
      - openai/*
  roles:
    default: default
    rules:
      - origin: subagent   # all subagents → reviewer role (own chain)
        role: reviewer
```

Roles are the grouping key for chains: `roles.default` is the fallback role; `roles.rules` match origin/provider/model in order to a concrete role (first match wins); an explicit `agent.options.role` (subagents via `agentOptions.role`, requires the dsh role patch, see [docs/dsh-patch.md](docs/dsh-patch.md)) has the highest priority — once a `reviewer` chain is configured, agents in that role use their own fallback chain.

Save and restart the web session for the changes to take effect. The feature switch `fallbacks.enabled` **defaults to off (`false`)** — the plugin only engages once it is turned on; `triggerCodes` defaults to `AUTH` / `QUOTA` / `RATE_LIMIT`; and with **no chains configured the behavior is identical to not having the plugin installed**. More examples (role chains, provider wildcard keys, roles rules) → [docs/configuration.md](docs/configuration.md).

> **Upgrade note (behavior change)**: an existing `fallbacks:` section **without an explicit `enabled` key** now resolves to `false` after upgrading — add `enabled: true` to keep the plugin active.

## Documentation

| Doc | Content |
|---|---|
| [docs/install.md](docs/install.md) | profile install / git install / uninstall / `--dump-config` verification |
| [docs/configuration.md](docs/configuration.md) | full `fallbacks` namespace reference, selector syntax, example YAML, settings page usage, behavior notes |
| [docs/dsh-patch.md](docs/dsh-patch.md) | motivation for the subagent explicit-role patch, apply / revert / verify, re-running after dsh upgrades |
| [patches/README.md](patches/README.md) | patch inventory and rationale (companion to docs/dsh-patch.md) |

## License

Released under the **MIT** License — see [LICENSE](LICENSE). The LICENSE file is authoritative for copyright and license terms.
