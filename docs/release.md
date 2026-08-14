# 发布指南（Release Guide）

本文档说明 `dsh-llm-fallbacks` 的发布流程：npm 认证（首次发布 bootstrap token → 后续 Trusted Publishing）、发布 SOP（触发 → 审查 → merge）、changelog fragment 格式、发布检查清单与回滚/重跑说明。

## 发布模型（PR-driven）

发布是**两步制**，不是黑盒一键：

1. **Release prep**（手动触发）→ 生成可审查的 `release vX.Y.Z` PR（版本 bump + 英文 changelog + fragment 归档）。
2. **merge 该 PR 才发布** → `Release` workflow 自动 publish + tag + GitHub Release。

仓库**不声明 `NPM_TOKEN`**：常规发布 npm 认证走 Trusted Publishing（OIDC `id-token` + `npm publish --provenance`，tokenless）；**首次发布例外**——npm TP 只能对已存在的包配置，首个版本用一次性 `NODE_AUTH_TOKEN` secret 发布（见「npm 认证」节）。GitHub 侧只用内置 `GITHUB_TOKEN`。**没有 `push:tags` 自动发布路径**——手动 `git tag && git push --tags` 不会发布，发布唯一入口是 merge `release vX.Y.Z` PR。

相关工作流：

| Workflow | 文件 | 触发 |
|---|---|---|
| CI | `.github/workflows/ci.yml` | PR / push main / 手动 |
| Release prep | `.github/workflows/release-prep.yml` | 手动（Actions → Release prep → Run workflow） |
| Release | `.github/workflows/release.yml` | merge 标题为 `release v*` 的 PR |

## npm 认证：首次发布 bootstrap token → 后续 Trusted Publishing（用户操作）

npm 的 Trusted Publishing（OIDC）只能对**已存在的包**配置——没有预注册路径，`dsh-llm-fallbacks` 尚未发布，首次发布无法走 TP（会 ENEEDAUTH/404）。因此认证分两段：

- **首次发布（bootstrap）**：一次性 Granular Access Token 存入 `NODE_AUTH_TOKEN` secret，发布 `0.1.0-alpha.2`。
- **后续发布**：首次发布成功后，在 npm 包设置配置 Trusted Publisher 绑定 `release.yml`，此后发布**零 secrets**（OIDC 自动认证，token 可删除）。

> **bootstrap token 是一次性机制，不是长期方案**：TP 配置完成后应从 GitHub 删除 `NODE_AUTH_TOKEN` secret（npm 官方也建议配置 TP 后限制传统 token 的发布权限）。
>
> 两步都只能由 npm 账号所有者（维护者）在 npm 网站上完成——仓库内无法自动配置，也不是本仓库代码能代做的。

### 首次发布：一次性 Granular Access Token（用户操作）

