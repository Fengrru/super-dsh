/**
 * Deterministic session reflection tests with a fake sessionQuery service.
 * No model calls, no network, no real filesystem.
 *
 * Run: bun test tests/reflection.test.ts
 */

import { describe, expect, test } from 'bun:test'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import { applyReflection } from '../src/features/reflection.ts'
import { exec, execWithAgent, fakeContext } from './fake-context.ts'

const SESSION_ID = 'session-reflect-1'

function reflectTool(tools: Map<string, ToolDefinitionLike>): ToolDefinitionLike {
  const tool = tools.get('reflect')
  expect(tool).toBeDefined()
  return tool!
}

function problematicEvents(): unknown[] {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Fix the build' }] },
    },
    {
      seq: 2,
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'bash-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'bun run dev' }),
      },
    },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        turn: 1,
        message: {
          role: 'tool',
          toolCallId: 'bash-1',
          isError: true,
          content: [{ type: 'text', text: 'Command failed: exit 1' }],
        },
      },
    },
    {
      seq: 4,
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'bash-2',
        name: 'bash',
        arguments: { command: 'bun run dev' },
      },
    },
    {
      seq: 5,
      type: 'tool/result',
      data: {
        turn: 1,
        message: {
          role: 'tool',
          toolCallId: 'bash-2',
          isError: true,
          content: [{ type: 'text', text: 'Command failed: exit 1' }],
        },
      },
    },
    {
      seq: 6,
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'write-1',
        name: 'write',
        arguments: { file_path: 'src/app.ts', content: 'export const x = 1\n' },
      },
    },
    {
      seq: 7,
      type: 'tool/result',
      data: {
        turn: 1,
        message: { role: 'tool', toolCallId: 'write-1', isError: false, content: [{ type: 'text', text: 'ok' }] },
      },
    },
    {
      seq: 8,
      type: 'tool/call',
      data: {
        turn: 1,
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
    {
      seq: 9,
      type: 'tool/result',
      data: {
        turn: 1,
        message: { role: 'tool', toolCallId: 'patch-1', isError: false, content: [{ type: 'text', text: 'ok' }] },
      },
    },
    {
      seq: 10,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'max-tokens', error: { message: 'token limit reached' } } },
    },
  ]
}

