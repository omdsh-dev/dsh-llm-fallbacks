---
module: dsh-llm-fallbacks dispatch-time role resolution
date: 2026-08-17
last_updated: 2026-11-08
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: named-virtual-chains
applies_when:
  - 在 dsh 中为 subagent 分发时解析角色并把子代理指到一条命名虚拟链
  - 需要理解两段式解析（显式 agentPreset → dispatch 声明）与 mount-only seam 的安全边界
  - 给按子会话 id 键的 per-child 角色记录选失效边界（读侧校验 vs 清理时机）
  - 给跨调用状态（cooldown/recovery store、per-child 记录）设计失效边界（配置变更能否无差别清空）
  - 设计插件客户端「依据配置键存在性显隐 UI」的开关类控件
tags:
  - dsh
  - llm-fallbacks
  - role-resolution
  - dispatch
  - chain-pointer
  - agentpreset
  - mount-only
---

# dsh 分发时角色解析：两段式 + 命名链指针挂载（mount-only seam 模式）

subagent 分发时的两段式角色解析（显式 `agentPreset` → dispatch 声明）与命名虚拟链指针挂载的已验证模式：两级全部确定性、无模型参与；挂载发生在**创建时**（`SubagentStartRequest.agentOptions`），链本身由虚拟适配器的 `stream()` 内链走执行——解析、挂载、执行各占一个不同 seam，互不代偿。

## Context

用户方向：subagent 被分发时角色不能靠碰运气——显式指定角色要生效，未指定就是「插件不干预」。配置 v2（命名虚拟链）把角色收窄成**身份 + 一个手动链指针**：`roles.list[] = { id, persona, chain? }`，`chain` 是 `chains[].id` 的**指针**，缺席/为空 = 未指定。角色规则匹配（`roles.rules`）、角色内联链、`fallback` 拼接策略与宿主子代理策略门控都随之删除，所以解析只剩两段确定性排序。

`AgentOptions` 仍只有 provider/model/maxTokens；`SubagentStartRequest.persona` 早已删除——persona 由 `src/role-persona.ts` 在 `agent/created` 上以**子作用域 system-prompt section**（与全局 deployment persona 同名同序，故替换而非叠加）投递，所以「决策点读不到 persona」这一约束的解决方式是**投递面**，不是把 persona 塞回路由对象。

## Guidance

### 两段式解析（全部确定性，无 LLM）

分发时角色解析 = 显式 → dispatch 声明 两级，首中即停，返回值恒为「声明角色 RAW id」或 `undefined`（= NOT SPECIFIED）：

1. **显式角色**：mount-only 载体 = 子会话 header 的 `agentPreset` 字段（child meta 折叠进 SessionHeader），trim 后与已声明角色 id 精确匹配（无 substring/前缀猜测）→ 该角色 declared RAW id。`inherit` 或未声明值 → 落入下一级；`inherit` 永不是可派发的显式角色。
2. **dispatch 声明**：dispatch seam 从子请求 prompt 的 Assignment header 区解析 `**Execute as**: <id>`（`src/subagents-seam.ts` 的 `resolveDeclaredRoleFromAssignment`，唯一纯解析点）：只读 header 区（首个 Assignment body marker 之前；无 marker 时取首段 + 后续 header 型段落，正文段落一律排除，故正文里引用的同一行不可能塑造解析），区内不同声明 id 必须恰好收敛到一个——歧义、未声明、空、`inherit`、缺席一律等于「无角色」→ `undefined`。

实现形态：`src/role-resolution.ts` 的 `resolveDeclaredRole(agentPreset, roleIds, { dispatchRole })` 是**纯同步排序逻辑**（无 config 对象、无 IO、无 LLM）。dispatch 角色由 seam 解析后存进按子会话 id 键的记录；`/fallbacks` 诊断读同一条记录，因此不存在的记录 = 未指定（没有「事后推断角色」的路径）。

### 链指针挂载（SubagentStartRequest.agentOptions，creation-time）

- **挂载点** = 子代理创建请求的 `agentOptions`：seam 盖 `{ provider: 'FallbacksChain', model: <role.chain> }`，宿主在 `manager.startLocal` 创建子代理时把它 merge 到父路由之上——子代理因此被那条命名链服务。四条件：
  1. 已解析角色（上面两段之一）；
  2. 该角色的 `chain` 指针非空**且**命名一个已声明的 `chains[].id`（未声明指针 → 一条 debug 行 + 视为未指定）；
  3. 请求**没有**显式 `agentOptions.provider` / `.model`（显式即已授权，原样通过，插件绝不改写）；
  4. backend 是 LOCAL（`prepareContinuable` 探针）——外部（acp）backend 不产生本地 agent、进程外也解析不到虚拟 provider → 保持纯继承（无链）。
