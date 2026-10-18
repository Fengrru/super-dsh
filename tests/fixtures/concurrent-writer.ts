/**
 * Child process for the cross-process store tests. Each invocation applies one
 * feature against a shared directory and performs N tool calls; the parent
 * starts two of these at once to prove that advisory locks serialize writes.
 *
 * Usage: bun tests/fixtures/concurrent-writer.ts <memory|repairs|knowledge> <root> <count> <prefix>
 */

import { join } from 'node:path'
import { applyKnowledge } from '../../src/features/knowledge.ts'
import { applyMemory } from '../../src/features/memory.ts'
import { applyRepairs } from '../../src/features/repairs.ts'
import { exec, fakeContext } from '../fake-context.ts'

const [mode, root, rawCount, prefix] = process.argv.slice(2)
const count = Number(rawCount)
if (!['memory', 'repairs', 'knowledge'].includes(mode) || Number.isNaN(count)) {
  throw new Error(`invalid arguments: ${process.argv.slice(2).join(' ')}`)
}

const fake = fakeContext({ workingDirectory: root })

if (mode === 'memory') {
  applyMemory(fake.ctx, { memory: { dir: join(root, 'memory'), maxEntries: 10_000 } })
  const save = fake.tools.get('memory_save')!
  for (let index = 0; index < count; index++) {
    await save.execute({
      text: `${prefix} keeps concurrency fact number ${index}`,
      tags: ['concurrency'],
    }, exec())
  }
} else if (mode === 'repairs') {
  applyRepairs(fake.ctx, { repairs: { dir: join(root, 'repairs'), maxEntries: 10_000 } })
  const record = fake.tools.get('repair_record')!
  for (let index = 0; index < count; index++) {
    await record.execute({
      tool: 'read',
      error_message: 'ENOENT: no such file or directory, open src/missing.ts',
      error_code: 'ENOENT',
      hint: 'Create the file first or switch to the correct path before reading.',
    }, exec())
  }
} else {
  applyKnowledge(fake.ctx, { knowledge: { dir: join(root, 'knowledge') } })
  const add = fake.tools.get('knowledge_add')!
  for (let index = 0; index < count; index++) {
    await add.execute({
      key: 'concurrent-key',
      content: `${prefix} knowledge content ${index}`,
      trust: 'verified',
    }, exec())
  }
}
