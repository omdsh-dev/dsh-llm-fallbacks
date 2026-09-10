# Security Policy

## Supported versions

`dsh-llm-fallbacks` is a single, continuously released npm package. Only the
**latest published version** is supported; older versions are not maintained
and do not receive security fixes. Please reproduce a report against the latest
published version (`dsh-llm-fallbacks` on npm) before sending it.

## Reporting a vulnerability

Report suspected vulnerabilities **privately by email to
[tech@btang.cn](mailto:tech@btang.cn)**.

**Do not open a public GitHub issue for a security problem** — a public issue
exposes the problem before a fix exists.

GitHub private vulnerability reporting (the *Report a vulnerability* button
under **Security**) is not enabled on this repository; it may be enabled later
as an additional channel alongside the email address above.

Reports are acknowledged, and reporters are kept informed as the issue is
investigated. There is no bug-bounty program.

## What to include

To make a report actionable, please include:

- the affected version — the npm version (`dsh-llm-fallbacks@<version>`) or the
  commit SHA you built from;
- your environment and front end — the dsh **web** profile or the **dsh-tui**
  terminal profile, with the dsh version if known;
- reproduction steps — the configuration and request sequence that triggers the
  problem;
- observed behavior versus expected behavior;
- your assessment of the impact (for example: leaked credential, request routed
  to an unintended provider/model, unauthorized settings write);
- any proof-of-concept, if you have one.

Redact secrets and tokens from anything you send: API keys, npm tokens, and
session logs that contain authorization headers.

## Scope

**In scope** — the code of this plugin:

- fallback chain decisions (when and where a request is re-dispatched after a
  retry-exhausted, auth, quota, or rate-limit failure);
- the `fallbacks:` settings surface and how configuration layers are composed;
- the `/api/fallbacks/get`, `/api/fallbacks/set`, and `/api/fallbacks/reset`
  gateway channel;
- the web settings card and the dsh-tui `/settings` fallbacks section;
- role seeds and role resolution;
- the session-log triage/repair tool (`scripts/repair-session-logs.ts`, run as
  `pnpm repair:session-logs`; read-only report by default).

**Out of scope**:

- vulnerabilities in the **dsh host itself** or in the `@deepseek-ai/*`
  packages — those belong upstream, with the DeepSeek Harness maintainers;
- general support questions, setup problems, and feature requests — take those
  to [the issue tracker](https://github.com/omdsh-dev/dsh-llm-fallbacks/issues)
  instead.

## Disclosure

If you report a vulnerability, please allow time for it to be investigated and
fixed before disclosing it publicly. Confirmed fixes ship as normal npm
releases and are recorded in [CHANGELOG.md](CHANGELOG.md).
