---
category: Fixed
---
- Adapt the subagent dispatch seam to the installed `@deepseek-ai/dsh-subagent` activation API (`startActivation` in place of the removed `start` / `startContinuable`), so role resolution, the in-session `[role: <id>]` notice row and the session-header role badge keep working with the dsh peer range declared in `package.json`.
- Deliver the resolved role persona as a scoped `deployment:persona-prefix` system-prompt section on the child instead of a request persona: it still replaces the deployment persona for that dispatched child, but it is no longer durable — a role child resumed after a host restart now runs without its role persona.
