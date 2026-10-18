/**
 * Deterministic history compaction tests with a fake sessionQuery service.
 * No model calls, no network, no real filesystem.
 *
 * Run: bun test tests/history-compact.test.ts
 */

import { describe, expect, test } from 'bun:test'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import {
  applyHistoryCompact,
  compactEvents,
  DEFAULT_COMPACT_MAX_CHARS,
  MAX_COMPACT_MAX_CHARS,
  MIN_COMPACT_MAX_CHARS,
} from '../src/features/history-compact.ts'
import { exec, execWithAgent, fakeContext } from './fake-context.ts'

const SESSION_ID = 'session-compact-1'

function compactTool(tools: Map<string, ToolDefinitionLike>): ToolDefinitionLike {
  const tool = tools.get('history_compact')
  expect(tool).toBeDefined()
  return tool!
}

function mixedEvents(): unknown[] {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }] },
    },
    {
      seq: 2,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Fix the failing tests in src/app.ts' }] },
    },
    {
      seq: 3,
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'I will inspect the file.' }] } },
    },
    {
      seq: 4,
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'call-write',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'src/app.ts', content: 'export const x = 1\n' }),
      },
    },
    {
      seq: 5,
      type: 'tool/result',
      data: {
        turn: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-write',
          isError: true,
          content: [{ type: 'text', text: 'EACCES: permission denied' }],
        },
      },
    },
    {
      seq: 6,
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'call-bash-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'bun test tests/app.test.ts' }),
      },
    },
    {
      seq: 7,
      type: 'tool/result',
      data: {
        turn: 1,
        message: { role: 'tool', toolCallId: 'call-bash-1', isError: false, content: [{ type: 'text', text: 'pass' }] },
      },
    },
    {
      seq: 8,
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'call-bash-2',
        name: 'bash',
        arguments: { command: 'bun test' },
      },
    },
    {
      seq: 9,
      type: 'tool/result',
      data: {
        turn: 1,
        message: { role: 'tool', toolCallId: 'call-bash-2', isError: false, content: [{ type: 'text', text: 'pass' }] },
      },
    },
    {
      seq: 10,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Intermediate result.' }] } },
    },
    { seq: 11, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 12, type: 'turn/start', data: { turn: 2 } },
    {
      seq: 13,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Also update src/util.ts and verify' }] },
    },
    {
      seq: 14,
      type: 'tool/call',
      data: {
        turn: 2,
        callId: 'call-patch',
        name: 'apply_patch',
        arguments: {
          input: '*** Begin Patch\n*** Update File: src/util.ts\n@@\n-old\n+new\n*** End Patch',
        },
      },
    },
    {
      seq: 15,
      type: 'tool/result',
      data: {
        turn: 2,
        message: { role: 'tool', toolCallId: 'call-patch', isError: false, content: [{ type: 'text', text: 'ok' }] },
      },
    },
    {
      seq: 16,
      type: 'tool/call',
      data: {
        turn: 2,
        callId: 'call-fuzzy',
        name: 'fuzzy_edit',
        arguments: { file_path: 'src/app.ts', old_string: 'missing', new_string: 'new' },
      },
    },
    {
      seq: 17,
      type: 'tool/result',
      data: {
        turn: 2,
        message: {
          role: 'tool',
          toolCallId: 'call-fuzzy',
          isError: true,
          content: [{ type: 'text', text: 'old_string not found' }],
        },
      },
    },
    {
      seq: 18,
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: 'Final answer: updated src/app.ts and src/util.ts.' }] },
      },
    },
    { seq: 19, type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } },
    { seq: 20, type: 'future/unknown', data: { payload: { anything: true } } },
  ]
}

