/**
 * Search-code agent A/B: does enabling the repo-map/search_code surface improve
 * navigation on a real source tree, or is grep/read sufficient?
 *
 * Baseline: core profile (no repo map).
 * Treatment: core profile + repoMap/search_code.
 * Both arms use the same model, workspace snapshot, and prompt.
 *
 * Run: bun run experiment:search-ab
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = import.meta.dir
const ROOT = resolve(HERE, '..')
const DSH_ROOT = resolve(HERE, '..', '..', 'deepseek-harness')
const PLUGIN = resolve(ROOT, 'dist', 'index.js')
const TSX = resolve(DSH_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const BIN = resolve(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = resolve(DSH_ROOT, 'tsconfig.base.json')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNS = resolve(HERE, 'runs', `search-code-ab-${STAMP}`)
const RESULTS = resolve(HERE, 'results')
const TIMEOUT = 300_000
const CONCURRENCY = 2

interface Task {
  id: string
  prompt: string
  expected: string[]
}

interface RunResult {
  final: string
  reason: string
  inputTokens: number
  outputTokens: number
  toolCalls: string[]
  wallMs: number
  exitCode: number | null
  timedOut: boolean
}

interface Trial extends RunResult {
  task: string
  arm: 'baseline' | 'treatment'
  passed: boolean
}

const tasks: Task[] = [
  {
    id: 'withFileLock-definition',
    prompt: 'In this source tree, which file defines the exported function `withFileLock`? Answer with the file path only.',
    expected: ['src/file-locks.ts'],
  },
  {
    id: 'repair-normalizer',
    prompt: 'Which file defines `normalizeRepairMessage`? Answer with the file path only.',
    expected: ['src/features/repairs.ts'],
  },
  {
    id: 'memory-store',
    prompt: 'Which file defines the `MemoryStore` class? Answer with the file path only.',
    expected: ['src/features/memory.ts'],
  },
  {
    id: 'artifact-reindex',
    prompt: 'Which file implements the `artifact_reindex` tool? Answer with the file path only.',
    expected: ['src/features/artifacts.ts'],
  },
  {
    id: 'withFileLock-callers',
    prompt: 'Which files call `withFileLock`? Answer with all caller file paths, one per line.',
    expected: ['src/features/memory.ts', 'src/features/knowledge.ts', 'src/features/repairs.ts'],
  },
  {
    id: 'budget-ledger',
    prompt: 'Which file defines the `BudgetLedger` class? Answer with the file path only.',
    expected: ['src/budget-ledger.ts'],
  },
  {
    id: 'search-code-impl',
    prompt: 'Which file implements the `search_code` tool? Answer with the file path only.',
    expected: ['src/features/repo-map.ts'],
  },
  {
    id: 'history-compact-impl',
    prompt: 'Which file implements the `history_compact` tool? Answer with the file path only.',
    expected: ['src/features/history-compact.ts'],
  },
]

function writePatch(arm: 'baseline' | 'treatment'): string {
  const path = join(RUNS, `${arm}.patch.yml`)
  mkdirSync(dirname(path), { recursive: true })
  const lines = [
    '- insert:',
    '    - id: super-dsh',
    `      name: '${PLUGIN.replace(/\\/g, '/')}'`,
    '      config:',
    '        profile: core',
    '        fuzzyEdit: false',
    '        applyPatch: false',
    '        memory: false',
    '        audit: false',
    '        effects: false',
    '        artifacts: false',
  ]
  if (arm === 'treatment') {
    lines.push('        repoMap: true')
  }
  lines.push('- id: session-title-llm', '  disabled: true', '')
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

function runDsh(prompt: string, workspace: string, home: string, patch: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const args = [TSX, '--tsconfig', TSCONFIG, BIN, '--profile', 'headless', '--patch', patch, '--json', prompt]
    const child = spawn(process.env.DSH_NODE ?? 'node', args, {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HARNESS_ROOT: DSH_ROOT,
        DSH_HOME: home,
        DSH_PERMISSION_MODE: 'danger-full-access',
        SUPER_DSH_WORKSPACE: workspace,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
      }
    }, TIMEOUT)
    child.on('close', (code) => {
      clearTimeout(timer)
      let final = ''
      let reason = 'missing'
      let inputTokens = 0
      let outputTokens = 0
      const toolCalls: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const event = JSON.parse(trimmed) as Record<string, any>
          if (event.type === 'final') final = String(event.text ?? '')
          if (event.type === 'status' && event.phase === 'turn_end') reason = String(event.reason?.kind ?? 'unknown')
          if (event.type === 'status' && event.phase === 'step_end') {
            inputTokens += Number(event.usage?.inputTokens ?? 0)
            outputTokens += Number(event.usage?.outputTokens ?? 0)
          }
          if (event.type === 'tool_call') toolCalls.push(String(event.tool))
        } catch {
          // Diagnostics interleave; ignore malformed lines.
        }
      }
      void stderr
      resolvePromise({ final, reason, inputTokens, outputTokens, toolCalls, wallMs: Date.now() - started, exitCode: code, timedOut })
    })
  })
}

async function runTrial(task: Task, arm: 'baseline' | 'treatment'): Promise<Trial> {
  const root = join(RUNS, task.id, arm)
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home, { recursive: true })
  cpSync(join(ROOT, 'src'), join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8')
  const session = await runDsh(task.prompt, workspace, home, writePatch(arm))
  const normalized = session.final.replace(/\\/g, '/')
  const passed = task.expected.every(path => normalized.includes(path))
  return { ...session, task: task.id, arm, passed }
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

mkdirSync(RUNS, { recursive: true })
mkdirSync(RESULTS, { recursive: true })
console.log(`DSH root: ${DSH_ROOT}`)
console.log(`Plugin:   ${PLUGIN}`)
console.log(`Runs:     ${RUNS}`)
console.log(`Running ${tasks.length * 2} search-code trials, concurrency ${CONCURRENCY}…`)

const jobs = tasks.flatMap(task => ([
  { task, arm: 'baseline' as const },
  { task, arm: 'treatment' as const },
]))
const trials = await pool(jobs, CONCURRENCY, async job => {
  const trial = await runTrial(job.task, job.arm)
  console.log(`  ${trial.arm} ${trial.task}: ${trial.passed ? 'PASS' : 'FAIL'} `
    + `(in=${trial.inputTokens} out=${trial.outputTokens} tools=${trial.toolCalls.join(',') || 'none'})`)
  return trial
})

const baseline = trials.filter(trial => trial.arm === 'baseline')
const treatment = trials.filter(trial => trial.arm === 'treatment')
const sum = (items: Trial[], field: 'inputTokens' | 'outputTokens'): number =>
  items.reduce((total, item) => total + item[field], 0)
const baselinePasses = baseline.filter(trial => trial.passed).length
const treatmentPasses = treatment.filter(trial => trial.passed).length
const baselineInputs = sum(baseline, 'inputTokens')
const tokenChange = baselineInputs === 0 ? 0 : (sum(treatment, 'inputTokens') - baselineInputs) / baselineInputs
const passWins = treatmentPasses - baselinePasses
const recommendCoding = passWins >= 2 || (passWins >= 0 && tokenChange <= -0.15)

const doc = {
  experiment: 'search-code-ab',
  generatedAt: new Date().toISOString(),
  model: 'deepseek-flash',
  dsh: '0.2.1-rc.2 (source checkout)',
  tasks: tasks.length,
  decisionRule: 'repo-map surface is supported if it wins >=2 tasks or uses >=15% fewer input tokens without losing tasks',
  summary: {
    baselinePasses,
    treatmentPasses,
    total: tasks.length,
    baselineInputTokens: baselineInputs,
    treatmentInputTokens: sum(treatment, 'inputTokens'),
    baselineOutputTokens: sum(baseline, 'outputTokens'),
    treatmentOutputTokens: sum(treatment, 'outputTokens'),
    tokenChange: Math.round(tokenChange * 10_000) / 10_000,
    passWins,
    recommendCoding,
  },
  trials,
}
writeFileSync(join(RESULTS, 'search-code-ab-bench.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log('\nSummary')
console.log(`passes: baseline ${baselinePasses}/${tasks.length}, treatment ${treatmentPasses}/${tasks.length}`)
console.log(`input tokens: baseline ${baselineInputs}, treatment ${sum(treatment, 'inputTokens')}`)
console.log(`decision: ${recommendCoding ? 'promote coding profile' : 'keep repo map opt-in'}`)
