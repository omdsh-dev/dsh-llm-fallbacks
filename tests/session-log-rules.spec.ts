/**
 * Tests for the pure core of the session-log triage/repair tool:
 *   - `classifyRows` (scripts/session-logs/classify.ts) — the first refusal
 *     class of a parsed log;
 *   - the built-in rules (scripts/session-logs/rules.ts) — `source-kind`,
 *     `subagent-descriptor-version`, and the never-repairable legacy
 *     `fallbacks-switch` class;
 *   - the OPT-IN lossy rule `drop-legacy-events`, which the default registry must
 *     never contain and whose drop proves its own survivors.
 *
 * Every fixture here is SYNTHESIZED from the measured payload shapes; no real
 * session content is committed. The expected target shapes are the released
 * ones (see the `rules.ts` docblock for the SSOT paths):
 *   - a foreign `source.kind` normalizes to the `plugin` arm,
 *     `{ kind: 'plugin', plugin: <original kind> }`, keeping `form` / `summary`
 *     / `sections` and dropping every other member;
 *   - a descriptor `version` 2 (or 1) whose payload key set is a subset of the
 *     version-3 admitted set for its `mode` bumps to 3;
 *   - `fallbacks/switch` rows are refused — the frozen chain rejects unknown
 *     event types even with `ignorable: true` — and the opt-in lossy rule is the
 *     only thing that can REMOVE them.
 *
 * Purity is asserted explicitly: normalization must never mutate its input.
 */
import { describe, expect, it } from 'vitest'
import { classifyRows } from '../scripts/session-logs/classify.ts'
import {
  BUILT_IN_RULES,
  dropLegacyEventsRule,
  droppedEventCount,
  fallbacksSwitchRule,
  legacyDropRefusal,
  sourceKindRule,
  subagentDescriptorVersionRule,
  type LogRule,
  type ParsedRow,
} from '../scripts/session-logs/rules.ts'

/** The log header row; `assertSource` never visits it. */
const HEADER: ParsedRow = { type: 'session', seq: 0 }

/** A `user/message` row carrying `source` (the position `assertSource` reads). */
function userMessage(seq: number, source: unknown): ParsedRow {
  return {
    type: 'user/message',
    seq,
    time: 1786936372682,
    data: {
      role: 'user',
      id: `message-${seq}`,
      content: [{ type: 'text', text: 'synthesized body' }],
      source,
    },
  }
}

/** A `subagent/descriptor` row with the given payload. */
function descriptor(seq: number, data: Record<string, unknown>): ParsedRow {
  return { type: 'subagent/descriptor', seq, time: 1786936372682, data }
}

/** `mstar-engine-status`: catalog form plus facts the released arm does not admit. */
const ENGINE_STATUS_SOURCE = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '3.7.3',
  harnessDir: '/tmp/workspace/.mstar',
  enforcement: 'soft',
  state: { plans: [], residuals: { low: 12 } },
}

/** `advisor`: notice form plus a producer-specific member. */
const ADVISOR_SOURCE = {
  kind: 'advisor',
  form: 'notice',
  summary: 'second-model review',
  note: 'dropped by the rewrite',
}

/** `workspace-instructions`: instructions form plus producer-specific members. */
const WORKSPACE_INSTRUCTIONS_SOURCE = {
  kind: 'workspace-instructions',
  form: 'instructions',
  files: ['AGENTS.md'],
  changes: [],
}

/** `mstar-harness-state`: catalog form plus a producer-specific digest. */
const HARNESS_STATE_SOURCE = {
  kind: 'mstar-harness-state',
  form: 'catalog',
  digest: 'a1b2c3',
}

/** Measured legacy shape: `2|one-shot|{label, mode, provider, version}`. */
const DESCRIPTOR_V2_ONE_SHOT = { label: 'explore', mode: 'one-shot', provider: 'deepseek', version: 2 }

/** Measured legacy shape: `2|continuable|{agentModel, agentProvider, label, mode, provider, version}`. */
const DESCRIPTOR_V2_CONTINUABLE = {
  agentModel: 'deepseek-v4-flash',
  agentProvider: 'deepseek',
  label: 'fullstack-dev',
  mode: 'continuable',
  provider: 'deepseek',
  version: 2,
}

