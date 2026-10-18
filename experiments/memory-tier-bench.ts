/**
 * Memory-tier A/B: does `core` tier priority change behavior compared with the
 * same fact stored as `long`?
 *
 * Both arms use memory v2 and the same tool surface. Session 1 is replaced by a
 * deterministic seed via the memory tool:
 *   - treatment: fact stored as `core` (always injected)
 *   - baseline:  fact stored as `long` (retrieved only when relevant)
 *
 * The task requires the seeded naming convention. This isolates the one v2
 * behavior that changes the context sent to the model; it is not a re-test of
 * basic cross-session memory (E2).
 *
 * Run: bun run experiment:memory-tier
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = import.meta.dir
const DSH_ROOT = resolve(HERE, '..', '..', 'deepseek-harness')
const PLUGIN = resolve(HERE, '..', 'dist', 'index.js')
const TSX = resolve(DSH_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const BIN = resolve(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = resolve(DSH_ROOT, 'tsconfig.base.json')
const SEED = resolve(HERE, '..', 'tests', 'fixtures', 'seed-memory.ts')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNS = resolve(HERE, 'runs', `memory-tier-${STAMP}`)
const RESULTS = resolve(HERE, 'results')
const TIMEOUT = 300_000
const CONCURRENCY = 2
const REPETITIONS = Math.max(1, Number(process.env.SUPER_DSH_MEMORY_TIER_REPS ?? 8) || 8)
const FACT = 'Identifiers in serialized payloads use lower_snake_case.'
const PROMPT = 'Create src/user.js. It must export a function makeUser that returns an object with the user\'s id and display name. Write the file directly; do not read files or run commands.'

type Arm = 'long' | 'core'

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
  arm: Arm
  rep: number
  passed: boolean
  fileExists: boolean
  fileText: string
}

function writePatch(arm: Arm): string {
  const path = join(RUNS, `memory-tier-${arm}.patch.yml`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    '- insert:',
    '    - id: super-dsh',
    `      name: '${PLUGIN.replace(/\\/g, '/')}'`,
    '      config:',
    '        profile: core',
    '        fuzzyEdit: false',
    '        applyPatch: false',
    '        audit: false',
    '        effects: false',
    '        artifacts: false',
    '        memory: true',
    '- id: session-title-llm',
    '  disabled: true',
    '',
  ].join('\n'), 'utf8')
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

function seedMemory(workspace: string, home: string, arm: Arm): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SEED, workspace, arm, FACT], {
      env: { ...process.env, DSH_HOME: home, SUPER_DSH_WORKSPACE: workspace },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`seed exited ${String(code)}: ${stderr}`))
    })
  })
}

async function runTrial(arm: Arm, rep: number): Promise<Trial> {
  const root = join(RUNS, arm, `rep-${rep}`)
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(workspace, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8')
  await seedMemory(workspace, home, arm)
  const session = await runDsh(PROMPT, workspace, home, writePatch(arm))
  let fileText = ''
  try {
    fileText = readFileSync(join(workspace, 'src', 'user.js'), 'utf8')
  } catch {
    // Missing file is a failed trial.
  }
  // The seeded rule is about snake_case field names. A single-word `id` is
  // already lowercase; `user_id` is also accepted.
  const hasKeys = (/\buser_id\s*:/.test(fileText) || /\bid\s*:/.test(fileText))
    && /\bdisplay_name\s*:/.test(fileText)
  const hasCamel = /\buserId\s*:|\bdisplayName\s*:/.test(fileText)
  return {
    ...session,
    arm,
    rep,
    passed: hasKeys && !hasCamel,
    fileExists: fileText.length > 0,
    fileText: fileText.slice(0, 2000),
  }
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
console.log(`Running ${REPETITIONS * 2} memory-tier trials, concurrency ${CONCURRENCY}…`)

const jobs = Array.from({ length: REPETITIONS }, (_, index) => index + 1)
const trials = await pool(
  jobs.flatMap(rep => (['long', 'core'] as const).map(arm => ({ arm, rep }))),
  CONCURRENCY,
  async job => {
    const trial = await runTrial(job.arm, job.rep)
    console.log(`  ${trial.arm} rep-${trial.rep}: ${trial.passed ? 'PASS' : 'FAIL'} `
      + `(in=${trial.inputTokens} out=${trial.outputTokens} tools=${trial.toolCalls.join(',') || 'none'})`)
    return trial
  },
)

const longTrials = trials.filter(trial => trial.arm === 'long')
const coreTrials = trials.filter(trial => trial.arm === 'core')
const sum = (items: Trial[], field: 'inputTokens' | 'outputTokens'): number =>
  items.reduce((total, item) => total + item[field], 0)
const longPasses = longTrials.filter(trial => trial.passed).length
const corePasses = coreTrials.filter(trial => trial.passed).length
const longInputs = sum(longTrials, 'inputTokens')
const tokenChange = longInputs === 0
  ? 0
  : (sum(coreTrials, 'inputTokens') - longInputs) / longInputs
const passWins = corePasses - longPasses
const supportsCoreTier = passWins >= 2 || (passWins >= 0 && tokenChange <= -0.15)

const doc = {
  experiment: 'memory-tier-ab',
  generatedAt: new Date().toISOString(),
  model: 'deepseek-flash',
  dsh: '0.2.1-rc.2 (source checkout)',
  fact: FACT,
  repetitions: REPETITIONS,
  decisionRule: 'core tier is supported if it wins >=2 trials or uses >=15% fewer input tokens without losing trials',
  summary: {
    longPasses,
    corePasses,
    total: REPETITIONS,
    longInputTokens: sum(longTrials, 'inputTokens'),
    coreInputTokens: sum(coreTrials, 'inputTokens'),
    tokenChange: Math.round(tokenChange * 10_000) / 10_000,
    passWins,
    supportsCoreTier,
  },
  trials,
}
writeFileSync(join(RESULTS, 'memory-tier-ab-bench.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log('\nSummary')
console.log(`passes: long ${longPasses}/${REPETITIONS}, core ${corePasses}/${REPETITIONS}`)
console.log(`input tokens: long ${sum(longTrials, 'inputTokens')}, core ${sum(coreTrials, 'inputTokens')}`)
console.log(`decision: ${supportsCoreTier ? 'core tier has evidence' : 'no evidence for core tier priority'}`)