- **无宿主策略咨询**：挂载是用户静态配置的映射，不是插件替模型选路由——没有 allowlist 求交、没有 `unprovable` 分支、没有 `virtualRouteInjected` 标记、没有 blocked-attempt 记录。随之而来的既定退化：链内降级切换不做宿主 allowlist 过滤（链由操作者手写，每个条目都是显式选择）。
- **不做二重门**：seam 不检查链尾合规——声明了但链尾不合规的链照样盖章，由 walk 自己的门拒绝（唯一门在 walk）。
- creation-time only：rc.1 的 `startActivation` 拒绝已存在的 child id（`DUPLICATE_CHILD`），所以该路径永不附着既有子代理；续跑的持久选择恒胜，只重写角色记录、绝不重新盖章。
- containment：任何抛错（配置读失败）都退回「调用方原样 spec」+ 一条 debug 行——降级的分发，不是失败的分发。

### 挂载不是失败决策（creation-time 语义）

- 挂载只盖创建选项 + 写 per-child 记录（角色、persona 裁决）；**不**写失败记账——rc.1 删除了 pendingSwitch / stepFailures / appliedTurnStep，walk 自己的 per-call 状态随 walk 一起消亡（唯一跨调用记忆是 cooldown/recovery store，按 agent 键、跨链共享）。
- **不** append durable `fallbacks/switch` 事件（issue #52 stop-write 仍然有效）：切换走 info 日志，`role-inject` 只是遗留事件词汇表里的只读标签，没有写入点。
- 越权面为零：只有 LOCAL backend 且无显式路由的子代理会被盖章；root 代理不触碰，外部 backend 纯继承；续跑子代理因 creation-time only 免于覆写。

### 已删除的旧解析面（历史，无继任者）

- **LLM 自动匹配段**：宿主形态不成立——唯一的宿主点是已删除的 `agent/request` 注入（rc.1 拒绝改变捕获选择的请求，request-error 重试也沿用捕获选择）；在 walk 的 `stream()` 内跑一次补全 = 每次失败一次嵌套请求。`roleAutoMatch` 键由 `detectLegacyKeys` 报进迁移横幅，插件绝不自动改写配置。
- **规则匹配段**（`roles.rules`）：随 v2 整体删除——一个子代理挂哪条链由它的角色指针决定（或纯继承），不再有「按 provider/model 模式匹配角色」的间接层。该键同由 `detectLegacyKeys` 上报（`roles.rules`），只 warn 不自动改写。

留下的键设计教训仍然成立：新增键按 **optional-on-type** 加入（必填会破坏库消费者构造 `FallbacksConfig` 字面量）、默认值同时落在 schema 默认与 `defaultFallbacksConfig`（`Config({})` 与默认配置相等），并在退役时把键名补进 `detectLegacyKeys`。

### AC-7 教训：client 的 hidden-when-absent 开关不可交付（absent ≡ default）

宿主 settings 组合（Config(config) 经 schemastery）**恒折叠 schema 默认**：声明了 default 的键在组合/解析结果中总是存在。wire 上「键缺失」与「键=默认值」不可区分（absent ≡ default）——client 端「键缺失时隐藏开关」的语义**无法成立**：读到的配置里键恒在（被折叠为默认），不存在可依赖的 absent 态；save 是 merge，首次保存即持久化默认值（≡ schema 默认，无行为差）。诚实修法（Option A）= **恒渲染 + 文档**：开关常显（默认态 = schema 默认），legacy/pre-Plan-A 配置首次保存后键持久化为默认值；客户端不做 accept() key-strip / hidden-when-absent 死逻辑。设计含义：客户端 UI 的显隐决策以**值语义**（读到什么默认就是什么真值）而非**存在性语义**（键是否在 wire 上）驱动。该教训的原始实例（roleAutoMatch 开关）已随该键退役，但宿主折叠行为不变——任何带 schema 默认的布尔/枚举键都适用。

### 跨请求状态与失效边界（I-000078 的教训）

历史症状（2026-10-25，I-000078）：注入只发生在首请求，失败决策原先仅用规则阶段重新解析角色——`roles.rules` 为空时恒得 `inherit` → 直接返回裸 `rootChain`。实测症状：`frontend-dev`（`fallback: none`）链头经 host allowlist 过滤后注入 `ollama-cloud/...`，429 用尽后下一个请求跳到 `rootChain[0]`（该模型根本不在角色链里），再才到角色链第 3 项。当时的修法是 per-agent `dispatchRoles` 记忆体 + `rememberedRole(agent.id) ?? resolveRole(...)`。

这两套机制（首请求注入、失败路径重新解析）在 v2 都不存在：角色只在创建时解析一次，链在创建时由指针固定，walk 只按 `options.model`（链 id）取链——**没有「失败路径重新解析」这第二次机会**，也就没有逃逸路径。仍然成立的三条教训：