/** Current shape: a continuable descriptor already at version 3. */
const DESCRIPTOR_V3_CONTINUABLE = {
  ...DESCRIPTOR_V2_CONTINUABLE,
  version: 3,
  agentReasoningEffort: 'high',
}

/** The legacy plugin event the frozen chain refuses: no rewrite can help. */
const SWITCH_ROW: ParsedRow = {
  type: 'fallbacks/switch',
  seq: 114513,
  time: 1786949105470,
  data: {
    turn: 4,
    step: 30,
    from: { provider: 'ark-plan', model: 'deepseek-v4-flash' },
    to: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
    role: 'inherit',
    reason: 'trigger-code',
  },
}

/** Recursively freeze a fixture: a mutation attempt throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** The released first-party vocabulary (SSOT: `SOURCE_KINDS` in payload.ts). */
const RELEASED_KINDS = [
  'user',
  'plugin',
  'model',
  'tool',
  'agent-instructions',
  'session-reference',
  'team-message',
  'goal',
  'skill-invocation',
  'skill-catalog',
  'coordinator',
  'subagent-report',
  'subagent-settled',
  'webhook',
  'agent-message',
]

describe('classifyRows', () => {
  it('reports ok for a log without any structural refusal', () => {
    const result = classifyRows([HEADER, userMessage(1, { kind: 'user' })], BUILT_IN_RULES)
    expect(result).toEqual({ class: 'ok', findings: [] })
  })

  it('classifies an unclassified source kind', () => {
    const result = classifyRows([HEADER, userMessage(1, ENGINE_STATUS_SOURCE)], BUILT_IN_RULES)
    expect(result.class).toBe('source-kind')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ ruleId: 'source-kind', class: 'source-kind' })
    expect(result.findings[0].detail).toContain('"mstar-engine-status"')
  })

  it('classifies a version-2 one-shot descriptor', () => {
    const result = classifyRows([HEADER, descriptor(4, DESCRIPTOR_V2_ONE_SHOT)], BUILT_IN_RULES)
    expect(result.class).toBe('subagent-descriptor-version')
    expect(result.findings[0].detail).toContain('subagent/descriptor 4')
    expect(result.findings[0].detail).toContain('version 2')
  })

  it('classifies a version-2 continuable descriptor', () => {
    const result = classifyRows([HEADER, descriptor(9, DESCRIPTOR_V2_CONTINUABLE)], BUILT_IN_RULES)
    expect(result.class).toBe('subagent-descriptor-version')
    expect(result.findings).toHaveLength(1)
  })

  it('classifies a legacy fallbacks/switch row as unknown-event-type', () => {
    const result = classifyRows([HEADER, SWITCH_ROW], BUILT_IN_RULES)
    expect(result.class).toBe('unknown-event-type')
    expect(result.findings[0]).toMatchObject({ ruleId: 'fallbacks-switch', class: 'unknown-event-type' })
    expect(result.findings[0].detail).toContain('fallbacks/switch 114513')
  })

  it("reports the FIRST refused row's class, not the registry order", () => {
    const descriptorFirst = classifyRows(
      [HEADER, descriptor(1, DESCRIPTOR_V2_ONE_SHOT), userMessage(2, ADVISOR_SOURCE)],
      BUILT_IN_RULES,
    )
    expect(descriptorFirst.class).toBe('subagent-descriptor-version')

    const sourceFirst = classifyRows(
      [HEADER, userMessage(1, ADVISOR_SOURCE), descriptor(2, DESCRIPTOR_V2_ONE_SHOT)],
      BUILT_IN_RULES,
    )
    expect(sourceFirst.class).toBe('source-kind')
  })

  it('collects the findings of every refused row in log order', () => {
    const result = classifyRows(
      [HEADER, userMessage(1, ADVISOR_SOURCE), descriptor(2, DESCRIPTOR_V2_ONE_SHOT), SWITCH_ROW],
      BUILT_IN_RULES,
    )
    expect(result.class).toBe('source-kind')
    expect(result.findings.map((finding) => finding.ruleId)).toEqual([
      'source-kind',
      'subagent-descriptor-version',
      'fallbacks-switch',
    ])
  })

  it('reports ok for every released first-party source kind', () => {
    for (const kind of RELEASED_KINDS) {
      const result = classifyRows([HEADER, userMessage(1, { kind })], BUILT_IN_RULES)
      expect(result.class, kind).toBe('ok')
      expect(result.findings, kind).toEqual([])
    }
  })

  it('never treats a content-block kind as a message source', () => {
    const toolCall: ParsedRow = {
      type: 'tool/call',
      seq: 3,
      time: 1786936372682,
      data: { message: { id: 'm', content: [{ type: 'tool-call', kind: 'tool-call', toolCallId: 't1' }] } },
    }
    const result = classifyRows([HEADER, toolCall], BUILT_IN_RULES)
    expect(result).toEqual({ class: 'ok', findings: [] })
  })

  it('reports ok for a log with no rows at all', () => {
    expect(classifyRows([], BUILT_IN_RULES)).toEqual({ class: 'ok', findings: [] })
  })
})

