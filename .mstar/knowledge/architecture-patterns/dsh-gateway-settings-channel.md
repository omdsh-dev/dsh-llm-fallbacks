---
module: dsh-plugin-gateway
date: 2026-08-12
last_updated: 2026-08-15
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: llm-fallbacks-settings-gateway
applies_when:
  - 为 dsh 插件实现 web 设置页的配置读写（无需改宿主源码）
  - 需要理解 /api/fallbacks/get|set|reset 通道的契约与失败语义
  - 评估插件命名空间能否经 apiproxy wire 暴露（exposedNamespaces 白名单）
  - 维护 dsh-llm-fallbacks 或 dsh-advisor 的 settings gateway
tags:
  - dsh
  - gateway
  - settings
  - mount-only
  - rpc
  - apiproxy
  - cordis
related_components:
  - "@deepseek-ai/dsh-host-apiproxy"
  - "@deepseek-ai/dsh-settings"
  - "@deepseek-ai/dsh-type-meta"
  - dsh-llm-fallbacks client store
---

# dsh 插件自有 settings gateway 通道（mount-only 数据面）

插件命名空间经 host apiproxy wire 读写配置的替代通道模式。两个 dsh 插件（advisor、
fallbacks）已验证：声明 `GatewayService` + 显式 `ctx.typert.register(contribution)` 的
自有通道取代「改宿主暴露白名单」，web 设置页照常读写，宿主源码零 diff。2026-08-13 起
端点注册从 `@Remote` SRC 标记迁移到显式 contribution（见「声明通道，不要拦截」——SRC
发现对 link 插件不可靠）。

## Context

dsh 的 web 设置 RPC（`dsh-host-apiproxy`）对命名空间有**硬编码暴露白名单**
（`exposedNamespaces()` 只含 model-provider 与产品命名空间），插件命名空间默认不可经
settings.describe/update/replace 读写。旧 fallbacks 交付以两个本地 patch 强行打开门禁
（`exposeToWebClients` + `exposedNamespaces()` 并集）——违反纯挂载约束。advisor 证明的
替代路径：插件声明自己的 `GatewayService` 通道，client 经 connection.rpc.call('/api', …)
读写；宿主侧写操作走进程内 ctx.settings（该检查只存在于 apiproxy wire 层，进程内
update/replace 无命名空间门禁）。展示挂载与数据通道正交——fallbacks 现经
`settings.plugin.item` 卡（2026-08-12 起，旧 settings.section 导航已删）展示，配置数据
仍走本通道（见 CONCEPTS 已决歧义）。

## Guidance

### 声明通道，不要拦截

- host 半：`class XGateway extends TypertRemoteService { … }`，`super(ctx, '<ns>')`；
  **显式注册**端点——`ctx.typert.register(contribution())`（`TypertContribution` 来自
  @deepseek-ai/dsh-typert-registry；invocation descriptor 镜像 SRC 派生形状：direct
  receiver、JSON wire params、`src-json` codec），经条件 `ctx.inject(['typert'])` 子
  激活（无 typert registry 的组合照常跑运行时、只是没有 /api 端点）。
- `TypertRemoteService` 基类**仅**为 `typertRemote` 绑定保留——dispatch 的
  `validateBinding` 要求 live service 上有可见绑定（纯实例属性，无模块私有状态）。
- **SRC 发现限制（2026-08-13，rc.2 dlx host）**：旧路径 `@Remote` 标记靠
  `remoteMethods()` 读 @deepseek-ai/dsh-typert-protocol 的**模块私有 WeakMap**。
  `link:` 挂载的插件 peer 从真实目录解析（物理上与 dlx 宿主缓存树分离），宿主
  typertGateway 持有一张空的标记表 → SRC 认领 **0 个端点** → `/api/<ns>/*` 404、
  客户端报「settings gateway is not ready」，而插件本身 Mounted+Enabled 正常
  （settings.register 成功；跨副本 schemastery 已验证健康——schema 双装不是断点）。
  同版本 peer 必要但不充分：**模块身份**（而非版本）门控私有表。
- **显式注册路径**：TypertRegistry.register 把 invocation descriptor 写入
  `ctx.typert.local`——`claimsEndpoint`/`resolveDescriptor` **先查它**（strict path），
  claim + dispatch 完全不碰私有表。单测里 SRC 仍能过（测试只 import 一个物理副本），
  分裂只出现在物理分离的模块实例之间。
- 插件**不得**自行 connection.rpc.intercept('/api')——该拦截槽 host 全局单点，重复注册
  会抛错；`TypertRemoteService` 绑定 + 显式 contribution 是唯一受支持的注册方式。
- client 半：connection.rpc.call('/api', '<ns>/<method>', { args })。

### Wire 契约

- payload 恰为**一个 plain-object `args` 字段**，键 = 方法参数名。
- 结果信封：成功 `{ ok: true, value }`；方法抛出/拒绝 → `{ ok: false, error: { message } }`。
- typertGateway 结果校验器**拒绝 `undefined`**：返回对象缺省键必须省略（never
  present-as-undefined）；`null` 也不是合法 wire 值——`set` 前丢弃 `null` 条目
  （null-means-absent，与 advisor 同）。

