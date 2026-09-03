# Verification Record (Profile Installation and Plugin-Config Card Runtime Verification)

This document records the installation / runtime-contract verification already completed for `dsh-llm-fallbacks` in **this repo's verification environment (a sandbox-compatible scratch environment)**, plus the verification steps and expected results that **must be executed in the user's real dsh environment**.

> **Scope statement**: this repo's verification environment is sandbox-constrained — it **cannot perform any write to a running dsh installation (a real `$DSH_HOME`)**, and it cannot operate the web settings GUI, issue real model calls, or observe across processes. Therefore "Verified" below covers only evidence completable inside the workspace (unit/integration tests, scratch-profile loading and `--dump-config` layer order, the build pipeline); "To be run by the user" lists the real-environment steps and expectations, labeled honestly without overstating the verified scope.

## Verified (evidence summary for this iteration)

### 1. Test matrix (unit + integration + client + host gateway + command + release/consumer tooling; 23 files / 475 tests all green)

| Scope | Files | Count | Contract covered |
|---|---|---|---|
| host unit tests (T1) | `gateway.spec.ts` | 35 | the three endpoints of `/api/fallbacks/get|set|reset`: `get` returns composed (JSON normalization omits undefined, no resolver); `set` rejects unknown keys, a valid patch writes the user layer and returns the new value, empty/null patches are no-ops; `reset` clears the user layer and returns default composed; without a settings service `get` still succeeds while `set`/`reset` report clear errors (KD-G5) |
| unit (T2) | `selectors.spec.ts` / `chains.spec.ts` / `roles.spec.ts` / `cooldown.spec.ts` | 11 / 34 / 15 / 12 | selector parsing and specificity (exact → `provider/*` → role → default), `provider/*` entries keep the model id and only swap the provider, role-rule ordered matching (rules-only: origin/provider/model → default), cooldown/revert (lazy expiry, `never` unlimited TTL, read-only snapshot) |
| unit (T3) | `state.spec.ts` / `events.spec.ts` / `config.spec.ts` / `runtime.spec.ts` | 13 / 4 / 26 / 50 | state machine (pendingSwitch created → applied → cleared, `appliedTurnStep` replay guard, reset on step advance), `fallbacks/switch` event shape and JSON round-trip, `Config({})` always equals the default config (no-op baseline), all items of mini-integration Step 6 |
| integration (T4) | `plugin.spec.ts` / `coexist-llm-retry.spec.ts` / `always-mode.spec.ts` | 19 / 4 / 5 | end-to-end re-integration (including the registration-order dependency of the model-selection combination, T2), **two-plugin coexistence order** (normal backs off first, switches after the budget is exhausted; non-retryable codes switch directly), **always delegates downstream first + cap at the request boundary** (ADR-2), cooldown/revert integration, **safety-valve** original error semantics after the cap, combination order without mutual interference |
| client (T5) | `fallbacks-store.spec.ts` / `fallbacks-card.spec.tsx` / `general-row.spec.tsx` / `conversation-switch.spec.tsx` | 95 / 36 / 9 / 15 | card read/write via the **gateway channel** (rpc mock of `/api/fallbacks/get|set|reset`: `load` fetches config from `get`, `save` goes through `set`, `resetToDefaults` goes through `reset`), `present` flag and unreachable-channel skeleton, describe only reads writable + other namespaces (the fallbacks namespace no longer appears in describe), KD-G3 new error path (errors surface truthfully after the revision guard was removed), draft seeded only from a real `get` result (I-1 invariant), chain/rule row-edit round trips, status-block recent-switch extraction (sessions.history event surface), card chrome (plugin-config page listing, collapse/expand, dirty/save/discard), controller lifecycle; General page status row (`settings.general.item` registration shape id `fallbacks` order 100, enabled badge + recent-switch summary, KD-G5 unreachable does not masquerade as disabled, lazy first read and no re-read once read); conversation switch row (`conversation.chat.node` keyed registration key `fallbacks-switch`, D1-defined state machine match/start/update/buildViewNode, renders `from → to (role · reason)` with unknown reasons passed through verbatim, role=status, malformed payloads degrade to the title row without throwing, zh rendering parity smoke) |
| command (AC-5) | `command.spec.ts` | 30 | `/fallbacks` registration shape (name/description/empty hint/handler, disposer passthrough), conditional `commands` child injection (registers only when a registry exists; silent without a service), snapshot building (role/chain resolution with the default fallback, recent switches newest-first capped, cooldown read-only snapshot), output states (configured chain / no chain / switches present + absent / cooldown present + absent / `never` does not revert), zh/en rendering smoke, real runtime-state integration (switch events + cooldown read from real state; read-only, never adds state) |
| release/consumer tooling | `service.spec.ts` / `export-surface.spec.ts` / `release-scripts.spec.ts` | 7 / 27 / 17 | the named cordis service surface (static provide metadata, `ctx.get` availability while applied, unregister on dispose, multi-fiber dedupe, same functions as the package-root re-exports); the package export surface (runtime values + callable smokes + type exports matching the docs-inventory keys); release-script gates (autoBumpPatch / insertSection / parseArgs / validateReleaseVersion / tagExists) |
| regression | `skeleton.spec.ts` / `host-native.spec.ts` / `peer-deps.test.ts` | 3 / 3 / 5 | bundle contract (row id, empty schema accepted, host+client apply entry points); host-native behavior baseline (real `@deepseek-ai/dsh-agent` module: trigger-code switches route to the chain target, always-cap second return point, no-op invariant); registry peer contract (`@deepseek-ai/*` as peerDependencies only, dsh-* pinned to `^0.1.2-rc.1`, autoInstallPeers, no link farm) |

