# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh](https://img.shields.io/badge/dsh-DeepSeek%20Harness%20compatible-4B32C3.svg)

dsh（DeepSeek Harness）的自动模型降级插件：当 root agent 或 subagent 的模型请求持续失败（重试耗尽、权限、配额超限、限流 429）时，按角色/模型 fallback 链自动切换 provider/model，当前 step/turn 在目标模型上继续完成——任务不因模型问题中断。

一句话安装（见 [安装](#安装)）：

```sh
dsh plugin --profile web add dsh-llm-fallbacks   # 钉版本：加 @<version>
```

## 能力一览

- **root / subagent 自动降级**：任意 agent 在模型故障下按链切换到下一个可用 provider/model，无需手动换模型。
- **两块制配置**：块 1 `rootChain`——root 主代理唯一降级链（空 = root 不降级）；块 2 声明式角色——`roles.list` 角色实体（id/label/description/chain/fallback）供 `roles.rules` 按 id 引用（或内置 `inherit`）；未命中规则 → `inherit` → `rootChain`。
- **条目语法**：链条目为 `provider/model`（精确切换）或 `provider/*`（保留失败模型 id 仅换 provider）——旧链键命名空间（provider/model 键、角色名键）已删除。
- **冷却与回主**：被切离/失败的模型在冷却期内不再入选；`revertPolicy: cooldown-expiry` 冷却到期后自动回主模型，`never` 会话内不回。
- **行为可见**：每次切换追加持久化会话事件 `fallbacks/switch`（from/to/role/reason），配合 info 级日志（候选尝试顺序与跳过原因）与设置 → 插件配置 → Fallbacks 卡片上的只读状态块，无静默换模型。
- **安全阀**：每 step 的 `maxSwitchesPerStep` 超限后停止切换、保持原错误语义，防止链循环放大延迟；`mode: 'always'` 的 provider 另有重试上限（`alwaysModeRetryCap`）。
- **无配置回归（no-op）**：`enabled` 默认关闭（`false`），无 `rootChain`/角色链 / 未命中触发码 / 角色解析失败时插件完全 no-op——行为与未安装时一致，不产生任何事件。

## 安装

### 一句话安装

```sh
dsh plugin --profile web add dsh-llm-fallbacks   # 钉版本：加 @<version>
```

registry 安装拉取的是**已构建产物**（`dist/`），目标机无需构建。插件为**纯挂载**：对 dsh 源码树零修改，无任何补丁 / postinstall 步骤——dsh 升级无需重打。版本跟随 npm dist-tag（默认 `latest`）；钉精确版本：`dsh plugin --profile web add dsh-llm-fallbacks@<version>`。

### 本地目录安装（开发/验证推荐）

```sh
# 1) 在插件仓库目录构建（prepare 自构建走 pnpm 工具链：tsdown + tsc，无 bun）
pnpm install
# 2) 装入目标 profile（示例为 web）
dsh plugin --profile web add .
```

> **开发前置**：类型检查与测试解析的是**真实** `@deepseek-ai/*` 包（peer 依赖，运行时由宿主提供），
> 来源为 npm registry 的 `0.1.0-rc.6`（`autoInstallPeers` + 用户级 `~/.npmrc` 的 registry
> 认证令牌——pnpm 11 起项目级 `.npmrc` 不再展开 `${NPM_TOKEN}`，无本地 link farm）。

> 两种安装方式、卸载与 `--dump-config` 验证（含 bundle 层顺序要求）详见 [docs/install.md](docs/install.md)。

## 快速开始

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
        label: 审查者
        description: 代码审查子代理
        chain:
          - openai/gpt-4o-mini
        fallback: inherit-root   # 默认：角色链后追加 rootChain
    rules:
      - origin: subagent # 所有 subagent → reviewer 角色（自身链 + 继承 root）
        role: reviewer
```

角色是声明式实体：`roles.list` 存放角色卡（id/label/description + chain/fallback），`roles.rules` 按 origin/provider/model 顺序匹配到**已声明角色 id 或内置 `inherit`**（首个命中即停）——**未命中 → `inherit` → `rootChain`**。只声明不写规则的角色永不命中。角色无 chain 无意义——设置卡拦截保存、启动时告警；请为每个声明角色配置 chain，或让规则直接引用内置 `inherit`。（手写 YAML 角色链缺省/为空不致命：`fallback: inherit-root`（默认）时空链仍按防御语义回退 `rootChain`；`fallback: none` 时空链无候选 → no-op 透传；两种情况都仅启动告警。）旧链键命名空间与角色兜底字段已删除（迁移表见 [docs/configuration.md](docs/configuration.md)）。

保存并重启 web 会话后生效。功能级开关 `fallbacks.enabled` **默认关闭（`false`）**——打开开关后插件才会介入；`triggerCodes` 默认覆盖 `AUTH` / `QUOTA` / `RATE_LIMIT`；**未配置任何 `rootChain`/角色链时行为与未安装插件完全一致**。更多示例（角色实体、fallback 策略、引用 `inherit` 的规则）见 [docs/configuration.md](docs/configuration.md)。

> **升级提示（行为变更）**：已有 `fallbacks:` 配置若**未显式写 `enabled` 键**，升级后解析为 `false`——请补上 `enabled: true` 以保持插件继续生效。

## `/fallbacks` 命令（会话内诊断）

在任意会话中键入 `/fallbacks` 即可查看当前会话的 fallback 状态，无需打开设置页：

- **会话来源**（`root` / `subagent`）与**解析角色**（首个命中规则的 `role`，未命中则内置 `inherit`）；
- 该角色的**解析链**（角色自身链 + 继承的 `rootChain`，`fallback: none` 时仅角色链）——无链时显示「未配置」；
- **最近切换**（`fallbacks/switch` 事件，最新在前，至多 5 条）：from/to provider/model、role、reason；
- **冷却状态**：哪些 `provider/model` 处于冷却、冷却至何时（`revertPolicy: 'never'` 显示「会话内不再回主」）。

命令**只读**——绝不修改 fallback 状态（不重置冷却、不写待应用切换）。它经条件 `commands` 子注入注册，仅在宿主组合了斜杠命令注册表时出现；无注册表时命令静默不可用（无顶层 inject 污染）。输出默认中文（宿主侧无会话级 locale 信号）；英文词典在同一副本表中。

## 纯挂载（零 dsh 修改）

插件以**纯挂载**方式安装，**从不修改 dsh 源码树**：

- **安装 = bundle 行插入 + client inject + 自有 gateway**：`bundle/cordis.patch.yml`
  把插件行插入 profile bundle 栈，`dsh.client.inject` 在设置 → 插件配置页挂载
  Fallbacks 卡片，设置读写/重置
  走插件自有 gateway 通道（`/api/fallbacks/get|set|reset`）。
- **无补丁、无自动打补丁**：没有 dsh 本体 patch 文件，也没有任何安装期 apply 步骤；
  一句话 registry 安装即可用。
- **dsh 升级永不需重打**：dsh 升级重置源码树对本插件无影响——无需任何重打步骤。
- **残留旧补丁无害**：插件不依赖任何补丁导出（角色解析 rules-only；model-selection
  标记协调已移除）——已打过旧补丁的 dsh 树可原样保留或手动回滚，均非必需。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | profile 安装 / registry 安装 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | `fallbacks` 命名空间全字段、selector 语法、示例 YAML、插件配置卡使用、行为说明 |
| [docs/verification.md](docs/verification.md) | 验证记录（测试矩阵、bundle 层序、运行契约、QA gate 剧本） |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
