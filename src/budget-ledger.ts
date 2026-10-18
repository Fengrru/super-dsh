/**
 * Token budget with reservations.
 *
 * A request can be admitted only after reserving an estimate of its cost. The
 * reservation shrinks the available headroom immediately, so concurrent or
 * fast-arriving requests cannot all pass the same free-token check before any
 * usage arrives. When the provider reports actual usage the reservation is
 * settled into `used`; on failure the reservation is released untouched.
 *
 * The ledger is intentionally in-memory and synchronous: the event handlers
 * that use it are not allowed to interleave on the reservation check.
 */

export interface BudgetReservation {
  key: string
  amount: number
}

export interface BudgetSnapshot {
  maxTokens: number
  used: number
  reserved: number
  remaining: number
  reservations: BudgetReservation[]
}

export class BudgetLedger {
  readonly maxTokens: number
  private usedTokens = 0
  private readonly reservations = new Map<string, number>()

  constructor(maxTokens: number) {
    if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens < 0) {
      throw new RangeError(
        `BudgetLedger requires a non-negative finite maxTokens (received ${String(maxTokens)})`,
      )
    }
    this.maxTokens = Math.floor(maxTokens)
  }

  /** Tokens already consumed by settled and directly charged usage. */
  get used(): number {
    return this.usedTokens
  }

  /** Sum of outstanding reservations. */
  get reserved(): number {
    let total = 0
    for (const amount of this.reservations.values()) total += amount
    return total
  }

  /** Headroom not consumed and not reserved, clamped at zero. */
  get remaining(): number {
    return Math.max(0, this.maxTokens - this.usedTokens - this.reserved)
  }

  /**
   * Reserve `amount` for `key`. Returns false when the key is already
   * reserved or when `used + reserved + amount` would exceed the cap.
   */
  reserve(key: string, amount: number): boolean {
    if (typeof key !== 'string' || key.length === 0) return false
    const tokens = normalizeTokens(amount)
    if (tokens === undefined) return false
    if (this.reservations.has(key)) return false
    if (this.usedTokens + this.reserved + tokens > this.maxTokens) return false
    this.reservations.set(key, tokens)
    return true
  }

  /**
   * Convert a reservation into actual usage. The reservation is removed even
   * when it is smaller than the actual amount. Returns whether a reservation
   * existed; without one `actual` is simply charged to `used`.
   */
  settle(key: string, actual: number): boolean {
    const tokens = normalizeTokens(actual) ?? 0
    const hadReservation = this.reservations.delete(key)
    this.usedTokens += tokens
    return hadReservation
  }

  /** Charge usage that never went through a reservation. */
  charge(amount: number): void {
    const tokens = normalizeTokens(amount)
    if (tokens !== undefined) this.usedTokens += tokens
  }

  /** Drop a reservation without charging anything. Returns whether it existed. */
  release(key: string): boolean {
    return this.reservations.delete(key)
  }

  /** Release every reservation whose key starts with `prefix`. */
  releasePrefix(prefix: string): number {
    if (prefix.length === 0) return 0
    let released = 0
    for (const key of [...this.reservations.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.reservations.delete(key)
      released++
    }
    return released
  }

  hasReservation(key: string): boolean {
    return this.reservations.has(key)
  }

  reservationAmount(key: string): number | undefined {
    return this.reservations.get(key)
  }

  reservationKeys(): string[] {
    return [...this.reservations.keys()]
  }

  snapshot(): BudgetSnapshot {
    return {
      maxTokens: this.maxTokens,
      used: this.usedTokens,
      reserved: this.reserved,
      remaining: this.remaining,
      reservations: [...this.reservations].map(([key, amount]) => ({ key, amount })),
    }
  }
}

function normalizeTokens(value: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}
