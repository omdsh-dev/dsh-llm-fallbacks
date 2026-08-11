# 验证记录（profile 安装、dsh patch 应用与设置页运行期验证）

本文记录 `dsh-llm-fallbacks` 在**本仓库验证环境（沙箱兼容的 scratch 环境）**下已完成
的安装/运行契约验证，以及**需要在用户真实 dsh 环境执行**的验证步骤与预期结果。

> 边界声明：本仓库的验证环境受沙箱约束，**无法对运行中的 dsh 安装（真实 `$DSH_HOME`）
> 做任何写操作**，也无法操作 web 设置 GUI、发起真实模型调用或跨进程观察。因此下文
> 「已验证」仅覆盖可在工作区内完成的证据（单元/集成测试、scratch profile 装入与
> `--dump-config` 层序、patch 只读校验与沙箱全流程、构建管线）；「用户待执行」为真实
> 环境步骤与预期，如实标注，不夸大已验范围。

## 已验证（本迭代证据汇总）

### 1. 测试矩阵（单元 + 集成 + client + host gateway，236 全绿）

| 范围 | 文件 | 数量 | 覆盖契约 |
|---|---|---|---|
| host 单测（T1） | `gateway.spec.ts` | 22 | `/api/fallbacks/get|set|reset` 三端点：`get` 返回 composed（JSON 归一化省略 undefined、无 resolver）；`set` 未知键拒绝、合法 patch 写 user layer 返回新值、空/null patch no-op；`reset` 清空 user layer 返回默认 composed；无 settings 服务时 `get` 仍成功、`set`/`reset` 报清晰错误（KD-G5） |
| 单元（T2） | `selectors.spec.ts` / `chains.spec.ts` / `roles.spec.ts` / `cooldown.spec.ts` | 11 / 26 / 10 / 9 | selector 解析与 specificity（exact → `provider/*` → 角色 → default）、`provider/*` 条目保留模型 id 仅换 provider、角色规则顺序匹配、cooldown/revert（惰性过期、never 无限 TTL） |
| 单元（T3） | `state.spec.ts` / `events.spec.ts` / `config.spec.ts` / `runtime.spec.ts` | 13 / 4 / 2 / 37 | 状态机（pendingSwitch 产生→应用→清除、appliedTurnStep 防重放、step 推进重置）、`fallbacks/switch` 事件形状与 JSON 往返、`Config({})` 恒等于默认配置（no-op 基线）、小集成 Step 6 全项 |
| 集成（T4） | `plugin.spec.ts` / `coexist-llm-retry.spec.ts` / `always-mode.spec.ts` | 18 / 4 / 5 | 端到端重集成、**双插件共存顺序**（normal 先退避、预算耗尽后切换；不可重试码直切）、**always 先委托下游 + cap 在 request 边界**（ADR-2）、冷却/revert 集成、**安全阀**超限后原错误语义、组合顺序互不干扰 |
| client（T5） | `fallbacks-store.spec.ts` | 69 | 设置页读写经 **gateway 通道**（`/api/fallbacks/get|set|reset` 的 rpc mock：`load` 从 `get` 取配置、`save` 走 `set`、`resetToDefaults` 走 `reset`）、`present` 标志与通道不可达骨架、describe 仅读 writable+其它命名空间（fallbacks 命名空间不再出现在 describe）、KD-G3 新错误路径（revision guard 移除后错误如实呈现）、draft 仅从真实 get 结果 seed（I-1 不变式）、chain/rule 行编辑往返、状态块最近切换提取（sessions.history 事件面）、controller 生命周期 |
| 回归 | `skeleton.spec.ts` / `unpatched-host.spec.ts` | 3 / 3 | bundle 契约（row id、空 schema 接受、host+client apply 入口）；未打补丁宿主降级（无 `markFallbackRouted` 不抛、路由到链目标） |

