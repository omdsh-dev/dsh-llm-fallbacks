---
module: dsh-tui-client-seams
date: 2026-08-16
last_updated: 2026-08-20
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: fallbacks-tui-settings
applies_when:
  - 为 dsh 编写第三方插件并需要 dsh-tui（终端 TUI profile）中的一等公民 client 面
  - 需要在 TUI `/` 菜单提供本地化描述 / 子命令补全
  - 需要让插件设置在 TUI `/settings` 屏可编辑（写面）
  - 需要判断插件在 dsh-tui profile 的可加载性与设置面形态
---

# dsh-TUI client seams（终端前端的插件挂载点）

dsh-tui（`dsh --profile dsh-tui`）是 dsh 的终端前端。插件在其上的 client 面与 web
profile 完全不同：**无 web client bundle 渲染、无 typert gateway**；设置面 = `/settings`
聚合屏 + `tuiSettingsSections` 声明式接缝（2026-08-17 起，issue #165 / PR #238）。
本 doc 是源码核实的 seam 地图（初版 2026-08-16 @ 557a27a = 0.6.1；2026-08-20 更新至
`main` 2747b87 = v0.8.6-5，settings seam 语义核实），与 web 向的
`.mstar/knowledge/architecture-patterns/dsh-mount-point-map.md` 互补。

## Seam 一览

| Seam | 形态 | 插件用途 | 备注 |
|------|------|----------|------|
| `tuiCommandTrees` | cordis Service（`name = 'dsh-tui-command-trees'`） | root 行本地化描述 + 子命令补全（`/fallbacks` 树） | 结构类型本地声明即可，零依赖；重复 root 抛错 |
| **`tuiSettingsSections`** | cordis Service（`name = 'dsh-tui-settings-sections'`） | 在 `/settings` 屏声明**可编辑设置区块**（ns/title/groups/fields；text/number/boolean/select + 自定义 format/parse） | **设置写面接缝**（#165 落地）；v0.8.0 起 seam、v0.8.5 起 groups 形状（c51661f）；插件只提供元数据，保存走宿主 revision-fenced `settings.mutate` |
| command registry merge | `refreshCommandList`（channel.ts） | `/fallbacks` 类命令**自动**进 `/` 菜单 | 零插件改动；注册即浮现 |
| dsh settings service | `ctx.get('settings')` describe/get/mutate | settings 命名空间解析 + `/provider` 向导 | 写面 = `/settings` 屏（revision-fenced mutate → `~/.dsh/settings.yaml` user layer）或文件编辑 |
| profile bundle composition | `dsh plugin --profile dsh-tui add <pkg>` | 插件以 bundle layer 进 profile | 读 `dsh.bundle.patch`，零 dsh-TUI 改动 |

## 1. Bundle composition（零改动可用）

- `dsh plugin --profile dsh-tui add dsh-xxx` 读插件 `package.json` 的
  `dsh.bundle.patch`（→ `bundle/cordis.patch.yml`，`- insert: id: xxx` 行），追加为
  dsh-tui profile 的 composition layer。
- profile 持久化：`~/.dsh/profiles/dsh-tui/{package.json, node_modules, cordis.yml,
  cordis.patch.yml}`；`cordis.yml` 是「空入口树」注释（**编辑 patch 层，不编辑该文件**）。
- launcher bin/dsh-tui.js 首启自举 profile（`dsh plugin --profile dsh-tui add
  @deepseek-harness-tui/dsh-tui@<版本>`）；**版本门**：/settings seam 需 dsh-tui
  ≥ v0.8.0（01b591c），groups 形状 ≥ v0.8.5（c51661f）；旧版本 → 区块不渲染、
  /settings 退化为只读命名空间 + yaml 提示。
- 验证：`dsh --profile dsh-tui --dump-config | grep llm-fallbacks`（行在 = 组合层
  有插件，**不等于**插件加载成功）。

## 2. `tuiCommandTrees` —— 插件 TUI 指令接缝

src/dsh-adapter/command-trees.ts：

```ts
interface TuiCommandTreeProvider {
  root: string                        // 无斜杠；trim+lowercase；正则 ^[a-z][a-z0-9_-]*$
  descriptions?: LocalizedDescriptions // Readonly<Partial<Record<'zh'|'en', string>>>
  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[]
}
interface CommandCompletionNode {
  name: string; aliases?: readonly string[]
  description: string; descriptions?: LocalizedDescriptions
  tag?: string; descriptionKey?: string
}
```

- `register(provider): () => void`：非法 root → TypeError；**重复 root → throw**
  （多 fiber 组合必须首 fiber-only 门控）；disposer 移除。
- `children(canonicalPath)`：root 在 index 0；未知路径 → `[]`；provider 抛错被
  吞 → `[]`（补全永不阻塞执行）。**子命令树可深至多级叶子**（`['fallbacks','config']`
  可返回 `[revert-seed 节点]`）。
- **结构类型本地声明**：不 import @deepseek-harness-tui/dsh-tui（零新 peer）。

## 3. `tuiSettingsSections` —— 设置写面接缝（核心，2026-08-20 核实）

src/dsh-adapter/settings-sections.ts（service `name = 'dsh-tui-settings-sections'`）：

