# 验证记录（profile 安装与插件配置卡运行期验证）

本文记录 `dsh-llm-fallbacks` 在**本仓库验证环境（沙箱兼容的 scratch 环境）**下已完成
的安装/运行契约验证，以及**需要在用户真实 dsh 环境执行**的验证步骤与预期结果。

> 边界声明：本仓库的验证环境受沙箱约束，**无法对运行中的 dsh 安装（真实 `$DSH_HOME`）
> 做任何写操作**，也无法操作 web 设置 GUI、发起真实模型调用或跨进程观察。因此下文
> 「已验证」仅覆盖可在工作区内完成的证据（单元/集成测试、scratch profile 装入与
> `--dump-config` 层序、构建管线）；「用户待执行」为真实环境步骤与预期，如实标注，
> 不夸大已验范围。

## 已验证（本迭代证据汇总）

### 1. 测试矩阵（单元 + 集成 + client + host gateway + 命令，18 files / 304 tests 全绿）

| 范围 | 文件 | 数量 | 覆盖契约 |
|---|---|---|---|
| host 单测（T1） | `gateway.spec.ts` | 26 | `/api/fallbacks/get|set|reset` 三端点：`get` 返回 composed（JSON 归一化省略 undefined、无 resolver）；`set` 未知键拒绝、合法 patch 写 user layer 返回新值、空/null patch no-op；`reset` 清空 user layer 返回默认 composed；无 settings 服务时 `get` 仍成功、`set`/`reset` 报清晰错误（KD-G5） |
| 单元（T2） | `selectors.spec.ts` / `chains.spec.ts` / `roles.spec.ts` / `cooldown.spec.ts` | 11 / 26 / 11 / 9 | selector 解析与 specificity（exact → `provider/*` → 角色 → default）、`provider/*` 条目保留模型 id 仅换 provider、角色规则顺序匹配（rules-only：origin/provider/model → default）、cooldown/revert（惰性过期、never 无限 TTL、只读快照） |
| 单元（T3） | `state.spec.ts` / `events.spec.ts` / `config.spec.ts` / `runtime.spec.ts` | 13 / 4 / 2 / 37 | 状态机（pendingSwitch 产生→应用→清除、appliedTurnStep 防重放、step 推进重置）、`fallbacks/switch` 事件形状与 JSON 往返、`Config({})` 恒等于默认配置（no-op 基线）、小集成 Step 6 全项 |
| 集成（T4） | `plugin.spec.ts` / `coexist-llm-retry.spec.ts` / `always-mode.spec.ts` | 19 / 4 / 5 | 端到端重集成（含 model-selection 组合的注册顺序依赖，T2）、**双插件共存顺序**（normal 先退避、预算耗尽后切换；不可重试码直切）、**always 先委托下游 + cap 在 request 边界**（ADR-2）、冷却/revert 集成、**安全阀**超限后原错误语义、组合顺序互不干扰 |
| client（T5） | `fallbacks-store.spec.ts` / `fallbacks-card.spec.tsx` / `general-row.spec.tsx` | 74 / 15 / 9 | 卡片读写经 **gateway 通道**（`/api/fallbacks/get|set|reset` 的 rpc mock：`load` 从 `get` 取配置、`save` 走 `set`、`resetToDefaults` 走 `reset`）、`present` 标志与通道不可达骨架、describe 仅读 writable+其它命名空间（fallbacks 命名空间不再出现在 describe）、KD-G3 新错误路径（revision guard 移除后错误如实呈现）、draft 仅从真实 get 结果 seed（I-1 不变式）、chain/rule 行编辑往返、状态块最近切换提取（sessions.history 事件面）、卡片 chrome（插件配置页列表、折叠/展开、dirty/保存/丢弃）、controller 生命周期；General 页状态行（`settings.general.item` 注册形状 id `fallbacks` order 100、启用徽标 + 最近切换摘要、KD-G5 不可达不冒充 disabled、惰性首读与已读不重读） |
| 命令（AC-5） | `command.spec.ts` | 24 | `/fallbacks` 注册形状（name/description/空 hint/handler、disposer 透传）、条件 `commands` 子注入（有注册表才注册；无服务静默）、快照构建（角色/链解析含 default 兜底、最近切换最新在前封顶、冷却只读快照）、输出状态（配置链 / 无链 / 切换有+无 / 冷却有+无 / never 不回主）、zh/en 渲染 smoke、真实运行状态集成（切换事件 + 冷却读自真实状态、只读不增状态） |
| 回归 | `skeleton.spec.ts` / `host-native.spec.ts` | 3 / 3 | bundle 契约（row id、空 schema 接受、host+client apply 入口）；宿主原生行为基线（真实 `@deepseek-ai/dsh-agent` 模块：触发码切换路由到链目标、always-cap 第二返回点、no-op 不变量） |

