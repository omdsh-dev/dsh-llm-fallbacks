---
category: Changed
---
- Under an enabled subagent model-selection allowlist, a mounted child's first attempt is allowlist-admitted: the walk starts on the first dispatchable route of the role chain that is on the allowlist, so a child can start on a non-head route.
- A mount is declined when the role chain has no allowlisted dispatchable route — the child keeps pure inheritance instead of being mounted on a chain the host allowlist cannot serve.
- A mounted child's walk refuses before any attempt (`UNDISPATCHABLE_HEAD_CODE`, no request sent) when the host subagent policy becomes `unprovable`, instead of dispatching an unfiltered route first.
