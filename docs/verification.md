# Verification Record (Profile Installation and Plugin-Config Card Runtime Verification)

This document records the installation / runtime-contract verification already completed for `dsh-llm-fallbacks` in **this repo's verification environment (a sandbox-compatible scratch environment)**, plus the verification steps and expected results that **must be executed in the user's real dsh environment**.

> **Scope statement**: this repo's verification environment is sandbox-constrained — it **cannot perform any write to a running dsh installation (a real `$DSH_HOME`)**, and it cannot operate the web settings GUI, issue real model calls, or observe across processes. Therefore "Verified" below covers only evidence completable inside the workspace (unit/integration tests, scratch-profile loading and `--dump-config` layer order, the build pipeline); "To be run by the user" lists the real-environment steps and expectations, labeled honestly without overstating the verified scope.

## Verified (evidence summary for this iteration)

> **Snapshot scope**: the §1 table is the **pre-direction-C baseline** — its rows, suite names, counts and stated contracts are the verification round that produced them (they were not all re-derived together); the §1 aggregate (55 files / 1335 tests) is `main`'s session-log-repair records refresh (merge commit `e4c0957`, PR #115), not the current tip. The `dispatch + subagent routing` row is the one row re-derived on the merged plan branch. The 0.2.2-rc.1 direction-C change replaced the decision path and moved the suite set with it — see the delta below the table. This document was **not** re-derived against the new suite set here (a local full run is out of scope for a documentation pass; CI owns it), so no count below is claimed as the current one.

### 1. Test matrix (unit + integration + client + host gateway + command + release/consumer tooling; 55 files / 1335 tests passed — `main`'s session-log-repair records refresh, not the current tip)

