---
category: Fixed
---
- A failure whose code is outside `triggerCodes` now cools its chain head before the failure is forwarded, so an llm-retry re-entry resumes on the next candidate instead of retrying the same provider five times; a forwarded failure of an UNLISTED request-scoped code (`CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_REASONING_EFFORT`, `INVALID_REQUEST`) still leaves a healthy route uncooled, and a code listed in `triggerCodes` keeps its cooldown on both the switch and the forwarded-after-output path.
