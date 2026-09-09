---
module: dsh-session-header-slots
date: 2026-09-10
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: subagent-role-badge
applies_when:
  - 插件想在 dsh web 会话标题栏区域贡献内容（徽标/状态/动作）
  - 插件需要按「当前查看的会话」渲染 per-session 数据
  - 需要从插件 gateway 暴露按会话键控的批量回读给 client
tags:
  - dsh
  - ui-slots
  - session-header
  - utilities
  - badge
  - gateway
  - typert
status: active
---

# dsh 会话标题栏槽位契约与插件徽标模式（session header utilities + gateway 批量回读）

## Context

dsh web 的会话标题栏是一棵**槽位树**，插件可外部注册，但各槽 kind 不同、拿到的
props 也不同。iter-20260909 子代理角色徽标（subagent-role-badge）走通了完整的
「插件后端记录 → gateway 批量回读 → 会话标题栏徽标」链路，本篇沉淀该 seam 的
契约与模式。宿主基线：dsh 0.1.2（2026-09-09 验证）。

## Guidance

### 会话标题栏槽位树（ui-conversation `contract/slots.ts:118-141`）

- `conversation.session.header` 是 **single** 槽（ui-conversation 拥有）；它的
  children 才是插件可贡献的面：
  - `...header.lineage`：**single**（ui-subagent 的 SubagentHeaderLineage 拥有）
    —— 插件注册即**替换**宿主渲染器，侵入、升级易碎，不要碰；
  - `...header.actions` / **`...header.utilities`**：**list**（title 邻接 /
    右对齐，ascending order）—— 外部可注册，插件贡献的标准座位；
  - `...header.corner`：single。
- **session 标准道具**：`scope: 'session'` 的槽位occupant 一律经
  `PropsRuntime` 合并拿到 `sessionId: SessionId`（ui-slots `src/index.ts:219-232`
  → ui-session `src/client/index.ts:112-119` 的 `SessionStandardProps`）——
  **owner props 可以是空 marker**（`ConversationHeaderActionOwnerProps` 就是），
  徽标组件直接读 `props.sessionId`，无需任何映射层。注意：本插件 typecheck 程序
  内 `@deepseek-ai/dsh-client-ui-session` 不是 peer（无法 import 其类型），运行时
  该 prop 恒在——**结构化读取 + typeof 守卫**，宿主偏差降级为不渲染。
- **注册形状**与插件其它 list 槽一致（`src/client/index.ts` 的
  `settings.general.item` 先例）：`ctx.slots.inject('<name>', function* () {
  yield ctx.slots.register({ name, id, order, locale: NS }, Component) })`。

### 数据面：插件 gateway 批量回读（而非新遥测通道）

- 后端 per-apply `Map<sessionId, record>`（分发时写一次，O(1)；`agent/disposed`
  + dispose effect 清理，镜像既有 per-agent maps）；gateway 构造函数收一个
  **可选快照函数**（`subagentPolicy` 先例：omitted ⇒ 空对象、throwing ⇒ `{}`，
  fail-closed 不炸宿主）。
- **批量 RPC**：`subagentRoles(ids: string[])` —— ids 非字符串数组 TypeError；
  长度上限（256）同样 TypeError；未知 id **省略不报错**（不泄露存在性）；
  结果对象用 `Map` + `Object.fromEntries` 投影（own property——直接赋值会让
  `__proto__` 键走继承 setter 而**静默消失**于 JSON）。
- **typert 描述符必须显式 `implementation`**：host 分发按
  `descriptor.implementation ?? descriptor.method` 找类成员（dsh-api-gateway
  `lib/index.js:752`，未命中 throw `gateway/method-unavailable`）；wire 方法名
  kebab-case（`subagent-roles`）而类成员 camelCase（`subagentRoles`）时漏写
  alias = 上线后才炸的第一个真实 wire 调用。`revert-seed` 描述符是先例
  （`tests/gateway.spec.ts`）。显式 `ctx.typert.register` 贡献是本地 link 插件
  唯一生效的注册路径（gateway 模块 docblock）。
- 客户端调用走既有 `/api` claim 族：`connection.rpc.call('/api',
  'fallbacks/subagent-roles', { args: { ids } })`。

### 渲染面：degrade-never-crash + 有界重探

- **引擎对节点渲染无 try/catch**（同 chat 节点教训）：shape guard 整记录级
  fail（role/at 坏 → null）、字段级降级（model 坏 → 去 hover）分型守卫；
  结构化读 seat、`try/catch` + `result.ok` 全包 fetch helper、组件内 `.then`
  依赖 helper 的 never-reject 契约。
- **「先开视图后分发」顺序**（运行中的子代理最常见的观察路径）靠**有界重探**：
  无记录时每 2s 重取一次、上限 5 次（~10s 窗口），found / 卸载 / 换会话即停
  （timer 清理 + cancel latch + 会话戳三层防陈旧写入）。重探让「无记录」不再
  等价于「永不出现」，而无需宿主提供 push 失效事件。
- **换会话的陈旧一闪**：状态带 session 戳并在渲染期同步重置（render-time
  reset / keyed remount），不依赖 effect 时序或宿主 remount 行为。
- 记录仅进程内（`agent/disposed` 清除）——徽标跨重启消失是**钉死的语义**
  （持久轨迹 = 既有 info 日志），文档与 hover 文案不得声称持久。

## Why This Matters

utilities 槽是插件在会话标题栏贡献 UI 的唯一低风险座位（lineage 是 single、
替换宿主渲染器不可持续）；而按会话的数据面要么轮询要么批量回读——批量 RPC +
有界重探的组合让插件在无 push 事件的前提下做到「运行中的子代理 ~10s 内可见其
角色」，全部渲染路径可降级。

## When to Apply

- 插件想在会话标题栏显示 per-session 状态（用了哪个角色/模型/策略、健康度）。
- 需要按 sessionId 批量查询插件内存态并在标题栏实时化。
- 评估要不要碰 `header.lineage`（不要）或往 `header.actions`（有动作语义时）。

## Examples

dsh-llm-fallbacks：`src/client/SubagentRoleBadge.tsx`（组件 + 会话戳 + 重探）、
`src/client/fallbacks-store.ts`（`parseSubagentRoleRecord` /
`fetchSubagentRoleRecord` fail-closed helper）、`src/gateway.ts`
（`subagentRoles` 批量端点 + typert 描述符）、`src/index.ts`
（`subagentRoleRecordMap` + `@internal` 测试 seam）；测试
`tests/subagent-role-badge.spec.tsx` / `tests/subagent-role-records.spec.ts`。
