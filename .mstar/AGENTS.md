# AGENTS.md — .mstar/ (harness layer)

Harness-layer rules for `dsh-llm-fallbacks`. Source priority: user instruction →
root `AGENTS.md` → this file → harness rules in `mstar-*` skills. This file carries
structure and rules only — never state, counts, findings or current progress.

## Path symbols (SSOT: `mstar-conventions`)

- `{HARNESS_DIR}` = `.mstar/`; `{PLAN_DIR}` = `plans/`; `{SDD_DIR}` = `sdd/<plan-id>/`;
  `{ITERATION_DIR}` = `iterations/`; `{KNOWLEDGE_DIR}` = `knowledge/`;
  `{SPECS_DIR}` = `specs/`; `{WORKFLOW_DIR}` = `workflows/`; `{PROJECT_DIR}` = `projects/`.
- Execution, issue, catalog, roadmap and milestone authority is `{HARNESS_DIR}/store.db`:
  `execution_*` holds work state, `issues` holds findings, `catalog_*` holds registered
  identity, `project_roadmaps` / `project_milestones` hold project direction. Read it
  through the CLI (`mstar status validate`, `plan show`, `issue list`, `roadmap show`,
  `milestone list`, `catalog list`) or `mstar dashboard` — never infer work, finding or
  roadmap state from files.
- `archived/` holds retired sources and carries no authority: nothing under it is a write
  target or an authority fallback.

## Process vs results

- Tracked (shared across clones): this file, `knowledge/**`, `specs/**`.
- Local process, gitignored: `store.db*`, `plans/`, `sdd/`, `iterations/`, `workflows/`,
  `projects/`, `archived/`.
- A finding or decision that must survive a clone is promoted through `mstar-compound`
  into `knowledge/` or `specs/` (or recorded here) — never `git add` process artifacts.

## Content boundaries

| Area | Content |
|------|---------|
| `plans/` | authored main plan `<plan-id>-<name>.md` plus durable gate summaries; an authored artifact, not state authority |
| `sdd/<plan-id>/` | SDD runtime scratch and the `review/` QC/QA bundle — raw seat reports stay here, not in `docs/` |
| `iterations/` | iteration packages: prototypes, compass, guides/specs |
| `knowledge/` | implementation SSOT crystallized from solved problems |
| `specs/` | frozen specs / ADRs |
| `projects/<id>/` | `references/` research corpus and `reports/`; a retired source belongs to `archived/`, not here |
| `workflows/<id>/` | retained `notes.jsonl` bodies |
| `archived/` | retired sources; no authority, never a write target |
| `docs/` | human documentation (outside the harness) |

## State and gates

- States: `Todo` → `InProgress` → `InReview` → `Done` | `Blocked`, held in `store.db`.
  Only `@project-manager` or qualified QA evidence sets `Done`; implementers stop at
  `InReview`.
- Per-plan flow: `specify → clarify → plan (locked) → tasks → implement` → QC tri-review +
  QA gate (`mandatory` or `pm-acceptance`) → Done; `inline` plans use the single-seat
  exception. Standalone plans then continue through the delivery tail (compound
  disposition → PR → merge-ready → terminal close).
- Findings cleanup mode is declared by the Assignment (`zero-residual` | `allow-residual`);
  the default is `allow-residual`.

## Issues (findings SSOT)

- A confirmed finding becomes a row in `store.db` issues: `mstar plan issue-add` inside an
  active plan, `mstar issue add` outside one. A recurrence appends an occurrence
  (`mstar issue occurrence`); dedup is by source identity + root cause, never by title.
- Capture records evidence only — disposition is a separate authorized act
  (`issue close` / `waive` / `duplicate` / `supersede`). A migrated disposition with no
  equivalent in the target lifecycle is recorded as the closest supported one and flagged
  in the closure reason, never silently relabelled.
- A retired register is read-only migration history, never a write target; open findings
  live only in the issue store.

## Authoritative references

`mstar-harness-core` (lifecycle, authorization) · `mstar-conventions` (paths, gitignore) ·
`mstar-artifacts` (plan / review / store fields) · `mstar-project-governance` (roadmap,
milestones, issue capture) · `mstar-phase-gates`, `mstar-review-qc`, `mstar-dispatch-gates`.
