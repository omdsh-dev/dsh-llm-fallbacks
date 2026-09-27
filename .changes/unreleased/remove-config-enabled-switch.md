---
category: Removed
---
- Removed the config-level `enabled` switch (breaking): the Plugins-page row toggle is the master switch, and the runtime no-op gate re-keys to content presence — an empty configuration (no chains, time slots, or roles) behaves exactly like an uninstalled plugin. Stored profiles still carrying `enabled: true/false` load cleanly; the key is silently stripped from snapshots and saves and never re-persisted.
