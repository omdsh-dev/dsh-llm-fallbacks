---
category: Changed
---
- Upgrade the `@deepseek-ai/dsh-*` peer range to `^0.1.7-rc.1` and adapt to the 0.1.7-rc.1 APIs: the `fallbacks` settings section is the Loader entry Config now (volatile schema; the retired `SettingsProvider.installSection` registration is gone), settings writes target the plugin's profile entry `llm-fallbacks` through the `SettingsForms` form service, the role notice writes the producer-declared `llm-fallbacks-role-notice` source kind (the shared `plugin` kind was removed; pre-upgrade `plugin:dsh-llm-fallbacks` rows keep their badge), and the card icons follow the renamed `*OutlineMedium` ui-primitives exports.
