---
category: Fixed
---
- `recovery: 'half-open'`: a completion observed after a route's cooldown lapsed now closes the circuit even when no decision-path read had transitioned the route to half-open yet (a manual re-selection, or a route no failure walk consulted because the current route kept succeeding). Previously the entry survived with its failure counter, so `/fallbacks` showed a spurious half-open marker for a route that was serving and the route's next failure escalated from n + 1 despite the proven recovery. Completions observed while a cooldown is still active are ignored exactly as before.
