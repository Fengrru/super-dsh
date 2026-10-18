/**
 * Profile A/B: core (24 tools) vs coding (40 tools) on navigation and edit
 * tasks, using the real dsh headless CLI. This is the experiment required
 * before changing the default profile.
 *
 * Run: bun experiments/profile-ab-bench.ts
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = import.meta.dir
const DSH_ROOT = resolve(HERE, '..', '..', 'deepseek-harness')
const PLUGIN = resolve(HERE, '..', 'dist', 'index.js')
const TSX = resolve(DSH_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const BIN = resolve(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = resolve(DSH_ROOT, 'tsconfig.base.json')
const RUNS = resolve(HERE, 'runs', `profile-ab-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const RESULTS = resolve(HERE, 'results')
const TIMEOUT = 360_000
const CONCURRENCY = 2

type Arm = 'core' | 'coding'

interface Task {
  id: string
  kind: 'navigate' | 'edit'
  files: Record<string, string>
  prompt: string
  check: (workspace: string, final: string) => Promise<boolean> | boolean
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

const tasks: Task[] = [
  {
    id: 'config-callers',
    kind: 'navigate',
    files: {
      'src/config.ts': 'export function loadConfig() {\n  return { mode: "main" }\n}\n',
      'src/legacy/config.ts': 'export function loadConfig() {\n  return { mode: "legacy" }\n}\n',
      'src/server.ts': 'import { loadConfig } from "./config"\n\nexport function startServer() {\n  return loadConfig()\n}\n',
      'src/worker.ts': 'import { loadConfig } from "./config"\n\nexport function runWorker() {\n  return loadConfig()\n}\n',
      'src/notes.ts': '// loadConfig is mentioned here only in a comment\n',
    },
    prompt: 'In this repository, find the real loadConfig definitions and list every source file that calls loadConfig. Ignore comments and the definition files themselves. Answer with the caller file paths only.',
    check: (_workspace, final) => /src\/server\.ts/.test(final) && /src\/worker\.ts/.test(final),
  },
  {
    id: 'server-caller',
    kind: 'navigate',
    files: {
      'src/config.ts': 'export function loadConfig() { return { port: 3000 } }\n',
      'src/server.ts': 'import { loadConfig } from "./config"\n\nexport function startServer() {\n  return loadConfig()\n}\n',
      'src/other.ts': 'export function unrelated() { return 1 }\n',
    },
    prompt: 'In src/server.ts, which function calls loadConfig? Answer with the function name only.',
    check: (_workspace, final) => /startServer/.test(final),
  },
  {
    id: 'transitive-impact',
    kind: 'navigate',
    files: {
      'src/auth.ts': 'export function validateToken(token: string) {\n  return token.length > 0\n}\n',
      'src/login.ts': 'import { validateToken } from "./auth"\n\nexport function login(token: string) {\n  return validateToken(token)\n}\n',
      'src/api.ts': 'import { login } from "./login"\n\nexport function handle(token: string) {\n  return login(token)\n}\n',
      'src/unrelated.ts': 'export function ping() { return "pong" }\n',
    },
    prompt: 'Which files transitively reference validateToken (directly or through one caller)? List the referencing files. Ignore the definition file and comments.',
    check: (_workspace, final) => /src\/login\.ts/.test(final) && /src\/api\.ts/.test(final),
  },
  {
    id: 'two-file-fix',
    kind: 'edit',
    files: {
      'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
      'src/a.js': 'export function double(value) {\n  return value + value\n}\n',
      'src/b.js': 'export function clamp(value) {\n  return Math.max(0, Math.min(10, value + 1))\n}\n',
      'test.js': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { double } from './src/a.js'",
        "import { clamp } from './src/b.js'",
        '',
        "test('double handles negatives', () => assert.equal(double(-3), -6))",
        "test('clamp keeps values', () => assert.equal(clamp(5), 5))",
        "test('clamp low', () => assert.equal(clamp(-5), 0))",
        '',
      ].join('\n'),
    },
    prompt: 'Fix the failing tests in this project. Do not modify test.js. Run the tests before finishing.',
    check: async (workspace) => {
      const testHash = createHash('sha256').update(readFileSync(join(workspace, 'test.js'))).digest('hex')
      const result = await runNodeTest(workspace)
      const afterHash = createHash('sha256').update(readFileSync(join(workspace, 'test.js'))).digest('hex')
      return result === 0 && testHash === afterHash
    },
  },
  {
    id: 'single-file-fix',
    kind: 'edit',
    files: {
      'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
      'sum.js': 'export function sum(values) {\n  let total = 0\n  for (const value of values) {\n    total += value > 0 ? value : -value\n  }\n  return total\n}\n',
      'test.js': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { sum } from './sum.js'",
        '',
        "test('sums negatives', () => assert.equal(sum([-1, 2]), 1))",
        "test('sums positives', () => assert.equal(sum([1, 2, 3]), 6))",
        '',
      ].join('\n'),
    },
    prompt: 'Fix the failing tests in this project. Do not modify test.js. Run the tests before finishing.',
    check: async (workspace) => {
      const testHash = createHash('sha256').update(readFileSync(join(workspace, 'test.js'))).digest('hex')
      const result = await runNodeTest(workspace)
      const afterHash = createHash('sha256').update(readFileSync(join(workspace, 'test.js'))).digest('hex')
      return result === 0 && testHash === afterHash
    },
  },
]

function patchFor(arm: Arm, path: string): string {
  writeFileSync(path, [
    '- insert:',
    '    - id: super-dsh',
    `      name: '${PLUGIN.replace(/\\/g, '/')}'`,
    '      config:',
    `        profile: ${arm}`,
    '- id: session-title-llm',
    '  disabled: true',
    '',
  ].join('\n'), 'utf8')
  return path
}

function runDsh(prompt: string, workspace: string, dshHome: string, patch: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const args = [TSX, '--tsconfig', TSCONFIG, BIN, '--profile', 'headless', '--patch', patch, '--json', prompt]
    const child = spawn(process.env.DSH_NODE ?? 'node', args, {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HARNESS_ROOT: DSH_ROOT,
        DSH_HOME: dshHome,
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
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-3000) })
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
        if (!line.trim().startsWith('{')) continue
        try {
          const event = JSON.parse(line) as Record<string, any>
          if (event.type === 'final') final = String(event.text ?? '')
          if (event.type === 'status' && event.phase === 'turn_end') reason = String(event.reason?.kind ?? 'unknown')
          if (event.type === 'status' && event.phase === 'step_end') {
            inputTokens += Number(event.usage?.inputTokens ?? 0)
            outputTokens += Number(event.usage?.outputTokens ?? 0)
          }
          if (event.type === 'tool_call') toolCalls.push(String(event.tool))
        } catch { /* diagnostics interleave */ }
      }
      void stderr
      resolvePromise({ final, reason, inputTokens, outputTokens, toolCalls, wallMs: Date.now() - started, exitCode: code, timedOut })
    })
  })
}

