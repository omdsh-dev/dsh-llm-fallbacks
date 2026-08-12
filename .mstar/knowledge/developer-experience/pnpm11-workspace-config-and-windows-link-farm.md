---
module: install toolchain (pnpm + dev-time link farm)
date: 2026-08-12
last_updated: 2026-08-12
problem_type: developer_experience
category: developer-experience
severity: high
title: pnpm 11 workspace-config 迁移、Windows 安全 link farm、cordis scoped 对齐（dsh 插件 bundle）
description: dsh-llm-fallbacks 按 dsh-advisor PR #11 经验（commit 294aff1b）自检并修复安装工具链：pnpm 11+ 静默忽略 .npmrc 非认证设置（autoInstallPeers/nodeLinker/allowBuilds 必须进 pnpm-workspace.yaml）、.npmrc 死 _authToken 删除、peerDependencies 范围必须匹配 prerelease 发布 tag（含 node-semver prerelease-tuple 规则实证：^4.0.0-rc.7 不匹配 4.0.1-rc.1）、cordis peer 必须 scoped 为 @deepseek-ai/cordis（shim 迁移 + requiredPeers 豁免 + legacy 清理）、Windows link farm 按目标选 junction/file + USERPROFILE 回退。
tags:
  - pnpm
  - pnpm-workspace-yaml
  - npmrc
  - node-linker
  - allow-builds
  - peer-dependencies
  - prerelease
  - semver
  - cordis
  - junction
  - link-farm
  - windows
  - userprofile
  - dsh
