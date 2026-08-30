---
category: Changed
---
- Upgrade every `@deepseek-ai/dsh-*` peer dependency (plus `@deepseek-ai/cordis` `^4.0.2` and `@deepseek-ai/schemastery` `^3.18.2`) to the published `^0.1.2-alpha.2` line (dsh 0.1.2-alpha.2, 2026-08-30; the alpha.1 line was never published). The settings section now registers through `SettingsProvider.installSection` (the 0.1.2 successor of the removed `installSettingsSection`/`settingsNamespace` helpers), and the always-mode retry cap counts the `llm/retry` events whose `SessionEventMap` vocabulary ships in `@deepseek-ai/dsh-llm-retry`.
