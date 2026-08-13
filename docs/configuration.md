# 配置指南（`fallbacks` 命名空间）

插件配置集中在 `fallbacks` settings 命名空间，可在 dsh 设置文档（默认 `$DSH_HOME/settings.yaml`）中编辑，也可在 web 设置 GUI 的 **插件配置 → Fallbacks 卡片**中编辑——两者读写同一命名空间。卡片的读写走**插件自有 gateway 通道**（`/api/fallbacks/get` / `/api/fallbacks/set` / `/api/fallbacks/reset`），不依赖 dsh 本体的任何设置暴露机制；`fallbacks` 命名空间不出现在宿主 describe 暴露集合属预期设计。插件对 dsh 源码树**零本地修改**（纯挂载：bundle 行插入 + client inject + 自有 gateway），dsh 升级无需重打补丁。

## 两块制模型

配置自 iter-20260813 起为**两块制**，用户只需记住两块：

| 块 | 一句话 | 配置落点 |
|----|--------|----------|
| 块 1 | root 主代理失败只走这一条链；空 = 不降级 | `rootChain` |
| 块 2 | 先声明角色，再让规则引用；没命中则继承 root | `roles.list` + `roles.rules` |

**不要混用：**

- `'inherit'` = 内置**角色 id**（规则目标 / 未命中缺省；**禁止**写入 `roles.list[].id`）；
- `'inherit-root'` = 角色实体上的**链拼接策略**（默认；角色链走完再**追加** `rootChain`）；
- 旧「角色解析兜底字段」**已删除**，不再是有效配置（改写依据见下文迁移映射表）。

## 字段总览

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 功能级总开关。默认关闭（OFF）：`false` 时插件完全不介入、卡片隐藏配置表单主体；`true` 但未配置任何链时行为与未安装插件一致（no-op） |
| `triggerCodes` | string[] | `['AUTH', 'QUOTA', 'RATE_LIMIT']` | 命中这些失败码时进入链决策。可重试型故障（5xx / `RATE_LIMIT` 等）先由 llm-retry 退避重试，预算耗尽后同样进入决策——**无需为 5xx 额外添加 triggerCodes** |
| `rootChain` | string[] | `[]` | **块 1**。root 主代理的有序降级链；条目为 `provider/model` 或 `provider/*`（见下文条目语法）。空 = root 不降级（no-op 透传） |
| `roles.list` | Array | `[]` | **块 2**。声明式角色实体集合（id/label/description + 可选 chain/fallback，条目字段见下表）。id 须匹配 `/^[a-z0-9-]{1,32}$/` 且集合内唯一；`'inherit'` 为保留字，**禁止**用作 id |
| `roles.rules` | Array | `[]` | **块 2**。角色规则：按 `origin`（`root`/`subagent`）、`provider`、`model` 模式顺序匹配到角色（字段省略即不约束，首个命中即停）；`role` 只能引用 `roles.list[].id` 或内置 `'inherit'` |
| `cooldownMs` | number | `300000` | 冷却时长（毫秒）。被切离/失败的模型在冷却期内不再入选 |
| `revertPolicy` | `'cooldown-expiry'` \| `'never'` | `'cooldown-expiry'` | 冷却到期后的回主策略：到期回主模型 / 会话内保持备用模型 |
| `maxSwitchesPerStep` | number | `8` | 单步安全阀：每 step 切换次数上限，超限停止切换、保持原错误语义，防止链循环放大延迟 |
| `alwaysModeRetryCap` | number | `5` | always 模式重试上限：`retryPolicy.mode === 'always'` 的 provider 在同一请求内重试达到该次数后切换；`0` 禁用 |

> 默认值以 `src/config.ts` 的 `defaultFallbacksConfig` 为准；卡片对数值字段（`cooldownMs` / `maxSwitchesPerStep` / `alwaysModeRetryCap`）旁显示默认值，其余字段展示当前生效值（未配置时即默认值）。