describe('reflect', () => {
  test('aggregates repeated calls, errors, files, and unfinished turns', async () => {
    const events = problematicEvents()
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
    applyReflection(fake.ctx, {})

    const result = await reflectTool(fake.tools).execute({ session_id: SESSION_ID }, exec())
    const markdown = String(result.markdown)
    const suggestions = result.suggestions as string[]

    expect(markdown).toContain('## Summary')
    expect(markdown).toContain('## Repeated calls')
    expect(markdown).toContain('## Errors')
    expect(markdown).toContain('## Verification')
    expect(markdown).toContain('## Suggestions')
    expect(markdown).toContain('`bash` called 2 times with identical arguments')
    expect(markdown).toContain('`bash` (2 times): Command failed: exit 1')
    expect(markdown).toContain('Verification observed: **no**')
    expect(markdown).toContain('src/app.ts')
    expect(markdown).toContain('src/a.ts')
    expect(markdown).toContain('src/b.ts')

    expect(suggestions).toContain('Tool bash failed 2 times: inspect the error and change approach.')
    expect(suggestions).toContain('Repeated identical call to bash 2 times: cache the result or change the plan.')
    expect(suggestions).toContain('Files changed without an observed verification command.')
    expect(suggestions.some(suggestion => suggestion.includes('Unfinished turn:'))).toBe(true)
    expect(result.stats).toEqual({
      events: events.length,
      toolCalls: 4,
      toolErrors: 2,
      repeatedCalls: 1,
      files: 3,
      unfinishedTurns: 1,
    })
  })

  test('reports a clean, verified session with the normal-case suggestion', async () => {
    const events = [
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'Update the config and test it' }] },
      },
      {
        type: 'tool/call',
        data: { name: 'write', arguments: { file_path: 'config.ts', content: 'export default {}\n' } },
      },
      {
        type: 'tool/result',
        data: {
          message: { role: 'tool', isError: false, content: [{ type: 'text', text: 'ok' }] },
        },
      },
      {
        type: 'tool/call',
        data: { name: 'bash', arguments: { command: 'bun test' } },
      },
      {
        type: 'tool/result',
        data: {
          message: { role: 'tool', isError: false, content: [{ type: 'text', text: 'pass' }] },
        },
      },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]
    const fake = fakeContext({
      services: {
        sessionQuery: { async readSession() { return { events } } },
      },
    })
    applyReflection(fake.ctx, {})

    const result = await reflectTool(fake.tools).execute({ session_id: SESSION_ID }, exec())
    const markdown = String(result.markdown)

    expect(markdown).toContain('Verification observed: **yes**')
    expect(markdown).toContain('bun test')
    expect(markdown).toContain('_No repeated identical calls recorded._')
    expect(markdown).toContain('_No tool errors recorded._')
    expect(result.suggestions).toEqual(['No repeated failures or unverified edits detected.'])
    expect(result.stats).toEqual({
      events: 6,
      toolCalls: 2,
      toolErrors: 0,
      repeatedCalls: 0,
      files: 1,
      unfinishedTurns: 0,
    })
  })

  test('canonicalizes argument key order and treats a verify tool as verification', async () => {
    const events = [
      {
        type: 'tool/call',
        data: {
          name: 'write',
          arguments: JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
        },
      },
      {
        type: 'tool/call',
        data: {
          name: 'write',
          arguments: { new_string: 'b', old_string: 'a', file_path: 'src/a.ts' },
        },
      },
      {
        type: 'tool/call',
        data: { name: 'verify', arguments: {} },
      },
      { type: 'turn/end', data: { reason: 'completed' } },
    ]
    const fake = fakeContext({
      services: {
        sessionQuery: { async readSession() { return events } },
      },
    })
    applyReflection(fake.ctx, {})

    const result = await reflectTool(fake.tools).execute({ session_id: SESSION_ID }, exec())
    const markdown = String(result.markdown)

    expect(markdown).toContain('`write` called 2 times with identical arguments')
    expect(markdown).toContain('Verification observed: **yes**')
    expect(markdown).toContain('`verify` tool was called.')
    expect((result.suggestions as string[]).some(suggestion => suggestion.includes('Repeated identical call to write 2 times')))
      .toBe(true)
    expect(result.stats).toMatchObject({ toolCalls: 3, repeatedCalls: 1, files: 1, unfinishedTurns: 0 })
  })

  test('uses the current agent session by default', async () => {
    const requested: string[] = []
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            requested.push(id)
            return {
              session: { id },
              events: [
                { type: 'user/message', data: { content: [{ type: 'text', text: 'Review my work' }] } },
                { type: 'turn/end', data: { reason: { kind: 'completed' } } },
              ],
            }
          },
        },
      },
    })
    applyReflection(fake.ctx, {})

    const result = await reflectTool(fake.tools).execute({}, execWithAgent({ session: { id: 'current-agent-session' } }))

    expect(requested).toEqual(['current-agent-session'])
    expect(String(result.markdown)).toContain('## Summary')
    expect(result.stats).toMatchObject({ events: 2, toolCalls: 0, unfinishedTurns: 0 })
  })

  test('reports a missing sessionQuery service', async () => {
    const fake = fakeContext()
    applyReflection(fake.ctx, {})

    await expect(reflectTool(fake.tools).execute({ session_id: SESSION_ID }, exec()))
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
    applyReflection(fake.ctx, {})

    await expect(reflectTool(fake.tools).execute({ session_id: 'missing-session' }, exec()))
      .rejects.toThrow(/could not read session "missing-session"/)
  })

  test('rejects a snapshot without events and a missing agent session', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: { async readSession() { return { session: { id: SESSION_ID } } } },
      },
    })
    applyReflection(fake.ctx, {})

    await expect(reflectTool(fake.tools).execute({ session_id: SESSION_ID }, exec()))
      .rejects.toThrow(/no event list/)
    await expect(reflectTool(fake.tools).execute({}, exec()))
      .rejects.toThrow(/no session id/)
  })

  test('can be disabled with reflection: false', () => {
    const fake = fakeContext()
    applyReflection(fake.ctx, { reflection: false })
    expect(fake.tools.has('reflect')).toBe(false)
  })

  test('declares a JSON output schema with suggestions and stats', () => {
    const fake = fakeContext()
    applyReflection(fake.ctx, {})
    const tool = reflectTool(fake.tools)
    expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
    expect(tool.output.schema).toMatchObject({
      type: 'object',
      required: ['markdown', 'suggestions', 'stats'],
    })
  })
})
