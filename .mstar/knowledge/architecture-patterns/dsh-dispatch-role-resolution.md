---
module: dsh-llm-fallbacks dispatch-time role resolution
date: 2026-08-17
last_updated: 2026-11-06
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: dsh-022-rc1-upgrade
applies_when:
  - 在 dsh 中为 subagent 分发时解析角色并挂载虚拟链路由
  - 需要理解三段式解析（显式 agentPreset → dispatch 声明 → 规则）的 mount-only seam 与安全边界
  - 设计插件客户端「依据配置键存在性显隐 UI」的开关类控件
  - 评估插件在虚拟适配器 stream() 决策点与 dispatch seam 的干预边界
- 排查 subagent 链头（套餐用尽 / 429）失败后走到 `rootChain` 而非角色链的问题
- 给按子会话 id 键的 per-child 角色记录选失效边界（读侧校验 vs 清理时机）
  - 排查 subagent 链头失败后「角色链丢失、落到 rootChain」类问题
  - 给跨调用状态（cooldown/recovery store、per-child 记录）设计失效边界（配置变更能否无差别清空）
tags:
  - dsh
  - llm-fallbacks
  - role-resolution
  - dispatch
  - automatch
  - role-inject
  - agentpreset
  - mount-only
---

# dsh 分发时角色解析：三段式 + 虚拟链挂载（mount-only seam 模式）

subagent 分发时的三段式角色解析（显式 → dispatch 声明 → 规则）与虚拟链路由挂载的已验证模式：三级全部确定性、无模型参与；挂载发生在**创建时**（`SubagentStartRequest.agentOptions`），链本身由虚拟适配器的 `stream()` 内链走执行，因此不再有「首请求注入 / 失败期记忆体」这套机制（rc.1 前身见文末历史注记）。

## Context

用户方向：subagent 被分发时角色不能靠碰运气——显式指定角色要生效，规则未命中时也不能静默变形。既有角色解析是**确定性规则匹配**（src/roles.ts resolveRole：provider/model 按列出顺序首中 → 声明角色 id；未命中 → 内置 inherit → rootChain），**不存在**「把角色清单交给模型自选」的机制。`AgentOptions` 仍只有 provider/model/maxTokens；rc.1 还删掉了 `SubagentStartRequest.persona`——persona 改由 `src/role-persona.ts` 在 `agent/created` 上以**子作用域 system-prompt section**（与全局 deployment persona 同名同序，故替换而非叠加）投递，所以「决策点读不到 persona」这一约束的解决方式是**投递面**，不是把 persona 塞回路由对象。本模式回答：在纯挂载（零 dsh 改动）约束下，把分发时角色解析做成三级确定性排序，并在创建时把子代理挂到虚拟链路由上——解析、挂载、执行各占一个不同 seam，互不代偿。

## Guidance

### 三段式解析（全部确定性，无 LLM）

分发时角色解析 = 显式 → dispatch 声明 → 规则 三级，首中即停，返回值恒为「声明角色 RAW id」或内置 inherit：

1. **显式角色**：dispatch 显式命名角色 → 直接走该角色。mount-only 载体 = 子会话 header 的 agentPreset 字段（child meta 折叠进 SessionHeader），与已声明角色 id 精确匹配（trim 后相等；无 substring/前缀猜测）→ 该角色 declared RAW id。agentPreset 为 inherit 或未声明值 → 落入下一级；inherit 永不是可派发的显式角色。
2. **dispatch 声明**：dispatch seam 从子请求 prompt 的 Assignment header 区解析 `**Execute as**: <id>`（src/subagents-seam.ts 的 resolveDeclaredRoleFromAssignment，唯一纯解析点）：只读 header 区（首个 Assignment body marker 之前；无 marker 时取首段 + 后续 header 型段落，正文段落一律排除，故正文里引用的同一行不可能塑造解析），区内不同声明 id 必须恰好收敛到一个——歧义、未声明、`inherit`、缺席一律等于「无角色」→ 落入下一级；解析失败被 containment 成一条 debug 行，绝不打断分发。
3. **规则匹配**：既有 resolveRole 原样（声明角色胜；inherit 落入下一级）。规则按 provider/model 匹配且 subagent-only（per-rule `origin` 字段仅遗留保留，匹配期忽略）——配置语义 → `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md` §Config model and chain resolution。

