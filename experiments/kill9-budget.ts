/**
 * Budget restart gap: budget accounting is in-memory. This experiment records
 * the limitation explicitly instead of claiming recovery: a new process starts
 * with used=0 after a child accumulated usage.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '..')
const src = pathToFileURL(join(root, 'src', 'features', 'budget.ts')).href
const tests = pathToFileURL(join(root, 'tests', 'fake-context.ts')).href
const temp = mkdtempSync(join(tmpdir(), 'super-dsh-kill9-budget-'))
const childPath = join(temp, 'child.ts')
writeFileSync(childPath, `
import { applyBudget } from ${JSON.stringify(src)}
import { fakeContext, exec } from ${JSON.stringify(tests)}
const [mode] = process.argv.slice(2)
const fake = fakeContext()
applyBudget(fake.ctx, { budget: { maxTokens: 1000 } })
const session = { id: 'budget-session' }
if (mode === 'use') {
  await fake.emit('session/event', session, {
    seq: 0,
    type: 'assistant/message',
    data: { usage: { inputTokens: 500, outputTokens: 400 } },
  })
}
const status = await fake.tools.get('budget_status').execute({ session_id: 'budget-session' }, exec())
console.log(JSON.stringify(status))
`, 'utf8')

async function run(mode: string): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([process.execPath, childPath, mode], {
    env: { ...process.env, DSH_HOME: join(temp, 'dsh-home') },
    cwd: temp,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(proc.stdout).text()
  await proc.exited
  return JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}') as Record<string, unknown>
}

const used = await run('use')
const restarted = await run('check')
const result = {
  experiment: 'kill9-budget',
  generatedAt: new Date().toISOString(),
  durable: false,
  beforeRestartUsed: Number(used.used_tokens ?? 0),
  afterRestartUsed: Number(restarted.used_tokens ?? 0),
  note: 'budget state is in-memory; restart loses usage by design',
  ok: Number(used.used_tokens ?? 0) > 0 && Number(restarted.used_tokens ?? 0) === 0,
}
const resultsDir = join(import.meta.dir, 'results')
mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'kill9-budget.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(`used_before=${result.beforeRestartUsed} used_after_restart=${result.afterRestartUsed} durable=${result.durable}`)
rmSync(temp, { recursive: true, force: true })
if (!result.ok) process.exitCode = 1