```ts
type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'
interface TuiSettingsFieldOption { value: string; label: string; descriptions?: LocalizedDescriptions }
type TuiSettingsFieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }
interface TuiSettingsField {
  path: readonly string[]   // settings.mutate path 词汇（object keys；dict keys 直名）
  label: string; descriptions?; hint?; hintDescriptions?
  group?: string            // 引用 section.groups[].id
  kind: TuiSettingsFieldKind
  options?: readonly TuiSettingsFieldOption[]   // select 用
  placeholder?: string
  secret?: { ref: string }  // 凭据接缝（字面值永不进 settings 文档）
  format?(value: unknown): string
  parse?(text: string): TuiSettingsFieldWrite | undefined   // undefined = draft 无效 → 阻止保存
}
interface TuiSettingsGroup { id: string; title: string; descriptions?: LocalizedDescriptions }
interface TuiSettingsSection { ns: string; title: string; descriptions?; groups?: readonly TuiSettingsGroup[]; fields: readonly TuiSettingsField[] }
```

- `register(section)`：ns regex `^[a-z][a-z0-9_-]*$`；重复 ns → throw；group-id regex +
  **field→group 引用校验**（未声明 group → TypeError）；返回 disposer。`list()` /
  `section(ns)` / `subscribe(listener)`（插件 un/load 时 /settings 屏实时刷新）。
- **激活门（v0.8.6+，3ff6ec1）**：`register()` 要求 live 插件激活上下文（apply() 内
  `ctx.inject` 满足）；`list()`/`section()` fiber-scoped；/settings 屏经
  `channel.settingsSections()` host wrapper 读全部区块。
- **format/parse 进程内可跑**：channel 直接传 section 对象（同进程 composition，
  无 IPC 序列化）；dsh-tui 自 section（plugin.ts:441-646）用 custom format 实证。
- **保存语义（宿主 SettingsForm）**：staged 草稿；`s` 保存 → 构建 path ops →
  `settings.mutate(ns, ops, expectedRevision)`（revision-fenced，冲突重试一次）；
  空 text/number draft → `{op:'unset'}`（重新继承组合层）——**自定义 parse 会替代
  宿主默认空 draft→clear，必须自己处理空 draft**；secret 字段走 credentials seam。
- **持久化**：`~/.dsh/settings.yaml` user layer（全局、跨 profile 共享——web 卡
  写入同一 yaml）；profile patch 层 `~/.dsh/profiles/dsh-tui/cordis.patch.yml`
  （插件行 config 覆盖，**patch 替换整行 config 而非合并**）。
- 插件侧落地模式（字段映射 / parse 复用 gateway 校验 / 版本门 / 动作能力处理）→
  **`.mstar/knowledge/best-practices/dsh-tui-settings-section-authoring.md`**。

## 4. Settings 面 —— /settings 屏 + 文件

- `/settings` 本地命令（src/commands.ts）→ `src/screens/Settings.tsx`：聚合所有
  已注册区块为可编辑表单；无声明区块的命名空间**只读展示** + `~/.dsh/settings.yaml`
  提示（与 web 前台回退一致）；Esc 逐层退出（先丢弃草稿）。
- 持久化路径同上（user layer + patch 层）；`ctx.settings.register(settingsNamespace(ns), Schema)`
  由插件注册（llm-fallbacks 的 `fallbacks` namespace 在 TUI profile 直接可用）。

## 5. 加载兼容性与活体验证法

- 插件条件注入（settings/commands/typert/tuiSettingsSections）在 TUI 组合全部安全；
  typert 缺失 → 端点静默不注册；web client bundle（`dsh.client.platform: web`）TUI 不加载。
- **活体验证流程（2026-08-16/20 实证）**：
  1. `pnpm build`（插件 dist 必须最新——profile link 指向 worktree，加载 dist）；
  2. 本地 dsh CLI 损坏时用专用安装：
     mkdir ~/.dsh-cli && cd ~/.dsh-cli && pnpm add @deepseek-ai/dsh@<版本>，
     经 node ~/.dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --profile dsh-tui
     boot（pnpm global 安装可能不物化依赖树）；
  3. `--dump-config` 确认组合行；TUI 内 `/settings`（区块 + 分组 + 编辑保存）+ `/fallbacks config`；
     保存验证：settings.yaml user layer diff + 回读一致；非法 draft 阻止保存；
  4. **交互式 TUI 需要 PTY**（ink raw mode）；subagent 内 script 非 PTY 会挂——
     QA 用 bounded PTY（hub start + scripted input，≤5min cap）或明确记 `not live-verified`；
  5. 探针插件法：--patch overlay.yml 注入探针行 + 探针包 console.error——cordis 吞子错误，
     探针是唯一可见面。
- **QA 环境坑**：交互 boot 失败 ≠ 插件问题——先复现 `dsh --profile web` 是否同样
  失败（全局 CLI 损坏 vs profile 问题）；dump-config 可用 ≠ boot 可用。

## When to Apply

- 新增 TUI client 面：`tuiCommandTrees` provider + 命令注册（先修 hint 坑）+ 文档。
- 新增 TUI 设置写面：`tuiSettingsSections` section 注册（复用 settings namespace +
  mutate 通道）+ /settings 区块；动作类能力（无 button kind）走命令。
- 判断「TUI 能否支持 X」：对照本 seam 表 + dsh-TUI 源码，不要假设 web 能力存在。
- 复用点：dsh-advisor 与 llm-fallbacks（iter-20260820-fallbacks-tui-settings）均为
  接缝消费实证；llm-fallbacks 是**首个真实第三方消费者**（/settings 区块 + 活体 QA）。

## 参考

- 迭代源码核实记录：`.mstar/iterations/iter-20260820-fallbacks-tui-settings/guides/dsh-tui-settings-seams.md`
- dsh-TUI 源码（只读参考）：`~/workspace/ai/deepseek/dsh-TUI` @ 2747b87；上游文档
  `docs/plugins.en.md` Seam 6（插件设置区块）。
