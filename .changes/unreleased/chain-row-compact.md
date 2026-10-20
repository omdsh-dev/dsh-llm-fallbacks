---
category: Changed
---
- Fallback-chain selector rows are now single compact lines: each entry shows its 1-based order index, the provider select, the model select and a trailing delete button instead of a labelled multi-row block.
- The delete button is revealed on row hover or keyboard focus (and stays reachable on touch devices) instead of occupying its own footer row; it is hidden entirely on rows the read-only view cannot edit.
- The "add selector" affordance sits inline at the tail of each chain block, directly under the last entry.
- Row hints (wildcard conversion, outside-catalog and "no models available") now render inline on the row line and ellipsise instead of pushing the row taller; the full text stays available on hover, and the "no models available" hint is bound to the model select for assistive tech (its visible inline text is the guaranteed channel).
- The chain selects are announced by position ("Selector 1 provider", "Selector 2 model", "Remove selector 2") so every row of a chain is distinguishable to screen readers.
