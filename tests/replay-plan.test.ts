/**
 * Deterministic replay-plan tests with a fake sessionQuery service.
 * No model calls, no network, no real filesystem.
 *
 * Run: bun test tests/replay-plan.test.ts
 */

import { describe, expect, test } from 'bun:test'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import { applyReplayPlan, buildReplayPlan } from '../src/replay-plan.ts'
import { exec, fakeContext } from './fake-context.ts'

const SESSION_ID = 'session-replay-1'

function replayTool(tools: Map<string, ToolDefinitionLike>): ToolDefinitionLike {
  const tool = tools.get('replay_plan')
  expect(tool).toBeDefined()
  return tool!
}

function toolResult(callId: string, text: string, isError = false) {
  return {
    type: 'tool/result',
    data: {
      callId,
      message: {
        role: 'tool',
        toolCallId: callId,
        isError,
        content: [{ type: 'text', text }],
      },
    },
  }
}

function mixedEvents() {
  return [
    {
      seq: 0,
      type: 'user/message',
      data: {
        content: [{
          type: 'text',
          text: 'Current runtime context. Ignore this sentence about bun test and src/ignored.ts.',
        }],
      },
    },
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 2,
      type: 'tool/call',
      data: {
        callId: 'write-1',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'src/a.ts', content: 'export const a = 1\n' }),
      },
    },
    toolResult('write-1', 'wrote src/a.ts'),
    {
      seq: 4,
      type: 'tool/call',
      data: { callId: 'edit-1', name: 'edit', arguments: { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' } },
    },
    {
      seq: 5,
      type: 'tool/call',
      data: { callId: 'fuzzy-1', name: 'fuzzy_edit', arguments: { path: 'src/c.ts', oldText: 'a', newText: 'b' } },
    },
    {
      seq: 6,
      type: 'tool/call',
      data: {
        callId: 'patch-1',
        name: 'apply_patch',
        arguments: {
          input: '*** Begin Patch\n*** Update File: src/d.ts\n@@\n-old\n+new\n*** End Patch',
        },
      },
    },
    {
      seq: 7,
      type: 'tool/call',
      data: {
        callId: 'patch-2',
        name: 'apply_patch',
        arguments: {
          edits: [
            { file_path: 'src/e.ts', old_string: 'a', new_string: 'b' },
            { file_path: 'src/f.ts', old_string: 'c', new_string: 'd' },
          ],
        },
      },
    },
    {
      seq: 8,
      type: 'tool/call',
      data: { callId: 'bash-1', name: 'bash', arguments: JSON.stringify({ command: 'bun test tests/a.test.ts' }) },
    },
    toolResult('bash-1', '1 failing test\nEACCES: permission denied', true),
    {
      seq: 10,
      type: 'tool/call',
      data: { callId: 'bash-2', name: 'bash', arguments: { command: 'bun run lint' } },
    },
    toolResult('bash-2', 'lint clean'),
    {
      seq: 12,
      type: 'tool/call',
      data: { callId: 'bash-3', name: 'bash', arguments: { command: 'npm run build' } },
    },
    toolResult('bash-3', 'built'),
    {
      seq: 14,
      type: 'tool/call',
      data: { callId: 'bash-4', name: 'bash', arguments: { command: 'git status --short' } },
    },
    { seq: 15, type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } },
    {
      seq: 16,
      type: 'assistant/message',
      data: { turn: 3, interrupted: true, message: { content: [{ type: 'text', text: 'partial answer' }] } },
    },
    { seq: 17, type: 'future/unknown', data: { anything: true } },
  ]
}