describe('sourceKindRule', () => {
  const rewrite = (source: unknown): unknown => {
    const result = sourceKindRule.normalize([HEADER, userMessage(1, source)])
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    const row = result.rows[1]
    return (row.data as { source: unknown }).source
  }

  it('rewrites mstar-engine-status into the plugin arm and drops every other member', () => {
    expect(rewrite(ENGINE_STATUS_SOURCE)).toEqual({
      kind: 'plugin',
      plugin: 'mstar-engine-status',
      form: 'catalog',
    })
  })

  it('rewrites an advisor notice, keeping its summary', () => {
    expect(rewrite(ADVISOR_SOURCE)).toEqual({
      kind: 'plugin',
      plugin: 'advisor',
      form: 'notice',
      summary: 'second-model review',
    })
  })

  it('rewrites workspace-instructions, keeping its form only', () => {
    expect(rewrite(WORKSPACE_INSTRUCTIONS_SOURCE)).toEqual({
      kind: 'plugin',
      plugin: 'workspace-instructions',
      form: 'instructions',
    })
  })

  it('rewrites mstar-harness-state, keeping its form only', () => {
    expect(rewrite(HARNESS_STATE_SOURCE)).toEqual({
      kind: 'plugin',
      plugin: 'mstar-harness-state',
      form: 'catalog',
    })
  })

  it('reports the rewrite as a finding while detecting the refusal', () => {
    const rows = [HEADER, userMessage(7, ADVISOR_SOURCE)]
    const detected = sourceKindRule.detect(rows)
    expect(detected).toHaveLength(1)
    const result = sourceKindRule.normalize(rows)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].detail).toContain('source.kind "advisor" → { kind: "plugin", plugin: "advisor" }')
  })

  it('keeps form/summary/sections only in the combination this rule admits (a conservative subset of the released arm)', () => {
    expect(
      rewrite({
        kind: 'advisor',
        form: 'snapshot',
        sections: [{ name: 'summary', text: 'body' }],
        extra: 1,
      }),
    ).toEqual({
      kind: 'plugin',
      plugin: 'advisor',
      form: 'snapshot',
      sections: [{ name: 'summary', text: 'body' }],
    })
  })

  it('is deliberately STRICTER than `pluginSourceValue`: form-less summary/sections are refused', () => {
    // The released arm returns early when `form` is absent, so it would admit
    // these; this rule refuses them because the missing form is what gave those
    // members their meaning — the stricter behaviour is the fail-closed choice,
    // not an equivalence claim.
    for (const source of [
      { kind: 'advisor', summary: 'no form' },
      { kind: 'advisor', sections: [] },
      { kind: 'advisor', summary: 'no form', sections: [{ name: 'a', text: 'b' }] },
    ]) {
      const result = sourceKindRule.normalize([HEADER, userMessage(1, source)])
      expect('refused' in result, JSON.stringify(source)).toBe(true)
    }
  })

  it('is idempotent: a normalized log has no further findings', () => {
    const rows = [HEADER, userMessage(1, ENGINE_STATUS_SOURCE), userMessage(2, ADVISOR_SOURCE)]
    const first = sourceKindRule.normalize(rows)
    if ('refused' in first) throw new Error(`unexpected refusal: ${first.refused}`)
    expect(first.findings).toHaveLength(2)
    expect(sourceKindRule.detect(first.rows)).toEqual([])
    const second = sourceKindRule.normalize(first.rows)
    if ('refused' in second) throw new Error(`unexpected refusal: ${second.refused}`)
    expect(second.findings).toEqual([])
    expect(second.rows).toEqual(first.rows)
  })

  it('rewrites sources inside agent/inbox/spliced and session/title-llm-request', () => {
    const inbox: ParsedRow = {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: 1786936372682,
      data: { inserted: [{ id: 'a', source: ADVISOR_SOURCE }, { id: 'b', source: { kind: 'user' } }] },
    }
    const titleRequest: ParsedRow = {
      type: 'session/title-llm-request',
      seq: 6,
      time: 1786936372682,
      data: { messages: [{ id: 'c', source: WORKSPACE_INSTRUCTIONS_SOURCE }] },
    }
    const result = sourceKindRule.normalize([HEADER, inbox, titleRequest])
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect((result.rows[1].data as { inserted: { source: unknown }[] }).inserted).toEqual([
      { id: 'a', source: { kind: 'plugin', plugin: 'advisor', form: 'notice', summary: 'second-model review' } },
      { id: 'b', source: { kind: 'user' } },
    ])
    expect((result.rows[2].data as { messages: { source: unknown }[] }).messages).toEqual([
      { id: 'c', source: { kind: 'plugin', plugin: 'workspace-instructions', form: 'instructions' } },
    ])
  })

  it('refuses the whole log when one source is not provably repairable', () => {
    const rows = [HEADER, userMessage(1, ADVISOR_SOURCE), userMessage(2, { kind: 42, form: 'catalog' })]
    const result = sourceKindRule.normalize(rows)
    if (!('refused' in result)) throw new Error('expected a refusal')
    expect(result.refused).toContain('user/message 2 source')
    expect(result.refused).toContain('not a non-empty string')
  })

  it('refuses a kind whose shape cannot be carried into the plugin arm', () => {
    const cases: { source: unknown; reason: string }[] = [
      { source: { kind: 'advisor', form: 'status' }, reason: 'outside the released plugin forms' },
      { source: { kind: 'advisor', summary: 'no form' }, reason: 'admitted only by the notice form' },
      { source: { kind: 'advisor', summary: 7 }, reason: 'admitted only by the notice form' },
      { source: { kind: 'advisor', form: 'notice' }, reason: 'notice form requires source.summary' },
      { source: { kind: 'advisor', form: 'snapshot' }, reason: 'snapshot form requires source.sections' },
      { source: { kind: 'advisor', form: 'snapshot', sections: [{}] }, reason: 'snapshot form' },
      { source: { kind: 'advisor', sections: [] }, reason: 'admitted only by the snapshot form' },
      { source: { kind: 'compact', form: 'catalog' }, reason: 'reserved compact plugin id' },
      { source: { kind: '', form: 'catalog' }, reason: 'not a non-empty string' },
      { source: { form: 'catalog' }, reason: 'not a non-empty string' },
    ]
    for (const { source, reason } of cases) {
      const result = sourceKindRule.normalize([HEADER, userMessage(1, source)])
      if (!('refused' in result)) throw new Error(`expected a refusal for ${JSON.stringify(source)}`)
      expect(result.refused, JSON.stringify(source)).toContain(reason)
    }
  })

  it('never mutates the input rows', () => {
    const rows = deepFreeze([HEADER, userMessage(1, ENGINE_STATUS_SOURCE), userMessage(2, ADVISOR_SOURCE)])
    expect(() => sourceKindRule.detect(rows)).not.toThrow()
    expect(() => sourceKindRule.normalize(rows)).not.toThrow()
    expect(JSON.stringify(rows)).toBe(
      JSON.stringify([HEADER, userMessage(1, ENGINE_STATUS_SOURCE), userMessage(2, ADVISOR_SOURCE)]),
    )
  })
})

