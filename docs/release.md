# 发布指南（Release Guide）

本文档说明 `dsh-llm-fallbacks` 的发布流程：一次性前置（Trusted Publishing 授权）、发布 SOP（触发 → 审查 → merge）、changelog fragment 格式、发布检查清单与回滚/重跑说明。

## 发布模型（PR-driven）

发布是**两步制**，不是黑盒一键：

1. **Release prep**（手动触发）→ 生成可审查的 `release vX.Y.Z` PR（版本 bump + 英文 changelog + fragment 归档）。
2. **merge 该 PR 才发布** → `Release` workflow 自动 publish + tag + GitHub Release。

仓库内**零 secrets**：npm 认证走 Trusted Publishing（OIDC `id-token` + `npm publish --provenance`），GitHub 侧只用内置 `GITHUB_TOKEN`。**没有 `push:tags` 自动发布路径**——手动 `git tag && git push --tags` 不会发布，发布唯一入口是 merge `release vX.Y.Z` PR。

相关工作流：

| Workflow | 文件 | 触发 |
|---|---|---|
| CI | `.github/workflows/ci.yml` | PR / push main / 手动 |
| Release prep | `.github/workflows/release-prep.yml` | 手动（Actions → Release prep → Run workflow） |
| Release | `.github/workflows/release.yml` | merge 标题为 `release v*` 的 PR |

## 一次性前置：Trusted Publishing 授权（用户操作）

发布前需要把 GitHub Actions 的 `release.yml` 与 npm 账号绑定（npm 侧 OIDC 授权）。
**该步骤只能由 npm 账号所有者（维护者）在 npm 网站上完成**——仓库内无法自动配置，也不是本仓库代码能代做的。

### Web UI 步骤（推荐）

1. 登录 [npmjs.com](https://www.npmjs.com) → 右上角头像 → **Access Tokens**。
2. **Generate New Token** → 类型选择 **Granular Access Token**。
3. 填写名称（如 `dsh-llm-fallbacks-github-release`）；Package 选择 `dsh-llm-fallbacks`（或所在 scope/org）；权限选择 **Read and write**。
4. 在 **Trusted Publishing** 区域：选择 GitHub 组织 `omdsh-dev`、仓库 `dsh-llm-fallbacks`、workflow 文件 `.github/workflows/release.yml`。
5. 创建 token —— npm 会把该 token 绑定到该 workflow 的 OIDC 身份（subject）。此后 `release.yml` 的 `npm publish --provenance` 不再需要任何 token/secret。

### CLI 等价（可选）

```sh
npm token create --granular --permissions=read-write \
  --workflows=omdsh-dev/dsh-llm-fallbacks/.github/workflows/release.yml
```

确切 flag 以 `npm token create --help` 为准；Web UI 为推荐路径。

### 注意事项

- npm **provenance** 要求包为公开包（工作流中发布命令已是 `--access public`）。
- GitHub 侧**无需额外配置**：OIDC token（`permissions: id-token: write`）由 Actions 自动签发；`contents: write` / `pull-requests: write` 已在 workflow 内声明。
- 授权完成后，首次发布走**显式** `0.1.0-alpha.2`（见下方 SOP）；`--patch` auto 留给后续。

## 发布 SOP

### 1. 写 changelog fragment

对每个**用户可见变更**，在 `.changes/unreleased/` 下新增一个 fragment（格式见下节）。没有 fragment 也可以发布（版本节将为空），但建议至少为每个面向用户的变更留一条。

### 2. 触发 Release prep

仓库 → **Actions** → 左侧 **Release prep** → **Run workflow**：

- **版本输入**：
  - **首次发布**：显式填 `0.1.0-alpha.2`（先验证流水线，正式版留给下一迭代）。
  - **后续**：留空 = auto bump（`--patch`）——当前版本为 prerelease 且尾段为数字（`X.Y.Z-pre.N`）时只递增 N（`0.1.0-alpha.1` → `0.1.0-alpha.2`，**保持 prerelease 线**）；无 prerelease 时 patch+1（`0.1.0` → `0.1.1`）；prerelease 尾段非数字时报错，改用显式版本。

工作流会依次：

1. **拒绝已发布版本**：显式版本且 git tag `v<v>` 已存在 → 报错退出（已发布版本无法重跑 prep）。
2. `pnpm release:prepare`：bump `package.json` version、把 `.changes/unreleased/` fragments 组装成 `## [<version>] - <date>` 节插入 `CHANGELOG.md`（`## [Unreleased]` 之下）、归档 fragments 到 `.changes/archive/<version>/`。
3. `pnpm release:validate -- v<v>`：package.json 版本与 tag 一致 + tag 未已存在（双保险）。
4. `pnpm build` 冒烟。
5. 提交 `chore(release): prepare v<v>` 到 `release/v<v>` 分支并 push（force-with-lease）。
6. 开 PR `release v<v>`（base `main`，label `release`）；**同版本 PR 已存在时改为更新它**（`gh pr edit` 路径）。

### 3. 审查 release PR

merge 前核对：

- [ ] `package.json` 的 `version` 是预期版本；
- [ ] `CHANGELOG.md` 在 `## [Unreleased]` 下出现 `## [<version>] - <date>` 节，fragment bullet 正确、英文；
- [ ] `.changes/unreleased/` 的 fragment 已归档到 `.changes/archive/<version>/`；
- [ ] diff 只含版本 / changelog / 归档（外加分支上任何直接提交，如无应为三块）。

### 4. Merge → 自动发布

merge 后 `release.yml` 触发（`pull_request: closed` + `merged == true` + 标题 `release v` 前缀）：

1. 检出 merge commit → `release:validate` → `pnpm build`；
2. `npm publish --provenance --access public` —— **不传 `--tag`**：首个版本是 registry 上唯一版本，落默认 `latest` dist-tag（`npm i dsh-llm-fallbacks` 可解析）；后续稳定版 `0.1.0` 自然接棒 `latest`；
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
- [ ] Trusted Publishing 授权已完成（仅首次发布需要）

## 回滚 / 重跑

- **PR 阶段（未 merge）**：版本或内容不对 → 直接**关闭 PR**，或**重跑 Release prep**。重跑是幂等式的：同版本重跑会重新生成 `release/v<v>` 分支（force-with-lease push）并**更新既有 PR**（`gh pr view` → `gh pr edit` 路径），PR 标题/正文/changelog 以最新一次运行为准。
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
