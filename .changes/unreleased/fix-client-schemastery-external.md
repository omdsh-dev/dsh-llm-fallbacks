---
category: Fixed
---
- Fixed the web settings card failing to load with "client-modules: require(&quot;@deepseek-ai/schemastery&quot;) missed the module table": the `Config` schema moved to a host-only module (`src/schema.ts`) and the client bundle no longer externalizes `@deepseek-ai/schemastery` — the client graph now reaches it type-only, and the bundle purity gate guards the split.
