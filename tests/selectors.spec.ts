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
    expect(() => parseSelector('provider/*/x')).toThrow(SelectorError)
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

describe('resolveWildcardEntry', () => {
  it('keeps the failing model id and swaps only the provider', () => {
    expect(resolveWildcardEntry('gpt-4o', 'anthropic')).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
      raw: 'anthropic/gpt-4o',
    })
  })
})
