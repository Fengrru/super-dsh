/**
 * Direct checks for the vendored fuzzy matcher. The safety wrapper has its own
 * tests; these exercise the matching strategies and the value-literal guard.
 */

import { describe, expect, test } from 'bun:test'
import {
  availableStrategies,
  canPatch,
  fuzzyFindAndReplace,
} from '../src/vendor/fuzzy-patch.ts'

describe('vendor fuzzy matching', () => {
  test('exact matches win first and report offsets', () => {
    const content = 'const value = 1\n'
    const result = fuzzyFindAndReplace(content, 'value = 1', 'value = 2')
    expect(result.strategy).toBe('exact')
    expect(result.matchCount).toBe(1)
    expect(result.newContent).toBe('const value = 2\n')
    expect(result.matchedText).toBe('value = 1')
    expect(result.matchedIndex).toBe(6)
    expect(result.matchedLength).toBe(9)
  })

  test('whitespace, indentation, and CRLF drift are recoverable', () => {
    const whitespace = fuzzyFindAndReplace(
      'const   value   =   1\n',
      'const value = 1',
      'const value = 2',
    )
    expect(whitespace.matchCount).toBe(1)
    expect(whitespace.newContent).toContain('const value = 2')

    const indentation = fuzzyFindAndReplace(
      '  if (ready) {\n    return 1\n  }\n',
      'if (ready) {\n  return 1\n}',
      'if (ready) {\n  return 2\n}',
    )
    expect(indentation.matchCount).toBe(1)

    const crlf = fuzzyFindAndReplace(
      'const a = 1\r\nconst b = 2\r\n',
      'const a = 1\nconst b = 2',
      'const a = 10\nconst b = 20',
    )
    expect(crlf.matchCount).toBe(1)
    expect(crlf.newContent).toContain('const a = 10')
  })

  test('token and typo-level drift are available without changing values', () => {
    const token = 'function  alpha ( value ) { return value }'
    const tokenQuery = 'function alpha(value) { return value }'
    expect(canPatch(token, tokenQuery)).toBe(true)
    expect(availableStrategies(token, tokenQuery).length).toBeGreaterThan(0)

    const typoContent = 'export function validateToken(value) { return value.length > 0 }'
    const typoQuery = 'export function validateTokne(value) { return value.length > 0 }'
    expect(canPatch(typoContent, typoQuery)).toBe(true)
    const typo = fuzzyFindAndReplace(typoContent, typoQuery, 'export function validateToken(value) { return true }')
    expect(typo.matchCount).toBe(1)
    expect(typo.newContent).toContain('return true')
  })

  test('refuses a fuzzy match that would change a value literal', () => {
    const content = 'const config = { port: 9999 }\n'
    expect(canPatch(content, 'const config = { port: 3000 }')).toBe(false)
    const result = fuzzyFindAndReplace(content, 'const config = { port: 3000 }', 'const config = { port: 8080 }')
    expect(result.matchCount).toBe(0)
    expect(result.strategy).toBe('none')
    expect(result.newContent).toBe(content)
  })

  test('handles identity, empty, no-match, and replace-all cases', () => {
    expect(fuzzyFindAndReplace('a', 'a', 'a')).toMatchObject({ matchCount: 0, strategy: 'identity' })
    expect(fuzzyFindAndReplace('a', '', 'b')).toMatchObject({ matchCount: 0, strategy: 'empty_old' })
    expect(fuzzyFindAndReplace('a', 'zzz', 'b')).toMatchObject({ matchCount: 0, strategy: 'none' })

    const all = fuzzyFindAndReplace('x x x', 'x', 'y', true)
    expect(all.matchCount).toBe(3)
    expect(all.newContent).toBe('y y y')
    expect(canPatch('x x x', 'x')).toBe(true)
    expect(availableStrategies('x', 'x')).toContain('exact')
  })

  test('short and multi-line candidates do not throw', () => {
    const multi = 'one\ntwo\nthree\nfour\nfive\n'
    expect(() => availableStrategies(multi, 'one\ntwo\nthree')).not.toThrow()
    expect(() => availableStrategies('a', 'a')).not.toThrow()
    expect(canPatch('a', 'a')).toBe(true)
  })
})
