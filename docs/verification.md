# 验证记录（Task 8 — profile 安装与运行期验证）

本文记录 `dsh-llm-fallbacks` 在**本仓库验证环境（沙箱兼容的 scratch 环境）**下已完成
的安装/运行契约验证，以及**需要在用户真实 dsh 环境执行**的验证步骤与预期结果。

> 边界声明：本仓库的验证环境受沙箱约束，**无法对运行中的 dsh 安装（真实 `$DSH_HOME`）
> 做任何写操作**，也无法操作 web 设置 GUI、发起真实模型调用或跨进程观察。因此下文
> 「已验证」仅覆盖可在工作区内完成的证据（单元/集成测试、scratch profile 装入与
> `--dump-config` 层序、patch 只读校验与沙箱全流程、构建管线）；「用户待执行」为真实
> 环境步骤与预期，如实标注，不夸大已验范围。

## 已验证（本迭代证据，T1–T8）

### 1. 测试矩阵（单元 + 集成，153 → 168 全绿）

| 范围 | 文件 | 数量 | 覆盖契约 |
|---|---|---|---|
| 单元（T2） | `selectors.spec.ts` / `chains.spec.ts` / `roles.spec.ts` / `cooldown.spec.ts` | 11 / 26 / 10 / 9 | selector 解析与 specificity（exact → `provider/*` → 角色 → default）、`provider/*` 条目保留模型 id 仅换 provider、角色规则顺序匹配、cooldown/revert（惰性过期、never 无限 TTL） |
| 单元（T3） | `state.spec.ts` / `events.spec.ts` / `config.spec.ts` / `runtime.spec.ts` | 13 / 4 / 2 / 37 | 状态机（pendingSwitch 产生→应用→清除、appliedTurnStep 防重放、step 推进重置）、`fallbacks/switch` 事件形状与 JSON 往返、`Config({})` 恒等于默认配置（no-op 基线）、小集成 Step 6 全项 |
| 集成（T4） | `plugin.spec.ts` / `coexist-llm-retry.spec.ts` / `always-mode.spec.ts` | 17 / 4 / 5 | 端到端重集成、**双插件共存顺序**（normal 先退避、预算耗尽后切换；不可重试码直切）、**always 先委托下游 + cap 在 request 边界**（ADR-2）、冷却/revert 集成、**安全阀**超限后原错误语义、组合顺序互不干扰 |
| client（T5） | `fallbacks-store.spec.ts` | 27 | 设置页描述符读/写（redactSecrets 面、expectedRevision 冲突保护、settings-conflict 状态）、chain/rule 行编辑往返、controller 生命周期 |
| 回归 | `skeleton.spec.ts` | 3 | bundle 契约（row id、空 schema 接受、host+client apply 入口） |

结果：**13 files / 168 tests 全绿**（`pnpm test`，vitest run）；`pnpm build`（tsdown host bundle →
`pnpm run build-client`（tsdown client bundle）→ `tsc` 声明）全绿。no-op 回归不变量（空链 / 未命中 / 链耗尽 / 安全阀
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

### 3. patch 可应用 / 可编译（T6 + T8 复验）

- **真实 dsh 源码树只读校验**：两个 patch 对 `$DSH_SOURCE_DIR`（真实 `$DSH_HOME/source/current`）
  `git apply --check` 均通过（只读，树保持 clean、零写入）；`--reverse --check` 在 pristine
  树上按预期失败。
- **沙箱拷贝全流程**（工作区内重建 `.dsh-patch-test/`，pre-image blob 与真实树一致）：
  `apply --check → apply → verify → 再次 apply（幂等跳过）→ revert → verify --absent →
  verify（回滚后按预期失败）→ 重应用 + verify（闭环）` 全流程与幂等性复验通过；env 解析
  （`DSH_SOURCE_DIR` 优先、缺省 `${DSH_HOME}/source/current`）与 `-d/--target` 覆盖生效；
  坏 env（`DSH_HOME=/nonexistent`）按预期报错退出 1。
- **类型正确性**（T6 修复轮）：真实 `tsc` 编译验证 cast 修正后 red→green（TS2345 原文
  复现 → exit 0），`z<Config>` 与 patch 后 `AgentOptions`（含 `role?`）双向可赋值。
- **构建管线**：`pnpm build`（host bundle + client bundle + tsc 声明）在 T1/T5 各轮全绿（T6/T7 无构建面变更）。

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

1. 应用 dsh 本体 patch（真实安装写操作，需用户执行）：

   ```sh
   cd <插件仓库目录>
   scripts/apply-dsh-patch.sh --check   # 只读检查
   scripts/apply-dsh-patch.sh           # git apply → 增量构建
   scripts/verify-dsh-patch.sh          # 断言 role 标记出现在源码与构建产物
   ```

2. 重启 dsh 会话，配置 subagent 角色链：`roles.rules` 中把某 subagent（如
   `origin: subagent` 或按 provider/model 匹配）归属到独立角色链，并在 tool-subagent
   的 `agentOptions.role` 显式设置该角色。
3. **预期**：该 subagent 的模型失败走**独立链**（不被父模型链牵制）；`fallbacks/switch`
   事件与日志中 role 为显式设置值；未设置 role 的 agent 行为与 patch 前一致。
4. 回滚验证：`scripts/revert-dsh-patch.sh --check` → `scripts/revert-dsh-patch.sh` →
   `scripts/verify-dsh-patch.sh --absent`（role 标记消失）。

### 5. dsh 升级后重跑 patch

dsh 升级（`$DSH_HOME/source/current` 指向新 staging）会重置本体改动：升级后重新执行
`scripts/apply-dsh-patch.sh`（幂等，已应用则跳过）并 `scripts/verify-dsh-patch.sh` 确认；
上下文偏移导致冲突时脚本报错提示，需按新源码行号重新生成 patch（见
[docs/dsh-patch.md](docs/dsh-patch.md)）。

## 已知限制（沙箱无法覆盖的真实运行面）

| 面 | 未覆盖原因 | 验证归属 |
|---|---|---|
| web 设置 GUI 交互（页面出现、编辑保存、冲突重载） | 沙箱无法操作真实 web 会话 | 用户待执行 §2（client 半逻辑已由 T5 27 例测试覆盖） |
| 真实模型调用与失败注入（AUTH/QUOTA/RATE_LIMIT 触发、切换继续） | 沙箱无真实模型凭据与运行中会话 | 用户待执行 §3（决策逻辑已由 T3/T4 集成测试覆盖） |
| 跨进程观察（日志、`fallbacks/switch` 会话事件在真实会话中的落地） | 沙箱无法运行真实 dsh 会话 | 用户待执行 §3/§4 |
| 真实安装上的 patch apply → build | 对运行中 `$DSH_HOME` 的写操作被沙箱拒绝 | 用户待执行 §4（可应用性已只读 `git apply --check` + 沙箱全流程验证） |
| 升级后 patch 冲突与重新生成 | 依赖真实 dsh 升级事件 | 用户待执行 §5 |
