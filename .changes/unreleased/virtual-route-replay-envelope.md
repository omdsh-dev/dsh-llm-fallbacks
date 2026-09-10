---
category: Fixed
---
- Replaying a pi-ai-backed head on the `FallbacksChain` / `Auto` route no longer drops that adapter's replay envelope for history **recorded on the virtual route**: that history is re-stamped to the provider/model its own envelope names, so thinking/thought signatures and redacted reasoning blocks survive instead of degrading to a provider-neutral transcript.
- History recorded on a **real** provider route still loses its replay envelope in a virtual-route session — the request route is the virtual pair, so the runtime's ownership pass strips it before the delegate runs — and that half cannot be closed from the plugin.
