/**
 * Session budget tests with a fake Cordis context.
 * No model calls, no network, no real filesystem.
 *
 * Run: bun test tests/budget.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyBudget } from '../src/features/budget.ts'
import { exec, execWithAgent, fakeContext } from './fake-context.ts'

const budgetDirs: string[] = []

function budgetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-budget-'))
  budgetDirs.push(dir)
  return dir
}

function budgetOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...options, dir: budgetDir() }
}

afterAll(() => {
  for (const dir of budgetDirs) rmSync(dir, { recursive: true, force: true })
})

function usageEvent(seq: number, usage: unknown) {
  return { seq, time: 1_700_000_000_000 + seq, type: 'assistant/message', data: { usage } }
}

describe('budget', () => {
  test('accumulates usage once per event and reports status', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions() })
    const session = { id: 'session-a' }

    expect(fake.handlers.has('agent/request')).toBe(false)

    await fake.emit('session/event', session, usageEvent(1, {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 150,
    }))
    // No total: input + output.
    await fake.emit('session/event', session, usageEvent(2, { inputTokens: 100, outputTokens: 20 }))
    // Same seq again must not double-count.
    await fake.emit('session/event', session, usageEvent(1, {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 150,
    }))
    await fake.emit('session/event', session, {
      seq: 3,
      time: 1,
      type: 'compaction/summary',
      data: { usage: { totalTokens: 50 } },
    })
    // Missing usage is ignored.
    await fake.emit('session/event', session, { seq: 4, time: 1, type: 'assistant/message', data: {} })
    await fake.emit('session/event', session, usageEvent(5, { outputTokens: 30 }))

    const status = await fake.tools.get('budget_status')!.execute(
      {},
      execWithAgent({ session: { id: 'session-a' } }),
    )
    expect(status).toEqual({
      session_id: 'session-a',
      used_tokens: 350,
      max_tokens: 200_000,
      reserved: 0,
      remaining: 199_650,
      exhausted: false,
      enforced: false,
    })

    // The same seq in a different session is a different event.
    await fake.emit('session/event', { id: 'session-b' }, usageEvent(1, { totalTokens: 1000 }))
    const other = await fake.tools.get('budget_status')!.execute({ session_id: 'session-b' }, exec())
    expect(other.used_tokens).toBe(1000)
    expect(other.session_id).toBe('session-b')

    // Unknown sessions start at zero rather than failing.
    const unknown = await fake.tools.get('budget_status')!.execute({ session_id: 'never-seen' }, exec())
    expect(unknown.used_tokens).toBe(0)
    expect(unknown.exhausted).toBe(false)

    // agent/created materializes the counter without changing it.
    await fake.emit('agent/created', { agent: { session: { id: 'session-c' } }, source: { kind: 'user' } })
    const created = await fake.tools.get('budget_status')!.execute({ session_id: 'session-c' }, exec())
    expect(created.used_tokens).toBe(0)

    await expect(fake.tools.get('budget_status')!.execute({}, exec()))
      .rejects.toThrow(/no session id/)
  })

  test('restores usage and seq dedupe after a restart', async () => {
    const dir = budgetDir()
    const config = { budget: { dir, maxTokens: 500 } }
    const first = fakeContext()
    applyBudget(first.ctx, config)
    const session = { id: 'session-restart' }

    await first.emit('session/event', session, usageEvent(1, { totalTokens: 100 }))
    await first.emit('session/event', session, usageEvent(2, { totalTokens: 50 }))

    const second = fakeContext()
    applyBudget(second.ctx, config)
    const status = await second.tools.get('budget_status')!.execute(
      { session_id: 'session-restart' },
      exec(),
    )
    expect(status.used_tokens).toBe(150)

    // The persisted seq set must still prevent a replayed usage event from
    // charging the session again.
    await second.emit('session/event', session, usageEvent(1, { totalTokens: 100 }))
    let current = await second.tools.get('budget_status')!.execute({ session_id: 'session-restart' }, exec())
    expect(current.used_tokens).toBe(150)

    await second.emit('session/event', session, usageEvent(3, { totalTokens: 25 }))
    current = await second.tools.get('budget_status')!.execute({ session_id: 'session-restart' }, exec())
    expect(current.used_tokens).toBe(175)
    expect(current.remaining).toBe(325)
  })

  test('is disabled unless configured and false disables it', () => {
    const unconfigured = fakeContext()
    applyBudget(unconfigured.ctx, {})
    expect(unconfigured.tools.has('budget_status')).toBe(false)

    const disabled = fakeContext()
    applyBudget(disabled.ctx, { budget: false })
    expect(disabled.tools.has('budget_status')).toBe(false)
  })

  test('enforcement refuses a request at the cap', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 100, enforce: true }) })
    const session = { id: 'session-enforced' }

    await fake.emit('session/event', session, usageEvent(1, { totalTokens: 120 }))

    const status = await fake.tools.get('budget_status')!.execute(
      {},
      execWithAgent({ session: { id: 'session-enforced' } }),
    )
    expect(status).toEqual({
      session_id: 'session-enforced',
      used_tokens: 120,
      max_tokens: 100,
      reserved: 0,
      remaining: 0,
      exhausted: true,
      enforced: true,
    })

    let nextCalls = 0
    const next = async () => {
      nextCalls++
      return 'next-marker'
    }
    await expect(fake.emit(
      'agent/request',
      { agent: { session: { id: 'session-enforced' } }, turn: 1, step: 0, signal: new AbortController().signal },
      next,
    )).rejects.toThrow(/super-dsh budget exhausted/)
    expect(nextCalls).toBe(0)
  })

  test('enforcement passes requests below the cap and ignores duplicate usage', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 150, enforce: true }) })
    const session = { id: 'session-under' }

    // Two deliveries of seq 1 count once: 100, not 200.
    await fake.emit('session/event', session, usageEvent(1, { totalTokens: 100 }))
    await fake.emit('session/event', session, usageEvent(1, { totalTokens: 100 }))

    let nextCalls = 0
    const results = await fake.emit(
      'agent/request',
      { agent: { session: { id: 'session-under' } }, turn: 1, step: 0, signal: new AbortController().signal },
      async () => {
        nextCalls++
        return 'seed-config'
      },
    )
    expect(nextCalls).toBe(1)
    expect(results).toEqual(['seed-config'])

    const status = await fake.tools.get('budget_status')!.execute(
      { session_id: 'session-under' },
      exec(),
    )
    expect(status.used_tokens).toBe(100)
    expect(status.remaining).toBe(50)
    expect(status.exhausted).toBe(false)
    expect(status.enforced).toBe(true)
  })

  test('enforcement refuses exactly at the cap with input/output fallback', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 30, enforce: true }) })

    await fake.emit('session/event', { id: 'session-exact' }, usageEvent(1, {
      inputTokens: 20,
      outputTokens: 10,
    }))

    await expect(fake.emit(
      'agent/request',
      { agent: { session: { id: 'session-exact' } }, turn: 2, step: 1, signal: new AbortController().signal },
      async () => 'never',
    )).rejects.toThrow(/budget exhausted/)
  })

  test('reserves before requests, blocks over-cap requests, and settles actual usage', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 100, enforce: true, reservePerRequest: 40 }) })
    const agent = { session: { id: 'session-reserve' } }
    const session = agent.session
    const status = () => fake.tools.get('budget_status')!
      .execute({ session_id: 'session-reserve' }, exec())

    // No turn/step on this event: charged directly, not settled.
    await fake.emit('session/event', session, usageEvent(1, { totalTokens: 10 }))

    const next = async () => 'admitted'
    expect(await fake.emit('agent/request', { agent, turn: 1, step: 0 }, next)).toEqual(['admitted'])
    expect(await fake.emit('agent/request', { agent, turn: 1, step: 1 }, next)).toEqual(['admitted'])

    let current = await status()
    expect(current).toMatchObject({
      used_tokens: 10,
      reserved: 80,
      // remaining keeps its original meaning: max - used.
      remaining: 90,
      exhausted: false,
    })

    // 10 used + 80 reserved + 40 reserve > 100.
    let blockedCalls = 0
    await expect(fake.emit('agent/request', { agent, turn: 1, step: 2 }, async () => {
      blockedCalls++
      return 'never'
    })).rejects.toThrow(/budget exhausted/)
    expect(blockedCalls).toBe(0)

    // A repeated waterfall for a held step keeps the single reservation.
    expect(await fake.emit('agent/request', { agent, turn: 1, step: 0 }, next)).toEqual(['admitted'])
    current = await status()
    expect(current.reserved).toBe(80)

    // Settle step 0 with 10 actual tokens.
    await fake.emit('session/event', session, {
      seq: 2,
      time: 1_700_000_000_002,
      type: 'assistant/message',
      data: { usage: { totalTokens: 10 }, turn: 1, step: 0 },
    })
    current = await status()
    expect(current).toMatchObject({ used_tokens: 20, reserved: 40, remaining: 80 })
    expect(current.exhausted).toBe(false)

    // Re-delivering the same seq must not settle a second time.
    await fake.emit('session/event', session, {
      seq: 2,
      time: 1_700_000_000_002,
      type: 'assistant/message',
      data: { usage: { totalTokens: 10 }, turn: 1, step: 0 },
    })
    current = await status()
    expect(current).toMatchObject({ used_tokens: 20, reserved: 40 })

    // 20 used + 40 reserved + 40 reserve == 100: exactly at the cap is allowed.
    expect(await fake.emit('agent/request', { agent, turn: 1, step: 2 }, next)).toEqual(['admitted'])
    current = await status()
    expect(current).toMatchObject({ used_tokens: 20, reserved: 80 })

    await fake.emit('session/event', session, {
      seq: 3,
      time: 1_700_000_000_003,
      type: 'assistant/message',
      data: { usage: { totalTokens: 15 }, turn: 1, step: 1 },
    })
    await fake.emit('session/event', session, {
      seq: 4,
      time: 1_700_000_000_004,
      type: 'assistant/message',
      data: { usage: { totalTokens: 50 }, turn: 1, step: 2 },
    })
    current = await status()
    expect(current).toMatchObject({
      used_tokens: 85,
      reserved: 0,
      remaining: 15,
      exhausted: false,
      enforced: true,
    })
  })

  test('releases reservations on request errors and thrown waterfalls', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 50, enforce: true, reservePerRequest: 30 }) })
    const agent = { session: { id: 'session-errors' } }
    const status = () => fake.tools.get('budget_status')!
      .execute({ session_id: 'session-errors' }, exec())

    await fake.emit('agent/request', { agent, turn: 4, step: 0 }, async () => 'admitted')
    expect((await status()).reserved).toBe(30)

    await fake.emit('agent/request-error', {
      agent,
      turn: 4,
      step: 0,
      error: { message: 'provider overloaded' },
    })
    let current = await status()
    expect(current).toMatchObject({ used_tokens: 0, reserved: 0 })

    await expect(fake.emit(
      'agent/request',
      { agent, turn: 4, step: 1 },
      async () => {
        throw new Error('provider down')
      },
    )).rejects.toThrow(/provider down/)
    current = await status()
    expect(current).toMatchObject({ used_tokens: 0, reserved: 0 })

    // Both holds are gone, so two more requests fit under the cap again.
    expect(await fake.emit('agent/request', { agent, turn: 4, step: 2 }, async () => 'admitted'))
      .toEqual(['admitted'])
    current = await status()
    expect(current.reserved).toBe(30)
  })

  test('turn/end releases every unsettled reservation of that turn', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 1_000, enforce: true, reservePerRequest: 100 }) })
    const agent = { session: { id: 'session-turn' } }
    const status = () => fake.tools.get('budget_status')!
      .execute({ session_id: 'session-turn' }, exec())
    const next = async () => 'admitted'

    await fake.emit('agent/request', { agent, turn: 1, step: 0 }, next)
    await fake.emit('agent/request', { agent, turn: 1, step: 1 }, next)
    await fake.emit('agent/request', { agent, turn: 2, step: 0 }, next)
    expect((await status()).reserved).toBe(300)

    await fake.emit('turn/end', { agent, turn: 1 })
    let current = await status()
    expect(current.reserved).toBe(100)

    await fake.emit('turn/end', { agent, turn: 2 })
    current = await status()
    expect(current.reserved).toBe(0)

    // A turn/end without a turn clears every hold of the session.
    await fake.emit('agent/request', { agent, turn: 3, step: 0 }, next)
    expect((await status()).reserved).toBe(100)
    await fake.emit('turn/end', { agent })
    expect((await status()).reserved).toBe(0)
  })

  test('reservePerRequest 0 preserves the previous enforcement behavior', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: budgetOptions({ maxTokens: 100, enforce: true }) })
    const agent = { session: { id: 'session-zero' } }

    await fake.emit('session/event', agent.session, usageEvent(1, { totalTokens: 100 }))
    const current = await fake.tools.get('budget_status')!
      .execute({ session_id: 'session-zero' }, exec())
    expect(current).toMatchObject({
      used_tokens: 100,
      reserved: 0,
      remaining: 0,
      exhausted: true,
      enforced: true,
    })

    await expect(fake.emit(
      'agent/request',
      { agent, turn: 1, step: 0 },
      async () => 'never',
    )).rejects.toThrow(/budget exhausted/)
    // Reservation lifecycle handlers are not installed when nothing is reserved.
    expect(fake.handlers.has('agent/request-error')).toBe(false)
    expect(fake.handlers.has('turn/end')).toBe(false)
  })
})
