# 安装指南

本文介绍如何把 `dsh-llm-fallbacks` 装入 dsh profile、验证安装与卸载。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`）；开发期类型检查与测试从 npm registry 解析 `@deepseek-ai/*@0.1.0-rc.6` peer 依赖（registry 认证令牌，见下文"认证（pnpm 11）"）。
- 构建需要 **node**（`>= 22`）与 **pnpm**（`>= 10`）——仅**本地目录安装**（开发）需要：插件的 `prepare` 脚本自构建（`pnpm run build`，tsdown + tsc，pnpm 栈无 bun）；registry 安装装的是已构建产物，目标机无需构建。
- 目标 profile（如 `web`）可读写，安装后需要重启 dsh 会话。

## 开发期 `@deepseek-ai/*` peer 解析（npm registry）

`@deepseek-ai/*` 是私有包，运行时由宿主 dsh 盒内 bundle 提供（`peerDependencies` 契约，tsdown 构建期外部化 `@deepseek-ai/*`）。开发期从 npm registry 解析真实包（`0.1.0-rc.6`）：`pnpm-workspace.yaml` 的 `autoInstallPeers: true` + 用户级 `~/.npmrc` 的认证令牌，`pnpm install` 时自动装齐 peer 依赖——类型检查、测试与跳转全部走真实代码（无本地 link farm）。

- **认证（pnpm 11）**：pnpm 11 起项目级 `.npmrc` 的凭据**不再展开环境变量**（`${NPM_TOKEN}` 失效并告警）。令牌须放**用户级** `~/.npmrc`：`@deepseek-ai:registry=https://registry.npmjs.org/` + `//registry.npmjs.org/:_authToken=<token>`（或 `pnpm config set "//registry.npmjs.org/:_authToken" <token>`）；`NPM_TOKEN` 仍为受限 scope 的只读令牌来源。
- **版本**：`peerDependencies` 钉 `^0.1.0-rc.6`（与 dlx 宿主 rc.6 对齐）；dsh 升级后同步 bump peer 版本。
- **pnpm 版本**：pnpm 11.21+（本项目栈）。11.21 起默认启用 minimum-release-age 供应链门禁，`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 是 **pnpm 自动维护**的豁免表——rc.6 整线（及 cordis 4.0.1）发布于当日，自动列入；**不要手动删除该块**：已解析锁文件在无豁免时会硬失败（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，需 `pnpm clean --lockfile` 重新解析）。
- **客户端运行时缝**：registry 包的 `dsh-client-runtime` `./client` 入口是浏览器 loader artifact（非 node 可导入），测试用本地 node-safe 双（`tests/support/snapshot-store.ts`，vitest alias）。

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

## 2. registry 安装

```sh
dsh plugin --profile web add dsh-llm-fallbacks   # 钉精确版本：加 @<version>
```

registry 安装注意：

- **构建产物，无需自建**：registry 包即已构建产物（`dist/`），目标机**不需要** node / pnpm，不存在 `prepare` 自构建。
- **无 pnpm ≥ 10 构建放行**：构建拦截（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）只针对 git 依赖；registry 包无构建脚本执行，无需 `onlyBuiltDependencies` / `approve-builds`。
- **版本**：跟随 npm dist-tag（默认 `latest`）；钉精确版本 `dsh-llm-fallbacks@<version>` 可防止后续发布悄悄改变实际运行的代码。
- **纯挂载，无补丁步骤**：registry 安装即完成——插件对 dsh 源码树零修改（bundle 行插入 + client inject + 自有 gateway），无需任何 apply/revert 脚本，dsh 升级后无需重打。

> **发布状态**：`dsh-llm-fallbacks` **尚未发布到 npm registry**——首个版本 `0.1.0-alpha.2` 待发布（发布流水线已就绪；首次发布用一次性 `NODE_AUTH_TOKEN`，Trusted Publishing 在首次发布后配置）。本节 registry 命令在首个 release PR merge 前为**预告**；当前可用的是 [git 安装](#4-git-安装当前可用)。发布流程见 [docs/release.md](docs/release.md)。

## 3. npm / pnpm 包安装（预告）

```sh
npm install dsh-llm-fallbacks   # 或：pnpm add dsh-llm-fallbacks
```

> **预告**：`dsh-llm-fallbacks@0.1.0-alpha.2` 发布后生效。包为已构建产物（`dist/`），消费面（库函数导入、具名 service）文档见 [docs/consumer-api.md](docs/consumer-api.md)。

## 4. git 安装（当前可用）

```sh
dsh plugin --profile web add github:omdsh-dev/dsh-llm-fallbacks   # 钉 commit：加 #<sha>
# 等价完整 URL 形式（或加 #<branch|tag|commit> 指定 ref）：
# dsh plugin --profile web add https://github.com/omdsh-dev/dsh-llm-fallbacks.git
```

git 安装注意：

- **prepare 自建**：pnpm 在安装 git 依赖时会执行包的 `prepare` 脚本（`pnpm run build`）自构建，安装机需要 node 与 pnpm；构建失败会导致装入未构建的包。
- **pnpm ≥ 10 构建放行（第一次 add 必遇）**：pnpm ≥ 10 默认不执行 git 依赖的构建脚本（含 `prepare`/`postinstall`）。第一次 `add` 会失败并打印 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，同时给出精确的包 key（`dsh-llm-fallbacks`）。把该 key 加进此 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  # $DSH_HOME/profiles/web/pnpm-workspace.yaml
  onlyBuiltDependencies:
    - dsh-llm-fallbacks
  ```

  然后重跑 `add`；也可交互式 `dsh plugin --profile web approve-builds` 选择放行。该放行 = 允许该包代码在安装期于你的机器上执行——建议钉 commit（`github:omdsh-dev/dsh-llm-fallbacks#<sha>`），防止后续 push 悄悄改变实际运行的代码。确切行为以你所用 pnpm 版本的策略为准。
- **纯挂载，无补丁步骤**：git 安装执行 `prepare`（构建）即完成——插件对 dsh 源码树零修改（bundle 行插入 + client inject + 自有 gateway），无需任何 apply/revert 脚本，dsh 升级后无需重打。

## 5. 验证安装

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

## 6. 卸载

```sh
dsh plugin --profile web remove dsh-llm-fallbacks
dsh --profile web --dump-config   # 确认 llm-fallbacks 层已消失
```

重启 dsh web 会话使卸载生效。卸载后插件不再介入任何请求/错误路径，已持久化的 `fallbacks/switch` 会话事件为历史记录，不受卸载影响。
