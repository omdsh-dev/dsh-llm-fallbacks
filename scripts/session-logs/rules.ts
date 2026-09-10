/**
 * rules.ts — the session-log refusal rule registry and its built-in rules.
 *
 * A session log reaches the GUI only through the FROZEN released migration
 * chain, so a pre-V3 log written by an older release (or by a plugin that
 * merged a custom `MessageSource.kind`) can be refused before it is read. Every
 * such refusal belongs to one class, and each class is one rule here.
 *
 * Rule shape: `detect` reports the refusals (read-only); `normalize` returns a
 * NEW row array with the class repaired, or `{ refused: reason }` when the
 * repaired shape is not provably admissible. The released catalog stays the
 * final oracle (a candidate generation is read back with
 * `validation: 'current'`); a rule never claims more than its own proof covers.
 *
 * Released formats this file encodes (SSOT paths are in the `deepseek-harness`
 * checkout at `dsh 0.1.5-rc.1`, the build the running harness uses):
 *   - `source-kind`:
 *     `packages/session/session-format-v2-to-v3/src/payload.ts` —
 *     `SOURCE_KINDS` (the first-party vocabulary) and `assertSource` (the
 *     message-source positions that check it). The sanctioned target shape is
 *     the `plugin` arm DSH itself uses
 *     (`packages/llm/llm/src/message.ts` `MessageSourceMap['plugin']`); the
 *     members that arm admits are enforced by
 *     `packages/session/session-format-v0-to-v1/src/payload-validation.ts`
 *     `pluginSourceValue`.
 *   - `subagent-descriptor-version`:
 *     `packages/session/session-format-v0-to-v1/src/validation.ts` — the V0→V1
 *     edge admits only descriptor `version: 3`. The admitted payload key set
 *     per `mode` is `packages/subagent/subagent/src/descriptor.ts`
 *     (`ONE_SHOT_DESCRIPTOR_KEYS` / `CONTINUABLE_DESCRIPTOR_KEYS`), and the
 *     value shape is `subagentDescriptorValue` in the payload-validation file
 *     above.
 *   - `unknown-event-type`: the same V0→V1 edge refuses an event type outside
 *     the released inventory even when the row carries `ignorable: true`, so
 *     the legacy `fallbacks/switch` rows are NEVER repairable by the default
 *     registry — the only in-repo recovery is the LOSSY `drop-legacy-events`
 *     rule below, which an explicit opt-in must add to a run.
 *   - `drop-legacy-events` (OPT-IN, lossy, deliberately NOT in `BUILT_IN_RULES`):
 *     removes exactly the `fallbacks/switch` rows and counts every removed one.
 *
 * Purity: no rule mutates its input. `detect` only reads; `normalize` always
 * returns a NEW row array, and copies a row (plus every container on the path of
 * a change) only when it actually changes that row — a pass-through row keeps its
 * identity.
 * Fail closed: a rule refuses whenever admissibility is unproven — it never
 * bumps a value because the change "looks" safe.
 */

export type RefusalClass =
  | 'ok'
  | 'source-kind'
  | 'subagent-descriptor-version'
  | 'unknown-event-type'
  | 'other-refusal'
  | 'decompress-failed'

/** One decoded JSONL row of a session log (the physical envelope only). */
export interface ParsedRow {
  type: string
  seq: number
  time?: number
  data?: unknown
}

/**
 * One refusal (`detect`) or one applied rewrite (`normalize`).
 * `detail` is human-facing evidence for the CLI report.
 */
export interface Finding {
  ruleId: string
  class: RefusalClass
  detail: string
}

/**
 * One refusal class as a rule.
 *
 * `detect` is ROW-LOCAL: it reports the refusals carried by the rows it is
 * given, in row order. `classifyRows` calls it once per row (a single-row
 * slice) so the class of a log's FIRST refused row is preserved; `normalize` is
 * called once with the whole log.
 *
 * `normalize` is all-or-nothing per rule: when any finding of that rule cannot
 * be repaired it returns `{ refused }` and the caller must discard the rows it
 * would otherwise have produced.
 */
