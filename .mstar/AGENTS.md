# AGENTS.md — .mstar/ (harness layer)

Harness-layer rules for `dsh-llm-fallbacks`. Source priority: user instruction →
root `AGENTS.md` → this file → harness rules in `mstar-*` skills.

## Path symbols (SSOT: `mstar-conventions`)

- `{HARNESS_DIR}` = `.mstar/`; `{PLAN_DIR}` = `plans/`; `{SDD_DIR}` = `sdd/<plan-id>/`;
  `{ITERATION_DIR}` = `iterations/`; `{KNOWLEDGE_DIR}` = `knowledge/`;
  `{SPECS_DIR}` = `specs/`; `{WORKFLOW_DIR}` = `workflows/`; `{PROJECT_DIR}` = `projects/`.
- Execution, issue, catalog, roadmap and milestone authority is `{HARNESS_DIR}/store.db`
  (`execution_*`, `issues`, `catalog_*`, `project_roadmaps`, `project_milestones`).
  Read it through the CLI (`mstar status validate`, `plan show`, `issue list`,
  `roadmap show`, `milestone list`, `catalog list`) or `mstar dashboard`.
- Migration history lives in `archived/` and carries no authority: `status.v2.json`,
  `status.v1.json`, `snapshots/`, `tmp/`, `workflows-snapshots/`, `workflow-sessions/`,
  `workflows-empty/`, `plans/`, `projects/_default/{roadmap.md,residuals.json}`.

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
| `projects/<id>/` | `references/` (research corpus) and `reports/`; the retired `roadmap.md` / `residuals.json` sources live under `archived/projects/` |
| `workflows/<id>/` | retained `notes.jsonl` bodies |
| `docs/` | human documentation (outside the harness) |

## State and gates

- States: `Todo` → `InProgress` → `InReview` → `Done` | `Blocked`. Only `@project-manager`
  or qualified QA evidence sets `Done`; implementers stop at `InReview`.
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
  (`issue close` / `waive` / `duplicate` / `supersede`).
- The retired registers (`projects/<id>/residuals.json`, archived under `archived/projects/`)
  are read-only history and never a write target. The 2026-10-16 `_default` register import
  mapped its 55 rows: 46 open, 8 resolved (closed with their original closure evidence), and
  1 superseded recorded as `waived` because no store-resident successor issue exists — that
  disposition is a documented lossy mapping, not a faithful `supersede`. One further,
  still-actionable residual existed only in the archived v1 register
  (`llm-fallbacks-session-event-fix` R2 / S-002: Windows-host reopen confirmation) and was
  captured separately as an open issue.

## Authoritative references

`mstar-harness-core` (lifecycle, authorization) · `mstar-conventions` (paths, gitignore) ·
`mstar-artifacts` (plan / review / store fields) · `mstar-project-governance` (roadmap,
milestones, issue capture) · `mstar-phase-gates`, `mstar-review-qc`, `mstar-dispatch-gates`.
