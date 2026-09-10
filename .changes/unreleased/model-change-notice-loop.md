---
category: Fixed
---
- With `FallbacksChain` / `Auto` selected, the host's model-change notice is no longer re-armed on every step: the root request is now served and recorded as the virtual pair (the `agent/request` rewrite to the chain head is removed) and the virtual adapter's delegate dispatches the effective head, so the durable `request/header` matches the session selection and the notice appears once on a genuine model change instead of continuously.
- `llm-deepseek.retryPolicy` — including `mode: 'always'` — now applies on the virtual route: the adapter reports the effective head's policy instead of the permissive default (the host captures that policy once at registration, so a later policy edit or a slot-driven head-provider rotation takes effect only after re-registration).
- `alwaysModeRetryCap` now trips on the virtual route; it was unreachable there because the removed rewrite always returned the chain head before the cap check.
