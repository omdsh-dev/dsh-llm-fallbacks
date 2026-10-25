---
category: Fixed
---
- Keep the dispatch-resolved role on the subagent failure path: after a role-injected child's route fails, the fallback now walks that role's own chain (and `rootChain` only for `inherit-root`) instead of degrading to the bare `rootChain`, so a `fallback: none` role never escapes onto the root chain.
