---
tags:
  - vitest
  - pnpm
  - test-counts
symptoms:
  - "vitest Test Files count differs between checkouts of the same commit"
  - "pnpm test collects hundreds of stale duplicate spec files"
applies_when:
  - "Repo keeps a pnpm store directory (e.g. .pnpm-store/) at the repo root"
  - "Vitest include glob is the default **/*.spec.* and defaultExclude does not cover the store dir"
---

# Vitest collects test copies from a root-level .pnpm-store (non-deterministic counts)

## Problem

`pnpm test` at the dsh-llm-fallbacks repo root reported `112 files / 2340 tests` for a tree whose real baseline was 44 files / 966 tests. The feature worktree checkout of the same commit reported the clean 44/966.

## What Didn't Work

- Suspecting `.worktrees/` duplication — already excluded via `exclude: [...defaultExclude, '**/.worktrees/**']`; not the cause.
- Diffing `git ls-files` — irrelevant; the extra files are untracked store content.

## Solution

The repo keeps its pnpm store at `<root>/.pnpm-store`. That store contains full project copies under `.pnpm-store/v11/projects/<hash>/tests/*.spec.ts` (store dedup of an earlier directory-linked dependency). Vitest's default include glob (`**/*.spec.*`) walks them: `defaultExclude` covers `node_modules` but NOT `.pnpm-store`. A worktree checkout is unaffected because the store lives outside its vitest root.

Fix (when this bites): add `'**/.pnpm-store/**'` to the vitest `exclude` list, or move the store off the repo root (`store-dir` in `.npmrc`). Until then, trust clean-checkout / worktree counts as the baseline.

## Why This Works

Vitest collection is root-dir-relative and gitignore-unaware; any ignored-but-present directory holding spec-shaped files gets collected. Excluding the store path restores a deterministic baseline.

## Prevention

When test counts drift between identical commits, diff the *collected file list* (`vitest run --reporter=json`, group by path prefix) before suspecting the code. Source: iter-20260826-fallbacks-half-open-recovery merge verification.
