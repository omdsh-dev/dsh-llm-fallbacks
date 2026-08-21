---
category: Fixed
---
- Register the `settings.plugin.item` card with `id` alongside `key` so it mounts on dsh hosts that still declare the slot as a list (pre-rc.7) instead of failing with `list slot "settings.plugin.item" requires options.id`.