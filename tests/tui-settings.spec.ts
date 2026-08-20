/**
 * TUI settings-section tests (plan fallbacks-tui-settings Task 1, AC-1 +
 * AC-2): the `tuiSettingsSections` `fallbacks` section — registration
 * shape, field inventory (all 13 fields covering the 15 web-card
 * capabilities), native kinds, JSON/triggerCodes format↔parse round-trips,
 * gateway-parity rejection, absent-service no-op, and the `serviceOwned`
 * first-fiber gate.
 *
 * The stub registry mirrors dsh-TUI's `TuiSettingsSectionsRuntime`
 * (read-only reference @ main 2747b87, `src/dsh-adapter/settings-sections.ts`):
 * ns normalization + regex, duplicate-ns throw, group-id regex + duplicate
 * group-id throw, and the field→group reference check — so the section
 * contract is pinned against the same rules the real host enforces. No
 * dsh-tui peer is involved (plan constraint: zero new peer/dependency;
 * shapes replicated structurally in `src/tui-settings.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import {
  FALLBACKS_TUI_SECTION_NS,
  buildFallbacksTuiSection,
  installTuiSettingsSection,
  type TuiSettingsField,
  type TuiSettingsFieldWrite,
  type TuiSettingsSection,
} from '../src/tui-settings.ts'
import { cfg } from './support/harness.ts'
import { MemorySettings } from './support/memory-settings.ts'

/**
 * Faithful test double of dsh-TUI's `TuiSettingsSectionsRuntime`: records
 * sections and mirrors the host's ns normalization + regex, duplicate-ns
 * throw, group-id regex + duplicate group-id throw, and the field→group
 * reference check (`settings-sections.ts` registerSection). `register`
 * returns a disposer that removes only its own registration.
 */
class TuiSettingsSectionsStub {
  readonly sections = new Map<string, TuiSettingsSection>()
  /** Registration order of namespaces (normalized, as the host stores them). */
  readonly nss: string[] = []
  /** The disposer returned by the most recent `register` call. */
  lastDisposer: (() => void) | undefined