结果：**15 files / 236 tests 全绿**（`pnpm test`，vitest run）；`pnpm build`（tsdown host bundle →
`pnpm run build-client`（tsdown client bundle）→ `tsc` 声明）全绿——其中 dev 链接 farm 下的
`tsc` 由仓内 ambient shim（`src/dsh-patch-ambient.d.ts`，声明 patch 侧 `markFallbackRouted`）转绿；patch 应用 + 重建后的真实宿主类型复验归 QA gate §6（shim 中 dsh-settings 侧声明为预期死代码——设置读写已走 gateway 通道，留待 Plan B 删除整文件）。no-op 回归不变量（空链 / 未命中 / 链耗尽 / 安全阀
超限 → 透传、不产生 `fallbacks/switch` 事件）由 T3/T4 测试持久断言。

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

### 3. patch 可应用 / 可编译（迭代证据复验）

- **真实 dsh 源码树只读校验**：两个 patch（role 组）对 `$DSH_SOURCE_DIR`（真实 `$DSH_HOME/source/current`）
  `git apply --check` 均通过（只读，树保持 clean、零写入）；`--reverse --check` 在 pristine
  树上按预期失败。
- **沙箱拷贝全流程**（工作区内重建 `.dsh-patch-test/`，pre-image blob 与真实树一致）：
  `apply --check → apply（agent → tool-subagent）→ verify（role 组
  src 探针全 PASS）→ 再次 apply（幂等跳过）→ revert（逆序 tool-subagent →
  agent）→ verify --absent → verify（回滚后按预期失败）→ 重应用 + verify（闭环）` 全流程与
  幂等性复验通过；env 解析（`DSH_SOURCE_DIR` 优先、缺省 `${DSH_HOME}/source/current`）与
  `-d/--target` 覆盖生效；坏 env（`DSH_HOME=/nonexistent`）按预期报错退出 1。
- **类型正确性**（autopatch 计划修复轮）：真实 `tsc` 编译验证 cast 修正后 red→green（TS2345 原文
  复现 → exit 0），`z<Config>` 与 patch 后 `AgentOptions`（含 `role?`）双向可赋值。
- **构建管线**：`pnpm build`（host bundle + client bundle + tsc 声明）在 dev 链接 farm 下全绿——
  `tsc` 的 patch 侧类型（`markFallbackRouted`）由 ambient shim
  （`src/dsh-patch-ambient.d.ts`）补齐，运行期真相仍是被应用的 patch；patch 应用 + 重建后的
  真实宿主类型复验归 QA gate §6（设置读写经插件 gateway 通道，无需暴露 patch）。

### 4. 运行契约（以测试证据支撑）

- **切换可见性**：任何切换（含 always-cap 路径）产生 `fallbacks/switch` 事件（T3 事件
  形状 + T4 集成断言；spec 硬性要求「无事件即无切换」）。
- **回滚/失败语义**：链耗尽 / 安全阀超限 / 无匹配链 / 角色解析失败 / 未命中 triggerCodes
  → `next()` 透传，原错误码与 message 原样保留（T3/T4 断言）。
- **卸载无残留**：`agent/disposed` 删除、`agent/status` idle 防御清理、`ctx.effect`
  dispose 清空（T3 断言）。
- **真实类型契约**：类型层不再走手写 `peer-stubs/`——`scripts/setup-dsh-links.mjs` 从 dsh 源码树
  （`$DSH_SOURCE_DIR` → `${DSH_HOME}/source/current` → `~/.dsh/source/current`）把真实
  `@deepseek-ai/*` 包（全树，除 bin 工具包）链接进 `node_modules/`，并生成 `vendor/cordis` 的
  bin-less shim（`import 'cordis'` 与真实包解析到同一物理文件，`Context`/`Events` 实例一致）；
  `tsc` 与集成测试（`tests/support/harness.ts` + llm-retry-stub + model-selection-stub）按真实
  类型面驱动。运行时缝走真实实现：`installSettingsSection` 挂真实 `@deepseek-ai/dsh-settings`
  （内存 provider `tests/support/memory-settings.ts`，继承真实 `Settings` 基类），
  `createSnapshotStore` 用真实 store 引擎（vitest alias 指向 dsh 源码树 `store.ts` 源）。

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

### 2. web 设置页验证

