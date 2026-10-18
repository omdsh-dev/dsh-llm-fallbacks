# Repair existing sessions

Session logs written before the current format edge (or by a plugin that merged
a custom message-source kind) fail to load; this tool reports which logs refuse
and can publish repaired successors. Run it with `pnpm repair:session-logs`. The
runtime behavior it recovers is described in
[features.md](features.md#switch-visibility); the `fallbacks` namespace itself
is in [docs/configuration.md](configuration.md).

A session log reaches the GUI only through the **frozen released migration chain**. That chain throws at the first row it cannot classify, so a pre-V3 log written by an older release — or by any plugin that merged a custom message-source kind — makes the session fail to load, and the bytes never change on their own. Two classes cover nearly every case, and both are the same kind of root cause: content outside what a released format edge admits.

| Class | What the log carries | Root cause |
|---|---|---|
| `source-kind` | a message `source.kind` outside the released vocabulary | the vocabulary is frozen **per format edge**, so a plugin that merged a custom kind into `MessageSourceMap` leaves the V2→V3 edge refusing the log (`cannot safely transform unclassified message source`). The released kinds are `user`, `plugin`, `model`, `tool`, `agent-instructions`, `session-reference`, `team-message`, `goal`, `skill-invocation`, `skill-catalog`, `coordinator`, `subagent-report`, `subagent-settled`, `webhook`, `agent-message` |
| `subagent-descriptor-version` | a `subagent/descriptor` row with `version: 2` | the V0→V1 edge admits only descriptor `version: 3`, and dsh releases `v0.1.0-rc.7` … `v0.1.1-rc.2` wrote version 2 |

A third class — the legacy `fallbacks/switch` event type — is **not** repairable by a rewrite: see [Lossy recovery for `fallbacks/switch`](#lossy-recovery-for-fallbacksswitch-opt-in).

**If you author a plugin:** through dsh 0.1.6 the persisted source vocabulary was frozen per format edge, and the sanctioned arm was `{ kind: 'plugin', plugin: '<stable-id>', form: … }`. Since dsh 0.1.7-rc.1 that vocabulary is producer-declared instead ("each producer declares its own `kind` in its own module" — dsh's own `model-selection` notice writes `{ kind: 'model-selection', form: 'notice', … }`), and the one rule a released edge enforces on a direct kind is that it is **non-empty** — except that native V4 admission also refuses the retired literal `plugin` as a direct kind (`format v4 message requires a producer-owned source kind`), so a wrapper must never be written into a V4 log. Old logs written against the frozen vocabulary are exactly what this tool's `source-kind` class repairs.

## Usage

The tool is run from this repository (clone + `pnpm install`). Its sources do ship in the npm tarball, but there is no runnable entry there — no `bin` is registered and `tsx` is a dev dependency — so a registry install cannot run it. It is a **read-only report by default**: it walks a session root, classifies every pre-V3 log into exactly one refusal class and prints per-class counts. Nothing is written unless `--apply` is given.

```sh
git clone https://github.com/omdsh-dev/dsh-llm-fallbacks.git
cd dsh-llm-fallbacks
pnpm install
pnpm repair:session-logs                             # read-only report (the default)
pnpm repair:session-logs -- --root ~/.dsh/sessions   # explicit session root
pnpm repair:session-logs -- --apply                  # publish a repaired successor generation
```

`--dry-run` no longer exists: the report **is** the default mode, and `--dry-run` is rejected as an unknown argument (exit 2).

| Flag | Meaning |
|---|---|
| `--root DIR` | session root to walk (default: `$DSH_HOME` or `~/.dsh`, then `/sessions`) |
| `--apply` | run the rules' proofs and publish a **V3 repair-floor** successor beside each repaired original (requires a resolved released catalog; see [The successor generation is the V3 repair floor](#the-successor-generation-is-the-v3-repair-floor)) |
| `--class NAME` | restrict what `--apply` repairs to one refusal class; the listing, the class table and the exit code still cover every log, and the repairable verdict is always computed over the **full** policy, so it can never hide a refusal or promise a repair this invocation cannot perform |
| `--catalog PATH` | explicit released catalog path (package directory, a directory holding it, or its module entry file). The resolved module is **executed**, not parsed — the same privilege as running this tool — and must declare a current format version ≥ 3; a below-version catalog, or a file candidate owned by a different package, is refused (exit 2) rather than trusted to verify its own output. When the resolved build is **newer** than v3 it must also export `historicalSessionFormatCatalog` (its own V0–V3 reader/encoder), which becomes the repair floor; a build without a usable floor is refused (exit 2) |
| `--backup` | copy the original generation to `<name>.bak` before publishing; a run that publishes nothing removes the copy it created again (a pre-existing one is never touched, and one holding different bytes blocks the repair until you inspect and delete it) |
| `--drop-legacy-events` | opt-in **lossy** recovery for legacy `fallbacks/switch` rows (see below) |
| `--json` | machine-readable report instead of the text report |
| `--quiet` | suppress the per-log lines and the by-class table (warnings and errors are never suppressed) |
| `--help`, `-h` | print the usage text (including the `--apply` precondition) and exit 0 |

The original generation is never modified and never truncated; rollback is deleting the published successor (if dsh has since opened the session and published a newer current generation from it, delete that generation instead), which makes the original the generation dsh opens again.

## The successor generation is the V3 repair floor

A published successor is always a **v3** generation (`session.v3.jsonl.zstd`), the newest generation this tool repairs *to*, even when the installed catalog declares a newer format (dsh 0.2.1-rc.2 declares v4). There are two reasons:

- The tool's whole scope is **pre-V3** logs: both repairable classes are refusals of the V0–V3 edges, and the rule outputs are exactly what those edges admit (the `source-kind` class rewrites a foreign `source.kind` into the released V3 `{ kind: 'plugin', plugin: … }` arm).
- The next released edge (V3→V4) requires **historical child evidence** — one parent's complete child identities and descriptors — which a repair of one standalone log cannot supply. Restoring a pre-V3 log through the newer build's *current* catalog therefore fails with `V3 catalog migration requires explicit historical child facts`, while its `historicalSessionFormatCatalog` (the V0–V3 reader/encoder) restores and verifies the v3 floor exactly.

So the tool reads and re-encodes through that floor catalog. When dsh opens the repaired session it selects the highest generation (the v3 successor), migrates it to the installed current format with the host's own child evidence, and publishes the current generation itself — the same path every readable pre-V3 session takes. The installed catalog must therefore declare `currentVersion >= 3` and, when it is newer than v3, still export `historicalSessionFormatCatalog`; a build without that floor is refused up front (exit 2) rather than trusted to verify its own output.

**`--apply` precondition: run it only while NO dsh instance is writing the sessions under `--root`.** The publisher links the successor into the session directory **without observing the host's flock lease** (that lease is host-internal and cannot be taken from this repo), so a dsh that is still appending to the old generation would be orphaned once the host prefers the successor. Stop dsh first.

**Runtime floor: Node ≥ 22.15.** Reading and writing need `node:zlib` zstd, which that release added (`engines.node` allows `>= 22`); an older runtime fails closed with an actionable message instead of a module-link stack trace.

**Two policies, and `ok-truncated`.** A log's class and its `ok` come from the released chain's policy at the **repair floor** — for a pre-V3 log, the same V0–V3 edges the host runs first; the host's later floor→current migration needs corpus-level child evidence and is outside a single log's verdict. That policy can swallow a refusal and drop every row after it, so every `ok` log is cross-checked with the **same policy under strict recovery** (one axis apart, so a refusal there means rows were dropped rather than "not current-shaped"): when it refuses, the log is reported **`ok-truncated`** (a `strictRefusal` reason in `--json`, an `ok-truncated` count in the summary) because the session opens **without** the rows that refusal swallowed. Such sessions still exit `0` — they do load.

**Discovery never fails open.** A namespace/session directory that cannot be read, a canonical generation **below the format floor** that is a symlink or not a regular file, and a leftover `session.repair.*.jsonl.zstd.tmp` are **reported** (a `skipped`/`staleStagingFiles` entry, always printed and never hidden by `--quiet`), suppress the "no session log …" line, and make the run exit `1`. Symlinks are reported, never followed: a repair writes beside the generation it repairs, which must stay inside `--root`. An unreadable `--root` is fatal (exit `2`) — never an empty report.

**`--apply` refuses a revision it did not decode.** The digest of the bytes this run read is compared with the file before anything is staged, so a concurrent append is refused before the first write. If the source moves *after* a publication this run created, that successor is removed again; if it moves after accepting a pre-existing identical successor, the failure names that file and says to delete it — never "nothing was published".

**A closed report stream is not a store event.** Piping the report into a consumer that stops reading (`pnpm repair:session-logs -- | head -n 5`) closes stdout, and the next write would otherwise raise an unhandled `EPIPE`. Instead the tool stops writing to that stream (with no stack trace), **still finishes the run** — an `--apply` pass publishes every remaining successor — and exits with the exit code below, which always describes what happened to the **store**, never whether the reader stayed. A stream error that is not a closed pipe (a full disk, an I/O failure) is **not** swallowed: it still surfaces as an uncaught error.

**Exit codes**: `0` = every log loads (a session that opens with rows dropped under the strict policy is `ok-truncated` and still exits `0`); `1` = at least one log is still refused/unrepairable, a repair failed, a log was left unpublished (including one `--class` excluded), an input could not be inspected (a `skipped` path), or a stale `session.repair.*.jsonl.zstd.tmp` was found under the root; `2` = fatal (bad arguments, a missing or unreadable `--root`, `--apply` without a resolved catalog, a catalog below format v3 or a newer catalog with no usable `historicalSessionFormatCatalog` floor, `--apply --drop-legacy-events` without `--backup`, or a runtime without `node:zlib` zstd).

## Lossy recovery for `fallbacks/switch` (opt-in)

Versions before 0.2.2 wrote durable `fallbacks/switch` session events (issue #52: the apply()-time event-type registration is ineffective because plugin and host resolve different module instances). The frozen V0→V1 edge refuses that event type **even when the row carries `ignorable: true`**, so no rewrite can make such a row load — removal is the only in-repo recovery. Opting in means accepting two consequences:

1. **The session's recorded provider/model switch audit rows are deleted.** They survive only in the original generation (and in its `.bak` when `--backup` is used): the published successor is the only readable generation that lacks them.
2. **The surviving events are renumbered.** The same edge requires every event's `seq` to equal its running event count, so each surviving event receives the `seq` of its position in the surviving event stream and every Session-seq reference it carries is shifted with it. Their content is otherwise unchanged, byte for byte.

```sh
pnpm repair:session-logs -- --drop-legacy-events                   # report: count what would be dropped
pnpm repair:session-logs -- --drop-legacy-events --apply --backup  # --backup is required here
```

The mode is **off by default**, report mode writes nothing, and `--apply --drop-legacy-events` **requires `--backup`** (exit 2 without it). It fails closed, writing nothing, when a surviving row references a seq that would be dropped, when the source rows are not densely numbered, or when the renumber would cross the header's seed cut. `--json` reports `legacyEventCount` (legacy rows in the source log), `droppedEventCount`, `renumberedEventCount` and a machine-readable `lossyRefusal` reason per log; text runs print the dropped/renumbered counts as a loud warning. A row of any *other* unknown event type is never dropped — such a log stays unrepairable. Without the flag those sessions stay unreadable by design, with their bytes preserved.

The durable fix belongs upstream at the migration edges (the frozen V0→V1 edge admitting the descriptor versions it shipped, and custom message-source kinds moving to the `plugin` arm).
