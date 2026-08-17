---
module: dsh-tui-client-seams
date: 2026-08-16
problem_type: architecture_pattern
category: architecture-patterns
severity: low
plan_id: fallbacks-tui-client
applies_when:
  - 为 dsh 编写第三方插件并需要 dsh-tui（终端 TUI profile）中的一等公民 client 面
  - 需要在 TUI `/` 菜单提供本地化描述 / 子命令补全
  - 需要判断插件在 dsh-tui profile 的可加载性与设置面形态
---

# dsh-TUI client seams（终端前端的插件挂载点）

dsh-tui（`dsh --profile dsh-tui`）是 dsh 的终端前端。插件在其上的 client 面与 web
profile 完全不同：**无 web client bundle 渲染、无 typert gateway、无插件设置页**。
本 doc 是源码核实的 seam 地图（dsh-TUI @ 557a27a = 0.6.1；profile 安装 0.5.0 时
seam 语义相同——2026-08-16 在 0.5.0 活体验证），与 web 向的
`.mstar/knowledge/architecture-patterns/dsh-mount-point-map.md` 互补。

## Seam 一览

| Seam | 形态 | 插件用途 | 备注 |
|------|------|----------|------|
| `tuiCommandTrees` | cordis Service（`name = 'dsh-tui-command-trees'`） | root 行本地化描述 + 子命令补全（`/fallbacks` 树） | 本文主角；结构类型本地声明即可，零依赖 |
| command registry merge | `refreshCommandList`（channel.ts） | `/fallbacks` 类命令**自动**进 `/` 菜单 | 零插件改动；注册即浮现 |
| dsh settings service | `ctx.get('settings')` describe/get/mutate | settings 命名空间解析 + 只读回读 | TUI 无设置页；写面 = YAML 文件 |
| profile bundle composition | `dsh plugin --profile dsh-tui add <pkg>` | 插件以 bundle layer 进 profile | 读 `dsh.bundle.patch`，零 dsh-TUI 改动 |

## 1. Bundle composition（零改动可用）

- `dsh plugin --profile dsh-tui add dsh-xxx` 读插件 `package.json` 的
  `dsh.bundle.patch`（→ `bundle/cordis.patch.yml`，`- insert: id: xxx` 行），追加为
  dsh-tui profile 的 composition layer。
- profile 持久化：`~/.dsh/profiles/dsh-tui/{package.json, node_modules, cordis.yml,
  cordis.patch.yml}`；`cordis.yml` 是「空入口树」注释（**编辑 patch 层，不编辑
  该文件**）；`package.json` `dsh.profile.bundles` 数组 + `link:` 依赖（本地目录
  安装形态）。
- launcher bin/dsh-tui.js 首启自举 profile（`dsh plugin --profile dsh-tui add
  @deepseek-harness-tui/dsh-tui@<版本>`）；registry 安装可能落后于源码
  （2026-08-16：源码 0.6.1 vs profile 0.5.0，TUI 内提示 `/update`）。
- 验证：`dsh --profile dsh-tui --dump-config | grep llm-fallbacks`（行在 = 组合层
  有插件，**不等于**插件加载成功——加载失败另见 §5）。

## 2. `tuiCommandTrees` —— 插件 TUI seam（核心）

src/dsh-adapter/command-trees.ts（0.6.1）/ lib/types/...（0.5.0）：

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
  （多 fiber 组合必须首 fiber-only 门控——镜像插件既有 `serviceOwned` dedupe）；
  disposer 移除。
- `children(canonicalPath)`：root 在 index 0；未知路径 → `[]`；provider 抛错被
  吞 → `[]`（补全永不阻塞执行）。`['fallbacks']` → 子命令节点；
  `['fallbacks', 'config']` → 叶子 `[]`。
- `descriptions(root)`：覆盖 `/` 菜单 root 行的 description。
- **结构类型本地声明**：不 import @deepseek-harness-tui/dsh-tui（零新 peer）；
  在 `src/tui.ts` 复制最小形状即可。`tests/peer-deps.test.ts` 契约不变。
- 条件注入：`ctx.inject(['tuiCommandTrees'], tctx => ...)`——服务缺失 → 子不激活
  → 干净 no-op（无 `dsh-tui-command-trees` 行的 profile 不受影响）。