function runNodeTest(cwd: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.env.DSH_NODE ?? 'node', ['--test'], { cwd, windowsHide: true, stdio: 'ignore' })
    child.on('close', (code) => resolvePromise(code))
  })
}

async function runTrial(task: Task, arm: Arm): Promise<Record<string, unknown>> {
  const root = join(RUNS, task.id, arm)
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [name, content] of Object.entries(task.files)) {
    const path = join(workspace, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  const patch = patchFor(arm, join(root, 'profile.patch.yml'))
  const session = await runDsh(task.prompt, workspace, home, patch)
  const passed = !session.timedOut && await task.check(workspace, session.final)
  return {
    task: task.id,
    kind: task.kind,
    arm,
    passed,
    final: session.final.slice(0, 1500),
    reason: session.reason,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    toolCalls: session.toolCalls,
    wallMs: session.wallMs,
    exitCode: session.exitCode,
    timedOut: session.timedOut,
  }
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = []
  let next = 0
  async function run(): Promise<void> {
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
const jobs = tasks.flatMap(task => (['core', 'coding'] as Arm[]).map(arm => ({ task, arm })))
const trials = await pool(jobs, CONCURRENCY, async ({ task, arm }) => {
  const trial = await runTrial(task, arm)
  console.log(`${task.id} ${arm}: ${trial.passed ? 'PASS' : 'FAIL'} (${trial.toolCalls.length} tools, ${trial.inputTokens} in)`)
  return trial
})

const summarize = (arm: Arm) => {
  const subset = trials.filter(trial => trial.arm === arm)
  return {
    passes: subset.filter(trial => trial.passed === true).length,
    total: subset.length,
    inputTokens: subset.reduce((sum, trial) => sum + Number(trial.inputTokens), 0),
    outputTokens: subset.reduce((sum, trial) => sum + Number(trial.outputTokens), 0),
    wallMs: subset.reduce((sum, trial) => sum + Number(trial.wallMs), 0),
  }
}
const core = summarize('core')
const coding = summarize('coding')
const decision = coding.passes > core.passes + 0.5
  ? 'coding'
  : coding.passes === core.passes && coding.inputTokens >= core.inputTokens * 1.1
    ? 'core'
    : coding.passes > core.passes ? 'coding' : 'core'
const result = {
  experiment: 'profile-ab',
  generatedAt: new Date().toISOString(),
  model: 'deepseek-flash',
  tasks: tasks.length,
  arms: { core, coding },
  decision,
  decisionRule: 'prefer coding only if it wins at least one more task than core; on ties prefer the lower-token arm',
  trials,
}
writeFileSync(join(RESULTS, 'profile-ab-bench.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log('\nSummary')
console.log(`core   ${core.passes}/${core.total}, input ${core.inputTokens}`)
console.log(`coding ${coding.passes}/${coding.total}, input ${coding.inputTokens}`)
console.log(`decision: ${decision}`)
console.log(`wrote ${join(RESULTS, 'profile-ab-bench.json')}`)
