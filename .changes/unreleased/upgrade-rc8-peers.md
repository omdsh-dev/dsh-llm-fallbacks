---
category: Changed
---
- Upgrade every `@deepseek-ai/dsh-*` peer dependency to `^0.1.0-rc.8` (dsh 0.1.0-rc.8, 2026-08-19).
- Replace the deleted `@deepseek-ai/dsh-client-web-react` dependency: the uSES snapshot bind is vendored in the client half (`src/client/use-snapshot.ts`, same contract as rc.7) and `SnapshotSelectorHook` is imported from `@deepseek-ai/dsh-client-ui-slots`; the client bundle's loader-table externals follow the rc.8 platform table.
- Add `use-sync-external-store` as a runtime dependency for the vendored snapshot hook.
