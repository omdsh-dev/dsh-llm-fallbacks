---
module: dsh-llm-fallbacks
date: 2026-08-11
last_updated: 2026-08-13
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: llm-fallbacks-settings-runtime
applies_when:
  - 在 dsh 中实现模型/请求级自动恢复或路由切换功能
  - 需要理解 omp llm-fallbacks 语义如何落到 dsh 事件面
  - 需要扩展或维护 dsh-llm-fallbacks 插件
  - 插件需要把自有配置暴露给 web 设置客户端（自有 gateway 通道 /api/fallbacks/get|set|reset）
  - 需要与 dsh 的 model-selection（installModelSelection）协调路由
  - 需要理解两块制配置模型（rootChain / roles.list / roles.rules / inherit）或迁移旧 chains / roles.default 配置
tags:
  - dsh
  - llm-fallbacks
  - agent
  - fallback-chains
  - request-error
  - settings-exposure
  - model-selection
  - mount-only
---

# dsh LLM fallback 架构：双 waterfall 恢复模式 + 设置面/路由协调

将 omp 的 retry.modelFallback / retry.fallbackChains 语义移植到 dsh 时的已验证架构（iter-20260810-llm-fallbacks 产物，随实现验证），以及后续迭代验证的设置页暴露、model-selection 协调、目录驱动选择与状态块真实化（iter-20260810-fallbacks-settings-ux / iter-20260810-fallbacks-settings-gateway）与纯挂载化（iter-20260811-fallbacks-mount-only：role rules-only、marker 移除、patch/autopatch 体系删除——本文件 2026-08-12 由 patch 时代刷新为 mount-only 现实），以及配置模型「两块制」重构（iter-20260813-fallbacks-role-model：rootChain + 声明式角色实体 + rules enum 引用 + inherit-root 继承 + legacy 三通道——本文件 2026-08-13 由链键 specificity / roles.default 时代刷新为两块制现实）。

## Context

dsh 的 agent loop 在模型请求失败时派发 agent/request-error waterfall；llm-retry 插件（dsh-base 内置）按 provider 的 retryPolicy 做同模型退避重试，预算耗尽或不可重试码（AUTH/QUOTA）时 next() 委托下游；mode:'always' 时 llm-retry 先委托下游再退避。模型选择经 agent/request waterfall 返回的 LlmCallConfig 决定（seed → waterfall → prepareCall）。失败码 taxonomy：AUTH(401/403)、QUOTA（QUOTA_EXCEEDED_CODE）、RATE_LIMIT(429)、CONTEXT_WINDOW_EXCEEDED 等。

## Guidance

### 核心模式：决策在 request-error、应用在 request（ADR-1/ADR-4）

