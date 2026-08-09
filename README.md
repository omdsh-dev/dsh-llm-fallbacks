# dsh-llm-fallbacks

dsh（DeepSeek Harness）的自动模型降级插件：当 root agent 或 subagent 的模型请求持续失败（重试耗尽、权限、配额超限、限流 429）时，按角色/模型 fallback 链自动切换 provider/model，当前 step/turn 在目标模型上继续完成——任务不因模型问题中断。

> 本插件与 omp 的 `retry.modelFallback` / `retry.fallbackChains` 语义对齐（对照见下），dsh 侧以 `fallbacks` settings 命名空间承载配置。

## 能力一览

- **root / subagent 自动降级**：任意 agent 在模型故障下按链切换到下一个可用 provider/model，无需手动换模型。
- **角色链**：subagent 可走独立于 root 的 fallback 链——显式 `agent.options.role`（需 dsh role patch）→ `roles.rules` 顺序匹配 → `roles.default`，首个命中即停。
- **链 specificity**：exact `provider/model` 键 → `provider/*` 键 → 角色链 → `default` 链；`provider/*` 条目保留失败模型 id 仅换 provider。
- **冷却与回主**：被切离/失败的模型在冷却期内不再入选；`revertPolicy: cooldown-expiry` 冷却到期后自动回主模型，`never` 会话内不回。
- **行为可见**：每次切换追加持久化会话事件 `fallbacks/switch`（from/to/role/reason），配合 info 级日志（候选尝试顺序与跳过原因）与 web 设置页只读状态，无静默换模型。
- **安全阀**：每 step 的 `maxSwitchesPerStep` 超限后停止切换、保持原错误语义，防止链循环放大延迟；`mode: 'always'` 的 provider 另有重试上限（`alwaysModeRetryCap`）。
- **无配置回归**：`enabled` 默认开启，但空链 / 未命中触发码 / 角色解析失败时插件完全 no-op——行为与未安装时一致，不产生任何事件。

## 与 omp `retry.modelFallback` / `fallbackChains` 语义对照

| dsh-llm-fallbacks | omp | 语义对照 |
|---|---|---|
| `fallbacks.enabled` | `retry.modelFallback` | 功能总开关。dsh 默认 `true`（空链即 no-op）；omp 关闭即不触发 |
| `fallbacks.chains` | `retry.fallbackChains` | 链配置。键/条目 selector 语法与 specificity（exact → `provider/*` → 角色 → default）一致 |
| `fallbacks.revertPolicy` | `retry.fallbackRevertPolicy` | `cooldown-expiry` / `never` 语义一致：冷却到期回主 / 会话内不回 |
| `fallbacks.roles`（default / rules / `agent.options.role`） | 子代理模型 pattern 列表（首个可解析 pattern 为主模型、其余为 fallback；无 `agent:<name>` 链键） | 都以「角色/agent」为链分组维度；dsh 的显式 role 与规则匹配更精确，可让 subagent 独立成链 |
| `fallbacks.triggerCodes` | 无公开对应配置（按失败类型触发） | dsh 将触发失败码集合开放为可配置项，默认 `['AUTH', 'QUOTA', 'RATE_LIMIT']` |
| `fallbacks.cooldownMs` / `maxSwitchesPerStep` / `alwaysModeRetryCap` | 无公开对应配置（冷却为内置行为） | dsh 侧可配置的冷却时长、单步安全阀、always 模式重试上限 |

> omp 侧语义以 omp 自身文档为准；本表仅列出本插件与之对齐/差异的部分，dsh 侧字段定义见 [docs/configuration.md](docs/configuration.md)。

## 快速开始

### 安装

本地目录安装（推荐开发/验证）：

```sh
# 1) 在插件仓库目录构建（prepare 自构建需要 bun）
pnpm install
# 2) 装入目标 profile（示例为 web）
dsh plugin --profile web add .
```

git 安装：

```sh
dsh plugin --profile web add https://github.com/<owner>/dsh-llm-fallbacks.git
```

> 两种安装方式与验证步骤详见 [docs/install.md](docs/install.md)（含 bundle 层顺序要求与 `--dump-config` 验证）。

### 最小配置

在 dsh 的设置文档（默认 `$DSH_HOME/settings.yaml`）中添加 `fallbacks:` 分节：

```yaml
fallbacks:
  chains:
    default:            # 角色 default 链：主模型失败后按顺序尝试
      - anthropic/claude-3-5-sonnet
      - openai/*
```

保存并重启 web 会话后生效。插件默认已启用（`enabled: true`），`triggerCodes` 默认覆盖 `AUTH` / `QUOTA` / `RATE_LIMIT`，**未配置任何链时行为与未安装插件完全一致**。更多示例（角色链、provider 通配键、roles 规则）见 [docs/configuration.md](docs/configuration.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | profile 安装 / git 安装 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | `fallbacks` 命名空间全字段、selector 语法、示例 YAML、设置页使用、行为说明 |
| [docs/dsh-patch.md](docs/dsh-patch.md) | subagent 显式角色 patch 的动机、应用/回滚/验证、dsh 升级后重跑 |
| [patches/README.md](patches/README.md) | patch 清单与原理（与 docs/dsh-patch.md 配套） |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
