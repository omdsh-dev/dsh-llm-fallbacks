# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh web](https://img.shields.io/badge/dsh%20web-compatible-4B32C3.svg)
![dsh tui](https://img.shields.io/badge/dsh%20tui-compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-llm-fallbacks?lang=zh)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-llm-fallbacks?ref=badge)

dsh（DeepSeek Harness）的自动模型降级插件：当 root agent 或 subagent 的模型请求持续失败（重试耗尽、权限、配额超限、限流 429）时，按角色/模型 fallback 链自动切换 provider/model，当前 step/turn 在目标模型上继续完成——任务不因模型问题中断。

两个 dsh 前端均可用：**web** profile（设置 → 插件配置 → Fallbacks 卡片）与 **dsh-tui** 终端 profile（`/fallbacks` + `/fallbacks config`）。

## 快速开始

### 安装

```sh
dsh plugin --profile web add dsh-llm-fallbacks      # web profile（设置 → Fallbacks 卡片）
dsh plugin --profile dsh-tui add dsh-llm-fallbacks  # dsh-tui 终端 profile
```

同一个插件、两个前端——区别只在 `--profile` 参数。钉版本：加 `@<version>`。registry 安装拉取的是**已构建产物**（`dist/`），目标机无需构建。registry / git / 本地目录变体、卸载与 `--dump-config` 验证 → [docs/install.md](docs/install.md)。

### 最小配置

在 dsh 的设置文档（默认 `$DSH_HOME/settings.yaml`）中添加 `fallbacks:` 分节：

```yaml
fallbacks:
  enabled: true          # 功能级开关；默认关闭（false），需显式打开后生效
  rootChain:             # 块 1：root 主代理降级链；主模型失败后按顺序尝试
    - anthropic/claude-3-5-sonnet
    - openai/*
  roles:                 # 块 2：先声明角色，再让规则引用
    list:
      - id: reviewer     # 角色实体：id 唯一（/^[a-z0-9-]{1,32}$/）；inherit 为保留字
        persona: 代码审查子代理
        chain:
          - openai/gpt-4o-mini
        fallback: inherit-root   # 默认：角色链后追加 rootChain
    rules:
      - origin: subagent # 所有 subagent → reviewer 角色（自身链 + 继承 root）
        role: reviewer
```

未命中规则 → 内置 `inherit` → `rootChain`。`enabled` **默认关闭（`false`）**——未配置任何链时插件完全 no-op。完整参考（角色实体、fallback 策略、规则、selector、预设角色）→ [docs/configuration.md](docs/configuration.md)。

> **升级提示（行为变更）**：已有 `fallbacks:` 配置若**未显式写 `enabled` 键**，升级后解析为 `false`——请补上 `enabled: true` 以保持插件继续生效。

### 验证

保存并重启会话后，键入 `/fallbacks`——只读的会话内诊断（来源、解析角色、链、最近的 `fallbacks/switch` 事件、冷却状态）。含 `fallbacks/switch` 事件的会话能在重启后正常加载，是因为插件在启动时注册了该事件类型（rc.6 运行时注册；上游注册面待落地）——卸载插件后，含此类事件的会话将再次拒绝加载，直到上游注册面落地（见下方「能力一览」说明）。在 dsh-tui profile 中，`/fallbacks config` 额外回读组合配置（TUI 无设置页——配置仅文件，见 [docs/configuration.md](docs/configuration.md)）。

## 能力一览

- **root / subagent 自动降级**：任意 agent 在模型故障下按链切换到下一个可用 provider/model，无需手动换模型。
- **两块制配置**：`rootChain` 管 root 代理；声明式角色实体（`roles.list`）供 `roles.rules` 引用（或内置 `inherit`）。
- **派发时角色解析**：在 subagent 的首次请求上，其角色按三个阶段解析——显式（`agentPreset` 匹配已声明角色 id）→ 确定性规则（不变）→ LLM 自动匹配（从已声明角色体系中选择，`fallbacks.roleAutoMatch` 默认 `true`）。解析出的角色的链头模型注入首次请求，并作为 `fallbacks/switch` 事件（`reason: 'role-inject'`）呈现；设 `roleAutoMatch: false` 仅关闭 LLM 自动匹配阶段（显式 `agentPreset` 阶段仍生效——无显式角色时即复现原有仅规则行为）。
- **冷却与回主**：被切离/失败的模型在冷却期内不再入选；`revertPolicy: cooldown-expiry` 冷却到期后自动回主模型。
- **行为可见**：每次切换追加持久化会话事件 `fallbacks/switch`（from/to/role/reason），配合 info 级日志——无静默换模型。插件在启动时把该事件类型注册进宿主（rc.6 运行时注册；上游注册面待落地），持久化事件在插件安装期间可跨重启加载。
- **安全阀**：`maxSwitchesPerStep` 限制每 step 切换次数、`alwaysModeRetryCap` 限制 always 模式重试——链循环不会放大延迟。
- **无配置回归（no-op）**：`enabled` 默认关闭；未配置任何链时行为与未安装插件完全一致。

## 预设角色（Preset roles）

插件内置 **7 个通用子代理角色**，开箱即用——`designer` / `librarian` / `reviewer` / `scout` / `security-reviewer` / `sonic` / `task`——`apply` 时自动以 seeded `roles.list` 行（`{ id, persona }`）声明：幂等，且绝不覆盖 operator 同名 persona。它们出现在设置卡的 seed 徽标（id 不可改）与 `/fallbacks config` 的角色摘要中，可直接被 `roles.rules` 引用。

- **开关**：`fallbacks.presets`——`'bundled'`（默认）在 apply 时声明预设角色；`'none'` 关闭自动声明（已物化行保留）。
- 完整语义（升级行为、冲突处理、`presetRoles` 库复用）→ [docs/configuration.md](docs/configuration.md)。

## 纯挂载（零 dsh 修改）

插件以**纯挂载**方式安装：bundle 行插入 + client inject + 自有 gateway 通道（`/api/fallbacks/get|set|reset`）——无 dsh 补丁、无 postinstall 步骤，dsh 升级永不需重打。旧版打补丁安装遗留的补丁无害。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | profile 安装（web + dsh-tui）/ registry / git / 本地目录变体 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | `fallbacks` 命名空间全字段、selector 语法、示例 YAML、插件配置卡使用、TUI 回读、行为说明、预设角色 |
| [docs/consumer-api.md](docs/consumer-api.md) | 开发者消费契约：库 API + 具名 `llm-fallbacks` service + 角色 seeds、导出清单、生命周期、类型说明 |
| [docs/release.md](docs/release.md) | 发布流程：Trusted Publishing 前置、Release prep SOP、fragment 格式、回滚 |
| [docs/verification.md](docs/verification.md) | 验证记录（测试矩阵、bundle 层序、运行契约、QA gate 剧本） |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