1. 打开 web 设置 GUI → Settings，确认出现 **Fallbacks** 页（位于 Models 页之后）。
2. **首次打开（尚无 `fallbacks` 配置）**：页面显示骨架（`nav` 标题 / 介绍 / 只读状态块 /
   功能级开关 / 保存 / 恢复默认），功能级开关 `enabled` **默认 OFF**，配置表单主体隐藏、
   显示「功能未开启」提示——页面始终可用，不因命名空间缺失而空白。
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

### 4. patch 应用后 subagent 显式 role 验证

1. 应用 dsh 本体 patch（真实安装写操作，需用户执行；role 组两个 patch，幂等）：

   ```sh
   cd <插件仓库目录>
   scripts/apply-dsh-patch.sh --check   # 只读检查
   scripts/apply-dsh-patch.sh           # git apply 两 patch → 增量构建
   scripts/verify-dsh-patch.sh          # 断言 role 组标记出现在源码与构建产物
   ```

2. 重启 dsh 会话，配置 subagent 角色链：`roles.rules` 中把某 subagent（如
   `origin: subagent` 或按 provider/model 匹配）归属到独立角色链，并在 tool-subagent
   的 `agentOptions.role` 显式设置该角色。
3. **预期**：该 subagent 的模型失败走**独立链**（不被父模型链牵制）；`fallbacks/switch`
   事件与日志中 role 为显式设置值；未设置 role 的 agent 行为与 patch 前一致。
4. 回滚验证：`scripts/revert-dsh-patch.sh --check` → `scripts/revert-dsh-patch.sh`（逆序
   回滚两 patch）→ `scripts/verify-dsh-patch.sh --absent`（role 组标记消失）。

### 5. dsh 升级后重跑 patch

dsh 升级（`$DSH_HOME/source/current` 指向新 staging）会重置本体改动：升级后重新执行
`scripts/apply-dsh-patch.sh`（幂等，已应用则跳过）并 `scripts/verify-dsh-patch.sh` 确认；
上下文偏移导致冲突时脚本报错提示，需按新源码行号重新生成 patch（见
[docs/dsh-patch.md](docs/dsh-patch.md)）。

### 6. QA gate 端到端验证剧本（设置页读写闭环 + 保存即生效 + 切换路由 + 状态块）

> 本节为 QA gate 阶段的 **mandatory 输入**：在真实 dsh 环境（`$DSH_HOME` 安装、web
> profile、可操作 web 设置 GUI、可发起真实模型调用）按步骤执行并记录结果。路径一律
> 以 `$DSH_SOURCE_DIR` / `$DSH_HOME` 表达，不含本地绝对路径。6.2 的「保存即生效」
> 以 6.1 记录的 host **PID + 启动时间基线**为锚（同 PID、同启动时间、不重载页面）。

#### 6.1 环境准备（新快照基线）

1. **前置核对**：`$DSH_SOURCE_DIR`（缺省 `${DSH_HOME}/source/current`）是 git 树；
   记录 `dsh --version`（快照）与两个 patch 文件存在（插件仓库 `patches/`，role 组）。
   插件侧 dev 链接 farm 需指向该树——patch 应用并重建后，在插件仓库重跑一次
   `pnpm dsh:link`（重链后插件的 tsc 按真实宿主类型复验，替代 ambient shim，
   见下方步骤 4 的说明）。
2. **应用两 patch（幂等）**：

   ```sh
   cd <插件仓库目录>
   scripts/apply-dsh-patch.sh --check   # 只读：两 patch 状态判定
   scripts/apply-dsh-patch.sh           # 应用 agent → tool-subagent → 增量构建
   scripts/verify-dsh-patch.sh          # 4 探针（2 src + 2 构建产物）→「校验通过」
   ```

   预期：apply 输出两 patch `[skip] 已应用`（已应用）或 `== 应用 ...`（新应用），退出 0；
   verify 输出 `== 校验通过：patch 标记（role 组，期望出现）满足`。