1. **记忆体必须带失效校验，不能只靠清除时机**：seam 记录里的角色在被读取时对照 live `roleIds`（trim 后查找声明 id），角色被删/改名即当作「无角色」；诊断与 persona 投递都走同一个校验后的读法。
2. **跨请求状态要问「谁清、清多宽」**：旧实现在 `settings/document-updated` 上 `dispatchRoles.clear()`，会让**任何**无关配置写入把在线子代理永久打回默认。今天的跨调用状态只剩 cooldown/recovery store（按 agent 键）与 per-child 记录：清理点是 `agent/disposed` + 插件 dispose。改这些清理点前先问「会不会把健康状态一起清掉」。
3. **证明「不逃逸」的测试要能区分**：当守卫的唯一可观测差异是日志（warn 存在与否）时，absence 断言必须配阳性对照，否则 capture 失效会静默空过；盖章矩阵要为每个否定条件（未指定 / 未声明指针 / 显式路由 / 外部 backend / 续跑）各留一条断言。

## Why This Matters

- 两段解析只认**已声明** id，未命中 / 歧义 / 已删除 → 静默 `undefined`——可解释、可回归（单测钉住各级）。
- 挂载与失败决策严格分离：创建时只盖路由并记录，绝不污染冷却/记账，也绝不被误认为「已切换模型」。
- mount-only seam 全部闭合：agentPreset 载体、Assignment header 解析（`**Execute as**: <id>`）、`subagents` 服务的 `internal/get` 包装 + `agentOptions` 指针盖章、persona 走 `agent/created` 的子作用域 section——零 dsh 改动。
- wire 折叠默认（absent ≡ default）是客户端插件共性问题：把 UI 语义建在「键是否存在」上必然落空，建在值上才诚实。

## When to Apply

- 为 dsh 插件实现 subagent 分发时的角色解析与命名链指针挂载（先确认既有确定性解析，再用创建时注入面）。
- 需要理解两段解析的阶段边界与安全约束（纯同步、歧义即「无角色」、已删除角色静默跳过、未声明指针视为未指定）。
- 设计依赖配置键存在性的客户端开关/显隐 UI 时——先确认宿主组合是否折叠默认（是 → 恒渲染 + 文档）。
- 扩展 `fallbacks/switch` 事件的 reason 词汇（vocabulary-only：仅供 legacy 读侧渲染，未知 reason 客户端原样渲染）。

## Examples

两段式解析签名（`src/role-resolution.ts`）：

```ts
resolveDeclaredRole(
  agentPreset: string | undefined,
  roleIds: ReadonlyMap<string, string>,
  opts: { dispatchRole?: string },   // seam 解析的 **Execute as**: <id>
) => string | undefined              // 恒为 declared RAW id 或 undefined（未指定）
```

创建时指针盖章（`src/subagents-seam.ts` `injectRoleChain`，LOCAL backend + 已解析角色为前提）：

```ts
// 显式路由 = 授权：model-authored / parent-stamped 的 pair 原样通过
if (typeof agentOptions?.provider === 'string' || typeof agentOptions?.model === 'string') return undefined
if (!isFallbackActive(config)) return undefined
const chainId = config.roles.list.find(role => role.id === roleId)?.chain
if (chainId === undefined || chainId === '') return undefined           // 未指定
if (!config.chains.some(chain => chain.id === chainId)) return undefined // 未声明指针 → 未指定
return { request: { ...spec.request,
  agentOptions: { ...agentOptions, provider: FALLBACKS_PROVIDER, model: chainId } } }
```

客户端开关的正确形态（AC-7 Option A：恒渲染，不依赖键是否存在；`<key>` 为任一带 schema 默认的开关）：

```tsx
<Switch checked={draft.<key> ?? <schemaDefault>} onChange={...} />
```

*Source: iteration iter-20260817-fallbacks-role-automatch `.mstar/iterations/iter-20260817-fallbacks-role-automatch/guides/role-resolution-dispatch-seams.md`
（方向 2 确认结论 + seam 调研）+ 主 plan `.mstar/plans/fallbacks-role-automatch.md` / `.mstar/plans/fallbacks-settings-visibility.md`
（AC-7 重定界 Option A），2026-08-17 compound 提升；「跨请求状态」一节来自 PR #169 / issue I-000078（2026-10-25，计划 `.mstar/plans/20261025-subagent-fallback-role.md`）。
**2026-11-08 刷新（plan named-virtual-chains）**：规则匹配段与角色内联链删除、`Auto` 虚拟行改为 `FallbacksChain/<chain id>` 的命名链指针、宿主策略门控（allowlist / `unprovable` / `virtualRouteInjected`）整体删除——本文只保留两段解析与指针挂载的现行形态，v1 的三段解析仅存于上面的历史小节。*

**失败期角色保持**（I-000078 / PR #169）：链配置模型（命名链 + 角色指针 + 逐链分时）→ `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md`；
插件创作上下文（wire 折叠陷阱亦见）→ `.mstar/knowledge/best-practices/dsh-cordis-plugin-authoring.md`。
