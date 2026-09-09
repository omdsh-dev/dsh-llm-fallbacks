---
category: Fixed
---
- The named `llm-fallbacks` service is now provided from inside the plugin's settings inject child — the seed write channel binds first, then the service is provided in the same callback — so service visibility implies `declareSeeds` can write. A companion declaring seeds the moment the service appears (the documented declare-on-probe pattern) no longer rejects with `settings service is unavailable` (issue #105); the first declare persists roles, with no retry needed.
- Observable timing change: the service appears only after the settings child settles (never synchronously during `apply()`), unregisters when the settings service goes away (settings teardown or plugin dispose), returns when settings re-appear, and never appears without a settings service; a second plugin fiber applying inside the one-tick claim window degrades via its dedupe catches instead of failing.