实现形态：src/role-resolution.ts 的 resolveDeclaredRole 是**纯同步排序逻辑**（无 config 对象、无 IO、无 LLM）——walk 必须在首 chunk 之前同步抛 pre-attempt 错误，解析因此不能 await。dispatch 角色由 seam 解析一次后存进按子会话 id 键的记录，walk 每次决策读 `seamRecord(sessionId).role` 传入 `dispatchRole`；规则匹配额外接受 `servedRoute`，使一个路由被虚拟行服务的子代理仍能命中按真实链头写的规则。

### 自动匹配段已删除（有界安全理由）

rc.1 连同 `roleAutoMatch` 键与 automatch 模块整体删除了 LLM 自动匹配段——不是「暂时关闭」，而是它原有的宿主形态已不成立：

- 唯一的宿主点是已删除的 agent/request 注入（首请求覆写请求配置）：rc.1 拒绝改变捕获选择的请求，request-error 重试也沿用捕获选择，所以那条路径连「命中后再覆写」的机会都没有。
- 在 walk 的 `stream()` 内跑一次补全 = **每次失败一次嵌套请求**，把恢复路径变成第二条请求生成路径。
- 解析必须纯同步：walk 在首 chunk 之前同步抛 `EMPTY_EFFECTIVE_CHAIN` / `UNDISPATCHABLE_EFFECTIVE_HEAD` / `LLM_UNAVAILABLE`，await 一个模型调用会让这三个错误失去「首 chunk 前抛出」的语义。

由此保留的硬约束：解析无 LLM、无 IO、不抛错逃逸（未知规则目标只 warn 并退化 `inherit`）；旧 `roleAutoMatch` 键由 `detectLegacyKeys` 报进 legacy 横幅，插件绝不自动改写配置。

### 分发时挂载（SubagentStartRequest.agentOptions，creation-time）

- 挂载点 = 子代理创建请求的 `agentOptions`：seam 盖 `{ provider: 'FallbacksChain', model: 'Auto' }`，宿主在 `manager.startLocal` 创建子代理时把它 merge 到父路由之上——子代理因此被虚拟行服务，链由 walk 解析。五条件（已解析角色 / 请求无显式路由 / LOCAL backend / 配置活跃且角色链有可派发 exact 头 / 宿主策略非 `unprovable`）取舍 → `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md` §Subagent mount at the dispatch seam。
- 显式路由 = 授权：请求自带 `agentOptions.provider` / `.model` 时原样通过，插件绝不改写（链头标签 `authorized`，对比插件挂载的 `injected`）。
- 链头合法性判定搬进 walk（`roleChainEntries` + `firstDispatchableExactHead`，与 walk 起步同一对调用），seam 只问「有没有可派发的 exact 头」——不再复用 overrideConfig，也不再做「链头 ≠ 请求当前模型」的 same-as-current 守卫：请求本来就落在虚拟行上，没有「当前真实模型」可比较。
- creation-time only：续跑子代理的持久选择恒胜（注入只发生在创建那一刻，永不覆写已存在子代理的路由）。
- 外部（acp）backend 不产生本地 agent、进程外也解析不到虚拟 provider → 保持纯继承（无链）。

### 挂载不是失败决策（creation-time 语义）

- 挂载只盖创建选项 + 写 per-child 记录（角色、`virtualRouteInjected` 粘性标记、persona 裁决、链头标签）；**不**写失败记账，也没有 per-request 记账可写——rc.1 删除了 pendingSwitch / stepFailures / appliedTurnStep，walk 自己的 per-call 状态随 walk 一起消亡（唯一跨调用记忆是 cooldown/recovery store）。
- **不** append durable fallbacks/switch 事件（issue #52 stop-write 仍然有效）：切换走 info 日志，`role-inject` 只是遗留事件词汇表里的只读标签，没有写入点。
- 越权面为零：只有 LOCAL backend 且无显式路由的子代理会被挂载；root 代理不触碰，外部 backend 纯继承；续跑子代理因 creation-time only 免于覆写。
- 幂等：每个子代理只在创建工作那一刻判定一次（记录按子会话 id 键，`agent/disposed` 清理）；不存在「后续请求重评估」的路径，也不需要 once-marker。

### roleAutoMatch 已删除（legacy 键检测）

`roleAutoMatch` 随自动匹配段一起从 schema 与类型移除；旧配置里的该键由 `detectLegacyKeys` 识别、经 gateway `legacyKeys` 进 client 迁移横幅（三通道细节 → `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md` §Legacy configuration），插件绝不自动改写配置。