3. **重建 dsh 受影响包**：`apply-dsh-patch.sh` 内置完成（`tsc -b` 两包 + `tsdown host`）；
   如需手动：`cd "$DSH_SOURCE_DIR" && pnpm exec tsc -b packages/core/agent
   packages/subagent/tool-subagent
   && pnpm exec tsdown --env.DSH_BUILD_FACE host`。
4. **插件构建**：`cd <插件仓库目录> && pnpm build`（host bundle + client bundle + tsc 声明）绿——
   步骤 1 重链后 tsc 按重建后的真实宿主类型复验（`markFallbackRouted` 由 patch 提供，
   替代 dev 环境的 ambient shim `src/dsh-patch-ambient.d.ts`；设置读写走插件 gateway
   通道，不依赖任何暴露 patch）。
5. **重启 `dsh web`（web profile）**：停止旧 host 进程 → 以 web profile 启动 `dsh web`
   （--dev 不可用时重建 web artifacts 后刷新验证 URL）。
6. **记录基线**：`ps -o pid,lstart -p <dsh-web-pid>`（或 `pgrep -fl "dsh web"` 定位）——
   **PID + 启动时间**作为 6.2「不重启 host」对照锚点；同时记录 `$DSH_HOME/settings.yaml`
   当前 `fallbacks:` 段状态（应为无该段，或 `enabled: false`）。

#### 6.2 设置页读写闭环（保存即生效，AC-1）

1. 打开 web 设置 GUI → Settings → **Fallbacks**（位于 Models 页之后）。
2. **预期①（gateway 通道生效）**：页面渲染骨架（nav / 介绍 / 只读状态块 /
   `enabled` 开关 / 保存 / 恢复默认）——配置读写经插件 gateway 通道
   （`/api/fallbacks/get|set|reset`），**不依赖任何设置暴露 patch**（`fallbacks`
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
   时间与 6.1 基线一致（`ps -o pid,lstart -p <pid>`），再触发一次触发码故障（6.3 方法
   注入，如 AUTH/QUOTA）→ 预期：
   - 日志出现 `llm-fallbacks: agent ... switch`（info 级，候选尝试顺序与跳过原因）；
   - 会话事件流追加 `fallbacks/switch` 事件（from/to/role/reason/time）；
   - 后续请求路由到链目标（provider/model 变为链首目标），当前 step/turn 不中断。
   → **保存后下一次故障即切换 = 无需重启会话**。
8. **读回证据**：重载页面 → 经 `fallbacks/get` 显示服务端真值（`enabled` 保持 ON、
   链行在）；
   状态块出现步骤 7 的切换条目（AC-7，见 6.3）。
9. **反证控制**：若步骤 7 显示**需重启 host 才生效** → 如实记录（附 PID/启动时间变化
   证据），并回写 compass/spec 产品承诺（Global Constraint 兜底条款）。

#### 6.3 切换路由 + 状态块（AC-2 / AC-7）

1. **故障注入**：配置 demo 链（`chains.default` 指向备用模型）；把主模型密钥配错或把
   链指向不存在的 provider 构造**不可重试失败码**（`AUTH` / `QUOTA`，不经退避直达插件）；
   可重试码路径（`RATE_LIMIT` / 5xx）观察 llm-retry 先退避、预算耗尽后进入链决策。
2. **预期**：日志 `llm-fallbacks: agent ... switch` + `fallbacks/switch` 事件 + 请求在
   链目标上继续、当前 step/turn 不中断（对应 §3 运行期验证）。
3. **活跃 model-selection 下同样生效（AC-2）**：存在活跃 model-selection（用户在设置页 /
   `settings.yaml` 选择了 provider/model）时触发故障 → 该 step 仍路由到链目标
   （fallback-routed 标记使外层 model-selection 监听器让位），下一步恢复用户选择。
4. **状态块条目（AC-7）**：设置页状态块出现该切换条目（from/to/role/reason/时间，
   「最近切换」列表、最新在前）；「当前生效模型」为**推导值**（配置 + 最近切换），
   附非实时探测说明文案。摘要随 `settings/changed` / 会话切换 / 连接重置推送刷新——
   切换发生在页面打开期间时，经重载页面（或下一次推送）后呈现，无需重启 host。

