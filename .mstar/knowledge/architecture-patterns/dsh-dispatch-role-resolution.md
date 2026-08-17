---
module: dsh-llm-fallbacks dispatch-time role resolution
date: 2026-08-17
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: fallbacks-role-automatch
applies_when:
  - 在 dsh 中为 subagent 分发时解析角色并注入角色链模型
  - 需要理解三段式解析（显式 agentPreset → 规则 → LLM 自动匹配）的 mount-only seam 与安全边界
  - 设计插件客户端「依据配置键存在性显隐 UI」的开关类控件
  - 评估插件在 agent/request 决策点的只读/注入式干预边界
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

# dsh 分发时角色解析：三段式 + LLM 自动匹配（mount-only seam 模式）

subagent 分发时（首请求）的三段式角色解析（显式 → 规则 → LLM 自动匹配）与角色链模型注入的已验证模式（iter-20260817-fallbacks-role-automatch 落地）：每一级都走 mount-only seam，注入是「非失败决策」的只读式干预，自动匹配有界安全，失败路径状态逐字节不变。

## Context

用户方向：subagent 被分发时角色不能靠碰运气——显式指定角色要生效，无规则命中时让模型自选最贴合角色。源码核实（2026-08-17）的确认结论：既有角色解析是**确定性规则匹配**（src/roles.ts resolveRole：origin/provider/model 按列出顺序首中 → 声明角色 id；未命中 → 内置 inherit → rootChain），**不存在**「把角色清单交给模型自选」的机制；AgentOptions 表面仅 provider/model/maxTokens，persona 在决策点不可读（作用域 system-prompt section，见 `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/role-and-model-selection-exploration.md` Role 节）。本模式回答：在纯挂载（零 dsh 改动）约束下，把分发时角色解析扩展为三段式，并在首请求注入角色链模型，同时不触碰失败路径。

## Guidance

### 三段式解析（只增不改既有路径）

分发时角色解析 = 显式 → 规则 → LLM 自动匹配 三级，前两级复用/兼容既有行为，第三级是新增兜底：

1. **显式角色**：dispatch 显式命名角色 → 直接走该角色。mount-only 载体 = 子会话 header 的 agentPreset 字段（child meta 折叠进 SessionHeader），与已声明角色 id 精确匹配（trim 后相等；无 substring/前缀猜测）→ 该角色 declared RAW id。agentPreset 为 inherit 或未声明值 → 落入下一级；inherit 永不是可派发的显式角色。
2. **规则匹配**：无显式角色 → 既有 resolveRole 原样（声明角色胜；inherit 落入下一级）。
3. **LLM 自动匹配**：规则未命中且 roleAutoMatch === true → 把已声明角色 taxonomy（id + persona）交给模型自选，要求恰好返回一个声明 id 或字面 none。命中 → 该角色链驱动模型；none / 无合法 id / 超时 / 任何异常 / 未启用 → inherit（rootChain），行为与现状完全一致。

实现形态：src/role-resolution.ts 的 resolveRoleAtDispatch 是**纯排序逻辑**（无 config 对象、无 LLM）——只编排显式/规则/自动匹配钩子并防御（钩子返回值过 roleIds 校验，未知 id → warn + inherit）；LLM 调用在 src/automatch.ts 的 pickRoleByLlm，经 ctx.get('llm')（可选 cordis Service，absent → null 快速路径；插件自身不监听 llm/stream，故自动匹配调用不会递归进自身）。

### 自动匹配的有界安全（硬约束）

- 一次决策至多一次调用；小 maxTokens 限输出；5s 默认超时放弃 stream（无悬挂流）；任何失败 → inherit。
- 空 taxonomy → 不调用 LLM 直接 inherit；ctx.llm 缺失 → 静默跳过；绝不在 agent/request 路径抛错。
- roleAutoMatch: false 必须逐字节复现今日行为。

### 分发时链头注入（复用 overrideConfig，但语义不同）

