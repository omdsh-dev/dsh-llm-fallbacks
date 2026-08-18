# dsh-llm-fallbacks

[English](README.md) | [中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-f69220.svg)
![dsh web](https://img.shields.io/badge/dsh%20web-compatible-4B32C3.svg)
![dsh tui](https://img.shields.io/badge/dsh%20tui-compatible-4B32C3.svg)
[![dshfind](https://dshfind.com/api/badge/omdsh-dev/dsh-llm-fallbacks?lang=zh)](https://dshfind.com/zh/plugins/omdsh-dev/dsh-llm-fallbacks?ref=badge)

dsh（DeepSeek Harness）的自动模型降级插件：当 root agent 或 subagent 的模型请求持续失败（重试耗尽、权限、配额超限、限流 429）时，按角色/模型 fallback 链自动切换 provider/model，当前 step/turn 在目标模型上继续完成——任务不因模型问题中断。

两个 dsh 前端均可用：**web** profile（设置 → 插件配置 → Fallbacks 卡片）与 **dsh-tui** 终端 profile（`/fallbacks` + `/fallbacks config`）。

## 快速开始

### 安装

```sh
dsh plugin --profile web add dsh-llm-fallbacks      # web profile（设置 → Fallbacks 卡片）
dsh plugin --profile dsh-tui add dsh-llm-fallbacks  # dsh-tui 终端 profile
```

同一个插件、两个前端——区别只在 `--profile` 参数。钉版本：加 `@<version>`。registry 安装拉取的是**已构建产物**（`dist/`），目标机无需构建。registry / git / 本地目录变体、卸载与 `--dump-config` 验证 → [docs/install.md](docs/install.md)。

### 修复旧会话（0.2.2 之前的版本）

0.2.2 之前的版本会把 `fallbacks/switch` 事件写入会话持久化日志，而新版 dsh 拒绝加载这类会话（issue #52——apply() 时的注册因插件与宿主解析到不同模块实例而无效）。如果升级后已有会话打不开，clone 本仓库并修复日志（先停 dsh）：

```sh
git clone https://github.com/omdsh-dev/dsh-llm-fallbacks.git
cd dsh-llm-fallbacks
pnpm install
pnpm repair:fallbacks-switch-logs -- --dry-run            # 预览哪些会话会被改动
pnpm repair:fallbacks-switch-logs -- --apply --backup     # 给旧事件打 ignorable 标记
```

脚本默认扫描 `~/.dsh/sessions`（可用 `--root <dir>` 覆盖），把遗留 `fallbacks/switch` 事件标记为 `ignorable: true`，宿主读路径即可重新接受该会话；每个被修复的日志保留一份 `<file>.bak`。`--apply` 必须搭配 `--backup`，且须在 dsh 停止时运行。从 0.2.2 起插件不再写 durable 切换事件，新会话无需修复。

### 最小配置

在 dsh 的设置文档（默认 `$DSH_HOME/settings.yaml`）中添加 `fallbacks:` 分节：

```yaml
fallbacks:
  enabled: true          # 功能级开关；默认关闭（false），需显式打开后生效
  rootChain:             # 全时段链：链头（第一项）必须是恰好一个官方 V4 模型
    - deepseek-official/deepseek-v4-flash   # （Flash 或 Pro，二选一）；后续条目为有序降级目标
  timeSlots:             # 可选：按墙钟时段轮换 root 生效链
    - kind: preset       # 冻结的 UTC+8 窗口；仅模型链可编辑（锁定 tz 为 Asia/Shanghai）
      preset: liang-peak # 09:00–12:00 与 14:00–18:00，每天
      chain:
        - anthropic/claude-3-5-sonnet
    - kind: custom       # 自定义窗口（可跨午夜）
      name: evening      # 可选显示名称
      start: '22:00'
      end: '02:00'
      days: [1, 5]       # 可选；缺省/空 = 每天（0=周日…6=周六）
      chain:
        - openai/gpt-4o
  roles:                 # 块 2：先声明角色，再让规则引用
    list:
      - id: reviewer     # 角色实体：id 唯一（/^[a-z0-9-]{1,32}$/）；inherit 为保留字
        persona: 代码审查子代理
        chain:
          - openai/gpt-4o-mini
        fallback: inherit-root   # 默认：角色链后追加 rootChain
    rules:               # 仅对子代理生效：规则不匹配 root 请求
      - role: reviewer   # 所有 subagent → reviewer 角色（自身链 + 继承 root）
```

未命中规则（或 root 请求）→ 内置 `inherit` → `rootChain`。`enabled` **默认关闭（`false`）**——未配置任何链时插件完全 no-op。全时段 `rootChain` 的链头必须恰好是一个官方 V4 模型（`deepseek-official/deepseek-v4-flash` 或 `deepseek-official/deepseek-v4-pro`）——设置卡与 gateway 在保存时拒绝其它链头（遗留非合规链头启动时告警并继续按 fallback-only 走原链，但无法原样保存）。完整参考（角色实体、fallback 策略、规则、selector、预设角色、分时槽预设）→ [docs/configuration.md](docs/configuration.md)。

> **升级提示（行为变更）**：已有 `fallbacks:` 配置若**未显式写 `enabled` 键**，升级后解析为 `false`——请补上 `enabled: true` 以保持插件继续生效。

### 验证

保存并重启会话后，键入 `/fallbacks`——只读的会话内诊断（来源、解析角色、链、最近的 `fallbacks/switch` 事件、冷却状态）。插件**不再写入** durable `fallbacks/switch` 会话事件（issue #52——apply() 时的注册被证伪无效），因此新切换只出现在 info 日志中，不再出现在 recent-switch 展示面；由旧版插件写入、含 `fallbacks/switch` 事件的会话，可用 `scripts/repair-fallbacks-switch-logs.ts` 修复——脚本把旧事件标记为 ignorable，会话即可重新加载（见下方「能力一览」说明）。在 dsh-tui profile 中，`/fallbacks config` 额外回读组合配置（TUI 无设置页——配置仅文件，见 [docs/configuration.md](docs/configuration.md)）。

## 能力一览

- **root / subagent 自动降级**：任意 agent 在模型故障下按链切换到下一个可用 provider/model，无需手动换模型。
- **两块制配置**：`rootChain` 管 root 代理；声明式角色实体（`roles.list`）供 `roles.rules` 引用（或内置 `inherit`）。
- **选择器里把链当主模型**：`enabled` 开启时，宿主模型选择器（web 与 TUI 一致）出现虚拟 `FallbacksChain` / `自动选择` 行——选中它即以配置的链作为 root 主模型（需要 all-day 链头合规才能成功覆盖）；选真实模型则保持 fallback-only（见 [模型选择器中的 FallbacksChain](#模型选择器中的-fallbackschain)）。
- **分时切换（Time-slot rotation）**：可选的 `fallbacks.timeSlots` 行按墙钟窗口（配置级 `tz` 时区，默认 `Asia/Shanghai`）轮换 root 生效链——四个冻结的 UTC+8 预设（`liang-peak` / `liang-valley` / `glm-peak` / `glm-valley`，窗口为代码常量、仅模型链可编辑），或自定义 `start`/`end`/`days` 窗口。第一条命中的行生效；全时段行固定最后。时段切换在**下一个** root 请求生效，日志记为**分时切换**——路由种子而非失败决策：不消耗冷却、不计入 `maxSwitchesPerStep`。失败降级保留**降级切换**文案（见 [分时槽预设（分时切换）](#分时槽预设分时切换)）。
- **派发时角色解析**：在 subagent 的首次请求上，其角色按三个阶段解析——显式（`agentPreset` 匹配已声明角色 id）→ 确定性规则（不变）→ LLM 自动匹配（从已声明角色体系中选择，`fallbacks.roleAutoMatch` 默认 `true`）。解析出的角色的链头模型注入首次请求，并以显式 `role → model` 日志行记录（不写 durable `fallbacks/switch` 事件——issue #52 停写）；设 `roleAutoMatch: false` 仅关闭 LLM 自动匹配阶段（显式 `agentPreset` 阶段仍生效——无显式角色时即复现原有仅规则行为）。设置卡总是渲染「启用角色自动匹配」开关（默认 `true`）以切换之——即使是从未声明过该键的旧配置，schema 默认值同样生效。
- **冷却与回主**：被切离/失败的模型在冷却期内不再入选；`revertPolicy: cooldown-expiry` 冷却到期后自动回主模型。
- **行为可见**：每次切换以 info 级日志行（from/to/role/reason）记录——无静默换模型。插件**刻意不写** durable `fallbacks/switch` 会话事件（issue #52——apply() 时的事件类型注册被证伪无效，含该事件的会话在 dsh 重启后拒绝加载）。由旧版插件写入、含此类事件的会话由 `scripts/repair-fallbacks-switch-logs.ts` 修复——旧事件被标记 ignorable 后，受影响会话可重新加载。
- **安全阀**：`maxSwitchesPerStep` 限制每 step 切换次数、`alwaysModeRetryCap` 限制 always 模式重试——链循环不会放大延迟。
- **无配置回归（no-op）**：`enabled` 默认关闭；未配置任何链时行为与未安装插件完全一致。

## 模型选择器中的 FallbacksChain

当 `enabled: true` 时，插件注册一个虚拟 provider **FallbacksChain**，目录中只有一行：**自动选择**。web profile 与 dsh-tui 都能看到这一行：两者共享同一个 adapter catalog，无需 TUI 设置页或宿主补丁。该行只要插件启用就可见——遗留多模型或空的 all-day 链**不会**隐藏它（只是覆盖不会生效）。

选择 **FallbacksChain / 自动选择** = 把配置的链作为 root **主模型**：root 请求路由到请求时刻生效链的第一个精确 `provider/model`，失败后由降级引擎从该链头照常沿链切换。选择任何真实目录模型则保持 v0.2.2 的 fallback-only 行为——会话模型为主，链只在它失败后介入。

**没有 `rootMode` 开关**——没有配置键、YAML 字段、设置开关或 gateway 标志。模式就是会话的 `{provider, model}` 选择本身：`FallbacksChain` = 链为主模型；任意真实模型 = fallback-only。

注意：

- **仅 root**：这一行只关乎 root 代理。subagent 的角色解析与注入不变；继承了该选择的 subagent 会话仍经链头路由——虚拟行只是薄委托，绝不是第二个路由引擎。
- **链头合规门槛**：覆盖/委托成功要求 all-day 链**链头合规**——第一项必须是恰好一个官方 V4 模型（`deepseek-official/deepseek-v4-flash` 或 `deepseek-official/deepseek-v4-pro`，即设置卡的「默认模型」面板）；后续条目（「默认降级链」）允许。禁用插件后该行隐藏（slot/链编辑不会触发注册抖动）。
- **过期选择**：行消失（插件禁用）而会话仍选中 `FallbacksChain / 自动选择` 时，会话继续把它显示为当前模型，但 `routable: false`——从目录选一个真实模型即可继续（宿主原生目录语义）。
- **能力跟随链头**：该行的模型元数据（上下文窗口、模态、推理）镜像当前生效链头；重试归属保持宽松默认——重试/失败记到被委托的真实链头，而非 `FallbacksChain` provider。完整语义 → [docs/configuration.md](docs/configuration.md)。

## 分时槽预设（分时切换）

分时槽行按墙钟窗口轮换**生效 root 链**——适合按峰谷切换模型，且不会把墙钟轮换误认为故障降级。文案严格区分：时段轮换的日志与 UI 用**分时切换**；失败降级保持**降级切换**；会话内「模型已降级」提示只出现在失败路径。

- **匹配顺序**：每个 root 请求时刻，第一条窗口包含当前时刻（按 `fallbacks.tz`，默认 `Asia/Shanghai` / UTC+8）的额外行生效——该行的模型链**取代**全时段链；无行命中则用全时段 `rootChain`。全时段行固定最后且**必选**：链头必须是恰好一个官方 V4 模型（Flash 或 Pro；后续条目允许）。
- **预设**（冻结，不可编辑窗口）：`liang-peak` = 每天 09:00–12:00 **与** 14:00–18:00；`liang-valley` = 其它所有 UTC+8 时间；`glm-peak` = 周一至周五 14:00–18:00；`glm-valley` = 其余时间。一个预设 id 对应一行；设置卡的选择器不会重复提供已添加的预设。
- **自定义行**：`start` / `end`（`HH:mm`，可跨午夜）+ 可选 `days`（0=周日…6=周六；缺省/空 = 每天）+ 模型。
- **下一请求生效**：时段边界跨越绝不打断进行中的 step——新行在下一个 root 请求生效。轮换仅挂载生效：info 日志 + 设置卡/`/fallbacks` 状态行，无 durable 切换事件。
- **设置卡**：主代理区块下分三块——**分时槽设置**（额外行：添加预设 / 添加自定义 / 删除 / 按钮或**拖拽**排序；预设行只读展示窗口摘要、仅可编辑模型链；自定义行带可编辑名称；**时区选择器**在此区块内，只要存在预设行就**锁定 Asia/Shanghai**——预设窗口是冻结的 UTC+8 常量）、**默认降级链**（all-day 链，可配置的 provider/model 选择器列表）与**默认模型**（官方 V4 Flash | Pro 二选一链头）。行可折叠为「名称 + 首个模型」。没有 `timeSlots.enabled` 总开关（添加行即开启），也没有 `rootMode` 控件。

## 预设角色（Preset roles）

插件内置 **7 个通用子代理角色**，开箱即用——`designer` / `librarian` / `reviewer` / `scout` / `security-reviewer` / `sonic` / `task`——`apply` 时自动以 seeded `roles.list` 行（`{ id, persona }`）声明：幂等，且绝不覆盖 operator 同名 persona。它们出现在设置卡的 seed 徽标（id 不可改）与 `/fallbacks config` 的角色摘要中，可直接被 `roles.rules` 引用。

- **开关**：`fallbacks.presets`——`'bundled'`（默认）在 apply 时声明预设角色；`'none'` 关闭自动声明（已物化行保留）。
- 完整语义（升级行为、冲突处理、`presetRoles` 库复用）→ [docs/configuration.md](docs/configuration.md)。

## 纯挂载（零 dsh 修改）

插件以**纯挂载**方式安装：bundle 行插入 + client inject + 自有 gateway 通道（`/api/fallbacks/get|set|reset`）——无 dsh 补丁、无 postinstall 步骤，dsh 升级永不需重打。旧版打补丁安装遗留的补丁无害。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | profile 安装（web + dsh-tui）/ registry / git / 本地目录变体 / 卸载 / `--dump-config` 验证 |
| [docs/configuration.md](docs/configuration.md) | `fallbacks` 命名空间全字段、selector 语法、示例 YAML、插件配置卡使用、TUI 回读、行为说明、预设角色 |
| [docs/consumer-api.md](docs/consumer-api.md) | 开发者消费契约：库 API + 具名 `llm-fallbacks` service + 角色 seeds、导出清单、生命周期、类型说明 |
| [docs/release.md](docs/release.md) | 发布流程：Trusted Publishing 前置、Release prep SOP、fragment 格式、回滚 |
| [docs/verification.md](docs/verification.md) | 验证记录（测试矩阵、bundle 层序、运行契约、QA gate 剧本） |

## 许可

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。版权与许可条款以 LICENSE 文件为准。
