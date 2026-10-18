/**
 * Experiment 5 — effects ledger scaling.
 *
 * Baseline: the original implementation re-read and re-folded the entire
 * session JSONL on every tool call, making N recorded calls O(N²) in bytes
 * parsed. Treatment: load the session ledger once, keep the folded state in
 * memory, and update it synchronously after each append.
 *
 * This bench records 10,000 pre-execute + result pairs (20,000 append records)
 * for one session and reports total and per-call latency. The run fails with
 * exit code 1 if the total exceeds 10 seconds.
 *
 * Run: bun experiments/effects-bench.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEffects } from '../src/features/effects.ts'
import { execWithAgent, fakeContext } from '../tests/fake-context.ts'

const CALLS = 10_000
const THRESHOLD_MS = 10_000

function agentFor(id: string) {
  return { session: { id }, followup() {} }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-effects-bench-'))
  const fake = fakeContext()
  applyEffects(fake.ctx, { effects: { dir } })
  const agent = agentFor('effects-bench-session')
  const next = async () => ({ kind: 'enter' })

  const started = performance.now()
  for (let index = 0; index < CALLS; index++) {
    const call = execWithAgent(agent, {
      callId: `bench-${index}`,
      name: 'write',
      arguments: { file_path: `src/file-${index}.ts`, content: `content-${index}` },
    })
    await fake.emit('tools/pre-execute', call, next)
    await fake.emit('tools/result', call, { isError: false })
  }
  const totalMs = performance.now() - started
  const perCallMs = totalMs / CALLS

  const status = await fake.tools.get('effect_status')!.execute(
    {},
    execWithAgent(agent, { callId: 'bench-status', name: 'effect_status', arguments: {} }),
  ) as { counts: Record<string, number>; unresolved: unknown[] }

  const ledgerFile = join(dir, 'effects-bench-session.jsonl')
  const ledgerBytes = statSync(ledgerFile).size
  const ledgerRecords = readFileSync(ledgerFile, 'utf8').trim().split('\n').length
  const passed = totalMs <= THRESHOLD_MS
    && status.counts.committed === CALLS
    && status.counts.total === CALLS
    && status.unresolved.length === 0

  const result = {
    experiment: 'effects-bench',
    generatedAt: new Date().toISOString(),
    hypothesis: 'Loading each session ledger once and folding it in memory makes N recorded tool calls O(N) instead of O(N^2); 10,000 calls should finish well under 10 seconds.',
    calls: CALLS,
    records: ledgerRecords,
    ledgerBytes,
    totalMs: Math.round(totalMs * 100) / 100,
    perCallMs: Math.round(perCallMs * 1000) / 1000,
    thresholdMs: THRESHOLD_MS,
    committed: status.counts.committed,
    unresolved: status.unresolved.length,
    passed,
  }

  const resultsDir = join(import.meta.dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'effects-bench.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log('Effects ledger scaling benchmark')
  console.log(`calls                ${CALLS}`)
  console.log(`ledger records       ${ledgerRecords} (${ledgerBytes} bytes)`)
  console.log(`total pre+result     ${result.totalMs.toFixed(2)} ms`)
  console.log(`per call             ${result.perCallMs.toFixed(3)} ms`)
  console.log(`committed            ${status.counts.committed}`)
  console.log(`unresolved           ${status.unresolved.length}`)
  console.log(`threshold            ${THRESHOLD_MS} ms`)
  console.log(`wrote ${join(resultsDir, 'effects-bench.json')}`)

  if (!passed) {
    console.error(`FAILED: expected <= ${THRESHOLD_MS} ms for ${CALLS} calls and a consistent ledger`)
    process.exitCode = 1
  }
}

await main()
