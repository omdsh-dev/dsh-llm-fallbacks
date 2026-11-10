/**
 * Selector parsing unit tests (Task 2).
 *
 * Covers the `provider/model` and `provider/*` grammar, the wildcard-entry
 * resolution helper, and the catchable-error path for illegal selectors
 * (the "config warning" path — warn-and-continue lives in Task 3).
 */

import { describe, expect, it } from 'vitest'
import {
  parseSelector,
  resolveWildcardEntry,
  SelectorError,
  selectorKey,
} from '../src/selectors.ts'

describe('parseSelector', () => {
  it('parses a concrete provider/model selector', () => {
    expect(parseSelector('openai/gpt-4o')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      raw: 'openai/gpt-4o',
    })
  })

  it('parses a wildcard provider/* selector (model undefined)', () => {
    expect(parseSelector('anthropic/*')).toEqual({
      provider: 'anthropic',
      model: undefined,
      raw: 'anthropic/*',
    })
  })

  it('parses a multi-slash model id (e.g. NVIDIA NIM, issue #74)', () => {
    expect(parseSelector('nvidia/minimaxai/minimax-m3')).toEqual({
      provider: 'nvidia',
      model: 'minimaxai/minimax-m3',
      raw: 'nvidia/minimaxai/minimax-m3',
    })
  })

  it('trims surrounding whitespace but keeps the canonical raw string', () => {
    expect(parseSelector('  openai/gpt-4o  ')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      raw: 'openai/gpt-4o',
    })
  })

  it('trims whitespace inside each segment (T2 review Minor #1)', () => {
    expect(parseSelector('openai/ gpt-4o')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      raw: 'openai/ gpt-4o',
    })
    expect(parseSelector(' openai /gpt-4o ')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      raw: 'openai /gpt-4o',
    })
    expect(parseSelector('openai/ *')).toEqual({
      provider: 'openai',
      model: undefined,
      raw: 'openai/ *',
    })
  })

  it('throws SelectorError on selectors without a provider/model separator', () => {
    for (const bad of ['', 'openai', '*', ' ', '  ']) {
      expect(() => parseSelector(bad), `selector ${JSON.stringify(bad)}`).toThrow(SelectorError)
    }
  })

  it('throws SelectorError on empty provider or empty model', () => {
    for (const bad of ['/model', 'provider/', '/*']) {
      expect(() => parseSelector(bad), `selector ${JSON.stringify(bad)}`).toThrow(SelectorError)
    }
  })

  it('throws SelectorError when the model segment contains a wildcard', () => {
    // `provider/*` is the only legal wildcard form; `*` inside a model id
    // (e.g. after a slash, or embedded) would blur the wildcard grammar.
    for (const bad of ['provider/*/x', 'openai/gpt*', 'openai/*x']) {
      expect(() => parseSelector(bad), `selector ${JSON.stringify(bad)}`).toThrow(SelectorError)
    }
  })

  it('exposes a catchable error type for the config-warning path', () => {
    try {
      parseSelector('nope')
      expect.unreachable('parseSelector should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SelectorError)
      expect((error as SelectorError).name).toBe('SelectorError')
      expect((error as SelectorError).message).toContain('nope')
    }
  })
})

describe('selectorKey', () => {
  it('builds the canonical concrete key', () => {
    expect(selectorKey('openai', 'gpt-4o')).toBe('openai/gpt-4o')
  })

  it('builds the wildcard key when the model is missing', () => {
    expect(selectorKey('openai')).toBe('openai/*')
  })

  it('builds the canonical key for a multi-slash model id', () => {
    expect(selectorKey('nvidia', 'minimaxai/minimax-m3')).toBe('nvidia/minimaxai/minimax-m3')
  })
})

describe('pinned reasoning effort (@effort suffix)', () => {
  it('splits a trailing effort off the model segment', () => {
    expect(parseSelector('openai/gpt-4o@high')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      effort: 'high',
      raw: 'openai/gpt-4o@high',
    })
  })

  it('omits the effort key when the entry carries none', () => {
    // Absent, not `undefined`: an effort-free entry must round-trip to the
    // exact wire string today's configs already carry.
    expect('effort' in parseSelector('openai/gpt-4o')).toBe(false)
  })

  it('carries the effort on a wildcard entry', () => {
    expect(parseSelector('openai/*@low')).toEqual({
      provider: 'openai',
      model: undefined,
      effort: 'low',
      raw: 'openai/*@low',
    })
  })

  it('splits on the last @ after the first / (multi-slash model id)', () => {
    expect(parseSelector('nvidia/minimaxai/minimax-m3@max')).toEqual({
      provider: 'nvidia',
      model: 'minimaxai/minimax-m3',
      effort: 'max',
      raw: 'nvidia/minimaxai/minimax-m3@max',
    })
  })

  it('keeps a non-effort suffix inside the model id', () => {
    // An invalid effort grammar is model text, never a parse error.
    expect(parseSelector('a/b@Not An Effort')).toEqual({
      provider: 'a',
      model: 'b@Not An Effort',
      raw: 'a/b@Not An Effort',
    })
    expect(parseSelector('a/b@').model).toBe('b@')
    expect(parseSelector('a/b@High').model).toBe('b@High') // effort ids are lowercase
  })

  it('keeps the selector key effort-free', () => {
    // A parsed pin lives on the HOP, not on the route: the key of the pinned
    // entry equals the key of the same entry without a pin.
    const pinned = parseSelector('openai/gpt-4o@high')
    expect(selectorKey(pinned.provider, pinned.model)).toBe('openai/gpt-4o')
    expect(selectorKey(pinned.provider, pinned.model)).toBe(selectorKey('openai', 'gpt-4o'))
  })
})

describe('resolveWildcardEntry', () => {
  it('keeps the failing model id and swaps only the provider', () => {
    expect(resolveWildcardEntry('gpt-4o', 'anthropic')).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
      raw: 'anthropic/gpt-4o',
    })
  })

  it('carries the wildcard entry\'s pinned effort through', () => {
    expect(resolveWildcardEntry('gpt-4o', 'anthropic', 'low')).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
      effort: 'low',
      raw: 'anthropic/gpt-4o@low',
    })
  })
})