describe('subagentDescriptorVersionRule', () => {
  const rewrite = (data: Record<string, unknown>): Record<string, unknown> => {
    const result = subagentDescriptorVersionRule.normalize([HEADER, descriptor(3, data)])
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    return result.rows[1].data as Record<string, unknown>
  }

  it('bumps a version-2 one-shot payload (keys are a subset of the version-3 set)', () => {
    expect(rewrite(DESCRIPTOR_V2_ONE_SHOT)).toEqual({ ...DESCRIPTOR_V2_ONE_SHOT, version: 3 })
  })

  it('bumps a version-2 continuable payload, preserving every member', () => {
    const rewritten = rewrite(DESCRIPTOR_V2_CONTINUABLE)
    expect(rewritten).toEqual({ ...DESCRIPTOR_V2_CONTINUABLE, version: 3 })
    expect(Object.keys(rewritten).sort()).toEqual(Object.keys(DESCRIPTOR_V2_CONTINUABLE).sort())
  })

  it('bumps a version-1 payload only when the same proof holds', () => {
    expect(rewrite({ ...DESCRIPTOR_V2_ONE_SHOT, version: 1 })).toEqual({ ...DESCRIPTOR_V2_ONE_SHOT, version: 3 })
  })

  it('leaves an already-version-3 descriptor alone', () => {
    const rows = [HEADER, descriptor(8, DESCRIPTOR_V3_CONTINUABLE)]
    expect(subagentDescriptorVersionRule.detect(rows)).toEqual([])
    const result = subagentDescriptorVersionRule.normalize(rows)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result).toEqual({ rows, findings: [] })
  })

  it('leaves non-descriptor rows untouched', () => {
    const rows = [HEADER, userMessage(1, { kind: 'user' })]
    const result = subagentDescriptorVersionRule.normalize(rows)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result).toEqual({ rows, findings: [] })
  })

  it('reports the bump as a finding with the mode in its evidence', () => {
    const result = subagentDescriptorVersionRule.normalize([HEADER, descriptor(11, DESCRIPTOR_V2_ONE_SHOT)])
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result.findings).toEqual([
      {
        ruleId: 'subagent-descriptor-version',
        class: 'subagent-descriptor-version',
        detail: 'subagent/descriptor 11: version 2 → 3 (payload keys are a subset of the version-3 "one-shot" set)',
      },
    ])
  })

  it('refuses a payload whose key set is not provably admissible', () => {
    const cases: { data: Record<string, unknown>; reason: string }[] = [
      {
        data: { ...DESCRIPTOR_V2_ONE_SHOT, persona: 'coach' },
        reason: 'outside the version-3 admitted set for mode one-shot',
      },
      { data: { ...DESCRIPTOR_V2_CONTINUABLE, toolFilter: { mode: 'x' } }, reason: 'toolFilter admits only the allow/deny members' },
      { data: { ...DESCRIPTOR_V2_CONTINUABLE, toolFilter: {} }, reason: 'toolFilter requires allow or deny' },
      { data: { ...DESCRIPTOR_V2_CONTINUABLE, toolFilter: ['x'] }, reason: 'toolFilter is not an object' },
      { data: { ...DESCRIPTOR_V2_CONTINUABLE, toolFilter: { allow: [1] } }, reason: 'not an array of non-empty strings' },
      {
        data: { agentProvider: 'deepseek', label: 'dev', mode: 'continuable', provider: 'deepseek', version: 2 },
        reason: 'agentProvider and agentModel must be paired',
      },
      { data: { ...DESCRIPTOR_V2_ONE_SHOT, provider: 7 }, reason: 'provider is not a non-empty string' },
      { data: { ...DESCRIPTOR_V2_ONE_SHOT, mode: 'batch' }, reason: 'is neither of the released descriptor modes' },
      { data: { ...DESCRIPTOR_V2_ONE_SHOT, mode: undefined }, reason: 'is neither of the released descriptor modes' },
    ]
    for (const { data, reason } of cases) {
      const result = subagentDescriptorVersionRule.normalize([HEADER, descriptor(2, data)])
      if (!('refused' in result)) throw new Error(`expected a refusal for ${JSON.stringify(data)}`)
      expect(result.refused, JSON.stringify(data)).toContain(reason)
    }
  })

  it('accepts a well-formed continuable toolFilter', () => {
    const data = { ...DESCRIPTOR_V2_CONTINUABLE, toolFilter: { allow: ['read'], deny: ['bash'] } }
    expect(rewrite(data)).toEqual({ ...data, version: 3 })
  })

  it('refuses a version it cannot prove (4, 0, or a missing version)', () => {
    for (const version of [4, 0, undefined, '2', null]) {
      const result = subagentDescriptorVersionRule.normalize([
        HEADER,
        descriptor(2, { ...DESCRIPTOR_V2_ONE_SHOT, version }),
      ])
      if (!('refused' in result)) throw new Error(`expected a refusal for version ${JSON.stringify(version)}`)
      expect(result.refused).toContain('not a released earlier version')
    }
  })

  it('refuses when the payload is not even an object', () => {
    const result = subagentDescriptorVersionRule.normalize([
      { type: 'subagent/descriptor', seq: 2, data: 'not-a-payload' },
    ])
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result).toEqual({ rows: [{ type: 'subagent/descriptor', seq: 2, data: 'not-a-payload' }], findings: [] })
  })

  it('never mutates the input rows', () => {
    const rows = deepFreeze([HEADER, descriptor(3, DESCRIPTOR_V2_CONTINUABLE), descriptor(4, DESCRIPTOR_V3_CONTINUABLE)])
    expect(() => subagentDescriptorVersionRule.detect(rows)).not.toThrow()
    const result = subagentDescriptorVersionRule.normalize(rows)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(rows[1].data).toEqual(DESCRIPTOR_V2_CONTINUABLE)
    expect(result.rows[1].data).toEqual({ ...DESCRIPTOR_V2_CONTINUABLE, version: 3 })
  })
})

