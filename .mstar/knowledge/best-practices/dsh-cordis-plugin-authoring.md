---
module: dsh-plugin-authoring
date: 2026-08-10
last_updated: 2026-08-10
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
---

# dsh 第三方 cordis 插件创作模式（已验证 playbook）

dsh-llm-fallbacks 迭代验证的 dsh 插件创作全流程（bundle 组合层 → host 半 → client 半 → 类型访问 → patch 交付）。

## Context

dsh 插件 = npm 包，package.json 声明 dsh.bundle.patch（指向 bundle/cordis.patch.yml，YAML 数组「insert: id/name/config」），经 `dsh plugin --profile <name> add .` 装入 profile（bundles 列表顺序决定加载顺序；后装 bundle 的行在 llm-retry 等内置行之后插入——waterfall 注册顺序依赖此）。@deepseek-ai/* 包未发布公共 registry（404），运行期由 dsh 宿主 in-box 解析；pnpm-workspace.yaml 需 autoInstallPeers: false。

## Guidance

### 包结构与构建

- exports：主入口、./client、./bundle/cordis.patch.yml、./package.json；files 含 dist 与 bundle。
- host 半：bun build --target node --external cordis --external '@deepseek-ai/*'（外部化 import 由宿主 in-box 解析）+ bunx tsc（d.ts）。
- client 半：closure-factory CJS bundle（window.__ModuleLoader__.load 契约），经 dshClient.inject 声明依赖；CSS-modules 需自定义 transform（类名哈希 + style 标签内联注入/卸载）+ NODE_ENV define。
- prepare 脚本自建（git 安装不跑 build；prepare 需自包含）。

### 类型访问（dsh link farm，取代 peer-stubs）

- @deepseek-ai/* 不可安装（registry 404），运行期由宿主 in-box 解析；开发期用 `scripts/setup-dsh-links.mjs`（prepare 前置；独立入口 `pnpm dsh:link` / `pnpm dsh:link:check`）从 dsh 源码树链接**真实包**到 node_modules：`$DSH_SOURCE_DIR` → `${DSH_HOME}/source/current` → `~/.dsh/source/current`（取第一个存在）。链接范围 = 源码树 `packages/`+`vendor/` 下所有**无 `bin`** 的 `@deepseek-ai/*` 包（bin 工具包会让 pnpm 往共享 dsh 树写 `.bin`，跳过）。tsconfig 无需 paths。
- **cordis 必须同物理文件**：真实包的 .d.ts 引用 dsh 树 vendor 的 cordis（非 npm 副本）——直接 symlink vendor/cordis 会带出它的 bin；改为生成 **bin-less shim**（`node_modules/cordis/`：package.json + index.js/index.d.ts/src 符号链接到 vendor 文件），`import 'cordis'` 两侧解析到同一 realpath，`Context`/`Events` 增广才合并（否则 TS2345 满屏）。
- 安全守卫：宿主 profile 的 pnpm store 内安装（git 依赖 prepare/postinstall 在 node_modules/.pnpm 内运行）或仓库根无 node_modules/ 时自动跳过（exit 0）——绝不把 staging 树链进宿主运行环境；源码树缺失/peer 不可链接 → 报错退出带指引（开发期硬性要求）。
- 运行时值 import 保持 external；测试缝走真实实现：`installSettingsSection` 挂真实 `@deepseek-ai/dsh-settings`（内存 provider 继承真实 `Settings` 基类，只实现 load/persist + seed 播种），client 半 store 引擎 vitest alias 到 dsh 源码树 `src/.../store.ts`（built `./client` 是浏览器 loader artifact，不可直跑）。

### 设置与 UI

- settings 命名空间：installSettingsSection(ctx, settingsNamespace(命名空间名), Config, entry, {setSource, onChange})（参照 agent-default-model）；composition entry 作 base、用户文档作覆盖层。
- web 设置页：client 半 ctx.slots.inject('settings.section', …) 注册（name/id/order/locale-thunk label）；数据走自有 store（settings.describe/update/replace loopback + expectedRevision 冲突语义）；owner props 为空。
- **设置页必须始终可用（不要死路）**：settings 的 describe 响应中 namespaces 缺失该命名空间 ≠ 页面该显示「无法读取」通知——首开无配置/命名空间未注册时也应渲染可操作骨架（标题/介绍/只读状态块/主开关/保存动作），以默认值种子展示，`writable` 跟随 describe 响应（不因缺失强制 false）。保存/恢复默认在无 view 时**省略 expectedRevision** 尝试写入（wire 契约该字段可选），host 接受→ready、拒绝→error 横幅如实呈现（不静默）。缺失状态可保留（语义为「未注册」，非死路），host 随后注册经 settings/changed 推送 → 重 describe → ready 原地升级。
- **挂载即播种 + 首个 ready 重播种**：编辑状态从 defaultFallbacksConfig 初始化（不等待 ready），`seededRevision` 保持 null 直至首个 ready 描述符以服务端真值重播种；ready 之前控件可用性由 `writable` 驱动。注意：命名空间缺失但 `writable: true` 时用户可 pre-ready 编辑，中途推送升级会用服务端真值覆盖未保存 draft——这是设计的「骨架原地升级」，注释需如实说明，勿写「ready 前不可编辑」这类过期前提。
- **功能级开关（feature master switch）模式**：用配置字段本身（如 fallbacks 命名空间的 `enabled` 字段）作页面显隐开关——OFF 时隐藏表单主体 + 显示提示（隐藏不丢弃：draft 保留、拨动即时显隐），ON 时显示完整配置界面；开关状态 = 用户配置字段（保存持久化、重载保持），不是纯 UI 本地态。默认值如需翻转（如 enabled true→false），单点改 defaultFallbacksConfig + schema。
- **配置默认值翻转的测试基准**：翻转默认值会连带破坏所有走共享 cfg() 基准的用例——把测试基准显式钉到活跃态（cfg() = { ...defaults, enabled: true, ...overrides }），只翻转显式断言默认值的用例（config.spec），并新增「默认配置 → no-op」专项用例锁定回归不变量；store 单测的缺失命名空间用例按新语义拆分（writable 跟随 / 拒绝 / 无前置写入成功 / host 拒绝）。
- **测试矩阵文档会漂移**：docs/verification.md 的用例计数在迭代中反复过期（153→163→168）——更新文档时顺手校准，或以 grep 计数为准。

### 关键坑

- Config 类型 + z 类型注解的 schemastery ObjectT 输出键全 required：.default(undefined as unknown as {...}) 的 cast 类型必须与 schema 输出全等，否则 tsc -b 报 TS2345。
- cordis 插件命名导出约定：Loader 丢弃 namespace（含 inject 元数据）当存在 default export——只用 named exports。
- 配置字段默认值跨 host/client 重复硬编码会漂移：从单一 defaultFallbacksConfig 派生。

## Why This Matters

每条模式都踩过坑（registry 404、closure-factory 契约、schemastery cast、waterfall 注册顺序），按此 playbook 可绕过全部已知陷阱；验证证据链见迭代 review bundle。

## When to Apply

新 dsh 插件（工具/设置/面板/服务）、或把现有插件从 host-only 扩展到 web client。

## Examples

本仓库 dsh-llm-fallbacks（package.json、scripts/setup-dsh-links.mjs、scripts/build-client.ts、src/client/、tests/support/memory-settings.ts 为可运行范例）。
