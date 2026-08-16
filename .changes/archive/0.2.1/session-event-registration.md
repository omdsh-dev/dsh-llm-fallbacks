---
category: Fixed
---
- Sessions containing `fallbacks/switch` events no longer refuse to load after a dsh restart: the plugin registers its session event type at startup (a stopgap until the upstream registration surface lands; tracked in the .mstar plans).
- When registration is unavailable, the switch still applies but the durable event is skipped — a session log is never written with an unregistered event type.
