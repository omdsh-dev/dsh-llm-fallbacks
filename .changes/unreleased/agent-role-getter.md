---
category: Added
---
- The `llm-fallbacks` service grows one additive read-only method: `getAgentRole(agentId)` returns the DECLARED RAW role id a live subagent was dispatched as (trimming preserved), readable from the moment of dispatch — before the child's first step and for its whole activation lifetime — and `null` whenever no dispatch role resolved for that id.
- `ROLE_PROJECTION_KEY` and `readRoleProjectionValue` are now re-exported from the package root, so a companion reads the durable `fallbacksSubagentRole` session projection without hard-coding the key literal or re-implementing the blank-string guard.
