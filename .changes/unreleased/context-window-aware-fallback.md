---
category: Added
---
- `triggerCodes` accepts `CONTEXT_WINDOW_EXCEEDED`: a request too big for the current model fails over to the next candidate, and because the route itself is healthy the switch is request-scoped — the from-route is recorded as failed for the step and counts against `maxSwitchesPerStep`, but is not put on cooldown and does not feed the half-open recovery counter (every other trigger code stays route-scoped, unchanged).
- Context-window walks skip candidates whose advertised context window is not larger than the failing model's; skipped candidates are named `skipped: context-window` in the switch log, and a model that discloses no window either way is kept as a candidate.
