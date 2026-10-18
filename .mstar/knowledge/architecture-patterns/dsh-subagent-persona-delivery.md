---
module: dsh-subagent
date: 2026-10-17
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: dsh-021-subagent-seam-repair
applies_when:
  - a dsh plugin must give a subagent a persona / identity text
  - handling the dsh 0.2.1-rc.1 subagent start-surface replacement
  - evaluating whether an Agent Preset can act as a persona-only overlay
tags:
  - dsh
  - subagent
  - persona
  - agent-preset
  - mount-only
  - startactivation
---

# Subagent persona delivery on dsh 0.2.1-rc.1 (mount-only)

## Context

dsh 0.2.1-rc.1 replaced the public subagent start surface with a single
`ctx.subagents.startActivation(spec)`. The old `start(name, request)` /
`startContinuable(spec)` pair is gone, `SubagentStartRequest` no longer carries
`persona`, and `SubagentActivation` returns `{ childId, messageId?, result,
dispose() }`. A plugin that merged a resolved role's persona into the request
has no slot left to write and no method left to wrap.

## Guidance

### Newly dispatched role personas: an `agent/created` scoped prompt section

- `agent/created` fires **before** the agent's first prompt assembly. The
  creation contract (upstream `packages/core/agent`, `CreateAgentOptions.setup`)
  states that everything registered through the agent's context exists before
  `session/created`, `agent/created` and the first prompt assembly, and the
  registry emits `agent/created` through `ctx.serial`.
- Register on the child's own scope, then let the registry's own shadowing rule
  do the replacement:

  ```ts
  agent.ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: PERSONA_PREFIX_SECTION,
      order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: persona,
    })
  })
  ```

  A scoped section **shadows** a same-named global section, so this REPLACES the
  deployment persona rather than concatenating with it.

  Two shipped packages are precedents for this shape, and the closer one is the
  identity case: `@deepseek-ai/dsh-file-reference-local` installs a conditional
  prompt section per agent this way, and **`@deepseek-ai/dsh-tool-agent-team` —
  the Agent Team tool surface — registers its teammate identity and policy on
  `agent.ctx` from an `agent/created` listener**: `scoped.systemPrompt.section({
  name: 'team:policy', … })` plus `scoped.systemPrompt.context({ name:
  'team:identity', …, text: () => \`You are teammate "${name}"…\` })`. Neither
  package uses an Agent Preset or an `agentPreset` request field to deliver
  identity.
- These are precedents for the **mechanism** — scoped prompt contributions on the
  agent's own context — **not** for a lifecycle contract, and not a claim that
  Agent Team is a drop-in per-role persona mechanism. `tool-agent-team` gates its
  `agent/created` install on team membership and contributes team policy plus a
  dynamic team identity; a role-persona channel gates on its own per-child record
  and contributes the persona text. Copy the mechanism; choose your own gate and
  your own content.
- No provider capability participates. The removed `capabilities.persona` gate
  belonged to the request slot, not to this channel, so spawn, fork and acp
  children are all reachable as long as they create a local agent.
- Teardown is the caller's job. Hold the fiber returned per agent, release it on
  `agent/disposed` and on plugin dispose, and give a ROOT-shared dedupe marker
  an **owner identity** — a `dispose()` that clears the whole marker set
  withdraws a still-live sibling installer's claims, and a repeated notification
  that overwrites a stored fiber handle leaves the previous registration
  unreachable.
- External (acp) children create no local agent, so no `agent/created` fires for
  them: role resolution and any catalog record still apply, but no persona,
  notice row or badge can be delivered on this channel.
- **A resumed child can already carry a persona by ANOTHER route — and that is
  where the same-name duplicate comes from.** A continuable subagent whose
  descriptor was persisted with a persona reapplies it on cold resume: upstream
  `manager` composes `descriptor.persona`, and `applyChildOverrides` registers a
  same-named `deployment:persona-prefix` section on the child's own scope. That
  path does not pass through a dispatch seam, so a plugin installing its own
  section must treat a same-name duplicate as "an already-present section" and
  skip — the registry cannot say who registered it. rc.1's own descriptor writer
  has no persona source for new activations, so this concerns descriptors
  persisted by an earlier install (or a future writer), not the normal dispatch
  path.

### An Agent Preset is NOT a persona overlay

