---
category: Changed
---
- Fallback now applies only to sessions whose model selection is `FallbacksChain / Auto`; a real-model selection is served by llm-retry alone, with no plugin fallback.
- A walk switches only while the failed attempt has emitted no output; after the first chunk the attempt is committed and the failure is forwarded verbatim, so no second model's output is appended behind a partial one.
- Subagents mounted through the dispatch seam inherit a chain; explicit routes (`provider` + `model` in the spawn request) and external backends keep their own route unchanged.
- The `alwaysModeRetryCap` and `roleAutoMatch` config keys were removed with no successor; a stored section that still carries them is reported by the legacy-key notice and startup warn, then ignored.