Result: **23 files / 475 tests all green** (`pnpm test`, vitest run); `pnpm build` (`tsc -p tsconfig.build.json` emits JS first (standard decorator downgrade `__esDecorate`) → tsdown host bundle →
`pnpm run build-client` → `tsc` declarations → `node scripts/verify-dist.mjs` artifact-parsing guard) all green — `tsc` is
driven by the real host type surface (registry peer `@deepseek-ai/*@0.1.2-alpha.2`, no in-repo type shims). The no-op regression
invariants (empty chains / no match / chain exhausted / safety-valve cap exceeded → pass through without producing
`fallbacks/switch` events) are persistently asserted by T3/T4 tests.

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

`llm-fallbacks` sits as an **independent layer after dsh-base (which contains llm-retry)** — i.e. the waterfall
registration order satisfies the hard requirement to "intervene after llm-retry" (corresponding to the bundle layer
order section of [docs/install.md](docs/install.md); the real web profile's layer order `dsh-base → dsh-web-app → @mstar-harness/dsh
→(add) dsh-llm-fallbacks` works the same way — `add` appends to the end, which suffices).

### 3. Runtime contracts (backed by test evidence)

- **Switch visibility**: every switch (including the always-cap path) produces a `fallbacks/switch` event (T3 event
  shape + T4 integration assertions; the spec hard-requires "no event, no switch").
- **Rollback / failure semantics**: chain exhausted / safety-valve cap exceeded / no matching chain / role-resolution
  failure / no `triggerCodes` hit → `next()` passes through, preserving the original error code and message verbatim
  (T3/T4 assertions).
- **No residue on unload**: `agent/disposed` removes state, `agent/status` idle is defensively cleaned, `ctx.effect`
  dispose clears everything (T3 assertions).
- **Real-type contract**: the type layer does not use hand-written `peer-stubs/` — the real
  `@deepseek-ai/*@0.1.2-rc.1` packages drive `tsc` and the integration tests (`tests/support/harness.ts` +
  llm-retry-stub + model-selection-stub): in registry mode `autoInstallPeers` resolves them from npm (user-level
  `~/.npmrc` auth, no local link farm); until 0.1.2 publishes, development links a sibling dsh checkout into
  `node_modules`. Runtime seams run the real implementations: `installSettingsSection` mounts the real
  `@deepseek-ai/dsh-settings` (in-memory provider `tests/support/memory-settings.ts`, inheriting the real
  `SettingsProvider` base class), and the client store VALUE import runs the real `@deepseek-ai/dsh-client-store`
  snapshot-store engine through its vitest alias — the linked tree is tsc-built into `lib/types/` only, so the test
  graph's VALUE imports resolve via `vitest.config.ts` aliases instead of the packages' exports maps.
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

1. Open the web settings GUI → Settings → **插件配置** (**Plugin Settings**), confirm the **Fallbacks card** appears (same list as the bash / agent-loop / web-search / advisor cards).
2. **First open (no `fallbacks` config yet)**: the card shows its skeleton (card header / intro / read-only status block /
   feature switch / save actions), the feature switch `enabled` is **OFF by default**, the configuration form body is hidden
   and the "Feature disabled" hint shows — the card is always usable and never blank just because the namespace is missing.
3. Turn on the `enabled` switch → the configuration form body appears (`triggerCodes` / `rootChain` / `roles` /
   `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`).
4. Edit any field (e.g. change `cooldownMs` to `600000`) and save.
5. **Expected**: the save succeeds with no conflict banner; `$DSH_HOME/settings.yaml` (or that profile's settings
   path) gets the new value written (including `enabled: true`); re-entering the page shows the saved value with the switch
   still ON, and a concurrent modification from another session surfaces as a truthful error banner on save — the gateway
   `set` has no revision guard, so there is no "Reload" prompt and no silent overwrite (KD-G3).
6. Turn off the `enabled` switch → the form body hides again (an in-progress draft is kept and still there when reopened);
   the compact row's Save/Discard operate on `enabled` only (PR #62 UX round 3 — hidden section drafts are never persisted,
   and the card's Reset-to-defaults button is gone; the gateway `fallbacks/reset` RPC remains a host API).

### 3. Runtime fallback verification (simulated failures)

1. Configure a demo fallback chain in the `fallbacks` namespace: point `rootChain` at a **fallback model**
   (e.g. `openai/gpt-4o-mini`), misconfigure the primary model's (e.g. `deepseek/deepseek-chat`) credentials or
   point the chain at a non-existent provider, and construct a **non-retryable failure code** (`AUTH` / `QUOTA` path,
   reaching the plugin directly without backoff).
2. Issue a request to trigger the failure.
3. **Expected**:
   - info-level logs from this plugin appear (candidate attempt order and skip reasons);
   - the session event stream gains **no** `fallbacks/switch` entry (issue #52 stop-write — the switch is recorded in
     the info log only);
   - the request continues on the fallback model and the current step/turn is not interrupted.
4. Retryable-code path (`RATE_LIMIT` / 5xx): with `RATE_LIMIT` in `triggerCodes`, observe
   llm-retry backing off first and the chain decision being entered only after its budget is exhausted — confirming
   the layer order (fallback does not preempt backoff).

### 4. QA gate end-to-end verification script (plugin-config card read/write loop + save-takes-effect + switch routing + status block)

> This section is the **mandatory input** for the QA gate phase: execute and record the steps in a real dsh environment
> (`$DSH_HOME` installation, web profile, operable web settings GUI, real model calls). Paths are always expressed as
> `$DSH_HOME` — no local absolute paths. §4.2's "save takes effect" is anchored to the host **PID + start-time
> baseline** recorded in §4.1 (same PID, same start time, no page reload).

#### 4.1 Environment preparation (new snapshot baseline)

1. **Preflight check**: record `dsh --version` (snapshot); the plugin-side peer dependencies resolve from the npm registry
   (`@deepseek-ai/*@0.1.2-rc.1`, no source tree needed).
2. **Plugin build**: `cd <plugin-repo> && pnpm build` (host bundle + client bundle + tsc
   declarations) green — pure-mount semantics: no dsh source-tree modification, no patch step; settings read/write go through the plugin
   gateway channel (`/api/fallbacks/get|set|reset`), usable right after installation.
3. **Restart `dsh web` (web profile)**: stop the old host process → start `dsh web` with the web profile
   (when `--dev` is unavailable, rebuild web artifacts and refresh the verification URL).
4. **Record the baseline**: `ps -o pid,lstart -p <dsh-web-pid>` (or locate via `pgrep -fl "dsh web"`) —
   **PID + start time** serve as the §4.2 "no host restart" comparison anchor; also record the current `fallbacks:` section
   state in `$DSH_HOME/settings.yaml` (expected: no such section, or `enabled: false`).

#### 4.2 Plugin-config card read/write loop (save-takes-effect, AC-1)

1. Open the web settings GUI → Settings → **Plugin Settings** → **Fallbacks card**.
2. **Expected ① (gateway channel works)**: the card renders its skeleton (card header / intro / read-only status block /
   `enabled` switch / save / reset to defaults) — config read/write goes through the plugin's gateway channel
   (`/api/fallbacks/get|set|reset`), independent of any settings-exposure mechanism of the dsh host (the `fallbacks`
   namespace not appearing in the describe exposure set is by design); a successful `get` sets `present`,
   and an unreachable channel shows an actionable skeleton rather than a dead page.
3. Turn on the `enabled` switch → the configuration form body appears (`triggerCodes` / `rootChain` / `roles` /
   `cooldownMs` / `revertPolicy` / `maxSwitchesPerStep` / `alwaysModeRetryCap`).
4. **Add a chain via catalog selection**: in the `rootChain` selector row pick a target in the provider/model **dropdown
   (model catalog)** to add a chain entry (e.g. the root chain → a fallback `provider/model` that exists in the
   catalog); same for `roles.list` role-chain rows and `roles.rules` row editing (optional). New rows only offer
   in-catalog options; out-of-catalog values are kept, annotated as synthetic options.
5. **Save** → UI saving → ready (`save` writes the user layer via `fallbacks/set`; `set` is
   merge-semantics with no revision guard — concurrent modifications no longer show a conflict banner; errors always
   surface truthfully in a banner).
6. **Disk evidence**: `$DSH_HOME/settings.yaml` gains a `fallbacks:` section matching the saved values
   (`enabled: true` + the added chain line).
7. **Take-effect evidence (AC-1 core)**: **without restarting the host or reloading the page** — first confirm the host PID/start
   time matches the §4.1 baseline (`ps -o pid,lstart -p <pid>`), then trigger one trigger-code failure (§4.3
   injection method, e.g. AUTH/QUOTA) → expected:
   - `llm-fallbacks: agent ... switch` appears in the logs (info level, candidate attempt order and skip reasons);
   - the session event stream gains **no** `fallbacks/switch` event (issue #52 stop-write — the switch is recorded in
     the info log only);
   - subsequent requests route to the chain target (provider/model becomes the first chain entry), and the current step/turn
     is not interrupted.
   → **the next failure after saving switches = no session restart needed**.
8. **Read-back evidence**: reload the page → the server truth renders via `fallbacks/get` (`enabled` stays ON,
   the chain line is there);
   the status block does **not** show step 7's switch (no durable event was written — the recent-switch line reflects
   only events already in the session history, see §4.3 step 4).
9. **Counter-evidence control**: if step 7 shows the change **only takes effect after a host restart** → record it
   truthfully (with PID/start-time change evidence), and report it back to the compass/spec product commitment (the
   Global Constraint fallback clause).

#### 4.3 Switch routing + status block (AC-2 / AC-7)

1. **Failure injection**: configure a demo fallback chain (`rootChain` pointing at a fallback model); misconfigure the primary
   model's credentials or point the chain at a non-existent provider to construct a **non-retryable failure code**
   (`AUTH` / `QUOTA`, reaching the plugin directly without backoff);
   on the retryable-code path (`RATE_LIMIT` / 5xx) observe llm-retry backing off first and the chain decision
   after its budget is exhausted.
2. **Expected**: `llm-fallbacks: agent ... switch` in the logs (no durable `fallbacks/switch` session event is written — issue #52 stop-write; the switch is recorded only in the info log) + the request
   continuing on the chain target with the current step/turn uninterrupted (corresponding to the §3 runtime verification).
3. **Under an active model-selection (documented degradation, T2 conclusion)**: with an active model-selection (the user
   picked a provider/model in the settings page / `settings.yaml`), a switch after a trigger-code failure **still happens
   and is recorded in the info log** (no durable `fallbacks/switch` event — issue #52 stop-write); but that step's routing may be re-applied by the outer model-selection listener (a model manually
   selected in the web front end is re-applied after the switch) — this is **host-native behavior** after removing the
   local patch-marker coordination (documented degradation, see §4.7). request-error-triggered chains are unaffected;
   without an active selection the request routes to the chain target. Spec and guides records:
   `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/role-and-model-selection-exploration.md`
   (Model-selection section).
4. **Status-block entry (AC-2/AC-7)**: the plugin-config card's status block shows **only** the recent-switch line
   (from/to/role/reason, newest first), read from the current session's raw event surface — the plugin writes no durable
   `fallbacks/switch` events (issue #52 stop-write), so the line reflects only events already in the session history
   (e.g. legacy events marked ignorable by `scripts/repair-fallbacks-switch-logs.ts`); new switches are **not** visible
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

#### 4.4 No-regression spot checks

1. **Default-config no-op**: set `fallbacks.enabled` back to `false` (or the unconfigured state) → trigger the same kind
   of failure → no switch, no `fallbacks/switch` event, and request behavior identical to an uninstalled plugin.
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

#### 4.6 Dispatch-time role injection (`role-inject` reason) — documented degradation (listener order)

1. **Setup**: with `fallbacks.enabled: true` and a role resolvable for a subagent — an explicit `agentPreset` matching a
   declared role id, a `roles.rules` match, or (with `roleAutoMatch` left at its default `true`) the LLM auto-match stage —
   dispatch a subagent whose resolved role's chain head differs from the request's current model.
2. **Expected**: on the subagent's **first** request the chain-head model is injected — an info-level
   `llm-fallbacks: agent ... role-inject role=<role> model=<provider>/<model>` log line (no durable `fallbacks/switch`
   event is written — issue #52 stop-write; the `role-inject` reason survives only in the event vocabulary for legacy
   events). Later requests are **not**
   re-injected (idempotent once-marker). The injection writes **no** pending switch / cooldown / failure bookkeeping (it is
   not a failure decision). With `roleAutoMatch: false` and no explicit/rules role, no auto-match and no injection occurs
   (today's behavior).
3. **Documented degradation (listener order)**: dispatch injection reuses the same `agent/request` override path as the
   failure-time fallback, so whether it survives a **manual web model selection** depends on waterfall listener order — the
   same documented degradation as the failure-time switch (§4.3 step 3 above). Without an active selection the request
   routes to the injected model.

#### 4.7 Manual web model selection may re-apply over a fallback switch (AC-2 — documented degradation, re-homed)

1. **Background**: removing the marker coordination that shipped with the local dsh-agent patch (plan
   `llm-fallbacks-runtime-depatch`) left the plugin with no way to mark a fallback switch so a web-front-end model
   selection would not re-apply over it. The status block carried a one-line `status.selectionNote` (zh/en) documenting
   this; since plan `fallbacks-settings-visibility` (AC-2) trims the card's read-only status block to the recent-switch
   line only, the degradation is re-homed here with equivalent semantics.
2. **Semantics**: a model **manually selected in the web front end may be re-applied over a fallback switch** — whether
   the switch routing survives depends on the outer model-selection listener's waterfall order. With an active
   model-selection (a provider/model picked in the settings page or `settings.yaml`), a switch after a trigger-code
   failure **still happens and is recorded in the info log** (no durable `fallbacks/switch` event is written — issue
   #52 stop-write), but that step's routing may be re-applied by the selection listener.
3. **Scope**: request-error-triggered chains are unaffected; without an active model selection the request routes to the
   chain target. This is host-native behavior, not a plugin defect.
4. **Spec/guide records**: `.mstar/iterations/iter-20260811-fallbacks-mount-only/guides/role-and-model-selection-exploration.md`
   (Model-selection section); the failure-time switch path is §4.3 step 3 above; the dispatch-injection variant of the
   same listener-order degradation is §4.6 above.

## Known limitations (real runtime surfaces the sandbox cannot cover)

| Surface | Why not covered | Verification owner |
|---|---|---|
| web settings GUI interaction (card appears, edit & save, conflict reload) | the sandbox cannot operate a real web session | user §2 / §4 (client-half logic already covered by T5's 155 tests) |
| real model calls and failure injection (AUTH/QUOTA/RATE_LIMIT triggers, switch continuation) | the sandbox has no real model credentials or running session | user §3 / §4 (decision logic already covered by T3/T4 integration tests) |
| cross-process observation (info logs, no durable `fallbacks/switch` events landing in a real session) | the sandbox cannot run a real dsh session — issue #52's reload gap is closed by the stop-write decision (the no-write pins in `tests/session-event-registration*.spec.ts` cover the commit + role-inject paths) and the repair transform is covered by `tests/repair-fallbacks-switch-logs.spec.ts`; a real repair run stays a user-side step (see the script's `--dry-run`/`--backup`/`--apply` usage) | user §3/§4 + `scripts/repair-fallbacks-switch-logs.ts` |
| `/fallbacks` command input/output in a real session | the sandbox cannot run a real dsh session and command registry | user §4.3 step 5 (command logic already covered by command.spec.ts) |
| real routing override under an active model-selection (documented degradation) | the sandbox has no real web session and model selection | user §4.3 (combination order already covered by T4 integration tests) |
