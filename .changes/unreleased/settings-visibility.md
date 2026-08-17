---
category: Changed
---
- The web settings card's root-chain section makes explicit that the root chain engages **only after the current session's selected model fails** — it never preempts the session model — and shows a prefer-session-model hint only when the plugin is enabled and a root chain is configured.
- The card's read-only status block is trimmed to the **recent switch** only: the "current effective model" line and the `selectionNote` degradation line were removed from the card (the documented model-selection degradation is re-homed to `docs/verification.md` §4.7).
- The settings card now renders an **Enable role auto-match** switch for `fallbacks.roleAutoMatch` (default `true`), reading and writing the existing config key (absent from a legacy config → the toggle is hidden and a save never invents the key).
- The conversation `fallbacks-switch` node now shows an explicit **role badge + `role → model`**, and `role-inject` switches display a localized reason rather than the raw string.