留下的键设计教训仍然成立：新增键按 **optional-on-type** 加入（必填会破坏库消费者构造 FallbacksConfig 字面量）、默认值同时落在 schema 默认与 `defaultFallbacksConfig`（`Config({})` 与默认配置相等），并在退役时把键名补进 `detectLegacyKeys`。

### AC-7 教训：client 的 hidden-when-absent 开关不可交付（absent ≡ default）

宿主 settings 组合（Config(config) 经 schemastery）**恒折叠 schema 默认**：声明了 default 的键在组合/解析结果中总是存在。wire 上「键缺失」与「键=默认值」不可区分（absent ≡ default）——client 端「键缺失时隐藏开关」的语义**无法成立**：读到的配置里键恒在（被折叠为默认），不存在可依赖的 absent 态；save 是 merge，首次保存即持久化默认值（≡ schema 默认，无行为差）。诚实修法（Option A）= **恒渲染 + 文档**：开关常显（默认态 = schema 默认），legacy/pre-Plan-A 配置首次保存后键持久化为默认值；客户端不做 accept() key-strip / hidden-when-absent 死逻辑。设计含义：客户端 UI 的显隐决策以**值语义**（读到什么默认就是什么真值）而非**存在性语义**（键是否在 wire 上）驱动。该教训的原始实例（roleAutoMatch 开关）已随该键退役，但宿主折叠行为不变——任何带 schema 默认的布尔/枚举键都适用。

### 失败期角色保持（I-000078 的教训；rc.1 后是结构性属性）

历史症状（2026-10-25，I-000078）：注入只发生在首请求，失败决策 `decide()` 原先仅用 `resolveRole(...)`（规则阶段）重新解析角色——`roles.rules` 为空时恒得 `inherit` → `buildRoleEntries` 直接返回裸 `rootChain`。实测症状：`frontend-dev`（`fallback: none`）链头经 host allowlist 过滤后注入 `ollama-cloud/...`，429 用尽后下一个请求跳到 `rootChain[0]`（该模型根本不在角色链里），再才到角色链第 3 项。当时的修法是 per-agent `dispatchRoles` 记忆体 + `rememberedRole(agent.id) ?? resolveRole(...)`。

rc.1 让那套记忆体不再必要：角色只在创建时解析一次，存进按子会话 id 键的记录；walk 每次决策读 `seamRecord(sessionId).role` 再走三级排序——**没有「失败路径重新解析角色」这第二次机会**，也就没有逃逸路径。`dispatchRoles` / `rememberedRole` / once-marker 一并删除。

仍然成立的三条教训：

1. **记忆体必须带失效校验，不能只靠清除时机**：seam 记录里的角色每次决策都过 live `roleIds`（trim 后查找声明 id），角色被删/改名即当作「无角色」回落规则阶段——与 dispatch 阶段「已删除角色 = 无角色」的语义一致；未声明的 id 直接进链解析会 warn 并退化为裸 `rootChain`（`src/chains.ts` 的 unknown-role 分支）。
2. **跨请求状态要问「谁清、清多宽」**：旧实现在 `settings/document-updated` 上 `dispatchRoles.clear()`，会让**任何**无关配置写入（rootChain / 分时行 / 开关）把在线子代理永久打回裸 `rootChain`。今天的跨调用状态只剩 cooldown/recovery store 与子记录：清理点是 `agent/disposed` + 插件 dispose（外加续跑子代理的 session-stable 标记），配置写入不清任何东西。改这些清理点前先问「会不会把健康状态一起清掉」。
3. **证明「不逃逸」的测试要能区分**：初版测试只走到角色链第二项就结束，即使 `rootChain` 被错误追加到 `fallback: none` 链尾也照样绿；需要「末项失败 → 决策不落到 rootChain」与「无关写入后仍走角色链（把 clear 加回去必须失败）」两类断言。当守卫的唯一可观测差异是日志（warn 存在与否）时，absence 断言必须配阳性对照（`logs.length > 0`），否则 capture 失效会静默空过。

残余变体（I-000079）的形态在 rc.1 不再成立：`policy.state === 'unprovable'` 与「子代理自带 authorized 路由」两种情形是**不挂载**（子代理留在真实模型上，只由 llm-retry 恢复），因此不存在「早退分支漏写记忆 → 失败后落到 rootChain」的路径。

## Why This Matters

