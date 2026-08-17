# CONCEPTS

本仓库（dsh-llm-fallbacks）领域词汇。供 `{KNOWLEDGE_DIR}` 与 AGENTS.md 引用，避免重复定义。

## dsh 插件

### dsh bundle
一个声明 `dsh.bundle.patch` 的 npm 包：以 `cordis.patch.yml` 组合层向 profile 插入插件行。后装入的 bundle 行插在内置行（如 llm-retry）之后——waterfall 监听注册顺序依赖此。
*Avoid:* plugin row / patch layer（口语混用时可接受，正式文档用 bundle）

### dsh settings slot
dsh web settings 的条目挂载契约（权威：dsh-private `packages/client/ui-settings/src/client/contract/slots.ts`）：`settings.plugin.item`（官方**插件配置页**卡，list kind——卡自绘折叠列表项，**卡形态替换 section 导航**的单入口）、`settings.section`（整页设置，list kind，按 order 排序）、`settings.general.item`（General 页内单行）、`settings.action`（头部操作）、`settings.onboarding`（root 步骤）；`trigger`/`header`/`close` 是 single seat（chrome 文案位）。list 槽同 order 按注册先后稳定排序（order tie 可预期）。shell 零自有内容——**新增设置不改 shell**；唯一宿主侧触发点是 `SettingsRoot.tsx` `navIcon(id)`（仅 models/agent-presets 有专属图标，新 id 落齿轮）。挂载统一 `ctx.slots.inject`（非裸 register）。*Avoid:* 把「新设置要改 shell」当默认假设。

### gateway channel（插件 gateway 通道）
插件自有配置读写通道：宿主半声明 `GatewayService`（`TypertRemoteService` 基类，仅取其 `typertRemote` 绑定）+ **显式 `ctx.typert.register(contribution)`** 注册 `/api/<ns>/get|set|reset`（2026-08-13 起替代 `@Remote` SRC 标记——SRC 发现读 `remoteMethods()` 的模块私有 WeakMap，link 插件与 dlx 宿主物理分离永不可共享；显式注册写入 `ctx.typert.local`，claims 先查它），client 半 `connection.rpc.call('/api', '<ns>/<method>', { args })` 读写。与 `settings slot` 正交——slot 决定页面出现，gateway 决定配置数据从哪来。apiproxy wire 的 `exposedNamespaces()` 白名单对插件命名空间关闭，gateway 是 mount-only 下 web 配置读写的唯一路径；通道无版本戳（无 revision 守卫，失败走错误横幅）。*Avoid:* 把插件配置经 `settings.describe/update/replace` 读写（patch 时代路径，已删除）

### mount-only（纯挂载）
本插件交付约束：对 dsh 源码树**零本地修改**。安装 = bundle 插行 + client inject + 自有 gateway；无 `patches/`、无 autopatch/prepare 打补丁链路；升级 dsh 无需重打。*Avoid:* patch 交付 / 本地修改交付

### registry peers（开发期依赖解析）
dsh 私有 `@deepseek-ai/*` 包的开发期类型/测试解析方案：`pnpm-workspace.yaml` 的 `autoInstallPeers: true` + 用户级 `~/.npmrc` 的 registry 认证令牌（pnpm 11 起项目级 `.npmrc` 不再展开 `${NPM_TOKEN}`）从 npm registry 解析 `@deepseek-ai/*@0.1.0-rc.6` peer 依赖（`peerDependencies` 契约，无本地 link farm；pnpm 11 全量重解析后 lockfile 零 pre-rc.6 残留）。运行时值 import 保持 external 由宿主 in-box 解析，测试用真实 `dsh-settings`（内存 provider）与本地 node-safe store 双（`tests/support/snapshot-store.ts`，因 registry 包的 `./client` 是浏览器 loader artifact）。`*Avoid:* peer-stubs / tsconfig paths / 本地 link farm（历史方案，已移除）`

### remote events（转发事件）
host → client 的远程事件转发面：client 经 `ctx.remote.$on(key, listener)` 订阅，事件名受宿主转发白名单（`API_REMOTE_FORWARDED_EVENTS`）约束；与 client 本地事件（`ctx.on`）区分——本地事件在 client 进程内 emit，remote 事件由 host 侧转发帧推送。20260811 起 `settings/changed`、`models/changed` 客户端事件已移除，配置/目录变更通知迁移到 remote events：`settings/document-updated(ns, revision)`（订阅方按 ns 精确过滤）与 `llm/adapters-updated()`（payload-free）。*Avoid:* `settings/changed`、`models/changed`（20260811 已移除的死事件名）

