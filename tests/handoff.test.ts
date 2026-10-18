/**
 * Deterministic handoff report tests with a fake sessionQuery service.
 * No model calls, no network, no real filesystem.
 *
 * Run: bun test tests/handoff.test.ts
 */

import { describe, expect, test } from 'bun:test'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import { applyHandoff } from '../src/features/handoff.ts'
import { exec, execWithAgent, fakeContext } from './fake-context.ts'

const SESSION_ID = 'session-handoff-1'

function handoffTool(tools: Map<string, ToolDefinitionLike>): ToolDefinitionLike {
  const tool = tools.get('handoff')
  expect(tool).toBeDefined()
  return tool!
}

describe('handoff', () => {
  test('builds a deterministic report from mixed events', async () => {
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 1,
        type: 'user/message',
        data: {
          id: 'u1',
          role: 'user',
          content: [{ type: 'text', text: 'Fix the failing tests in src/app.ts' }],
          source: { kind: 'user' },
        },
      },
      {
        seq: 2,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect the file.' }] },
        },
      },
      {
        seq: 3,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'call-write',
          name: 'write',
          arguments: JSON.stringify({ file_path: 'src/app.ts', content: 'export const x = 1\n' }),
        },
      },
      {
        seq: 4,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'call-write',
            isError: true,
            content: [{ type: 'text', text: 'EACCES: permission denied' }],
          },
        },
      },
      {
        seq: 5,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 2,
          callId: 'call-bash',
          name: 'bash',
          arguments: JSON.stringify({ command: 'bun test tests/app.test.ts' }),
        },
      },
      {
        seq: 6,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 2,
          message: {
            role: 'tool',
            toolCallId: 'call-bash',
            isError: false,
            content: [{ type: 'text', text: '1 failing test' }],
          },
        },
      },
      {
        seq: 7,
        type: 'tool/call',
        data: {
          turn: 1,
          step: 2,
          callId: 'call-patch',
          name: 'apply_patch',
          arguments: JSON.stringify({
            input: '*** Begin Patch\n*** Update File: src/util.ts\n@@\n-old\n+new\n*** End Patch',
          }),
        },
      },
      // Duplicate request in the alternate `{message:{content}}` shape.
      {
        seq: 8,
        type: 'user/message',
        data: { message: { content: [{ type: 'text', text: 'Fix the failing tests in src/app.ts' }] } },
      },
      {
        seq: 9,
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer: fixed the tests.' }] },
        },
      },
      { seq: 10, type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } },
      { seq: 11, type: 'future/unknown', data: { payload: { anything: true } } },
    ]

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
    applyHandoff(fake.ctx, {})

    const result = await handoffTool(fake.tools).execute(
      { session_id: SESSION_ID },
      exec(),
    )
    const markdown = String(result.markdown)

    expect(markdown).toContain('Fix the failing tests in src/app.ts')
    expect(markdown).toContain('Final answer: fixed the tests.')
    expect(markdown).toContain('EACCES: permission denied')
    expect(markdown).toContain('src/app.ts')
    expect(markdown).toContain('src/util.ts')
    expect(markdown).toContain('bun test tests/app.test.ts')
    expect(markdown).toContain('max-tokens')
    expect(markdown).toContain('## Resume checklist')
    expect(markdown).toContain('Re-read every file')
    expect(markdown).toContain('Re-run the failed commands')
    expect(markdown).toContain('Confirm the unfinished items')
    // The duplicate user message is collapsed before rendering.
    expect(markdown.split('Fix the failing tests in src/app.ts').length - 1).toBe(1)

    expect(result.stats).toEqual({
      events: 12,
      userMessages: 1,
      toolCalls: 3,
      toolErrors: 1,
      files: 2,
      commands: 1,
    })
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
                { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Continue the task' }] } },
                { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } },
              ],
            }
          },
        },
      },
    })
    applyHandoff(fake.ctx, {})

    const result = await handoffTool(fake.tools).execute(
      {},
      execWithAgent({ session: { id: 'current-agent-session' } }),
    )

    expect(requested).toEqual(['current-agent-session'])
    expect(String(result.markdown)).toContain('# Session handoff: `current-agent-session`')
    expect(result.stats).toEqual({
      events: 2,
      userMessages: 1,
      toolCalls: 0,
      toolErrors: 0,
      files: 0,
      commands: 0,
    })
  })

  test('reports a missing sessionQuery service', async () => {
    const fake = fakeContext()
    applyHandoff(fake.ctx, {})

    await expect(handoffTool(fake.tools).execute({ session_id: SESSION_ID }, exec()))
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
    applyHandoff(fake.ctx, {})

    await expect(handoffTool(fake.tools).execute({ session_id: 'missing-session' }, exec()))
      .rejects.toThrow(/could not read session "missing-session"/)
  })

  test('can be disabled with handoff: false', () => {
    const fake = fakeContext()
    applyHandoff(fake.ctx, { handoff: false })
    expect(fake.tools.has('handoff')).toBe(false)
  })

  test('filters injected context and extracts apply_patch edits arrays', async () => {
    const events = [
      {
        seq: 1,
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'Edit both config files' }] },
      },
      {
        seq: 2,
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
      },
      {
        seq: 3,
        type: 'tool/call',
        data: {
          callId: 'patch-1',
          name: 'apply_patch',
          arguments: {
            edits: [
              { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
              { file_path: 'src/b.ts', old_string: 'c', new_string: 'd' },
            ],
          },
        },
      },
    ]
    const fake = fakeContext({
      services: {
        sessionQuery: { async readSession() { return events } },
      },
    })
    applyHandoff(fake.ctx, {})
    const result = await handoffTool(fake.tools).execute({ session_id: SESSION_ID }, exec())
    const markdown = String(result.markdown)
    expect(markdown).toContain('Edit both config files')
    expect(markdown).not.toContain('Current runtime context')
    expect(markdown).toContain('src/a.ts')
    expect(markdown).toContain('src/b.ts')
    expect(result.stats).toMatchObject({ userMessages: 1, files: 2, toolCalls: 1 })
  })
})
