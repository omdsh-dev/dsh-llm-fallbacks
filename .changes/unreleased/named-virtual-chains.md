---
category: Changed
---
- Replace the two-block config (`rootChain` + per-role chains + `roles.rules`) with N named virtual chains, each selectable in the model picker as `FallbacksChain/<chain id>` with its own 默认降级链, 默认模型 tail and per-chain 分时 slots; the settings card renders chain tabs (add / rename label / delete, per-tab save).
- Role entities keep identity (id/persona) plus a manually specified chain POINTER (`roles.list[].chain`, 「指定降级链」); unspecified roles no longer touch routing.
- Remove role-rule matching, the `fallback` chain-append policy, the host subagent-policy sync (card status area + sync button + `subagentPolicy` wire), the card's 运行状态 block, and the General page status row.
- Accept the documented degradation: the virtual route's `providerRetryPolicy` returns the host default (the head's custom policy no longer applies on the virtual route).
- Saving the settings removes the v1 `rootChain` / top-level `timeSlots` / `roles.rules` / `roles.default` / `enabled` fields and each role's `fallback` and array-form `chain` from the persisted section, preserving foreign keys and unrelated configuration; loading alone changes nothing.
