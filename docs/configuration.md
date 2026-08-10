# 配置指南（`fallbacks` 命名空间）

插件配置集中在 `fallbacks` settings 命名空间，可在 dsh 设置文档（默认 `$DSH_HOME/settings.yaml`）中编辑，也可在 web 设置 GUI 的 **Fallbacks** 页中编辑——两者读写同一命名空间，GUI 保存带修订号冲突保护。web 页的读写可用依赖 dsh 本体暴露 patch（`dsh-settings` + `dsh-host-apiproxy`，见 [docs/dsh-patch.md](docs/dsh-patch.md)）应用并重建；未应用时页面显示「未注册」、保存被拒并如实提示。

## 字段总览

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 功能级总开关。默认关闭（OFF）：`false` 时插件完全不介入、设置页隐藏配置表单主体；`true` 但未配置任何链时行为与未安装插件一致（no-op） |
| `triggerCodes` | string[] | `['AUTH', 'QUOTA', 'RATE_LIMIT']` | 命中这些失败码时进入链决策。可重试型故障（5xx / `RATE_LIMIT` 等）先由 llm-retry 退避重试，预算耗尽后同样进入决策——**无需为 5xx 额外添加 triggerCodes** |
| `chains` | Record&lt;string, string[]&gt; | `{}` | 链键 → 有序 fallback 选择器列表。键为 `provider/model`、`provider/*` 或角色名；条目为 `provider/model` 或 `provider/*`（见下文 selector 语法） |
| `roles.default` | string | `'default'` | 角色解析兜底：无显式 role、无规则命中时使用的角色 |
| `roles.rules` | Array | `[]` | 角色规则：按 `origin`（`root`/`subagent`）、`provider`、`model` 模式匹配到角色，顺序匹配、首个命中即停 |
| `cooldownMs` | number | `300000` | 冷却时长（毫秒）。被切离/失败的模型在冷却期内不再入选 |
| `revertPolicy` | `'cooldown-expiry'` \| `'never'` | `'cooldown-expiry'` | 冷却到期后的回主策略：到期回主模型 / 会话内保持备用模型 |
| `maxSwitchesPerStep` | number | `8` | 单步安全阀：每 step 切换次数上限，超限停止切换、保持原错误语义，防止链循环放大延迟 |
| `alwaysModeRetryCap` | number | `5` | always 模式重试上限：`retryPolicy.mode === 'always'` 的 provider 在同一请求内重试达到该次数后切换；`0` 禁用 |

> 默认值以本迭代 readme-settings spec §1.2 为准（`enabled` 默认 `false`），与 `src/config.ts` 的 schema 默认值一致；设置页对数值字段（`cooldownMs` / `maxSwitchesPerStep` / `alwaysModeRetryCap`）旁显示默认值，其余字段展示当前生效值（未配置时即默认值）。

## Selector 语法

**链键**（`chains` 的键）：

- `provider/model` —— 精确匹配：仅当失败请求恰好使用该 provider/model 时命中此链；
- `provider/*` —— provider 通配：该 provider 下任意模型失败时命中；
- 角色名（如 `default`、`reviewer`）—— 按角色解析结果命中（见下文角色解析）。

**链条目**（`chains` 的值，有序）：

- `provider/model` —— 切换到指定模型；
- `provider/*` —— 保留失败模型 id，仅切换 provider；目标 provider 无此模型 id 时跳过该候选（近匹配模糊解析不在本迭代范围）。

非法/未知 selector（缺分隔符、空段、多余分隔符等）在启动与设置变更时告警，不崩溃、不生效；在 dsh 运行环境（存在模型目录服务）下，`*/*` 永不匹配——作为链键，查找键来自具体失败 provider，`*` 不可能命中；作为条目，目标 provider 无 `*` 模型目录，存在性探针会跳过该候选。

## 链解析（specificity）

失败发生时按以下优先级取链（首个命中的链键贡献条目，多条命中按优先级合并、条目保持列表内顺序）：

