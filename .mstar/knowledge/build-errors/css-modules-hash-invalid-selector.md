---
module: scripts/build-client.ts (dsh-llm-fallbacks client build)
date: 2026-08-11
problem_type: build_error
category: build-errors
severity: high
symptoms: ["Fallbacks 设置页约 60% 样式从未渲染（标题/开关/字段标签/hint/chevron 丢失）", "页面呈现无层级、无间距的裸控件堆叠", "代码级 diff 审查与单元测试全部通过，视觉验收仍失败", "注入 <style> 文本 57 条规则，浏览器 sheet.cssRules 仅 20 条生效（≈35%）"]
root_cause: CSS Modules 哈希类名以数字开头（FNV-1a `8hex_local` → `.8b697c55_fieldRow`）是非法 CSS 标识符，浏览器按 CSS 规范静默丢弃整条规则；10/16 概率数字开头，导致大部分样式从未解析。
resolution_type: code_fix
plan_id: llm-fallbacks-settings-style
tags: [css-modules, hash, invalid-identifier, selector, build-client, cssom, contract-assertion]
---

# CSS Modules 哈希类名数字开头 → 浏览器静默丢弃样式规则

## Problem

`scripts/build-client.ts` 的 `hashClass()` 生成 FNV-1a 32 位哈希 `8hex_local`（如
`8b697c55_fieldRow`）。CSS 规范中**标识符不能以数字开头**，`.8b697c55_fieldRow` 是非法
选择器，浏览器静默丢弃整条规则。哈希 10/16 概率数字开头 → 约 60% 样式从未渲染，页面
呈现为裸控件堆叠，且**代码级对照无法发现**（源码正确、产物错误）。

## Symptoms

- 注入 `<style data-plugin-css="dsh-llm-fallbacks/FallbacksSection.module.css">` 文本 57 条
  规则，`sheet.cssRules` 仅 20 条（≈35%）
- 被丢弃的关键规则：`.title`、`.intro`、`.fieldLabel`、`.hint`、`.fieldRow`、`.switch`、
  `.optionRow input`、`.selectInput`（chevron）、`.iconButton`、`.banner`
- 上一轮 polish 迭代（llm-fallbacks-settings-ux-polish）视觉验收失败，根因即此

## What Didn't Work

- 代码级 diff 对照：样式源码正确，审查无法发现产物错误
- 静态文本检查：只读注入的 CSS 文本看不出问题（规则文本齐全）
- 仅扫 selector 位置的契约断言：对**声明位置**的同类篡改不设防（见下「后续坑」）

## Solution

1. **哈希前缀合法化**：`hashClass` 产物改为 `_<8hex>_<local>`（镜像宿主 ModelsSection
   `_1zfRHq_section` 形态；`_` 是合法标识符开头）。class map 与 CSS 文本出自同一 transform，
   天然一致，组件代码零改动。

```ts
// Before
const hash = fnv1a(local).toString(16).padStart(8, '0'); // "8b697c55_fieldRow" ← 非法
// After
const hash = '_' + fnv1a(local).toString(16).padStart(8, '0'); // "_8b697c55_fieldRow" ← 合法
```

2. **selector-aware 替换**：naive 全局 regex 会把**声明位置** data-URI 里的点也改写
   （`www.w3.org` → `www._0e4734df_w3._9c1df059_org`，chevron 损坏）。改为 brace-walked
   `hashSelectorTokens`，只改写 selector 位置的类名 token；`url()` 内容逐字节原样。
3. **双位置契约断言**（build-client.ts 尾部 contract 区）：
   - selector 位置：无 `.`+数字 类选择器；全部哈希类名匹配 `^[A-Za-z_][A-Za-z0-9_-]*$`
   - 声明位置：`url(...)` 内不得出现 `_<8hex>_` 篡改形态（对旧损坏产物 byte-exact 失败）
4. **浏览器 CSSOM 验证**（QA gate）：`sheet.cssRules.length == 文本规则数`；关键规则
   （title/fieldRow/switch/selectInput）生效。

## Why This Works

浏览器 CSS 解析器按 CSS Syntax 规范丢弃非法标识符开头的选择器——这是**静默**行为，无
console 警告。修复从产物源头保证合法标识符；契约断言把「产物合法性」变成构建期硬门禁
（防回归：对修复前 bundle 立即抛错，41 个数字开头选择器）；浏览器 CSSOM 验证是最后防线
（构建断言 + 浏览器行为双覆盖）。

## Prevention

- 契约断言必须覆盖 **selector 与声明位置**两类篡改形态（本 bug 两个 Warning 分别对应）
- 涉及 CSS 哈希/类名 transform 的改动，QA 至少做一次 CSSOM 规则数 == 文本规则数验证
- 视觉类迭代的验收证据不能只看代码 diff——浏览器实测（截图 + CSSOM）是必需证据
- 已知限制（记录不阻塞）：契约 regex / brace 解析对 tsdown 输出形态有耦合（单行 minify
  时会 miss），fail-loud 已具备；string/comment 内 brace 的解析是预存在的简化
