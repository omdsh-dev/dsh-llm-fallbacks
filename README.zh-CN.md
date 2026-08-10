# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![bun](https://img.shields.io/badge/bun-%3E%3D1.2.17-fbf0df.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)

dsh（DeepSeek Harness）的自动模型降级插件：当 root agent 或 subagent 的模型请求持续失败（重试耗尽、权限、配额超限、限流 429）时，按角色/模型 fallback 链自动切换 provider/model，当前 step/turn 在目标模型上继续完成——任务不因模型问题中断。

一句话安装：

```sh
dsh plugin --profile web add https://github.com/dsh-external/dsh-llm-fallbacks.git
```

## 能力一览

- **root / subagent 自动降级**：任意 agent 在模型故障下按链切换到下一个可用 provider/model，无需手动换模型。
- **角色链**：subagent 可走独立于 root 的 fallback 链——显式 `agent.options.role`（需 dsh role patch）→ `roles.rules` 顺序匹配 → `roles.default`，首个命中即停。
- **链 specificity**：exact `provider/model` 键 → `provider/*` 键 → 角色链 → `default` 链；`provider/*` 条目保留失败模型 id 仅换 provider。
- **冷却与回主**：被切离/失败的模型在冷却期内不再入选；`revertPolicy: cooldown-expiry` 冷却到期后自动回主模型，`never` 会话内不回。
- **行为可见**：每次切换追加持久化会话事件 `fallbacks/switch`（from/to/role/reason），配合 info 级日志（候选尝试顺序与跳过原因）与 web 设置页只读状态，无静默换模型。
- **安全阀**：每 step 的 `maxSwitchesPerStep` 超限后停止切换、保持原错误语义，防止链循环放大延迟；`mode: 'always'` 的 provider 另有重试上限（`alwaysModeRetryCap`）。
- **无配置回归（no-op）**：`enabled` 默认关闭（`false`），空链 / 未命中触发码 / 角色解析失败时插件完全 no-op——行为与未安装时一致，不产生任何事件。

## 安装

### 一句话 URL 安装

```sh
dsh plugin --profile web add https://github.com/dsh-external/dsh-llm-fallbacks.git
```

### 本地目录安装（开发/验证推荐）

```sh
# 1) 在插件仓库目录构建（prepare 自构建需要 bun）
pnpm install
# 2) 装入目标 profile（示例为 web）
dsh plugin --profile web add .
```

> 不提供 npm registry 安装命令（本迭代未发布 npm 包）。两种安装方式、卸载与 `--dump-config` 验证（含 bundle 层顺序要求）详见 [docs/install.md](docs/install.md)。

## 快速开始

### 最小配置

在 dsh 的设置文档（默认 `$DSH_HOME/settings.yaml`）中添加 `fallbacks:` 分节：

```yaml
fallbacks:
  enabled: true          # 功能级开关；默认关闭（false），需显式打开后生效
  chains:
    default:             # 角色 default 链：主模型失败后按顺序尝试
      - anthropic/claude-3-5-sonnet
      - openai/*
  roles:
    default: default
    rules:
      - origin: subagent   # 所有 subagent → reviewer 角色（走独立链）
        role: reviewer
```

角色是链的分组键：`roles.default` 为兜底角色，`roles.rules` 按 origin/provider/model 顺序匹配到具体角色（首个命中即停）；显式 `agent.options.role`（subagent 经 `agentOptions.role` 传入，需 dsh role patch，见 [docs/dsh-patch.md](docs/dsh-patch.md)）优先级最高——配置了 `reviewer` 链后，归属该角色的 agent 走独立 fallback 链。

保存并重启 web 会话后生效。功能级开关 `fallbacks.enabled` **默认关闭（`false`）**——打开开关后插件才会介入；`triggerCodes` 默认覆盖 `AUTH` / `QUOTA` / `RATE_LIMIT`；**未配置任何链时行为与未安装插件完全一致**。更多示例（角色链、provider 通配键、roles 规则）见 [docs/configuration.md](docs/configuration.md)。

> **升级提示（行为变更）**：已有 `fallbacks:` 配置若**未显式写 `enabled` 键**，升级后解析为 `false`——请补上 `enabled: true` 以保持插件继续生效。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | profile 安装 / git 安装 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | `fallbacks` 命名空间全字段、selector 语法、示例 YAML、设置页使用、行为说明 |
| [docs/dsh-patch.md](docs/dsh-patch.md) | subagent 显式角色 patch 的动机、应用/回滚/验证、dsh 升级后重跑 |
| [patches/README.md](patches/README.md) | patch 清单与原理（与 docs/dsh-patch.md 配套） |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
