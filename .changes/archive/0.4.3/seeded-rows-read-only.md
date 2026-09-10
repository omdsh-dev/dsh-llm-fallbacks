---
category: Changed
---
- The settings card renders seeded role rows as read-only reference material: no id input (the row title carries the name), the persona shows as a single-line brief with an expandable full view instead of a persona editor, and the persona revert button is gone; chain and fallback editors and the remove action are unchanged, and unseeded rows keep the full editing UI.
- Every role row shows a source badge — `bundled` for the plugin's own presets, the declared set name (or `external` when the batch is unnamed) for companion-declared rows, and `User` otherwise; rows kept from the removed `designer` / `librarian` presets show `User` even though the operator never wrote them (the label means "no live declaration", not "operator-written").
- A blank or missing wire `source` renders no badge — the version-skew degrade, not an error.
