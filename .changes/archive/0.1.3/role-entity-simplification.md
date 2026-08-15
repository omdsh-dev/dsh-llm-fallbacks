---
category: Changed
---
- Role entities now carry only an `id` plus a `persona` (personality hint): the `label` field is removed and `description` is renamed to `persona`. Existing `label` / `description` keys are flagged as legacy (`legacyKeys` + startup warning) and stay inert until manually removed (migration rows in `docs/configuration.md`).
- The settings card reorders its form: the root agent fallback chain, role entities, and role rules come first, with trigger failure codes, cooldown and switch-limit options grouped under an "Advanced options" heading at the end.
- The root agent's chain editor no longer offers `provider/*` wildcard entries — the root chain stays provider/model lines and provider-any matching lives in the role rules (role chain editors keep the wildcard, and existing YAML `provider/*` entries remain valid).
