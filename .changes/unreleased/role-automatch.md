---
category: Added
---
- Dispatch-time role resolution: on a subagent's first request its role is now resolved in three stages — explicit (`agentPreset` matches a declared role id) → deterministic rules (unchanged) → LLM auto-match from the declared role taxonomy (`fallbacks.roleAutoMatch`, default `true`). Setting `roleAutoMatch: false` disables only the LLM auto-match stage; it reproduces the previous rules-only behavior when there is no explicit role (the explicit `agentPreset` stage is independent new behavior, not gated by the toggle).
- The resolved role's chain-head model is injected into the subagent's first request and surfaced as a `fallbacks/switch` event with `reason: 'role-inject'` (role + from/to) plus an explicit `role → model` log line.
