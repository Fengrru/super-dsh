/**
 * Repo-map performance probe: cold build, TTL-cached warm queries, and forced
 * rescans on a real checkout (sibling deepseek-harness by default).
 *
 * Run: bun experiments/repo-map-perf.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { applyRepoMap } from '../src/features/repo-map.ts'
import { fakeContext, exec } from '../tests/fake-context.ts'

const root = resolve(process.env.DSH_HARNESS_ROOT ?? join(import.meta.dir, '..', '..', 'deepseek-harness'))
if (!existsSync(root)) {
  console.error(`repo-map-perf: checkout not found at ${root}`)
  process.exit(2)
}

const MAX_FILES = 2000
const COLD_LIMIT_MS = 5000
const WARM_LIMIT_MS = 100

async function measure(): Promise<void> {
  const fake = fakeContext({ workingDirectory: root })
  applyRepoMap(fake.ctx, { repoMap: { root, maxFiles: MAX_FILES, refreshMs: 5000 } })
  const tool = fake.tools.get('repo_map')!

  const coldStart = performance.now()
  const coldResult = await tool.execute({ limit: 10 }, exec())
  const coldMs = performance.now() - coldStart

  const warm: number[] = []
  for (let index = 0; index < 3; index++) {
    const started = performance.now()
    await tool.execute({ limit: 10 }, exec())
    warm.push(performance.now() - started)
  }

  const forced = fakeContext({ workingDirectory: root })
  applyRepoMap(forced.ctx, { repoMap: { root, maxFiles: MAX_FILES, refreshMs: 0 } })
  const forcedTool = forced.tools.get('repo_map')!
  const forcedMs: number[] = []
  for (let index = 0; index < 3; index++) {
    const started = performance.now()
    await forcedTool.execute({ limit: 10 }, exec())
    forcedMs.push(performance.now() - started)
  }

  const p50 = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  const round = (value: number): number => Math.round(value * 10) / 10

  const result = {
    experiment: 'repo-map-perf',
    generatedAt: new Date().toISOString(),
    root,
    maxFiles: MAX_FILES,
    files: coldResult.files,
    returnedSymbols: coldResult.count,
    coldMs: round(coldMs),
    warmMs: { p50: round(p50(warm)), max: round(Math.max(...warm)) },
    forcedScanMs: { p50: round(p50(forcedMs)), max: round(Math.max(...forcedMs)) },
    thresholds: { coldMs: COLD_LIMIT_MS, warmP50Ms: WARM_LIMIT_MS },
    passed: coldMs < COLD_LIMIT_MS && p50(warm) < WARM_LIMIT_MS,
  }
  const resultsDir = join(import.meta.dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'repo-map-perf.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log(`files ${result.files}, returned symbols ${result.returnedSymbols}`)
  console.log(`cold ${result.coldMs}ms (limit ${COLD_LIMIT_MS}ms)`)
  console.log(`warm p50 ${result.warmMs.p50}ms, max ${result.warmMs.max}ms (limit ${WARM_LIMIT_MS}ms)`)
  console.log(`forced p50 ${result.forcedScanMs.p50}ms, max ${result.forcedScanMs.max}ms`)
  console.log(`passed ${result.passed}`)
  if (!result.passed) process.exitCode = 1
}

await measure()
