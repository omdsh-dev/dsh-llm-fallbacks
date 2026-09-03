---
category: Changed
---
- Upgrade every `@deepseek-ai/dsh-*` peer dependency to `^0.1.2-alpha.4` (dsh 0.1.2-alpha.4, 2026-09-01). Migrate `Session.events` reads to `Session.snapshotEvents()` (Session no longer exposes the events array; session logs are read on demand via `snapshotEvents()`/`eventAt()`).
