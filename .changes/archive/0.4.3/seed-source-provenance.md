---
category: Added
---
- `declareSeeds` accepts an optional second argument `{ set: '<name>' }` that labels the whole seed batch with a registered provenance set name; an empty, non-string, or reserved name (`bundled` / `user` / `external`) warns once and degrades to the unnamed `external` label — the seeds still apply.
- Every seed readback and gateway `seeds` wire entry now carries a per-row `source` (`bundled`, the declared set name, `external`, or `user`), derived at read time from the live declaration registries and never persisted.
- Rows without a live declaration — including `designer` / `librarian` rows persisted by earlier versions before the preset trim — show source `user` even though the operator never wrote them; the label means "no live declaration", not "operator-written".
