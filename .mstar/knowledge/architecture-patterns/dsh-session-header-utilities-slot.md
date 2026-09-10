---
module: dsh-session-header-slots
date: 2026-09-10
last_updated: 2026-09-10
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: subagent-role-badge
applies_when:
  - 插件想在 dsh web 会话标题栏区域贡献内容（徽标/状态/动作）
  - 插件需要按「当前查看的会话」渲染 per-session 数据
  - 需要在 mount-only 约束下把「会话自己的持久日志」变成一个可跨重启读回的宿主投影值
tags:
  - dsh
  - ui-slots
  - session-header
  - utilities
  - badge
  - session-projection
  - use-projection
status: active
---

# dsh 会话标题栏槽位契约与插件徽标模式（session header utilities + 会话投影读回）

## Context

dsh web 的会话标题栏是一棵**槽位树**，插件可外部注册，但各槽 kind 不同、拿到的
props 也不同。iter-20260909 子代理角色徽标（subagent-role-badge）走通了完整的
「插件在会话标题栏渲染 per-session 数据」链路。宿主基线：dsh 0.1.2（槽位树，
2026-09-09 验证）/ 0.1.5-rc.1（投影注册面，2026-09-10 验证）。

**本篇已于 2026-09-10 刷新（plan role-based-subagent-adoption Task 3b）**：徽标最初的
数据面是「插件内存记录 + gateway 批量 RPC + 有界重探」，该数据面已被删除，替换为
**宿主会话投影键**（从子代理自己日志里的 notice 行折叠出来的只读值）。下面的槽位树
契约不变；数据面与渲染面两节按新链路重写，被删设计见文末 **Superseded**。

## Guidance

### 会话标题栏槽位树（ui-conversation `contract/slots.ts:118-141`）

- `conversation.session.header` 是 **single** 槽（ui-conversation 拥有）；它的
  children 才是插件可贡献的面：
  - `...header.lineage`：**single**（ui-subagent 的 SubagentHeaderLineage 拥有）
    —— 插件注册即**替换**宿主渲染器，侵入、升级易碎，不要碰；
  - `...header.actions` / **`...header.utilities`**：**list**（title 邻接 /
    右对齐，ascending order）—— 外部可注册，插件贡献的标准座位；
  - `...header.corner`：single。
- **session 标准道具**：`scope: 'session'` 的槽位 occupant 一律经
  `PropsRuntime` 合并拿到会话标准 kit（ui-slots `src/index.ts:219-232`
  → ui-session `src/client/index.ts:112-119` 的 `SessionStandardProps`：
  `{ useSession, sessionId, useProjection }`）。注意：本插件 typecheck 程序内
  `@deepseek-ai/dsh-client-ui-session` 不是 peer（无法 import 其类型），运行时
  这些 prop 恒在——**结构化读取 + typeof 守卫**，宿主偏差降级为不渲染。徽标只用
  `useProjection`（它已绑定「当前查看的会话」），不需要 `sessionId` 管线。
- **注册形状**与插件其它 list 槽一致（`src/client/index.ts` 的
  `settings.general.item` 先例）：`ctx.slots.inject('<name>', function* () {
  yield ctx.slots.register({ name, id, order, locale: NS }, Component) })`。

### 数据面：宿主会话投影键（而非插件 gateway 回读）

- **一个键、一次注册**：在 `ctx.sessionProjections`（`SessionProjectionRegistry`）
  上注册一个 session projection unit，注册本身走 `ctx.inject(['sessionProjections'], …)`
  —— 与本插件 `settings` / `llm` / `typert` 相同的 mount-only 惯用法；registry 与其
  缓存是安装 profile 的 base-bundle 行，因此**不需要碰宿主**。
- **唯一真相 = 子代理自己日志里的 notice 行**（`user/message`，来源
  `{ kind: 'plugin', plugin: 'dsh-llm-fallbacks', form: 'notice' }`）。投影是这条行的
  **纯读**：`init` / `apply` 是纯同步折叠，`state` 是 plain JSON，`wire` 发布 client
  可见值。**只解析 content 文本**（`[role: <id>]`），**绝不读 `source.summary`**——
  summary 在 120 字符处被截断（`@deepseek-ai/dsh-llm` `message.ts` /
  `boundContextSummary`）而角色 id 在 settings schema 里没有长度上限，截断会让徽标
  显示一个不存在的角色名。content block 无上限，所以 content 文本是唯一正确的来源；
  行的 provenance（kind + plugin）让预过滤变成 O(1) 廉价判断。
- **投影值只携带角色 id，不携带路由**：路由由宿主既有的 `modelSelection` 投影
  （`lastUsed` = 最近一条已记录请求的路由）单独提供，两者是不同的事实——notice 行在
  子代理首个 step 写一次，而它最终跑在哪个路由上之后还会变。因此 hover 文案必须写
  「**最近一次请求的路由**」，而不是派发时的路由。
