---
category: Fixed
---
- `/fallbacks` command registration no longer uses an empty `input.hint` — the real dsh-commands registry rejects empty hints, so the command silently never appeared in any profile; it now registers in both web and dsh-tui profiles.
