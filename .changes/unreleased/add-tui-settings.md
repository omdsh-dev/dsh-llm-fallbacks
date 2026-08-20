---
category: Added
---
- Add a `/settings` write surface for llm-fallbacks in dsh-tui profiles: the fallbacks section edits every web settings-card capability (JSON text fields for complex config), with full parity to the web card. Requires dsh-tui >= v0.8.5 (commit `c51661f`).
- Add `/fallbacks config revert-seed <role-id>` (restores a seeded role's persona) and enrich the `/fallbacks config` readback with time slots, timezone, and role rules.
