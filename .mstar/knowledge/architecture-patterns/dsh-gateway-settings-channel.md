---
module: dsh-plugin-gateway
date: 2026-08-12
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

> **Stale-pointer note**: Iteration `iter-20260812-fallbacks-plugin-config` supersedes: fallbacks 展示挂载由 `settings.section` 换为 `settings.plugin.item` 卡，且 20260811 起 `settings/changed` 已移除（失效刷新迁 `settings/document-updated` + `llm/adapters-updated`）——正文「Context」与「Store 其它要点」两处陈述将过时；knowledge refresh 归 iteration-close compound。

# dsh 插件自有 settings gateway 通道（mount-only 数据面）

插件命名空间经 host apiproxy wire 读写配置的替代通道模式。两个 dsh 插件（advisor、
fallbacks）已验证：声明 `GatewayService` + `@Remote` 的自有通道取代「改宿主暴露白名单」，
web 设置页照常读写，宿主源码零 diff。

## Context

dsh 的 web 设置 RPC（`dsh-host-apiproxy`）对命名空间有**硬编码暴露白名单**
（`exposedNamespaces()` 只含 model-provider 与产品命名空间），插件命名空间默认不可经
`settings.describe/update/replace` 读写。旧 fallbacks 交付以两个本地 patch 强行打开门禁
（`exposeToWebClients` + `exposedNamespaces()` 并集）——违反纯挂载约束。advisor 证明的
替代路径：插件声明自己的 `GatewayService` 通道，client 经 `connection.rpc.call('/api', …)`
读写；宿主侧写操作走进程内 `ctx.settings`（该检查只存在于 apiproxy wire 层，进程内
update/replace 无命名空间门禁）。`settings.section` slot 注册保留——它是**展示挂载**，
与数据通道正交（见 CONCEPTS 已决歧义）。

## Guidance

### 声明通道，不要拦截

- host 半：`class XGateway extends GatewayService { @Remote('get') … }`，
  `super(ctx, '<ns>')`。typertGateway SRC 发现（`ctx.reflect.props` + remoteMethods）自动
  认领 `<ns>/<method>` 到 host 全局 `/api` 拦截器。
- 插件**不得**自行 `connection.rpc.intercept('/api')`——该拦截槽 host 全局单点，重复注册
  会抛错；`GatewayService` 绑定 + `@Remote` 标记是唯一受支持的注册方式。
- client 半：`connection.rpc.call('/api', '<ns>/<method>', { args })`。

### Wire 契约

- payload 恰为**一个 plain-object `args` 字段**，键 = 方法参数名。
- 结果信封：成功 `{ ok: true, value }`；方法抛出/拒绝 → `{ ok: false, error: { message } }`。
- typertGateway 结果校验器**拒绝 `undefined`**：返回对象缺省键必须省略（never
  present-as-undefined）；`null` 也不是合法 wire 值——`set` 前丢弃 `null` 条目
  （null-means-absent，与 advisor 同）。

### 写入语义：merge 与 reset 分离

- `set(patch)` 是 MERGE（`ctx.settings.update`）——无法表达「清掉 user layer 让组合默认
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
- 进程内 update/replace 仍发 `settings/changed`（ns 过滤保持），推送失效刷新逻辑不变。

## Why This Matters

- 设置数据面彻底离开 apiproxy expose 机制：插件命名空间在未打 patch 的宿主上不出现于
  `settings.describe`（与 advisor 同态），client 必须读 gateway——这是迁移中最大的行为
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

- **dsh-advisor**：`AdvisorConfigGateway`（get/set 两方法；`resolveAdvisorConfig` 有
  enabled 解析器——fallbacks 无，见下）。
- **dsh-llm-fallbacks**：`FallbacksConfigGateway`（get/set/reset 三方法；无解析器；
  实例细节与 store 迁移 → `architecture-patterns/dsh-llm-fallbacks.md`「设置命名空间 web
  暴露」节）。
- 测试缝：`tests/gateway.spec.ts`（get 规范化、set 未知键拒绝/空 patch no-op、reset 走
  replace、KD-G5 无 settings 服务三分支、畸形 user layer 不崩 get）。
- 展示挂载契约（`settings.section` slot 等）→ `architecture-patterns/dsh-settings-slot-contract.md`。

*Source: iteration iter-20260811-fallbacks-mount-only `guides/gateway-channel-design.md`（ADR-1..ADR-5 契约），
与 dsh-advisor `src/gateway.ts` 对照验证。2026-08-12 compound 提升（结构化重写为模式层）。*