#### 6.4 无回归抽查

1. **默认配置 no-op**：`fallbacks.enabled` 关回 `false`（或未配置状态）→ 触发同类故障 →
   无切换、无 `fallbacks/switch` 事件，请求行为与未安装插件一致。
2. **目录外值读回保留**：手写一个目录外 selector（如 `provider/legacy-model`）保存 →
   重载页面仍显示该值（合成选项标注「目录外」），未被目录选择丢弃。
3. **并发修改行为抽查（可选）**：另一会话/直接编辑 `settings.yaml` 后保存 → 错误横幅
   如实呈现保存结果，不静默覆盖（gateway `set` 无 revision guard，冲突保护退化为
   「错误如实呈现」，KD-G3）。

#### 6.5 结果记录

> **历史存档（暴露机制时代，gateway 通道上线前）**：以下验收记录来自暴露 patch
> 时代（`settings.describe`/`update` + expectedRevision + 四 patch）的 QA gate，
> 仅作存档。**当前状态**：设置读写经插件 gateway 通道（`/api/fallbacks/get|set|reset`），
> 不再依赖任何暴露 patch；`apply-dsh-patch.sh` 仅剩 role 组两 patch，
> `verify-dsh-patch.sh` 为 4 探针（见 §6.1）。
>
> **验收记录（2026-08-11，用户重启后执行，双轨 in-loop 部分）**：
>
> - **AC-1 ✅ 全链路 PASS（RPC 直连，PID 23556 基线无重启）**：
>   - 读：`settings.describe` 返回 `fallbacks` 命名空间（暴露机制生效；writable: true）——此前被硬编码白名单过滤。
>   - 写：`settings.update`（expectedRevision 0→1）成功，不再 `settings-not-exposed`。
>   - 落盘：`~/.dsh/settings.yaml` 出现 `fallbacks:` 段（enabled: true + chains）——用户反馈「开启无效果」的磁盘反证。
>   - 读回：describe revision 1 返回服务端真值；同一 PID 无重启。
>   - 还原：update {enabled:false}（revision 2）——验收后恢复 no-op 默认，不干扰用户会话。
> - **AC-6 ✅**：四 patch 已应用（apply-dsh-patch.sh）+ verify 10 探针 PASS（环境准备阶段记录；暴露机制时代）。
> - **AC-2/AC-7 运行时部分（GUI 面，待用户按 §6.3 触发）**：真实故障注入会切换当前会话路由，验收后已还原 enabled:false；如需体验：重新开启 enabled + 触发一次 AUTH/QUOTA/RATE_LIMIT 故障 → 观察 `fallbacks/switch` 事件、路由到链目标、设置页状态块条目。


- 以表格记录：步骤 / 预期 / 实际 / 证据（日志行、`settings.yaml` 片段、截图、PID 基线）。
- 任一步与预期不符 → 记录为 QA finding（severity + 复现步骤），如实回报，不回写
  「已验证」。

## 已知限制（沙箱无法覆盖的真实运行面）

| 面 | 未覆盖原因 | 验证归属 |
|---|---|---|
| web 设置 GUI 交互（页面出现、编辑保存、冲突重载） | 沙箱无法操作真实 web 会话 | 用户待执行 §2 / §6（client 半逻辑已由 T5 61 例测试覆盖） |
| 真实模型调用与失败注入（AUTH/QUOTA/RATE_LIMIT 触发、切换继续） | 沙箱无真实模型凭据与运行中会话 | 用户待执行 §3 / §6（决策逻辑已由 T3/T4 集成测试覆盖） |
| 跨进程观察（日志、`fallbacks/switch` 会话事件在真实会话中的落地） | 沙箱无法运行真实 dsh 会话 | 用户待执行 §3/§4/§6 |
| 真实安装上的 patch apply → build | 对运行中 `$DSH_HOME` 的写操作被沙箱拒绝 | 用户待执行 §4/§6（可应用性已只读 `git apply --check` + 沙箱全流程验证） |
| 升级后 patch 冲突与重新生成 | 依赖真实 dsh 升级事件 | 用户待执行 §5 |