- 注入目标 = 解析角色拼接链（角色 chain + inherit-root 兜底）的**首个 exact 候选**：无 cooldown/failed 过滤（冷却与 step-failed 是 per-agent 失败域状态，fresh subagent 首请求无状态条目，过滤分支空洞；把失败历史带进新 agent 语义错误）；无 catalog 存在性探针（exact 头本就不受既有探针约束，且保持首请求热路径无目录抓取）；provider/* 通配**不是**注入目标（无失败模型可锚定，猜测注入可能以 triggerCodes 外的码硬失败、绕过 fallback）。无 exact 候选 → 不注入（今日行为）。
- 注入条件 = 链头模型 ≠ 请求当前模型（same-as-current 是注入守卫，不是链头过滤器）。
- 复用既有 overrideConfig(seed, to) 机制在 agent/request 应用；web model-selection listener 顺序的 documented degradation 原样适用（listener 在外时用户显式选择会覆写当步路由）。

### 注入不是失败决策（no-commit 语义）

分发时注入**不写** pending switch / cooldown / step-failed 记账（绝不 commit()），只 override 请求配置 + append fallbacks/switch 事件（reason: role-inject，from/to/role 齐全）+ 显式 role → model 日志行。失败路径状态逐字节不变。范围：仅 subagent origin（session.header.origin === 'subagent'）；root 代理不触碰。注入幂等：仅首请求（per-agent once-marker，agent/disposed 清理；后续请求永不重评估）；仅在 applied === undefined 分支评估，失败路径 pending switch 恒胜。

### roleAutoMatch 配置键（optional-on-type）

新键 roleAutoMatch: boolean 默认 true——optional-on-type（镜像 presets additive 先例：必填会破坏库消费者构造 FallbacksConfig 字面量），schema z.boolean().default(true)，defaultFallbacksConfig 携带 true（Config({}) === defaultFallbacksConfig），运行读取 config.roleAutoMatch ?? true，detectLegacyKeys 不标记（新键，非两块制遗留）。

### AC-7 教训：client 的 hidden-when-absent 开关不可交付（absent ≡ default）

宿主 settings 组合（Config(config) 经 schemastery）**恒折叠 schema 默认**：声明了 default 的键在组合/解析结果中总是存在。wire 上「键缺失」与「键=默认值」不可区分（absent ≡ default）——client 端「键缺失时隐藏开关」的语义**无法成立**：读到的配置里键恒在（被折叠为默认），不存在可依赖的 absent 态；save 是 merge，首次保存即持久化默认值（≡ schema 默认，无行为差）。诚实修法（Option A）= **恒渲染 + 文档**：开关常显（默认态 = schema 默认），legacy/pre-Plan-A 配置首次保存后键持久化为默认值；客户端不做 accept() key-strip / hidden-when-absent 死逻辑。设计含义：客户端 UI 的显隐决策以**值语义**（读到什么默认就是什么真值）而非**存在性语义**（键是否在 wire 上）驱动。

## Why This Matters

- 角色解析的确定性规则匹配是既有契约；三段式扩展只在其上**追加**兜底段，roleAutoMatch: false / 无显式角色 / 无规则命中 → 行为与今日完全一致——可解释、可回归（单测钉住各级 + roleAutoMatch: false 逐字节回归）。
- 注入与失败决策严格分离（no-commit）是安全边界：分发注入绝不污染失败路径的冷却/记账，也绝不被误认为「已切换模型」。
- mount-only seam 全部闭合：agentPreset 载体、ctx.get('llm') 可选服务、overrideConfig 复用、role-inject additive reason——零 dsh 改动。
- wire 折叠默认（absent ≡ default）是客户端插件共性问题：把 UI 语义建在「键是否存在」上必然落空，建在值上才诚实。

## When to Apply

- 为 dsh 插件实现 subagent 分发时的角色/模型注入（先确认既有确定性解析，再追加自动匹配段）。
- 需要理解三段式解析的阶段边界与安全约束（有界调用、no-commit、subagent-only、首请求幂等）。
- 设计依赖配置键存在性的客户端开关/显隐 UI 时——先确认宿主组合是否折叠默认（是 → 恒渲染 + 文档）。
- 扩展 fallbacks/switch 事件的 reason 集合（additive reason，向后兼容；未知 reason 客户端原样渲染）。

## Examples

三段式解析签名（src/role-resolution.ts）：

```ts
resolveRoleAtDispatch(agent, rules, roleIds, {
  automatchEnabled: boolean,
  automatch?: (ctx) => Promise<string | null>,  // 钩子契约：declared RAW id 或 null
  warn,
}) => Promise<string>  // 恒为 declared id 或 'inherit'
```

注入条件（src/index.ts agent/request，applied === undefined 分支，subagent origin + 首请求）：

```ts
head = firstExactCandidate(chain)  // 无 cooldown/failed 过滤、无 catalog 探针
if (head !== currentModel) {
  overrideConfig(seed, head)       // 复用失败路径注入机制
  appendSwitch({ reason: 'role-inject', from: currentModel, to: head, role })  // 不 commit()
}
```

客户端开关的正确形态（AC-7 Option A，恒渲染不依赖键存在性）：

```tsx
<Switch checked={draft.roleAutoMatch ?? true} onChange={...} />
```

*Source: iteration iter-20260817-fallbacks-role-automatch `.mstar/iterations/iter-20260817-fallbacks-role-automatch/guides/role-resolution-dispatch-seams.md`
（方向 2 确认结论 + 三段式 seam 调研）+ 主 plan `.mstar/plans/fallbacks-role-automatch.md` / `.mstar/plans/fallbacks-settings-visibility.md`
（AC-7 重定界 Option A），2026-08-17 compound 提升。角色解析基础（resolveRole / 两块制配置模型）→ `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md`；
插件创作上下文（wire 折叠陷阱亦见）→ `.mstar/knowledge/best-practices/dsh-cordis-plugin-authoring.md`。*