### `roles.list` 条目字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 角色 id：`/^[a-z0-9-]{1,32}$/`、集合内唯一；`'inherit'` 为保留字，禁止使用 |
| `label` | string | 是 | 角色名称（自由文本，不校验） |
| `description` | string | 是 | 角色描述（自由文本，不校验） |
| `chain` | string[] | 否 | 角色自身的有序降级链（条目语法同 `rootChain`）；缺省空 = 该角色无自身链 |
| `fallback` | `'inherit-root'` \| `'none'` | 否（默认 `'inherit-root'`） | 链拼接策略：`inherit-root` = 角色链走完再追加 `rootChain`；`none` = 仅用角色自身链 |
| `prompt` / `permissions` | string / object | 否 | **预留字段**（见下节） |

### `roles.rules` 条目字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `origin` | `'root'` \| `'subagent'` | 来源约束；省略 = 不约束 |
| `provider` | string | provider 约束；省略 = 不约束 |
| `model` | string | model 约束；省略 = 不约束 |
| `role` | string | 规则目标：**必须**引用 `roles.list[].id` 或内置 `'inherit'`；未声明引用 → 告警 + `legacyKeys`，该条不生效 |

### `prompt` / `permissions`（预留字段）

`roles.list` 条目上的 `prompt` 与 `permissions`（`allow` / `deny`）为 **schema 预留字段**：

- **YAML 写入不改变本轮降级行为**——本轮无运行时消费方；
- **UI 本轮不展示**——Fallbacks 卡片不渲染这两个字段；
- **next iteration 由插件 subagent 工具消费**——落地为 persona 注入与 tool 过滤（规划中的 `fallbacks-explicit-role-tool`）。

## 条目语法

**链条目**（`rootChain` / `roles.list[].chain` 的值，有序）：

- `provider/model` —— 精确切换：切换到指定模型；
- `provider/*` —— 保留失败模型 id，仅切换 provider；目标 provider 无此模型 id 时跳过该候选（近匹配模糊解析不在本迭代范围）。

> **链键命名空间已删除**：旧 `chains` 键的三种键语义（`provider/model` exact、`provider/*` 通配、角色名作键）不再存在——失败模型特异路由改由 `roles.rules`（按 provider/model 模式匹配到角色）近似，角色归属由声明实体表达。条目侧 `provider/*` 通配保留。

空白填充边界：selector 的空白填充（如 `other/ gpt-4o`）在保存时**原样保留**（GUI 不重写用户输入），运行时解析归一化（`parseSelector` 容忍空白），语义与未填充时一致。

非法/未知条目（缺分隔符、空段、多余分隔符等）在保存校验时告警并**拦截保存**（卡片）或启动告警（校验函数），不崩溃、不生效；在 dsh 运行环境（存在模型目录服务）下，`*/*` 永不匹配——目标 provider 无 `*` 模型目录，存在性探针会跳过该候选。

## 角色解析与链拼接

**角色解析**（所有 agent，root 与 subagent 同构；顺序匹配、首个命中即停）：

1. `roles.rules` 按 `origin` / `provider` / `model` 模式匹配（字段省略即不约束）→ 命中的规则目标角色；
2. 未命中任何规则 → 内置 `'inherit'` 角色（无自身链 → `rootChain`）。

`inherit` 是**保留角色 id**：它只作规则目标 / 未命中缺省，**禁止**写入 `roles.list[].id`。命中规则但目标角色未在 `roles.list` 声明 → 防御性回退 `'inherit'` 并告警。

**链拼接**（append-not-replace）：命中角色的实际候选链为

```text
[...role.chain, ...(role.fallback === 'none' ? [] : rootChain)]
```

- `fallback: inherit-root`（默认）：角色自身链在前，`rootChain` 兜底在后；
- `fallback: none`：仅角色自身链；自身链为空且 `none` → no-op 透传；
- 未命中规则（`inherit`）或角色未声明：候选链 = `rootChain`。