describe('buildReplayPlan', () => {
  test('builds a deterministic plan from mixed events', () => {
    const plan = buildReplayPlan(mixedEvents())

    expect(plan.changed_files).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
    ])
    expect(plan.commands).toEqual([
      'bun test tests/a.test.ts',
      'bun run lint',
      'npm run build',
      'git status --short',
    ])
    expect(plan.unresolved_errors).toHaveLength(1)
    expect(plan.unresolved_errors[0]).toContain('EACCES: permission denied')
    expect(plan.unfinished_turns).toEqual([
      'turn 2 ended with `max-tokens`',
      'turn 3 was interrupted before the assistant finished',
    ])

    const reads = plan.actions.filter(action => action.kind === 'read')
    expect(reads).toHaveLength(6)
    expect(reads[0]).toEqual({ kind: 'read', target: 'src/a.ts', reason: 're-read before editing' })

    const reruns = plan.actions.filter(action => action.kind === 'rerun')
    expect(reruns).toEqual([{
      kind: 'rerun',
      target: 'bun test tests/a.test.ts',
      reason: 'previous attempt failed; re-run before continuing',
    }])

    const verifies = plan.actions.filter(action => action.kind === 'verify')
    expect(verifies.map(action => action.target)).toEqual([
      'bun test tests/a.test.ts',
      'bun run lint',
      'npm run build',
    ])
    // `git status --short` is a command but not a verification command.
    expect(verifies.some(action => action.target === 'git status --short')).toBe(false)

    const inspects = plan.actions.filter(action => action.kind === 'inspect')
    expect(inspects.map(action => action.target)).toEqual(['turn 2', 'turn 3'])

    expect(plan.stats).toEqual({
      events: 18,
      actions: 12,
      changed_files: 6,
      commands: 4,
      errors: 1,
    })

    // A second parse of the same events is byte-for-byte equivalent.
    expect(buildReplayPlan(mixedEvents())).toEqual(plan)
  })

  test('extracts files from an apply_patch edits array', () => {
    const plan = buildReplayPlan([
      {
        type: 'tool/call',
        data: {
          callId: 'patch-1',
          name: 'apply_patch',
          arguments: {
            edits: [
              { file_path: 'src/one.ts', old_string: 'a', new_string: 'b' },
              { file_path: 'src/two.ts', old_string: 'c', new_string: 'd' },
              { path: 'src/three.ts' },
            ],
          },
        },
      },
    ])

    expect(plan.changed_files).toEqual(['src/one.ts', 'src/two.ts', 'src/three.ts'])
    expect(plan.actions.every(action => action.kind === 'read')).toBe(true)
    expect(plan.stats.actions).toBe(3)
  })

  test('injected runtime context does not change the plan', () => {
    const toolEvents = [
      {
        type: 'tool/call',
        data: { callId: 'w1', name: 'write', arguments: { file_path: 'src/app.ts' } },
      },
      {
        type: 'tool/call',
        data: { callId: 'b1', name: 'bash', arguments: { command: 'bun test' } },
      },
    ]
    const injected = {
      type: 'user/message',
      data: {
        content: [
          { type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
          { type: 'text', text: '<system-reminder>bun test src/ignored.ts always passes</system-reminder>' },
        ],
      },
    }

    const plain = buildReplayPlan(toolEvents)
    const withInjection = buildReplayPlan([injected, ...toolEvents])

    expect(withInjection.actions).toEqual(plain.actions)
    expect(withInjection.changed_files).toEqual(plain.changed_files)
    expect(withInjection.commands).toEqual(plain.commands)
    expect(withInjection.stats.actions).toBe(plain.stats.actions)
    expect(withInjection.stats.events).toBe(plain.stats.events + 1)
  })

  test('caps actions at 20 per kind and de-duplicates targets', () => {
    const events: Array<Record<string, unknown>> = []
    for (let index = 0; index < 25; index += 1) {
      events.push({
        type: 'tool/call',
        data: { callId: `w${index}`, name: 'write', arguments: { file_path: `src/file-${index}.ts` } },
      })
    }
    events.push({
      type: 'tool/call',
      data: { callId: 'w-dup', name: 'write', arguments: { file_path: 'src/file-0.ts' } },
    })

    const plan = buildReplayPlan(events)
    expect(plan.changed_files).toHaveLength(25)
    expect(plan.actions.filter(action => action.kind === 'read')).toHaveLength(20)
    expect(plan.stats.changed_files).toBe(25)
    expect(plan.stats.actions).toBe(20)
  })

  test('returns an empty plan for an empty or unrecognized session', () => {
    const empty = buildReplayPlan([])
    expect(empty).toEqual({
      actions: [],
      changed_files: [],
      commands: [],
      unresolved_errors: [],
      unfinished_turns: [],
      stats: { events: 0, actions: 0, changed_files: 0, commands: 0, errors: 0 },
    })

    const unknown = buildReplayPlan([
      { type: 'future/unknown', data: { payload: true } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'nothing to replay' }] } },
    ])
    expect(unknown.actions).toEqual([])
    expect(unknown.stats.events).toBe(2)
  })
})