| Scope | Files | Count | Contract covered |
|---|---|---|---|
| host unit tests (T1) | `gateway.spec.ts` | 71 | the three endpoints of `/api/fallbacks/get|set|reset`: `get` returns composed (JSON normalization omits undefined, no resolver); `set` rejects unknown keys, a valid patch writes the user layer and returns the new value, empty/null patches are no-ops; `reset` clears the user layer and returns default composed; without a settings service `get` still succeeds while `set`/`reset` report clear errors (KD-G5); time-slot and all-day tail save guards |
| unit (T2) | `selectors.spec.ts` / `chains.spec.ts` / `cooldown.spec.ts` | 13 / 35 / 15 | selector parsing and specificity (exact / `provider/*`), `provider/*` entries keep the model id and only swap the provider, single-chain candidate resolution (`resolveChainViews` / `selectCandidates` / annotation, no role concatenation), cooldown/revert (lazy expiry, `never` unlimited TTL, read-only snapshot) |
| unit (T3) | `state.spec.ts` / `events.spec.ts` / `config.spec.ts` / `runtime.spec.ts` | 22 / 4 / 38 / 50 | state machine (pendingSwitch created → applied → cleared, `appliedTurnStep` replay guard, reset on step advance), `fallbacks/switch` event shape and JSON round-trip, `Config({})` always equals the default config (no-op baseline), all items of mini-integration Step 6 |
| integration (T4) | `plugin.spec.ts` / `coexist-llm-retry.spec.ts` / `always-mode.spec.ts` | 22 / 4 / 8 | end-to-end re-integration (including the registration-order dependency of the model-selection combination, T2 — the harness double installs the real `agent/pre-step` notice listener, so a re-armed notice loop now fails the suite), **two-plugin coexistence order** (normal backs off first, switches after the budget is exhausted; non-retryable codes switch directly), **always delegates downstream first + cap at the request boundary** (ADR-2; the cap is reachable on the virtual route since plan `model-change-notice-loop` Task 1), cooldown/revert integration, **safety-valve** original error semantics after the cap, combination order without mutual interference |
| dispatch + subagent routing (T4 ext) | `seam-inject.spec.ts` / `dispatch-injection.spec.ts` / `dispatch-integration.spec.ts` / `role-resolution.spec.ts` / `subagents-seam.spec.ts` / `role-notice.spec.ts` / `role-persona.spec.ts` / `role-projection.spec.ts` / `subagent-role-badge.spec.tsx` / `agent-team-roles.spec.ts` | 11 / 6 / 5 / 10 / 43 / 26 / 9 / 16 / 18 / 6 | dispatch-time role resolution from the Assignment header at the subagent dispatch seam (explicit preset → dispatch-declared role; no rules, no auto-match), the `injectRoleChain` stamp matrix (declared role + declared chain pointer + no explicit route + LOCAL backend; unspecified / external / resume / rollback cases), role persona delivery to the child, the in-session role notice row, the projection-key subagent role badge, and the child's first attempt served from the role's named chain |
| client (T5) | `fallbacks-store.spec.ts` / `fallbacks-card.spec.tsx` / `conversation-switch.spec.tsx` / `client-slot-registration.spec.ts` | 20 / 21 / 19 / 2 | card read/write via the **gateway channel** (rpc mock of `/api/fallbacks/get|set|reset`: `load` fetches config from `get`, `save` goes through `set`, `resetToDefaults` goes through `reset`), `present` flag and unreachable-channel skeleton, describe only reads writable + other namespaces, draft seeded only from a real `get` result (I-1 invariant), per-chain / role / slot row-edit round trips, the chain TAB strip (tablist keyboard semantics, add / rename label / delete, ≥1 chain, dirty pip + error mark), per-tab save ISOLATION including add and delete persistence, role cards with the 指定降级链 pointer, conversation switch row (`conversation.chat.node` keyed registration key `fallbacks-switch`, D1-defined state machine match/start/update/buildViewNode, renders `from → to (role · reason)` with unknown reasons passed through verbatim, role=status, malformed payloads degrade to the title row without throwing, zh rendering parity smoke), client slot registration ledger |
| time slots + virtual picker (T5 ext) | `time-slots.spec.ts` / `time-slots-runtime.spec.ts` / `virtual-adapter.spec.ts` / `tui-settings.spec.ts` / `tui-client.spec.ts` / `context-window.spec.ts` / `override.spec.ts` | 43 / 12 / 33 / 51 / 15 / 9 / 14 | all-day tail conformance (Flash / Pro XOR; the retired V4 ids rejected), slot resolver first-match windows, virtual FallbacksChain adapter delegate (served route, no rewrite) + effective-head retry-policy proxy + pi-ai replay-envelope re-stamp for history recorded on the virtual route (with the real-route boundary pin), TUI settings schema readback, context-window cap skip, request override path |
| recovery + seeds + presets | `recovery.spec.ts` / `runtime-recovery.spec.ts` / `success-observation.spec.ts` / `seeds.spec.ts` / `seeds-integration.spec.ts` / `seeds-declare-window.spec.ts` / `presets.spec.ts` / `presets-integration.spec.ts` | 17 / 8 / 13 / 52 / 9 / 3 / 5 / 13 | half-open recovery circuit, runtime recovery listener, role-seed manager + integration, preset seed declarations |
| command (AC-5) | `command.spec.ts` | 78 | `/fallbacks` registration shape (name/description/empty hint/handler, disposer passthrough), conditional `commands` child injection (registers only when a registry exists; silent without a service), snapshot building (role/chain resolution with the default fallback, recent switches newest-first capped, cooldown read-only snapshot), output states (configured chain / no chain / switches present + absent / cooldown present + absent / `never` does not revert), zh/en rendering smoke, real runtime-state integration (switch events + cooldown read from real state; read-only, never adds state) |
| release/consumer tooling | `service.spec.ts` / `export-surface.spec.ts` / `release-scripts.spec.ts` | 12 / 29 / 17 | the named cordis service surface (static provide metadata, `ctx.get` availability while applied, unregister on dispose, multi-fiber dedupe, same functions as the package-root re-exports); the package export surface (runtime values + callable smokes + type exports matching the docs-inventory keys); release-script gates (autoBumpPatch / insertSection / parseArgs / validateReleaseVersion / tagExists) |
| session tooling + repair | `session-event-registration.spec.ts` / `session-event-registration-guard.spec.ts` / `repair-session-logs.spec.ts` / `session-log-rules.spec.ts` / `session-log-publish.spec.ts` / `enabled-read-sweep.spec.ts` | 2 / 2 / 85 / 62 / 43 / 4 | issue #52 stop-write registration guards (no durable `fallbacks/switch` append); the repo-wide `enabled` read sweep over `src/**` (no config-level switch, exact-set allowlist); the pre-V3 session-log triage/repair tool (refusal classification, released-catalog oracle, the rule registry with its exact-set-pinned source vocabulary, successor publication) that replaced the retired fail-closed detector |
| regression | `skeleton.spec.ts` / `host-native.spec.ts` / `peer-deps.test.ts` | 3 / 3 / 5 | bundle contract (row id, empty schema accepted, host+client apply entry points); host-native behavior baseline (real `@deepseek-ai/dsh-agent` module: trigger-code switches route to the chain target, always-cap second return point, no-op invariant); registry peer contract (`@deepseek-ai/*` as peerDependencies only, dsh-* sharing one caret range, autoInstallPeers, no link farm) |

