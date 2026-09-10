---
category: Fixed
---
- Replaying a pi-ai-backed head on the `FallbacksChain` / `Auto` route no longer drops that adapter's replay envelope: the delegated history is re-stamped to the provider/model the envelope itself names, so thinking/thought signatures and redacted reasoning blocks survive instead of degrading to a provider-neutral transcript.
