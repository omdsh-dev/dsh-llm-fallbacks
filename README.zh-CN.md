# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)

dsh（DeepSeek Harness）的自动模型降级插件：当 root agent 或 subagent 的模型请求持续失败（重试耗尽、权限、配额超限、限流 429）时，按角色/模型 fallback 链自动切换 provider/model，当前 step/turn 在目标模型上继续完成——任务不因模型问题中断。

一句话安装（pnpm ≥ 10 需一次构建放行，见 [安装](#安装)）：

```sh
dsh plugin --profile web add github:dsh-external/dsh-llm-fallbacks   # 钉 commit：加 #<sha>
```

## 能力一览

- **root / subagent 自动降级**：任意 agent 在模型故障下按链切换到下一个可用 provider/model，无需手动换模型。
- **角色链**：subagent 可走独立于 root 的 fallback 链——`roles.rules` 按 origin/provider/model 顺序匹配到具体角色 → `roles.default`，首个命中即停。
- **链 specificity**：exact `provider/model` 键 → `provider/*` 键 → 角色链 → `default` 链；`provider/*` 条目保留失败模型 id 仅换 provider。
- **冷却与回主**：被切离/失败的模型在冷却期内不再入选；`revertPolicy: cooldown-expiry` 冷却到期后自动回主模型，`never` 会话内不回。
- **行为可见**：每次切换追加持久化会话事件 `fallbacks/switch`（from/to/role/reason），配合 info 级日志（候选尝试顺序与跳过原因）与 web 设置页只读状态，无静默换模型。
- **安全阀**：每 step 的 `maxSwitchesPerStep` 超限后停止切换、保持原错误语义，防止链循环放大延迟；`mode: 'always'` 的 provider 另有重试上限（`alwaysModeRetryCap`）。
- **无配置回归（no-op）**：`enabled` 默认关闭（`false`），空链 / 未命中触发码 / 角色解析失败时插件完全 no-op——行为与未安装时一致，不产生任何事件。

## 安装

### 一句话 git 安装

```sh
dsh plugin --profile web add github:dsh-external/dsh-llm-fallbacks   # 钉 commit：加 #<sha>
```

git 安装拉取的是**源码而非构建产物**，安装时由包自行构建（`prepare` 自构建）。插件为**纯挂载**：对 dsh 源码树零修改，无任何补丁 / postinstall 步骤——dsh 升级无需重打。pnpm ≥ 10 默认不执行 git 依赖的 `prepare`：第一次 `add` 会失败并打印 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，同时给出精确的包 key。在该 profile 的 `pnpm-workspace.yaml` 中放行构建（`onlyBuiltDependencies: [dsh-llm-fallbacks]`，或运行 `dsh plugin --profile web approve-builds`），然后重跑 `add`。请把这次放行当作它本来的样子：允许该包代码在安装期于你的机器上执行——建议钉 commit（`github:dsh-external/dsh-llm-fallbacks#<sha>`），防止后续 push 悄悄改变实际运行的代码。完整 URL 形式等价：`dsh plugin --profile web add https://github.com/dsh-external/dsh-llm-fallbacks.git`。

### 本地目录安装（开发/验证推荐）

```sh
# 1) 在插件仓库目录构建（prepare 自构建走 pnpm 工具链：tsdown + tsc，无 bun）
pnpm install
# 2) 装入目标 profile（示例为 web）
dsh plugin --profile web add .
```

> **开发前置**：类型检查与测试解析的是**真实** `@deepseek-ai/*` 包（peer 依赖，运行时由宿主提供），
> 来源为你的 dsh 源码树——`$DSH_SOURCE_DIR`，缺省 `${DSH_HOME}/source/current`
> （`scripts/setup-dsh-links.mjs` 在 `prepare` 时把它们链接进 `node_modules/`，含 in-box cordis
> 的 bin-less shim）。`pnpm dsh:link` 重链（换 `$DSH_HOME` 后重跑）、`pnpm dsh:link:check` 校验。

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

角色是链的分组键：`roles.default` 为兜底角色，`roles.rules` 按 origin/provider/model 顺序匹配到具体角色（首个命中即停）——角色解析为 **rules-only**（不存在显式角色字段；提供该字段的旧 dsh 补丁已移除）。配置了 `reviewer` 链后，归属该角色的 agent 走独立 fallback 链。

保存并重启 web 会话后生效。功能级开关 `fallbacks.enabled` **默认关闭（`false`）**——打开开关后插件才会介入；`triggerCodes` 默认覆盖 `AUTH` / `QUOTA` / `RATE_LIMIT`；**未配置任何链时行为与未安装插件完全一致**。更多示例（角色链、provider 通配键、roles 规则）见 [docs/configuration.md](docs/configuration.md)。

> **升级提示（行为变更）**：已有 `fallbacks:` 配置若**未显式写 `enabled` 键**，升级后解析为 `false`——请补上 `enabled: true` 以保持插件继续生效。

## 纯挂载（零 dsh 修改）

插件以**纯挂载**方式安装，**从不修改 dsh 源码树**：

- **安装 = bundle 行插入 + client inject + 自有 gateway**：`bundle/cordis.patch.yml`
  把插件行插入 profile bundle 栈，`dsh.client.inject` 挂载 web 设置页，设置读写/重置
  走插件自有 gateway 通道（`/api/fallbacks/get|set|reset`）。
- **无补丁、无自动打补丁**：没有 dsh 本体 patch 文件，也没有任何安装期 apply 步骤；
  一句话 git 安装即可用。
- **dsh 升级永不需重打**：dsh 升级重置源码树对本插件无影响——无需任何重打步骤。
- **残留旧补丁无害**：插件不依赖任何补丁导出（角色解析 rules-only；model-selection
  标记协调已移除）——已打过旧补丁的 dsh 树可原样保留或手动回滚，均非必需。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | profile 安装 / git 安装 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | `fallbacks` 命名空间全字段、selector 语法、示例 YAML、设置页使用、行为说明 |
| [docs/verification.md](docs/verification.md) | 验证记录（测试矩阵、bundle 层序、运行契约、QA gate 剧本） |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