describe('replay_plan tool', () => {
  test('reads a session and returns the machine-readable plan', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            expect(id).toBe(SESSION_ID)
            return mixedEvents()
          },
        },
      },
    })
    applyReplayPlan(fake.ctx, {})

    const tool = replayTool(fake.tools)
    const result = await tool.execute({ session_id: SESSION_ID }, exec())

    expect(result.changed_files).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
    ])
    expect(result.unresolved_errors).toHaveLength(1)
    expect((result.unresolved_errors as string[])[0]).toContain('EACCES: permission denied')
    expect((result.stats as Record<string, number>).events).toBe(18)

    const rendered = tool.output.render({}, result)
    expect(rendered).toHaveLength(1)
    expect(JSON.parse(rendered[0]!.text)).toEqual(result)
  })

  test('uses the current agent session and the snapshot-shaped response', async () => {
    const requested: string[] = []
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            requested.push(id)
            return {
              session: { id },
              events: [
                {
                  type: 'tool/call',
                  data: { callId: 'b1', name: 'bash', arguments: { command: 'cargo check' } },
                },
              ],
            }
          },
        },
      },
    })
    applyReplayPlan(fake.ctx, {})

    const result = await replayTool(fake.tools).execute(
      {},
      exec({ agent: { session: { id: 'agent-session' } } }),
    )

    expect(requested).toEqual(['agent-session'])
    expect(result.commands).toEqual(['cargo check'])
    expect((result.actions as Array<Record<string, unknown>>)[0]).toEqual({
      kind: 'verify',
      target: 'cargo check',
      reason: 'verification command; run it again after the planned edits',
    })
  })

  test('reports a missing sessionQuery service before checking the session id', async () => {
    const fake = fakeContext()
    applyReplayPlan(fake.ctx, {})

    await expect(replayTool(fake.tools).execute({ session_id: SESSION_ID }, exec()))
      .rejects.toThrow(/sessionQuery/)
  })

  test('reports a missing session id', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: { async readSession() { return [] } },
      },
    })
    applyReplayPlan(fake.ctx, {})

    await expect(replayTool(fake.tools).execute({}, exec()))
      .rejects.toThrow(/session id/)
  })

  test('returns an empty plan for an empty session', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: { async readSession() { return { events: [] } } },
      },
    })
    applyReplayPlan(fake.ctx, {})

    const result = await replayTool(fake.tools).execute({ session_id: SESSION_ID }, exec())
    expect(result).toEqual({
      actions: [],
      changed_files: [],
      commands: [],
      unresolved_errors: [],
      unfinished_turns: [],
      stats: { events: 0, actions: 0, changed_files: 0, commands: 0, errors: 0 },
    })
  })

  test('propagates read failures and can be disabled', async () => {
    const fake = fakeContext({
      services: {
        sessionQuery: {
          async readSession(id: string) {
            throw new Error(`session not found: ${id}`)
          },
        },
      },
    })
    applyReplayPlan(fake.ctx, {})
    await expect(replayTool(fake.tools).execute({ session_id: 'missing' }, exec()))
      .rejects.toThrow(/could not read session "missing"/)

    const disabled = fakeContext()
    applyReplayPlan(disabled.ctx, { replayPlan: false })
    expect(disabled.tools.has('replay_plan')).toBe(false)
  })
})
