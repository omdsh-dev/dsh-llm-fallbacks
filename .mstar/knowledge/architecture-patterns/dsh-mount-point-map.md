---
module: dsh host + client mounting seams (external plugins)
date: 2026-08-12
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: fallbacks-mount-map-command
applies_when:
  - 评估 dsh 外部插件功能能否在 mount-only 约束下挂载（settings / gateway / events / commands / 会话面）
  - 为后续迭代挑选下一批可落地 seam（避免重新考古 dsh-private）
  - 判断「必须改宿主」类结论是否成立——先查地图与证据标准，再下结论
  - 复刻本轮的可行性门禁方法（falsifiable gate）评估新 seam
tags:
  - dsh
  - mount-only
  - seams
  - slots
  - gateway
  - events
  - commands
  - conversation
related_components:
  - dsh-private (ui-settings, ui-plugin-config, ui-conversation, ui-slots, host/apiproxy, api/remotes)
  - dsh-llm-fallbacks
---

# dsh 外部插件挂载点地图（mount-only seam inventory + 门禁方法）

系统性盘点 dsh（20260811 snapshot）可供外部插件挂载的 seam 的地图与评估方法（iter-20260812
产出）。**地图结论 = 已实测（dsh-private file:line）的挂载事实**，不是推断；full evidence
表存迭代 package（`.mstar/iterations/iter-20260812-fallbacks-plugin-config/guides/mount-point-map.md`），本
文是模式层：分类摘要 + 判定方法与关键不变量。

## Context

dsh-llm-fallbacks 的交付约束是 **mount-only**（对 dsh 源码树零修改）。在此约束下「某功能
能否挂载、成本多大」不能靠猜测——需要一份带证据的 seam 地图。2026-08-12 对 dsh 20260811
快照系统性调查出 **32 个 seam**，其中 16 个 implement-now、2 个 gated、其余 map-only/闭合。
地图同时是三处可行性门禁（General 行、会话可见性、只读状态命名空间）的输入。

**证据标准（每 seam 强制五列）**：Contract（slot 类型/服务面/事件签名）· Evidence
（dsh-private `file:line`，实测非推断）· Feasibility（外部 mount-only 插件能否用：
bundle purity 值导入规则 + apiproxy allowlist + 是否需已注册 settings 命名空间）·
Cost（S ≤1 文件注册型 / M 2–4 文件新组件 / L host+client 协同或新 gateway 端点）·
Verdict（implement-now / gated / map-only + 理由）。

## Guidance

### 关键机制事实（所有 seam 共用）

