/**
 * Session budget tests with a fake Cordis context.
 * No model calls, no network, no real filesystem.
 *
 * Run: bun test tests/budget.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { applyBudget } from '../src/features/budget.ts'
import { exec, execWithAgent, fakeContext } from './fake-context.ts'

function usageEvent(seq: number, usage: unknown) {
  return { seq, time: 1_700_000_000_000 + seq, type: 'assistant/message', data: { usage } }
}

describe('budget', () => {
  test('accumulates usage once per event and reports status', async () => {
    const fake = fakeContext()
    applyBudget(fake.ctx, { budget: true })
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
    applyBudget(fake.ctx, { budget: { maxTokens: 100, enforce: true } })
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
    applyBudget(fake.ctx, { budget: { maxTokens: 150, enforce: true } })
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
    applyBudget(fake.ctx, { budget: { maxTokens: 30, enforce: true } })

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
})
