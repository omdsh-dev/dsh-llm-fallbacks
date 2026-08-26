---
category: Added
---
- Add opt-in half-open recovery (`fallbacks.recovery: 'half-open'`): an expired cooldown leaves the route half-open for one logged probe instead of restoring the preferred candidate; consecutive failures escalate the suppression duration (×2 per failure, capped at 1 h); an observed completion closes the circuit and fully restores the preference. `revertPolicy: 'never'` keeps the mechanism inert; state is session-scoped in-memory. YAML-only — the default `'timer'` keeps every existing behavior byte-identical.
- Startup warn when `recovery: 'half-open'` is combined with `cooldownMs` at or above the 1-hour escalation cap: escalation is inert (every suppression stays flat at `cooldownMs`), and the config validator now says so at startup.