- 角色解析的确定性规则匹配是既有契约；显式与 dispatch 声明两段只认**已声明** id，未命中 / 歧义 / 已删除 → 静默落入下一级或 `inherit`——可解释、可回归（单测钉住各级）。
- 挂载与失败决策严格分离：创建时只盖路由并记录，绝不污染冷却/记账，也绝不被误认为「已切换模型」。
- mount-only seam 全部闭合：agentPreset 载体、Assignment header 解析（`**Execute as**: <id>`）、`subagents` 服务的 `internal/get` 包装 + `agentOptions` 注入、persona 走 `agent/created` 的子作用域 section——零 dsh 改动。
- wire 折叠默认（absent ≡ default）是客户端插件共性问题：把 UI 语义建在「键是否存在」上必然落空，建在值上才诚实。
- 「分发时解析的角色」必须在失败路径上保持：rc.1 用「只解析一次、记录随子会话走」把它变成结构性属性——否则 `fallback: none` 角色的链约束在链头失败瞬间失效，降级范围被静默放大到完整 rootChain。

## When to Apply

- 为 dsh 插件实现 subagent 分发时的角色解析与虚拟链挂载（先确认既有确定性解析，再用创建时注入面）。
- 需要理解三段式解析的阶段边界与安全约束（纯同步、subagent-only、歧义即无角色、已删除角色静默跳过）。
- 设计依赖配置键存在性的客户端开关/显隐 UI 时——先确认宿主组合是否折叠默认（是 → 恒渲染 + 文档）。
- 扩展 fallbacks/switch 事件的 reason 词汇（vocabulary-only：仅供 legacy 读侧渲染，未知 reason 客户端原样渲染）。

## Examples

三段式解析签名（src/role-resolution.ts）：

```ts
resolveDeclaredRole(agent, rules, roleIds, {
  dispatchRole?: string,                               // seam 解析的 **Execute as**: <id>
  servedRoute?: { provider: string; model: string },   // 虚拟行的实际路由（规则匹配用）
  warn: (message: string) => void,                     // 未知规则目标 → warn 一次
}) => string                                           // 恒为 declared RAW id 或 'inherit'
```

创建时挂载判定（src/subagents-seam.ts injectRoute，LOCAL backend + 已解析角色为前提）：

```ts
// 显式路由 = 授权：model-authored / parent-stamped 的 pair 原样通过
if (typeof agentOptions?.provider === 'string' || typeof agentOptions?.model === 'string') return undefined
if (!isFallbackActive(config)) return undefined
if (firstDispatchableExactHead(roleChainEntries(config.roles.list, config.rootChain, role)) === undefined) return undefined
if (options.policyFor?.(agentId)?.state === 'unprovable') return undefined   // fail-closed
return { request: { ...spec.request,
  agentOptions: { ...agentOptions, provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL } } }
// 记录携带 virtualRouteInjected；链头标签 injected / authorized
```

客户端开关的正确形态（AC-7 Option A：恒渲染，不依赖键是否存在；`<key>` 为任一带 schema 默认的开关）：

```tsx
<Switch checked={draft.<key> ?? <schemaDefault>} onChange={...} />
```

*Source: iteration iter-20260817-fallbacks-role-automatch `.mstar/iterations/iter-20260817-fallbacks-role-automatch/guides/role-resolution-dispatch-seams.md`
（方向 2 确认结论 + 三段式 seam 调研）+ 主 plan `.mstar/plans/fallbacks-role-automatch.md` / `.mstar/plans/fallbacks-settings-visibility.md`
（AC-7 重定界 Option A），2026-08-17 compound 提升；「失败期角色保持」一节来自 PR #169 / issue I-000078（2026-10-25，计划 `.mstar/plans/20261025-subagent-fallback-role.md`）。
**2026-11-06 刷新（plan dsh-022-rc1-upgrade，方向 C）**：LLM 自动匹配段与 `roleAutoMatch` 键删除、`agent/request` 注入改为 dispatch seam 的 creation-time `agentOptions` 挂载、per-agent 角色记忆体删除——旧的「request-error 决策 / request 覆写」两级机制仅存于本文历史叙述与 I-000078 症状记录。*

**失败期角色保持**（I-000078 / PR #169）：角色解析基础（resolveRole / 两块制配置模型）→ `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md`；
插件创作上下文（wire 折叠陷阱亦见）→ `.mstar/knowledge/best-practices/dsh-cordis-plugin-authoring.md`。*