候选过滤（命中即跳过）：与当前模型相同、处于冷却期、本 step 已失败、`provider/*` 条目目标 provider 无此模型 id。

> **运行时落地说明**：上述角色解析 / 链拼接的**新语义运行时消费落地在 Plan 2（fallbacks-role-runtime）**；本轮（iter-20260813）**配置形状已生效**——schema、校验、UI 编辑面与 legacy 检测均按新模型工作，运行时决策暂经最小过渡适配读取旧形状（源码标注 `TODO(plan fallbacks-role-runtime T2)`），决策行为不变。

## 示例 YAML

以下配置演示两块制完整形态——root 链、角色实体（含 `fallback` 策略）与引用声明角色 / 内置 `inherit` 的规则（写入 `$DSH_HOME/settings.yaml`）：

```yaml
fallbacks:
  enabled: true
  triggerCodes:
    - AUTH
    - QUOTA
    - RATE_LIMIT
  rootChain:                     # 块 1：root 主代理降级链；空 = root 不降级
    - anthropic/claude-3-5-sonnet
    - openai/*
  roles:                         # 块 2：先声明角色，再让规则引用
    list:
      - id: reviewer             # 角色实体：id 唯一、/^[a-z0-9-]{1,32}$/；inherit 为保留字
        label: 审查者
        description: 代码审查子代理
        chain:                   # 角色自身链
          - openai/gpt-4o-mini
        fallback: inherit-root   # 默认：角色链走完再追加 rootChain
      - id: cheap
        label: 廉价模型
        description: 成本优先
        chain:
          - deepseek/deepseek-chat
        fallback: none           # 仅角色链，不追加 rootChain
    rules:                       # 顺序匹配 origin/provider/model；未命中 → inherit（root 链）
      - origin: subagent         # 所有 subagent → reviewer 角色
        role: reviewer
      - provider: deepseek       # deepseek provider 的 agent → cheap 角色
        role: cheap
      - provider: deepseek       # 精确 provider/model → 显式指向内置 inherit（root 链）
        model: deepseek-reasoner
        role: inherit
  cooldownMs: 300000
  revertPolicy: cooldown-expiry
  maxSwitchesPerStep: 8
  alwaysModeRetryCap: 5
```

要点：

- 示例显式设置 `enabled: true`——功能级开关默认 `false`，未显式打开时插件不介入、卡片隐藏配置表单主体。
- 链首条目即主模型之后的第一个降级目标；链内条目即优先级。
- 只声明角色不写规则 = 该角色**永不命中**（未命中走 `inherit` → `rootChain`）；想让角色被命中必须同时写一条引用它的 `roles.rules`。
- `role: inherit` 是合法规则目标：显式把某类请求指向内置 inherit（root 链）。
- 切换只改变后续请求的 provider/model 路由，不重置会话上下文与工具状态。
- 链目标模型需各自已配置密钥与配额（不同 provider 之间成本/额度可能不同）。

## 迁移映射表（旧格式 → 新格式）

旧格式（iter-20260812 及以前）配置**不会自动迁移**：插件检测到后经三通道提示（见下节），由用户按下表手工改写。

