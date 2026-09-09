---
category: Added
---
- `triggerCodes` accepts `CONTEXT_WINDOW_EXCEEDED`: a request too big for the current model now fails over to a candidate whose advertised context window is larger (candidates that cannot fit it either are skipped and named `skipped: context-window` in the switch log; an undisclosed window keeps the candidate), and because the route itself is healthy the switch is request-scoped — the from-route is recorded as failed for the step and counts against `maxSwitchesPerStep`, but is not put on cooldown and does not feed the half-open recovery counter. Every other trigger code stays route-scoped, unchanged.
