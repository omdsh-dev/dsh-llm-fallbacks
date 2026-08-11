# CONCEPTS

本仓库（dsh-llm-fallbacks）领域词汇。供 `{KNOWLEDGE_DIR}` 与 AGENTS.md 引用，避免重复定义。

## dsh 插件

### dsh bundle
一个声明 `dsh.bundle.patch` 的 npm 包：以 `cordis.patch.yml` 组合层向 profile 插入插件行。后装入的 bundle 行插在内置行（如 llm-retry）之后——waterfall 监听注册顺序依赖此。
*Avoid:* plugin row / patch layer（口语混用时可接受，正式文档用 bundle）

### dsh settings slot
dsh web settings 的条目挂载契约（权威：dsh-private `packages/client/ui-settings/src/client/contract/slots.ts`）：`settings.section`（整页设置，list kind，按 order 排序；`fallbacks` 即经此挂载，order 30）、`settings.general.item`（General 页内单行）、`settings.action`（头部操作）、`settings.onboarding`（root 步骤）；`trigger`/`header`/`close` 是 single seat（chrome 文案位）。shell 零自有内容——**新增设置不改 shell**；唯一宿主侧触发点是 `SettingsRoot.tsx` `navIcon(id)`（仅 models/agent-presets 有专属图标，新 id 落齿轮）。挂载统一 `ctx.slots.inject`（非裸 register）。*Avoid:* 把「新设置要改 shell」当默认假设。

### gateway channel（插件 gateway 通道）
插件自有配置读写通道：宿主半 `GatewayService` + `@Remote` 声明 `/api/<ns>/get|set|reset`（fallbacks 即 `/api/fallbacks/*`），client 半 `connection.rpc.call('/api', '<ns>/<method>', { args })` 读写。与 `settings slot` 正交——slot 决定页面出现，gateway 决定配置数据从哪来。apiproxy wire 的 `exposedNamespaces()` 白名单对插件命名空间关闭，gateway 是 mount-only 下 web 配置读写的唯一路径；通道无版本戳（无 revision 守卫，失败走错误横幅）。*Avoid:* 把插件配置经 `settings.describe/update/replace` 读写（patch 时代路径，已删除）

### mount-only（纯挂载）
本插件交付约束：对 dsh 源码树**零本地修改**。安装 = bundle 插行 + client inject + 自有 gateway；无 `patches/`、无 autopatch/prepare 打补丁链路；升级 dsh 无需重打。*Avoid:* patch 交付 / 本地修改交付

### dsh link farm
dsh 私有 `@deepseek-ai/*` 包（未发布 registry）的开发期类型/测试解析方案：`scripts/setup-dsh-links.mjs` 从 dsh 源码树（`$DSH_SOURCE_DIR`，缺省 `${DSH_HOME}/source/current`，再缺省 `~/.dsh/source/current`）把真实包符号链接进 `node_modules/`（含 `vendor/cordis` 的 bin-less shim，保证 `import 'cordis'` 与真实包解析到同一物理文件）；运行时值 import 保持 external 由宿主 in-box 解析，测试用真实 `dsh-settings`（内存 provider）与真实 store 引擎。`*Avoid:* peer-stubs / tsconfig paths（历史方案，已移除）`

## LLM fallbacks

### fallback 链（fallback chains）
`fallbacks.chains` 配置的键→有序 selector 列表。键 specificity：exact `provider/model` → `provider/*` → 角色链 → `default`；条目 `provider/*` 表示保留失败模型 id 仅换 provider（目标 provider 无此 id 则跳过）。

### fallbacks/switch 事件
插件每次切换模型时追加的持久化会话事件（from/to/role/reason），是「行为可见」承诺的载体：无事件即无切换。

### triggerCodes
触发 fallback 决策的失败码集合，默认 `['AUTH', 'QUOTA', 'RATE_LIMIT']`（dsh 稳定失败码；注意是 `QUOTA` 不是 `QUOTA_EXCEEDED`）。重试型失败（5xx/TRANSPORT）由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策。

### documented degradation（文档化降级）
被接受的功能落差必须「非静默」呈现：替代方案有测试证明，**或**降级说明（设置页/文档）+ QA 实测证据闭环，二选一（PD-4 口径）。当前实例：model-selection 协调在 mount-only 下无可靠覆写 seam → 当步路由由监听注册顺序决定，设置页 `status.selectionNote`（zh/en）诚实标注、组合测试钉住语义。

## 已决歧义

- `QUOTA_EXCEEDED`（常见命名）→ 本插件与 dsh taxonomy 用 `QUOTA`；文档中不要混用。
- `settings slot` vs `gateway channel`：前者是**展示挂载**（页面出现在 Settings），后者是**数据通道**（配置读写从哪来）；讨论设置页时两者分开表述，不要混用。
