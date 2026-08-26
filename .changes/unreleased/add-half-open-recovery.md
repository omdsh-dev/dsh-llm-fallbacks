---
category: Added
---
- Add opt-in half-open recovery (`fallbacks.recovery: 'half-open'`): an expired cooldown leaves the route half-open for one logged probe instead of restoring the preferred candidate; consecutive failures escalate the suppression duration (×2 per failure, capped at 1 h); an observed completion closes the circuit and fully restores the preference. `revertPolicy: 'never'` keeps the mechanism inert; state is session-scoped in-memory. YAML-only — the default `'timer'` keeps every existing behavior byte-identical.