export interface LogRule {
  id: string
  class: RefusalClass
  detect(rows: readonly ParsedRow[]): Finding[]
  normalize(rows: readonly ParsedRow[]): { rows: ParsedRow[]; findings: Finding[] } | { refused: string }
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                     */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Render a JSON value for a diagnostic message.
 *
 * Not total: `JSON.stringify` throws on a `BigInt` member, so the only values
 * this is called with are the streamed JSON payload members of a parsed row
 * (which can never carry one). A violation surfaces as a loud rule failure, not
 * as a silent misreport.
 */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

/* ------------------------------------------------------------------ */
/* source-kind                                                        */
/* ------------------------------------------------------------------ */

/**
 * The released first-party message-source vocabulary.
 *
 * SSOT: `packages/session/session-format-v2-to-v3/src/payload.ts` `SOURCE_KINDS`
 * (`deepseek-harness`, `dsh 0.1.5-rc.1`). A V2 message whose `source.kind` is
 * outside this set is refused with
 * `cannot safely transform unclassified message source`; the GUI surfaces that
 * as a failed session load.
 */
const RELEASED_SOURCE_KINDS: ReadonlySet<string> = new Set([
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
])

/**
 * Forms the released `plugin` arm admits (SSOT: `ContextFormed` in
 * `packages/llm/llm/src/message.ts`, enforced by `pluginSourceValue`).
 */
const RELEASED_PLUGIN_FORMS: ReadonlySet<string> = new Set([
  'instructions',
  'catalog',
  'snapshot',
  'notice',
  'relay',
  'recall',
])

/** `source` member path inside `row.data`, e.g. `['message', 'source']`. */
type SourcePath = readonly (string | number)[]

/**
 * Message-source positions of one row: exactly the rows the released V2→V3
 * edge classifies (`assertSource`, called from `assertEvent` in
 * `session-format-v2-to-v3/src/payload.ts`):
 *   - `user/message`                     → `data.source`
 *   - `assistant/message` / `tool/result` → `data.message.source`
 *   - `agent/inbox/spliced`              → every `data.inserted[i].source`
 *   - `session/title-llm-request`        → every `data.messages[i].source`
 *
 * A `kind` member anywhere else is NOT what refuses a log — content blocks
 * carry their own `type`/`kind` — so such members are deliberately left alone.
 */
function sourcePaths(row: ParsedRow): readonly SourcePath[] {
  if (!isRecord(row.data)) return []
  switch (row.type) {
    case 'user/message':
      return [['source']]
    case 'assistant/message':
    case 'tool/result':
      return [['message', 'source']]
    case 'agent/inbox/spliced':
      return memberSourcePaths(row.data, 'inserted')
    case 'session/title-llm-request':
      return memberSourcePaths(row.data, 'messages')
    default:
      return []
  }
}

function memberSourcePaths(data: Record<string, unknown>, member: string): SourcePath[] {
  const list = data[member]
  if (!Array.isArray(list)) return []
  return list.map((_member, index) => [member, index, 'source'])
}

function pathLabel(path: SourcePath): string {
  return path.map((step) => String(step)).join('.')
}

function readPath(root: unknown, path: SourcePath): unknown {
  let node = root
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(node)) return undefined
      node = node[step]
    } else {
      if (!isRecord(node)) return undefined
      node = node[step]
    }
  }
  return node
}

/**
 * Copy-as-you-go write at `path`: every container on the path is re-created, so
 * the input tree is never mutated. Only called for a path `readPath` resolved.
 */
function writePath(node: unknown, path: SourcePath, value: unknown): unknown {
  const [step, ...rest] = path
  if (typeof step === 'number') {
    const copy: unknown[] = Array.isArray(node) ? [...node] : []
    copy[step] = rest.length === 0 ? value : writePath(copy[step], rest, value)
    return copy
  }
  const copy: Record<string, unknown> = isRecord(node) ? { ...node } : {}
  copy[step] = rest.length === 0 ? value : writePath(copy[step], rest, value)
  return copy
}

/** A source is foreign when its `kind` is absent or outside the vocabulary. */
function isForeignKind(value: unknown): boolean {
  return !(typeof value === 'string' && RELEASED_SOURCE_KINDS.has(value))
}

/**
 * Rewrite one foreign source into the released `plugin` arm, or explain why its
 * shape cannot be carried over:
 *   - `plugin` records the original kind (stable identity, DSH's own
 *     precedent);
 *   - `form` / `summary` / `sections` survive when the released
 *     `pluginSourceValue` admits the combination (`summary` with the `notice`
 *     form, `sections` with `snapshot` as exact `{ name, text }` members);
 *   - every other member is dropped, because the released arm admits none.
 *
 * This is a CONSERVATIVE SUBSET of that released arm, deliberately stricter:
 * `pluginSourceValue` returns early when `form` is absent, so it would admit a
 * foreign `summary` / `sections` payload with no `form` at all — this rewrite
 * refuses those instead, because the missing `form` is what gave those members
 * their meaning, and a rewrite whose result is not provably the same message is
 * a rewrite this rule must not make.
 */
