---
category: Fixed
---
- A failure whose code is outside `triggerCodes` now cools its chain head before the failure is forwarded, so an llm-retry re-entry resumes on the next candidate instead of retrying the same provider five times; a forwarded request-scoped failure (`CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_REASONING_EFFORT`, `INVALID_REQUEST`) still leaves a healthy route uncooled, and a code listed in `triggerCodes` keeps its existing cooldown behavior.