## LLM fallbacks

### fallback 链（fallback chains）
agent 失败时的有序降级 selector 列表。两块制配置模型下链分两级：`rootChain`（root 主代理一条链）+ 声明式角色实体（`roles.list`）各自 `chain`；链拼接 **append-not-replace**：`[...role.chain, ...(fallback === 'none' ? [] : rootChain)]`（角色条目在前、rootChain 兜底在后）。条目 `provider/*` 表示保留失败模型 id 仅换 provider（目标 provider 无此 id 则跳过）。链键 specificity（exact `provider/model` 键 → 角色链 → default 键）已删除（D1）——命名空间只剩角色名。
*Avoid:* `chains` 键→链映射（旧字段，已删除）

### 两块制配置模型（two-block config model）
fallbacks 配置的自明结构：块 1 = `rootChain`（root 主代理一条链），块 2 = 声明式角色实体 `roles.list`（id/persona/chain/fallback）+ `roles.rules`（origin/provider/model → 角色 id 或 `inherit` 的引用）。心智模型只有两级：root 一条、角色各自一条（默认继承 root）。
*Avoid:* `chains` 键→链映射、`roles.default`（旧模型，已删除）

### inherit（内置角色 id）
保留字角色 id：合法作 `roles.rules[].role` 目标与「无规则命中」缺省，**禁止**写入 `roles.list[].id`。解析为 `rootChain`（静默——合法缺省角色，非 typo）。
*Avoid:* 把 inherit 当链拼接策略、或用作角色实体 id

### inherit-root（链拼接策略）
`roles.list` 实体上的 `fallback` 枚举值（默认）：角色自身 `chain` 走完后**追加** `rootChain`；`none` = 仅角色链（空链 + none → no-op 透传）。
*Avoid:* 与 `inherit`（角色 id）混用

### fallbacks/switch 事件
插件每次切换模型时追加的持久化会话事件（from/to/role/reason），是「行为可见」承诺的载体：无事件即无切换。reason 是开放字符串（未知值客户端原样渲染，向后兼容）；`role-inject` 是分发时角色注入的附加 reason 值（additive，非结构变更——见三段式分发角色解析）。

### triggerCodes
触发 fallback 决策的失败码集合，默认 `['AUTH', 'QUOTA', 'RATE_LIMIT']`（dsh 稳定失败码；注意是 `QUOTA` 不是 `QUOTA_EXCEEDED`）。重试型失败（5xx/TRANSPORT）由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策。

### documented degradation（文档化降级）
被接受的功能落差必须「非静默」呈现：替代方案有测试证明，**或**降级说明（设置页/文档）+ QA 实测证据闭环，二选一（PD-4 口径）。当前实例：model-selection 协调在 mount-only 下无可靠覆写 seam → 当步路由由监听注册顺序决定，设置页 `status.selectionNote`（zh/en）诚实标注、组合测试钉住语义。

## 会话转录（conversation surface）

### conversationEvents
client 会话转录的节点注册表（`ConversationNodeDefinition` 注册，kind 唯一）：引擎把每条摄入事件（surface 与否不限）投喂给每个定义的 `match`——决定「自定义会话事件是否被渲染为转录节点」。非 surface 插件事件（如 `fallbacks/switch`）默认转录不可见，注册定义是纯挂载下使其可见的唯一路径。

### conversation.chat.node
会话转录的 keyed 渲染座位：按节点 kind 派发渲染器（未注册 kind 落 JsonBlock 兜底，非 `unknown` 渲染器）。与 conversationEvents 配合 = 「注册表决定是否渲染，座位决定如何渲染」；外部插件渲染器纯渲染、type-only 引用 `ui-conversation`，业务数据经 `node` prop 传入。

### degrade-never-crash
会话转录节点生命周期的不变式：宿主引擎对节点 `match`/`start` **无 try/catch**——插件节点代码对畸形载荷必须降级（match no-op / start 返回确定降级态）而**绝不 throw**，单节点异常会炸掉整条转录装配而非「某一行不渲染」。*Avoid:* 在节点生命周期里抛错指望引擎兜底

## 已决歧义