function toPluginSource(source: Record<string, unknown>): { source: Record<string, unknown> } | { refusal: string } {
  const kind = source['kind']
  if (!isNonEmptyString(kind)) {
    return { refusal: `source.kind ${describe(kind)} is not a non-empty string, so no stable plugin id can replace it` }
  }
  if (kind === 'compact') {
    // `compact` is a reserved plugin id whose arm additionally requires
    // compactionId / sourceCommandId — members this rewrite drops.
    return { refusal: 'source.kind "compact" is the reserved compact plugin id, whose arm requires dropped members' }
  }
  const form = source['form']
  if (form !== undefined && !(typeof form === 'string' && RELEASED_PLUGIN_FORMS.has(form))) {
    return { refusal: `source.form ${describe(form)} is outside the released plugin forms, so the form cannot be preserved` }
  }
  const summary = source['summary']
  if (summary !== undefined && (form !== 'notice' || typeof summary !== 'string')) {
    return { refusal: 'source.summary is admitted only by the notice form, as a string' }
  }
  const sections = source['sections']
  if (sections !== undefined && (form !== 'snapshot' || !isSnapshotSections(sections))) {
    return { refusal: 'source.sections are admitted only by the snapshot form, as { name, text } members' }
  }
  if (form === 'snapshot' && sections === undefined) return { refusal: 'the snapshot form requires source.sections' }
  if (form === 'notice' && summary === undefined) return { refusal: 'the notice form requires source.summary' }

  const next: Record<string, unknown> = { kind: 'plugin', plugin: kind }
  if (form !== undefined) next['form'] = form
  if (summary !== undefined) next['summary'] = summary
  if (sections !== undefined) next['sections'] = sections
  return { source: next }
}

/** `pluginSourceValue` admits snapshot sections as exactly `{ name, text }`. */
function isSnapshotSections(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every(
    (section) =>
      isRecord(section) &&
      Object.keys(section).length === 2 &&
      isNonEmptyString(section['name']) &&
      typeof section['text'] === 'string',
  )
}

function detectSourceKinds(rows: readonly ParsedRow[]): Finding[] {
  const findings: Finding[] = []
  for (const row of rows) {
    for (const path of sourcePaths(row)) {
      const source = readPath(row.data, path)
      if (!isRecord(source) || !isForeignKind(source['kind'])) continue
      findings.push({
        ruleId: 'source-kind',
        class: 'source-kind',
        detail: `${row.type} ${row.seq} ${pathLabel(path)} carries source.kind ${describe(source['kind'])}, outside the released first-party vocabulary`,
      })
    }
  }
  return findings
}

function normalizeSourceKinds(
  rows: readonly ParsedRow[],
): { rows: ParsedRow[]; findings: Finding[] } | { refused: string } {
  const out: ParsedRow[] = []
  const findings: Finding[] = []
  for (const row of rows) {
    let next = row
    for (const path of sourcePaths(row)) {
      const source = readPath(next.data, path)
      if (!isRecord(source) || !isForeignKind(source['kind'])) continue
      const rewritten = toPluginSource(source)
      if ('refusal' in rewritten) {
        return { refused: `${row.type} ${row.seq} ${pathLabel(path)}: ${rewritten.refusal}` }
      }
      next = { ...next, data: writePath(next.data, path, rewritten.source) }
      findings.push({
        ruleId: 'source-kind',
        class: 'source-kind',
        detail: `${row.type} ${row.seq} ${pathLabel(path)}: source.kind ${describe(source['kind'])} → { kind: "plugin", plugin: ${JSON.stringify(source['kind'])} }`,
      })
    }
    out.push(next)
  }
  return { rows: out, findings }
}

/* ------------------------------------------------------------------ */
/* subagent-descriptor-version                                        */
/* ------------------------------------------------------------------ */

const SUBAGENT_DESCRIPTOR_TYPE = 'subagent/descriptor'
const RELEASED_DESCRIPTOR_VERSION = 3

type DescriptorMode = 'one-shot' | 'continuable'

