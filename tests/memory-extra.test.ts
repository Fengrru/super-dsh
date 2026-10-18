import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMemory } from '../src/features/memory.ts'
import { exec, fakeContext } from './fake-context.ts'

describe('memory TTL and project-memory interchange', () => {
  test('hides expired entries from retrieval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-ttl-'))
    const fake = fakeContext()
    applyMemory(fake.ctx, { memory: { dir } })

    await fake.tools.get('memory_save')!.execute({
      text: 'The ephemeral token is xyzzy.',
      tags: ['ephemeral'],
      ttl_days: 0.000001,
    }, exec())
    await new Promise(resolve => setTimeout(resolve, 150))

    const result = await fake.tools.get('memory_search')!.execute({ query: 'ephemeral xyzzy' }, exec())
    expect(result.count).toBe(0)
  })

  test('exports Markdown and imports it into a fresh store', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-src-'))
    const targetDir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-dst-'))
    const source = fakeContext()
    applyMemory(source.ctx, { memory: { dir: sourceDir } })
    await source.tools.get('memory_save')!.execute({
      text: 'The project test command is bun test --coverage.',
      tags: ['testing'],
    }, exec())
    await source.tools.get('memory_save')!.execute({
      text: 'API responses use snake_case field names.',
      tags: ['api', 'convention'],
    }, exec())

    const exported = await source.tools.get('memory_export')!.execute({ format: 'md' }, exec())
    expect(exported.format).toBe('md')
    expect(String(exported.content)).toContain('## testing')
    expect(String(exported.content)).toContain('## api, convention')

    const target = fakeContext()
    applyMemory(target.ctx, { memory: { dir: targetDir } })
    const imported = await target.tools.get('memory_import')!.execute({ content: exported.content }, exec())
    expect(imported.imported).toBe(2)
    expect(imported.count).toBe(2)

    const found = await target.tools.get('memory_search')!.execute({ query: 'snake_case naming' }, exec())
    expect(found.count).toBeGreaterThan(0)
    expect(JSON.stringify(found)).toContain('snake_case')
  })
})
