---
module: mstar-harness-dsh
date: 2026-08-10
problem_type: workflow_issue
category: workflow-patterns
severity: low
plan_id: llm-fallbacks-plugin
applies_when:
  - 在 dsh 会话的文件沙箱（workspace-write）下执行迭代/SDD 验证
  - 需要验证 dsh 插件安装、patch 应用等本应写工作区外路径的操作
  - 需要只读验证 dsh 运行安装（staging 树）
tags:
  - dsh
  - sandbox
  - verification
  - scratch
  - pnpm-patch
---

# dsh harness 沙箱兼容验证模式（scratch 环境 + 只读校验）

在 dsh 会话沙箱（工作区外不可写）下完成运行类验证的已验证手法（iter-20260810-llm-fallbacks 全程使用）。

## Context

dsh 会话的文件策略默认 workspace-write：只能写 session workspace 内路径。dsh 运行安装（$DSH_HOME/source/current，staging 树 = dsh-private 同源 git 树 + node_modules + 已构建 lib）与真实 profile（$DSH_HOME/profiles/<name>/）都在工作区外。但 dsh CLI 支持 DSH_HOME 环境变量重定向——验证可在工作区内完整复现。

## Guidance

### 插件安装验证：scratch DSH_HOME

DSH_HOME=<worktree>/.dsh-verify 时执行 `dsh plugin --profile verify add <worktree>` → profile 初始化 + pnpm link + bundles reconcile；再用 `dsh --profile verify --dump-config` → 组合层序（确认插件行在 llm-retry 等内置行之后）。验证后删除 scratch。真实 profile 的装入与 GUI 交互留用户环境执行，文档如实标注。

### patch 验证：沙箱拷贝 + 真实树只读 git apply --check

- patch 生成：把目标源文件复制到工作区临时目录做最小编辑，git diff 导出 pnpm 格式 patch；对真实树 git apply --check（只读）验证可应用 + pre-image blob 一致性。
- 全流程（apply→verify→revert→verify）在沙箱拷贝（git init 的最小镜像树）上跑；脚本目标解析用 DSH_SOURCE_DIR / DSH_HOME 环境变量，脚本文件本身零本地绝对路径。
- 编译级验证（不能只 grep）：scratch TS 文件 + tsconfig paths 指向真实树 vendor/schemastery 类型做 tsc --noEmit（red→green 证据链）。

### harness 解析与 worktree

- {HARNESS_DIR} 解析从 session workspace 向上探测 .mstar/.agents/.plans/plans——祖先目录的 ~/.mstar 会兜底命中；解析结果按 workspace 缓存（会话中途初始化项目 harness 不生效）。
- 迭代 Phase 2 的 feature worktree 可建在 session workspace 内（如 <repo>/.worktrees/<plan-id>，git 允许且子代理沙箱可写）；.worktrees/ 加入 .gitignore。

## Why This Matters

沙箱不是验证的障碍，而是把验证逼到「可复现、可留痕、不污染真实环境」的形态；用户真实环境验收清单随文档交付，避免「已验证」与「待用户」混淆（QC/QA 会逐项核对边界表述）。

## When to Apply

dsh 会话内任何涉及工作区外写入的验证（profile 安装、本体 patch、GUI 契约、真实模型调用）。

## Examples

docs/verification.md（本仓库）：已验/待验清单与用户执行步骤。