- **client 侧就是 seat 的 `useProjection('<key>')`**：会话标准 kit 把 hook 绑定到
  **当前查看的会话**，所以不需要 sessionId 传参、不需要 effect / state、更不需要
  轮询——已结算子会话的 follow opening 快照本身就带这个值，运行中的子会话靠变更帧
  更新；键缺失（宿主没有该 unit，或日志里没有 notice 行）或值异形 = **不渲染**。
- **持久性来自宿主投影缓存**（会话创建 / `turn/end` / dispose 逐单元 checkpoint），
  插件自己不落盘任何东西：已结算的 child 以 unpublished observation 形式被服务，
  其 `projections` 随 opening 快照下发；宿主重启后的冷读同样命中这份缓存。
- **实测归属（重要）**：本节的「跨重启可见」是 seam 契约 + 源码追踪的结论，其
  **宿主侧实测是 plan `role-based-subagent-adoption` 的 QA gate**（在真实宿主上打开已结算的 `kind: 'subagent'`
  子会话，检查 `/api/session/follow` opening frame 的 `projections` 块是否真的带该键，
  并做一次重启后冷读）。若该实测证伪，回退分支是服务端按需读会话（保留 RPC）——
  本篇不冒充已执行的实测证据。

### 渲染面：degrade-never-crash，无轮询

- **引擎对节点渲染无 try/catch**：值级守卫整值 fail（非字符串 / 空串 → 无徽标）、
  字段级降级（路由字段坏 → hover 只留角色）；`useProjection` seat 结构化读取 +
  typeof 守卫，宿主版本偏差降级为不渲染。组件是**无状态、无 effect** 的纯视图。
- **没有重探循环**：值由宿主 push（opening 快照 + 变更帧），所以「先开视图后派发」
  不再是一个需要自愈的时序问题——也就没有 timer / cancel latch / 会话戳三层防陈旧
  写入。上一版那套「每 2s 重取、上限 5 次（~10s 窗口）」的补偿逻辑随之删除。
- 数据本身持久（宿主投影缓存），因此徽标**不再**「跨重启消失」；旧的「仅进程内、
  重启即清空」是钉死的旧语义，已随 RPC 一起废除，文档与 hover 文案都不得再声称。

### Superseded（2026-09-10，plan role-based-subagent-adoption Task 3b）

- **已删除**：`fallbacks/subagent-roles` gateway 批量 RPC 及其 typert 描述符、后端
  `Map<sessionId, record>`（`subagentRoleRecordMap` 及其 `agent/disposed` 清理）、
  client 的 `fetchSubagentRoleRecord` fail-closed helper、10s 有界重探循环与渲染期
  会话戳，以及只钉这些路径的测试。
- **删除理由**：徽标必须在**已结算**子会话与**宿主重启后**都可见（用户要求
  「以后需要都能看到」）；进程内 map 不跨重启，重探窗口只有 ~10s，且 gateway 快照
  只被旧的 auto-match 分支写入，看不到真正解析出角色的派发路径。新数据面复用同一份
  「子代理自己日志里的 notice 行」，单一写入原语 + 单一读取路径，净减代码。
- **仍然有效的教训**（属于插件其它端点）：typert 描述符必须显式 `implementation`
  ——host 分发按 `descriptor.implementation ?? descriptor.method` 找类成员
  （dsh-api-gateway `lib/index.js:752`，未命中 throw `gateway/method-unavailable`），
  wire 方法名 kebab-case 而类成员 camelCase 时漏写 alias = 上线后才炸的第一个真实
  wire 调用（`revert-seed` 描述符是先例）。被删的只是本 seam 的那一个端点。

## Why This Matters

utilities 槽是插件在会话标题栏贡献 UI 的唯一低风险座位（lineage 是 single、
替换宿主渲染器不可持续）。数据面不必是「插件自己的存储 + 回读」：把**会话自己
已经持久化的日志**折叠成一个宿主 projection 值，插件就同时得到三件原本互相冲突的
东西——跨重启可见、无需自建存储、无需轮询或失效事件；而值本身只读、纯 JSON、
可直接降级为不渲染。

## When to Apply

- 插件想在会话标题栏显示 per-session 状态（用了哪个角色/模型/策略、健康度），
  且该状态在**会话日志里已有**或可以写成一行合法消息。
- 需要让「会话自己的一条持久行」变成标题栏可读的状态：优先注册 session
  projection（单一读取路径、宿主负责缓存与推送），而不是新建 RPC + 轮询。
- 评估要不要碰 `header.lineage`（不要）或往 `header.actions`（有动作语义时）。

## Examples

dsh-llm-fallbacks：`src/role-projection.ts`（宿主投影 unit：折叠 notice 行、发布
`wire` 值）、`src/role-projection-key.ts`（host/client 共享的纯 key 模块 + 值守卫，
无 `@deepseek-ai/*` import）、`src/role-notice.ts`（唯一写入原语：`[role: <id>]`
notice 行）、`src/subagents-seam.ts`（同一 install 点注册 notice emitter 与投影 unit）、
`src/client/SubagentRoleBadge.tsx`（结构化读 `useProjection` 的纯视图）；测试
`tests/role-projection.spec.ts`（注册 + 折叠 + key 暴露）、
`tests/subagent-role-badge.spec.tsx`（投影 seat 渲染）。