  register(section: TuiSettingsSection): () => void {
    const ns = section.ns.trim()
    if (!/^[a-z][a-z0-9_-]*$/u.test(ns)) throw new TypeError(`invalid TUI settings-section namespace: ${section.ns}`)
    if (this.sections.has(ns)) throw new Error(`TUI settings section "${ns}" is already registered`)
    const groupIds = new Set<string>()
    for (const group of section.groups ?? []) {
      const id = group.id.trim()
      if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI settings group id: ${group.id}`)
      if (groupIds.has(id)) throw new Error(`TUI settings group "${id}" is already declared in section "${ns}"`)
      groupIds.add(id)
    }
    for (const field of section.fields) {
      const group = field.group?.trim()
      if (group !== undefined && !groupIds.has(group)) {
        throw new TypeError(
          `TUI settings field "${field.path.join('.')}" references unknown group "${field.group}" in section "${ns}"`,
        )
      }
    }
    const normalized = { ...section, ns }
    this.sections.set(ns, normalized)
    this.nss.push(ns)
    this.lastDisposer = () => {
      if (this.sections.get(ns) === normalized) this.sections.delete(ns)
    }
    return this.lastDisposer
  }

  list(): readonly TuiSettingsSection[] {
    return [...this.sections.values()]
  }
}

/**
 * A stub Context whose `inject` mirrors cordis' child-activation contract:
 * with a service present the child activates immediately (receiving the
 * service bag), and its returned disposer is captured; with no service the
 * child never activates. The stub ctx is cast to `Context` — the real
 * `Context` surface is not needed, `installTuiSettingsSection` only touches
 * `inject`.
 */
function makeStubContext(service: TuiSettingsSectionsStub | undefined): {
  ctx: Context
  disposer: (() => void) | undefined
} {
  let disposer: (() => void) | undefined
  const ctx = {
    inject(names: readonly string[], callback: (tctx: unknown) => unknown) {
      if (service === undefined) return
      const returned = callback({ tuiSettingsSections: service })
      if (typeof returned === 'function') disposer = returned as () => void
    },
  } as unknown as Context
  return {
    ctx,
    // Read live: `inject` activates synchronously inside
    // `installTuiSettingsSection`, after this object is constructed.
    get disposer() {
      return disposer
    },
  }
}

/** All 13 field key paths the section must declare (web-card capability map). */
const EXPECTED_FIELD_PATHS = [
  'enabled',
  'roleAutoMatch',
  'presets',
  'triggerCodes',
  'tz',
  'rootChain',
  'timeSlots',
  'roles.list',
  'roles.rules',
  'cooldownMs',
  'maxSwitchesPerStep',
  'alwaysModeRetryCap',
  'revertPolicy',
]

/** Top-level `Config` schema keys (schema.ts) — every field path must resolve. */
const SCHEMA_KEYS: Record<string, true> = {
  enabled: true, triggerCodes: true, rootChain: true, roles: true, cooldownMs: true,
  revertPolicy: true, maxSwitchesPerStep: true, alwaysModeRetryCap: true, presets: true,
  roleAutoMatch: true, timeSlots: true, tz: true,
}
/** Declared nested keys of the `roles` object (gateway ROLES_KEYS). */
const ROLES_NESTED_KEYS: Record<string, true> = {
  list: true,
  rules: true,
}

/** Field lookup by joined path inside a built section. */
function fieldOf(section: TuiSettingsSection, key: string): TuiSettingsField {
  const field = section.fields.find((candidate) => candidate.path.join('.') === key)
  expect(field, `section must declare field "${key}"`).toBeDefined()
  return field!
}

/** JSON-field sample values that pass `validateConfigPatch` (gateway parity). */
const SAMPLES: Record<string, unknown> = {
  rootChain: ['deepseek/deepseek-chat', 'deepseek-official/deepseek-v4-flash'],
  timeSlots: [
    { kind: 'preset', preset: 'liang-peak', chain: ['deepseek/deepseek-chat'] },
    { kind: 'custom', start: '09:00', end: '12:00', days: [1, 2, 3], chain: ['deepseek/deepseek-chat'] },
  ],
  'roles.list': [
    {
      id: 'coder',
      persona: 'Coder persona',
      prompt: 'You are a coder',
      permissions: { allow: [], deny: [] },
      chain: ['deepseek/deepseek-chat'],
      fallback: 'inherit-root',
    },
  ],
  'roles.rules': [
    { origin: 'root', provider: 'deepseek', model: 'deepseek-chat', role: 'coder' },
  ],
}

const JSON_FIELD_KEYS = ['rootChain', 'timeSlots', 'roles.list', 'roles.rules']

describe('installTuiSettingsSection — registration shape (AC-1)', () => {
  it('registers exactly one fallbacks section with ns, title, and zh/en descriptions when serviceOwned', () => {
    const registry = new TuiSettingsSectionsStub()
    const { ctx } = makeStubContext(registry)

    installTuiSettingsSection(ctx, { serviceOwned: true })

    expect(registry.nss).toEqual([FALLBACKS_TUI_SECTION_NS])
    expect(registry.sections.size).toBe(1)
    const section = registry.sections.get(FALLBACKS_TUI_SECTION_NS)
    expect(section?.ns).toBe(FALLBACKS_TUI_SECTION_NS)
    expect(section?.title).toBe('fallbacks')
    expect(section?.descriptions?.zh?.length).toBeGreaterThan(0)
    expect(section?.descriptions?.en?.length).toBeGreaterThan(0)
  })

  it('returns the registry disposer from the inject child (withdrawal on unload)', () => {
    const registry = new TuiSettingsSectionsStub()
    const stub = makeStubContext(registry)

    installTuiSettingsSection(stub.ctx, { serviceOwned: true })

    const disposer = stub.disposer
    expect(typeof disposer).toBe('function')
    expect(disposer).toBe(registry.lastDisposer)
    disposer()
    expect(registry.sections.size).toBe(0)
  })

  it('skips registration entirely when the fiber does not own the service', () => {
    const registry = new TuiSettingsSectionsStub()
    const { ctx } = makeStubContext(registry)

    installTuiSettingsSection(ctx, { serviceOwned: false })

    expect(registry.nss).toHaveLength(0)
    expect(registry.sections.size).toBe(0)
  })

  it('no-ops without error when no tuiSettingsSections service is composed', () => {
    const registry = new TuiSettingsSectionsStub()
    const { ctx } = makeStubContext(undefined)

    expect(() => installTuiSettingsSection(ctx, { serviceOwned: true })).not.toThrow()
    expect(registry.nss).toHaveLength(0)
    expect(registry.sections.size).toBe(0)
  })
})

describe('fallbacks section — field inventory and schema resolution (AC-1)', () => {
  const section = buildFallbacksTuiSection()

  it('declares every web-card capability key, in the planned order', () => {
    expect(section.fields.map((field) => field.path.join('.'))).toEqual(EXPECTED_FIELD_PATHS)
  })

  it('group ids are regex-valid, unique, and every field references a declared group', () => {
    const groupIds = (section.groups ?? []).map((group) => group.id)
    expect(groupIds.length).toBeGreaterThan(0)
    expect(new Set(groupIds).size).toBe(groupIds.length)
    for (const id of groupIds) {
      expect(id).toMatch(/^[a-z][a-z0-9_-]*$/)
    }
    for (const field of section.fields) {
      if (field.group !== undefined) expect(groupIds).toContain(field.group)
    }
  })

  it('every field path resolves against the Config schema keys', () => {
    for (const field of section.fields) {
      const [top, nested] = field.path
      expect(SCHEMA_KEYS[top] === true, `field path ${field.path.join('.')} starts with schema key "${top}"`).toBe(true)
      if (top === 'roles') {
        expect(field.path.length).toBe(2)
        expect(ROLES_NESTED_KEYS[nested!] === true, `roles nested key "${nested}" is declared`).toBe(true)
      } else {
        expect(field.path.length).toBe(1)
      }
    }
  })

  it('registers cleanly through the host-validation stub (ns/group/field-reference rules)', () => {
    const registry = new TuiSettingsSectionsStub()
    expect(() => registry.register(section)).not.toThrow()
    expect(registry.nss).toEqual(['fallbacks'])
  })
})

describe('fallbacks section — native kinds (AC-1)', () => {
  const section = buildFallbacksTuiSection()

  it('enabled and roleAutoMatch are boolean fields', () => {
    expect(fieldOf(section, 'enabled').kind).toBe('boolean')
    expect(fieldOf(section, 'roleAutoMatch').kind).toBe('boolean')
  })

  it('cooldownMs / maxSwitchesPerStep / alwaysModeRetryCap are number fields', () => {
    expect(fieldOf(section, 'cooldownMs').kind).toBe('number')
    expect(fieldOf(section, 'maxSwitchesPerStep').kind).toBe('number')
    expect(fieldOf(section, 'alwaysModeRetryCap').kind).toBe('number')
  })

  it('presets and revertPolicy are select fields with the right options', () => {
    const presets = fieldOf(section, 'presets')
    expect(presets.kind).toBe('select')
    expect(presets.options?.map((option) => option.value)).toEqual(['bundled', 'none'])

    const revertPolicy = fieldOf(section, 'revertPolicy')
    expect(revertPolicy.kind).toBe('select')
    expect(revertPolicy.options?.map((option) => option.value)).toEqual(['cooldown-expiry', 'never'])
  })
})

describe('JSON fields — format/parse round-trips and gateway-parity rejection (AC-2)', () => {
  const section = buildFallbacksTuiSection()

  it.each(JSON_FIELD_KEYS)('%s: format(sample) → parse → original value', (key) => {
    const field = fieldOf(section, key)
    expect(typeof field.format).toBe('function')
    expect(typeof field.parse).toBe('function')
    const sample = SAMPLES[key]!
    const text = field.format!(sample)
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
    expect(field.parse!(text)).toEqual({ kind: 'set', value: sample })
  })

  it.each(JSON_FIELD_KEYS)('%s: format guards undefined/null → empty string', (key) => {
    const field = fieldOf(section, key)
    expect(field.format!(undefined)).toBe('')
    expect(field.format!(null)).toBe('')
  })

  it.each(JSON_FIELD_KEYS)('%s: blank/whitespace draft stages a clear, not a blocked save', (key) => {
    const field = fieldOf(section, key)
    expect(field.parse!('')).toEqual({ kind: 'clear' })
    expect(field.parse!('   \n\t ')).toEqual({ kind: 'clear' })
  })

  it.each(JSON_FIELD_KEYS)('%s: invalid JSON → undefined (save blocked)', (key) => {
    const field = fieldOf(section, key)
    expect(field.parse!('{ not json')).toBeUndefined()
    expect(field.parse!('[1, 2')).toBeUndefined()
  })

  it('rootChain: wrong shape (non-conforming tail) → undefined', () => {
    const field = fieldOf(section, 'rootChain')
    // Missing the official-V4 tail the gateway requires on save.
    expect(field.parse!('["deepseek/deepseek-chat"]')).toBeUndefined()
    expect(field.parse!('{"a":1}')).toBeUndefined()
    expect(field.parse!('["deepseek/deepseek-chat", 42]')).toBeUndefined()
  })

  it('timeSlots: rows rejected per validateTimeSlotsPatch rules → undefined', () => {
    const field = fieldOf(section, 'timeSlots')
    // Bad kind.
    expect(field.parse!('[{"kind":"bogus","chain":["deepseek/deepseek-chat"]}]')).toBeUndefined()
    // Unknown preset id.
    expect(field.parse!('[{"kind":"preset","preset":"nope","chain":["deepseek/deepseek-chat"]}]')).toBeUndefined()
    // Preset row carrying its own window.
    expect(field.parse!('[{"kind":"preset","preset":"liang-peak","start":"09:00","chain":["deepseek/deepseek-chat"]}]')).toBeUndefined()
    // Custom row without strict HH:mm bounds.
    expect(field.parse!('[{"kind":"custom","start":"9am","end":"12:00","chain":["deepseek/deepseek-chat"]}]')).toBeUndefined()
    // Empty chain.
    expect(field.parse!('[{"kind":"custom","start":"09:00","end":"12:00","chain":[]}]')).toBeUndefined()
    // Non-array.
    expect(field.parse!('{"kind":"preset"}')).toBeUndefined()
  })

  it('roles.list: rows per Config schema → undefined when the schema rejects', () => {
    const field = fieldOf(section, 'roles.list')
    // Non-object rows / missing required id / non-string id.
    expect(field.parse!('42')).toBeUndefined()
    expect(field.parse!('[{"persona":"no id"}]')).toBeUndefined()
    expect(field.parse!('[{"id":42}]')).toBeUndefined()
  })

  it('roles.rules: provider/model/role strings per Config schema → undefined on violation', () => {
    const field = fieldOf(section, 'roles.rules')
    expect(field.parse!('[{"role":42}]')).toBeUndefined()
    expect(field.parse!('[{"origin":"bogus","role":"coder"}]')).toBeUndefined()
    expect(field.parse!('"coder"')).toBeUndefined()
  })
})

describe('triggerCodes — comma-joined format/parse (AC-2)', () => {
  const section = buildFallbacksTuiSection()
  const field = fieldOf(section, 'triggerCodes')

  it('format joins with ", "', () => {
    expect(field.format!(['AUTH', 'QUOTA'])).toBe('AUTH, QUOTA')
    expect(field.format!([])).toBe('')
    expect(field.format!(undefined)).toBe('')
  })

  it('parse splits on commas, trims, and drops empties', () => {
    expect(field.parse!('AUTH, QUOTA')).toEqual({ kind: 'set', value: ['AUTH', 'QUOTA'] })
    expect(field.parse!('AUTH,  , QUOTA ,')).toEqual({ kind: 'set', value: ['AUTH', 'QUOTA'] })
  })

  it('blank/whitespace drafts stage a clear', () => {
    expect(field.parse!('')).toEqual({ kind: 'clear' })
    expect(field.parse!('  ')).toEqual({ kind: 'clear' })
  })
})

describe('apply() wiring — conditional tuiSettingsSections child', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(MemorySettings)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers the fallbacks section once a tuiSettingsSections service is composed', async () => {
    const registry = new TuiSettingsSectionsStub()
    ctx.provide('tuiSettingsSections', registry as never)
    apply(ctx, cfg())
    await vi.waitFor(() => expect(registry.sections.size).toBe(1))
    expect(registry.nss).toEqual(['fallbacks'])
    expect(registry.sections.get('fallbacks')?.ns).toBe('fallbacks')
  })

  it('stays a silent no-op when no tuiSettingsSections service exists', async () => {
    const registry = new TuiSettingsSectionsStub()
    expect(() => apply(ctx, cfg())).not.toThrow()
    expect(registry.sections.size).toBe(0)
    // A registry composed later activates the child exactly once — never
    // eagerly at apply time, never twice.
    ctx.provide('tuiSettingsSections', registry as never)
    await vi.waitFor(() => expect(registry.sections.size).toBe(1))
    expect(registry.nss).toEqual(['fallbacks'])
  })

  it('serviceOwned: false — a deduped fiber registers no section through the apply path', async () => {
    const registry = new TuiSettingsSectionsStub()
    // The `llm-fallbacks` service is already owned on the shared context
    // root: apply()'s provide hits cordis' duplicate-key failure, the catch
    // sets serviceOwned = false, and installTuiSettingsSection must NOT
    // register — a second registration would be the host duplicate-ns throw.
    ctx.provide('llm-fallbacks', { name: 'llm-fallbacks' } as never)
    ctx.provide('tuiSettingsSections', registry as never)

    expect(() => apply(ctx, cfg())).not.toThrow()
    await vi.waitFor(() => expect(registry.sections.size).toBe(0))
    expect(registry.nss).toHaveLength(0)
  })

  it('registers the tuiSettingsSections child AFTER installTuiClient and BEFORE the tail settings preset child', () => {
    // The tail ctx.inject(['settings']) preset child must stay the LAST
    // registered child; installTuiClient + installTuiSettingsSection both
    // precede it. Pin the registration order via a recording wrapper.
    const injectKeys: string[] = []
    const recorder = new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'inject') {
          return (deps: readonly string[], callback: unknown) => {
            injectKeys.push(deps.join(','))
            return Reflect.get(target, prop).call(target, deps, callback)
          }
        }
        return Reflect.get(target, prop)
      },
    })

    apply(recorder, cfg())

    const tuiClientIndex = injectKeys.indexOf('tuiCommandTrees')
    const tuiSettingsIndex = injectKeys.indexOf('tuiSettingsSections')
    const lastSettings = injectKeys.lastIndexOf('settings')
    expect(tuiClientIndex).toBeGreaterThanOrEqual(0)
    expect(tuiSettingsIndex).toBeGreaterThan(tuiClientIndex)
    expect(lastSettings).toBe(injectKeys.length - 1)
    expect(tuiSettingsIndex).toBeLessThan(lastSettings)
  })
})
