---
category: Fixed
---
- Upgrade a v1 configuration automatically, in memory, at every config read: `rootChain` + the top-level `timeSlots` rows become chain #0 `Auto` (so an already-selected `FallbacksChain/Auto` route keeps working), role rows keep their identity and persona while their v1 array `chain` reads as not specified (re-attachable via 指定降级链), and `fallback` / `roles.rules` / `roles.default` / `enabled` are dropped. No file is rewritten on load — the next save persists the upgraded shape and retires the migration banner.