| 旧（iter-20260812 及以前） | 新 |
|----------------------------|-----|
| `chains: { default: [...] }` | `rootChain: [...]` |
| `chains: { reviewer: [...] }` | `roles.list: [{ id: reviewer, chain: [...] }]`（另写一条 `roles.rules` 才能命中该角色；只声明不引用 = 永不命中，未命中走 `inherit`） |
| `chains: { deepseek/*: [...] }` | `roles.rules: [{ provider: deepseek, role: <已声明 id> }]`（须先有对应 `roles.list` 项；或删除该键） |
| `chains: { deepseek/deepseek-chat: [...] }` | `roles.rules: [{ provider: deepseek, model: deepseek-chat, role: <已声明 id> }]` |
| `roles.rules[].role` 任意字符串 | 引用 `roles.list[].id` 或内置 `'inherit'`（enum）；未声明引用 → `legacyKeys` + 告警，该条不生效 |
| `roles.default: 'default'`（或任意字符串） | **删除该字段**；无规则命中 → 内置 `'inherit'`（→ `rootChain`）。「所有子代理默认走某链」改写为一条 `{ origin: subagent, role: <id> }` |
| 角色链无兜底 | `fallback: inherit-root`（默认）→ `[...role.chain, ...rootChain]`；`fallback: none` → 仅 `role.chain` |
| （无对应旧字段）`prompt` / `permissions` | schema **预留**；本轮无 UI、无运行时消费；YAML 写入不改变本轮降级行为 |
| （无对应旧字段）角色 id = `inherit` | **禁止**写入 `roles.list`；`inherit` 只作规则目标 / 未命中缺省 |

## 三通道 legacy 提示

旧格式配置升级后经**三通道**提示，不静默丢失、**不自动改文件**：

1. **UI 横幅**（本轮已生效）：Fallbacks 卡片主体顶部渲染迁移提示（`get` 响应 `legacyKeys` 非空时）——「检测到旧格式配置字段（…）：已按新模型展示，请按 docs/configuration.md 迁移表手工改写；插件不会自动改写配置。」不阻断编辑、不改磁盘；下一次保存以新格式整体覆写。
2. **启动 warn**（日志文案落地在 Plan 2 `apply()`）：插件启动/配置读取时以 `logger.warn` 提示检测到的 legacy 字段。本轮已产出检测能力（`detectLegacyKeys` / `legacyKeys` 管道），启动告警文案随 Plan 2 运行时切换一并落地；三通道在 Plan 1 + Plan 2 均 Done 后闭合。
3. **本文档迁移表**：上节「迁移映射表」为手工改写依据。

## web 插件配置卡使用说明

