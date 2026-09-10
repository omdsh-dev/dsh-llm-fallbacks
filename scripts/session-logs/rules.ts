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
 *     the legacy `fallbacks/switch` rows are NEVER repairable.
 *
 * Purity: no rule mutates its input. `detect` only reads; `normalize` copies
 * every row and every container on the path of a rewrite.
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

/** Render a JSON value for a diagnostic message (never throws). */
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
 *   - `form` / `summary` / `sections` survive because `pluginSourceValue`
 *     admits them — but only in the combination it admits (`summary` needs the
 *     `notice` form, `sections` need `snapshot` with exact `{ name, text }`
 *     members);
 *   - every other member is dropped, because the released arm admits none.
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
/* fallbacks-switch (legacy, never repairable)                        */
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
 * Built-in rules in check order: the first refused row decides the log's class,
 * and within one row the first rule here decides it.
 */
export const BUILT_IN_RULES: readonly LogRule[] = [
  sourceKindRule,
  subagentDescriptorVersionRule,
  fallbacksSwitchRule,
]
