---
category: Changed
---
- Settings card (PR #62 UX round 3): the Reset-to-defaults button and its confirmation dialog are gone from the card (the gateway `fallbacks/reset` RPC and store `resetToDefaults()` stay as host APIs), and each big section (主代理 / 子代理 / 高级选项) now saves ONLY its own fields — 主代理 persists `rootChain` / `timeSlots` / `tz` (+ the card-level `enabled`), 子代理 persists `roles`, 高级选项 persists the advanced scalars — with every other section's value taken from the last accepted config, so one section's Save never rides along (or clobbers) another section's unsaved edits; validation and Discard are per-section too, and after a save only clean sections re-seed from the accepted config.