- `inherit` vs `inherit-root` vs `roles.default`：`inherit` = 内置**角色 id**（规则目标 / 未命中缺省，禁入 `roles.list`）；`inherit-root` = 角色实体上的**链拼接策略**（默认：角色链后追加 rootChain）；`roles.default` = **已删除旧字段**，不再是有效配置。三个词不混用。
- `QUOTA_EXCEEDED`（常见命名）→ 本插件与 dsh taxonomy 用 `QUOTA`；文档中不要混用。
- `settings slot` vs `gateway channel`：前者是**展示挂载**（页面出现在 Settings），后者是**数据通道**（配置读写从哪来）；讨论设置页时两者分开表述，不要混用。
- `settings/changed` / `models/changed`（20260811 已移除的客户端事件名）→ 失效刷新一律表述为 remote events（`settings/document-updated` + `llm/adapters-updated`）；不要在代码、测试或文档中恢复旧名。
- `settings.section` vs `settings.plugin.item`：fallbacks 起 2026-08-12 用**卡形态**（plugin.item）并删除独立导航；「设置页」口语可指卡或 section，正式文档按挂载形态区分。

### PR-driven release
npm 发布触发模型：发布动作 = merge `release vX.Y.Z` PR（release-prep 手动触发生成 PR，release.yml 在 merged 后跑 publish/tag/GitHub Release）。区别于 push:tags 自动发布——可审查、可回滚、无 secrets。Trusted Publishing 组合下零长期凭据。
*Avoid:* 直接 `git tag && git push --tags` 自动发版（无审查面）

### Trusted Publishing bootstrap
npm 的 Trusted Publishing（OIDC provenance，无 token）**只对已存在的包可配置**——包未发布过时没有配置入口。首版 bootstrap：一次性 granular token（NODE_AUTH_TOKEN，publish 步骤 optional env）→ 发布 → npm package settings 配 TP → 删除 token。TP 是常态，token 是一次性手段。

### 具名 cordis service（消费面）
插件暴露程序化能力给其它插件的方式：`ctx.provide(name, VALUE)` 值形式注册（非 factory）+ `declare module '@deepseek-ai/cordis'` Context interface 合并——消费方 `ctx.get(name) !== undefined` 即响应式能力探测（生命周期自动就绪/撤销）。多 fiber 同 root 必须 dedupe guard（cordis 重复键 fail-loud）。
*Avoid:* `ctx.provide(name, () => ({...}))` 工厂形式（会把函数本身注册为服务值）

### role seeds（角色种子）
companion 插件经释放面声明 `[{id, persona}]`、由本插件自动补全角色 taxonomy 的机制（iter-20260815-fallbacks-role-seeds）：持久面 = operator 配置 `roles.list[]` 普通行（物化仅 `{id, persona}` 两键），内存面 = per-apply `FallbacksSeedManager` registry；`seeded`/`personaOverridden` **派生不存储**（round-trip 构造性无孤儿 override）。释放面 = 9-key service 的 `declareSeeds`(a) / `getEffectiveRoles`(b) / `revertSeededPersona`(c) + gateway `seeds` wire + `fallbacks/revert-seed`。seed id 按 as-declared 过 `ROLE_ID_PATTERN`（零 coercion），chain/fallback/prompt/permissions 永不被动（R4）。
*Avoid:* 「seed 覆盖配置」「mstar patch 写插件行」（fold bundle row 已证伪——同 loader-entry id 启动崩溃 / 异 id 双实例）

### bundled preset roles（内置预设角色）
插件自身携带的默认角色声明（iter-20260816-fallbacks-preset-roles）：`presetRoles` 包根导出 + config `presets: 'bundled' | 'none'`（默认 bundled）——插件在 apply 尾部经条件注入子自声明 7 个 omp 风格通用角色（designer/librarian/reviewer/scout/security-reviewer/sonic/task），operator 可关（none = 零声明零写）。与 companion 声明的区别：seeds 的**调用方是插件自身**；语义（冲突保留/幂等/derived seeded）完全复用。
*Avoid:* 默认 none（bundled 语义开箱即有）· async 化 apply 自声明（fiber FAILED）· 复用早注册注入子 fire（base-only 基线覆盖 operator 行）

### 三段式分发角色解析（three-stage dispatch role resolution）
subagent 分发时（首请求）解析角色的三段流程：显式角色（session header `agentPreset` 精确匹配已声明角色 id）→ 确定性规则匹配（`roles.rules`，与失败时共用 resolveRole）→ LLM 自动匹配（`roleAutoMatch` 默认开启；模型从已声明角色 taxonomy 中自选，超时/失败/无合法答案回退 inherit）。解析角色的链首 exact 候选在分发时注入首请求（`fallbacks/switch` 事件，reason `role-inject`；非失败决策——无冷却/记账，仅 subagent origin，首请求幂等）。
*Avoid:* 把「模型自选角色」当作既有机制（角色解析是确定性规则匹配，模型自选仅存在于自动匹配兜底段）
