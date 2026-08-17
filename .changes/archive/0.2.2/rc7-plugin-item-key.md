---
category: Fixed
---
- dsh 0.1.0-rc.7 loads the plugin again: the Fallbacks card registers into the keyed `settings.plugin.item` slot with `key: 'fallbacks'` (the old list-slot `id`/`order` options are gone).
- Every `@deepseek-ai/dsh-*` peer dependency is floored to `^0.1.0-rc.7` (`cordis` / `schemastery` / `react` unchanged).