#### Direction C (0.2.2-rc.1) suite delta

Read the table above with this delta applied:

- **Deleted with their mechanism**: `always-mode.spec.ts` (always-mode retry cap), `automatch.spec.ts` (LLM role auto-match), `override.spec.ts` (the `overrideConfig` path), `index-request.spec.ts` (the `agent/request` listener), `allowlist-switch.spec.ts` (the request-time allowlist switch), `context-window.spec.ts` (the request-time context-window walk), `success-observation.spec.ts` (the `session/event` success observer), `runtime.spec.ts`, `time-slots-runtime.spec.ts`, `host-native.spec.ts` (the request-waterfall baseline), and `session-event-registration.spec.ts` / `session-event-registration-guard.spec.ts` (the append-based no-write pins, superseded by the repo-wide write-surface lint).
- **Added**: `chain-walk.spec.ts` (candidate order and filters, committed rule, exactly-one-finish, effort passthrough, exhausted chain, abort forwarding, recursion guard) and `seam-inject.spec.ts` (the five mount conditions, `chainHeads` labels, resume fallback and resume-is-not-a-mount, record stickiness).
- **Per-file counts re-derived on the rc.1 tip** (`rg -c '^\s*it\('` against each file): `chain-walk.spec.ts` 36,
  `seam-inject.spec.ts` 13, `subagents-seam.spec.ts` 43. The aggregate figures elsewhere in this section are unchanged
  snapshots, not these recomputations.
- **Reworked in place**: `coexist-llm-retry.spec.ts` (composition through walk re-entry instead of waterfall order), `runtime-recovery.spec.ts` (half-open closed by attempt completion), `dispatch-injection.spec.ts` / `dispatch-integration.spec.ts` (mount at the seam), `virtual-adapter.spec.ts` (`stream()` returns the walk), `state.spec.ts` (cooldown + recovery only), `plugin.spec.ts`, `gateway.spec.ts`, `command.spec.ts`, `config.spec.ts`, `support/harness.ts` (the waterfall drivers now assert pass-through, and `cfg` / `walkDeps` / `makeAgent` fixtures drive the walk directly).
- **Contract moved, not dropped**: the no-durable-write pin lives in the two stop-write registration specs (`tests/session-event-registration.spec.ts` + `session-event-registration-guard.spec.ts`), listed in the session-tooling row above.

**Test-double caveats (plan `model-change-notice-loop`)**, so a future reader does not mistake them for coverage:

- The harness double (`tests/support/model-selection-stub.ts`) calls the host's **real** `installModelSelection` (plan `model-change-notice-loop` fix round `bcfd827`), so the notice string is built by the upstream `modelSwitchNotice` rather than copied — the double cannot drift from the upstream shape. The literal is still pinned, but now by the **test**, not the seam: `tests/plugin.spec.ts` asserts the `[model changed:` prefix and the `provider/model → provider/model` summary, so a DSH rewording breaks that assertion **without** any plugin defect and has to be re-synced deliberately.
- The half-open probe case (`tests/runtime-recovery.spec.ts`) seeds its episode through the **store seam**
  (`stateStore(ctx).get(agent.id).recovery.markHalfOpen`) instead of driving a real failure path, so it pins the probe's
  route anchoring without re-testing the recovery circuit itself.
- The accepted gaps that live in production code (the anchor's origin gate and its own clock, and the **outer-pass
  replay-envelope strip** for real-route history in a virtual-route session) are recorded under
  [docs/configuration.md](configuration.md) § FallbacksChain in the model picker — they are documented, not tested.
  The envelope gap has one executed half (the real-route boundary arm in `tests/virtual-adapter.spec.ts` asserts the strip)
  and one reasoned half (that the removed root primary rewrite used to keep that history, since the request then carried
  the head pair) — the reasoned half is not measured and cannot be measured in-repo.

