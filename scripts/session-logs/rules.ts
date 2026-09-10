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
 *     removes exactly the `fallbacks/switch` rows, renumbers the survivors (the
 *     released V0→V1 codec requires `seq === eventCount` for every row, so a
 *     removed mid-sequence row leaves every later row with a stale `seq`), and
 *     refuses the whole file when that renumber would change what a surviving
 *     row's Session-seq reference points at.
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

/**
 * Every {@link RefusalClass} member, as a COMPILE-CHECKED record: a new class
 * added to the union without a member here fails to compile, so the vocabulary
 * cannot grow silently.
 */
export const REFUSAL_CLASS_MEMBERS: Readonly<Record<RefusalClass, true>> = {
  ok: true,
  'source-kind': true,
  'subagent-descriptor-version': true,
  'unknown-event-type': true,
  'other-refusal': true,
  'decompress-failed': true,
}

/**
 * The refusal vocabulary in REPORT order — the single source of truth for the
 * `--class` values, the report's per-class table and the usage text. Kept
 * member-for-member with {@link REFUSAL_CLASS_MEMBERS} by that record's type and
 * by an equality pin in the suite, so the next class fails loudly in both places
 * instead of yielding a `NaN` report row.
 */
export const REFUSAL_CLASSES: readonly RefusalClass[] = [
  'ok',
  'source-kind',
  'subagent-descriptor-version',
  'unknown-event-type',
  'other-refusal',
  'decompress-failed',
]

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
 *
 * `repairable` is the report's own predicate for "this rule can make a log of its
 * class load AT ALL": a detector that never rewrites anything answers `false`, and
 * a rule whose repair scope depends on the rows (the opt-in lossy rule repairs a
 * log only when it actually carries a removable row) answers per call. The CLI
 * derives its repairable-class set from this member rather than from a literal, so
 * adding a rule is enough to make its class repairable.
 */
