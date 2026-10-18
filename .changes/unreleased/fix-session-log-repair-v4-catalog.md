---
category: Fixed
---
- `pnpm repair:session-logs` works against the dsh 0.2.1-rc.2 session-format catalog again: a pre-V3 log is repaired and published as its V3 repair-floor generation through the catalog's own `historicalSessionFormatCatalog`, and the host migrates that generation onward to the installed V4 format with its own historical child evidence. Previously every `--apply` publication and every catalog classification of a pre-V3 log failed with `V3 catalog migration requires explicit historical child facts`, because the newer catalog's V3→V4 edge needs corpus-level child evidence a single-log repair cannot supply.
- The resolved catalog's repair floor is now validated and reported: a newer build without a usable `historicalSessionFormatCatalog` is refused up front (exit 2), and the text/`--json` report names both the installed `currentVersion` and the `repairVersion` successors are published at.
