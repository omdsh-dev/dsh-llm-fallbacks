---
module: scripts/build-client.ts (dsh-llm-fallbacks client build purity gate)
date: 2026-08-12
problem_type: build_error
category: build-errors
severity: high
symptoms:
  - "client bundle purity 断言只扫 require(...) 调用——被 alwaysBundle 内联的模块对它不可见"
  - "负向探针（故意值导入 3 个 type-only 对等包）构建成功：产物 94.37 kB 全内联、零 require 残留、旧断言通过"
  - "新增 type-only 对等依赖（dsh-client-ui-plugin-config 等）若被误值导入，会静默内联进浏览器可加载产物且门不报错"
root_cause: "deps.alwaysBundle 会把 CLIENT_EXTERNALS 之外的依赖全部内联——值导入的对等包根本不产生 require，旧的 require-only 文本断言（只匹配 require(\"@deepseek-ai/...\")）对「已内联的非法值导入」完全不可见；断言与内联路径错位。"
resolution_type: code_fix
plan_id: fallbacks-plugin-config-card
tags: [client-bundle, purity, alwaysBundle, resolveId, externals, build-contract, mount-only]
---

# Client bundle purity：alwaysBundle 静默内联 → require-only 断言失明（94 kB 缺口）

`scripts/build-client.ts` 的 purity 门曾只扫 `require(...)` 文本——但 rolldown 的
`deps.alwaysBundle` 会把表外依赖**内联进产物**，值导入根本不产生 `require`。负向探针实证
缺口：故意值导入 3 个 type-only 对等包构建**成功**（94.37 kB 内联产物、零 require、
旧断言通过）。修复 = resolveId 门 + 更严的 emitted-surface token 扫描。

## Problem

client 半的 bundle purity 契约：浏览器可加载产物只能值导入冻结表 `CLIENT_EXTERNALS`
（`PLATFORM_MODULES` 10 项 + `@deepseek-ai/dsh-client-runtime/client` 豁免）。旧断言
`require\(\s*["'](@deepseek-ai\/[^"']+)` 只匹配**显式 require**——对 alwaysBundle
内联的模块不可见：值导入 `@deepseek-ai/dsh-client-ui-plugin-config/client` 等对等包会被
**静默内联**（peer 自动外部化列表之外的全进 alwaysBundle），产物无 require 残留，断言
照过。这正是 Task 4 引入新 type-only 对等包时的真实风险面。

## Symptoms

- 负向探针（临时入口值导入 3 个新对等包）`pnpm build` **exit 0**，产物 94.37 kB、零
  `require("@deepseek-ai/...")`——旧门无感。
- 修复后同探针 exit 1：`client bundle purity: value import of … is not in CLIENT_EXTERNALS`。
- 门与内联路径错位：断言看「require 面」，内联走「模块图面」，两者对不上。

## What Didn't Work

- **require-only 文本扫描**：只覆盖外部化 require，内联模块对它不可见（根因）。
- **依赖「type-only import 必被擦除」的假设**：import type 确实擦除，但一旦某处写成
  值导入（含嵌套依赖内部的值导入），擦除假设失效且无检测。

## Solution

1. **resolveId 纯度插件**（`dsh-client-bundle-purity`，`scripts/build-client.ts` 内联
   rolldown 插件）：`resolveId(source)` 命中 `@deepseek-ai/*` 且不在 `CLIENT_EXTERNALS`
   → **抛错**。模块图构建期拦截，覆盖直接、嵌套内联依赖、动态 import fallback、字面量
   `require(...)`（均达 resolveId）。
2. **emitted-surface token 扫描升级**：`/@deepseek-ai\/[\w./-]+/g` 全 token 扫描，严格
   超集——现在能捕获内联模块（闭合 94 kB 缺口）与 peer 自动外部化 require
   （`dsh-client-locale` 等）。当前产物每个命中 token 都在表内。
3. 表格与 plan 文档同步：`PLATFORM_MODULES` 10 项实测对齐 `web/src/platform.ts:8-15`
   （补 `@deepseek-ai/dsh-client-ui-attachment`；`cordis` vs `@deepseek-ai/cordis` 双名
   注记——shim 名与宿主名同表）。

```ts
// build-client.ts（示意）
{
  name: 'dsh-client-bundle-purity',
  resolveId(source: string) {
    if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
      throw new Error(`client bundle purity: value import of ${source} is not in CLIENT_EXTERNALS`)
    }
  },
}
```

## Why This Works

门现在建在**模块图解析面**（resolveId），与内联路径同面：任何可解析的 `@deepseek-ai/*`
值导入在构建期即抛错；token 扫描是第二道防线（含 comment 内残留的显式性）。修复为
verification-only——不改任何运行时值导入，产物面零变化。

## Prevention

- **新增 type-only 对等包后必跑负向探针思维**：问「若误写成值导入，门会不会报？」——
  本缺口就是靠负向探针实证的（pre-fix 绿 / post-fix 红成对留档）。
- 双道防线缺一不可：resolveId 门（面） + token 扫描（文本超集）。
- 已知残余（roadmap，loud-failure 接受）：token 扫描是 text-agnostic——comment/string
  命中外包名会假阳性（当前靠产物干净）；split-literal specifier
  （`'@deepseek-ai/' + 'dsh-client-ui-plugin-config'`）可同时绕过两层（非可分析 require，
  loader 期失败）；门只覆盖 `src/client/index.ts` 单入口——未来新增 client 入口需挂同
  插件。

*Source: iteration iter-20260812-fallbacks-plugin-config plan `fallbacks-plugin-config-card`
Task 4（`sdd/fallbacks-plugin-config-card/task-4-report.md` 负向探针 + qc 复核），
2026-08-12 compound 提升。*
