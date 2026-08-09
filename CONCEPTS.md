# CONCEPTS

本仓库（dsh-llm-fallbacks）领域词汇。供 `{KNOWLEDGE_DIR}` 与 AGENTS.md 引用，避免重复定义。

## dsh 插件

### dsh bundle
一个声明 `dsh.bundle.patch` 的 npm 包：以 `cordis.patch.yml` 组合层向 profile 插入插件行。后装入的 bundle 行插在内置行（如 llm-retry）之后——waterfall 监听注册顺序依赖此。
*Avoid:* plugin row / patch layer（口语混用时可接受，正式文档用 bundle）

### peer-stubs
dsh 私有 `@deepseek-ai/*` 包（未发布 registry）的类型访问方案：`peer-stubs/@deepseek-ai/<pkg>/` 内只声明消费面的 `index.d.ts` + `package.json`，经 tsconfig `paths` 映射；运行时值 import 保持 external 由宿主 in-box 解析，测试用 vitest alias 替身。

## LLM fallbacks

### fallback 链（fallback chains）
`fallbacks.chains` 配置的键→有序 selector 列表。键 specificity：exact `provider/model` → `provider/*` → 角色链 → `default`；条目 `provider/*` 表示保留失败模型 id 仅换 provider（目标 provider 无此 id 则跳过）。

### fallbacks/switch 事件
插件每次切换模型时追加的持久化会话事件（from/to/role/reason），是「行为可见」承诺的载体：无事件即无切换。

### triggerCodes
触发 fallback 决策的失败码集合，默认 `['AUTH', 'QUOTA', 'RATE_LIMIT']`（dsh 稳定失败码；注意是 `QUOTA` 不是 `QUOTA_EXCEEDED`）。重试型失败（5xx/TRANSPORT）由 llm-retry 先行退避，预算耗尽后同样进入 fallback 决策。

## 已决歧义

- `QUOTA_EXCEEDED`（omp/常见命名）→ 本插件与 dsh taxonomy 用 `QUOTA`；文档中不要混用。
