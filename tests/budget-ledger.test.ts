/**
 * BudgetLedger reservation semantics. Pure in-memory, no host events.
 *
 * Run: bun test tests/budget-ledger.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { BudgetLedger } from '../src/budget-ledger.ts'

describe('BudgetLedger', () => {
  test('reserves, settles, and releases headroom', () => {
    const ledger = new BudgetLedger(100)
    expect(ledger.used).toBe(0)
    expect(ledger.reserved).toBe(0)
    expect(ledger.remaining).toBe(100)

    expect(ledger.reserve('turn:1', 40)).toBe(true)
    expect(ledger.hasReservation('turn:1')).toBe(true)
    expect(ledger.reservationAmount('turn:1')).toBe(40)
    expect(ledger.reserved).toBe(40)
    expect(ledger.remaining).toBe(60)

    // Settling removes the hold and adds actual usage, even when actual is
    // smaller than the estimate.
    expect(ledger.settle('turn:1', 30)).toBe(true)
    expect(ledger.hasReservation('turn:1')).toBe(false)
    expect(ledger.used).toBe(30)
    expect(ledger.reserved).toBe(0)
    expect(ledger.remaining).toBe(70)

    // A refund (release) drops an unused hold without charging.
    expect(ledger.reserve('turn:2', 20)).toBe(true)
    expect(ledger.release('turn:2')).toBe(true)
    expect(ledger.release('turn:2')).toBe(false)
    expect(ledger.reserved).toBe(0)
    expect(ledger.used).toBe(30)
    expect(ledger.remaining).toBe(70)
  })

  test('restores used tokens from a durable snapshot', () => {
    const ledger = new BudgetLedger(100, 40)
    expect(ledger.used).toBe(40)
    expect(ledger.remaining).toBe(60)
    ledger.charge(10)
    expect(ledger.used).toBe(50)
    expect(new BudgetLedger(10, Number.NaN).used).toBe(0)
  })

  test('rejects duplicate keys without changing the hold', () => {
    const ledger = new BudgetLedger(100)
    expect(ledger.reserve('same', 10)).toBe(true)
    expect(ledger.reserve('same', 50)).toBe(false)
    expect(ledger.reservationAmount('same')).toBe(10)
    expect(ledger.reserved).toBe(10)
  })

  test('refuses reservations that would exceed the cap', () => {
    const ledger = new BudgetLedger(100)
    expect(ledger.reserve('a', 60)).toBe(true)
    expect(ledger.reserve('b', 40)).toBe(true)
    expect(ledger.reserved).toBe(100)
    expect(ledger.remaining).toBe(0)
    // used(0) + reserved(100) + 1 > 100
    expect(ledger.reserve('c', 1)).toBe(false)
    expect(ledger.hasReservation('c')).toBe(false)

    ledger.release('b')
    expect(ledger.reserved).toBe(60)
    expect(ledger.reserve('c', 40)).toBe(true)
    expect(ledger.reserved).toBe(100)

    ledger.settle('a', 60)
    // used(60) + reserved(40) is still full; actual usage counts like the
    // reservation it replaced.
    expect(ledger.reserve('d', 1)).toBe(false)
    expect(ledger.settle('c', 40)).toBe(true)
    expect(ledger.used).toBe(100)
    expect(ledger.remaining).toBe(0)
  })

  test('rejects invalid keys and amounts', () => {
    const ledger = new BudgetLedger(10)
    expect(ledger.reserve('', 1)).toBe(false)
    expect(ledger.reserve('bad', -1)).toBe(false)
    expect(ledger.reserve('bad', Number.NaN)).toBe(false)
    expect(ledger.reserve('bad', Number.POSITIVE_INFINITY)).toBe(false)
    expect(ledger.reserved).toBe(0)
    expect(() => new BudgetLedger(-1)).toThrow(RangeError)
    expect(() => new BudgetLedger(Number.NaN)).toThrow(RangeError)
  })

  test('settle without a reservation charges usage directly', () => {
    const ledger = new BudgetLedger(20)
    expect(ledger.settle('unreserved', 7)).toBe(false)
    expect(ledger.used).toBe(7)
    expect(ledger.remaining).toBe(13)
    ledger.charge(5)
    expect(ledger.used).toBe(12)
  })

  test('releases reservations by prefix and reports a snapshot', () => {
    const ledger = new BudgetLedger(1_000)
    ledger.reserve('session-a:1:0', 100)
    ledger.reserve('session-a:1:1', 50)
    ledger.reserve('session-a:2:0', 25)
    ledger.settle('session-a:2:0', 10)

    expect(ledger.snapshot()).toEqual({
      maxTokens: 1_000,
      used: 10,
      reserved: 150,
      remaining: 840,
      reservations: [
        { key: 'session-a:1:0', amount: 100 },
        { key: 'session-a:1:1', amount: 50 },
      ],
    })
    expect(ledger.reservationKeys()).toEqual(['session-a:1:0', 'session-a:1:1'])

    expect(ledger.releasePrefix('session-a:1:')).toBe(2)
    expect(ledger.reserved).toBe(0)
    expect(ledger.releasePrefix('')).toBe(0)
    expect(ledger.snapshot()).toEqual({
      maxTokens: 1_000,
      used: 10,
      reserved: 0,
      remaining: 990,
      reservations: [],
    })
  })
})
