/**
 * CausalClock vector-clock tests. Pure in-memory; no dsh integration.
 *
 * Run: bun test tests/causal-clock.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { CausalClock } from '../src/causal-clock.ts'

describe('CausalClock', () => {
  test('ticks per session and returns a stable snapshot', () => {
    const clock = new CausalClock()
    expect(clock.snapshot()).toEqual({})

    expect(clock.tick('agent-a')).toBe(1)
    expect(clock.tick('agent-a')).toBe(2)
    expect(clock.tick('agent-b')).toBe(1)
    expect(clock.snapshot()).toEqual({ 'agent-a': 2, 'agent-b': 1 })

    const snapshot = clock.snapshot()
    snapshot['agent-a'] = 99
    expect(clock.snapshot()['agent-a']).toBe(2)
  })

  test('merges plain records and other clocks by per-key maximum', () => {
    const clock = new CausalClock({ a: 1 })
    clock.tick('a')
    clock.merge({ a: 4, b: 2 })
    expect(clock.snapshot()).toEqual({ a: 4, b: 2 })

    const other = new CausalClock({ a: 7, c: 3 })
    clock.merge(other)
    expect(clock.snapshot()).toEqual({ a: 7, b: 2, c: 3 })

    // Merging a lower clock is idempotent.
    clock.merge({ a: 1, b: 1 })
    expect(clock.snapshot()).toEqual({ a: 7, b: 2, c: 3 })
    expect(clock.tick('a')).toBe(8)
  })

  test('compares equal, before, after, and concurrent clocks', () => {
    const a = new CausalClock({ s1: 2, s2: 1 })
    const same = new CausalClock({ s1: 2, s2: 1 })
    expect(a.compare(same)).toBe('equal')
    expect(same.compare(a)).toBe('equal')

    const earlier = new CausalClock({ s1: 1, s2: 1 })
    expect(earlier.compare(a)).toBe('before')
    expect(a.compare(earlier)).toBe('after')

    const later = new CausalClock({ s1: 3, s2: 1 })
    expect(a.compare(later)).toBe('before')
    expect(later.compare(a)).toBe('after')

    const concurrent = new CausalClock({ s1: 3, s2: 0 })
    expect(a.compare(concurrent)).toBe('concurrent')
    expect(concurrent.compare(a)).toBe('concurrent')

    expect(new CausalClock().compare(new CausalClock())).toBe('equal')
    expect(new CausalClock().compare({ s1: 1 })).toBe('before')
    expect(new CausalClock({ s1: 1 }).compare({})).toBe('after')
  })

  test('merges a fan-in of two subagents and detects concurrency', () => {
    const left = new CausalClock()
    const right = new CausalClock()
    left.tick('left')
    left.tick('left')
    right.tick('right')

    const parent = new CausalClock()
    parent.merge(left).merge(right)
    expect(parent.snapshot()).toEqual({ left: 2, right: 1 })

    expect(left.compare(right)).toBe('concurrent')
    expect(left.compare(parent)).toBe('before')
    expect(right.compare(parent)).toBe('before')
    expect(parent.compare(left)).toBe('after')
  })

  test('serializes through toJSON/fromJSON and JSON.stringify', () => {
    const clock = new CausalClock()
    clock.tick('agent-a')
    clock.tick('agent-a')
    clock.tick('agent-b')

    expect(clock.toJSON()).toEqual({ 'agent-a': 2, 'agent-b': 1 })
    expect(JSON.stringify(clock)).toBe('{"agent-a":2,"agent-b":1}')

    const fromObject = CausalClock.fromJSON(JSON.parse(JSON.stringify(clock)))
    expect(fromObject.snapshot()).toEqual(clock.snapshot())
    expect(fromObject.compare(clock)).toBe('equal')

    const fromString = CausalClock.fromJSON('{"agent-b":4,"agent-a":2}')
    expect(fromString.tick('agent-a')).toBe(3)
    expect(fromString.tick('agent-b')).toBe(5)

    const copy = CausalClock.fromJSON(clock)
    expect(copy.snapshot()).toEqual(clock.snapshot())
    copy.tick('agent-a')
    expect(clock.snapshot()['agent-a']).toBe(2)
  })

  test('rejects invalid counts, ids, and serialized input', () => {
    const clock = new CausalClock()
    expect(() => clock.tick('')).toThrow(/session id/)
    expect(() => clock.merge({ a: -1 })).toThrow(/non-negative/)
    expect(() => clock.merge({ a: 1.5 })).toThrow(/non-negative/)
    expect(() => clock.compare({ a: Number.NaN })).toThrow(/non-negative/)
    expect(() => CausalClock.fromJSON('not json')).toThrow(/valid JSON/)
    expect(() => CausalClock.fromJSON(null)).toThrow(/expected/)
    expect(() => CausalClock.fromJSON([1, 2])).toThrow(/expected/)
  })
})
