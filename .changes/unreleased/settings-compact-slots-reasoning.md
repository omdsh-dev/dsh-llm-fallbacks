---
category: Changed
---
- Time-slot rows are compact: the preset/window block the row header already summarised is gone, the row's move/delete actions ride the header, and a custom row edits its name, start and end on one line.
- Every fallback-chain row carries a reasoning-effort select: Follow session sends no effort of its own, a pinned tier overrides that hop only, and the hop falls back to the route's default — never to the session value — when the route does not list the pinned tier.
- Chain entries accept a pinned effort as `provider/model@effort`; the suffix never changes the route the entry names, so a pinned official tail still conforms.
- Either DeepSeek provider can serve the official tail: `deepseek-account/deepseek-flash`, `deepseek-account/deepseek-v4-pro`, `deepseek-official/deepseek-flash` and `deepseek-official/deepseek-v4-pro` are all legal, the account pair is listed first, and the settings panel only offers providers that are configured.
- The subagent session-header pill prints `[FC/<chain label>] <model>` (the chain's static effective head) instead of the raw `FallbacksChain/<id>` route, shows an unresolved state when the chain resolves to no model, and leaves non-virtual routes and a cold catalog exactly as they were.
