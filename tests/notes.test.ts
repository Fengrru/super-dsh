/**
 * Deterministic checks for the session scratchpad: storage, tolerant reads,
 * tag filtering, path containment, and real compaction.
 */

import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { applyNotes } from '../src/features/notes.ts'
import { execWithAgent, fakeContext } from './fake-context.ts'

function agent(sessionId: string) {
  return { session: { id: sessionId }, followup() {} }
}

function scratchpad(dir: string) {
  const fake = fakeContext()
  applyNotes(fake.ctx, { notes: { dir } })
  return {
    append: fake.tools.get('note_append')!,
    read: fake.tools.get('note_read')!,
    compact: fake.tools.get('note_compact')!,
  }
}

describe('session notes', () => {
  test('appends trimmed notes and reads them chronologically with tags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const tools = scratchpad(dir)
    const session = agent('session-a')

    const first = await tools.append.execute({ content: '  first discovery  ' }, execWithAgent(session))
    expect(first.count).toBe(1)
    expect(existsSync(String(first.path))).toBe(true)
    expect(String(first.path).endsWith('session-a.jsonl')).toBe(true)

    await tools.append.execute({ content: 'chose the simpler design', tag: 'decision' }, execWithAgent(session))
    const read = await tools.read.execute({}, execWithAgent(session))
    const notes = read.notes as Array<{ at: number; content: string; tag: string }>

    expect(read.count).toBe(2)
    expect(read.skipped).toBe(0)
    expect(notes.map(note => note.content)).toEqual(['first discovery', 'chose the simpler design'])
    expect(notes.map(note => note.tag)).toEqual(['general', 'decision'])
    expect(notes[0].at).toBeLessThanOrEqual(notes[1].at)
  })

  test('filters by tag and isolates malformed lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const tools = scratchpad(dir)
    const session = agent('session-b')

    const first = await tools.append.execute({ content: 'ran the tests', tag: 'work' }, execWithAgent(session))
    await tools.append.execute({ content: 'a personal note', tag: 'personal' }, execWithAgent(session))
    await tools.append.execute({ content: 'another work item', tag: 'Work' }, execWithAgent(session))

    appendFileSync(String(first.path), 'this is not json\n{"v":1,"at":1}\n', 'utf8')

    const all = await tools.read.execute({}, execWithAgent(session))
    expect(all.count).toBe(3)
    expect(all.skipped).toBe(2)

    const work = await tools.read.execute({ tag: 'WORK' }, execWithAgent(session))
    const notes = work.notes as Array<{ content: string }>
    expect(work.count).toBe(2)
    expect(work.skipped).toBe(2)
    expect(notes.map(note => note.content)).toEqual(['ran the tests', 'another work item'])
  })

  test('caps note content at 8000 characters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const tools = scratchpad(dir)
    const session = agent('session-long')

    await tools.append.execute({ content: 'x'.repeat(9000) }, execWithAgent(session))
    const read = await tools.read.execute({}, execWithAgent(session))
    const notes = read.notes as Array<{ content: string }>
    expect(notes[0].content.length).toBe(8000)
  })

  test('rejects empty content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const tools = scratchpad(dir)
    await expect(tools.append.execute({ content: '   ' }, execWithAgent(agent('session-empty'))))
      .rejects.toThrow(/non-empty/)
  })

  test('keeps a hostile session id inside the notes directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const tools = scratchpad(dir)
    const hostile = '../../escape/../outside'

    const result = await tools.append.execute({ content: 'contained' }, execWithAgent(agent(hostile)))
    const file = resolve(String(result.path))
    const base = resolve(dir)

    expect(file.startsWith(base + sep)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(dir, '..', 'outside.jsonl'))).toBe(false)
    expect(readdirSync(base).some(name => name.endsWith('.jsonl'))).toBe(true)
  })

  test('compacts atomically to the most recent notes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const tools = scratchpad(dir)
    const session = agent('session-compact')

    let path = ''
    for (let index = 1; index <= 6; index++) {
      const result = await tools.append.execute({ content: `note-${index}` }, execWithAgent(session))
      path = String(result.path)
    }

    const compacted = await tools.compact.execute({ keep: 2 }, execWithAgent(session))
    expect(compacted).toEqual({ before: 6, after: 2 })

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map(line => JSON.parse(line).content)).toEqual(['note-5', 'note-6'])
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false)

    const read = await tools.read.execute({}, execWithAgent(session))
    expect((read.notes as Array<{ content: string }>).map(note => note.content)).toEqual(['note-5', 'note-6'])
  })

  test('enforces maxEntriesPerSession after an append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-notes-'))
    const fake = fakeContext()
    applyNotes(fake.ctx, { notes: { dir, maxEntriesPerSession: 2 } })
    const append = fake.tools.get('note_append')!
    const session = agent('session-cap')

    await append.execute({ content: 'one' }, execWithAgent(session))
    await append.execute({ content: 'two' }, execWithAgent(session))
    const third = await append.execute({ content: 'three' }, execWithAgent(session))
    expect(third.count).toBe(2)

    const read = await fake.tools.get('note_read')!.execute({}, execWithAgent(session))
    expect((read.notes as Array<{ content: string }>).map(note => note.content)).toEqual(['two', 'three'])
  })
})
