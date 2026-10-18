/**
 * Seed one memory fact for the memory-tier A/B.
 *
 * Usage: DSH_HOME=... bun tests/fixtures/seed-memory.ts <workspace> <core|long> <text>
 */

import { join } from 'node:path'
import { applyMemory } from '../../src/features/memory.ts'
import { exec, fakeContext } from '../fake-context.ts'

const [workspace, tier, text] = process.argv.slice(2)
if (workspace === undefined || (tier !== 'core' && tier !== 'long') || text === undefined) {
  throw new Error('usage: seed-memory.ts <workspace> <core|long> <text>')
}
const fake = fakeContext({ workingDirectory: workspace })
applyMemory(fake.ctx, { memory: { dir: join(process.env.DSH_HOME ?? '', 'super-dsh', 'memory') } })
const save = fake.tools.get('memory_save')!
const result = await save.execute({ text, tier, importance: 0.95 }, exec())
if (result === undefined) throw new Error('memory_save returned no result')
