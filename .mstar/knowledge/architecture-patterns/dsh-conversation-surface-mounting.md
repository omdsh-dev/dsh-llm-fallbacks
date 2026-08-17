---
module: dsh client conversation surface (transcript mounting for external plugins)
date: 2026-08-12
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: fallbacks-aux-seams
applies_when:
  - 让插件自定义会话事件在 dsh 会话转录中渲染（纯挂载、不改宿主）
  - 理解 conversationEvents 注册表 / conversation.chat.node keyed 座位的契约
  - 实现会话内可见的插件状态呈现（switch 行、通知、状态行）
  - 评估「注入模型上下文」vs「纯渲染」两条会话可见性路径的行为边界
tags:
  - dsh
  - conversation
  - conversation-events
  - chat-node
  - slots
  - render-only
  - degrade-never-crash
  - mount-only
related_components:
  - dsh-private (client/runtime conversation registry, ui-conversation)
  - dsh-llm-fallbacks (ConversationFallbackSwitch)
---

# dsh 会话转录挂载：conversationEvents + conversation.chat.node（纯渲染模式）

外部插件把**自定义会话事件**渲染进 dsh 会话转录的已验证模式（iter-20260812
fallbacks-aux-seams D1+D2 门禁 POSITIVE 并落地）：`conversationEvents` 注册表决定
「事件是否被渲染」，`conversation.chat.node` keyed 座位决定「如何渲染」。核心纪律：
**纯渲染、绝不 throw（degrade-never-crash）**。

## Context

fallbacks/switch 事件已持久化（`SessionEventMap` merge + session.append；跨重启可读依赖插件在 apply() 启动时把类型注册进宿主根导出 `KNOWN_SESSION_EVENT_TYPES`——rc.6 运行时注册 stopgap，上游注册面跟踪见 `.mstar/plans/llm-fallbacks-session-event-format/`），但**不是**
SurfaceEventType（user/message | assistant/message | tool/result）——不进 surface 投影，
会话转录默认完全不渲染。20260811 dsh 的兜底定义（`unknown-surface`）只 match surface
事件，插件事件落在「已持久化但会话内不可见」的空白。本模式回答：如何让这类事件在转录中
可见，且不动宿主、不进模型上下文。

## Guidance

### 双段挂载：注册表 + keyed 座位

1. **`conversationEvents` 服务**（`{HOST}/runtime/src/client/conversation/event-registry.ts:19-27`）：
   `register(definition)`，**kind 唯一、重复抛错**；`registerFallback` 注册单例兜底定义。
   引擎把**每条摄入事件**（surface 与否不限）投喂给**每个定义**的 `match`
   （`conversation-assembler.ts:370-382`；live 路径 `session.ts:673` 全量 append）——
   `ConversationNodeDefinition = { kind; target?; match(event); start(context, match,
   reader); update(context, match); publication?; buildLocationData?; buildViewNode?(context) }`。
   外部注册实证：ui-workflow-run（非 surface 的 `tool-workflow/*` 事件在转录中渲染）。
2. **`conversation.chat.node` keyed 座位**（`{HOST}/ui-conversation/src/client/contract/slots.ts:56-63`）：
   `{ kind: 'keyed'; scope: 'session' }`，按 ChatConversationViewNode.kind 派发
   （`{HOST}/chat/ChatNodeSeat.tsx:48-51`，`entryKey: routedNode.kind`）。注册 shape
   `{ name, key, locale }`，**inject 可选**（ui-tool 的 `tool-call` 即无 inject 注册——
   业务数据经 `node` prop 传入，`ChatNodeDataMap` 类型级 merge 承载 payload）。

```ts
// fallbacks 双段注册（src/client/index.ts:229-244）
ctx.conversationEvents.register(fallbackSwitchDefinition) // kind 'fallbacks-switch'
ctx.slots.inject('conversation.chat.node', function* () {
  yield ctx.slots.register(
    { name: 'conversation.chat.node', key: 'fallbacks-switch', locale: 'fallbacks' },
    ConversationFallbackSwitch
  )
})
```

### 座位 fallback 语义（易错点）