/**
 * Version-3 admitted descriptor payload keys per `mode`.
 *
 * SSOT: `packages/subagent/subagent/src/descriptor.ts` — `DESCRIPTOR_BASE_KEYS`
 * is `version, mode, provider, label`; `CONTINUABLE_DESCRIPTOR_KEYS` adds
 * `agentProvider, agentModel, agentReasoningEffort, persona, toolFilter`.
 *
 * The observed legacy payloads are subsets of these sets, which is what makes a
 * `2 → 3` bump shape-preserving:
 *   - `2|one-shot|{label, mode, provider, version}`
 *   - `2|continuable|{agentModel, agentProvider, label, mode, provider, version}`
 */
const DESCRIPTOR_V3_KEYS_BY_MODE: Readonly<Record<DescriptorMode, readonly string[]>> = {
  'one-shot': ['version', 'mode', 'provider', 'label'],
  continuable: [
    'version',
    'mode',
    'provider',
    'label',
    'agentProvider',
    'agentModel',
    'agentReasoningEffort',
    'persona',
    'toolFilter',
  ],
}

/**
 * Prove that a descriptor payload of an older `version` becomes admissible by
 * changing `version` to 3 and nothing else. Key-subset membership is the
 * primary proof; the value checks mirror the released
 * `subagentDescriptorValue` so a bump can never trade one refusal for another.
 * `null` means "provably admissible".
 */
function descriptorBumpRefusal(data: Record<string, unknown>): string | null {
  const mode = data['mode']
  if (mode !== 'one-shot' && mode !== 'continuable') {
    return `mode ${describe(mode)} is neither of the released descriptor modes`
  }
  const admitted = DESCRIPTOR_V3_KEYS_BY_MODE[mode]
  const unexpected = Object.keys(data).filter((key) => !admitted.includes(key))
  if (unexpected.length > 0) {
    return `payload key(s) ${unexpected.join(', ')} are outside the version-3 admitted set for mode ${mode} (${admitted.join(', ')})`
  }
  if (!isNonEmptyString(data['provider'])) return 'provider is not a non-empty string'
  if (mode === 'one-shot') {
    if (data['label'] !== undefined && typeof data['label'] !== 'string') return 'label is not a string'
    return null
  }
  if (!isNonEmptyString(data['label'])) return 'label is not a non-empty string'
  for (const key of ['agentProvider', 'agentModel', 'agentReasoningEffort', 'persona']) {
    if (data[key] !== undefined && !isNonEmptyString(data[key])) return `${key} is not a non-empty string`
  }
  if ((data['agentProvider'] === undefined) !== (data['agentModel'] === undefined)) {
    return 'agentProvider and agentModel must be paired'
  }
  return toolFilterRefusal(data['toolFilter'])
}

/** `subagentDescriptorValue` admits `toolFilter` as a non-empty allow/deny. */
function toolFilterRefusal(value: unknown): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) return 'toolFilter is not an object'
  if (Object.keys(value).some((key) => key !== 'allow' && key !== 'deny')) {
    return 'toolFilter admits only the allow/deny members'
  }
  if (value['allow'] === undefined && value['deny'] === undefined) {
    return 'toolFilter requires allow or deny'
  }
  for (const key of ['allow', 'deny']) {
    const list = value[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || !list.every(isNonEmptyString)) {
      return `toolFilter ${key} is not an array of non-empty strings`
    }
  }
  return null
}

function detectDescriptorVersions(rows: readonly ParsedRow[]): Finding[] {
  const findings: Finding[] = []
  for (const row of rows) {
    if (row.type !== SUBAGENT_DESCRIPTOR_TYPE) continue
    if (!isRecord(row.data) || row.data['version'] === RELEASED_DESCRIPTOR_VERSION) continue
    findings.push({
      ruleId: 'subagent-descriptor-version',
      class: 'subagent-descriptor-version',
      detail: `${SUBAGENT_DESCRIPTOR_TYPE} ${row.seq} uses unsupported descriptor version ${describe(row.data['version'])}`,
    })
  }
  return findings
}

