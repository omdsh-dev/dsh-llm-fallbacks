---
category: Fixed
---
- `scripts/repair-fallbacks-switch-logs.ts` now fails closed: the released session-format migration chain (v0→v1) refuses unknown event types even when marked `ignorable`, so a "repaired" log would still be rejected on load — the script no longer reports or writes such logs and exits non-zero instead (the durable fix belongs upstream at the migration edges).
