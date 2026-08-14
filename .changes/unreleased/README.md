# Change fragments

Each file in this directory is a changelog fragment for the next release.
`pnpm release:prepare` collects them into the next `## [<version>] - <date>`
section of `CHANGELOG.md` (directly under `## [Unreleased]`), then moves the
consumed fragments to `.changes/archive/<version>/`.

## Format

- Filename: any slug ending in `.md` (e.g. `add-foo.md`). `README.md` and
  `.gitkeep` are ignored.
- Frontmatter (optional): a `category:` key groups the fragment's bullets
  under a `### <category>` heading in the changelog (default: `Changed`).
- Body: one or more English bullet lines (`- ` prefix), rendered verbatim.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

Keep each fragment focused on a single user-visible change.
