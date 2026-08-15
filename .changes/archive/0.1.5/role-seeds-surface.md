---
category: Added
---
- Role seeds: the `llm-fallbacks` service grows three additive methods — `declareSeeds` (a, declare `[{ id, persona }]`), `getEffectiveRoles` (b, read back effective roles with seeded / persona-overridden state), and `revertSeededPersona` (c, revert one id to its currently declared seed default) — the service shape grows from six to nine keys, strictly additively.
- Role seeds: the `fallbacks/get` gateway response (and the post-write `set` / `reset` responses) gains an additive `seeds` badge field, and a new `fallbacks/revert-seed` gateway endpoint reverts one seeded role to its seed default.
- Settings card: seeded roles show a seed-default / override badge with a revert button, and saving a seeded role with an empty chain is allowed (seeds never write chains).
