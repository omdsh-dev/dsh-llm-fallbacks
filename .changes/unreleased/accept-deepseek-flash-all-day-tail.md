---
category: Changed
---
- Retarget the all-day `rootChain` tail set to the renamed official line: exactly one of `deepseek-official/deepseek-flash` or `deepseek-official/deepseek-pro` (XOR). The retired `deepseek-v4-flash` / `deepseek-v4-pro` ids are no longer legal tails — a saved V4 tail now warns at startup, keeps slot rows and the virtual picker inert, and blocks save until a legal tail is picked. `deepseek-pro` is a legal selector whose model is not yet served by the catalog: the settings card shows it disabled ("not yet available"), requests to it fail until the gateway enables the id, and a chain whose only entry is `deepseek-pro` has no dispatchable head (the virtual-row override declines with a warn; a chain with a working entry before it still overrides).