- A preset is a **complete agent-plane composition**. Under the shipped
  `web-app` profile the host plane `disabled: true`s `tool-fs`,
  `tool-fs-search`, `tool-jobs`, `skill-filesystem`, `tool-skill`,
  `command-goal`, `tool-goal` and `plan-mode`, and the presets own them
  ("Only the per-agent rows move behind presets … `tool-skill` is what a preset
  mounts to give its agent the catalog and loader at all").
- Upstream `packages/subagent/subagent/src/child-agent.ts`: when
  `composition.agentPreset !== undefined` the child `presets.mount(childCtx, id)`s
  a **standalone** preset instead of `composeFrom(childCtx, parent.ctx)`. A
  preset carrying only a persona row therefore strips the child's entire tool
  surface — it does not merely drop "the parent's extra rows".
- Faithfully cloning the default preset is possible but expensive:
  `AgentPresetRegistry.readDocument(id)` round-trips the declaration as YAML on
  the loader's `entryListSchema` (config included), while
  `compositionInventory()` returns rows **without** their config.
- Rule of thumb: use an Agent Preset when you mean "a different agent"; use the
  scoped prompt section when you mean "the same agent, a different persona".

### Timing: reserve the child id before the native call

`manager.startLocal` mints `childId = spec.childId ?? randomUUID()`, creates the
child, and only then resolves the activation promise — so `agent/created` runs
**before** any `.then` on a wrapper's side. A wrapper whose per-child record must
already be readable by an `agent/created` listener has to:

1. reserve the id itself for local backends —
   `{ ...spec, childId: spec.childId ?? randomUUID() }`. A reserved id with a
   provider lacking `prepareContinuable` throws `UNSUPPORTED_CAPABILITY`, so gate
   the reservation on that method's presence and leave external backends' specs
   untouched; and
2. write the record **synchronously before** delegating, deleting it if the
   native call throws or rejects.

Contain the reservation construction itself: a hostile enumerable getter that
throws during the spread must degrade to the caller's own spec object with one
contained log rather than escaping — and the resulting persona miss must still be
carried to the **resolved** activation id, or the notice reports a delivered
persona for a child that never received one. A resume that already carries a
caller-reserved `childId` rides the same record fallback.

### Reading the dispatch role from another plugin

The seam's ROOT-shared per-child record is also the immediate read surface for
companions in the same host process: `ctx.get('llm-fallbacks').getAgentRole(childId)`
returns the DECLARED RAW role the seam resolved, or `null` when no record exists.

- **Local timing is dispatch-time.** A local backend's record is written
  synchronously before the native activation call, so the getter answers before
  the child's first step — earlier than the durable notice row / projection,
  which are readable only after the first non-empty `agent/pre-step`.
- **External timing is resolution-time.** A non-local provider allocates its own
  child id, so its record appears only once the resolved activation (or the
  parent-owned `subagent/catalog` correlation) supplies that id; before then the
  same id reads `null`.
- **Lifetime.** A local child's record is removed on `agent/disposed`, so the
  value lives exactly for that child's activation lifetime. An external/ACP
  dispatch has no local agent lifecycle to observe, so its record is not removed
  by a child disposal — it remains in the map until the plugin itself disposes
  (which clears the whole map).
- **Read the seam keyed by the APPLY context.** `subagentSeamOf(ctx)` is keyed by
  the context that installed the seam, not by the settings-inject child context
  that provides the service — a getter must close over the installing context.
- **Durable half.** `ROLE_PROJECTION_KEY` (`'fallbacksSubagentRole'`) and
  `readRoleProjectionValue` are re-exported from the package root, so a companion
  reads the projection without hard-coding the literal or duplicating the
  blank-string guard.

## Agent Team members

The experimental Agent Team bundle replaces ordinary delegation with
`spawn_teammate` / `send_message`, and it has **no role or persona slot on its
own request**: `SpawnTeammateRequest = { name, description, prompt:
ContentBlock[], context: 'fresh' | 'fork', provider, signal }`
(`packages/experimental/agent-team/src/types.ts:165-172`). The carrier therefore
stays dynamic — the role is whatever `**Execute as**: <id>` header the model
writes into the teammate's initial prompt.

- **The existing seam already sees every teammate.** `roster.spawn` mints
  `childId` and creates the member through
  `ctx.subagents.startActivation({ delivery: 'parent', childId, provider,
  label: description, request: { prompt, parent } })`
  (`packages/experimental/agent-team/src/roster.ts:248-283`) — the same call the
  plugin's wrapper already intercepts, so persona, notice, badge and role
  resolution need no Agent-Team-specific wiring and no wrapping of the Agent
  Team service.
- **Model selection joined the same seam** (plan
  `dsh-148-agent-team-role-delivery`): the seam's resolved role is now an
  explicit dispatch stage of `resolveRoleAtDispatch`, after the explicit
  `agentPreset` stage and before rules, so the declared role's chain head drives
  the teammate's first request. The stage is generic to the seam, so a normally
  delegated `**Execute as**` child gets the same routing — it closes the latent
  contract gap where the declared role carried the persona but never the model.
- **Absent / undeclared headers fall through.** A prompt without the header, or
  with an id the live declaration set does not hold, resolves to no role and
  takes the ordinary rules → auto-match → `inherit` path; the teammate still
  runs.
- **Names are arbitrary; roles are repeatable.** The role comes from the header,
  never from `name`; teammate names stay unique inside one Team (the roster
  rejects a duplicate name), so several differently named teammates can carry
  one role. There is deliberately no name→role mapping.
- **External providers deliver two outcomes.** A **generic** external (acp)
  child creates no local agent (`agent/created` never fires), so the role
  resolves and is recorded but no persona, notice row or badge is delivered. A
  **roster-shaped teammate** cannot use a non-local provider at all:
  `roster.spawn` always passes a reserved `childId`, and the runtime rejects it
  with `UNSUPPORTED_CAPABILITY`
  (`packages/subagent/subagent/src/index.ts:270-272`), so member creation fails
  and no role is delivered. Persona delivery stays non-durable: it is a section
  on the child's own context, so a teammate resumed after a host restart carries
  none.

## Verification that actually proves the channel

- A unit fake shaped like the **old** surface keeps a suite green straight
  through the replacement. Pin the installed surface explicitly
  (`startActivation` present, `start`/`startContinuable` absent) by resolving the
  peer's own `package.json` → `types` entry, never a hard-coded path or version.
- Prove the shadow against the **real** `@deepseek-ai/dsh-system-prompt`: assert
  the ASSEMBLED prompt carries exactly one persona section with the scoped text,
  and that no extra tick is needed between the `agent/created` dispatch resolving
  and the assembly.
- Prove the consumer path against the real `apply()`: removing the installation
  wiring, or capturing the persona/roles source once instead of reading it live,
  must make the case fail.

## When to Apply

- Adding or reviewing any subagent identity/persona feature in a dsh plugin.
- Migrating a plugin across a subagent start-surface change.
- Deciding between "another agent" (Agent Preset) and "another persona" (scoped
  prompt section).

## References

- Plan `dsh-021-subagent-seam-repair` (`{PLAN_DIR}`) — the implementation this
  pattern was verified in, with its review bundle under `{SDD_DIR}`.