1. agent/request-error 监听（注册在 llm-retry 之后）：未启用 / code 不在 triggerCodes → next()（always 模式同样透传）；命中候选 → 写每-agent pendingSwitch + cooldown 抑制 + stepFailures 记账 + append fallbacks/switch 事件 → 返回 {kind:'retry'}（拥有恢复，不调 next）。无候选 / 安全阀超限 → next()（原错误语义不变）。
2. agent/request 监听：await next() 后应用 pendingSwitch（provider/model 覆写、丢弃继承的 reasoningEffort——installModelSelection 的 withoutInheritedEffort 模式）并清除；appliedTurnStep 防重放。
3. 候选过滤：当前模型 / 冷却中 / 本步已失败 / provider/* 条目目标 provider 无此模型 id（存在性探针，仅 wildcard 条目受探针约束；exact 条目永不探针过滤）。

### 配置模型与链解析（两块制，iter-20260813-fallbacks-role-model 起）

**两块制配置模型**（用户只需记住两块，spec §2）：块 1 = `rootChain`（root 主代理的一条链，空 = root 不降级）；块 2 = 声明式角色实体 `roles.list`（id/label/description/prompt?/permissions?/chain?/fallback）+ `roles.rules`（origin/provider/model → 声明 id 或内置 `'inherit'` 的 enum 引用）。`prompt`/`permissions` 为 schema 预留（next iteration fallbacks-explicit-role-tool），本轮无消费者，YAML 写入不改变降级行为。D3：不引入 `system` 保留字——运行时「系统配置模型」= current，恒被 same-as-current 过滤，UI/文档展示「默认：当前系统模型」。

**角色解析**（root 与 subagent 同构，spec §7.1）：`resolveRole` 顺序匹配 `roles.rules`（origin 读 `session.header.origin`，缺省 `'root'`；provider/model 读 `AgentOptions`——显式 `agent.options.role` 只存在于已删除的 dsh patch，mount-only 下不可读；字段省略即不约束，首个命中即停）→ 返回声明 id；命中规则但 `rule.role` ∉ 声明集 ∪ `{'inherit'}` → warn + 回退 `'inherit'`（防御，启动校验已告警）；未命中 → 内置 `'inherit'`。id 按 trim 规范化（qc2 F-001：padded YAML id + trimmed 规则引用解析到同一角色，不静默降级）。subagent persona 在决策点不可读（`AgentOptions` 仅 provider/model/maxTokens），persona→role 映射未实现——详见探索 guide（`.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/role-and-model-selection-exploration.md`，Role 节）。

**链解析 = append-not-replace**（spec §7.2）：`candidates = [...(roleDef?.chain ?? []), ...(roleDef?.fallback === 'none' ? [] : rootChain)]`——角色自身条目在前、`rootChain` 兜底在后；`fallback: 'none'` 仅角色链（空角色链 + none → no-op 透传）；内置 `'inherit'` 与未知角色 id 均解析为 `rootChain`（前者静默——合法的未命中角色，非 typo；后者 warn 一次，防御不崩溃）。条目语义不变：`provider/model` exact、`provider/*` 保留失败模型 id 仅换 provider（目标 provider 无此 id 则跳过）。**链键 specificity（exact provider/model 键 → provider/* 键 → 角色链 → default 键）已删除（D1）**——命名空间只剩角色名；`roles.default` 已删除（D4），「所有子代理默认 X」改写为一条 `{origin: subagent, role: X}` 规则；**root 参与 rules**（D2，`origin: root` 可命中角色——删除链键后 root 需要 provider 特异链的唯一逃生口；默认不配则走 rootChain）。

**决策热路径（单遍历）**：`resolveRole` → `resolveChainViews` 一次遍历产出 `all` + wildcard 溯源（未知角色 warn **至多一次/决策**，此前 resolveChain 跑两遍 all+surviving）→ `hasWildcardEntry` 走与解析**同一拼接** `buildRoleEntries`（探针精确，`fallback:'none'` 正确排除 rootChain——qc1 S-3 单 SSOT / qc2 F-003）→ 仅 wildcard 条目可达时才构建 catalog 存在性探针（纯 exact 链零探针）→ `selectCandidates` 原位过滤（wildcard 条目受探针约束，exact 条目永不探针过滤；T2 review Important #1 决策路径契约）。防御性 warn 经注入的 `logger.warn`（qc2 F-002，非 console）。

### 旧配置迁移：三通道 + schemastery 未知键保留（iter-20260813-fallbacks-role-model）

**breaking（不自动迁移）**：`chains` / `roles.default` 从 schema 与类型零残留（docs 迁移表除外）。schemastery `Config()` 组合对未知键采用**保留策略（retain，实测 schemastery@3.18.0：顶层 / 嵌套对象 / 列表项均原值透传）**——旧键在组合对象上仍然可见，因此 legacy 检测直接读组合对象即准确（无需 raw 入参快照 fallback）。三通道提示，插件**绝不自动改写**配置：

1. **启动告警**：`apply()` 内 `detectLegacyKeys(source())` 非空 → `logger.warn('llm-fallbacks: legacy config keys detected …; see docs/configuration.md migration table')`（warn-only，不迁移）。
2. **gateway + UI 横幅**：`get()` 响应附 `legacyKeys: string[]`（`chains` / `roles.default` / `roles.rules[].role` 未声明值）；client 非空即渲染迁移横幅（zh/en，引用迁移表），表单保持可编辑、保存写出新格式（wire 字段权威，client 不自猜——W-1/F-1：save 是 merge，删不掉用户层旧键）。
3. **docs/configuration.md 迁移映射表**：逐旧键 → 新写法对照（如 `roles.default` → 删除 + 一条 `{origin: subagent, role: X}` 规则；角色链无兜底 → `fallback: inherit-root` 默认；角色 id = `inherit` → 禁止写入 list）。

wire 层需显式规范化：`validateConfigPatch` 按新键集 own-key membership 拒绝未知键（不受组合保留行为影响）。

### 校验（warn-not-crash，双面）

- **host `validateFallbacksConfig`**（纯函数，永不 throw / 不 mutate）：id 格式 `/^[a-z0-9-]{1,32}$/` + 唯一 + 保留字 `'inherit'` 禁入 `roles.list`、`roles.rules[].role` 引用 ∈ 声明集 ∪ `{'inherit'}`、`fallback` 枚举、`rootChain`/角色链 selector 合法（`parseSelector`）；`label`/`description` 自由文本不校验。每条违例一条 `llm-fallbacks:` warn，该配置「不生效」但整体仍可用（AC-4）。**启动时跑一次**（含 `detectLegacyKeys`）；live settings merge 由 settings 层 schema 校验兜底，运行时防御（resolveRole / resolveChainViews / roleDef 查找）warn-not-crash 容忍坏值（qc1 F-006，validation 不随 onChange 重跑）。
- **client `validateDraft`**：保存前校验（同规则 + selector 合法性），违例行内红框 + 错误横幅，**拦截 save**（不触碰 gateway `set` / store error 路径）；`label`/`description` 同样不校验。

### 冷却与安全阀

cooldownMs 内被切离/失败模型不入选；revertPolicy: 'cooldown-expiry' 到期回主、'never' 用 Infinity TTL 会话内不回。每 step 失败模型集合 + maxSwitchesPerStep 双重防护；链耗尽保持原 LlmError 语义。

### mode:'always' 的 cap（ADR-2）

llm-retry always 模式先 next() 委托下游——若在 request-error 直接切换会抢占退避。故 cap 在 agent/request 边界生效：按 (turn, step, provider) 计数已持久化 llm/retry 事件（只计 mode === 'always' 条目）≥ alwaysModeRetryCap 才切换。

### 状态机（每-agent）

Map<agent.id, AgentFallbackState>：pendingSwitch（产生→应用→清除；同 (turn,step) 链式切换靠 writePending 清 appliedTurnStep）、stepFailures（step 推进重置）、cooldown（跨 idle 保留——US-4 跨 turn 回主需要）、agent/disposed 清理、插件 dispose 整体清空（无残留）。

### model-selection 协调：标记载体已移除 → 文档化降级（iter-20260811-fallbacks-mount-only）

真实组合下 `installModelSelection`（web 前端门 per-agent 注册、先于插件）在 `agent/request` 的 `await next()` 之后重新套用会话选择，会把 fallback 切换覆写回去。patch 时代的解法是 `markFallbackRouted` 标记让位（spec §2.5 D-1：dsh-agent `model-selection.ts` 内模块级 WeakSet + 外层 listener 命中即跳过覆写）；该 patch 与整套 patch 交付体系已在 iter-20260811-fallbacks-mount-only 删除，插件切换**不再打标记**，协调退化为**文档化降级**（T2 结论，证明见探索 guide Model-selection 节）：

- **注册顺序决定当步路由**：插件 listener 在外（web profile 默认——插件随 bundle 加载先注册、model-selection 随 agent 创建后注册）→ 切换在当步生效；model-selection listener 在外（headless profile，或插件注册前已创建的 agent）→ 用户选择在当步重新套用、覆写切换（clobber）。
- **决策与记录不受影响**：request-error 决策链、`fallbacks/switch` 事件、冷却、安全阀、always-cap 逻辑全部照旧；被覆写的是当步「实际路由」，不是切换决策。
- **诚实呈现**：设置页一行降级说明（`status.selectionNote`，zh/en）；`tests/plugin.spec.ts` 组合测试钉住四种注册序 × 有无活跃 selection。
- **未来 seam（未实现）**：若 dsh 未来在 `LlmCallConfig` 上暴露首类「coordinator-owned routing」位，标记让位可无 patch 恢复。

### 设置命名空间 web 暴露：插件自有 gateway 通道（iter-20260810-fallbacks-settings-gateway 起）

dsh 的 web 设置 RPC（`dsh-host-apiproxy`）对命名空间有硬编码暴露白名单，插件命名空间默认不可经 wire 读写——早期 patch 方案（`exposeToWebClients` opt-in + apiproxy `exposedNamespaces()` 并集，spec §2.5 D-2）已随 gateway 方案作废。当前形态是**插件自有 gateway 通道，零 host patch**（`src/gateway.ts`）：

- **端点**：`/api/fallbacks/get` + `/api/fallbacks/set` + `/api/fallbacks/reset`（typertGateway `@Remote` SRC 声明；网关 `/api` 拦截槽是 host 全局单点，插件不得再 `connection.rpc.intercept('/api')`）。
- **读取**：`get` 读 `FallbacksSettingsBridge` source——与运行时同一份 live 组合配置（schema 默认 → 插件行 base → settings user layer）。
- **写入**：`set` 先按 `Config` schema 校验 patch（未知键拒绝），再经 `ctx.settings.update` 写 user layer（进程内写不经过 wire 级 `exposedNamespaces()` 门）；`reset` 用 `ctx.settings.replace(ns, {})` 清 user layer（`set` 是 merge-only，无法表达「重置为组合默认」）。
- **可选降级**：settings 服务可选——无 settings 服务时 `get` 仍可用（bridge source 直读），`set`/`reset` 返回明确错误（KD-G5）。
- **冲突语义（KD-G3）**：gateway 通道是普通 RPC merge/replace、**无版本戳**——`expectedRevision`/`settings-conflict` 冲突 UX 随迁移删除，任何 `set`/`reset` 失败统一进既有错误横幅、表单保持可编辑供重试（旧冲突用例删除，新「set 拒绝 → 错误横幅」用例顶替）。
- **Draft 播种不变量**：表单 draft 恒从真实解析配置播种（`accept(config, writable)`）；`get` 失败时骨架可以默认值展示，但**不得**用默认值播种 draft——瞬态通道故障恢复后，draft 与真实种子 diff 会送出全默认 patch，抹掉真实配置。

通用模式（wire 契约、KD-G3/G5 语义、可选 settings 条件注入、写前未知键拒绝、无解析器原则、`present` 标志）→ `architecture-patterns/dsh-gateway-settings-channel.md`。

**入口面（2026-08-12 起）**：设置展示挂载在官方插件配置页（`settings.plugin.item` 卡，
替换旧 `settings.section` 独立导航，不并存）；另有三个互补表面——`/fallbacks` 会话内只读
诊断命令（条件注入 `commands` 服务；快照 `FallbacksCommandSnapshot {origin, role, chainRole, chain, inherit}`——链显示角色自身链优先、空则 `rootChain`（`fallback:'none'` 且空链 → 空），rootChain 兜底尾部标「（inherit-root）」）、General 页只读状态行（`settings.general.item`，
order 100）、会话转录切换行（`conversationEvents` + `conversation.chat.node`，纯渲染）。
卡 = 编辑入口、行 = 状态摘要、命令 = 会话内诊断、转录行 = 恢复可见性。挂载点全表 →
`architecture-patterns/dsh-mount-point-map.md`；会话转录模式 → `architecture-patterns/dsh-conversation-surface-mounting.md`。

### 目录驱动 provider/model 选择（iter-20260810-fallbacks-settings-ux，spec §2.5 D-3/D-4）

- **数据源**：`llm.providers({})`（可配置 provider 目录）+ `llm.models({})`（`{ groups, failures }` 模型目录）；`llm/adapters-updated` remote 事件刷新（20260811 起；旧 `models/changed` 客户端事件已移除）。
- **store catalog 快照**：独立 `loadCatalog()` + 独立 generation guard；`llm/adapters-updated` **只**刷 catalog、`connection/reset` 全刷；failures 降级诊断不拖垮 groups；catalog 失败不阻塞表单（settings 状态零触碰）。
- **混合下拉**：provider select + model select 级联 + `provider/*` 通配（不依赖 models）+ 目录外合成选项（原值 + 「（目录外）」标注，value 携带原始字符串、读回默认选中）——**目录外值 round-trip 无损**，仅新增条目受限目录；行编辑态判别联合 `{kind:'catalog',id}|{kind:'outside',raw}|null`；序列化仍写原始字符串（`provider/model`、`provider/*` 条目语义不变；无链键——`rootChain` 行与角色链行的有序选择器列表即链本身）。

### 设置页只读状态块真实化（R1 关闭，spec §2.5 D-5/D-6）

- **读取面**：`connection.api.sessions.history({ sessionId, maxMessages })` 原始事件面（`HistoryEntry.event` 含 `fallbacks/switch`）——**不用** `ctx.sessionHistory`（公开快照只含投影会话对话，无原始自定义事件）；当前会话 `ctx.sessions.list` current（注意 host/client Context merge 冲突——`ctx.get('sessions') as unknown as ISessions`，且 client fiber 的 `sessions` 注入应可选降级）；单页 50、seq 倒序取 N=5、会话切换重载、错误隔离不碰 settings 状态。
- **展示值推导**（非实时路由探测，恒附注）：未启用 / `rootChain` 未配置 → 空态；有最近切换 → 最新 `to`；无切换 → `rootChain` 首项（无角色链语境时，spec §7.4）。

### 纯挂载交付纪律（iter-20260811-fallbacks-mount-only，原 patch 交付纪律已删除）

插件安装对 dsh 源树**零 diff**——patch 文件、apply/revert/verify 脚本、autopatch 安装期调用、ambient shim（`src/dsh-patch-ambient.d.ts`）全部删除：

- **安装 = bundle 插行 + client inject + 自有 gateway**：`bundle/cordis.patch.yml` 在 profile bundle 栈上插插件行，`dsh.client.inject` 挂载 web 设置页，设置读写经 `/api/fallbacks/get|set|reset`。
- **无 patch、无 autopatch 步骤**：一行 git 安装即用（pnpm ≥ 10 需 approve-builds 放行 `prepare` 自构建）；`prepare` = setup-dsh-links + build，无 postinstall。
- **dsh 升级无需重打**：升级重置源树不影响本插件。
- **残留旧 patch 无害**：插件不依赖任何 patch 导出（role rules-only；marker 已移除），已打 patch 的旧 dsh 树可留可 revert，均非必需。

### 已知限制（open residual）

- 失败码默认 ['AUTH','QUOTA','RATE_LIMIT']；5xx/TRANSPORT 等由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策，无需额外配置。

## Why This Matters

恢复语义归属（request-error 拥有恢复 vs request 路由覆写）分离使插件完全自包含、零侵入 dsh 核心；llm-retry 共存顺序与 always-cap 边界是移植中最易出错的两处，均有测试固化（双插件共存矩阵、mutation-red 验证）。两条 dsh 集成 seam 在纯挂载形态下闭合：设置暴露 = 插件自有 gateway 通道（无 host patch），model-selection 协调 = 文档化降级（注册顺序决定当步路由，marker 移除后无静默失效面——组合测试 + `status.selectionNote` 钉住语义）。

## When to Apply

- dsh 内任何「失败后换模型/换路由继续」类功能（retry、fallback、模型降级、按负载分流）。
- 需要理解 fallbacks/switch 事件、fallbacks settings 命名空间或 selector 语法时。
- 插件需要 web 设置读写（自有 gateway 通道）或与 model-selection 协调路由时。
- 需要理解两块制配置模型（rootChain / 声明式角色 / rules 引用 / inherit 继承语义）或迁移旧 chains / roles.default 配置时。
- 需要理解本插件纯挂载安装语义（零 dsh 源树 diff、无 patch/autopatch、升级免重打）时。

## Examples

- 链配置示例见本插件 docs/configuration.md（仓库内）。
- 集成测试矩阵：tests/coexist-llm-retry.spec.ts、tests/always-mode.spec.ts、tests/plugin.spec.ts（含组合顺序）、tests/host-native.spec.ts（宿主原生基线，原 unpatched-host.spec.ts 更名重写）、tests/roles.spec.ts（rules-only 解析）、tests/runtime.spec.ts（新链语义）。
- 两块制配置/校验/迁移：tests/config.spec.ts（schema + id/引用/枚举校验、「composed role entities」钉住空值填充与 no-op 默认）、tests/gateway.spec.ts（新键集 + `legacyKeys` wire 行为）、tests/fallbacks-card.spec.tsx（新编辑面 + 校验拦截 + legacy 横幅）、tests/command.spec.ts（诊断新语义——inherit 标注、`hasModelSpecificChainKeys` 删除）。
- 设置页/目录/状态块：tests/fallbacks-store.spec.ts（61 用例）。
- 真实宿主端到端剧本：docs/verification.md §4（QA gate）。

*Source: iteration iter-20260810-llm-fallbacks（specs/llm-fallbacks-spec.md）+ iter-20260810-fallbacks-settings-ux（specs/fallbacks-settings-runtime-spec.md，D-1..D-6 提升）+ iter-20260810-fallbacks-settings-gateway + iter-20260811-fallbacks-mount-only（Plan B：role rules-only、marker 移除、patch 体系删除）+ iter-20260813-fallbacks-role-model（specs/fallbacks-role-model-spec.md：两块制配置模型、D1–D4、inherit 语义、legacy 三通道），随实现验证。2026-08-12 刷新：由 patch 时代更新为纯挂载现实。2026-08-13 刷新：由链键 specificity / roles.default 时代更新为两块制现实。*