Result: **as of `main`'s session-log-repair records refresh — 55 files / 1335 tests passed** (`corepack pnpm@11.21.0 test`, vitest run); `pnpm build` (`tsc -p tsconfig.build.json` emits JS first (standard decorator downgrade `__esDecorate`) → tsdown host bundle →
`pnpm run build-client` → `tsc` declarations → `node scripts/verify-dist.mjs` artifact-parsing guard) all green — `tsc` is
driven by the real host type surface (registry peer `@deepseek-ai/*` at the `package.json` versions, no in-repo type shims). The no-op regression
invariants (empty chains / no match / chain exhausted / safety-valve cap exceeded → pass through without producing
`fallbacks/switch` events) are persistently asserted by T3/T4 tests.

Pre-direction-C snapshot (`pnpm test` re-run on the merged plan branch, 2026-09-11): **57 files / 1391 passed | 0 skipped** — neither this figure nor the aggregates above is the current tip (see the snapshot-scope note in §1).

### 2. Bundle layer order (proven via scratch profile `--dump-config`)

On a **scratch profile inside the workspace** (`DSH_HOME=<plugin-repo>/.dsh-verify`, deleted after verification):

```
$ dsh plugin --profile verify add <plugin-repo>
  → profile initialized; `dsh.profile.bundles` = ["@deepseek-ai/dsh-base", "dsh-llm-fallbacks"]
    (reconcile appends to the end of the list, matching the "add appends by default" semantics)
$ dsh --profile verify --dump-config
  # == @deepseek-ai/dsh-base
  - id: llm-retry            ← llm-retry lives in the dsh-base layer
  ...
  # == dsh-llm-fallbacks
  - id: llm-fallbacks
    name: dsh-llm-fallbacks
    config: {}
```