1. exact `provider/model` 键；
2. `provider/*` 键；
3. 当前 agent 角色链（角色名作键）；
4. `default` 链。

候选过滤（命中即跳过）：与当前模型相同、处于冷却期、本 step 已失败、`provider/*` 条目目标 provider 无此模型 id。

## 角色解析

角色是 fallback 链的分组键，解析顺序（首个命中即停）：

1. `agent.options.role` —— 显式角色（subagent 经 dsh role patch 的 `agentOptions.role` 传入，见 [docs/dsh-patch.md](docs/dsh-patch.md)）；
2. `roles.rules` 顺序匹配（`origin` / `provider` / `model` 模式，字段省略即不约束）；
3. `roles.default`（默认 `'default'`）。

root agent 与 subagent 均参与；root 走 `roles.default` 或规则。

## 示例 YAML

以下配置演示 default 链、角色链与 provider 通配键（写入 `$DSH_HOME/settings.yaml`）：

```yaml
fallbacks:
  enabled: true
  triggerCodes:
    - AUTH
    - QUOTA
    - RATE_LIMIT
  chains:
    default:                     # 角色 default 链：主模型失败后按顺序尝试
      - anthropic/claude-3-5-sonnet
      - openai/*
    reviewer:                    # 角色链：role=reviewer 的 agent 走独立链
      - openai/gpt-4o-mini
    deepseek/*:                  # provider 通配键：deepseek 任意模型失败时命中
      - openai/gpt-4o
  roles:
    default: default
    rules:
      - origin: subagent         # 所有 subagent → reviewer 角色
        role: reviewer
      - provider: deepseek       # deepseek provider 的 agent → reviewer 角色
        role: reviewer
  cooldownMs: 300000
  revertPolicy: cooldown-expiry
  maxSwitchesPerStep: 8
  alwaysModeRetryCap: 5
```

要点：

- 示例显式设置 `enabled: true`——功能级开关默认 `false`，未显式打开时插件不介入、设置页隐藏配置表单主体。
- 链首条目即主模型之后的第一个降级目标；链内条目即优先级。
- 切换只改变后续请求的 provider/model 路由，不重置会话上下文与工具状态。
- 链目标模型需各自已配置密钥与配额（不同 provider 之间成本/额度可能不同）。

## web 设置页使用说明

- **入口**：web 设置 GUI → Settings → **Fallbacks**（位于 Models 页之后）。
- **始终可用（骨架恒渲染）**：无论是否已配置 `fallbacks` 命名空间（首次打开、loading、error 等任意描述符状态），页面都渲染骨架——`nav` 标题、介绍、只读状态块、功能级开关 `enabled`、保存/恢复默认动作。命名空间尚未注册时显示默认配置种子，保存动作可用（失败会如实提示，见下）。
- **功能级开关 `enabled`（默认 OFF）**：开关即用户配置字段 `fallbacks.enabled`，默认关闭。关闭时隐藏配置表单主体（`triggerCodes` / `chains` / `roles` / `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`），显示「功能未开启：打开 `enabled` 开关以显示配置界面」提示——隐藏不丢弃，编辑中的 draft 保留；打开后显示完整配置界面。拨动开关即时显隐（draft 驱动），经保存动作持久化。
- **可读标签**：枚举型配置项显示可读标签而非原始枚举值——`RATE_LIMIT` →「限流（429）」、`QUOTA` →「配额超限」、`AUTH` →「权限/认证失败」；`cooldown-expiry` →「冷却到期后回主模型」、`never` →「保持备用模型」。数值字段旁显示默认值；其余字段展示当前生效值（未配置时即默认值）。
- **链/角色行编辑**：`chains` 以「键 + 每行一个选择器的多行输入」编辑；`roles.rules` 以行编辑（origin/provider/model/role），空字段不参与匹配。provider/model 输入为**目录下拉**（模型目录驱动）：新行只提供目录内选项，目录外值读回时以合成选项标注保留（不被目录选择丢弃）；目录不可用/为空时下拉禁用并显示提示，不阻塞手写。
- **model-selection 协调（AC-2）**：存在活跃 model-selection（用户在设置页 / `settings.yaml` 选择了 provider/model）时，触发码故障后的切换**同样生效**——fallback-routed 标记使外层 model-selection 监听器对当步让位，请求路由到链目标，下一步恢复用户选择（spec §2.5 D-1）。
- **恢复默认**：一键把该命名空间的用户配置重置为组合默认值（`enabled` 回 `false`）。
- **冲突重载**：保存携带 `expectedRevision`；配置被其它地方修改时保存被拒，页面显示冲突横幅与「重新加载」按钮，避免静默覆盖并发修改。命名空间尚未注册时保存省略 `expectedRevision` 尝试写入，host 拒绝则错误横幅如实呈现、骨架与 draft 保留。
- **只读状态块**：显示当前生效配置摘要（启用状态/默认角色/链数/触发码）+ **最近切换摘要**（来自当前会话原始 `fallbacks/switch` 事件面，最新在前，每条含 from/to/role/reason/时间）+ **当前生效模型**（由配置 + 最近切换**推导**的展示值，非实时路由探测，附非实时说明文案）。摘要随 `settings/changed` / 会话切换 / 连接重置推送刷新（无轮询）——页面打开期间发生的切换，在下一次推送或重载页面后呈现；状态块只读、不可编辑。