结果：**18 files / 304 tests 全绿**（`pnpm test`，vitest run）；`pnpm build`（tsdown host bundle →
`pnpm run build-client`（tsdown client bundle）→ `tsc` 声明）全绿——dev 链接 farm 下 `tsc` 按
真实宿主类型面驱动（`scripts/setup-dsh-links.mjs` 链接，无任何仓内类型 shim）。no-op 回归
不变量（空链 / 未命中 / 链耗尽 / 安全阀超限 → 透传、不产生 `fallbacks/switch` 事件）由
T3/T4 测试持久断言。

### 2. bundle 层序（scratch profile `--dump-config` 实证）

在**工作区内 scratch profile**（`DSH_HOME=<插件仓库>/.dsh-verify`，验证后删除）上：

```
$ dsh plugin --profile verify add <插件仓库>
  → profile 初始化；`dsh.profile.bundles` = ["@deepseek-ai/dsh-base", "dsh-llm-fallbacks"]
    （reconcile 追加到列表末尾，符合「add 默认追加」语义）
$ dsh --profile verify --dump-config
  # == @deepseek-ai/dsh-base
  - id: llm-retry            ← llm-retry 位于 dsh-base 层内
  ...
  # == dsh-llm-fallbacks
  - id: llm-fallbacks
    name: dsh-llm-fallbacks
    config: {}
```

`llm-fallbacks` 作为**独立层插在 dsh-base（含 llm-retry）之后**——即 waterfall 注册
顺序满足「llm-retry 之后介入」的硬性要求（对应 [docs/install.md](docs/install.md)
bundle 层顺序一节；真实 web profile 层序 `dsh-base → dsh-web-app → @mstar-harness/dsh
→(add) dsh-llm-fallbacks` 同理，`add` 追加到末尾即满足）。

### 3. 运行契约（以测试证据支撑）

- **切换可见性**：任何切换（含 always-cap 路径）产生 `fallbacks/switch` 事件（T3 事件
  形状 + T4 集成断言；spec 硬性要求「无事件即无切换」）。
- **回滚/失败语义**：链耗尽 / 安全阀超限 / 无匹配链 / 角色解析失败 / 未命中 triggerCodes
  → `next()` 透传，原错误码与 message 原样保留（T3/T4 断言）。
- **卸载无残留**：`agent/disposed` 删除、`agent/status` idle 防御清理、`ctx.effect`
  dispose 清空（T3 断言）。
- **真实类型契约**：类型层不走手写 `peer-stubs/`——`scripts/setup-dsh-links.mjs` 从 dsh 源码树
  （`$DSH_SOURCE_DIR` → `${DSH_HOME}/source/current` → `~/.dsh/source/current`）把真实
  `@deepseek-ai/*` 包（全树，除 bin 工具包）链接进 `node_modules/`，并生成 vendored cordis 的
  bin-less shim（`import 'cordis'` 与真实包解析到同一物理文件，`Context`/`Events` 实例一致）；
  `tsc` 与集成测试（`tests/support/harness.ts` + llm-retry-stub + model-selection-stub）按真实
  类型面驱动。运行时缝走真实实现：`installSettingsSection` 挂真实 `@deepseek-ai/dsh-settings`
  （内存 provider `tests/support/memory-settings.ts`，继承真实 `Settings` 基类），
  `createSnapshotStore` 用真实 store 引擎（vitest alias 指向 dsh 源码树 `store.ts` 源）。
  插件对 dsh 源码树**零本地修改**——安装 = bundle 行插入（`bundle/cordis.patch.yml`）+ client
  inject（`dsh.client.inject`）+ 自有 gateway 通道；dsh 升级无需重打任何补丁（纯挂载语义）。