### 写入语义：merge 与 reset 分离

- `set(patch)` 是 MERGE（ctx.settings.update）——无法表达「清掉 user layer 让组合默认
  重新生效」：把默认值当 patch 写会把旧默认钉死在 user layer（默认值后续变更不再传导）。
- 表单若拥有 reset-to-defaults 动作，加**第三个方法 `reset()`**：进程内
  `settings.replace(ns, {})`（真清除路径，证据：dsh-private `agent-default-model` /
  `llm-pi-ai` 测试同款调用）。这是相对 advisor 两方法契约的唯一 justified 扩展。

### 可选 settings 服务（KD-G5）

settings 服务可缺席（link 安装 / host 无 settings fiber）。用**条件注入子**捕获：

```ts
constructor(ctx, bridge) {
  super(ctx, 'fallbacks')
  this.bridge = bridge
  ctx.inject(['settings'], (sctx) => {
    this.settings = sctx.settings
    return () => { this.settings = undefined }
  })
}
```

无 settings 服务时：`get` 仍可用（bridge/组合源直读 → 页面只读渲染 base 配置）；
`set`/`reset` 抛明确错误（`'…settings service is unavailable — configuration cannot be
written'`）。`get` 失败（传输断 / gateway 未就绪 / 抛出）→ 通道不可达骨架，**不是**硬页面错误。

### 无 revision 守卫（KD-G3）

gateway 通道是普通 RPC merge/replace，**无版本戳**。迁移时删除乐观并发分支
（`expectedRevision`、冲突横幅、`settings-conflict` 码），任何 `set`/`reset` 失败统一走
既有错误横幅、表单保持可编辑供重试。这是 store 保存路径唯一允许的行为变化，需新单测
钉住（「set 拒绝 → 错误横幅」替换旧「冲突」用例）。

### 跨写者 RMW race（无 revision guard 的代价，2026-08-15 实证）

`mergeLayers` 数组整替 + 无版本戳 → 任何「fresh-read → 计算 → settings.update」的写路径
（gateway `set`/`reset`、seeds `declare`/`revert`）之间没有互斥：读与写两个 await 点之间
另一写者整替落地 → **last-writer-wins**，输方改动从 user layer 消失。影响有界且可恢复：
registry 存活、re-declare 重新物化、card-save 丢失在 post-write read 可见；低概率（低频
写）。这是**通道既有限制**（非任一迭代引入），修复 = 跨写者 revision guard / compare-and-
retry = settings-channel 迭代的产品决策（R-002 defer，Durable Roadmap：下一
settings-channel 迭代；trigger：第三并发写者或该迭代启动）。

### 读写路径同用 containment 守卫

schemastery/mergeLayers 非严格组合会保留 legacy/畸形嵌套键（如两块制前的
`roles.default`、非数组 `list`）。**读路径必须容忍**（降级为 `[]`/默认，不崩——「readbacks
must never crash」）；**写路径必须与读路径共用同一守卫**（`roleRows()`/`roleRules()`）——
否则同一畸形源在写路径抛裸 TypeError（RPC 错误面）而读路径静默降级，语义不对称。2026-08-15
fix wave 实证：declare/revert 直读 `config.roles.list` 被收口到守卫。

### Additive wire 字段（旧客户端兼容先例）

gateway 响应加字段用 **additive** 模式：`readResult()` 统一附加（`legacyKeys`、`seeds`），
缺字段的旧客户端忽略、老响应对新客户端 keep-last——wire 兼容前向/后向都不需要版本协商。
新端点（如 fallbacks/revert-seed）在 `fallbacksTypertContribution()` 增加 invocation
即可，`ROLES_KEYS`/`CONFIG_KEYS` 等既有键集合不动。

### 写前校验与「不要发明 resolver」

- settings schema **非严格**（未知键静默合并），gateway 必须在写前显式拒绝未知键（与
  advisor、Loader 同严）；空/仅 null patch → no-op 返回当前组合，不触发 settings 往返。
- 若运行时在决策点直接读 `source()`（无 enabled-without-pair → disabledReason 类解析器），
  `get` 就返回原始组合配置、**不**合成派生字段——发明 resolver 会复制决策路径。

### Draft 播种不变量

表单 draft 恒从**真实解析配置**播种；`get` 失败时骨架可以默认值展示，但**不得**用默认值
播种 draft——瞬态通道故障恢复后，draft 会与真实种子 diff 出全默认 patch，抹掉真实配置。

### Store 其它要点

- `describe` 仍调用：取顶层 `writable`（host 只读态）+ 其它命名空间目录（configured-provider
  并集）；插件自身命名空间将**不再出现**于 describe——停止按 ns 查找。
