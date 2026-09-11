---
category: Added
---
- A subagent's resolved role is now its identity, not only a routing decision: the declared role's persona is installed on the child itself for every resolved role, including roles with no model chain (a caller-set persona still wins).
- The resolved role is announced once inside the subagent's own session as a durable plugin notice row naming the role.
- The role badge next to the session title now reads the child's own session record, so the role stays visible for a settled subagent session and after a host restart. Its source is narrower than before: the badge reports the role DECLARED in the child's Assignment header (`**Execute as**: <id>`), so a child whose role came only from an `agentPreset` match, a role rule or the LLM auto-match is still routed as that role but shows no badge.
