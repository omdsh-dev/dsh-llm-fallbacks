---
category: Changed
---
- Upgrade every `@deepseek-ai/dsh-*` peer dependency to `^0.1.2-alpha.1` (dsh 0.1.2-alpha.1, 2026-08-27); the ApiProxy host package removed upstream is not consumed by this plugin (settings and credentials go through the own gateway channel and `@deepseek-ai/dsh-api-remotes`), so no source migration was required.