- 补全机制（0.6.1 commands.ts）：token 级 canonicalPath 走查（root 后遇分隔符
  才进下一层、尾 token 前缀匹配）；补全/描述**只是 UI 元数据**，执行走
  commandService.execute(agent, '/'+name+rawInput, signal)（channel.ts:1240）。

## 3. Command registry merge —— `/fallbacks` 自动浮现

- `refreshCommandList`（channel.ts:2907-2925 / 0.5.0 同构）：`LOCAL_COMMANDS` +
  `commandService.list(target)`（external: true，`descriptions` 来自
  `commandTrees?.descriptions(name)`）；locals 赢同名冲突；commands/change +
  agent 切换时刷新。
- 输入路由（PromptInput `tryRunCommand`）：`/` 前缀 + `parseCommandName` +
  **名字在 channel.commandList 中** → commandService.execute；否则文本送模型。
- **命令注册元数据必须通过真实 `CommandRuntime` 校验**（`normalizeDefinition`）：
  `input: { hint: '' }` 抛「input hint must not be empty」（见
  `.mstar/knowledge/best-practices/dsh-cordis-plugin-authoring.md` 的 20260816 实测坑）——stub
  registry 测试会掩盖，必须活体验证。
- 活体判别：TUI 里输入 `/xxx` 若被模型当消息处理 = 命令不在 commandList。

## 4. Settings 面 —— 命名空间 + 文件，无页面

- TUI **无设置页 / 无 web client / 无 typert**；settings seam 只有 dsh settings
  service（channel.ts:2343 `/provider` 向导用它：describe/get/mutate）。
- 持久化：$DSH_HOME/settings.yaml（全局、**跨 profile 共享**——web profile 写
  的 `fallbacks:` 段在 dsh-tui 同样生效）+ profile patch 层
  `~/.dsh/profiles/dsh-tui/cordis.patch.yml`（插件行 `config` 覆盖；**patch 替换
  整行 config 而非合并**）。
- 插件 settings 命名空间（`installSettingsSection`）在 TUI profile **直接可用**
  （零代码改动）；「设置方法」= 只读回读命令（`/fallbacks config`）+ 文档指引
  文件编辑。TUI 设置写面依赖上游设置页 seam（dsh-TUI #165）。

## 5. 加载兼容性与活体验证法

- 插件条件注入（settings/commands/typert）在 TUI 组合全部安全；typert 缺失 →
  端点静默不注册（与 headless profile 相同）；web client bundle 不加载。
- **活体验证流程（2026-08-16 实证）**：
  1. `pnpm build`（插件 dist 必须最新——profile link 指向 worktree，加载 dist）；
  2. 本地 dsh CLI 损坏时用专用安装：
     mkdir ~/.dsh-cli && cd ~/.dsh-cli && pnpm add @deepseek-ai/dsh@<版本>，
     经 node ~/.dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --profile dsh-tui
     boot（pnpm global 安装可能不物化依赖树）；
  3. `--dump-config` 确认组合行；PTY boot 后发 `/fallbacks` + `/fallbacks config`，
     观察命令输出（成功 = 命令在列表 + 分发通）；
  4. 插件 apply 证据：settings.yaml 出现插件命名空间段（preset 自声明写入）；
  5. 探针插件法：--patch overlay.yml 注入探针行（`- insert: - id: probe` +
   `~/.dsh/profiles/dsh-tui/node_modules/probe/` 包），inject 子内 console.error
   注册结果——cordis 吞子错误，探针是唯一可见面。
- **QA 环境坑**：交互 boot 失败 ≠ 插件问题——先复现 `dsh --profile web` 是否同样
  失败（全局 CLI 损坏 vs profile 问题）；`dump-config` 可用 ≠ boot 可用。

## When to Apply

- 新增 TUI client 面：`tuiCommandTrees` provider + 命令注册（先修 hint 坑）+
  README dsh-tui profile 节 + 真实 TUI 会话 QA。
- 判断「TUI 能否支持 X」：对照本 seam 表 + 0.6.1 源码，不要假设 web 能力存在。
- 复用点：dsh-advisor n8（同 commit 调研）与 llm-fallbacks
  iter-20260816-fallbacks-tui-client 均按本地图实现并活体验证。

## 参考

- 迭代源码核实记录：`.mstar/iterations/iter-20260816-fallbacks-tui-client/guides/dsh-tui-client-seams.md`（含行号级引用）。
- dsh-TUI 源码（只读参考）：`~/workspace/ai/deepseek/dsh-TUI` @ 557a27a。
