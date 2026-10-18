/**
 * Agent-level A/B experiments for SuperDSH.
 *
 * E2 — cross-session project memory: a fact stated in session 1 must be
 * available in a *new* session, with the workspace wiped in between so only
 * plugin memory can carry it.
 *
 * E3 — verification gate: seeded failing-test tasks; the treatment refuses to
 * finish a turn until `node --test` passes, feeding failures back.
 *
 * Both arms use the real dsh headless CLI and the real DeepSeek API. Session
 * workspaces and DSH homes are isolated per run. Results are written to
 * experiments/results/agent-bench.json.
 *
 * Run from the super-dsh directory:
 *   bun experiments/agent-bench.ts
 * or through the dsh checkout:
 *   cd ../deepseek-harness && pnpm exec tsx ../super-dsh/experiments/agent-bench.ts
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dir
const DSH_ROOT = resolve(HERE, '..', '..', 'deepseek-harness')
const PLUGIN = resolve(HERE, '..', 'dist', 'index.js')
const TSX_CLI = resolve(DSH_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const DSH_BIN = resolve(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const DSH_TSCONFIG = resolve(DSH_ROOT, 'tsconfig.base.json')
const RUNS = resolve(HERE, 'runs')
const RESULTS = resolve(HERE, 'results')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const CONCURRENCY = 2
const SESSION_TIMEOUT_MS = 420_000

if (!existsSync(PLUGIN)) {
  throw new Error(`Build the plugin first: bun run build (missing ${PLUGIN})`)
}
if (!existsSync(join(DSH_ROOT, 'node_modules', 'tsx'))) {
  throw new Error(`Expected a dsh source checkout at ${DSH_ROOT}`)
}

interface RunOptions {
  cwd: string
  dshHome: string
  patch: string
}

interface ToolCall {
  tool: string
  input: unknown
}

interface DshRun {
  final: string
  exitCode: number | null
  reason: string
  turns: number
  steps: number
  toolCalls: ToolCall[]
  inputTokens: number
  outputTokens: number
  wallMs: number
  stderrTail: string
  timedOut: boolean
}

interface Trial {
  experiment: 'memory' | 'verify'
  arm: 'baseline' | 'treatment'
  task: string
  passed: boolean
  detail: string
  session: DshRun
  extra?: Record<string, unknown>
}

async function runDsh(prompt: string, options: RunOptions): Promise<DshRun> {
  const started = Date.now()
  const args = [
    TSX_CLI,
    '--tsconfig', DSH_TSCONFIG,
    DSH_BIN,
    '--profile', 'headless',
    '--patch', options.patch,
    '--json',
    prompt,
  ]
  return await new Promise<DshRun>((resolvePromise) => {
    const child = spawn(process.env.DSH_NODE ?? 'node', args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        DSH_HARNESS_ROOT: DSH_ROOT,
        DSH_HOME: options.dshHome,
        DSH_PERMISSION_MODE: 'danger-full-access',
        SUPER_DSH_WORKSPACE: options.cwd,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000)
    })
    const timer = setTimeout(() => {
      killed = true
      killTree(child.pid)
    }, SESSION_TIMEOUT_MS)

    child.on('close', (code) => {
      clearTimeout(timer)
      const events: Array<Record<string, any>> = []
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          events.push(JSON.parse(trimmed))
        } catch {
          // Diagnostics may interleave; ignore malformed lines.
        }
      }
      let final = ''
      let reason = 'missing'
      let turns = 0
      let steps = 0
      let inputTokens = 0
      let outputTokens = 0
      const toolCalls: ToolCall[] = []
      for (const event of events) {
        if (event.type === 'final') final = String(event.text ?? '')
        if (event.type === 'status') {
          if (event.phase === 'turn_end') {
            turns++
            reason = String(event.reason?.kind ?? 'unknown')
          }
          if (event.phase === 'step_end') {
            steps++
            inputTokens += Number(event.usage?.inputTokens ?? 0)
            outputTokens += Number(event.usage?.outputTokens ?? 0)
          }
        }
        if (event.type === 'tool_call') toolCalls.push({ tool: String(event.tool), input: event.input })
      }
      resolvePromise({
        final,
        exitCode: code,
        reason,
        turns,
        steps,
        toolCalls,
        inputTokens,
        outputTokens,
        wallMs: Date.now() - started,
        stderrTail: stderr.slice(-3000),
        timedOut: killed,
      })
    })
  })
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function writePatch(name: string, pluginConfig?: Record<string, unknown>): string {
  const lines = []
  if (pluginConfig !== undefined) {
    lines.push('- insert:')
    lines.push('    - id: super-dsh')
    lines.push(`      name: '${PLUGIN.replace(/\\/g, '/')}'`)
    lines.push('      config:')
    for (const [key, value] of Object.entries(pluginConfig)) {
      if (value !== null && typeof value === 'object') {
        lines.push(`        ${key}:`)
        for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
          lines.push(`          ${innerKey}: ${yamlScalar(innerValue)}`)
        }
      } else {
        lines.push(`        ${key}: ${yamlScalar(value)}`)
      }
    }
  }
  lines.push('- id: session-title-llm')
  lines.push('  disabled: true')
  const path = join(RUNS, `${STAMP}-${name}.patch.yml`)
  mkdirSync(RUNS, { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  return String(value)
}

function freshWorkspace(path: string): void {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function isMemoryFile(home: string): string | undefined {
  const dir = join(home, 'super-dsh', 'memory')
  if (!existsSync(dir)) return undefined
  const file = readdirSync(dir).find(name => name.endsWith('.jsonl'))
  return file === undefined ? undefined : join(dir, file)
}

// ── E2: cross-session memory ────────────────────────────────────────────────

const MEMORY_SESSION_1 = [
  'Remember this for future sessions. Do not modify any files and do not run commands.',
  'The project test command is `bun test --coverage`.',
  'API responses must use snake_case field names.',
  'Reply exactly: SAVED',
].join(' ')

const MEMORY_SESSION_2 = [
  'Without reading files or running commands, answer these two questions about this project:',
  '(1) What is its test command?',
  '(2) What field-name convention must API responses use?',
  'Answer concisely.',
].join(' ')

async function runMemoryPair(arm: 'baseline' | 'treatment', rep: number): Promise<Trial[]> {
  const root = join(RUNS, STAMP, 'memory', arm, `rep${rep}`)
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  freshWorkspace(workspace)
  mkdirSync(home, { recursive: true })
  const patch = arm === 'treatment'
    ? writePatch(`memory-${rep}`, { fuzzyEdit: false, memory: true, audit: false })
    : writePatch(`baseline-${rep}`)

  const first = await runDsh(MEMORY_SESSION_1, { cwd: workspace, dshHome: home, patch })
  const memoryFile = isMemoryFile(home)
  const memoryText = memoryFile === undefined ? '' : readFileSync(memoryFile, 'utf8')

  // The workspace is wiped so session 2 cannot inherit files from session 1.
  freshWorkspace(workspace)
  const second = await runDsh(MEMORY_SESSION_2, { cwd: workspace, dshHome: home, patch })
  const normalized = second.final.toLowerCase().replace(/\s+/g, ' ')
  const hasCommand = /bun test\s+--coverage|bun test\s+--\s+coverage/.test(normalized)
  const hasNaming = /snake[_ ]case/.test(normalized)
  const passed = hasCommand && hasNaming

  return [{
    experiment: 'memory',
    arm,
    task: `pair-${rep}`,
    passed,
    detail: `session1 tools=${first.toolCalls.map(call => call.tool).join(',') || 'none'}; `
      + `memory_file=${memoryFile === undefined ? 'none' : 'present'}; `
      + `session2=command:${hasCommand} naming:${hasNaming}`,
    session: second,
    extra: {
      first,
      memoryStored: memoryText.includes('bun test --coverage') && memoryText.includes('snake_case'),
    },
  }]
}

// ── E3: verification gate ───────────────────────────────────────────────────

interface SeededTask {
  id: string
  files: Record<string, string>
  prompt: string
}

const VERIFY_TASKS: SeededTask[] = [
  {
    id: 'sum-negative',
    prompt: 'There is a bug in src.js. Fix it so the project tests pass. Do not modify test.js. The project uses node\'s built-in test runner.',
    files: {
      'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
      'src.js': 'export function sum(numbers) {\n  let total = 0\n  for (const value of numbers) {\n    total += value > 0 ? value : -value\n  }\n  return total\n}\n',
      'test.js': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { sum } from './src.js'",
        '',
        "test('adds positives', () => assert.equal(sum([1, 2, 3]), 6))",
        "test('adds negatives', () => assert.equal(sum([-1, 2]), 1))",
        "test('handles empty', () => assert.equal(sum([]), 0))",
        '',
      ].join('\n'),
    },
  },
  {
    id: 'slugify',
    prompt: 'There is a bug in src.js. Fix it so the project tests pass. Do not modify test.js. The project uses node\'s built-in test runner.',
    files: {
      'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
      'src.js': "export function slugify(text) {\n  return text.toLowerCase().trim().replace(/ /g, '-')\n}\n",
      'test.js': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { slugify } from './src.js'",
        '',
        "test('collapses repeated spaces', () => assert.equal(slugify('Hello  World'), 'hello-world'))",
        "test('trims and joins', () => assert.equal(slugify(' a b '), 'a-b'))",
        "test('removes punctuation', () => assert.equal(slugify('Hello, World!'), 'hello-world'))",
        '',
      ].join('\n'),
    },
  },
  {
    id: 'parse-port',
    prompt: 'There is a bug in src.js. Fix it so the project tests pass. Do not modify test.js. The project uses node\'s built-in test runner.',
    files: {
      'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
      'src.js': [
        'export function parsePort(value) {',
        '  const port = Number.parseInt(value)',
        "  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')",
        '  return port',
        '}',
        '',
      ].join('\n'),
      'test.js': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { parsePort } from './src.js'",
        '',
        "test('accepts valid ports', () => assert.equal(parsePort('8080'), 8080))",
        "test('rejects trailing junk', () => assert.throws(() => parsePort('8080abc')))",
        "test('rejects empty', () => assert.throws(() => parsePort('')))",
        "test('rejects out of range', () => assert.throws(() => parsePort('70000')))",
        '',
      ].join('\n'),
    },
  },
  {
    id: 'clamp',
    prompt: 'There is a bug in src.js. Fix it so the project tests pass. Do not modify test.js. The project uses node\'s built-in test runner.',
    files: {
      'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
      'src.js': 'export function clamp(value, min, max) {\n  return Math.max(min, Math.min(max, value + 1))\n}\n',
      'test.js': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { clamp } from './src.js'",
        '',
        "test('keeps in range', () => assert.equal(clamp(5, 0, 10), 5))",
        "test('clamps low', () => assert.equal(clamp(-5, 0, 10), 0))",
        "test('clamps high', () => assert.equal(clamp(15, 0, 10), 10))",
        '',
      ].join('\n'),
    },
  },
]

async function runVerifyTrial(arm: 'baseline' | 'treatment', task: SeededTask): Promise<Trial> {
  const root = join(RUNS, STAMP, 'verify', arm, task.id)
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  freshWorkspace(workspace)
  mkdirSync(home, { recursive: true })
  for (const [name, content] of Object.entries(task.files)) {
    writeFileSync(join(workspace, name), content, 'utf8')
  }
  const testHash = sha256(task.files['test.js'])
  const patch = arm === 'treatment'
    ? writePatch(`verify-${task.id}`, {
      fuzzyEdit: false,
      memory: false,
      audit: false,
      verify: { command: 'node --test', maxAttempts: 2, timeoutMs: 60000 },
    })
    : writePatch(`baseline-verify-${task.id}`)

  const session = await runDsh(task.prompt, { cwd: workspace, dshHome: home, patch })
  const checker = await runCommand('node --test', workspace, 60_000)
  const testUnchanged = sha256(readFileSync(join(workspace, 'test.js'), 'utf8')) === testHash
  const passed = checker.exitCode === 0 && testUnchanged
  const testRuns = session.toolCalls.filter((call) => {
    const input = JSON.stringify(call.input)
    return call.tool === 'verify' || /node --test|npm test|bun test/.test(input)
  }).length

  return {
    experiment: 'verify',
    arm,
    task: task.id,
    passed,
    detail: `tests=${checker.exitCode === 0 ? 'pass' : 'fail'} test_file_intact=${testUnchanged} `
      + `test_runs=${testRuns} turn_end=${session.reason}`,
    session,
    extra: { testRuns, testUnchanged, checkerTail: checker.output.slice(-1000) },
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => killTree(child.pid), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, output: output.slice(-5000) })
    })
  })
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
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

// ── main ────────────────────────────────────────────────────────────────────

mkdirSync(RUNS, { recursive: true })
mkdirSync(RESULTS, { recursive: true })

const ONLY = process.env.SUPER_DSH_BENCH_ONLY
const REPS = Math.max(1, Number(process.env.SUPER_DSH_BENCH_REPS ?? 2) || 2)
const JUST_MERGE = process.env.SUPER_DSH_BENCH_JUST_MERGE === '1'

const memoryJobs = JUST_MERGE || ONLY === 'verify'
  ? []
  : [
      ...Array.from({ length: REPS }, (_, index) => ({ arm: 'baseline' as const, rep: index + 1 })),
      ...Array.from({ length: REPS }, (_, index) => ({ arm: 'treatment' as const, rep: index + 1 })),
    ]
const verifyJobs = JUST_MERGE || ONLY === 'memory'
  ? []
  : VERIFY_TASKS.flatMap(task => ([
      { arm: 'baseline' as const, task },
      { arm: 'treatment' as const, task },
    ]))

console.log(`DSH root: ${DSH_ROOT}`)
console.log(`Plugin:   ${PLUGIN}`)
console.log(`Runs:     ${join(RUNS, STAMP)}`)
console.log(`Running ${memoryJobs.length} memory pairs (2 sessions each) and ${verifyJobs.length} verify trials, concurrency ${CONCURRENCY}…`)

const memoryTrials = (await pool(memoryJobs, CONCURRENCY, async job => {
  const trials = await runMemoryPair(job.arm, job.rep)
  console.log(`  memory ${job.arm} pair-${job.rep}: ${trials[0].passed ? 'PASS' : 'FAIL'} (${trials[0].detail})`)
  return trials
})).flat()

const verifyTrials = await pool(verifyJobs, CONCURRENCY, async job => {
  const trial = await runVerifyTrial(job.arm, job.task)
  console.log(`  verify ${job.arm} ${job.task.id}: ${trial.passed ? 'PASS' : 'FAIL'} (${trial.detail})`)
  return trial
})

const memoryDoc = memoryTrials.length > 0
  ? experimentDoc('memory', memoryTrials, {
    baseline: memoryTrials.filter(trial => trial.arm === 'baseline' && trial.passed).length,
    treatment: memoryTrials.filter(trial => trial.arm === 'treatment' && trial.passed).length,
    totalPerArm: REPS,
  })
  : loadDoc(join(RESULTS, 'agent-bench-memory.json'))
const verifyDoc = verifyTrials.length > 0
  ? experimentDoc('verify', verifyTrials, {
    baseline: verifyTrials.filter(trial => trial.arm === 'baseline' && trial.passed).length,
    treatment: verifyTrials.filter(trial => trial.arm === 'treatment' && trial.passed).length,
    totalPerArm: VERIFY_TASKS.length,
  })
  : loadDoc(join(RESULTS, 'agent-bench-verify.json'))

if (memoryTrials.length > 0) {
  writeFileSync(join(RESULTS, 'agent-bench-memory.json'), `${JSON.stringify(memoryDoc, null, 2)}\n`, 'utf8')
}
if (verifyTrials.length > 0) {
  writeFileSync(join(RESULTS, 'agent-bench-verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8')
}

const merged = {
  experiment: 'agent-bench',
  generatedAt: new Date().toISOString(),
  model: 'deepseek-flash',
  dsh: '0.2.1-rc.2 (source checkout)',
  runs: (memoryDoc?.trials.length ?? 0) + (verifyDoc?.trials.length ?? 0),
  memory: memoryDoc?.summary ?? null,
  verify: verifyDoc?.summary ?? null,
  trials: [
    ...(memoryDoc?.trials ?? []),
    ...(verifyDoc?.trials ?? []),
  ],
}
writeFileSync(join(RESULTS, 'agent-bench.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

console.log('\nSummary')
if (memoryDoc !== undefined) {
  console.log(`memory: baseline ${memoryDoc.summary.baseline}/${memoryDoc.summary.totalPerArm}, treatment ${memoryDoc.summary.treatment}/${memoryDoc.summary.totalPerArm}`)
}
if (verifyDoc !== undefined) {
  console.log(`verify: baseline ${verifyDoc.summary.baseline}/${verifyDoc.summary.totalPerArm}, treatment ${verifyDoc.summary.treatment}/${verifyDoc.summary.totalPerArm}`)
}
console.log(`wrote ${join(RESULTS, 'agent-bench.json')}`)

function experimentDoc(
  experiment: 'memory' | 'verify',
  trials: Trial[],
  summary: Record<string, number>,
): {
  experiment: string
  generatedAt: string
  model: string
  runs: number
  summary: Record<string, number>
  trials: Trial[]
} {
  return {
    experiment,
    generatedAt: new Date().toISOString(),
    model: 'deepseek-flash',
    runs: trials.length,
    summary,
    trials,
  }
}

function loadDoc(path: string): { summary: Record<string, number>; trials: Trial[] } | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { summary: Record<string, number>; trials: Trial[] }
  } catch {
    return undefined
  }
}
