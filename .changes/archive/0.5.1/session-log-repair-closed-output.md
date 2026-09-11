---
category: Fixed
---
- `pnpm repair:session-logs` no longer dies with an unhandled `EPIPE` stack trace when the consumer stops reading the report (the ordinary `… | head -n 5`): it stops writing to that stream, still completes the run — an `--apply` pass publishes every remaining successor — and exits with the store's own exit code, which `--help` and the README exit-code section now document (a stream error that is not a closed pipe is still surfaced, never swallowed).
