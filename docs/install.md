# 安装指南

本文介绍如何把 `dsh-llm-fallbacks` 装入 dsh profile、验证安装与卸载。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`），且其源码树在 `$DSH_SOURCE_DIR`（缺省 `${DSH_HOME}/source/current`）——**开发期类型检查与测试需要它**（见下文「真实 `@deepseek-ai/*` 链接」）。
- 构建需要 **node**（`>= 22`）与 **pnpm**（`>= 10`）——插件的 `prepare` 脚本自构建（`pnpm run build`，tsdown + tsc，pnpm 栈无 bun）。
- 目标 profile（如 `web`）可读写，安装后需要重启 dsh 会话。

## 真实 `@deepseek-ai/*` 链接 farm（开发期）

`@deepseek-ai/*` 是私有包，运行时由宿主 dsh 盒内 bundle 提供（`peerDependencies` 契约，tsdown 构建期外部化 `@deepseek-ai/*`）。开发期不再使用手写 `peer-stubs/`：`pnpm install`（`prepare` 前置）会调用 `scripts/setup-dsh-links.mjs`，从 dsh 源码树把**真实包**符号链接进 `node_modules/`——类型检查、测试与跳转全部走真实代码（方案经 dsh-advisor 全链路验证）。

- **链接范围**：源码树 `packages/` 与 `vendor/` 下所有声明 `bin` 之外的 `@deepseek-ai/*` 包（按各自 package.json 的 name），外加 `vendor/cordis` 的 **bin-less shim**（`node_modules/@deepseek-ai/cordis/` 的入口文件符号链接到 vendored cordis 的真实文件）——真实包的 `.d.ts` 引用的是 dsh 树里 vendor 的 cordis，shim 保证 `import '@deepseek-ai/cordis'` 与它们解析到同一物理文件（否则 `Context`/`Events` 类型实例不匹配，tsc 报错）。
- **路径解析**：`$DSH_SOURCE_DIR` 优先 → `${DSH_HOME}/source/current` → `~/.dsh/source/current`（取第一个存在的）——不同开发者只要各自的 `$DSH_HOME` 指向自己的 dsh 安装即可，无需改任何仓库内路径。源码树缺失或 peer 包不可链接时**报错退出并给出指引**（开发期硬性要求；宿主安装路径不受影响，见下）。
- **安全守卫**：在宿主 profile 的 pnpm store 内安装（git 依赖的 prepare/postinstall 在 `node_modules/.pnpm/` 中运行）时脚本自动跳过（exit 0），绝不把 staging 树的包链进宿主运行环境。
- **手动操作**：`pnpm dsh:link` 重链（换 `$DSH_HOME`/`$DSH_SOURCE_DIR` 后重跑）、`pnpm dsh:link:check` 校验（`--check`：链接缺失/指向漂移/过期项均报错，可用于 CI）。

## 1. 本地目录安装（推荐）

```sh
# 1) 在插件仓库目录构建（prepare 自构建，产出 dist/）
pnpm install        # 或显式 pnpm build
# 2) 装入目标 profile
dsh plugin --profile web add .
```

`dsh plugin` 会把参数转发给该 profile 目录下的 pnpm（`add`、`remove`、`why` 等均可用），并将 `dsh-llm-fallbacks` 追加到 profile 的 bundle 层列表（`dsh.profile.bundles`）。插件为**纯挂载**：安装 = bundle 行插入 + client inject（`dsh.client.inject`），**对 dsh 源码树零修改、无任何补丁步骤**；dsh 升级无需重打补丁。

### bundle 层顺序（硬性要求）

dsh 的 profile 由有序 bundle 层组合而成：`@deepseek-ai/dsh-base`（内含 llm-retry 插件）→ `@deepseek-ai/dsh-web-app` → `@mstar-harness/dsh` →（`add` 追加的）`dsh-llm-fallbacks`。

**`dsh-llm-fallbacks` 必须排在 llm-retry（`@deepseek-ai/dsh-base` 层内）之后**：插件的 `agent/request-error` 监听需在 llm-retry 之后组合，才能在重试预算耗尽（normal 模式）或 llm-retry 先委托下游（always 模式）后介入；顺序颠倒会让可重试失败先到达本插件、抢占 llm-retry 的退避。

`add` 默认追加到列表末尾即满足该顺序，无需手工改动；若手动编辑 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`，请保持 `@deepseek-ai/dsh-base` 在本插件之前。

## 2. git 安装

```sh
dsh plugin --profile web add github:dsh-external/dsh-llm-fallbacks   # 钉 commit：加 #<sha>
# 等价完整 URL 形式（或加 #<branch|tag|commit> 指定 ref）：
# dsh plugin --profile web add https://github.com/dsh-external/dsh-llm-fallbacks.git
```

git 安装注意：

- **prepare 自建**：pnpm 在安装 git 依赖时会执行包的 `prepare` 脚本（`pnpm run build`）自构建，安装机需要 node 与 pnpm；构建失败会导致装入未构建的包。
- **pnpm ≥ 10 构建放行（第一次 add 必遇）**：pnpm ≥ 10 默认不执行 git 依赖的构建脚本（含 `prepare`/`postinstall`）。第一次 `add` 会失败并打印 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，同时给出精确的包 key（`dsh-llm-fallbacks`）。把该 key 加进此 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  # $DSH_HOME/profiles/web/pnpm-workspace.yaml
  onlyBuiltDependencies:
    - dsh-llm-fallbacks
  # pnpm ≥ 10.26 也接受 allowBuilds 形式：
  # allowBuilds:
  #   dsh-llm-fallbacks: true
  ```

  然后重跑 `add`；也可交互式 `dsh plugin --profile web approve-builds` 选择放行。该放行 = 允许该包代码在安装期于你的机器上执行——建议钉 commit（`github:dsh-external/dsh-llm-fallbacks#<sha>`），防止后续 push 悄悄改变实际运行的代码。若安装未被拦截但装入后 `--dump-config` 看不到 `llm-fallbacks` 层 / 插件配置页的 Fallbacks 卡片不出现，同样先检查本项放行。确切行为以你所用 pnpm 版本的策略为准。
- **传输协议**：`github:` 简写由 pnpm 解析——通常优先 HTTPS，探测失败时退回 SSH（`git@github.com:...`）；显式 https URL 形式则固定 HTTPS。两种形式等价，`#<ref>` 钉版均支持。
- **纯挂载，无补丁步骤**：git 安装执行 `prepare`（构建）即完成——插件对 dsh 源码树零修改（bundle 行插入 + client inject + 自有 gateway），无需任何 apply/revert 脚本，dsh 升级后无需重打。

## 3. 验证安装

```sh
dsh --profile web --dump-config
```

组合配置树末尾应出现本插件的独立层：

```yaml
# == dsh-llm-fallbacks
- id: llm-fallbacks
  name: dsh-llm-fallbacks
  config: {}
```

且其**之前**的层包含 llm-retry（来自 `@deepseek-ai/dsh-base`）——层序即 waterfall 注册顺序（见上文 bundle 层顺序）。

然后**重启 dsh web 会话**（`dsh web` 或重启正在运行的会话），让 host 半与 client 半（插件配置卡）加载：

- web 设置 GUI 的 Settings → **插件配置** 页中应出现 **Fallbacks 卡片**，且**始终可用**——首次打开（尚无 `fallbacks` 配置）也渲染卡片骨架。
- 卡片可读、可编辑、可保存；功能级开关 `enabled` **默认 OFF**（关闭时隐藏配置表单主体），打开开关后显示完整配置表单；未配置任何链时行为 no-op（详见 [docs/configuration.md](docs/configuration.md)）。
- 会话内可直接键入 `/fallbacks` 查看当前会话的诊断（角色 → 链 → 最近切换 → 冷却），详见 README 的 `/fallbacks` 一节。

## 4. 卸载

```sh
dsh plugin --profile web remove dsh-llm-fallbacks
dsh --profile web --dump-config   # 确认 llm-fallbacks 层已消失
```

重启 dsh web 会话使卸载生效。卸载后插件不再介入任何请求/错误路径，已持久化的 `fallbacks/switch` 会话事件为历史记录，不受卸载影响。
