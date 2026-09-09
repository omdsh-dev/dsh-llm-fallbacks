---
category: Added
---
- Subagent sessions whose dispatch resolved a non-`inherit` role show a compact role badge next to the session title in the web session header; hovering shows `role → provider/model` — the effective route after any override/inject.
- The badge covers both policy-on and policy-off dispatches; `inherit`/unresolved sessions render no badge, records live only for the host process lifetime, and the `role → model` info logs stay the durable record.
- A session header opened before the subagent's first dispatch completes re-probes the readback briefly (~10s), so the badge appears as soon as the role record lands — no re-navigation or reload needed.
