---
category: Fixed
---
- A failure whose code is outside `triggerCodes` now cools its chain head before the failure is forwarded, so an llm-retry re-entry resumes on the next candidate instead of retrying the same provider five times; request-scoped codes (`CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_REASONING_EFFORT`, `INVALID_REQUEST`) still leave a healthy route uncooled.
