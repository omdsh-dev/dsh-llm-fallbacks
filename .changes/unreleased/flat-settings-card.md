---
category: Changed
---
- Rebuilt the web settings card in the official Plugins-page flat form language: the card is always open with no collapsible chrome and no feature switch, all fields render unconditionally under flat section headings (主代理 / 子代理 / 高级选项), and ONE footer Save/Discard pair replaces the per-section saves — Save writes the whole validated draft (Discard is kept; staged edits survive refresh). Self-drawn buttons, icons, and tooltips replace the `@deepseek-ai/dsh-client-ui-primitives` dependency, which is dropped from the client bundle and from `peerDependencies`.