export interface LogRule {
  id: string
  class: RefusalClass
  detect(rows: readonly ParsedRow[]): Finding[]
  normalize(rows: readonly ParsedRow[]): { rows: ParsedRow[]; findings: Finding[] } | { refused: string }
  repairable(rows: readonly ParsedRow[]): boolean
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
 *
 * Exported so the vocabulary itself is pinned by a test (exact set equality),
 * not just its use: one spurious EXTRA kind here would make this registry stop
 * detecting the RCA's dominant driver (`source-kind`) for that value, silently.
 */
export const RELEASED_SOURCE_KINDS: ReadonlySet<string> = new Set([
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
 * Whether one value is a member of the released message-source vocabulary
 * ({@link RELEASED_SOURCE_KINDS}).
 *
 * The one predicate the write-surface guard (`tests/session-write-surface.spec.ts`)
 * checks this repo's own `MessageSource.kind` literals against, so "released" has
 * exactly one definition in this repository.
 */
export function isReleasedSourceKind(value: unknown): value is string {
  return typeof value === 'string' && RELEASED_SOURCE_KINDS.has(value)
}

/**
 * Forms the released `plugin` arm admits (SSOT: `ContextFormed` in
 * `packages/llm/llm/src/message.ts`, enforced by `pluginSourceValue`).
 */
export const RELEASED_PLUGIN_FORMS: ReadonlySet<string> = new Set([
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
  return !isReleasedSourceKind(value)
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
export const DESCRIPTOR_V3_KEYS_BY_MODE: Readonly<Record<DescriptorMode, readonly string[]>> = {
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
 * Split one log into the drop's candidate rows and the survivors it keeps —
 * `rows` minus every parsed legacy row, in order, with the survivor rows
 * themselves untouched.
 *
 * This is the ONLY place the drop's row policy is written down: `normalize` and
 * any caller that wants to re-derive the renumber (the CLI's pre-write proof does)
 * both go through it, so neither can disagree about which rows are removable.
 *
 * @param rows parsed log rows (header first).
 * @returns the survivors (byte-identical source rows) and the dropped row count.
 */
export function legacyDropSplit(rows: readonly ParsedRow[]): { survivors: ParsedRow[]; dropped: number } {
  const survivors = rows.filter((row) => !isRemovableLegacyEvent(row))
  return { survivors, dropped: rows.length - survivors.length }
}

/**
 * Remove every `fallbacks/switch` row and nothing else, in row order; one
 * finding per removed row, so `findings.length` IS the dropped-event count (see
 * {@link droppedEventCount}).
 *
 * All-or-nothing: when {@link legacyDropRefusal} cannot prove the survivors
 * byte-identical to their source rows the rule refuses, and the caller writes
 * nothing. The drop itself is not enough to make such a log load — the released
 * V0→V1 codec requires `seq === eventCount` for every row — so the drop is
 * followed by {@link renumberSurvivingEvents}, which renumbers the survivors,
 * refuses to change what any surviving Session-seq reference points at, and
 * proves every written byte is one of its audited remap steps.
 */
function normalizeDroppedLegacyEvents(
  rows: readonly ParsedRow[],
): { rows: ParsedRow[]; findings: Finding[] } | { refused: string } {
  const { survivors } = legacyDropSplit(rows)
  const refusal = legacyDropRefusal(rows, survivors)
  if (refusal !== null) return { refused: refusal }
  const renumbered = renumberSurvivingEvents(rows, survivors)
  if ('refused' in renumbered) return { refused: renumbered.refused }
  return { rows: renumbered.rows, findings: detectDroppableLegacyEvents(rows) }
}

/**
 * The rows the opt-in lossy rule removes from one log: its `normalize` reports
 * exactly one finding per dropped row, so counting them is exact.
 */
export function droppedEventCount(findings: readonly Finding[]): number {
  return findings.filter((finding) => finding.ruleId === DROP_LEGACY_EVENTS_RULE_ID).length
}

/* ------------------------------------------------------------------ */
/* the Session-seq reference surface (the renumber's field list)      */
/* ------------------------------------------------------------------ */

/**
 * Row-relative JSON path of one audited seq member. The `SourcePath` alias is
 * the same structural type; naming it here keeps the intent readable.
 */
type SeqPath = SourcePath

/**
 * Packed Assistant runs of the released v0 physical layout.
 *
 * SSOT: `PACKED_TAGS` in `session-format-v0-to-v1/src/codec.ts`. A packed row
 * carries `seq0` (the FIRST event seq of the run) and no `seq` at all; the number
 * of events it occupies IS its payload length (`data.texts` for `text-chunks` /
 * `reasoning-chunks`, `data.args` for `tool-call-chunks`), and the codec advances
 * its running count by exactly that (`codec.ts` `eventCount += run.eventCount`).
 */
const PACKED_RUN_TYPES: ReadonlySet<string> = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/**
 * One audited Session-seq reference inside one row.
 *
 * `positions` is what the renumber REWRITES; `spans` is every old seq the
 * reference NAMES (a `[start, end]` range covers its whole interior, not just its
 * endpoints), which is what the integrity gate tests against the dropped seqs.
 */
interface SeqReference {
  /** Diagnostic label, e.g. `sourceEventSeqs.3` or `data.messageSeqs.0`. */
  label: string
  /** The writable members of this reference (a range has two). */
  positions: readonly { path: SeqPath; value: number }[]
  /** Inclusive old-seq spans this reference names. */
  spans: readonly { start: number; end: number }[]
}

/** The physical envelope member one row carries (`ParsedRow` is the logical view). */
function envelopeValue(row: ParsedRow, member: string): unknown {
  return (row as unknown as Record<string, unknown>)[member]
}

/** Whether one row is a packed Assistant run rather than one single-event row. */
function isPackedRun(row: ParsedRow): boolean {
  return PACKED_RUN_TYPES.has(row.type)
}

/** Events one row occupies, or `null` when a packed run's payload is malformed. */
function rowEventCount(row: ParsedRow): number | null {
  if (!isPackedRun(row)) return 1
  const data = row.data
  if (!isRecord(data)) return null
  const payload = data[row.type === 'tool-call-chunks' ? 'args' : 'texts']
  // The released codec requires a NON-EMPTY string array; anything else is a row
  // it refuses outright, so this rule models no extent for it.
  return Array.isArray(payload) && payload.length > 0 ? payload.length : null
}

/** The event position one row DECLARES (`seq`, or `seq0` for a packed run). */
function declaredEventSeq(row: ParsedRow): unknown {
  return isPackedRun(row) ? envelopeValue(row, 'seq0') : row.seq
}

/** The physical record of one row, mirroring `rowRecord` in `catalog.ts`. */
function rowPayload(row: ParsedRow): unknown {
  const data = row.data
  if (row.type === 'session' && isRecord(data) && typeof data['version'] === 'number' && typeof data['id'] === 'string') {
    return data
  }
  return row
}

/**
 * The header's seed cut: the number of leading events the released V0 header
 * declares as inherited (`seedLength`, `codec.ts` `decodePhysicalHeader`).
 * Events below it belong to the inherited lifecycle, so renumbering across it
 * would silently re-classify the first own event as inherited.
 */
function headerSeedCut(rows: readonly ParsedRow[]): number {
  const header = rows[0]
  if (header === undefined) return 0
  const payload = rowPayload(header)
  if (!isRecord(payload)) return 0
  const seedLength = payload['seedLength']
  return typeof seedLength === 'number' ? seedLength : 0
}

/**
 * Every Session-seq reference the released reader resolves inside one row.
 *
 * The field list is the union of the two released remappers and the validators
 * that reject what they miss:
 *   - `row.seq` / `row.seq0` — the row's own coordinate (see the renumber below);
 *   - `row.sourceEventSeqs` — absolute seqs, `[start, end]` ranges allowed
 *     (`codec.ts` `decodeSeqRanges`), each `< row.seq` and unique
 *     (`validation.ts` `assertReleasedSurfaceMetadata`), must cover the shadowed
 *     surface span (`relationships.ts` `applySurface`);
 *   - `row.surfaceOp.start` / `.end` (a `{ op: 'replace', … }` marker) — same
 *     family, `< row.seq` (`validation.ts`), must be on the current surface
 *     (`relationships.ts`) and index the message-id map by seq (`migration.ts`);
 *   - `data.sourceEventSeq` — `command/done`, an event index
 *     (`payload-validation.ts` `earlierSeq`, `relationships.ts`);
 *   - `data.shadowedRange.start` / `.end` and `data.shadowedSeqs` —
 *     `compaction/prune` / `compaction/summary` (`payload-validation.ts`
 *     `shadowedValue`, `relationships.ts` `assertCurrentSurfaceSpan`);
 *   - `data.messageSeqs` — `session/title` / `session/title-llm-request`
 *     (`payload-validation.ts` `seqArray`, `relationships.ts` `assertTitleSources`).
 *
 * Deliberately NOT references:
 *   - `data.throughSeq` (`session-log-deepseek/delivery-accepted`) — a cursor over
 *     THIS log's own delivered stream: `session-log-deepseek/src/index.ts:119-148`
 *     folds it as an accepted-sequence watermark and `:168` emits the last seq of
 *     this snapshot, and the shipped invariant is exactly "must identify an earlier
 *     event" (`session-log-deepseek/src/invariant.ts:34-44`). It is left opaque
 *     because the released remappers do not shift it
 *     (`session-format-v2-to-v3/src/references.ts:31-50` — the same switch that
 *     renumbers the seven members above — and its V1→V2 twin
 *     `session-format-v1-to-v2/src/migration.ts:566-661`), the released V2→V3
 *     migration only *inspects* the delivery marker (`migration.ts:64-67,88-91`),
 *     and an invalid value is refused by `earlierSeq`
 *     (`payload-validation.ts:179`) → the pre-write strict restore fails the whole
 *     file closed (reason `other`). Known residual, deliberately not code-guarded:
 *     a drop *preceding* a still-valid `throughSeq` leaves it naming a different,
 *     later event (0 occurrences in the measured corpus).
 *   - `data.seq` (`tool-workflow/*`) — a workflow-local counter;
 *   - `data.start` (`agent/inbox/spliced`) — an inbox position, only counted
 *     (`payload-validation.ts` `countValue`), never used as an event index.
 * A member that is present but not a safe integer is skipped: the released codec
 * refuses such a row outright, and this rule must not "repair" a reference it
 * cannot read. A Session seq is non-negative by contract, but these scalars are
 * admitted as any safe integer, so an already-invalid NEGATIVE member (`-1`) is
 * enumerated too and the remap's boundary check is one-sided for it (it passes
 * `after < newSeq`, is skipped because `after === value`, and is written nowhere
 * — see {@link renumberSurvivingEvents}). Not a regression: neither this
 * enumeration nor the remap can create one, and the CLI's strict pre-write
 * restore refuses such a row upstream.
 */
function seqReferences(row: ParsedRow): SeqReference[] {
  const references: SeqReference[] = []
  const addScalar = (path: SeqPath, value: unknown): void => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return
    references.push({ label: pathLabel(path), positions: [{ path, value }], spans: [{ start: value, end: value }] })
  }
  const sourceEventSeqs = envelopeValue(row, 'sourceEventSeqs')
  if (Array.isArray(sourceEventSeqs)) {
    sourceEventSeqs.forEach((entry, index) => {
      const path: SeqPath = ['sourceEventSeqs', index]
      const endpoints = Array.isArray(entry) && entry.length === 2 ? entry : null
      if (endpoints === null) {
        addScalar(path, entry)
        return
      }
      const [start, end] = endpoints as [unknown, unknown]
      if (typeof start !== 'number' || typeof end !== 'number'
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
        return
      }
      references.push({
        label: pathLabel(path),
        positions: [{ path: [...path, 0], value: start }, { path: [...path, 1], value: end }],
        spans: [{ start, end }],
      })
    })
  }
  const operation = envelopeValue(row, 'surfaceOp')
  if (isRecord(operation) && operation['op'] === 'replace') {
    addScalar(['surfaceOp', 'start'], operation['start'])
    addScalar(['surfaceOp', 'end'], operation['end'])
  }
  const data = row.data
  if (!isRecord(data)) return references
  switch (row.type) {
    case 'command/done':
      addScalar(['data', 'sourceEventSeq'], data['sourceEventSeq'])
      break
    case 'compaction/prune':
    case 'compaction/summary': {
      const range = data['shadowedRange']
      if (isRecord(range)) {
        addScalar(['data', 'shadowedRange', 'start'], range['start'])
        addScalar(['data', 'shadowedRange', 'end'], range['end'])
      }
      const shadowedSeqs = data['shadowedSeqs']
      if (Array.isArray(shadowedSeqs)) {
        shadowedSeqs.forEach((value, index) => addScalar(['data', 'shadowedSeqs', index], value))
      }
      break
    }
    case 'session/title':
    case 'session/title-llm-request': {
      const messageSeqs = data['messageSeqs']
      if (Array.isArray(messageSeqs)) {
        messageSeqs.forEach((value, index) => addScalar(['data', 'messageSeqs', index], value))
      }
      break
    }
    default:
      break
  }
  return references
}

/** One leaf difference between a source row and its renumbered survivor. */
interface RowDifference {
  path: SeqPath
  before: unknown
  after: unknown
}

/**
 * Every leaf difference between two JSON trees, in path order.
 *
 * This is the renumber's byte-identity proof: the renumber writes through
 * {@link writePath} copies, so anything it changed that it did not plan shows up
 * here as an unaudited difference, and any planned write that did not land shows
 * up as a missing one.
 */
function rowDifferences(before: unknown, after: unknown, path: SeqPath = []): RowDifference[] {
  if (before === after) return []
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ path, before: before.length, after: after.length }]
    return before.flatMap((member, index) => rowDifferences(member, after[index], [...path, index]))
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].flatMap((key) => rowDifferences(before[key], after[key], [...path, key]))
  }
  return [{ path, before, after }]
}

/** Key of one written/observed member, unique per path (paths may contain `.`). */
function writeKey(path: SeqPath): string {
  return path.map((step) => String(step)).join('\u0000')
}

/** One audited write the renumber performed. */
interface RenumberWrite {
  path: SeqPath
  before: number
  after: number
}

/** Whether one observed difference IS one audited write. */
function isWritten(write: RenumberWrite, difference: RowDifference): boolean {
  return writeKey(write.path) === writeKey(difference.path)
    && write.before === difference.before
    && write.after === difference.after
}

/** How many dropped events precede `seq` — the monotone shift of that seq. */
function droppedBefore(dropped: readonly number[], seq: number): number {
  let low = 0
  let high = dropped.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((dropped[middle] as number) < seq) low = middle + 1
    else high = middle
  }
  return low
}

/** Prefix of the refusal that means "a survivor names a dropped seq". */
const REFERENCE_INTEGRITY_REFUSAL_PREFIX = 'reference integrity: '

/** Prefix of the refusal that means "the renumber would cross the seed cut". */
const SEED_CUT_REFUSAL_PREFIX = 'the renumber crosses the header seed cut: '

/** Why the opt-in lossy recovery refused one log (see `lossyRefusalReason`). */
export type LossyRefusalReason = 'reference-integrity' | 'seed-cut' | 'other'

/**
 * The category of one lossy refusal, from the rule's own refusal text. The two
 * prefixes are built from the constants above, so this classifies what
 * {@link renumberSurvivingEvents} raises by construction — never by guessing.
 */
export function lossyRefusalReason(refusal: string): LossyRefusalReason {
  if (refusal.includes(REFERENCE_INTEGRITY_REFUSAL_PREFIX)) return 'reference-integrity'
  if (refusal.includes(SEED_CUT_REFUSAL_PREFIX)) return 'seed-cut'
  return 'other'
}

/**
 * Renumber the survivors of a proven drop so the released V0→V1 edge accepts
 * them again, or refuse the whole file.
 *
 * WHY: the codec requires `seq === eventCount` for every row, and a packed run's
 * `firstSeq` to equal the event count reached so far, so removing any row that is
 * not at the tail leaves every later row with a stale coordinate. Each surviving
 * event's coordinate becomes its 0-based position in the SURVIVING event stream
 * (a packed run keeps its extent and moves its `seq0`), and every audited
 * reference is shifted monotonically by the number of dropped events before it.
 *
 * The gate runs over the whole file first and is fail closed:
 *   - every source row (kept or dropped) must declare exactly the event position
 *     it occupies, or the survivors are not densely numbered and no remap is
 *     provable;
 *   - no surviving reference may name a dropped seq (or cover one inside a
 *     `[start, end]` range) — that reference would silently point at a different
 *     event after the renumber;
 *   - no dropped event may precede the header's seed cut, which would move the
 *     first own event into the inherited region.
 * Then every written member is proven to be exactly one audited remap step
 * (see {@link rowDifferences}), and every written reference is re-proven at the
 * remap boundary: it names no dropped seq, and its new coordinate is still an
 * EARLIER surviving event (`after < newSeq`).
 *
 * Exported because this is the load-bearing half of the opt-in lossy rule: the
 * CLI re-derives it over the drop rule's own output before any write.
 *
 * @param input the unmodified log rows (header first), exactly as parsed.
 * @param survivors the drop's output: `input` minus the removable legacy rows.
 * @returns the renumbered rows and how many surviving events moved, or the reason
 *   the file must not be written.
 */
export function renumberSurvivingEvents(
  input: readonly ParsedRow[],
  survivors: readonly ParsedRow[],
): { rows: ParsedRow[]; renumberedEventCount: number } | { refused: string } {
  const [header, ...events] = input
  const [survivorHeader, ...survivorEvents] = survivors
  if (header === undefined) return { refused: 'the log carries no header row' }
  if (survivorHeader === undefined || JSON.stringify(survivorHeader) !== JSON.stringify(header)) {
    return { refused: 'the renumber would change or remove the session header row' }
  }

  interface Kept {
    source: ParsedRow
    survivor: ParsedRow
    oldSeq: number
    newSeq: number
    events: number
  }
  const kept: Kept[] = []
  const dropped: number[] = []
  let position = 0
  let newPosition = 0
  let cursor = 0
  for (const [offset, row] of events.entries()) {
    const events_ = rowEventCount(row)
    if (events_ === null) {
      return {
        refused: `${row.type} ${describe(envelopeValue(row, 'seq0'))} is a packed Assistant run whose payload is not the string array the released codec requires`,
      }
    }
    const declared = declaredEventSeq(row)
    if (declared !== position) {
      return {
        refused: `row ${offset + 2} (${row.type}) declares seq ${describe(declared)} at event position ${position}, so the survivors are not densely numbered`,
      }
    }
    const survivor = survivorEvents[cursor]
    if (survivor !== undefined && JSON.stringify(survivor) === JSON.stringify(row)) {
      kept.push({ source: row, survivor, oldSeq: position, newSeq: newPosition, events: events_ })
      cursor += 1
      newPosition += events_
    } else if (isRemovableLegacyEvent(row)) {
      if (events_ !== 1) {
        return { refused: `the removable ${FALLBACKS_SWITCH_TYPE} row ${position} spans ${events_} events` }
      }
      dropped.push(position)
    } else {
      return {
        refused: `row ${offset + 2} (${row.type}) is neither kept byte-identically nor a removable ${FALLBACKS_SWITCH_TYPE} row, so the renumber cannot be proven`,
      }
    }
    position += events_
  }
  if (cursor !== survivorEvents.length) {
    return { refused: `only ${cursor} of the ${survivorEvents.length} survivor event(s) match the input rows in order` }
  }

  for (const { source, oldSeq } of kept) {
    for (const reference of seqReferences(source)) {
      for (const span of reference.spans) {
        // Binary search over the ASCENDING dropped positions: a span holds a
        // dropped seq exactly when the count below its end exceeds the count
        // below its start. Linear in the reference surface, not in the drop count.
        if (droppedBefore(dropped, span.end + 1) !== droppedBefore(dropped, span.start)) {
          const hit = dropped[droppedBefore(dropped, span.start)] as number
          return {
            refused: `${REFERENCE_INTEGRITY_REFUSAL_PREFIX}${source.type} ${oldSeq} ${reference.label} names the dropped ${FALLBACKS_SWITCH_TYPE} seq ${hit}`,
          }
        }
      }
    }
  }

  const seedCut = headerSeedCut(input)
  const belowCut = dropped.find((seq) => seq < seedCut)
  if (belowCut !== undefined) {
    return {
      refused: `${SEED_CUT_REFUSAL_PREFIX}the dropped ${FALLBACKS_SWITCH_TYPE} seq ${belowCut} precedes the header's seedLength ${seedCut}, `
        + 'so renumbering outside it would move the first own event into the inherited region',
    }
  }

  const droppedSeqs = new Set(dropped)
  const rows: ParsedRow[] = [header]
  let renumberedEventCount = 0
  for (const { source, survivor, oldSeq, newSeq, events: extent } of kept) {
    let next = survivor
    const written: RenumberWrite[] = []
    if (newSeq !== oldSeq) {
      const path: SeqPath = [isPackedRun(survivor) ? 'seq0' : 'seq']
      const before = declaredEventSeq(survivor)
      next = writePath(next, path, newSeq) as ParsedRow
      written.push({ path, before: before as number, after: newSeq })
      renumberedEventCount += extent
    }
    for (const reference of seqReferences(survivor)) {
      for (const { path, value } of reference.positions) {
        const after = value - droppedBefore(dropped, value)
        // The post-remap assertion, at the remap boundary and in the only
        // coordinate space where each half means something:
        //   - the OLD value must not be a dropped seq (`droppedSeqs`; the gate above
        //     already proves it for every span, this re-proves it per written member);
        //   - the NEW value must still name an EARLIER surviving event (`after < newSeq`).
        //     Both halves are one-sided for an already-invalid NEGATIVE member: `-1`
        //     is not a dropped seq and passes `after < newSeq`, then `after === value`
        //     skips it, so it is written nowhere (see `seqReferences`).
        // `after` is a NEW position, so testing it against the dropped OLD positions
        // would be a category error: a surviving event legitimately moves down onto a
        // dropped event's old index.
        if (droppedSeqs.has(value) || after >= newSeq) {
          return {
            refused: `${REFERENCE_INTEGRITY_REFUSAL_PREFIX}${survivor.type} ${oldSeq} ${pathLabel(path)} names ${value}, `
              + `which is not an earlier surviving event (remapped to ${after}, before ${newSeq} required)`,
          }
        }
        if (after === value) continue
        next = writePath(next, path, after) as ParsedRow
        written.push({ path, before: value, after })
      }
    }
    // Two-sided proof, keyed by path: a row can carry hundreds of thousands of
    // reference members, so neither side may scan the other linearly.
    const differences = rowDifferences(source, next)
    const writesByPath = new Map(written.map((write) => [writeKey(write.path), write]))
    const unaudited = differences.find((difference) => {
      const write = writesByPath.get(writeKey(difference.path))
      return write === undefined || !isWritten(write, difference)
    })
    if (unaudited !== undefined) {
      return {
        refused: `the renumber changed ${pathLabel(unaudited.path)} (${describe(unaudited.before)} → ${describe(unaudited.after)}) outside its audited remap fields`,
      }
    }
    const differencesByPath = new Map(differences.map((difference) => [writeKey(difference.path), difference]))
    const missing = written.find((write) => {
      const difference = differencesByPath.get(writeKey(write.path))
      return difference === undefined || !isWritten(write, difference)
    })
    if (missing !== undefined) {
      return { refused: `the renumber did not apply its own ${pathLabel(missing.path)} step` }
    }
    rows.push(next)
  }

  // Output-side invariant, independent of the input-side walk above: the rows this
  // function RETURNS must satisfy the released edge's own `seq === eventCount` rule
  // (packed runs included), so a shared bug in the input walk cannot produce a
  // successor that merely looks renumbered.
  let densePosition = 0
  for (const row of rows.slice(1)) {
    const extent = rowEventCount(row)
    const declared = declaredEventSeq(row)
    if (extent === null || declared !== densePosition) {
      return {
        refused: `the renumber produced ${row.type} at event position ${densePosition} declaring ${describe(declared)}; the released edge requires dense seqs`,
      }
    }
    densePosition += extent
  }
  return { rows, renumberedEventCount }
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

export const sourceKindRule: LogRule = {
  id: 'source-kind',
  class: 'source-kind',
  detect: detectSourceKinds,
  normalize: normalizeSourceKinds,
  // A foreign message source is always rewritable into the released plugin arm.
  repairable: () => true,
}

export const subagentDescriptorVersionRule: LogRule = {
  id: 'subagent-descriptor-version',
  class: 'subagent-descriptor-version',
  detect: detectDescriptorVersions,
  normalize: normalizeDescriptorVersions,
  // An earlier descriptor version is bumped only when its payload proves admissible,
  // but the class itself is repairable: it always rewrites or refuses, never drops.
  repairable: () => true,
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
  // A detector, never a repair: this rule exists so the class is REPORTED when the
  // lossy opt-in is absent.
  repairable: () => false,
}

/**
 * The OPT-IN lossy recovery for the legacy `fallbacks/switch` rows: `normalize`
 * removes exactly those rows, renumbers the survivors so the released V0→V1 edge
 * accepts them again, and reports one finding per removed row (so
 * {@link droppedEventCount} stays the drop count; the renumbered-event count is
 * {@link renumberSurvivingEvents}'s, not a finding).
 *
 * DELIBERATELY NOT a member of {@link BUILT_IN_RULES}: the default registry stays
 * strictly non-lossy, so this rule can only enter a run through the CLI's
 * explicit `--drop-legacy-events`. Scope is exact and self-proven — only a row
 * whose PARSED `type` is `fallbacks/switch` is removed, every survivor is
 * re-serialized and matched against its source row before the rule returns, a
 * row of any other unknown event type is left in place (which leaves such a log
 * unrepairable rather than silently lossy), and the renumber refuses the file
 * outright when a surviving reference names a dropped seq. It therefore runs
 * FIRST in a lossy chain, so its input is the unmodified log. Replacing the
 * detector it stands beside (`fallbacks-switch`) is the caller's decision: both
 * policies cover the same rows, and the detector refuses what this rule removes.
 */
export const dropLegacyEventsRule: LogRule = {
  id: DROP_LEGACY_EVENTS_RULE_ID,
  class: 'unknown-event-type',
  detect: detectDroppableLegacyEvents,
  normalize: normalizeDroppedLegacyEvents,
  // Repairable only for a log that actually carries a row this rule may remove: a
  // differently-unknown event type stays unrepairable even under the opt-in, which
  // is what the CLI's class gate used to special-case.
  repairable: (rows) => rows.some(isRemovableLegacyEvent),
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
