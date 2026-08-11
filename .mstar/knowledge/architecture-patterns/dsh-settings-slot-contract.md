---
module: dsh web settings (dsh-private host)
date: 2026-08-11
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: llm-fallbacks-settings-style
applies_when: ["为 dsh web 添加新设置页/设置条目/头部操作", "判断某设置能力是否可经 slot 挂载而无需改 shell", "评估为 section 提供专属导航图标"]
tags: [dsh, settings, slots, ui-settings, plugin, shell, navIcon]
---

# dsh Web Settings slot 契约（挂载新设置条目，不改 shell）

## Context

dsh web settings 是**纯组合面（shell 零自有内容）**——所有条目通过 slot 注册进来，契约的
权威定义在 dsh-private `packages/client/ui-settings/src/client/contract/slots.ts`。契约设计
意图原文："A feature owns its settings surface — adding a setting never means editing the
shell"（新增设置永远不用改 shell 本体）。本仓库 Fallbacks 设置页即经 `settings.section`
（id `fallbacks`，order 30）挂载。

## Guidance

可挂新条目的 slot（按形态选择）：

| Slot | 用途 | 注册项要点 |
|------|------|-----------|
| `settings.section` | 一整页新设置（主入口；`kind: 'list'`，导航行 + 内容页按 order 排序） | `id`（导航 key + `only` 过滤键）、`order`、`label`（注册方本地化）、`locale`、可选 `inject`/`children` |
| `settings.general.item` | General 页内单行偏好项 | 由 ui-settings-general GeneralSection 在 children 声明；类型在 locale 包 `settings-contract.ts` |
| `settings.action` | 内容列头部、Close 前的操作列表（如「打开配置文件」） | — |
| `settings.onboarding` | root 级 onboarding 步骤（一次挂一个） | `order`/`stepId`/`complete`/`openSection` |
| `settings.trigger` / `header` / `close` | `single` seat（chrome 文案位）——**不是**业务条目用 | — |

```ts
// 新设置页最近范例（ui-agent-preset）——统一走 ctx.slots.inject（非裸 register）：
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'agent-presets',
  order: 20,
  label: () => ctx.locale.bind('settings.agentPreset')('nav'),
  locale: 'settings.agentPreset',
  inject: sectionInjected,
}, AgentPresetSection))
```

**注意**：
1. **导航图标硬编码 fallback**：`SettingsRoot.tsx` 的 `navIcon(id)` 只为 `models` 与
   `agent-presets` 提供专属图标；新 section id 一律落到齿轮图标（`IconSettingsOutline16`）。
   要专属图标须改宿主函数（独立决策项）。
2. **挂载走 `ctx.slots.inject`**：等待声明就绪、声明坍缩时自动移除贡献、重声明后重跑。
3. **全新插件包**需补三个注册面：`tsconfig.client.json` aggregate 引用、
   `packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` 行、`package.json` 依赖；
   **在现有包内挂**只需 register 片段。

## Why This Matters

- 设置能力边界由 slot 契约决定：**新增设置永远不需要改 shell**——评估改动范围时先查
  slots.ts，避免误判「要动宿主」而扩大范围。
- navIcon fallback 是唯一「宿主侧改动」常见触发点，提前识别可避免返工。
- inject vs register 的语义差异影响生命周期（声明坍缩/重声明），用错会留幽灵条目。

## When to Apply

- 计划新增设置页 / General 内新行 / 头部操作时
- 评估「设置能力是否需要改 dsh-private」时（先查 slots.ts，再查 navIcon）
- 新建独立插件包并挂 settings 时（补三个注册面）

## Examples

### 现有注册者（对照）

- `general`（ui-settings-general，order 0）、`models`（ui-models）、`agent-presets`
  （ui-agent-preset，order 20）、`fallbacks`（dsh-llm-fallbacks，order 30，`settings.section`）
- General 内单行：locale、theme、permission、conversation、agent-preset 均用
  `ctx.slots.inject('settings.general.item', ...)`
