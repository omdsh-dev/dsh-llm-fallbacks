# CONCEPTS

本仓库（dsh-llm-fallbacks）领域词汇。供 `{KNOWLEDGE_DIR}` 与 AGENTS.md 引用，避免重复定义。

## dsh 插件

### dsh bundle
一个声明 `dsh.bundle.patch` 的 npm 包：以 `cordis.patch.yml` 组合层向 profile 插入插件行。后装入的 bundle 行插在内置行（如 llm-retry）之后——waterfall 监听注册顺序依赖此。
*Avoid:* plugin row / patch layer（口语混用时可接受，正式文档用 bundle）

### dsh settings slot
dsh web settings 的条目挂载契约（权威：dsh-private `packages/client/ui-settings/src/client/contract/slots.ts`）：`settings.section`（整页设置，list kind，按 order 排序；`fallbacks` 即经此挂载，order 30）、`settings.general.item`（General 页内单行）、`settings.action`（头部操作）、`settings.onboarding`（root 步骤）；`trigger`/`header`/`close` 是 single seat（chrome 文案位）。shell 零自有内容——**新增设置不改 shell**；唯一宿主侧触发点是 `SettingsRoot.tsx` `navIcon(id)`（仅 models/agent-presets 有专属图标，新 id 落齿轮）。挂载统一 `ctx.slots.inject`（非裸 register）。*Avoid:* 把「新设置要改 shell」当默认假设。

### dsh link farm
dsh 私有 `@deepseek-ai/*` 包（未发布 registry）的开发期类型/测试解析方案：`scripts/setup-dsh-links.mjs` 从 dsh 源码树（`$DSH_SOURCE_DIR`，缺省 `${DSH_HOME}/source/current`，再缺省 `~/.dsh/source/current`）把真实包符号链接进 `node_modules/`（含 `vendor/cordis` 的 bin-less shim，保证 `import 'cordis'` 与真实包解析到同一物理文件）；运行时值 import 保持 external 由宿主 in-box 解析，测试用真实 `dsh-settings`（内存 provider）与真实 store 引擎。`*Avoid:* peer-stubs / tsconfig paths（历史方案，已移除）`

## LLM fallbacks

### fallback 链（fallback chains）
`fallbacks.chains` 配置的键→有序 selector 列表。键 specificity：exact `provider/model` → `provider/*` → 角色链 → `default`；条目 `provider/*` 表示保留失败模型 id 仅换 provider（目标 provider 无此 id 则跳过）。

### fallbacks/switch 事件
插件每次切换模型时追加的持久化会话事件（from/to/role/reason），是「行为可见」承诺的载体：无事件即无切换。

### triggerCodes
触发 fallback 决策的失败码集合，默认 `['AUTH', 'QUOTA', 'RATE_LIMIT']`（dsh 稳定失败码；注意是 `QUOTA` 不是 `QUOTA_EXCEEDED`）。重试型失败（5xx/TRANSPORT）由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策。

## 已决歧义

- `QUOTA_EXCEEDED`（常见命名）→ 本插件与 dsh taxonomy 用 `QUOTA`；文档中不要混用。
