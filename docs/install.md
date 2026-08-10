# 安装指南

本文介绍如何把 `dsh-llm-fallbacks` 装入 dsh profile、验证安装与卸载。

## 前置条件

- 可用的 dsh 运行环境（`$DSH_HOME`，默认 `~/.dsh`）。
- 构建需要 **bun**（`>= 1.2.17`）与 **node**（`>= 22`）——插件的 `prepare` 脚本自构建（`bun run build`）。
- 目标 profile（如 `web`）可读写，安装后需要重启 dsh 会话。

## 1. 本地目录安装（推荐）

```sh
# 1) 在插件仓库目录构建（prepare 自构建，产出 dist/）
pnpm install        # 或显式 pnpm build
# 2) 装入目标 profile
dsh plugin --profile web add .
```

`dsh plugin` 会把参数转发给该 profile 目录下的 pnpm（`add`、`remove`、`why` 等均可用），并将 `dsh-llm-fallbacks` 追加到 profile 的 bundle 层列表（`dsh.profile.bundles`）。

> **自动 patch（本地 link 安装不触发）**：`add .` 走 pnpm 的 `link:` 依赖（node_modules 内为符号链接），**pnpm 不会为 `link:` 依赖运行 prepare/postinstall 生命周期脚本**（已实证）——因此安装期自动 patch（见 [docs/dsh-patch.md](docs/dsh-patch.md)「自动应用」）不会在此路径触发。若本机 dsh 源码树（`$DSH_SOURCE_DIR` / `${DSH_HOME}/source/current`）需要 role patch，安装后手动执行一次：

```sh
bash scripts/autopatch-install.sh    # 幂等：已应用/已原生支持则跳过；失败仅 warn
# 或显式手动应用：scripts/apply-dsh-patch.sh && scripts/verify-dsh-patch.sh
```

如需完全禁用自动 patch（例如 git/tarball 安装时不想动 dsh 源码树），设环境变量 `DSH_LLM_FALLBACKS_AUTOPATCH=0` 再安装。

### bundle 层顺序（硬性要求）

dsh 的 profile 由有序 bundle 层组合而成：`@deepseek-ai/dsh-base`（内含 llm-retry 插件）→ `@deepseek-ai/dsh-web-app` → `@mstar-harness/dsh` →（`add` 追加的）`dsh-llm-fallbacks`。

**`dsh-llm-fallbacks` 必须排在 llm-retry（`@deepseek-ai/dsh-base` 层内）之后**：插件的 `agent/request-error` 监听需在 llm-retry 之后组合，才能在重试预算耗尽（normal 模式）或 llm-retry 先委托下游（always 模式）后介入；顺序颠倒会让可重试失败先到达本插件、抢占 llm-retry 的退避。

`add` 默认追加到列表末尾即满足该顺序，无需手工改动；若手动编辑 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`，请保持 `@deepseek-ai/dsh-base` 在本插件之前。

## 2. git 安装

```sh
dsh plugin --profile web add https://github.com/<owner>/dsh-llm-fallbacks.git
# 或指定 ref：add https://github.com/<owner>/dsh-llm-fallbacks.git#<branch|tag|commit>
```

git 安装注意：

- **prepare 自建**：pnpm 在安装 git 依赖时会执行包的 `prepare` 脚本（`bun run build`）自构建，安装机需要具备 bun；构建失败会导致装入未构建的包。
- **自动 patch**：git 安装会执行 `prepare`（构建）并随后触发 `postinstall`——两处都会调用 `scripts/autopatch-install.sh` 自动检测并幂等应用 dsh 本体 role patch（目标 = `$DSH_SOURCE_DIR`，缺省 `${DSH_HOME}/source/current`；缺失/非 git 树则跳过；失败仅 warn 不中断安装）。可用 `DSH_LLM_FALLBACKS_AUTOPATCH=0` 禁用。详见 [docs/dsh-patch.md](docs/dsh-patch.md)「自动应用」。
- **allowBuilds（构建脚本放行）**：pnpm ≥ 10 默认不执行依赖的构建脚本（含 `postinstall`）。若安装被策略拦截、或装入后 `--dump-config` 看不到 `llm-fallbacks` 层 / 设置页不出现 / 自动 patch 未触发，请放行本包构建（如 `dsh plugin --profile web approve-builds`，或在该 profile 的 pnpm 配置中把 `dsh-llm-fallbacks` 加入 `onlyBuiltDependencies`）。确切行为以你所用 pnpm 版本的策略为准。

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

然后**重启 dsh web 会话**（`dsh web` 或重启正在运行的会话），让 host 半与 client 半（设置页）加载：

- web 设置 GUI 的 Settings 中应出现 **Fallbacks** 页（位于 Models 页之后）。
- 页面可读、可编辑、可保存；未配置任何链时显示默认配置，行为 no-op（详见 [docs/configuration.md](docs/configuration.md)）。

## 4. 卸载

```sh
dsh plugin --profile web remove dsh-llm-fallbacks
dsh --profile web --dump-config   # 确认 llm-fallbacks 层已消失
```

重启 dsh web 会话使卸载生效。卸载后插件不再介入任何请求/错误路径，已持久化的 `fallbacks/switch` 会话事件为历史记录，不受卸载影响。