describe('fallbacksSwitchRule', () => {
  it('detects the legacy event as an unknown historical event type', () => {
    expect(fallbacksSwitchRule.detect([HEADER, SWITCH_ROW])).toEqual([
      {
        ruleId: 'fallbacks-switch',
        class: 'unknown-event-type',
        detail: expect.stringContaining('fallbacks/switch 114513 is outside the released event inventory'),
      },
    ])
  })

  it('is never repairable — normalize refuses, even with ignorable: true', () => {
    expect(fallbacksSwitchRule.normalize([HEADER, SWITCH_ROW])).toEqual({
      refused: expect.stringContaining('refuses unknown historical events even when the row carries ignorable: true'),
    })
    const ignorable: ParsedRow = { ...SWITCH_ROW, seq: 12, data: { ...(SWITCH_ROW.data as object), ignorable: true } }
    const result = fallbacksSwitchRule.normalize([HEADER, ignorable])
    expect('refused' in result).toBe(true)
  })

  it('passes a log without switch rows through unchanged', () => {
    const rows = [HEADER, userMessage(1, { kind: 'user' })]
    expect(fallbacksSwitchRule.normalize(rows)).toEqual({ rows, findings: [] })
  })
})

describe('dropLegacyEventsRule (opt-in, lossy)', () => {
  /** A second legacy row, so a count of 1 cannot pass by accident. */
  const SWITCH_ROW_2: ParsedRow = { ...SWITCH_ROW, seq: 114514 }
  /** A row that merely MENTIONS the legacy type name in its payload. */
  const MENTIONS_SWITCH: ParsedRow = {
    type: 'user/message',
    seq: 12,
    time: 1786949105471,
    data: {
      role: 'user',
      id: 'message-12',
      content: [{ type: 'text', text: 'the legacy "fallbacks/switch" event was removed' }],
      source: { kind: 'user' },
    },
  }
  const KEPT: ParsedRow[] = [HEADER, userMessage(1, { kind: 'user' }), MENTIONS_SWITCH]

  it('detects every parsed legacy row, one finding per row, and nothing else', () => {
    const findings = dropLegacyEventsRule.detect([...KEPT, SWITCH_ROW, SWITCH_ROW_2])
    expect(findings).toHaveLength(2)
    expect(findings.map((finding) => finding.ruleId)).toEqual(['drop-legacy-events', 'drop-legacy-events'])
    expect(findings[0]).toMatchObject({ ruleId: 'drop-legacy-events', class: 'unknown-event-type' })
    expect(findings[0].detail).toContain('fallbacks/switch 114513 is dropped, not repaired')
    expect(dropLegacyEventsRule.detect(KEPT)).toEqual([])
  })

  it('drops exactly the parsed legacy rows, keeps every other row byte-identical and in order', () => {
    const rows = [HEADER, SWITCH_ROW, ...KEPT.slice(1), SWITCH_ROW_2]
    const result = dropLegacyEventsRule.normalize(rows)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)

    // Survivors are the same objects in the same order, byte-for-byte.
    expect(result.rows).toEqual([HEADER, ...KEPT.slice(1)])
    expect(result.rows.map((row) => JSON.stringify(row))).toEqual([HEADER, ...KEPT.slice(1)].map((row) => JSON.stringify(row)))
    // The count IS the finding count, and the delta IS the count.
    expect(droppedEventCount(result.findings)).toBe(2)
    expect(rows.length - result.rows.length).toBe(droppedEventCount(result.findings))
  })

  it('is a no-op with no findings on a log without legacy rows', () => {
    const result = dropLegacyEventsRule.normalize(KEPT)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result).toEqual({ rows: KEPT, findings: [] })
  })

  it('decides per PARSED row, never by substring: a payload mentioning the type survives', () => {
    const result = dropLegacyEventsRule.normalize([HEADER, MENTIONS_SWITCH])
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(result.findings).toEqual([])
    expect(result.rows).toEqual([HEADER, MENTIONS_SWITCH])
  })

  it('refuses the whole drop when a survivor would change or a foreign row would be removed', () => {
    // The rule's own construction path cannot produce either case, so the guard is
    // pinned directly: both are hard refusals (the caller then writes nothing).
    const tampered = JSON.stringify({ ...MENTIONS_SWITCH, seq: 13 })
    expect(
      legacyDropRefusal([HEADER, MENTIONS_SWITCH], [HEADER, JSON.parse(tampered) as ParsedRow]),
    ).toContain('neither kept byte-identically nor a removable fallbacks/switch row')
    expect(legacyDropRefusal([HEADER, MENTIONS_SWITCH], [HEADER])).toContain(
      'neither kept byte-identically nor a removable fallbacks/switch row',
    )
    // An extra survivor that exists in no input row is refused too.
    expect(legacyDropRefusal([HEADER], [HEADER, MENTIONS_SWITCH])).toContain(
      'only 1 match the input in order',
    )
    // The honest pair is proven.
    expect(legacyDropRefusal([HEADER, SWITCH_ROW], [HEADER])).toBeNull()
  })

  it('never mutates the input rows', () => {
    const rows = deepFreeze([HEADER, SWITCH_ROW, MENTIONS_SWITCH])
    expect(() => dropLegacyEventsRule.detect(rows)).not.toThrow()
    const result = dropLegacyEventsRule.normalize(rows)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused}`)
    expect(JSON.stringify(rows)).toBe(JSON.stringify([HEADER, SWITCH_ROW, MENTIONS_SWITCH]))
  })

  it('is NOT a member of the default registry (which stays strictly non-lossy)', () => {
    expect(BUILT_IN_RULES.map((rule) => rule.id)).not.toContain('drop-legacy-events')
    // The class it covers is still represented by the never-repairable detector.
    expect(BUILT_IN_RULES.filter((rule) => rule.class === 'unknown-event-type')).toEqual([fallbacksSwitchRule])
  })
})

describe('BUILT_IN_RULES', () => {
  it('exposes one rule per RCA refusal class, in check order', () => {
    expect(BUILT_IN_RULES.map((rule: LogRule) => [rule.id, rule.class])).toEqual([
      ['source-kind', 'source-kind'],
      ['subagent-descriptor-version', 'subagent-descriptor-version'],
      ['fallbacks-switch', 'unknown-event-type'],
    ])
  })

  it('never mutates the input rows of any rule', () => {
    const rows = deepFreeze([
      HEADER,
      userMessage(1, ENGINE_STATUS_SOURCE),
      descriptor(2, DESCRIPTOR_V2_ONE_SHOT),
      SWITCH_ROW,
    ])
    for (const rule of BUILT_IN_RULES) {
      expect(() => rule.detect(rows), rule.id).not.toThrow()
      expect(() => rule.normalize(rows), rule.id).not.toThrow()
    }
  })
})
