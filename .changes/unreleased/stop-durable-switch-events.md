---
category: Fixed
---
- Sessions containing `fallbacks/switch` events no longer refuse to load: the plugin stops writing durable switch events, and `scripts/repair-fallbacks-switch-logs.ts` marks legacy events ignorable so affected sessions load again.
- The ineffective apply()-time event-type registration stopgap is removed.