## 用户待执行（真实环境步骤与预期）

> 以下步骤需在**真实 dsh 环境**（有 `$DSH_HOME` 安装、可操作 web GUI、可发起真实模型
> 调用）执行；路径一律以 `$DSH_HOME` / `$DSH_SOURCE_DIR` 表达，不依赖本地绝对路径。

### 1. 真实 profile 装入

```sh
cd <插件仓库目录>
pnpm install          # prepare 自构建（pnpm 工具链）
dsh plugin --profile web add .
dsh --profile web --dump-config   # 组合树末尾应出现 # == dsh-llm-fallbacks 层
```

**预期**：`dsh.profile.bundles` 末尾追加 `dsh-llm-fallbacks`（在 `@deepseek-ai/dsh-base`
之后）；`--dump-config` 中 `llm-fallbacks` 层出现在含 `llm-retry` 的 dsh-base 层之后。
然后重启 dsh web 会话使 host 半与 client 半加载。

### 2. web 插件配置卡验证

1. 打开 web 设置 GUI → Settings → 插件配置，确认出现 **Fallbacks 卡片**（与 bash / agent-loop / web-search / advisor 卡同列表）。
2. **首次打开（尚无 `fallbacks` 配置）**：卡片显示骨架（卡片头 / 介绍 / 只读状态块 /
   功能级开关 / 保存 / 恢复默认），功能级开关 `enabled` **默认 OFF**，配置表单主体隐藏、
   显示「功能未开启」提示——卡片始终可用，不因命名空间缺失而空白。
3. 打开 `enabled` 开关 → 配置表单主体出现（`triggerCodes` / `chains` / `roles` /
   `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`）。
4. 编辑任一字段（如把 `cooldownMs` 改为 `600000`）并保存。
5. **预期**：保存成功、无冲突横幅；`$DSH_HOME/settings.yaml`（或该 profile 的 settings
   路径）写入新值（含 `enabled: true`）；再次进入页面显示已保存的值、开关保持 ON，
   revision 正常（并发修改时出现冲突横幅 +「重新加载」按钮，不静默覆盖）。
6. 关闭 `enabled` 开关 → 表单主体再次隐藏（编辑中的 draft 保留，重新打开仍在）；
   一键「恢复默认」后确认配置回组合默认值（`enabled` 回 `false`）。

### 3. 运行期 fallback 验证（模拟失败）

1. 在 `fallbacks` 命名空间配置 demo 链：`chains.default` 指向一个**备用模型**
   （如 `openai/gpt-4o-mini`），把主模型（如 `deepseek/deepseek-chat`）的密钥配错或
   把链指向不存在的 provider，构造**不可重试失败码**（`AUTH` / `QUOTA` 路径，不经退避
   直达插件）。
2. 发起一个请求触发失败。
3. **预期**：
   - 日志出现本插件 info 级记录（候选尝试顺序与跳过原因）；
   - 会话事件流追加 `fallbacks/switch`（from/to/role/reason）；
   - 请求在备用模型上继续，当前 step/turn 不中断。
4. 可重试码路径（`RATE_LIMIT` / 5xx）：配置 `triggerCodes` 含 `RATE_LIMIT`，观察
   llm-retry 先退避、预算耗尽后进入链决策——确认层序正确（fallback 未抢占退避）。

### 4. QA gate 端到端验证剧本（插件配置卡读写闭环 + 保存即生效 + 切换路由 + 状态块）

> 本节为 QA gate 阶段的 **mandatory 输入**：在真实 dsh 环境（`$DSH_HOME` 安装、web
> profile、可操作 web 设置 GUI、可发起真实模型调用）按步骤执行并记录结果。路径一律
> 以 `$DSH_SOURCE_DIR` / `$DSH_HOME` 表达，不含本地绝对路径。4.2 的「保存即生效」
> 以 4.1 记录的 host **PID + 启动时间基线**为锚（同 PID、同启动时间、不重载页面）。