`llm-fallbacks` sits as an **independent layer after dsh-base (which contains llm-retry)** — i.e. the plugin applies
after the services it consumes (`llm`, `subagents`) exist (corresponding to the bundle layer order section of
[docs/install.md](install.md); the real web profile's layer order `dsh-base → dsh-web-app → @mstar-harness/dsh
→(add) dsh-llm-fallbacks` works the same way — `add` appends to the end, which suffices). Since direction C the plugin
registers no request-waterfall listener, so the former "intervene after llm-retry" ordering requirement no longer
exists; see [docs/install.md](install.md) § Bundle layer order.

### 3. Runtime contracts (backed by test evidence)

- **Switch visibility**: a switch is written to the **info log** (from/to/role/reason/candidates); the plugin writes
  **no** durable `fallbacks/switch` session event (issue #52 stop-write), and the stop-write registration
  specs pin the event-type registration guards that would let such an append back in.
- **Walk outcome semantics**: an uncommitted trigger-code failure advances the walk; a committed failure, an aborted
  finish, a non-trigger code, an exhausted chain or a spent switch cap forwards / re-emits the attempt's terminal
  `finish` verbatim (original code and message preserved), and an empty or undispatchable chain throws
  `EMPTY_EFFECTIVE_CHAIN` / `UNDISPATCHABLE_EFFECTIVE_HEAD` before any chunk. A plugin-originated walk refuses the same
  way — `UNDISPATCHABLE_EFFECTIVE_HEAD`, no attempt dispatched — when the subagent model-selection policy is `unprovable`
  or when the admitted head is no longer on the allowlist after the catalog query (`tests/chain-walk.spec.ts`).
- **No residue on unload**: `agent/disposed` removes the per-agent state and the seam record entries, and `ctx.effect`
  dispose clears the stores wholesale (`tests/state.spec.ts` + the walk's own disposal assertions).
- **Real-type contract**: the type layer does not use hand-written `peer-stubs/` — the real
  `@deepseek-ai/*` packages (the versions declared in `package.json`) drive `tsc` and the integration tests (`tests/support/harness.ts` +
  llm-retry-stub + model-selection-stub): in registry mode `autoInstallPeers` resolves them from npm (user-level
  `~/.npmrc` auth, no local link farm); the local-link alternative (a sibling dsh checkout linked into
  `node_modules`) remains available for pre-publish lines (see docs/install.md). Runtime seams run the real
  implementations: the settings section is the Loader entry Config itself (0.1.7-rc.1 form-service model — the
  volatile `Config` schema is what makes the entry describable/writable), exercised through the real
  `SettingsForms` face over the in-memory double `tests/support/memory-settings.ts` (the 0.1.5-era
  `SettingsProvider` base class is gone), and the client store VALUE import runs the real `@deepseek-ai/dsh-client-store`
  snapshot-store engine — resolved from the published package in registry mode, or through the vitest alias in
  the local-link alternative (a linked tree is tsc-built into `lib/types/` only, so its VALUE imports resolve
  via `vitest.config.ts` aliases instead of the packages' exports maps).
  The plugin makes **zero local modifications** to the dsh source tree — installation = bundle row insert
  (`bundle/cordis.patch.yml`) + client inject (`dsh.client.inject`) + its own gateway channel; dsh upgrades never
  require re-patching (pure-mount semantics).

## To be run by the user (real-environment steps and expectations)

> The following steps must be executed in a **real dsh environment** (a `$DSH_HOME` installation, an operable web GUI,
> and the ability to issue real model calls); paths are always expressed as `$DSH_HOME` — no local absolute paths.

### 1. Loading a real profile

```sh
cd <plugin-repo>
pnpm install          # self-build via prepare (pnpm toolchain)
dsh plugin --profile web add .
dsh --profile web --dump-config   # the composed tree should end with a # == dsh-llm-fallbacks layer
```

**Expected**: `dsh-llm-fallbacks` is appended to the end of `dsh.profile.bundles` (after `@deepseek-ai/dsh-base`);
in `--dump-config` the `llm-fallbacks` layer appears after the dsh-base layer that contains `llm-retry`.
Then restart the dsh web session so the host half and the client half load.

### 2. Web plugin-config card verification

1. Open the web settings GUI → Settings → **插件配置** (**Plugin Settings**), confirm the **Fallbacks card** appears (same list as the bash / agent-loop / web-search / advisor cards), titled/described/iconified from the plugin's `locale/*.json` meta + `icon.svg`.
2. **Flat always-open form**: the card renders its full configuration form unconditionally — no collapsible chrome and no
   feature switch (the config-level `enabled` key was removed; the Plugins-page row toggle is the master switch) — with the
   主代理 / 子代理 / 高级选项 headings as flat, non-collapsible section markers and the read-only status block at the bottom.
   The card is always usable and never blank just because the namespace is missing.
3. Edit any field (e.g. change `cooldownMs` to `600000`) — the single footer Save/Discard pair arms (Save disabled =
   `!dirty || invalid || saving || !writable`) — and save.
4. **Expected**: the save succeeds with no conflict banner; `$DSH_HOME/settings.yaml` (or that profile's settings
   path) gets the whole validated draft written; re-entering the page shows the saved values, and a concurrent
   modification from another session surfaces as a truthful error banner on save — the gateway `set` has no revision
   guard, so there is no "Reload" prompt and no silent overwrite (KD-G3).
5. **Discard**: click the footer Discard → the WHOLE draft reverts to the last accepted config and the gates relock
   (staged edits survive refresh in the store, so Discard is kept — the documented divergence from the official
   no-discard form; the card's Reset-to-defaults button is gone and the gateway `fallbacks/reset` RPC remains a host API).

### 3. Runtime fallback verification (simulated failures)

1. Configure a demo fallback chain in the `fallbacks` namespace: point a chain's `entries` at a **fallback model**
   (e.g. `openai/gpt-4o-mini`), misconfigure the primary model's (e.g. `deepseek/deepseek-chat`) credentials or
   point the chain at a non-existent provider, and construct a **non-retryable failure code** (`AUTH` / `QUOTA` path,
   reaching the walk directly without backoff). **Select `FallbacksChain / Auto` in the model picker** — a session on a
   real model has no chain and must show no plugin behavior at all (that negative case is step 5).
2. Issue a request to trigger the failure.
3. **Expected**:
   - info-level logs from this plugin appear (candidate attempt order and skip reasons);
   - the session event stream gains **no** `fallbacks/switch` entry (issue #52 stop-write — the switch is recorded in
     the info log only);
   - the request continues on the fallback model and the current step/turn is not interrupted.
4. Retryable-code path (`RATE_LIMIT` / 5xx): with `RATE_LIMIT` in `triggerCodes`, observe
   llm-retry backing off first, then the retry re-entering the walk — which happens **inside the same step** and starts
   past the head that just went on cooldown.
5. **Negative case (direction C)**: switch the session to a real provider/model and repeat the failure. Expected: no
   plugin log line, no cooldown, no walk — llm-retry is the only retry layer.

### 4. QA gate end-to-end verification script (plugin-config card read/write loop + save-takes-effect + switch routing + status block)

> This section is the **mandatory input** for the QA gate phase: execute and record the steps in a real dsh environment
> (`$DSH_HOME` installation, web profile, operable web settings GUI, real model calls). Paths are always expressed as
> `$DSH_HOME` — no local absolute paths. §4.2's "save takes effect" is anchored to the host **PID + start-time
> baseline** recorded in §4.1 (same PID, same start time, no page reload).

#### 4.1 Environment preparation (new snapshot baseline)

1. **Preflight check**: record `dsh --version` (snapshot); the plugin-side peer dependencies resolve from the npm registry
   (`@deepseek-ai/*` at the `package.json` versions, no source tree needed).
2. **Plugin build**: `cd <plugin-repo> && pnpm build` (host bundle + client bundle + tsc
   declarations) green — pure-mount semantics: no dsh source-tree modification, no patch step; settings read/write go through the plugin
   gateway channel (`/api/fallbacks/get|set|reset`), usable right after installation.
3. **Restart `dsh web` (web profile)**: stop the old host process → start `dsh web` with the web profile
   (when `--dev` is unavailable, rebuild web artifacts and refresh the verification URL).
4. **Record the baseline**: `ps -o pid,lstart -p <dsh-web-pid>` (or locate via `pgrep -fl "dsh web"`) —
   **PID + start time** serve as the §4.2 "no host restart" comparison anchor; also record the current `fallbacks:` section
   state in `$DSH_HOME/settings.yaml` (expected: no such section, or one without content).

#### 4.2 Plugin-config card read/write loop (save-takes-effect, AC-1)

1. Open the web settings GUI → Settings → **Plugin Settings** → **Fallbacks card**.
2. **Expected ① (gateway channel works)**: the card renders its flat always-open form (the 主代理 / 子代理 / 高级选项
   section headings, the read-only status block, one Save/Discard footer; no feature switch — the config-level `enabled`
   key was removed) — config read/write goes through the plugin's gateway channel
   (`/api/fallbacks/get|set|reset`), independent of any settings-exposure mechanism of the dsh host (the `fallbacks`
   namespace not appearing in the describe exposure set is by design); a successful `get` sets `present`,
   and an unreachable channel shows the flat informational notice atop the still-usable form rather than a dead page.
3. **Add a chain via catalog selection**: create a chain in the 虚拟链 tab strip (`＋`), name its label, then pick
   targets in its 默认降级链 selector rows through the provider/model **dropdown (model catalog)** and one 默认模型
   tail (Flash or Pro). A role card's 指定降级链 dropdown points a dispatched child at one named chain (optional).
   New rows only offer in-catalog options; out-of-catalog values are kept, annotated as synthetic options.
5. **Save** → UI saving → ready (`save` writes the user layer via `fallbacks/set`; `set` is
   merge-semantics with no revision guard — concurrent modifications no longer show a conflict banner; errors always
   surface truthfully in a banner).
6. **Disk evidence**: `$DSH_HOME/settings.yaml` gains a `fallbacks:` section matching the saved values
   (the added chain line — no `enabled` key exists any more).
7. **Take-effect evidence (AC-1 core)**: **without restarting the host or reloading the page** — first confirm the host PID/start
   time matches the §4.1 baseline (`ps -o pid,lstart -p <pid>`), select `FallbacksChain / Auto` for the session, then
   trigger one trigger-code failure (§4.3 injection method, e.g. AUTH/QUOTA) → expected:
   - `llm-fallbacks: agent ... switch` appears in the logs (info level, candidate attempt order and skip reasons);
   - the session event stream gains **no** `fallbacks/switch` event (issue #52 stop-write — the switch is recorded in
     the info log only);
   - subsequent requests route to the chain target (provider/model becomes the first chain entry), and the current step/turn
     is not interrupted.
   → **the next failure after saving switches = no session restart needed**.
8. **Read-back evidence**: reload the page → the server truth renders via `fallbacks/get` (the chain line is there);
   the status block does **not** show step 7's switch (no durable event was written — the recent-switch line reflects
   only events already in the session history, see §4.3 step 4).
9. **Counter-evidence control**: if step 7 shows the change **only takes effect after a host restart** → record it
   truthfully (with PID/start-time change evidence), and report it back to the compass/spec product commitment (the
   Global Constraint fallback clause).

#### 4.3 Switch routing + status block (AC-2 / AC-7)

1. **Failure injection**: configure a demo fallback chain (its `entries` pointing at a fallback model) and select its `FallbacksChain/<id>` row
   `FallbacksChain / Auto` for the session; misconfigure the primary model's credentials or point the chain at a
   non-existent provider to construct a **non-retryable failure code** (`AUTH` / `QUOTA`, reaching the walk directly
   without backoff);
   on the retryable-code path (`RATE_LIMIT` / 5xx) observe llm-retry backing off first and the chain decision
   after its budget is exhausted.
2. **Expected**: `llm-fallbacks: agent ... switch` in the logs (no durable `fallbacks/switch` session event is written — issue #52 stop-write; the switch is recorded only in the info log) + the request
   continuing on the chain target with the current step/turn uninterrupted (corresponding to the §3 runtime verification).
3. **Route scope decides who has a chain**: run the same injection against a session on a **real** provider/model.
   Expected: no switch, no walk, no plugin log line — the failure is llm-retry's alone. With `FallbacksChain / Auto`
   selected, the session's recorded route stays the virtual pair across the switch, so a web model selection has nothing
   to re-apply over (see §4.7).
4. **Status-block entry (AC-2/AC-7)**: the plugin-config card's status block shows **only** the recent-switch line
   (from/to/role/reason, newest first), read from the current session's raw event surface — the plugin writes no durable
   `fallbacks/switch` events (issue #52 stop-write), so the line reflects only events already in the session history
   (e.g. legacy `fallbacks/switch` events — the repair script cannot make such sessions loadable, see the README
   Features note); new switches are **not** visible
   here, neither in-process nor after a restart (they are recorded in the info logs instead). The former "current
   effective model" line (D-6) and the selectionNote line were removed from the card (compass AC-2 — the read-only
   status block keeps the recent switch only). The summary refreshes via push on `settings/document-updated` (fallbacks
   namespace) / `llm/adapters-updated` (catalog only) / session switch / connection reset — with no durable events
   written, a switch occurring while the page is open never appears, with or without a page reload or host restart.
5. **In-session diagnostics (AC-5)**: type `/fallbacks` in the same session; the output should contain the session origin
   (root/subagent), the resolved role, the resolved chain (including the default-fallback annotation), recent switches
   (newest first, from/to/role/reason — historical events only; the plugin writes no durable events, issue #52, so new
   switches are visible in the info logs, not here) and the cooldown state; the command is read-only and never changes
   any fallback state.
6. **Virtual route + model-selection notice (plan `model-change-notice-loop`)**: select `FallbacksChain` / `Auto` in the
   model picker and run a multi-step turn. Expected — the session log's `request/header.config` records the **virtual
   pair** `{ provider: 'FallbacksChain', model: 'Auto' }` (the route is served, no longer rewritten to the head), and the
   durable `user/message` notices with `source.plugin = 'model-selection'` appear **once per genuine selection change**
   only: a steady-state step appends none (the pre-fix measurement was 10 notices over 10 admitted steps with the header
   holding the rewritten real head), and changing the session model away from the row appends exactly one. Then confirm the
   served head's retry policy applies on this route (with e.g. `llm-deepseek.retryPolicy: { mode: 'always' }` the request
   retries before any fallback walk), that an always-mode retry re-enters the walk and resumes past a head the previous
   attempt put on cooldown, and that a walk which cannot advance re-emits the last attempt's terminal error.

#### 4.4 No-regression spot checks

1. **Default-config no-op**: empty the `fallbacks:` section (or the unconfigured state — there is no `enabled` switch to
   turn off any more) → trigger the same kind of failure → no switch, no `fallbacks/switch` event, and request behavior
   identical to an uninstalled plugin.
2. **Out-of-catalog values survive read-back**: hand-write an out-of-catalog selector (e.g. `provider/legacy-model`) and
   save → reloading the page still shows the value (synthetic option annotated "outside catalog"), not discarded by the
   catalog selection.
3. **Concurrent-modification spot check (optional)**: after another session / a direct `settings.yaml` edit, saving → an
   error banner truthfully presents the save result without silent overwrite (gateway `set` has no revision guard; conflict
   protection degrades to "errors surfaced truthfully", KD-G3).

#### 4.5 Recording results

- Record in a table: step / expected / actual / evidence (log lines, `settings.yaml` excerpts, screenshots, PID baseline).
- Any step that deviates from expectations → record it as a QA finding (severity + reproduction steps), report it
  truthfully, and do not write it back into "Verified".

#### 4.6 Subagent chain mount at the dispatch seam

1. **Setup**: with fallback content configured (a non-empty chain for the child's role), dispatch a subagent whose
   dispatch prompt declares `**Execute as**: <id>` for a declared role, on a **local** backend, and without an explicit
   `provider`/`model` in the spawn request.
2. **Expected**: the child's recorded route is the virtual pair — `agentProvider: 'FallbacksChain'`,
   `agentModel: 'Auto'` in the activation descriptor — and its `request/header.config` records that pair; with the host
   `subagent-model-selection` policy enabled, the card's Subagents section shows the effective chain head with source
   `injected`. A failure on a listed code then walks the role chain, and the info log names the from/to pair with
   `role=<resolved role>`.
3. **Explicit route is untouched**: repeat with a spawn request that already carries `provider`+`model`. Expected: the
   child keeps that route, the card (policy enabled) labels the head `authorized`, and no chain participates (the child's
   requests are real-route).
4. **External backend degrades**: dispatch the same child on an external (acp) provider. Expected: no local agent is
   created, nothing is mounted, and the child runs without a chain — the documented degradation, never a failed
   dispatch.
5. **No first-request hook**: no `role-inject` log line appears at any request; the plugin registers no request-path
   listener, so there is nothing to observe there and nothing that a manual web model selection could re-apply over.

#### 4.7 Model selection and fallback switching no longer interact

1. **Background**: the pre-upgrade plugin decided switches in a request-waterfall listener and rewrote the request, so a
   web-front-end model selection could be re-applied over the switched route (the retired `status.selectionNote`
   degradation). Direction C removed that path.
2. **Semantics now**: the walk dispatches each attempt itself inside the virtual route's `stream()`. A session on
   `FallbacksChain` / `Auto` keeps that selection while attempts move between real provider/model pairs; a session on a
   real model is never touched by this plugin. There is no plugin-originated route rewrite left for a selection
   listener to re-apply over.
3. **What to check anyway**: with `FallbacksChain` / `Auto` selected, the session's recorded route stays the virtual
   pair across a switch (no `model/selection` churn, §4.3 step 6), and the host's model-change notice appears only on a
   genuine selection change.
4. **Spec/guide records**: `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/role-and-model-selection-exploration.md`
   (Model-selection section) documents the retired behavior; §4.3 step 3 above is the current expected result.

## Known limitations (real runtime surfaces the sandbox cannot cover)

| Surface | Why not covered | Verification owner |
|---|---|---|
| web settings GUI interaction (card appears, edit & save, conflict reload) | the sandbox cannot operate a real web session | user §2 / §4 (client-half logic already covered by the client matrix row above) |
| real model calls and failure injection (AUTH/QUOTA/RATE_LIMIT triggers, switch continuation) | the sandbox has no real model credentials or running session | user §3 / §4 (decision logic already covered by T3/T4 integration tests) |
| cross-process observation (info logs, no durable `fallbacks/switch` events landing in a real session) | the sandbox cannot run a real dsh session — issue #52's reload gap is closed by the stop-write decision (the stop-write registration specs pin the event-type guards against a reintroduced append, and the walk writes no durable event by construction) and the repair tool's default refusal is covered by `tests/repair-session-logs.spec.ts` + `tests/session-log-rules.spec.ts` (the released session-format chain refuses ignorable-marked unknown events, so the default registry can never write a repair; only the explicit lossy `--drop-legacy-events` opt-in removes such rows) | user §3/§4 + `scripts/repair-session-logs.ts` |
| `/fallbacks` command input/output in a real session | the sandbox cannot run a real dsh session and command registry | user §4.3 step 5 (command logic already covered by command.spec.ts) |