function normalizeDescriptorVersions(
  rows: readonly ParsedRow[],
): { rows: ParsedRow[]; findings: Finding[] } | { refused: string } {
  const out: ParsedRow[] = []
  const findings: Finding[] = []
  for (const row of rows) {
    if (row.type !== SUBAGENT_DESCRIPTOR_TYPE) {
      out.push(row)
      continue
    }
    const data = row.data
    if (!isRecord(data) || data['version'] === RELEASED_DESCRIPTOR_VERSION) {
      out.push(row)
      continue
    }
    const version = data['version']
    if (version !== 1 && version !== 2) {
      return {
        refused: `${SUBAGENT_DESCRIPTOR_TYPE} ${row.seq}: version ${describe(version)} is not a released earlier version (1 or 2), so a bump to ${RELEASED_DESCRIPTOR_VERSION} is not provable`,
      }
    }
    const reason = descriptorBumpRefusal(data)
    if (reason !== null) {
      return { refused: `${SUBAGENT_DESCRIPTOR_TYPE} ${row.seq}: ${reason}` }
    }
    out.push({ ...row, data: { ...data, version: RELEASED_DESCRIPTOR_VERSION } })
    findings.push({
      ruleId: 'subagent-descriptor-version',
      class: 'subagent-descriptor-version',
      detail: `${SUBAGENT_DESCRIPTOR_TYPE} ${row.seq}: version ${describe(version)} → ${RELEASED_DESCRIPTOR_VERSION} (payload keys are a subset of the version-3 ${describe(data['mode'])} set)`,
    })
  }
  return { rows: out, findings }
}

/* ------------------------------------------------------------------ */
/* fallbacks-switch (legacy, never repairable by default)              */
/* ------------------------------------------------------------------ */

const FALLBACKS_SWITCH_TYPE = 'fallbacks/switch'

const FALLBACKS_SWITCH_REFUSAL =
  'fallbacks/switch is an unknown historical event type: the frozen V0→V1 edge refuses unknown historical events even when the row carries ignorable: true, so no rewrite can make such a log load'

function detectFallbacksSwitch(rows: readonly ParsedRow[]): Finding[] {
  return rows
    .filter((row) => row.type === FALLBACKS_SWITCH_TYPE)
    .map((row) => ({
      ruleId: 'fallbacks-switch',
      class: 'unknown-event-type' as const,
      detail: `${FALLBACKS_SWITCH_TYPE} ${row.seq} is outside the released event inventory; ${FALLBACKS_SWITCH_REFUSAL}`,
    }))
}

/* ------------------------------------------------------------------ */
/* drop-legacy-events (OPT-IN, lossy, never in the registry)          */
/* ------------------------------------------------------------------ */

const DROP_LEGACY_EVENTS_RULE_ID = 'drop-legacy-events'

const DROP_LEGACY_EVENTS_LOSS =
  'no rewrite can make a fallbacks/switch row load, so the row can only be removed — which loses the '
  + 'provider/model switch audit entry it carries'

/**
 * Whether one PARSED row is a removable legacy event.
 *
 * The decision is the parsed record's own `type` member compared for exact
 * equality — never a substring/pattern match on the serialized line, because the
 * string `fallbacks/switch` legitimately occurs inside user data and inside
 * message bodies. A row that did not parse never reaches a rule at all: the
 * reader refuses the whole log (`decompress-failed`) before any rule runs.
 */
function isRemovableLegacyEvent(row: ParsedRow): boolean {
  return row.type === FALLBACKS_SWITCH_TYPE
}

function detectDroppableLegacyEvents(rows: readonly ParsedRow[]): Finding[] {
  return rows
    .filter(isRemovableLegacyEvent)
    .map((row) => ({
      ruleId: DROP_LEGACY_EVENTS_RULE_ID,
      class: 'unknown-event-type' as const,
      detail: `${FALLBACKS_SWITCH_TYPE} ${row.seq} is dropped, not repaired: ${DROP_LEGACY_EVENTS_LOSS}`,
    }))
}

/**
 * The drop's own proof, run over the rule's own input/output pair rather than
 * assumed from the loop that produced it: walk the input rows in order, re-
 * serialize each one (`JSON.stringify`) and match it against the next survivor.
 * A survivor whose bytes differ from the row it came from, or a removed row that
 * is NOT a parsed `fallbacks/switch` row, refuses the whole drop — so the
 * survivor count is provably `input − dropped`.
 *
 * Exported because this is the rule's load-bearing safety property: the pinning
 * tests feed it a tampered survivor / a removed foreign row directly, which the
 * rule's own construction path can never produce.
 *
 * @returns the reason to refuse, or `null` when the drop is proven.
 */
