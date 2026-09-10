# Spec: Seeds consumer contract — declare window and provenance (v1)

> Status: locked 2026-09-09 (iteration iter-20260909-seeds-role-ux, grill D1–D4).
> Authority for every consumer-facing contract on the role-seeds surface:
> the `llm-fallbacks` named service (`declareSeeds` / `getEffectiveRoles` /
> `revertSeededPersona`), the gateway `seeds` wire field, and the declare
> window lifecycle. Consumers coding against these surfaces follow THIS file;
> plans reference it as `primary_spec` / `spec_refs` and must not silently
> deviate.

## 1. Declare window lifecycle (issue #105)

- The named service `llm-fallbacks` appears only once the plugin's settings
  write channel is bound (probe it with `ctx.get('llm-fallbacks')`).
  Registration order inside the settings
  inject child is: bind `writeRoles` first, then `sctx.provide('llm-fallbacks', …)`
  (child-context provide — this makes the settings child the owner fiber, so
  the service unregisters on settings teardown)
  — both synchronous in the same callback body.
- **Consumer invariant**: "the service probes non-`undefined`" implies
  "`declareSeeds` can write". The documented declare-on-probe pattern
  (`docs/consumer-api.md`) is race-free by construction; a one-shot consumer
  never needs a retry.
- Visibility lags binding by design (cordis 4 strict `ctx.get` returns
  `undefined` while the owning fiber is still loading), so the implication is
  one-directional and safe: binding always precedes visibility. The service
  was never synchronously observable via `ctx.get` during `apply()`, before
  or after the fix.
- **Host without a settings service**: the service never appears (the settings
  inject child never activates). This is accepted and documented — seed roles
  are unwritable there by definition.
- **Settings teardown / re-appearance**: the service's owner fiber is the
  settings inject child, so when the settings service goes away the named
  service unregisters with it (it does not linger with a dead write channel).
  When the settings service re-appears, the child re-fires: write channel
  re-binds, service re-registers, the bundled preset self-declare re-runs
  (idempotent — no-delta declare performs no settings write).

## 2. Seed provenance wire contract

- `declareSeeds` accepts an optional registered set name:
  `declareSeeds(seeds)` (one-arg, keeps working) or
  `declareSeeds(seeds, { set: 'mstar' })`. The set name is trimmed; an
  invalid set name — empty after trim, non-string, or a RESERVED value —
  warns once (with the `llm-fallbacks: seeds:` prefix) and the declaration
  degrades to the unnamed case. The seeds themselves still apply: a bad
  label must never drop roles.
- **Reserved set names**: `bundled`, `user`, `external`. A companion cannot
  declare under a reserved name (it would forge or shadow the fixed
  provenance labels).
- **Per-producer replacement semantics**: the in-memory, per-apply registry is
  keyed by producer label (`bundled` / registered set name / `external`).
  Each producer has its current id → default-persona slice and declaration
  recency. A declare is that producer's full current declaration set and
  replaces **only that producer's slice**, never the whole registry.
  Omitted ids leave that slice; other producers' slices remain untouched.
  A row stays seeded while any live declaration covers it; only when none
  remains does it read `user`. Its persisted row and operator chain remain
  untouched (R2).
- **Unnamed producers share one `external` slice**: the API carries no caller
  identity. Declare with `{ set: '<name>' }` to keep an independent slice.
- **Resolution precedence**: `bundled` wins for any id the plugin's own preset
  self-declare currently declares; otherwise the **most recent non-bundled
  producer** declaring the id wins (registered set name or `external`);
  no live declaration means `user`. Readback, gateway seed status, and revert
  resolve through this same precedence.
- Per-row `source` on every effective-role readback (`EffectiveRole.source`)
  and on the gateway `seeds` wire entries (`SeedsWireStatus.source`), derived
  at read time from the live declaration registries — never persisted:

  | Source value | Meaning |
  |---|---|
  | `bundled` | the plugin's own bundled preset self-declare currently declares the id, even if another producer also declares it |
  | the trimmed set name | no bundled declaration covers the id, and the most recent non-bundled producer declaring it has this registered `{ set }` name |
  | `external` | no bundled declaration covers the id, and the most recent non-bundled producer declaring it is the shared unnamed slice (no set name or an invalid one) |
  | `user` | no live declaration (operator config row) |

- The card localizes the fixed labels `bundled` / `user` / `external` as
  `内置` / `用户` / `外部` in zh and `bundled` / `User` / `external` in en.
  Registered set names render verbatim, case-preserved.
- **Copy honesty**: the mstar merge-preserve pattern (readback → copy
  currently seeded non-own ids verbatim → one-arg declare) leaves the plugin's
  bundled rows `bundled` and seeded. The companion's copies in the `external`
  slice do not replace the bundled producer's slice. If the bundled producer
  later drops an id, a still-live companion copy keeps it seeded and resolves
  through the same precedence. `user` means no live declaration covers the
  row, not that the operator originally wrote it.
- The wire addition is additive; older clients ignore unknown fields. A
  missing or unknown `source` on the wire degrades gracefully (the card
  renders no badge), never a crash.
- Provenance is metadata only: no change to materialization, attach,
  conflict (R2 / `persona-source`), or revert semantics. Materialization
  compares against the declaring producer's own previous defaults; revert
  restores the currently declared default resolved by the same precedence.
  Declare keeps compute → write → commit and its zero-delta check: a failed
  settings write does not commit the new slice, and a provenance-only change
  performs zero settings writes. No provenance is persisted.

## 3. Bundled preset set

- The bundled preset set is the 5 ids `reviewer`, `scout`, `security-reviewer`,
  `sonic`, `task` (designer and librarian removed 2026-09-09, grill D4).
- `presetRoles` stays `readonly SeedDeclaration[]`; only the element count
  changed. The bundled self-declare records `bundled` provenance internally —
  consumers can never label their own declares as `bundled` (reserved name).
- **Upgrade semantics (R2, no destructive write)**: previously persisted
  designer/librarian rows survive subsequent bundled declares untouched
  (`materialize` leaves ids omitted from the batch alone) and read back as
  `source: 'user'` unless another live producer still declares them. No settings-schema migration, no auto-delete, no
  spurious warns on the upgrade path (the post-restart conservative branch
  only flags a persona that differs from the incoming default — quiet when
  rows sit at their seed defaults).

## References

- Iteration decision log: `.mstar/iterations/iter-20260909-seeds-role-ux/specs/iteration-decisions.md` (D1–D4)
- Plans: `.mstar/plans/seeds-declare-window.md` (§1), `.mstar/plans/seed-source-provenance.md` (§2, §3), `.mstar/plans/role-card-seeded-ux.md` (§2 rendering)
- Consumer docs (Phase 2 deliverable): `docs/consumer-api.md` — the lifecycle and `declareSeeds` sections
