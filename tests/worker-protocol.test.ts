/**
 * NDJSON JSON-RPC worker protocol and WorkerTaskState tests.
 * Pure in-memory; no child processes, sockets, or dsh integration.
 *
 * Run: bun test tests/worker-protocol.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  MAX_WORKER_LINE_BYTES,
  WorkerTaskState,
  decodeWorkerLine,
  encodeWorkerMessage,
  isWorkerMessage,
  type WorkerCancel,
  type WorkerCheckpoint,
  type WorkerExecute,
  type WorkerResult,
} from '../src/worker-protocol.ts'

const execute: WorkerExecute = {
  jsonrpc: '2.0',
  id: 1,
  method: 'execute',
  params: {
    task_id: 'task-1',
    session_id: 'session-1',
    from_step: 0,
    capabilities: ['fs:read:/project/src'],
    timeout_ms: 30_000,
  },
}

const checkpoint: WorkerCheckpoint = {
  jsonrpc: '2.0',
  id: 2,
  method: 'checkpoint',
  params: {
    task_id: 'task-1',
    step_index: 3,
    actions: [{ type: 'read_file', path: 'src/a.ts' }],
    progress_percent: 40,
  },
}

const result: WorkerResult = {
  jsonrpc: '2.0',
  id: 'result-1',
  method: 'result',
  params: {
    task_id: 'task-1',
    status: 'completed',
    result: { changed: ['src/a.ts'] },
    metrics: { duration_ms: 1_200, tokens_consumed: 300, cost_cents: 1 },
  },
}

const cancel: WorkerCancel = {
  jsonrpc: '2.0',
  id: 3,
  method: 'cancel',
  params: { task_id: 'task-1', reason: 'user cancelled' },
}

describe('worker codec', () => {
  test('round-trips all four worker message types', () => {
    for (const message of [execute, checkpoint, result, cancel]) {
      const line = encodeWorkerMessage(message)
      expect(line.endsWith('\n')).toBe(true)
      expect(line.split('\n')).toHaveLength(2)
      expect(decodeWorkerLine(line)).toEqual({ ok: true, value: message })
    }
  })

  test('encoding is deterministic and canonical key order is accepted', () => {
    const first = encodeWorkerMessage(execute)
    const second = encodeWorkerMessage({ ...execute })

    expect(first).toBe(second)
    expect(first.indexOf('"id"')).toBeLessThan(first.indexOf('"jsonrpc"'))
    expect(isWorkerMessage(execute)).toBe(true)
    expect(isWorkerMessage({ jsonrpc: '2.0' })).toBe(false)
  })

  test('rejects malformed lines, frames, methods, and missing fields', () => {
    expect(decodeWorkerLine('').ok).toBe(false)
    expect(decodeWorkerLine('   \r\n').ok).toBe(false)
    expect(decodeWorkerLine('not json').ok).toBe(false)
    expect(decodeWorkerLine('[]').ok).toBe(false)
    expect(decodeWorkerLine('null').ok).toBe(false)
    expect(decodeWorkerLine(JSON.stringify({ id: 1, method: 'execute', params: { task_id: 't' } })).ok)
      .toBe(false)
    expect(decodeWorkerLine(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'execute', params: { task_id: 't' } })).ok)
      .toBe(false)
    expect(decodeWorkerLine(JSON.stringify({ jsonrpc: '2.0', method: 'execute', params: { task_id: 't' } })).ok)
      .toBe(false)
    expect(decodeWorkerLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown', params: {} })).ok)
      .toBe(false)

    const unknown = decodeWorkerLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'unknown',
      params: { task_id: 't' },
    }))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toMatch(/unknown method/)

    const missingTask = decodeWorkerLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'checkpoint',
      params: { step_index: 1 },
    }))
    expect(missingTask.ok).toBe(false)
    if (!missingTask.ok) expect(missingTask.error).toMatch(/task_id/)

    const missingStep = decodeWorkerLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'checkpoint',
      params: { task_id: 't' },
    }))
    expect(missingStep.ok).toBe(false)
    if (!missingStep.ok) expect(missingStep.error).toMatch(/step_index/)

    const missingStatus = decodeWorkerLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'result',
      params: { task_id: 't' },
    }))
    expect(missingStatus.ok).toBe(false)
    if (!missingStatus.ok) expect(missingStatus.error).toMatch(/status/)

    const badStatus = decodeWorkerLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'result',
      params: { task_id: 't', status: 'done' },
    }))
    expect(badStatus.ok).toBe(false)
    if (!badStatus.ok) expect(badStatus.error).toMatch(/status/)
  })

  test('rejects lines over 1 MiB before parsing', () => {
    const line = 'x'.repeat(MAX_WORKER_LINE_BYTES + 1)
    const decoded = decodeWorkerLine(line)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error).toMatch(/too large/)
  })

  test('refuses to encode an invalid message', () => {
    expect(() => encodeWorkerMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'checkpoint',
      params: { task_id: 't' },
    } as unknown as WorkerCheckpoint)).toThrow(/step_index/)
  })
})

describe('WorkerTaskState', () => {
  test('runs queued -> running -> checkpointing -> completed', () => {
    const state = new WorkerTaskState('task-1')
    expect(state.status).toBe('queued')
    expect(state.step).toBe(0)

    expect(state.start().status).toBe('running')
    expect(state.checkpoint(1).status).toBe('checkpointing')
    expect(state.step).toBe(1)
    expect(state.checkpoint(2).step).toBe(2)
    expect(state.checkpoints.map(record => record.step)).toEqual([1, 2])

    const completed = state.complete({ ok: true })
    expect(completed.status).toBe('completed')
    expect(completed.result).toEqual({ ok: true })
    expect(state.toJSON()).toEqual(completed)
  })

  test('rejects illegal transitions and stale checkpoints', () => {
    const state = new WorkerTaskState('task-2')
    expect(() => state.checkpoint(1)).toThrow(/cannot checkpoint from queued/)
    expect(() => state.complete('done')).toThrow(/cannot complete from queued/)
    expect(() => state.start()).not.toThrow()
    expect(() => state.start()).toThrow(/cannot start from running/)
    expect(() => state.checkpoint(0)).toThrow(/stale checkpoint/)
    state.checkpoint(2)
    expect(() => state.checkpoint(2)).toThrow(/stale checkpoint/)
    expect(() => state.checkpoint(1)).toThrow(/stale checkpoint/)
    state.complete()
    expect(() => state.checkpoint(3)).toThrow(/cannot checkpoint from completed/)
    expect(() => state.complete()).toThrow(/cannot complete from completed/)
    expect(() => state.cancel('too late')).toThrow(/cannot cancel from completed/)
    expect(() => state.fail(new Error('too late'))).toThrow(/cannot fail from completed/)
  })

  test('allows fail and cancel from queued and records terminal reasons', () => {
    const failed = new WorkerTaskState({ taskId: 'queued-fail' })
    failed.fail({ code: 'rejected', message: 'no capacity' })
    expect(failed.status).toBe('failed')
    expect(failed.snapshot().error).toEqual({ code: 'rejected', message: 'no capacity' })

    const cancelled = new WorkerTaskState({ taskId: 'queued-cancel' })
    const snapshot = cancelled.cancel('duplicate task')
    expect(snapshot.status).toBe('cancelled')
    expect(snapshot.cancelReason).toBe('duplicate task')
  })

  test('checks deadlines with an injected clock and fails the task', () => {
    let now = 1_000
    const state = new WorkerTaskState({
      taskId: 'deadline',
      deadlineMs: 100,
      now: () => now,
    })
    expect(state.deadlineAt).toBe(1_100)
    state.start()

    now = 1_100
    expect(state.checkDeadline()).toBe(false)
    now = 1_101
    expect(state.checkDeadline()).toBe(true)
    expect(state.status).toBe('failed')
    const snapshot = state.snapshot()
    expect(snapshot.error).toMatchObject({ code: 'deadline_exceeded' })
    expect(snapshot.checkpoints).toEqual([])
  })

  test('throws on an expired deadline and keeps the failed state', () => {
    let now = 0
    const state = new WorkerTaskState('deadline-2', { deadlineMs: 50, now: () => now })
    state.start()
    now = 51

    expect(() => state.checkpoint(1)).toThrow(/deadline exceeded/)
    expect(state.status).toBe('failed')
    expect(() => state.complete('ignored')).toThrow(/cannot complete from failed/)
  })

  test('cancel wins over a passed deadline when called explicitly', () => {
    let now = 0
    const state = new WorkerTaskState({ taskId: 'cancel', deadlineMs: 10, now: () => now })
    state.start()
    now = 100

    const snapshot = state.cancel('user cancelled')
    expect(snapshot.status).toBe('cancelled')
    expect(snapshot.cancelReason).toBe('user cancelled')
    expect(state.checkDeadline()).toBe(false)
  })

  test('records checkpoint timestamps from the injected clock', () => {
    let now = 42
    const state = new WorkerTaskState({ now: () => now })
    state.start()
    now = 43
    state.checkpoint(1)
    now = 47
    state.checkpoint(2)

    expect(state.checkpoints).toEqual([
      { step: 1, at: 43 },
      { step: 2, at: 47 },
    ])
  })
})