1. 登录 [npmjs.com](https://www.npmjs.com) → 右上角头像 → **Access Tokens** → **Generate New Token** → 类型选择 **Granular Access Token**。
2. 填写名称（如 `dsh-llm-fallbacks-bootstrap`）；Package 选择 `dsh-llm-fallbacks`；权限选择 **Read and write**。
   - 若包尚未发布、npm 的 package picker 列表里还没有 `dsh-llm-fallbacks`：改用 **org 级 publish scope**（如 `omdsh-dev` 下选择该包/全部包），或走「手动 token 路径」——创建 **Granular Access Token** 后**不限制 package**（或选择 Any package），发布时依赖该 token 的发布权限。
3. 复制 token，到 GitHub 仓库 **Settings → Secrets and variables → Actions** 新建 repository secret，名称 **`NODE_AUTH_TOKEN`**，值粘贴该 token。
4. `release.yml` 的 publish 步骤通过 `env: NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }}` 自动读取（`setup-node` 的 `registry-url` 会把该值写入 `.npmrc`，npm 自动使用）；secret 不存在时该 env 为空 → 走 OIDC/provenance 路径。

### 后续发布：在 npm 包设置配置 Trusted Publisher（用户操作，tokenless）

首次发布成功后，包在 npm 上才有 Settings 页：

1. 登录 [npmjs.com](https://www.npmjs.com) → **Packages** → `dsh-llm-fallbacks` → **Settings** → **Trusted publishing**。
2. **Select your publisher** → 选择 **GitHub Actions**。
3. 填写字段：
   - **Organization or user**（必填）：`omdsh-dev`（GitHub 组织/用户名）；
   - **Repository**（必填）：`dsh-llm-fallbacks`；
   - **Workflow filename**（必填）：`release.yml` —— **只填文件名**，不含路径，须含 `.yml`/`.yaml` 扩展名；workflow 须存在于仓库 `.github/workflows/` 下；
   - **Environment name**（可选）：仅当发布 job 使用 GitHub environment 保护时填写；
   - **Allowed actions**（必填）：勾选 **`npm publish`**（本仓库直接 `npm publish --provenance`，不走 staged publish）。
4. 保存。该配置**不创建任何 token**——npm 接受来自该 workflow 的 OIDC 发布（tokenless by design）。

> 每个包同一时间只能有一个 trusted publisher 配置；可随时编辑/删除（删除后回到 token 认证）。

### 注意事项

- npm **provenance** 要求包为公开包（工作流中发布命令已是 `--access public`）。
- GitHub 侧**无需额外配置**：OIDC token（`permissions: id-token: write`）由 Actions 自动签发；`contents: write` / `pull-requests: write` 已在 workflow 内声明。
- TP 就绪后删除 `NODE_AUTH_TOKEN` secret：npm CLI 在 OIDC 环境中优先走 OIDC，token 只是 bootstrap 期的回退路径。
- 首次发布走**显式** `0.1.0-alpha.2`（见下方 SOP）；`--patch` auto 留给后续。

## 发布 SOP

### 1. 写 changelog fragment

对每个**用户可见变更**，在 `.changes/unreleased/` 下新增一个 fragment（格式见下节；**一个文件一个 category**，纯英文 bullets——`<!-- CN -->` 等非 bullet 行会被原样渲染进 CHANGELOG）。

**必须至少有一个 fragment**：`release.yml` 在 changelog 提取为空时直接 fail（发布中止）——空版本节无法发布。首次发布前尤其检查 `.changes/unreleased/` 非空（本仓库首次发布的 fragment 已随功能提交）。

### 2. 触发 Release prep

仓库 → **Actions** → 左侧 **Release prep** → **Run workflow**：

- **版本输入**：
  - **首次发布**：显式填 `0.1.0-alpha.2`（先验证流水线，正式版留给下一迭代）。
  - **后续**：留空 = auto bump（`--patch`）——当前版本为 prerelease 且尾段为数字（`X.Y.Z-pre.N`）时只递增 N（`0.1.0-alpha.1` → `0.1.0-alpha.2`，**保持 prerelease 线**）；无 prerelease 时 patch+1（`0.1.0` → `0.1.1`）；prerelease 尾段非数字时报错，改用显式版本。

工作流会依次：

1. **拒绝已发布版本**：显式版本且 git tag `v<v>` 已存在 → 报错退出（已发布版本无法重跑 prep）。
2. `pnpm release:prepare`：bump `package.json` version、把 `.changes/unreleased/` fragments 组装成 `## [<version>] - <date>` 节插入 `CHANGELOG.md`（`## [Unreleased]` 之下）、归档 fragments 到 `.changes/archive/<version>/`。
   - **日期为 UTC**：脚本用 `new Date().toISOString().slice(0, 10)`，节日期固定为 UTC 当天；正时区深夜本地 prep 可能显示「昨天」——以 UTC 为准即可。
3. `pnpm release:validate -- v<v>`：package.json 版本与 tag 一致 + tag 未已存在（双保险）。
4. `pnpm build` 冒烟。
5. 提交 `chore(release): prepare v<v>` 到 `release/v<v>` 分支并 push（force-with-lease）。
6. 开 PR `release v<v>`（base `main`，label `release`）；**open PR 已存在则更新它**，**closed PR 已存在则先 reopen 再更新**，都没有才新建。

### 3. 审查 release PR

merge 前核对：

- [ ] `package.json` 的 `version` 是预期版本；
- [ ] `CHANGELOG.md` 在 `## [Unreleased]` 下出现 `## [<version>] - <date>` 节，fragment bullet 正确、英文；
- [ ] `.changes/unreleased/` 的 fragment 已归档到 `.changes/archive/<version>/`；
- [ ] diff 只含版本 / changelog / 归档（外加分支上任何直接提交，如无应为三块）。

### 4. Merge → 自动发布

merge 后 `release.yml` 触发（`pull_request: closed` + `merged == true` + 标题 `release v` 前缀）：

1. 检出 merge commit → `release:validate` → `pnpm build`；
2. `npm publish --provenance --access public --tag latest` —— **显式 `--tag latest`**：npm ≥ 11（Node 24 自带）发布 prerelease 必须显式 `--tag`，否则 hard-throw；首个版本（`0.1.0-alpha.2`）落默认 `latest` dist-tag（`npm i dsh-llm-fallbacks` 可解析），后续稳定版 `0.1.0` 自然接棒 `latest`。npm 认证自动选择：TP 已配置 → OIDC；bootstrap 期 → `NODE_AUTH_TOKEN`（见「npm 认证」节）；
3. 打 tag `v<v>` 并 push（已存在则跳过）；
4. 用 changelog 节创建 GitHub Release（版本含 `-` 时 `prerelease: true`）。

## Changelog fragment 格式

`.changes/unreleased/` 下每个文件是一条 fragment（`.changes/unreleased/README.md` 是说明文件，`.gitkeep` 是占位，二者都会被忽略）：

- **文件名**：任意以 `.md` 结尾的 slug（如 `add-foo.md`）。
- **Frontmatter（可选）**：`category:` 键把该 fragment 的 bullets 归入 changelog 中的 `### <category>` 小标题（默认 `Changed`）。
- **正文**：一行或多行英文 bullet（`- ` 前缀），原样渲染。

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

每条 fragment 聚焦一个用户可见变更。

## 发布检查清单

- [ ] `pnpm test` 全绿（409 测试基线，vitest run）
- [ ] `pnpm build` 全绿（tsc + tsdown + build-client + verify-dist）
- [ ] `actionlint .github/workflows/*.yml` 干净（ci + release-prep + release）
- [ ] `pnpm release:validate -- v<version>` 通过（发布前本地预览）
- [ ] 版本号与 CHANGELOG 节一致；fragments 已归档
- [ ] npm 认证就绪：首次发布 = `NODE_AUTH_TOKEN` secret 已配置；后续发布 = Trusted Publisher 已绑定 `release.yml`（见「npm 认证」节）

## 回滚 / 重跑

- **PR 阶段（未 merge）**：版本或内容不对 → 直接**关闭 PR**，或**重跑 Release prep**。重跑是幂等式的：同版本重跑会重新生成 `release/v<v>` 分支（force-with-lease push）并处理 PR——**有 open PR 则更新它**；**有 closed PR 则先 `gh pr reopen` 再更新正文**；两者都没有才新建。**永远不会原地编辑一个 closed PR**（那会让发布静默卡死）。
- **merge 后、发布中途失败**：若 `npm publish` 已成功但 tag / GitHub Release 步骤失败——**不要直接重跑 Release workflow**：`npm publish` 会因版本已存在于 registry 而失败。修复方式：
  - 手动补 tag 与 Release：`git tag -a -m "release v<v>" v<v> && git push origin v<v>`，再用 changelog 节手动创建 GitHub Release；或
  - fix-forward：直接走下一版本（见下）。
- **已发布但内容错误**：npm **不允许重发同版本**；`npm unpublish` 仅限发布后 72 小时内且无依赖方（有政策限制）。**推荐 fix-forward**：修正后 bump 下一版本（prerelease 线如 `0.1.0-alpha.3`）重新走 SOP。GitHub Release 可随时编辑/删除；tag 在确认无人依赖后可删除（`git push origin :refs/tags/v<v>`）。
- **语义**：两步制（prep PR + merge）本身就是回滚闸门——发现不对，不 merge 即可，什么都没发生。

## 相关文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/release-prep.yml` | 手动入口：bump + changelog + 开/更新 release PR |
| `.github/workflows/release.yml` | merge 后自动 publish + tag + GitHub Release |
| `scripts/prepare-release.ts` | 版本解析（显式 / `--patch` auto）、fragment 组装、bump、归档 |
| `scripts/validate-release-version.ts` | 版本一致性 + tag 未存在校验 |
| `CHANGELOG.md` | 英文 changelog（`## [Unreleased]` + 版本节） |
| `.changes/unreleased/` | 待发布 fragments |
| `.changes/archive/<version>/` | 已消费 fragments 归档 |