## 行为说明

### 触发条件

`enabled` 为 true、存在匹配链、且失败码 ∈ `triggerCodes`（默认 `AUTH`/`QUOTA`/`RATE_LIMIT`）时进入链决策：

- `AUTH` / `QUOTA` 为不可重试码，不经退避直达本插件；
- `RATE_LIMIT` 及 5xx 等可重试码先由 llm-retry 退避重试，预算耗尽后委托到本插件；
- 未命中 triggerCodes 的失败（含 always 模式下的非 triggerCode 失败）一律透传，走 llm-retry 或原错误路径。

### 切换后继续

命中候选 → 记录待应用切换 + 把当前模型压入冷却 + 记账 + 追加 `fallbacks/switch` 事件 → 返回重试 → 下一轮请求在目标模型上构建，当前 step/turn 继续完成，任务不中断。

### 冷却与回主

被切离/失败的模型在 `cooldownMs` 内不再入选（冷却与「本 step 已失败」双重抑制）；`cooldown-expiry` 冷却到期后该模型可重新入选（回主）；`never` 会话内不回（无限冷却）。

### 安全阀与 always 模式

- **安全阀**：每 step 记录失败模型集合与切换计数，`maxSwitchesPerStep` 超限后不再决策，step 以原错误语义结束（原始错误码与 message 原样保留）；step 推进时重置。
- **always 模式 cap**：`retryPolicy.mode === 'always'` 的 provider 在请求构建边界按 turn/step/provider 统计已持久化的 `llm/retry` 事件数，≥ `alwaysModeRetryCap`（0 禁用）时触发切换（`reason: always-cap`）。llm-retry 的 always 模式先委托下游再退避，cap 之前本插件不抢占（见 spec ADR-2）。

### no-op 不变量

未配置链 / `enabled: false` / 未命中 triggerCodes / 角色解析失败 / 链耗尽 / 安全阀超限：插件一律透传，请求与会话事件流与未安装插件时完全一致，不产生任何 `fallbacks/switch` 事件。

### 与 llm-retry 的关系

本插件**不修改** llm-retry 与 provider 的 `retryPolicy`：fallback 只在 llm-retry 委托/耗尽后介入（bundle 层序保证，见 [docs/install.md](docs/install.md)）；`llm/retry` 事件仅用于 always 模式 cap 计数。插件卸载（HMR/dispose）时监听随 fiber 卸载、每-agent 状态整体清空，无残留状态。