未注册 kind 的节点渲染 **JsonBlock**（label message.unknownSurface，
`{HOST}/chat/ChatNodeSeat.tsx:48-57`）——**不是** `UnknownNodeView`（后者是字面量 `unknown`
key 的注册渲染器，`register-node-renderers.ts:44-45`）。两个概念不同：座位 fallback
是通用 JSON 块，`unknown` 渲染器是注册表内的兜底条目。

### 渲染器纪律

- 自绘在 `--dsw-alias-*` token 上（`ui-conversation` 组件值导入不在 CLIENT_EXTERNALS——
  **type-only 合法，值导入禁止**；fallbacks 实现只值导入 `react`）。
- 业务数据经 `node` prop，零新 inject 面、零新数据路径（事件载荷 = 渲染输入）。
- 未知字段如实呈现（如未知 reason 原样渲染），不编造。

### degrade-never-crash（W-001 教训，硬纪律）

宿主引擎对节点生命周期 **没有 try/catch**（实测 dsh-private）——节点代码 throw 会
炸掉转录装配，不是「某一行不渲染」：

- `match` 对畸形信封（null/空 data、缺/非整数 seq）必须 **no-op**（不 match），不抛错；
- `start` 必须**恒返回确定态**（如降级 `{seq, time}` 快照），对畸形载荷降级而非抛错；
- 事件级守卫与渲染/装配共享同一形状守卫（`src/client/switch-guard.ts`），保证 match/start/buildViewNode
  判定一致；
- 注册返回的 disposer 显式接线（事件注册表无隐式清理）。

### 行为面边界（为什么是纯渲染）

会话可见性有两条路径，行为边界不同：

| 路径 | 机制 | 行为面 | 门禁 |
|------|------|--------|------|
| D1+D2 纯渲染（本模式） | 节点定义 + keyed 渲染器 | 零模型上下文注入 | 无 product 决策（视图贡献） |
| C4 消息注入 | `MessageSourceMap` merge + `createUserMessage` | **注入模型上下文** | 需 product 决策（自描述前缀 + 渲染/自审排除） |

纯渲染优先：达成同用户价值且零行为面。C4 注入会改变模型上下文，默认排除。

## Why This Matters

- 事件持久化 ≠ 事件可见：非 surface 插件事件默认在转录中完全不可见，本模式是纯挂载下
  唯一的「让恢复/状态发生在会话流中可见」的开放路径。
- degrade-never-crash 是**宿主假设**（引擎无 try/catch）——违反它会把单节点错误放大为
  整条转录装配崩溃；QC W-001 正是在此发现的真实缺陷面。
- 纯渲染与消息注入的分界保护模型上下文：切换通知不该让模型「读到」自身恢复过程。

## When to Apply

- 插件有自定义会话事件（非 surface）需要用户可见时（切换行、状态通知、工具结果）。
- 评估会话内呈现的候选座位（D1+D2 逐条行 vs D3 turnTail 聚合行 vs D4 会话头动作）——
  逐条行信息密度最高，聚合/头部是低密度备选。
- 任何在 conversation 面注册渲染器的实现（先读本节纪律，特别是 type-only 与 no-throw）。

## Examples

- fallbacks `src/client/ConversationFallbackSwitch.tsx`：`fallbackSwitchDefinition`（match 只认
  fallbacks/switch 且 id = event seq；start 快照载荷、畸形降级确定态；buildViewNode 于
  anchorSeq 产节点）+ keyed 渲染行（dim 标题 + 分隔点 + 省略摘要 `from → to（role ·
  reason）`，几何对齐上游 compaction 行 `MessageItem.module.css:38-122`）。
- 外部注册先例：ui-tool（`tool-call`，无 inject）、ui-goal（`command-input`）、
  ui-workflow-run（`workflow-run`，带 inject）。
- 未选备选：D3 turnTail（每 Turn 尾部聚合行，后续可叠加）、D4 会话头动作（与 `/fallbacks`
  命令语义重叠）。

*Source: iteration iter-20260812-fallbacks-plugin-config `.mstar/iterations/iter-20260812-fallbacks-plugin-config/guides/seam-exploration-session-visibility.md`
（D1–D4 门禁证据）+ `.mstar/iterations/iter-20260812-fallbacks-plugin-config/guides/mount-point-map.md` D 节，2026-08-12 compound 提升。*
