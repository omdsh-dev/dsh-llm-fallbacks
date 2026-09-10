---
category: Changed
---
- `pnpm repair:session-logs` replaces the retired session-log detector: it is a read-only report by default — classifying every pre-V3 session log and printing per-class counts — and publishes a repaired successor generation only with `--apply` (the old `--dry-run` flag no longer exists, since report mode is the default).
- Session logs blocked by legacy `fallbacks/switch` rows can be recovered with the opt-in lossy `--drop-legacy-events` mode (which requires `--backup` together with `--apply`): it removes those switch-audit rows, renumbers the surviving events, reports the dropped and renumbered event counts, and fails closed with nothing written when a surviving reference names a dropped seq.
