---
module: dsh-plugin-authoring
date: 2026-08-10
last_updated: 2026-08-15
problem_type: best_practice
category: best-practices
severity: low
plan_id: llm-fallbacks-plugin
applies_when:
  - 为 dsh（DeepSeek Harness）编写第三方 cordis 插件
  - 插件需要 host 半（服务/事件/waterfall）与 web client 半（设置页/面板）
  - 需要消费 @deepseek-ai/* 包的类型或运行时面
tags:
  - dsh
  - cordis
  - plugin
  - bundle
  - real-code-linking
  - settings
  - schemastery
---

# dsh 第三方 cordis 插件创作模式（已验证 playbook）

dsh-llm-fallbacks 迭代验证的 dsh 插件创作全流程（bundle 组合层 → host 半 → client 半 → 类型访问 → 纯挂载交付）。

## Context

dsh 插件 = npm 包，package.json 声明 dsh.bundle.patch（指向 bundle/cordis.patch.yml，YAML 数组「insert: id/name/config」），经 `dsh plugin --profile <name> add .` 装入 profile（bundles 列表顺序决定加载顺序；后装 bundle 的行在 llm-retry 等内置行之后插入——waterfall 注册顺序依赖此）。@deepseek-ai/* 包未发布公共 registry（404），运行期由 dsh 宿主 in-box 解析；pnpm-workspace.yaml 需 autoInstallPeers: false。

## Guidance

### 包结构与构建

- exports：主入口、./client、./bundle/cordis.patch.yml、./package.json；files 含 dist 与 bundle。
- host 半：tsdown（`tsdown.config.ts`：node ESM bundle，`deps.neverBundle ['cordis', /^@deepseek-ai\//]`——外部化 import 由宿主 in-box 解析）+ tsc（d.ts，`emitDeclarationOnly`）。构建栈与 dsh 宿主一致（pnpm + tsdown + tsx，无 bun）。
- client 半：closure-factory CJS bundle（`window.__ModuleLoader__.load` 契约；`tsx scripts/build-client.ts` 跑 tsdown，`deps.neverBundle` 加载器表 + `alwaysBundle` 内联其余），经 dshClient.inject 声明依赖；CSS-modules 需自定义 transform（rolldown 插件 resolveId/load 虚拟 id + 类名哈希 + style 标签内联注入/卸载）+ NODE_ENV define。
- prepare 脚本自建（git 安装不跑 build；prepare 需自包含）。

### 类型访问（dsh link farm，取代 peer-stubs）

- @deepseek-ai/* 不可安装（registry 404），运行期由宿主 in-box 解析；开发期用 `scripts/setup-dsh-links.mjs`（prepare 前置；独立入口 `pnpm dsh:link` / `pnpm dsh:link:check`）从 dsh 源码树链接**真实包**到 node_modules：`$DSH_SOURCE_DIR` → `${DSH_HOME}/source/current` → `~/.dsh/source/current`（取第一个存在）。链接范围 = 源码树 `packages/`+`vendor/` 下所有**无 `bin`** 的 `@deepseek-ai/*` 包（bin 工具包会让 pnpm 往共享 dsh 树写 `.bin`，跳过）。tsconfig 无需 paths。
- **cordis 必须同物理文件**：真实包的 .d.ts 引用 dsh 树 vendor 的 cordis（非 npm 副本）——直接 symlink vendor/cordis 会带出它的 bin；改为生成 **bin-less shim**（`node_modules/cordis/`：package.json + index.js/index.d.ts/src 符号链接到 vendor 文件），`import 'cordis'` 两侧解析到同一 realpath，`Context`/`Events` 增广才合并（否则 TS2345 满屏）。
- 安全守卫：宿主 profile 的 pnpm store 内安装（git 依赖 prepare/postinstall 在 node_modules/.pnpm 内运行）或仓库根无 node_modules/ 时自动跳过（exit 0）——绝不把 staging 树链进宿主运行环境；源码树缺失/peer 不可链接 → 报错退出带指引（开发期硬性要求）。
- 运行时值 import 保持 external；测试缝走真实实现：`installSettingsSection` 挂真实 `@deepseek-ai/dsh-settings`（内存 provider 继承真实 `Settings` 基类，只实现 load/persist + seed 播种），client 半 store 引擎 vitest alias 到 dsh 源码树 `src/.../store.ts`（built `./client` 是浏览器 loader artifact，不可直跑）。

### 设置与 UI

- settings 命名空间：installSettingsSection(ctx, settingsNamespace(命名空间名), Config, entry, {setSource, onChange})（参照 agent-default-model）；composition entry 作 base、用户文档作覆盖层。
- web 设置入口两形态（2026-08-12 起 fallbacks 用卡片形态）：
  - **插件配置页卡（`settings.plugin.item`）**：`ctx.slots.inject('settings.plugin.item', generator)` 注册 `{ name, id, order, locale, inject }` + 自绘折叠卡组件（`<li>` + header + body + footer，chrome 对齐上游 `PluginCard`——组件**不可值导入**，必须 self-draw；advisor 自绘参考）。**卡替换 section 导航，不并存**（单入口）。卡内数据仍走插件自有 gateway 通道。
  - **整页 section（`settings.section`）**：独立设置页（`ctx.slots.inject('settings.section', …)` 注册 name/id/order/label/locale）；仍适用于整页设置产品。
  - 两种形态的**数据都走插件自有 gateway 通道**（client `connection.rpc.call('/api', '<ns>/<method>', { args })`，host 半 `TypertRemoteService` 绑定 + 显式 `ctx.typert.register(contribution)`——2026-08-13 起，`@Remote` SRC 标记对 link 插件失效）——apiproxy `exposedNamespaces()` 白名单对插件命名空间关闭，wire 读写（describe/update/replace）不可行；owner props 为空。
  - slot 挂载全契约（settings.section / plugin.item / general.item / action / onboarding / navIcon fallback / 新包三注册面）→ `architecture-patterns/dsh-settings-slot-contract.md`。
  - gateway 通道全契约（wire 规范化、KD-G3/G5、无 revision 守卫、set/reset 语义、draft 播种不变量、可选 settings 注入）→ `architecture-patterns/dsh-gateway-settings-channel.md`。
- **会话内只读诊断命令（`/fallbacks` 模式）**：`commands` 服务**条件注入子**注册
  （`ctx.inject(['commands'], (commandCtx) => registerCommands(...))`，**不入顶层
  inject**）——commands 服务缺失时子不激活、命令静默缺席，不抛顶层注入错误；注册返回
  disposer。只读命令不改运行时状态（快照构建走现有 store 只读面）。
- **失效刷新走 remote 转发事件（20260811+ 宿主）**：`settings/changed` / `models/changed`
  客户端事件已移除（订阅即死代码）。迁移到 `ctx.remote.$on`（需 `remote` 在 inject 面）：
  `settings/document-updated(ns, rev)`（ns 精确过滤）+ `llm/adapters-updated()`（payload-free）
  + 保留 `ctx.on('connection/reset')`（微任务合并突发）；`refresh*IfLoaded` + generation
  guard 语义不变。**漂移检测纪律**：link farm 给真实 dsh 类型 → `pnpm build`（含 tsc）在
  事件名删除后 TS2345 报错（死订阅无处藏）；测试 double **钉事件名集合**
  （drift-visible，新增订阅名自动失败）；`grep settings/changed|models/changed` 零残留。
- **设置页必须始终可用（不要死路）**：gateway `get` 失败（通道不可达）≠ 页面该显示「无法读取」通知——渲染可操作骨架（标题/介绍/只读状态块/主开关/保存动作）以默认值展示（`present=false`），`writable` 跟随 describe 顶层标志；`set`/`reset` 失败 → error 横幅如实呈现（不静默）、表单保持可编辑（KD-G3，无 revision 守卫）。通道恢复后骨架原地升级为就绪态。
- **Draft 播种**：编辑状态从 gateway `get` 返回的**真实组合配置**初始化（`accept(config, writable)`），不用默认值播种——`get` 失败时骨架仅**展示**默认值，播种默认值会在通道恢复后 diff 出全默认 patch、抹掉真实配置。
- **功能级开关（feature master switch）模式**：用配置字段本身（如 fallbacks 命名空间的 `enabled` 字段）作页面显隐开关——OFF 时隐藏表单主体 + 显示提示（隐藏不丢弃：draft 保留、拨动即时显隐），ON 时显示完整配置界面；开关状态 = 用户配置字段（保存持久化、重载保持），不是纯 UI 本地态。默认值如需翻转（如 enabled true→false），单点改 defaultFallbacksConfig + schema。
- **配置默认值翻转的测试基准**：翻转默认值会连带破坏所有走共享 cfg() 基准的用例——把测试基准显式钉到活跃态（cfg() = { ...defaults, enabled: true, ...overrides }），只翻转显式断言默认值的用例（config.spec），并新增「默认配置 → no-op」专项用例锁定回归不变量；store 单测按 gateway 语义拆分（get 失败 → present=false 骨架、draft 不播种默认值、describe 仍调用但不再读 fallbacks ns）。
- **测试矩阵文档会漂移**：docs/verification.md 的用例计数在迭代中反复过期（153→163→168）——更新文档时顺手校准，或以 grep 计数为准。

### schemastery 组合与 schema-breaking 配置迁移（未知键保留，iter-20260813 T1 实测）

`schemastery` `Config()` 组合对**未知键采用保留策略（retain）**——schema 未声明的键不丢弃：顶层、嵌套对象、列表项均原值透传（实测 schemastery@3.18.0：`Object.hasOwn(out, 'chains') === true`、`roles.default` 保留、列表项 `chain` 保留）。对插件配置迁移的三点影响：

- **schema-breaking 删除的旧键仍可见于组合对象**：「零残留」必须在 schema 与类型层面达成（迁移表除外）；组合对象天然携带用户层残留旧键。
- **wire 层需显式规范化**：组合对象 ≠ 新 schema 形状——`validateConfigPatch` 按新键集 own-key membership 拒绝未知键（不受保留行为影响），`get` 响应按新键集组装。
- **legacy 检测直接读组合对象**：`detectLegacyKeys(source())` 组合后即准确——无需 raw 入参快照 fallback 策略（fallbacks 实测：旧键随用户层写入保留在组合对象上，检测即准确）。

**三通道迁移模式**（breaking 不自动迁移）：启动 `logger.warn` + gateway `legacyKeys` + UI 迁移横幅（表单保持可编辑）+ docs 迁移映射表；插件绝不自动改写配置。

**组合空值填充语义**（已声明可选字段的等价默认）：`chain` 缺省 → `[]`、`permissions` 缺省 → `{ allow: [], deny: [] }`、字符串可选字段（如 `prompt`）缺省 → 不出现——「无自身链 / 无权限」语义等价，消费方 `roleDef?.chain ?? []` 不变；空组合 `Config({})` 深等于默认配置（no-op 不变式的组合侧验证）。

### 事件监听组合顺序与运行时面可读性（waterfall 内外层）

- **FIRST-registered listener is OUTER and has the final say**（cordis `events.ts` `waterfall`：按 `_hooks[name]` 注册序 first→outer 组合；`dispatch` 按 scope carrier 过滤但**不重排**）。同 ctx 两个 listener，先注册者的 post-`next()` 覆写赢。插件做 `agent/request` 类 override 前，先问「谁先注册」，不要按配置意图猜。
- **`agent/created` 是 post-publish，经它注册必为 inner**：`agents.create` 工厂先 `await setup`（`installModelSelection` 等在此注册）再 insert/announce；`agent/created` 里注册的 listener 严格内层，其 post-`next()` 改动会被外层 listener 重套覆写（clobber）。
- **注册时机不由插件控制**：bundle 行序（`cordis.patch.yml` 插行）与 agent 创建时机归宿主——headless profile 中 agent 在宿主 runner 插件 apply 内创建，晚挂载的兄弟插件天然 inner；web profile 中插件随 bundle 加载先注册、model-selection 随 agent 创建后注册（插件 outer）。结论必须按 profile 分述。
- **把预判转证实**：对「无挂载替代」类结论，写组合测试钉住注册序 × 行为矩阵（同 ctx 两 listener / 先外后内 / `agent/created` seam / headless 序），把 architect 预判变 proven（iter-20260811 Plan B T2 范式，证据见该迭代 `guides/role-and-model-selection-exploration.md`）。
- **persona 运行时不可读**（2026-08-11 源码验证）：`AgentOptions` 原生仅 `{ provider, model, maxTokens }`（注释明确 "Persona belongs to system-prompt sections"）；persona 是 subagent provider 能力，在 `agents.create` 未发布 setup 窗口以**作用域 system-prompt section**（`deployment:persona`）安装（spawn/fork provider 才有该能力），live `Agent` handle 与 child `SessionHeader` 均无 persona 字段。插件决策点（`agent/request-error` 只持 `Agent`）读不到 persona；hook `system-prompt/assemble` 捕获是 provider-scoped 内部装配面且值为 prompt 文本（非可作规则键的标识）——脆弱，不做。若 dsh 未来把 persona 上提为 `AgentOptions`/session header 字段，映射才可行（schema 向后兼容扩展）。

### 关键坑

- Config 类型 + z 类型注解的 schemastery ObjectT 输出键全 required：.default(undefined as unknown as {...}) 的 cast 类型必须与 schema 输出全等，否则 tsc -b 报 TS2345。
- cordis 插件命名导出约定：Loader 丢弃 namespace（含 inject 元数据）当存在 default export——只用 named exports。
- **上游清单契约会改名**（2026-08-11 实测）：client 半的 package.json 声明字段由 `dshClient` 改为 **`dsh.client`**（新 loader 只认 `dsh.client`，旧字段被忽略 → client 半在 GUI 完全不可见，无报错）。插件必须跟随：`"dsh": { "bundle": { "patch": ... }, "client": { "inject": [...], "platform": "web" } }`，且 `exports["./client"]` 必须存在（loader 校验）。升级 dsh 快照后核对 manifest 字段名 + exports。
- **Purity 门必须建在模块图面（resolveId），不是 require 文本面**：`deps.alwaysBundle` 会把表外依赖**静默内联**——值导入对等包不产生 require，require-only 断言失明（实测 94.37 kB 内联产物零 require 通过旧门）。双层：resolveId 插件抛错 + emitted-surface token 扫描（`/@deepseek-ai\/[\w./-]+/g` 超集）。每次新增 type-only 对等包后做负向探针（误值导入应红）。→ `build-errors/dsh-client-bundle-purity-gate.md`。
- **会话转录挂载走 conversationEvents + conversation.chat.node（纯渲染）**：非 surface 插件事件默认转录不可见；双段注册（注册表决定是否渲染 + keyed 座位决定如何渲染）；**宿主引擎对节点生命周期无 try/catch——match/start 对畸形载荷必须降级绝不 throw**；type-only 引用 `dsh-client-ui-conversation`；业务数据经 `node` prop。→ `architecture-patterns/dsh-conversation-surface-mounting.md`。
- 配置字段默认值跨 host/client 重复硬编码会漂移：从单一 defaultFallbacksConfig 派生。

### 具名 cordis 服务注册（消费面，iter-20260814 实测）

插件暴露程序化消费面（供其它插件探测/调用）时，注册具名服务——**消费方 `ctx.get('<service>') !== undefined` 即响应式能力探测**（优于 `ctx.loader.entries()` 点读；cordis 生命周期自动就绪/撤销）：

- **`ctx.provide(name, VALUE)` 是值形式**（cordis 4.0.1 `reflect.ts:277-292` 验证）：传**对象值**，不是 factory——传函数会被当作服务值本身注册（`fb.resolveRole === undefined`）。
- **`export const provide = ['<name>'] as const` 只是声明性元数据**（loader/工具可见）；实际注册只发生在 `apply()` 内 `ctx.provide()`——registry 不自动注册（`registry.ts:106-108`），无双注册风险。
- **多 fiber 同 root apply 必须 dedupe guard**：cordis 对重复服务键 fail-loud（`reflect.ts:289-290` throw「service X has been registered」）。镜像插件内既有 gateway/typert dedupe 模式：`try { ctx.provide(...) } catch (e) { if (e instanceof Error && e.message.includes('has been registered')) { debug('already registered — no service on this fiber (multi-fiber dedupe)') } else throw }`——第一 fiber 拥有服务、后续 fiber 优雅降级，**未加 guard 会让 apply() 中止在其它 dedupe 注册之前**。
- **类型面**：`declare module '@deepseek-ai/cordis' { interface Context { '<name>'?: ServiceShape } }`（cordis-4 interface-Context 合并；先例 dsh-settings `settings`、dsh-agent-default-model `agentDefaultModel`）；消费方 import 后 `ctx.get` 自动带类型。
- **严格 get 语义**：服务未注册/已撤销 → `ctx.get` 返回 `undefined`（不 throw）——消费方 `if (fb !== undefined)` 即生命周期探测。
- **版本元信息**：运行时 `createRequire(import.meta.url)('../package.json').version`（模块级读一次）——src/vitest 与 dist/发布后（npm 恒带 package.json）均解析；不要 build-time 内联。
- **服务面纪律**：只暴露**纯函数面**（解析/校验函数 + name/version 元信息），**不暴露运行态**（store/事件发射器）——跨插件读状态是实现细节非契约；运行态请走事件（如 `fallbacks/switch`）。
- 单点真相：服务方法 = 直接引用 index re-export 的同一函数（`toBe` 同一性测试钉住），不复制逻辑。
- **有状态方法的身份（2026-08-15 实证）**：服务面可以是「无状态纯函数 + 有状态闭包」混合——legacy 纯函数方法与库 re-export **同一绑定**（`toBe` 同一），但 per-apply 有状态方法（如 seeds `declareSeeds`/`revertSeededPersona`）是**闭包**（捕获 apply() 内建的 manager），与库 re-export **不是**同一引用。文档必须区分两种身份（写「与库导出同一绑定」会过度声称，2026-08-15 修过此 doc bug）；测试同样分型钉住（纯函数 `toBe` vs 闭包行为）。

### 条件注入子 fire 模式（apply 尾部触发后台动作，2026-08-16 实证）

插件需要在 apply 后做**异步后台动作**（如经 settings 通道物化默认数据）时的安全模式：

- **apply 保持同步签名**：cordis 虽 await thenable 返回值，但 rejection 经 `_reload` 使整条 fiber **FAILED**（插件整体不加载）——headless 组合会把运行时整个拖死；且 `void → Promise<void>` 是公共库面非 additive 变更。异步动作一律 fire-and-forget + **同步挂 `.catch`**（无 unhandled rejection 窗口）。
- **不要在 apply 尾部同步触发**：`ctx.inject` 子一个 tick 后才激活，同步触发必中「服务未就绪」stub。定案：**注册新的条件注入子**（`ctx.inject(['settings'])`），子激活回调内执行动作；子不激活 = 服务结构性不存在 = 零副作用（headless 边界天然成立）。
- **不要复用早注册的注入子**：早注册子激活时 `setSource`/绑定可能尚未就绪（base-only 基线 → 整键覆盖事故）；新 fire 点注册于 apply 最尾部，按注册序激活保证依赖先 live。
- **multi-fiber 门控**：同一动作只应发生在成功注册 service 的 fiber（provide try 置 ownership 标志、dedupe catch 置 false）；second fiber 不重复执行；动作本身幂等（no-delta）作双兜底。
- 失败面：logger.error 一条带前缀、状态不 commit、不阻断 apply、无进程内重试（下次 apply / 子再激活即重试）。测试须 `vi.waitFor`（fire 在激活后一个 tick）+ 负向断言 settle 窗口。

## Why This Matters

每条模式都踩过坑（registry 404、closure-factory 契约、schemastery cast、waterfall 注册顺序），按此 playbook 可绕过全部已知陷阱；验证证据链见迭代 review bundle。

## When to Apply

新 dsh 插件（工具/设置/面板/服务）、或把现有插件从 host-only 扩展到 web client、或需要暴露程序化消费面（具名 cordis service / 库 API re-export）时。

## Examples

本仓库 dsh-llm-fallbacks（package.json、scripts/setup-dsh-links.mjs、scripts/build-client.ts、src/client/、tests/support/memory-settings.ts 为可运行范例）。