export function legacyDropRefusal(
  input: readonly ParsedRow[],
  survivors: readonly ParsedRow[],
): string | null {
  let cursor = 0
  for (const [index, row] of input.entries()) {
    const survivor = survivors[cursor]
    if (survivor !== undefined && JSON.stringify(survivor) === JSON.stringify(row)) {
      cursor += 1
      continue
    }
    if (isRemovableLegacyEvent(row)) continue
    return `row ${index + 1} (${row.type}) is neither kept byte-identically nor a removable ${FALLBACKS_SWITCH_TYPE} row, so it must not be dropped`
  }
  if (cursor !== survivors.length) {
    return `the drop produced ${survivors.length} survivor(s) from ${input.length} row(s), but only ${cursor} match the input in order`
  }
  return null
}

/**
 * Remove every `fallbacks/switch` row and nothing else, in row order; one
 * finding per removed row, so `findings.length` IS the dropped-event count (see
 * {@link droppedEventCount}).
 *
 * All-or-nothing: when {@link legacyDropRefusal} cannot prove the survivors
 * byte-identical to their source rows the rule refuses, and the caller writes
 * nothing.
 */
function normalizeDroppedLegacyEvents(
  rows: readonly ParsedRow[],
): { rows: ParsedRow[]; findings: Finding[] } | { refused: string } {
  const survivors = rows.filter((row) => !isRemovableLegacyEvent(row))
  const refusal = legacyDropRefusal(rows, survivors)
  if (refusal !== null) return { refused: refusal }
  return { rows: survivors, findings: detectDroppableLegacyEvents(rows) }
}

/**
 * The rows the opt-in lossy rule removes from one log: its `normalize` reports
 * exactly one finding per dropped row, so counting them is exact.
 */
export function droppedEventCount(findings: readonly Finding[]): number {
  return findings.filter((finding) => finding.ruleId === DROP_LEGACY_EVENTS_RULE_ID).length
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

export const sourceKindRule: LogRule = {
  id: 'source-kind',
  class: 'source-kind',
  detect: detectSourceKinds,
  normalize: normalizeSourceKinds,
}

export const subagentDescriptorVersionRule: LogRule = {
  id: 'subagent-descriptor-version',
  class: 'subagent-descriptor-version',
  detect: detectDescriptorVersions,
  normalize: normalizeDescriptorVersions,
}

export const fallbacksSwitchRule: LogRule = {
  id: 'fallbacks-switch',
  class: 'unknown-event-type',
  detect: detectFallbacksSwitch,
  normalize(rows) {
    const findings = detectFallbacksSwitch(rows)
    if (findings.length > 0) return { refused: FALLBACKS_SWITCH_REFUSAL }
    return { rows: [...rows], findings: [] }
  },
}

/**
 * The OPT-IN lossy recovery for the legacy `fallbacks/switch` rows: `normalize`
 * removes exactly those rows and reports one finding per removed row.
 *
 * DELIBERATELY NOT a member of {@link BUILT_IN_RULES}: the default registry stays
 * strictly non-lossy, so this rule can only enter a run through the CLI's
 * explicit `--drop-legacy-events`. Scope is exact and self-proven — only a row
 * whose PARSED `type` is `fallbacks/switch` is removed, every survivor is
 * re-serialized and matched against its source row before the rule returns, and a
 * row of any other unknown event type is left in place (which leaves such a log
 * unrepairable rather than silently lossy). It therefore runs FIRST in a lossy
 * chain, so its input is the unmodified log. Replacing the detector it stands
 * beside (`fallbacks-switch`) is the caller's decision: both policies cover the
 * same rows, and the detector refuses what this rule removes.
 */
export const dropLegacyEventsRule: LogRule = {
  id: DROP_LEGACY_EVENTS_RULE_ID,
  class: 'unknown-event-type',
  detect: detectDroppableLegacyEvents,
  normalize: normalizeDroppedLegacyEvents,
}

/**
 * Built-in rules in check order: the first refused row decides the log's class,
 * and within one row the first rule here decides it.
 *
 * Strictly non-lossy by construction: every rule either proves a shape-preserving
 * rewrite or refuses, so an unrepairable log is never silently modified. The
 * lossy `dropLegacyEventsRule` is absent here on purpose.
 */
export const BUILT_IN_RULES: readonly LogRule[] = [
  sourceKindRule,
  subagentDescriptorVersionRule,
  fallbacksSwitchRule,
]
