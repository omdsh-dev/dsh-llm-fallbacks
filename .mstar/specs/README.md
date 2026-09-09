# Specs

Repository-level, cross-iteration normative specs. A document lands here only
when its decision is **locked** (changing it requires explicit review) and it
stays authoritative across plans and iterations — it is the `primary_spec` /
`spec_refs` target for the plans that implement it. Iteration-scoped drafts
belong in the iteration package instead
(`.mstar/iterations/<iteration-id>/specs/`).

| Spec | Status | Scope | Locked by |
|------|--------|-------|-----------|
| [seeds-consumer-contract-v1.md](seeds-consumer-contract-v1.md) | locked 2026-09-09 | Seeds consumer contract: declare window lifecycle (issue #105), seed provenance wire contract (`bundled` / set name / `external` / `user`), bundled preset trim upgrade semantics | iter-20260909-seeds-role-ux (grill D1–D4) |

Draft specs in flight live in the active iteration package; they are promoted
here only after their decisions are locked. Promotion of implementation
knowledge to `.mstar/knowledge/` happens at iteration-close via
`mstar-compound`, not here.
