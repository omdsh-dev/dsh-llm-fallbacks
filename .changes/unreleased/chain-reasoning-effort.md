---
category: Fixed
---
- A `FallbacksChain/<chain id>` route now advertises the reasoning capability of the whole chain instead of its current head: an explicit session reasoning effort (for example `high`) is admitted and dropped per hop by the fallback walk, instead of being refused with `UNSUPPORTED_REASONING_EFFORT` before any fallback hop runs.
