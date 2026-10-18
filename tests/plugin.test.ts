/**
 * Integration checks for the plugin's runtime behavior with a fake Cordis
 * context. These are deterministic: no model calls, no network.
 *
 * Run: bun test
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFuzzyEdit } from '../src/features/fuzzy-edit.ts'
import { applyMemory } from '../src/features/memory.ts'
import { applyAudit } from '../src/features/audit.ts'
import { applyVerify } from '../src/features/verify.ts'
import { exec, fakeContext } from './fake-context.ts'

describe('fuzzy_edit', () => {
  test('applies a whitespace-drifted edit through ctx.fs with the exact matched text', async () => {
    let content = 'const config = {\n  port:   3000,\n  host: "localhost",\n}\n'
    let appliedOld = ''
    const fake = fakeContext({ fs: {
      readText: async () => content,
      editText: async (_target, edit) => {
        appliedOld = edit.oldString
        content = content.replace(edit.oldString, edit.newString)
        return { before: content, after: content, version: 2 }
      },
    } })
    fake.ctx.waterfall = async () => ({ version: 1 })
    applyFuzzyEdit(fake.ctx, {})
    const tool = fake.tools.get('fuzzy_edit')
    expect(tool).toBeDefined()

    const result = await tool!.execute({
      file_path: 'config.ts',
      old_string: '  port: 3000,\n  host: "localhost",',
      new_string: '  port: 8080,\n  host: "0.0.0.0",',
    }, exec())

    expect(appliedOld).toBe('  port:   3000,\n  host: "localhost",')
    expect(content).toContain('port: 8080')
    expect(result.strategy).toBe('whitespace_normalized')
  })

  test('refuses an ambiguous region', async () => {
    const content = 'if (ready) {\n  return 1\n}\n\nif (ready) {\n  return 1\n}\n'
    const fake = fakeContext({ fs: { readText: async () => content } })
    fake.ctx.waterfall = async () => ({ version: 1 })
    applyFuzzyEdit(fake.ctx, {})
    const tool = fake.tools.get('fuzzy_edit')!
    await expect(tool.execute({
      file_path: 'x.ts',
      old_string: 'if (ready) {\n  return 1\n}',
      new_string: 'if (ready) {\n  return 2\n}',
    }, exec())).rejects.toThrow(/more than one region|not unique/)
  })
})

describe('memory', () => {
  test('saves, retrieves, injects once per turn, and forgets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-'))
    const fake = fakeContext()
    applyMemory(fake.ctx, { memory: { dir, injectTopK: 3 } })

    const save = {
      text: 'The project test command is bun test --coverage.',
      tags: ['testing', 'convention'],
      importance: 0.9,
    }
    const saved = await fake.tools.get('memory_save')!.execute(save, exec())
    expect(saved.stored).toBe(true)

    const search = await fake.tools.get('memory_search')!.execute({ query: 'test command' }, exec())
    expect(search.count).toBeGreaterThan(0)
    expect(JSON.stringify(search)).toContain('bun test')

    const next = async () => ({ kind: 'enter', messages: [] as unknown[] })
    const agent = {}
    const [first] = await fake.emit('agent/pre-step', {
      agent,
      messages: [{ content: [{ type: 'text', text: 'What test command does this project use?' }] }],
      turn: 1,
      step: 1,
    }, next) as Array<{ messages: Array<{ content: Array<{ text: string }> }> }>
    expect(JSON.stringify(first)).toContain('bun test')

    const [second] = await fake.emit('agent/pre-step', {
      agent,
      messages: [{ content: [{ type: 'text', text: 'What test command does this project use?' }] }],
      turn: 1,
      step: 2,
    }, next) as Array<{ messages: Array<unknown> }>
    expect(second.messages).toHaveLength(0)

    const id = String(saved.id)
    const forgotten = await fake.tools.get('memory_forget')!.execute({ id }, exec())
    expect(forgotten).toEqual({ removed: true, count: 0 })
  })
})

describe('audit ledger', () => {
  test('detects record tampering, truncation, and preserves a valid chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir } })

    const session = { id: 'session-test-1' }
    for (let seq = 0; seq < 5; seq++) {
      await fake.emit('session/event', session, {
        seq,
        time: 1_700_000_000_000 + seq,
        type: seq === 2 ? 'tool/call' : 'turn/start',
        data: seq === 2 ? { name: 'edit', callId: 'c1' } : { turn: 1 },
      })
    }

    const verify = fake.tools.get('audit_verify')!
    const valid = await verify.execute({ session_id: 'session-test-1' }, exec())
    expect(valid.ok).toBe(true)
    expect((valid.ledgers as Array<{ records: number }>)[0].records).toBe(5)

    const file = join(dir, 'session-test-1-18a48146.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    const record = JSON.parse(lines[0])
    record.type = 'tampered'
    lines[0] = JSON.stringify(record)
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    const tampered = await verify.execute({ session_id: 'session-test-1' }, exec())
    expect(tampered.ok).toBe(false)
    expect(JSON.stringify(tampered)).toContain('hash mismatch')

    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    const original = readFileSync(file, 'utf8').trim().split('\n')
    writeFileSync(file, `${original.slice(0, -1).join('\n')}\n`, 'utf8')
    const truncated = await verify.execute({ session_id: 'session-test-1' }, exec())
    expect(truncated.ok).toBe(false)
  })

  test('finds an event data hash as evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-evidence-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir } })
    await fake.emit('session/event', { id: 'session-evidence-1' }, {
      seq: 0,
      time: 1_700_000_000_000,
      type: 'tool/call',
      data: { name: 'read', callId: 'c1' },
    })
    const file = readdirSync(dir).find(name => name.endsWith('.jsonl'))!
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8').trim())
    const evidence = await fake.tools.get('audit_evidence')!.execute({ data_hash: record.dataHash }, exec())
    expect(evidence.found).toBe(true)
    expect(evidence.type).toBe('tool/call')
    const missing = await fake.tools.get('audit_evidence')!.execute({ data_hash: '0'.repeat(64) }, exec())
    expect(missing.found).toBe(false)
  })
})

describe('verification gate', () => {
  test('steers the agent when the configured command fails', async () => {
    const fake = fakeContext()
    applyVerify(fake.ctx, { verify: { command: 'node -e "process.exit(1)"', maxAttempts: 1 } })
    const followups: unknown[] = []
    const agent = { followup: (message: unknown) => followups.push(message) }

    await fake.emit('tools/result', { name: 'edit', agent }, { isError: false })
    await fake.emit('agent/turn-stopping', { agent, turn: 1 })
    expect(followups).toHaveLength(1)
    expect(JSON.stringify(followups[0])).toContain('[super-dsh verify]')
  }, 20000)

  test('allows the turn when verification passes', async () => {
    const fake = fakeContext()
    applyVerify(fake.ctx, { verify: { command: 'node -e "process.exit(0)"', maxAttempts: 1 } })
    const followups: unknown[] = []
    const agent = { followup: (message: unknown) => followups.push(message) }

    await fake.emit('tools/result', { name: 'edit', agent }, { isError: false })
    await fake.emit('agent/turn-stopping', { agent, turn: 1 })
    expect(followups).toHaveLength(0)
  }, 20000)
})