- **Bundle purity gate**：client 值导入仅允许 `CLIENT_EXTERNALS` = `PLATFORM_MODULES`
  （10 项：react/*、@deepseek-ai/cordis、`dsh-client-ui-slots`、`dsh-client-web-react`、
  `dsh-client-ui-primitives`、`dsh-client-ui-attachment`、`dsh-client-schema-form`，
  `{HOST}/packages/client/web/src/platform.ts:8-15`）+ @deepseek-ai/dsh-client-runtime/client
  豁免。**跨插件值导入在构建门抛错**；type-only import 永远合法（emit 时擦除）。
  → 任何「值导入某 `@deepseek-ai/*` 包」的 seam 都需先查该包是否在表内。
- **Slot 注册统一 `ctx.slots.inject`**（非裸 register）：等待声明就绪、声明坍缩时自动移除、
  重声明后重跑（`{HOST}/runtime/src/client/slots.ts:130-192`）。
- **List slot 排序**：`order` 升序，**同 order 按注册先后稳定排序**
  （`{HOST}/ui-slots/src/index.ts:779-783`，V8 stable sort）——order tie 是稳定且可预期的。
- **负 seam 也重要**：`exposedNamespaces()` 白名单（apiproxy wire）、单座 slot、无开放注册
  面的 host 上下文——这些是「为什么必须走替代路径」的存档。

### Verdict 语义

| Verdict | 含义 |
|---------|------|
| implement-now | 外部插件可直接挂载（本轮已实现或可立即实现） |
| gated | 可用但需额外门禁/产品决策（行为级改动、跨 scope 观察纪律） |
| map-only | 记录在案但不做：不适用 / 被更优 seam 覆盖 / 单座闭合 / 负 seam（不可用） |
| 闭合 | 单座已被宿主或其它插件占用，无插入位 |

### Seam 分类摘要（每行详细证据 → package guide 同名节）

**A. Settings slots（web client 展示挂载面）**

| Seam | 契约要点 | 可行性 | 成本 | Verdict |
|------|----------|--------|------|---------|
| `settings.plugin.item` | keyed/root（rc.7 起；key = 卡片编辑的设置命名空间）；卡自绘（owner `children?: never`） | ✅ | S | **implement-now**（fallbacks 卡，key `fallbacks`） |
| settings.section | list/root；整页导航 | ✅ | S | map-only（fallbacks 已迁出；其它产品仍可用） |
| `settings.general.item` | list/root；owner 空、行自绘 | ✅ | S | **implement-now**（fallbacks 只读行，order 100） |
| settings.action | list/root；头部操作 | ✅ | S–M | map-only（被 `/fallbacks` 命令覆盖） |
| settings.onboarding | list/root；一次一个引导接管 | ✅ | M | map-only（偏好类功能不适用） |
| settings.trigger/header/close | single，shell 自占 | ❌ | — | map-only（闭合） |
| ctx.locale | ns 字典注册 | ✅ | S | implement-now（zh/en 文案） |

**B. 数据面（host wire / settings 通道）**

| Seam | 契约要点 | 可行性 | 成本 | Verdict |
|------|----------|--------|------|---------|
| 插件自有 gateway 通道（B1） | `TypertRemoteService` 绑定 + 显式 `ctx.typert.register(contribution)`（2026-08-13 起；`@Remote` SRC 标记对 link 插件失效）；`/api/<ns>/<method>`；wire `{ok,value}`/`{ok:false,error}` | ✅ | S | implement-now；多命名空间经第二个 `GatewayService` + `{namespace}` 选项 |
| connection.api 目录面（B2） | settings.describe / llm.providers / llm.models / sessions.history | ✅ | S | implement-now（目录、切换历史、writable） |
| apiproxy `exposedNamespaces()`（B3） | 白名单外写请求拒绝 | ❌ 负 seam | — | map-only（替代 = B1 gateway） |
| ctx.settings 进程内（B4） | register/update(MERGE)/replace(reset) | ✅ host 半 | S | implement-now；schema 非严格 → 写前必须拒绝未知键 |
| remote 转发事件（B5） | `ctx.remote.$on`；白名单 `API_REMOTE_FORWARDED_EVENTS` | ✅ 白名单内 | S | implement-now；新事件类型需改宿主白名单（非纯挂载路径） |
| connection/reset（B6） | client 事件；连接代际重建时 emit | ✅ | S | implement-now |

**C. 运行时/agent 面（host）**

| Seam | 契约要点 | 可行性 | 成本 | Verdict |
|------|----------|--------|------|---------|
| Session 生命周期（C1） | session/created / session/event / session/disposed，`{global:true}` | ✅ | S | **gated**（跨 scope 观察需双侧 dispose 纪律） |
| Agent 事件（C2） | agent/request-error / agent/request / agent/status / created / disposed | ✅ | S | implement-now（fallback 决策本体） |
| `SessionEventMap` merge（C3） | 类型级 merge + session.append；非 SurfaceEventType 不进 surface 投影 | ✅ | S | implement-now（fallbacks/switch） |
| `MessageSourceMap` merge（C4） | `createUserMessage` 注入 user-role 消息 | ✅ | S–M | **gated**（改变模型上下文，需产品决策） |
| Slash 命令（C5） | `commands` 服务注册；**条件注入子** `ctx.inject(['commands'])` | ✅ | S | implement-now（`/fallbacks`） |
| ctx.llm 目录（C6） | listModels / listConfigurableProviders | ✅ host 半 | S | implement-now |
| ctx.logger（C7） | cordis 内建 | ✅ | — | 琐碎，非挂载点 |

**D. Conversation 面（client，会话内展示）** → 详见
`.mstar/knowledge/architecture-patterns/dsh-conversation-surface-mounting.md`（本轮单独提升）。

| Seam | 契约要点 | 可行性 | 成本 | Verdict |
|------|----------|--------|------|---------|
| `conversationEvents`（D1） | `ConversationNodeDefinition` 注册表；引擎全事件投喂每个定义 | ✅ | M | implement-now（`fallbacks-switch` 节点） |
| `conversation.chat.node`（D2） | keyed 座位按 node kind 派发；座位 fallback = JsonBlock | ✅ | S | implement-now（keyed 渲染行） |
| `conversation.chat.turnTail`（D3） | chain 槽；每 Turn 尾部聚合行 | ✅ | M | map-only（信息密度低于逐条行） |
| `conversation.session.header.actions`（D4） | list；会话头操作 | ✅ | M | map-only（与命令语义重叠） |
| conversation.input.overlay/dock 等（D5） | composer 浮层/输入区 | ✅ | M | map-only |
| conversation.view / hero 单座（D6） | view 环 / hero 单座已占用 | ✅/❌ | L | map-only（闭合） |
| ctx.slash（D7） | client 触发管线 | ✅ | M | map-only（与 host 命令重复） |
| `conversation.chat.commandview`（D8） | keyed 命令行槽 | ✅ | M | map-only（命令成功文本已够） |

**E. Sidebar / Workspace（闭合面）**：sidebar.workspaces/sidebar.settings、
`directoryFlow` 双单座均已占用 → map-only（闭合）。

**F. 打包与清单（安装面）**：pkg.dsh manifest（bundle patch + client inject + platform）=
外部包声明即挂载；**bundle 插行顺序决定 host waterfall 顺序与 plugin.item 卡同序**
（tie 语义）。implement-now。

**G. Host Contexts（提示词面）**：**无开放注册 seam**——host 上下文是宿主自有包 + 自有
prompt 装配；外部插件不能加 host 上下文。开放替代 = C4 消息注入。

### 可行性门禁方法（falsifiable gate，三处门禁验证过的范式）

每处「可不可挂」必须写成**可证伪的判定条件**，逐条给 dsh-private 证据，全满足为正：

1. slot/服务存在且 kind/scope/owner 匹配需求（file:line）；
2. owner props 允许目标形态（空 = 自绘；非空则含所需数据）；
3. 数据可经现有 controller/事件流触达，不改其 API（零新数据路径优先）；
4. bundle purity gate 通过：仅 type-only import 相关 `@deepseek-ai/*` 包（build 后 grep
   dist 无残留实证）；
5. 行为面纯净：纯渲染 ≤ 消息注入 ≤ 决策改动（越界需 product 决策，记 gated）。

**负结论纪律**：门禁为负 → 地图 + 探索 guide 书面 verdict（证据、原因、替代），**禁止
静默放弃**；门禁为正但产品价值不足 → 记录为 map-only + 理由（如 D3/D4 未选）。

## Why This Matters

- 挂载决策从「偶发发现」变成「按图挑选」：每个 seam 的可行性/成本/用途已实测存档，
  下轮迭代直接选 seam，不需要重新考古 dsh-private。
- 「必须改宿主」是最贵的结论——地图证明多数能力面都有开放 seam（settings 卡/行、命令、
  会话转录、gateway、remote 事件），改宿主结论需要先反驳地图证据。
- 门禁方法可证伪：每个 POSITIVE 都有 file:line 契约证据与 bundle 实证，评审可复核，
  不会出现「误判可挂 → 实现期失败」。

## When to Apply

- 任何「在 dsh 上挂新功能但不动宿主」的评估，先读本图对应类别 + 证据标准。
- 规划下一批 seam 落地（地图 H2 门禁输入模式：General 行 / 会话可见性 / 只读状态
  命名空间已演示完整流程）。
- 判断 order tie / 注册顺序 / 事件白名单类语义问题时。

## Examples

- **已落地三处门禁**：General 行（A3，order 100 列尾，读-only，KD-G5 诚实呈现）、
  会话可见性（D1+D2，纯渲染零模型上下文注入）、`/fallbacks` 命令（C5，条件注入子
  静默缺席）。探索过程见 package `guides/seam-exploration-*.md`。
- **负 seam**：B3（插件命名空间不在 apiproxy 白名单 → 走 B1 gateway）、E1/E2/G1
  （单座占用/无开放注册面 → 闭合）。

*Source: iteration iter-20260812-fallbacks-plugin-config `.mstar/iterations/iter-20260812-fallbacks-plugin-config/guides/mount-point-map.md`
（32 seams 全证据表）+ guides/seam-exploration-{general-row,session-visibility}.md
（门禁展开证据），2026-08-12 compound 提升（结构化重写为模式层；逐 seam file:line 证据
以 package 为 SSOT）。*
