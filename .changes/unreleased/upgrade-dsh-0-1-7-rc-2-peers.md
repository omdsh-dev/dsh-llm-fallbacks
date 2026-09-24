---
category: Changed
---
- Declare dsh 0.1.7-rc.2 compatibility: peer dependencies bump from `^0.1.7-rc.1` to `^0.1.7-rc.2`. No runtime change was required — the corridor's LLM provider reorganization (`resolveAuth`), the new `ACCOUNT_QUOTA` error code, and the tightened model-catalog semantics leave the plugin's seams untouched, and the plugin's live-config-reference unwrap already covers the schemastery ≥3.18.4 volatile semantics the rc.2 settings stack resolves against.
- Dev-time installs patch an upstream packaging gap via a pnpm `packageExtensions` entry: the published `dsh-client-ui-primitives@0.1.7-rc.2` bare-imports `dsh-util-code-language` without declaring it in its manifest (the host box resolves it from its own package set; registry-mode dev installs would fail the vitest graph). Remove the entry once an upstream release declares the dependency.