#### 4.1 环境准备（新快照基线）

1. **前置核对**：`$DSH_SOURCE_DIR`（缺省 `${DSH_HOME}/source/current`）是 git 树；
   记录 `dsh --version`（快照）。插件侧 dev 链接 farm 需指向该树——插件仓库内重跑一次
   `pnpm dsh:link`（重链后插件的 tsc 按真实宿主类型复验）。
2. **插件构建**：`cd <插件仓库目录> && pnpm build`（host bundle + client bundle + tsc
   声明）绿——纯挂载语义：不修改 dsh 源码树、无任何补丁步骤；设置读写走插件 gateway
   通道（`/api/fallbacks/get|set|reset`），安装即用。
3. **重启 `dsh web`（web profile）**：停止旧 host 进程 → 以 web profile 启动 `dsh web`
   （--dev 不可用时重建 web artifacts 后刷新验证 URL）。
4. **记录基线**：`ps -o pid,lstart -p <dsh-web-pid>`（或 `pgrep -fl "dsh web"` 定位）——
   **PID + 启动时间**作为 4.2「不重启 host」对照锚点；同时记录 `$DSH_HOME/settings.yaml`
   当前 `fallbacks:` 段状态（应为无该段，或 `enabled: false`）。

#### 4.2 插件配置卡读写闭环（保存即生效，AC-1）

1. 打开 web 设置 GUI → Settings → **插件配置** → **Fallbacks 卡片**。
2. **预期①（gateway 通道生效）**：卡片渲染骨架（卡片头 / 介绍 / 只读状态块 /
   `enabled` 开关 / 保存 / 恢复默认）——配置读写经插件 gateway 通道
   （`/api/fallbacks/get|set|reset`），不依赖 dsh 本体的任何设置暴露机制（`fallbacks`
   命名空间不出现在 describe 暴露集合属预期设计）；`get` 成功则 `present`，
   通道不可达时显示可操作骨架而非死页。
3. 开启 `enabled` 开关 → 配置表单主体出现（`triggerCodes` / `chains` / `roles` /
   `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`）。
4. **目录选择添加链**：在 `chains` 行编辑的 provider/model **下拉（模型目录）**中选择
   目标添加一条链条目（如 `default` 链 → 目录内存在的备用 `provider/model`）；`roles.rules`
   行编辑同理（可选）。新行只提供目录内选项，目录外值以合成选项标注保留。
5. **保存** → UI saving → ready（`save` 经 `fallbacks/set` 写 user layer；`set` 为
   merge 语义，无 revision guard——并发修改不再有冲突横幅，错误一律如实横幅呈现）。
6. **磁盘证据**：`$DSH_HOME/settings.yaml` 出现 `fallbacks:` 段且与保存值一致
   （`enabled: true` + 添加的链行）。
7. **立即生效证据（AC-1 核心）**：**不重启 host、不重载页面**——先确认 host PID/启动
   时间与 4.1 基线一致（`ps -o pid,lstart -p <pid>`），再触发一次触发码故障（4.3 方法
   注入，如 AUTH/QUOTA）→ 预期：
   - 日志出现 `llm-fallbacks: agent ... switch`（info 级，候选尝试顺序与跳过原因）；
   - 会话事件流追加 `fallbacks/switch` 事件（from/to/role/reason/time）；
   - 后续请求路由到链目标（provider/model 变为链首目标），当前 step/turn 不中断。
   → **保存后下一次故障即切换 = 无需重启会话**。
8. **读回证据**：重载页面 → 经 `fallbacks/get` 显示服务端真值（`enabled` 保持 ON、
   链行在）；
   状态块出现步骤 7 的切换条目（AC-7，见 4.3）。
9. **反证控制**：若步骤 7 显示**需重启 host 才生效** → 如实记录（附 PID/启动时间变化
   证据），并回写 compass/spec 产品承诺（Global Constraint 兜底条款）。

#### 4.3 切换路由 + 状态块（AC-2 / AC-7）

1. **故障注入**：配置 demo 链（`chains.default` 指向备用模型）；把主模型密钥配错或把
   链指向不存在的 provider 构造**不可重试失败码**（`AUTH` / `QUOTA`，不经退避直达插件）；
   可重试码路径（`RATE_LIMIT` / 5xx）观察 llm-retry 先退避、预算耗尽后进入链决策。