applies_when:
  - 任何 pnpm ≥ 10/11 仓库：非认证 pnpm 设置（autoInstallPeers/nodeLinker/allowBuilds）必须放 pnpm-workspace.yaml，.npmrc 只留 registry/auth
  - 对只发布 prerelease 版本的 @deepseek-ai/* 包声明 peerDependencies
  - 编写/移植 dsh 插件 dev-time link farm（scripts/setup-dsh-links.mjs）
  - 声明 cordis peer 或生成 cordis shim（必须 @deepseek-ai/cordis scoped 名）
  - 让链接脚本在 Windows 上工作（junction/file 分型、USERPROFILE、分隔符）
---

# pnpm 11 workspace-config 迁移、Windows 安全 link farm、cordis scoped 对齐

## Context

dsh-llm-fallbacks 按 dsh-advisor PR #11 沉淀的 `developer-experience/pnpm11-workspace-config-and-windows-link-farm.md`（commit `294aff1b`）对自身安装工具链做自检，发现 5 类问题并全部修复（commit `ac994ea`，21 files）。与 advisor 文档的关系：advisor 记录通用 pnpm-11/Windows 失败模式；本文记录 fallbacks 的修复实证，并新增两条 advisor 未覆盖的教训——**node-semver prerelease-tuple 规则**与 **cordis peer 必须 scoped 对齐**（用户明确要求对齐 advisor 的 `@deepseek-ai/cordis` 声明）。

## Guidance

1. **pnpm 11+ 非认证设置只读 `pnpm-workspace.yaml`。** `autoInstallPeers` / `nodeLinker` / `allowBuilds` 留在 `.npmrc` 被**静默忽略**——这是最危险的失败模式：安装表面成功，实际违反设计不变量（私有 peer 永不来自 registry），布局约定丢失。三件套必须同放：

```yaml
# pnpm-workspace.yaml
autoInstallPeers: false
nodeLinker: hoisted

allowBuilds:
  esbuild: true
```

2. **`.npmrc` 只留 registry/auth。** 删除 `_authToken=${NPM_TOKEN}`：安装路径不从私有 registry 取包（peer 由 link farm 提供），token 是死配置，还让**每次** pnpm 调用报 `Failed to replace env in config: ${NPM_TOKEN}` WARN（实测症状）。

3. **peer range 必须带 prerelease tag。** 无 prerelease 的范围（`^0.0.1`）永不匹配 prerelease 版本（`0.0.1-rc.1`）。14 个 `@deepseek-ai/*` peer 全部改为 `^0.0.1-rc.1`（树内发布版本实测均为 `0.0.1-rc.1`）。这是 `autoInstallPeers` 意外开启时的最后防线。

4. **node-semver prerelease-tuple 规则（本仓实证，advisor 未记录）。** `^4.0.0-rc.7` **不匹配** `4.0.1-rc.1`：带 prerelease 的 comparator 只接受同 `[major, minor, patch]` tuple 的 prerelease，不同 tuple 的 prerelease 候选被排除。范围必须精确到发布 tag——vendored cordis 为 `4.0.1-rc.1`，peer 必须写 `^4.0.1-rc.1`，不能想当然写 `^4.0.0-rc.7`（表面"同系列"）。

5. **cordis peer 必须 scoped（用户裁决，对齐 advisor）。** 声明 `@deepseek-ai/cordis` 而非裸 `cordis`，连带四点：
   - **shim 位置与名字**：`node_modules/@deepseek-ai/cordis`，package.json `name: '@deepseek-ai/cordis'`（vendored 只接受 `@deepseek-ai/cordis` 名；legacy 裸名不再支持）。
   - **requiredPeers 豁免**：vendored cordis 声明 `bin` → `collectDeepseekPackages()` 跳过 → 不豁免会落入 missingPeers 报错。`filter(name => startsWith('@deepseek-ai/') && name !== '@deepseek-ai/cordis')`。
   - **legacy 清理**：write 路径 `rmSync(node_modules/cordis)`（裸 shim 残留会让旧解析存活）；check 路径 `existsSync` 报错 `legacy node_modules/cordis shim present`。
   - **import 全量迁移**：src/tests 全部 `from '@deepseek-ai/cordis'`；client externals 表删除裸 `'cordis'` 条目只留 scoped（死条目留在 frozen 表里是错误契约声明）。

6. **Windows link farm：按目标选链接类型。** junction 仅限目录（无需特权），文件 symlink 需 Developer Mode/管理员 shell——cordis shim 的 `index.js`/`index.d.ts` 是文件条目，统一 junction 会得到坏链接。`statSync(target).isDirectory() ? 'junction' : 'file'`（statSync 失败回退 `'file'`）。`HOME` 在 Windows 不存在 → `process.env.HOME ?? process.env.USERPROFILE`。

7. **shim 目录在 farm 目录内天然免疫 pruneStale。** shim 是真实目录（非 symlink），`readlinkSync` 失败 → `continue`（"not a symlink — never ours, never touched"）。把 shim 放进 `node_modules/@deepseek-ai/` 后无需改 prune 逻辑。

## Why This Matters

第 1、3 条守护设计不变量（私有 peer 永不来自 registry）：`.npmrc` 静默忽略让不变量在"安装成功"的表面下被破坏，事后以错误模块身份/ERESOLVE 暴露。第 4 条是本仓独有的深坑——范围"看起来对"（同 4.x 系列）实际不匹配，且只在 pnpm 真正解析该 peer 时才显形。第 5 条是插件生态一致性：所有 dsh 插件对 cordis 的声明必须统一为 scoped 名，裸名 shim 与裸名 import 是迁移残留。第 6 条让 bundle 在用户实际运行 pnpm 11 的 Windows 上可安装。

## When to Apply

- 任何 pnpm ≥ 10/11 仓库：检查 pnpm 设置是否在 `pnpm-workspace.yaml`（pnpm ≥ 10.26 已接受 `allowBuilds`）。
- 声明 peer 指向只发 prerelease 的包：范围必须带发布 tag，且 tuple 必须与发布版本一致（第 4 条）。
- 新建/移植 dsh 插件 bundle：cordis peer、shim、import、externals 表全部用 `@deepseek-ai/cordis`；link farm 脚本用第 6、7 条的 Windows 安全写法。
- 升级 dsh 源码树 vendor/cordis 版本：同步 `package.json` peer range 到新版本 tag。

## Examples

### Before（broken）

`.npmrc` 含 `_authToken=${NPM_TOKEN}`（每次 pnpm 调用 WARN）；`pnpm-workspace.yaml` 只有 `autoInstallPeers`；peers `^0.0.1` + `cordis: ^4.0.0-rc.7`；shim 发布裸名 `cordis` 位于 `node_modules/cordis`；`linkKind()` win32 全 junction；`process.env.HOME` 无回退。

### After（verified, pnpm 10.28.1 macOS）

设置三件套进 `pnpm-workspace.yaml`；token 删除（pnpm 调用零 WARN）；14 个 peer `^0.0.1-rc.1` + `@deepseek-ai/cordis: ^4.0.1-rc.1`；shim 在 `node_modules/@deepseek-ai/cordis` 发布 scoped 名（入口 symlink 指向 vendored 文件）；`linkKind(target)` 按 statSync 分型 + try/catch；`HOME ?? USERPROFILE`。验证：fresh `pnpm install` → prepare 链接 215 包 + cordis shim → build 绿 → `dsh:link:check` ok → 319/319 tests 过。Windows 侧（junction/file、USERPROFILE）未实测——逻辑逐条对齐 advisor 已验证实现。

### 相关

- 上游：`dsh-external/dsh-advisor` `.mstar/knowledge/developer-experience/pnpm11-workspace-config-and-windows-link-farm.md`（通用失败模式）。
- 本仓 link farm 设计：`best-practices/dsh-cordis-plugin-authoring.md`（real-code-linking、shim 动机、react 身份）。
