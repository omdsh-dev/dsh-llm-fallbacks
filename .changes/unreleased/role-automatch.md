---
category: Added
---
- Dispatch-time role resolution: on a subagent's first request its role is now resolved in three stages — explicit (`agentPreset` matches a declared role id) → deterministic rules (unchanged) → LLM auto-match from the declared role taxonomy (`fallbacks.roleAutoMatch`, default `true`; set `false` to reproduce the previous rules-only behavior).
- The resolved role's chain-head model is injected into the subagent's first request and surfaced as a `fallbacks/switch` event with `reason: 'role-inject'` (role + from/to) plus an explicit `role → model` log line.
