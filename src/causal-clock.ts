/**
 * A small vector clock for multi-subagent fan-in.
 *
 * dsh sessions are single-writer, so the harness does not need a causal clock
 * for normal execution and this module is intentionally not wired into the
 * plugin. It exists for callers that run sibling subagents and later need to
 * order their persisted events: each subagent ticks its own key, and the
 * parent merges snapshots with `merge`, then uses `compare` to distinguish
 * happened-before from concurrent work.
 *
 * Comparison result is relative to `this`:
 * - `before`: this clock happened before the other.
 * - `after`: this clock happened after the other.
 * - `equal`: the clocks carry the same counts.
 * - `concurrent`: each clock has a count the other lacks or trails.
 */

export type CausalComparison = 'before' | 'after' | 'concurrent' | 'equal'

export class CausalClock {
  private readonly counts = new Map<string, number>()

  constructor(initial?: CausalClock | Record<string, number>) {
    if (initial !== undefined) this.merge(initial)
  }

  /** Increment one session/subagent counter and return its new value. */
  tick(sessionId: string): number {
    assertSessionId(sessionId)
    const current = this.counts.get(sessionId) ?? 0
    if (!Number.isSafeInteger(current + 1)) {
      throw new RangeError(`CausalClock: counter for "${sessionId}" exceeds the safe integer range`)
    }
    const next = current + 1
    this.counts.set(sessionId, next)
    return next
  }

  /** Merge another clock (or a plain snapshot), keeping the per-key maximum. */
  merge(other: CausalClock | Record<string, number>): this {
    const source = other instanceof CausalClock ? other.snapshot() : other
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError('CausalClock.merge: expected a CausalClock or {sessionId: count} record')
    }
    for (const [sessionId, value] of Object.entries(source)) {
      assertSessionId(sessionId)
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`CausalClock.merge: count for "${sessionId}" must be a non-negative safe integer`)
      }
      const current = this.counts.get(sessionId) ?? 0
      if (value > current) this.counts.set(sessionId, value)
    }
    return this
  }

  /** Independent, key-sorted copy of the clock. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const sessionId of [...this.counts.keys()].sort()) {
      out[sessionId] = this.counts.get(sessionId) as number
    }
    return out
  }

  compare(other: CausalClock | Record<string, number>): CausalComparison {
    const remote = other instanceof CausalClock ? other.snapshot() : other
    if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) {
      throw new TypeError('CausalClock.compare: expected a CausalClock or {sessionId: count} record')
    }

    let thisGreater = false
    let otherGreater = false
    const keys = new Set<string>([...this.counts.keys(), ...Object.keys(remote)])
    for (const key of keys) {
      const mine = this.counts.get(key) ?? 0
      const theirs = remote[key] ?? 0
      if (!Number.isSafeInteger(theirs) || theirs < 0) {
        throw new RangeError(`CausalClock.compare: count for "${key}" must be a non-negative safe integer`)
      }
      if (mine > theirs) thisGreater = true
      else if (mine < theirs) otherGreater = true
    }

    if (!thisGreater && !otherGreater) return 'equal'
    if (thisGreater && !otherGreater) return 'after'
    if (!thisGreater && otherGreater) return 'before'
    return 'concurrent'
  }

  toJSON(): Record<string, number> {
    return this.snapshot()
  }

  static fromJSON(value: unknown): CausalClock {
    if (value instanceof CausalClock) return new CausalClock(value)
    if (typeof value === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new TypeError('CausalClock.fromJSON: string is not valid JSON')
      }
      return new CausalClock(recordOf(parsed))
    }
    return new CausalClock(recordOf(value))
  }
}

function recordOf(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('CausalClock.fromJSON: expected a {sessionId: count} object')
  }
  return value as Record<string, number>
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('CausalClock: session id must be a non-empty string')
  }
}