- `present` 标志替代 namespace-found 检查：`get` 解析 → true；否则 false → 可操作骨架。
- **失效刷新（20260811 起 remote events）**：进程内 update/replace **不再发**
  settings/changed（该客户端事件与 models/changed 已于 20260811 dsh snapshot 移除，
  订阅即死代码）。client 失效刷新迁移到 remote 转发事件（`ctx.remote.$on`，需 `remote`
  在 inject 面）：
  - settings/document-updated(ns, revision) —— ns **精确过滤**插件命名空间才刷新
    （form + switches），他 ns 不刷新；
  - llm/adapters-updated() —— payload-free，**只**刷 catalog，不碰表单；
  - connection/reset（client 事件，保留）——全量刷新，微任务合并突发（burst
    coalesce，advisor 同款 debounce）。
  - 刷新仍走 `refresh*IfLoaded` + generation guard（只刷已读过的 store，未打开的面闲置）。
  - 检测纪律：死事件靠 link farm 真实类型 + `tsc`（`pnpm build` 含 tsc）暴露（TS2345）；
    测试 double 钉事件名集合（drift-visible）；grep settings/changed|models/changed
    零残留。

### 注入子注册序 = 激活序；SettingsProvider init publish 清 seed（2026-08-16 实证）

- **cordis 注入子按注册序同波激活**（Fiber `_reload` 先 `await Promise.resolve()`，微任务 FIFO）：apply 内多个 `ctx.inject([...])` 子按注册先后激活。依赖「先注册子先执行」的隐式顺序（如 writeRoles live 先于 preset fire）成立但脆弱——**新 fire 点应注册于 apply 最尾部**，并在注释钉住理由（preset 子见 `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md` Preset roles 节）。
- **SettingsProvider init publish 清 seed（F-005 教训）**：cordis `Service` 构造同步 provide 但不跑 `[Service.init]`；dsh-settings init 的 `publish(await load())` 会**清掉 init 完成前 publish 的任何 seed**（测试 double 人造物；file-backed HMR 因文档持久化天然规避）。测试「settings 移除→恢复→注入子 re-fire」时，须手工构造 fresh provider 并在子再激活前同步 seed——四断言面（re-fire 证明 / no-delta 零写 / 无重复 / user section 未变）各自独立失败才算钉住。
- **re-fire 语义**：settings 子每次激活 re-fire（无 per-apply 单发 guard）；declare 幂等 + registry re-commit 保持 badge 正确。

## Why This Matters

- 设置数据面彻底离开 apiproxy expose 机制：插件命名空间在未打 patch 的宿主上不出现于
  settings.describe（与 advisor 同态），client 必须读 gateway——这是迁移中最大的行为
  变化与最易错点。
- KD-G3/G5 把「失败面」钉成明确语义（可操作骨架 + 诚实错误横幅），杜绝白屏/死按钮与
  静默丢保存。
- 写前未知键拒绝 + wire 规范化防脏数据进入 user layer；`reset` 独立方法保证「恢复默认」
  是清除而非钉死。

## When to Apply

- 任何 dsh 插件需要 web 设置读写且承诺不改宿主（mount-only）时。
- 评估「插件命名空间能否走 apiproxy wire」时——先查 `exposedNamespaces()`，结论通常
  是「不能，走 gateway」。
- 维护/扩展 fallbacks 或 advisor 的 gateway 通道（端点、错误语义、store 契约）。
- 排查设置页「保存不生效 / 冲突横幅 / 骨架异常」类问题。

## Examples

- **dsh-advisor**：`AdvisorConfigGateway` + `advisorTypertContribution()`（get/set 两
  方法；`resolveAdvisorConfig` 有 enabled 解析器——fallbacks 无，见下）。
- **dsh-llm-fallbacks**：`FallbacksConfigGateway` + `fallbacksTypertContribution()`
  （get/set/reset 三方法 + seeds wire `seeds` 字段 + fallbacks/revert-seed 端点
  (2026-08-15)；无解析器；实例细节与 store 迁移 →
  `.mstar/knowledge/architecture-patterns/dsh-llm-fallbacks.md`「设置命名空间 web 暴露」节）。
- 测试缝：`tests/gateway.spec.ts`（get 规范化、set 未知键拒绝/空 patch no-op、reset 走
  replace、KD-G5 无 settings 服务三分支、畸形 user layer 不崩 get）。
- 展示挂载契约（settings.section slot 等）→ `.mstar/knowledge/architecture-patterns/dsh-settings-slot-contract.md`。

*Source: iteration iter-20260811-fallbacks-mount-only `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/gateway-channel-design.md`（ADR-1..ADR-5 契约），
与 dsh-advisor `src/gateway.ts` 对照验证。2026-08-12 compound 提升（结构化重写为模式层）。
2026-08-15 刷新：跨写者 RMW race（R-002）、读写 containment 守卫、additive wire 字段先例。2026-08-16 刷新：注入子注册序=激活序、SettingsProvider init publish 清 seed（iter-20260816-fallbacks-preset-roles F-005 实证）。*
