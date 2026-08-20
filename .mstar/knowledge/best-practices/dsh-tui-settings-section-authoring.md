---
module: dsh-tui-settings-section-authoring
date: 2026-08-20
problem_type: best_practice
category: best-practices
severity: low
plan_id: fallbacks-tui-settings
applies_when:
  - 第三方插件需要把复杂 web 设置能力映射到 dsh-TUI /settings 屏（scalar-only seam）
  - 需要为 tuiSettingsSections 编写 section 的 fields + 自定义 format/parse
  - 需要处理「设置能力是动作而非值」（无 button kind）或验证既有设置的 UI 级检查缺口
---

# dsh-TUI settings-section authoring（tuiSettingsSections 区块编写模式）

llm-fallbacks（iter-20260820-fallbacks-tui-settings）是 dsh-TUI 设置区块接缝的**首个
真实第三方消费者**。本文沉淀把「web 卡全量设置能力」映射到 scalar-only 接缝的可复用
模式（源码核实 @ dsh-TUI main 2747b87；接缝形状见
`.mstar/knowledge/architecture-patterns/dsh-tui-client-seams.md` §3）。

## Context

- 接缝只渲染标量字段：`text | number | boolean | select`；无列表/对象编辑 kind。
- 插件只提供**元数据**（section + fields + format/parse 函数）；值读取与保存全部由
  宿主完成（`channel.settingsHost().listNamespaces()` 读值 → 保存走
  revision-fenced `settings.mutate` path ops）。
- format/parse 在插件进程内执行（同进程 composition，无 IPC 序列化）——自定义函数
  可用；但**自定义 parse 会替代宿主的默认空 draft→clear 语义**。

## 字段映射模式（复杂配置 → scalar-only seam）

1. **标量用原生 kind**：boolean（开关类）、number（数值类）、select（枚举类，
   `options: [{value, label, descriptions?}]` 必须与 schema const 完全一致）、
   text（自由字符串，如 tz）。
2. **复杂结构 → text 字段 + 自定义 format/parse**：
   - `format(value)` = 可读文本（JSON.stringify(value, null, 2) 或 join(', ')）；
     **必须守卫 `undefined`/`null` → `''`**（宿主直接调用 format 并期望 string）。
   - `parse(text)`：
     - **空/纯空白 draft → `{kind:'clear'}`**（自定义 parse 接管了宿主默认空 draft
       语义——漏掉会导致空 draft 阻断保存而非清除）；
     - `JSON.parse` 结果 `null` → `{kind:'clear'}`（语义 clear，非 set:null）；
     - 其余 → 结构校验，**非法 → `undefined`**（draft 无效 → 宿主阻止保存）；
     - **限制 draft 大小**（如 64 KiB 常量 + TextEncoder 字节检查）再 JSON.parse，
       避免大粘贴卡住进程内编辑器。
3. **parse 复用 gateway 校验器，不复制逻辑**：把现有校验函数 `export`（最小 diff），
   parse 内 `validateConfigPatch({key: tokens})` 一次调用覆盖所有语义（含嵌套路由）；
   触发 codes 这类简单数组同样走校验器（防止未来 gateway 加守则时 TUI 旁路）。
4. **分组组织长表单**：`groups: [{id, title, descriptions?}]` + 字段 `group` 引用
   （subpage 导航）；group id 与 ns 同 regex `^[a-z][a-z0-9_-]*$`，字段引用未声明
   group → 注册抛错。
5. **动作能力（无 button kind）走命令**：web 卡里的动作（如 persona revert-seed）
   用 `/fallbacks config <action> <arg>` 子命令承载（复用 service 单点真实，**不**依赖
   typert gateway RPC——TUI profile 可能无 typert 组合）；子命令补全 = tuiCommandTrees
   树深 2 级叶子。reset-to-defaults 这类 web 卡已移除 UI 的动作，默认不进 TUI。
6. **版本门**：/settings 区块需要 dsh-tui ≥ v0.8.0（seam），groups ≥ v0.8.5
   （c51661f）；文档必须写明最低版本，旧版本 → 区块不渲染、文件编辑仍是唯一 TUI 面。

## 保存语义（宿主侧，编写 parse 时对账）

- `s` 保存 → `settings.mutate(ns, ops, expectedRevision)`：revision-fenced，冲突重试
  一次；path ops 为 object keys（数组整体替换；unset 移除 user layer 键 → 重新继承
  组合层）。
- 非法 draft（parse → undefined）阻止保存并显示错误——**parse 是插件的校验闸**；
  深层语义（如 role 引用完整性）若 gateway 不拦，TUI 也不会拦（**gateway parity** 是
  声明契约；web 卡 UI 级检查是另一层，见下）。

## 已知差距（web 卡 UI 检查 vs gateway parity）

- web 卡有 UI 级预存检查（rule 角色引用存在性、role-id 格式/唯一性、tz 推导），
  gateway `validateConfigPatch` 不拦；TUI JSON 字段与 gateway 同语义
  （schema-valid 但语义可疑的配置可保存；运行时 warn-not-crash 降级）。
- 若产品要求「卡面级校验」，需把语义检查加进 gateway 校验器（**会改变 web gateway
  拒绝行为**）——属 web 设置校验 parity 决策，登记 roadmap，勿在 TUI 切片内私自加。

## 回读作为验证面

- `/fallbacks config` 只读回读是 TUI 编辑后的验证面：新增字段（timeSlots/tz/rules）
  须在回读可见；渲染 helper 先 slice 再 map（截断 cap）；**任何值不得渲染
  'undefined'**（防御手写 settings.yaml 越界值：range-guard 后再索引，如 day mask
  0-6 过滤）。

## When to Apply

- 任何带复杂配置的 dsh 插件要在 /settings 提供一等公民编辑体验。
- 判断「某设置能否在 TUI 编辑」：对照本模式 + 接缝形状；动作类 → 命令；复杂结构 →
  校验 JSON 文本字段。
- 复用点：dsh-advisor（同 seam 消费）；llm-fallbacks 实现（src/tui-settings.ts +
  commands.ts，commit 7c0a39c..455a4e4）。

## 参考

- 迭代源码核实记录：`.mstar/iterations/iter-20260820-fallbacks-tui-settings/guides/dsh-tui-settings-seams.md`
- 上游接缝形状 + 保存语义：dsh-TUI `src/dsh-adapter/settings-sections.ts` /
  `settingsEditor.ts` @ main 2747b87；`docs/plugins.en.md` Seam 6。
