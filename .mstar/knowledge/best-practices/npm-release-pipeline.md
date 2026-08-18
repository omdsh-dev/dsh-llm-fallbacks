---
module: npm-release-pipeline
date: 2026-08-14
last_updated: 2026-08-14
problem_type: best_practice
category: best-practices
severity: low
plan_id: fallbacks-npm-release
applies_when:
  - 为 npm 包仓库搭建 GitHub Actions 发布流水线
  - 使用 npm Trusted Publishing / provenance
  - 发布 prerelease 版本（alpha/beta/rc）
  - 从零建立 changelog fragments 机制
tags:
  - npm
  - release
  - github-actions
  - trusted-publishing
  - provenance
---

# npm Release Pipeline（PR-driven + Trusted Publishing，实测 2026-08-14）

## Context

dsh-llm-fallbacks 建立 npm 发布流水线（单包），参考 mstar-harness 的 PR-driven release 模式。踩坑 4 个非显而易见点，全部经源码/官方文档验证。

## Guidance

### 架构：PR-driven release（不直接 push tag 发版）

- **`.github/workflows/release-prep.yml`**（`workflow_dispatch` + 可选 version 输入）：reject 已存在 tag → `prepare-release` 脚本（bump + changelog fragments 组装 + 归档）→ validate → build 冒烟 → commit release/vX.Y.Z 分支 → 开 `release vX.Y.Z` PR。
- **`.github/workflows/release.yml`**（`pull_request: types: [closed]` + branches [main] + `merged == true` + title `startsWith('release v')` + head.ref `release/v*`）：checkout merge_commit → validate → build → `npm publish --provenance --access public` → tag + GitHub Release。
- 发布动作 = merge release PR：可审查、可回滚、无 secrets。**不写** push:tags 自动发布路径。

### 坑 1：npm Trusted Publishing 只对**已存在**的包可配置（无 pre-registration）

- 官方文档（docs.npmjs.com/trusted-publishers）只有 package Settings → Trusted publishing → GitHub Actions（org/repository/**workflow 文件名**/optional environment/allowed actions）路径——**包未发布时没有配置入口**。
- 首次发布 bootstrap：一次性 granular token（repo/org secret `NODE_AUTH_TOKEN`，publish 步骤 optional env——absent 走 OIDC，present 走 token）→ 首版发布 → 在 npm package settings 配 TP → **删除 token secret + 移除 workflow env**（dsh-llm-fallbacks 2026-08-14 已完成，现为纯 OIDC；token 是历史 bootstrap 手段）。
- 没有配置 TP 的 CLI——`npm token create --granular --workflows=...` 等 flags 不存在，文档别编造。

### 坑 2：release workflow 必须 node 24（provenance 兼容）

- Node 22 自带 npm 的 sigstore/provenance 会 `MODULE_NOT_FOUND`（mstar-harness release.yml 注释验证）——**不要** `npm install -g npm@latest` 到 Node 22 上修，直接 pin node 24（如 `24.19.0`）。
- CI 验证流水线可以留在 node 22（engines 下限），发布流水线单独 node 24。

### 坑 3：npm ≥ 11 发布 prerelease 版本**必须**显式 `--tag`

- npm 11.x（Node 24 自带）发布 `X.Y.Z-pre.N` 无 `--tag` → hard-throw「You must specify a tag using --tag when publishing a prerelease version」（npm 11 源码 v11.0.0-v11.6.2 验证；npm 10 无此 guard）。
- 首发 prerelease 用 `--tag latest`：默认 dist-tag 是 latest，`npm i <pkg>` 能解析；正式版后续自然接管。
- 对应地，GitHub Release 的 `prerelease` 标志按版本推导：prerelease=$(node -p "/-/.test(require('./package.json').version)")。

### 坑 4：流水线重跑/版本一致性防护

- **closed-PR 重跑**：`gh pr view $BRANCH` 会匹配已关闭 PR（`gh pr edit` 不 reopen）→ 静默死路。门控必须 state-aware：`gh pr list --head $BRANCH --state open` → open 则 edit；无 open PR 则 `gh pr create`（**永不** `gh pr reopen` 已关闭的 release PR，merged 或 closed-unmerged 同理）。
- **PR title 版本交叉校验**：release.yml 从 title 后缀推导期望版本 vs package.json version，mismatch → fail（防手工改分支导致的标题/版本脱钩）；changelog 提取空文件 → fail。
- **reject 已存在 tag**：release-prep 前置 `git rev-parse v$V` 拒绝 + validate 双保险。
- **publish 先于 tag**：发布失败不会产生坏 tag；tag push 不会重复触发 CI（push filter 只 main）。
- **fragments 机制**：`.changes/unreleased/*.md`（frontmatter `category:` 可选 + 英文 bullets）→ prepare-release 插入 `## [v] - date`（UTC）→ 归档 .changes/archive/<v>/。auto-bump 对 `X.Y.Z-pre.N` 只递增 N（`0.1.0-alpha.1 → alpha.2`，**别学 mstar 的 parseInt 朴素 split**——会把 alpha 静默跳成正式版）。

### 工具细节

- scripts 用 `tsx` 跑（node:fs/node:path only，不引 Bun API）；逻辑导出（parseArgs/autoBumpPatch/insertSection/validateReleaseVersion）供 vitest 套件——bump 分支/插入/validate 正反例全部提交进仓库（fixture 干跑不落仓 = 无保护）。
- action pins：`checkout@v4` / `setup-node@v4` / pnpm/action-setup@v4（11.21.0）；release workflows 对齐 pnpm/action-setup → setup-node(cache: pnpm) 顺序。
- `git tag -a -m "release vX.Y.Z"`（git 2.55+ 无 message 拒绝 tag）。
- 工作流权限：release-prep `contents: write, pull-requests: write`；release `contents: write, id-token: write`；无 `NPM_TOKEN`。

## Why This Matters

四个坑（TP 无 pre-registration、node 24 sigstore、npm≥11 prerelease --tag、closed-PR 重跑）都在真实流水线首跑前被 QC 源码级/文档级验证拦截——任一未拦都会在首次真实发布时失败或产生坏产物。bootstrap + PR-driven 组合使发布可审查、可回滚、无长期 secrets。

## When to Apply

- 给任意 npm 包仓库搭 GitHub Actions 发布流水线（单包或多包 workspace 简化）。
- 使用 Trusted Publishing/provenance 且包尚未发布过。
- 发布 prerelease 线（alpha/beta/rc）。

## Examples

本仓库：`.github/workflows/release-prep.yml` + `.github/workflows/release.yml` + `scripts/prepare-release.ts` + `scripts/validate-release-version.ts` + `tests/release-scripts.spec.ts` + `docs/release.md`（SOP 含 Trusted Publishing 前置清单）。