describe('history_compact', () => {
  test('compacts mixed events by turn with deterministic progress and stats', async () => {
    const events = mixedEvents()
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            expect(id).toBe(SESSION_ID)
            return events
          },
        },
      },
    })
    applyHistoryCompact(fake.ctx, {})

    const result = await compactTool(fake.tools).execute({ session_id: SESSION_ID }, exec())
    const summary = String(result.summary)

    expect(summary).toContain('## Goal')
    expect(summary).toContain('Fix the failing tests in src/app.ts')
    expect(summary).not.toContain('Current runtime context')
    expect(summary).toContain('## Progress')
    expect(summary).toContain('Turn 1:')
    expect(summary).toContain('Turn 2:')
    expect(summary).toContain('bash×2')
    expect(summary).toContain('write×1')
    expect(summary).toContain('src/util.ts')
    expect(summary).toContain('EACCES: permission denied')
    expect(summary).toContain('old_string not found')
    expect(summary).toContain('## Current state')
    expect(summary).toContain('Final answer: updated src/app.ts and src/util.ts.')
    expect(summary).toContain('max-tokens')
    expect(summary).toContain('## Next steps')

    const nextStepLines = summary
      .slice(summary.indexOf('## Next steps'))
      .split('\n')
      .filter(line => line.startsWith('- '))
    expect(nextStepLines).toHaveLength(3)
    expect(summary).toContain('Resume or close the unfinished')
    expect(summary).toContain('Re-run the failing `write` call')

    // Interrupted intermediate assistant text is superseded by the final text.
    expect(summary).toContain('"Intermediate result."')
    expect(summary).toContain('Run the project\'s tests, lint, or typecheck')

    expect(result.summary).toBe(compactEvents(events))
    expect(result.stats).toEqual({
      events: events.length,
      turns: 2,
      original_chars: JSON.stringify(events).length,
      compact_chars: summary.length,
      ratio: Math.round((summary.length / JSON.stringify(events).length) * 1000) / 1000,
    })
    const rendered = JSON.stringify(compactTool(fake.tools).output.render({}, result))
    expect(rendered).toContain('Compacted')
    expect(rendered).toContain('ratio')
  })

  test('filters every injected user-context shape and uses the first real request as the goal', async () => {
    const events = [
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '<system-reminder>ignore this</system-reminder>' }] },
      },
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '<available_skills>write</available_skills>' }] },
      },
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'Current runtime context. cwd=/tmp' }] },
      },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'Ship the release' }] } },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'Working on it.' }] } },
      },
    ]
    const summary = compactEvents(events)
    expect(summary).toContain('Ship the release')
    expect(summary).not.toContain('ignore this')
    expect(summary).not.toContain('<available_skills>')
    expect(summary).not.toContain('cwd=/tmp')
  })

  test('drops older turns before truncating the goal or current state', async () => {
    const events: unknown[] = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'Compact this long session' }] } },
    ]
    for (let turn = 1; turn <= 8; turn += 1) {
      events.push({ type: 'turn/start', data: { turn } })
      events.push({
        type: 'user/message',
        data: { content: [{ type: 'text', text: `Request ${turn}: ${'r'.repeat(300)}` }] },
      })
      events.push({
        type: 'assistant/message',
        data: { turn, message: { content: [{ type: 'text', text: `Answer ${turn}: ${'a'.repeat(500)}` }] } },
      })
      events.push({
        type: 'tool/call',
        data: { turn, name: 'write', arguments: { file_path: `src/f${turn}.ts`, content: 'x' } },
      })
      events.push({
        type: 'tool/result',
        data: {
          turn,
          message: { role: 'tool', isError: false, content: [{ type: 'text', text: 'ok' }] },
        },
      })
      events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }

    const maxChars = 5000
    const summary = compactEvents(events, maxChars)
    expect(summary.length).toBeLessThanOrEqual(maxChars)
    expect(summary).toContain('## Goal')
    expect(summary).toContain('## Current state')
    expect(summary).toContain('## Next steps')
    expect(summary).toContain('Compact this long session')
    expect(summary).toContain('Request 8')
    expect(summary).not.toContain('Answer 1:')
    expect(summary).toContain('older turn(s) omitted')
    expect(summary).toContain('Answer 8')
  })

  test('honors the character budget floor and ceiling', () => {
    const events = mixedEvents()
    expect(compactEvents(events, 10)).toBe(compactEvents(events, MIN_COMPACT_MAX_CHARS))
    expect(compactEvents(events, 1_000_000)).toBe(compactEvents(events, MAX_COMPACT_MAX_CHARS))
    expect(compactEvents(events).length).toBeLessThanOrEqual(DEFAULT_COMPACT_MAX_CHARS)
  })

  test('uses the current agent session by default and accepts a snapshot-shaped read', async () => {
    const requested: string[] = []
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            requested.push(id)
            return {
              session: { id },
              events: [
                { type: 'user/message', data: { content: [{ type: 'text', text: 'Continue the task' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } },
              ],
            }
          },
        },
      },
    })
    applyHistoryCompact(fake.ctx, {})

    const result = await compactTool(fake.tools).execute(
      {},
      execWithAgent({ session: { id: 'current-agent-session' } }),
    )

    expect(requested).toEqual(['current-agent-session'])
    expect(String(result.summary)).toContain('Continue the task')
    expect(result.stats).toMatchObject({ events: 2, turns: 1 })
  })

  test('reports a missing sessionQuery service', async () => {
    const fake = fakeContext()
    applyHistoryCompact(fake.ctx, {})

    await expect(compactTool(fake.tools).execute({ session_id: SESSION_ID }, exec()))
      .rejects.toThrow(/sessionQuery/)
  })

  test('propagates a missing session error from sessionQuery', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            if (id !== SESSION_ID) throw new Error(`session not found: ${id}`)
            return []
          },
        },
      },
    })
    applyHistoryCompact(fake.ctx, {})

    await expect(compactTool(fake.tools).execute({ session_id: 'missing-session' }, exec()))
      .rejects.toThrow(/could not read session "missing-session"/)
  })

  test('rejects a snapshot without events and a missing agent session', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession() {
            return { session: { id: SESSION_ID } }
          },
        },
      },
    })
    applyHistoryCompact(fake.ctx, {})

    await expect(compactTool(fake.tools).execute({ session_id: SESSION_ID }, exec()))
      .rejects.toThrow(/no event list/)
    await expect(compactTool(fake.tools).execute({}, exec()))
      .rejects.toThrow(/no session id/)
  })

  test('can be disabled with historyCompact: false', () => {
    const fake = fakeContext()
    applyHistoryCompact(fake.ctx, { historyCompact: false })
    expect(fake.tools.has('history_compact')).toBe(false)
  })

  test('declares a JSON output schema and defaults to 4000 characters', () => {
    const fake = fakeContext()
    applyHistoryCompact(fake.ctx, {})
    const tool = compactTool(fake.tools)
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        max_chars: { type: 'integer', minimum: 500, maximum: 20000 },
      },
    })
    expect(tool.output.schema).toMatchObject({
      type: 'object',
      required: ['summary', 'stats'],
    })
  })

  test('does not count read-only file paths as changed files', () => {
    const summary = compactEvents([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'Inspect the repository' }] } },
      {
        type: 'tool/call',
        data: { name: 'read', arguments: { file_path: 'src/read-only.ts' } },
      },
      {
        type: 'tool/call',
        data: { name: 'glob', arguments: { pattern: 'src/**/*.ts' } },
      },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'Inspection complete.' }] } },
      },
    ])
    expect(summary).not.toContain('changed file')
    expect(summary).not.toContain('src/read-only.ts')
    expect(summary).toContain('Run the project\'s verification command')
  })
})