2. **预期**：日志 `llm-fallbacks: agent ... switch` + `fallbacks/switch` 事件 + 请求在
   链目标上继续、当前 step/turn 不中断（对应 §3 运行期验证）。
3. **活跃 model-selection 下（文档化降级，T2 结论）**：存在活跃 model-selection（用户在
   设置页 / `settings.yaml` 选择了 provider/model）时，触发码故障后的切换**仍然发生并记录**；
   但该步的路由可能被外层 model-selection 监听器重新套用（web 前端手动选择的模型在切换后
   重新应用）——这是去掉本地 patch 标记协调后的**宿主原生行为**，插件配置卡含一行降级说明
   （`status.selectionNote`，zh/en）。request-error 触发链不受影响；无活跃 selection 时路由
   到链目标。规格与 guides 记录见 `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/role-and-model-selection-exploration.md`
   （Model-selection 节）。
4. **状态块条目（AC-7）**：插件配置卡状态块出现该切换条目（from/to/role/reason/时间，
   「最近切换」列表、最新在前）；「当前生效模型」为**推导值**（配置 + 最近切换），
   附非实时探测说明文案。摘要随 `settings/document-updated`（fallbacks 命名空间）/
   `llm/adapters-updated`（仅目录）/ 会话切换 / 连接重置推送刷新——切换发生在页面打开期间时，
   经重载页面（或下一次推送）后呈现，无需重启 host。
5. **会话内诊断（AC-5）**：在同一会话键入 `/fallbacks`，输出应含会话来源（root/subagent）、
   解析角色、解析链（含 default 兜底标注）、最近切换（最新在前，from/to/role/reason）与冷却
   状态；命令只读，不改变任何 fallback 状态。

#### 4.4 无回归抽查

1. **默认配置 no-op**：`fallbacks.enabled` 关回 `false`（或未配置状态）→ 触发同类故障 →
   无切换、无 `fallbacks/switch` 事件，请求行为与未安装插件一致。
2. **目录外值读回保留**：手写一个目录外 selector（如 `provider/legacy-model`）保存 →
   重载页面仍显示该值（合成选项标注「目录外」），未被目录选择丢弃。
3. **并发修改行为抽查（可选）**：另一会话/直接编辑 `settings.yaml` 后保存 → 错误横幅
   如实呈现保存结果，不静默覆盖（gateway `set` 无 revision guard，冲突保护退化为
   「错误如实呈现」，KD-G3）。

#### 4.5 结果记录

- 以表格记录：步骤 / 预期 / 实际 / 证据（日志行、`settings.yaml` 片段、截图、PID 基线）。
- 任一步与预期不符 → 记录为 QA finding（severity + 复现步骤），如实回报，不回写
  「已验证」。

## 已知限制（沙箱无法覆盖的真实运行面）

| 面 | 未覆盖原因 | 验证归属 |
|---|---|---|
| web 设置 GUI 交互（卡片出现、编辑保存、冲突重载） | 沙箱无法操作真实 web 会话 | 用户待执行 §2 / §4（client 半逻辑已由 T5 89 例测试覆盖） |
| 真实模型调用与失败注入（AUTH/QUOTA/RATE_LIMIT 触发、切换继续） | 沙箱无真实模型凭据与运行中会话 | 用户待执行 §3 / §4（决策逻辑已由 T3/T4 集成测试覆盖） |
| 跨进程观察（日志、`fallbacks/switch` 会话事件在真实会话中的落地） | 沙箱无法运行真实 dsh 会话 | 用户待执行 §3/§4 |
| `/fallbacks` 命令在真实会话中的输入输出 | 沙箱无法运行真实 dsh 会话与命令注册表 | 用户待执行 §4.3 步骤 5（命令逻辑已由 command.spec.ts 覆盖） |
| 活跃 model-selection 下的真实路由复写（文档化降级） | 沙箱无真实 web 会话与模型选择 | 用户待执行 §4.3（组合顺序已由 T4 集成测试覆盖） |
