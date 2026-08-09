---
module: dsh-plugin-authoring
date: 2026-08-10
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
  - peer-stubs
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

### 类型访问（peer-stubs 模式）

- @deepseek-ai/* 不可安装：建 peer-stubs/@deepseek-ai/<pkg>/（index.d.ts 只声明消费面 + package.json {name, version, private, types}），tsconfig paths 映射（含子路径如 @deepseek-ai/dsh-session/types）。
- 运行时值 import（如 @deepseek-ai/dsh-settings 的 installSettingsSection）保持 external；vitest 用 resolve.alias 指向测试替身。
- stub 头部注明镜像的 dsh 源码 commit/日期；dsh 基线漂移会静默破坏类型面（事件形状变更尤其危险）。

### 设置与 UI

- settings 命名空间：installSettingsSection(ctx, settingsNamespace(命名空间名), Config, entry, {setSource, onChange})（参照 agent-default-model）；composition entry 作 base、用户文档作覆盖层。
- web 设置页：client 半 ctx.slots.inject('settings.section', …) 注册（name/id/order/locale-thunk label）；数据走自有 store（settings.describe/update/replace loopback + expectedRevision 冲突语义）；owner props 为空。

### 关键坑

- Config 类型 + z 类型注解的 schemastery ObjectT 输出键全 required：.default(undefined as unknown as {...}) 的 cast 类型必须与 schema 输出全等，否则 tsc -b 报 TS2345。
- cordis 插件命名导出约定：Loader 丢弃 namespace（含 inject 元数据）当存在 default export——只用 named exports。
- 配置字段默认值跨 host/client 重复硬编码会漂移：从单一 defaultFallbacksConfig 派生。

## Why This Matters

每条模式都踩过坑（registry 404、closure-factory 契约、schemastery cast、waterfall 注册顺序），按此 playbook 可绕过全部已知陷阱；验证证据链见迭代 review bundle。

## When to Apply

新 dsh 插件（工具/设置/面板/服务）、或把现有插件从 host-only 扩展到 web client。

## Examples

本仓库 dsh-llm-fallbacks（package.json、scripts/build-client.ts、peer-stubs/、src/client/ 为可运行范例）。
