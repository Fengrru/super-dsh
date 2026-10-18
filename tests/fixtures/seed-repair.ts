/**
 * Seed a repair hint into an isolated DSH_HOME for the repairs A/B.
 *
 * Usage: DSH_HOME=... bun tests/fixtures/seed-repair.ts <workspace> <spec.json>
 * The spec is { message, hint, tools?: string[] }.
 */

import { readFileSync } from 'node:fs'
import { applyRepairs } from '../../src/features/repairs.ts'
import { exec, fakeContext } from '../fake-context.ts'

const [workspace, specPath] = process.argv.slice(2)
if (workspace === undefined || specPath === undefined) {
  throw new Error('usage: seed-repair.ts <workspace> <spec.json>')
}
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  message?: unknown
  hint?: unknown
  tools?: unknown
}
if (typeof spec.message !== 'string' || typeof spec.hint !== 'string') {
  throw new Error('spec requires string message and hint')
}
const tools = Array.isArray(spec.tools)
  ? spec.tools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0)
  : ['pwsh', 'bash']

const fake = fakeContext({ workingDirectory: workspace })
applyRepairs(fake.ctx, { repairs: true })
const record = fake.tools.get('repair_record')!
for (const tool of tools) {
  await record.execute({
    tool,
    error_message: spec.message,
    hint: spec.hint,
  }, exec())
}