- **入口**：web 设置 GUI → Settings → **插件配置** 页 → **Fallbacks 卡片**（与 bash / agent-loop / web-search / advisor 卡同列表，order 30；卡片取代了旧的独立 Settings 导航页）。
- **始终可用（骨架恒渲染）**：无论首次打开、loading、error 等任意状态，卡片都渲染骨架——卡片头（名称/描述）、只读状态块、功能级开关 `enabled`、保存/恢复默认动作。配置来自 gateway 通道 `get`（成功则 `present`）；`get` 失败/通道不可达时显示可操作骨架而非死卡，保存动作可用（失败会如实提示，见下）。
- **legacy 横幅**：`get` 响应含 `legacyKeys`（非空）→ 卡片主体顶部渲染迁移提示横幅（zh/en），指向本文档迁移表；不阻断编辑、不改磁盘。
- **功能级开关 `enabled`（默认 OFF）**：开关即用户配置字段 `fallbacks.enabled`，默认关闭。关闭时隐藏配置表单主体（`triggerCodes` / `rootChain` / `roles` / `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`），显示「功能未开启：打开 `enabled` 开关以显示配置界面」提示——隐藏不丢弃，编辑中的 draft 保留；打开后显示完整配置界面。拨动开关即时显隐（draft 驱动），经保存动作持久化。
- **可读标签**：枚举型配置项显示可读标签而非原始枚举值——`RATE_LIMIT` →「限流（429）」、`QUOTA` →「配额超限」、`AUTH` →「权限/认证失败」；`cooldown-expiry` →「冷却到期后回主模型」、`never` →「保持备用模型」；`inherit-root` →「继承 root（角色链后追加 rootChain）」、`none` →「仅角色链（不追加 rootChain）」。数值字段旁显示默认值；其余字段展示当前生效值（未配置时即默认值）。
- **rootChain 区**：标题「root 主代理降级链」+ 提示「未配置 = root 不降级」；选择器行复用目录下拉（provider/model 级联 + `provider/*` 通配 + 目录外合成选项），**无键输入**。
- **roles.list 区**：每角色一张实体卡——id（文本，格式校验：`/^[a-z0-9-]{1,32}$/`、唯一、`inherit` 保留字非法）、label（文本）、description（文本）、chain 选择器行（可折叠/追加）、fallback 下拉（`inherit-root` / `none`）、删除按钮；「添加角色」按钮。**本轮不渲染** `prompt` / `permissions`。
- **roles.rules 区**：行编辑 origin（root/subagent/任意）+ provider（目录下拉/任意）+ model（级联下拉/任意）+ role（**下拉**：`inherit` + 已声明角色 ids，同页联动——角色增删即时反映）；「添加规则」按钮。空字段不参与匹配。
- **保存前校验（拦截 save）**：id 格式/唯一/保留字、rule role 引用、selector 非法 → 行内标注（红边/提示）+ 错误横幅；**校验失败拦截 `save()`**——点保存不写入、看到错误；校验通过才经 gateway `set` 写 user layer。
- **model-selection 协调（AC-2，文档化降级）**：存在活跃 model-selection（用户在设置页 / `settings.yaml` 选择了 provider/model）时，触发码故障后的切换**仍然决策并记录**（`fallbacks/switch` 事件、冷却；当步实际路由可能被活跃 selection 覆写，最终 provider/model 以重新套用的选择为准）——这是去掉本地 patch 标记协调后的**宿主原生行为**（T2 结论，见 [docs/verification.md](docs/verification.md) §4.3）。request-error 触发链不受影响；无活跃 selection 时路由到链目标。卡片含一行降级说明（`status.selectionNote`，zh/en）。
- **恢复默认**：一键把该命名空间的用户配置重置为组合默认值（`enabled` 回 `false`）——经 gateway `reset`（清空 user layer，组合默认值生效）。
- **保存与错误呈现**：保存经 gateway `set`（merge 语义）写 user layer，无 revision guard——并发/写失败时错误横幅如实呈现保存结果，骨架与 draft 保留（不静默覆盖）。
- **只读状态块**：显示**当前生效模型**（由配置 + 最近切换**推导**的展示值——无切换时取 `rootChain` 首项；未启用或 `rootChain` 未配置时显示「fallbacks 未启用（或 rootChain 未配置）」；非实时路由探测，附非实时说明文案）+ **最近切换摘要**（来自当前会话原始 `fallbacks/switch` 事件面，最新在前，每条含 from/to/role/reason/时间）。摘要随 `settings/document-updated`（fallbacks 命名空间）/ `llm/adapters-updated`（仅目录）/ 会话切换 / 连接重置推送刷新（无轮询）——页面打开期间发生的切换，在下一次推送或重载页面后呈现；状态块只读、不可编辑。会话内的同款诊断也可用 `/fallbacks` 命令查看（见 README）。

## 行为说明

### 触发条件

`enabled` 为 true、存在匹配的候选链、且失败码 ∈ `triggerCodes`（默认 `AUTH`/`QUOTA`/`RATE_LIMIT`）时进入链决策：

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

未配置 `rootChain` 且无命中角色链 / `enabled: false` / 未命中 triggerCodes / 角色解析失败 / 链耗尽 / 安全阀超限：插件一律透传，请求与会话事件流与未安装插件时完全一致，不产生任何 `fallbacks/switch` 事件。

### 与 llm-retry 的关系

本插件**不修改** llm-retry 与 provider 的 `retryPolicy`：fallback 只在 llm-retry 委托/耗尽后介入（bundle 层序保证，见 [docs/install.md](docs/install.md)）；`llm/retry` 事件仅用于 always 模式 cap 计数。插件卸载（HMR/dispose）时监听随 fiber 卸载、每-agent 状态整体清空，无残留状态。
