---
category: Changed
---
- Adopt the 0.1.2 `imageRequestPricing` hook on the virtual chain adapter: image token metering on the fallback chain now resolves the SAME effective head `stream()` dispatches and delegates to that concrete route's adapter, so pricing is route-accurate instead of keyed off the virtual `provider`/`model` row (which carries no pricing of its own).
- Unresolvable routes degrade safely: an unresolvable chain head, a vanished LLM runtime, or a throwing delegate returns `undefined`, so the token meter falls back to its neutral estimate and the hook never throws.
