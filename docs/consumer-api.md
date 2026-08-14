# 消费契约（Consumer API）

本文档定义 `dsh-llm-fallbacks` 对外暴露的**消费面**：① 包根库 API（`import { … } from 'dsh-llm-fallbacks'`）；② 具名 cordis service（`ctx.get('llm-fallbacks')`）。两个入口共享同一函数实现（单点真相，无复制逻辑）。安装方式见 [docs/install.md](install.md)；发布流程见 [docs/release.md](release.md)。

> **契约边界**：本文档描述的是**本包**的导出面与生命周期。**本包契约成立 ≠ 隔壁仓库已接上**——集成是否完成需以目标仓库的实际接线为准。

## 库 API（包根 re-export）

`src/index.ts` 从包根统一 re-export 运行时函数、值常量与类型，消费方直接 `import { … } from 'dsh-llm-fallbacks'`，无需深入子模块路径。

### 最小示例

```ts
import { resolveRole, resolveChain, validateFallbacksConfig } from 'dsh-llm-fallbacks'

// resolveRole：按 origin/provider/model 顺序匹配 roles.rules → 角色 id（未命中 → 'inherit'）
const role = resolveRole(agent, config.roles.rules, roleIds)

// resolveChain：角色链 + rootChain 拼接后返回存活候选（决策路径同款）
const candidates = resolveChain(config.roles.list, config.rootChain, role, provider, model)

// validateFallbacksConfig：校验配置，问题经 logger.warn 告警（不抛错）
validateFallbacksConfig(config, logger)
```

### 函数导出清单

| 导出 | 说明 |
|---|---|
| `resolveRole(agent, rules, roleIds, warn?)` | 按 `origin`/`provider`/`model` 顺序匹配 `roles.rules`，返回命中的角色 id；无规则命中或引用未声明角色时返回内置 `'inherit'`。 |
| `resolveCandidate(entry, failing, modelExists?)` | 把单个链条目解析为候选；`provider/*` 通配展开为失败模型；条目非法或存在性探测失败返回 `null`。 |
| `resolveChainViews(roles, rootChain, role, provider, model, warn?)` | 单趟解析角色的拼接链，返回未过滤候选视图 `{ all, wildcard }`（`wildcard[i]` 标记候选 `all[i]` 是否来自通配条目）。 |
| `selectCandidates(all, wildcard, filter?, modelExists?)` | 对候选视图应用过滤与存在性探测，返回存活候选列表。 |
| `resolveChain(roles, rootChain, role, provider, model, filter?, modelExists?, warn?)` | 完整链解析（决策路径同款）：拼接角色链 + `rootChain`（`fallback: 'none'` 不追加），返回存活候选。 |
| `hasWildcardEntry(roles, rootChain, role)` | 探测该角色的拼接链是否含 `provider/*` 通配条目——调用方据此决定是否需要 catalog 存在性探测（与解析同源，无过近似）。 |
| `createCandidateFilter(options)` | 构造候选过滤器：跳过当前模型、冷却中、本 step 已失败与缺失模型 id 的候选。 |
| `annotateCandidates(candidates, surviving, options)` | 为每个候选标注跳过原因（`skip` 未定义 = 存活），用于可见性 / 日志。 |
| `validateFallbacksConfig(config, logger)` | 校验配置合法性（未声明角色引用、非法链等），问题经 `logger.warn` 告警（不抛错）。 |
| `detectLegacyKeys(source)` | 检测配置中的已删除旧键（如 `chains`），返回命中的键名列表。 |
| `parseSelector(input)` | 解析 `provider/model` 或 `provider/*` 选择器；输入非法时抛 `SelectorError`。 |

### 值导出

| 导出 | 说明 |
|---|---|
| `INHERIT_ROLE_ID` | 内置保留角色 id `'inherit'`（无规则命中时的回退目标）。 |
| `ROLE_ID_PATTERN` | 角色 id 格式正则 `/^[a-z0-9-]{1,32}$/`。 |
| `defaultFallbacksConfig` | 默认配置对象（`enabled: false`、默认 `triggerCodes`、空链）。 |
| `SelectorError` | `parseSelector` 抛出的可捕获错误类——catch 侧类型安全依赖它。 |

### 类型导出

`FallbacksConfig` / `FallbacksRole` / `FallbacksRoles` / `FallbacksRoleRule` / `FallbackStrategy` / `RevertPolicy` / `Origin` / `AgentLike` / `Selector` / `FailingModel` / `AnnotatedCandidate` / `CandidateSkipReason` / `CandidateFilterOptions` / `FallbacksConfigLogger`——均为 `export type`，仅编译期存在。

### 插件既有导出（保持不变）

`name` / `Config`（schemastery schema）/ `stateStore` / `countRetryEvents` / `apply` 及事件与状态类型（`FallbackSwitchReason` / `FallbacksSwitchEventData` / `AgentFallbackState` / `FallbackStateStore` / `PendingSwitch` / `StepFailures`）继续从包根导出，零回归。

## 具名 service（`ctx.get('llm-fallbacks')`）

插件 `apply()` 后在 cordis `Context` 上以名称 `'llm-fallbacks'` 注册服务。**它是与库 API 共享同一函数实现的纯函数小面，不是第二套库 API**：运行态（冷却、最近切换等）不属于契约——跨插件读状态请监听 `fallbacks/switch` 事件，不要读服务对象内部。

### 形状

```ts
{
  name: 'llm-fallbacks'          // 与插件 name 一致
  version: string                // package.json version（模块加载时快照）
  resolveRole: typeof resolveRole
  resolveChain: typeof resolveChain
  validateFallbacksConfig: typeof validateFallbacksConfig
  detectLegacyKeys: typeof detectLegacyKeys
}
```

服务面**刻意不包含**运行态（无 `stateStore` / 事件发射器）与过滤 helper——那些只走库 import。静态导出 `provide = ['llm-fallbacks'] as const` 是声明性元数据（loader/工具识别用），实际注册发生在 `apply()` 内。

### 探测示例

与 mstar loader-probe 用法一致：先用 `!== undefined` 探测可用性，再调用。

```ts
const fb = ctx.get('llm-fallbacks')
if (fb !== undefined) {
  fb.resolveRole(agent, rules, roleIds)
}
```

### 生命周期

- **apply 后可用**：插件 apply 期间 `ctx.get('llm-fallbacks')` 返回服务对象，四函数与库 re-export 为同一函数引用，`version` 等于 package.json 版本。
- **dispose 后撤销**：注册随插件 fiber unload 自动注销（cordis 4 fiber-scoped），插件 dispose 后 `ctx.get('llm-fallbacks')` 为 `undefined`——strict `get` 对缺失实现返回 `undefined`，不抛错。

### 类型合并

import 本包即自动合并 `Context` 类型（`declare module '@deepseek-ai/cordis'` 增补 `'llm-fallbacks'?: FallbacksService`），消费方**无需自行 declare**；`FallbacksService` 类型亦从包根导出。未 import 本包类型时，`ctx.get('llm-fallbacks')` 退化到 untyped 重载。

## 版本元信息

`version` 是发布时 package.json 的版本字符串（模块加载时经 `createRequire` 读取一次的快照），随发布更新；消费方可据此做版本门控，但它**不是运行态**，不代表任何实时状态。
