/**
 * Repairs agent A/B: does automatic repair-hint injection improve task success
 * or reduce token use?
 *
 * Pre-registered decision rule (fixed before running):
 *   Keep repairs on by default only when the treatment passes at least two
 *   more tasks than the baseline, OR passes no fewer tasks and uses at least
 *   15% fewer input tokens. Otherwise repairs should be opt-in.
 *
 * Both arms enable the repairs feature (same tool schemas). Only the treatment
 * arm has a pre-seeded hint for the task's actual test failure, so the
 * difference is the injection itself.
 *
 * Run: bun run experiment:repairs
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = import.meta.dir
const DSH_ROOT = resolve(HERE, '..', '..', 'deepseek-harness')
const PLUGIN = resolve(HERE, '..', 'dist', 'index.js')
const TSX = resolve(DSH_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const BIN = resolve(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = resolve(DSH_ROOT, 'tsconfig.base.json')
const SEED = resolve(HERE, '..', 'tests', 'fixtures', 'seed-repair.ts')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNS = resolve(HERE, 'runs', `repairs-ab-${STAMP}`)
const RESULTS = resolve(HERE, 'results')
const TIMEOUT = 300_000
const CONCURRENCY = 4

interface Task {
  id: string
  files: Record<string, string>
  prompt: string
  hint: string
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
  testUnchanged: boolean
  injectedHints: number
}

function project(source: string, test: string, exported: string): Record<string, string> {
  return {
    'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    'src.js': source,
    'test.js': [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      `import { ${exported} } from './src.js'`,
      '',
      test,
      '',
    ].join('\n'),
  }
}

const tasks: Task[] = [
  {
    id: 'sum-signed',
    files: project(
      [
        'export function sum(numbers) {',
        '  let total = 0',
        '  for (const value of numbers) total += value > 0 ? value : -value',
        '  return total',
        '}',
        '',
      ].join('\n'),
      [
        "test('sum keeps signed values', () => assert.equal(sum([-1, 2]), 1))",
        "test('sum handles positives', () => assert.equal(sum([1, 2, 3]), 6))",
        "test('sum handles empty', () => assert.equal(sum([]), 0))",
      ].join('\n'),
      'sum',
    ),
    prompt: 'The project tests fail. Run `node --test` first, diagnose the failure, fix only src.js, then run `node --test` again. Do not modify test.js.',
    hint: 'In sum, the loop uses the absolute value. Change the body to `total += value`.',
  },
  // Each source exports only the target function; the generated test imports
  // exactly that name, so a broken sibling export cannot mask the task.
  ...([
    ['clamp-off-by-one', 'clamp', 'export function clamp(value, min, max) { return Math.max(min, Math.min(max, value + 1)) }',
      "test('clamp keeps values', () => assert.equal(clamp(5, 0, 10), 5))\ntest('clamp clamps high', () => assert.equal(clamp(15, 0, 10), 10))",
      'In clamp, remove the `+ 1` from the value passed to Math.min.'],
    ['slugify-spaces', 'slugify', 'export function slugify(text) { return text.toLowerCase().trim().replace(/ /g, "-") }',
      "test('collapses repeated spaces', () => assert.equal(slugify('Hello  World'), 'hello-world'))\ntest('removes punctuation', () => assert.equal(slugify('Hello, World!'), 'hello-world'))",
      'In slugify, replace runs of non-alphanumeric characters with a hyphen: `replace(/[^a-z0-9]+/g, "-")`.'],
    ['dedupe-by-id', 'dedupe', 'export function dedupe(items) { return [...new Set(items)] }',
      "test('dedupes objects by id', () => assert.deepEqual(dedupe([{ id: 1, n: 'a' }, { id: 1, n: 'b' }, { id: 2, n: 'c' }]).map(x => x.id), [1, 2]))",
      'In dedupe, Set compares object identity. Deduplicate by `id` with a Map keyed by `item.id`.'],
    ['sort-numeric', 'sortNumbers', 'export function sortNumbers(numbers) { return [...numbers].sort() }',
      "test('sorts numerically', () => assert.deepEqual(sortNumbers([10, 2, 1]), [1, 2, 10]))",
      'In sortNumbers, `.sort()` is lexicographic. Pass a numeric comparator `(a, b) => a - b`.'],
    ['median-even', 'median', 'export function median(numbers) { const sorted = [...numbers].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }',
      "test('averages the middle for even lengths', () => assert.equal(median([1, 2, 3, 4]), 2.5))",
      'In median, an even-length array must average the two middle values, not return the upper one.'],
    ['format-month', 'formatMonth', 'export function formatMonth(date) { const m = date.getMonth(); return `${date.getFullYear()}-${String(m).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` }',
      "test('formats March as 03', () => assert.equal(formatMonth(new Date(2024, 2, 5)), '2024-03-05'))",
      'In formatMonth, getMonth() is zero-based. Add 1 before formatting.'],
    ['parse-port-junk', 'parsePort', 'export function parsePort(value) { const port = Number.parseInt(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port"); return port }',
      "test('rejects trailing junk', () => assert.throws(() => parsePort('8080abc')))\ntest('accepts a valid port', () => assert.equal(parsePort('8080'), 8080))",
      'parseInt accepts trailing junk. Validate the whole string (for example with a digits regex or Number) before range checking.'],
    ['email-anchors', 'validEmail', 'export function validEmail(value) { return value.includes("@") && value.includes(".") }',
      "test('rejects an invalid address', () => assert.equal(validEmail('not an email'), false))\ntest('rejects trailing text', () => assert.equal(validEmail('a@b.com extra'), false))\ntest('accepts a valid address', () => assert.equal(validEmail('a@b.com'), true))",
      'Replace the includes checks with an anchored email regex or a full-string match so trailing text fails.'],
    ['truncate-code-points', 'truncate', 'export function truncate(text, max) { return text.slice(0, max) + "…" }',
      "test('does not split surrogate pairs', () => assert.equal(truncate('a😀b', 2), 'a😀…'))",
      'String.slice counts UTF-16 units. Use Array.from(text).slice(0, max).join("") before adding the ellipsis.'],
    ['retry-attempts', 'retry', 'export async function retry(fn, attempts) { try { return await fn() } catch { throw new Error("failed") } }',
      "test('retries until success', async () => { let calls = 0; const result = await retry(async () => { calls += 1; if (calls < 3) throw new Error('no'); return 'ok' }, 3); assert.equal(result, 'ok'); assert.equal(calls, 3) })",
      'retry currently calls fn once. Loop up to `attempts` times, await each call, and return the first success.'],
    ['merge-no-mutate', 'merge', 'export function merge(target, source) { return Object.assign(target, source) }',
      "test('does not mutate the target', () => { const target = { a: 1 }; const result = merge(target, { b: 2 }); assert.deepEqual(target, { a: 1 }); assert.deepEqual(result, { a: 1, b: 2 }) })",
      'Object.assign mutates target. Return a new object, for example `{ ...target, ...source }`.'],
    ['query-decode', 'parseQuery', 'export function parseQuery(qs) { const out = {}; for (const part of qs.split("&")) { const [k, v] = part.split("="); out[k] = v } return out }',
      "test('decodes values', () => assert.deepEqual(parseQuery('a=hello%20world&b=x'), { a: 'hello world', b: 'x' }))",
      'parseQuery must decodeURIComponent both the key and the value before storing them.'],
    ['deep-equal-nan', 'deepEqual', 'export function deepEqual(a, b) { return a === b }',
      "test('treats NaN as equal', () => assert.equal(deepEqual(NaN, NaN), true))\ntest('compares primitives', () => assert.equal(deepEqual(2, 2), true))",
      '`===` is false for NaN. Use Object.is for primitives (or a recursive comparison) so NaN equals NaN.'],
    ['flatten-nested', 'flatten', 'export function flatten(items) { const out = []; for (const item of items) out.push(item); return out }',
      "test('flattens nested arrays', () => assert.deepEqual(flatten([1, [2, [3]]]), [1, 2, 3]))",
      'flatten must recurse into nested arrays (or use `items.flat(Infinity)`).'],
    ['count-words-spaces', 'countWords', 'export function countWords(text) { return text.trim().length === 0 ? 0 : text.trim().split(" ").length }',
      "test('collapses repeated whitespace', () => assert.equal(countWords('  one   two\\nthree  '), 3))",
      'Split on whitespace runs (`/\\s+/`) after trimming, or filter empty segments.'],
  ] as const).map(([id, name, source, test, hint]) => ({
    id,
    files: project(source, test, name),
    prompt: 'The project tests fail. Run `node --test` first, diagnose the failure, fix only src.js, then run `node --test` again. Do not modify test.js.',
    hint,
  })),
]

function writePatch(task: string, arm: 'baseline' | 'treatment'): string {
  const path = join(RUNS, `${task}.${arm}.patch.yml`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
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
    '        repairs: true',
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

function runCommand(command: string, cwd: string, timeoutMs = 60_000): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, output: output.slice(-5000) })
    })
  })
}

/** Count sessions whose event log contains the injected repair context. */
function countInjectedHints(home: string): number {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return 0
  let count = 0
  for (const relative of readdirSync(sessions, { recursive: true })) {
    const name = String(relative)
    if (!name.endsWith('.jsonl.zstd')) continue
    try {
      const file = resolve(sessions, name)
      const bytes = readFileSync(`\\\\?\\${file}`)
      const text = Buffer.from(Bun.zstdDecompressSync(bytes)).toString('utf8')
      if (text.includes('Repair memory (prior sessions)')) count++
    } catch {
      // A missing or unreadable session log is not an injection.
    }
  }
  return count
}

function seedRepair(workspace: string, home: string, spec: { message: string; hint: string }): Promise<void> {  return new Promise((resolvePromise, reject) => {
    const specPath = join(workspace, '..', 'repair-spec.json')
    writeFileSync(specPath, JSON.stringify({ message: spec.message, hint: spec.hint }, null, 2), 'utf8')
    const child = spawn(process.env.DSH_NODE ?? 'node', [SEED, workspace, specPath], {
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

async function runTrial(task: Task, arm: 'baseline' | 'treatment'): Promise<Trial> {
  const root = join(RUNS, task.id, arm)
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [name, content] of Object.entries(task.files)) {
    const path = join(workspace, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  const testHash = createHash('sha256').update(task.files['test.js']!).digest('hex')
  const patch = writePatch(task.id, arm)

  // Record the hint against the task's actual failure output before the
  // treatment session. Baseline writes no hint; both keep the same tool set.
  if (arm === 'treatment') {
    const broken = await runCommand('node --test', workspace)
    await seedRepair(workspace, home, {
      message: broken.output || 'node --test failed with exit code 1',
      hint: task.hint,
    })
  }

  const session = await runDsh(task.prompt, workspace, home, patch)
  const checker = await runCommand('node --test', workspace)
  const testUnchanged = createHash('sha256').update(readFileSync(join(workspace, 'test.js'), 'utf8')).digest('hex') === testHash
  return {
    ...session,
    task: task.id,
    arm,
    passed: checker.exitCode === 0 && testUnchanged,
    testUnchanged,
    injectedHints: countInjectedHints(home),
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

const requested = Number(process.env.SUPER_DSH_REPAIR_LIMIT ?? tasks.length)
const LIMIT = Number.isFinite(requested) && requested > 0
  ? Math.min(tasks.length, Math.floor(requested))
  : tasks.length
const selectedTasks = tasks.slice(0, LIMIT)

mkdirSync(RUNS, { recursive: true })
mkdirSync(RESULTS, { recursive: true })
console.log(`DSH root: ${DSH_ROOT}`)
console.log(`Plugin:   ${PLUGIN}`)
console.log(`Runs:     ${RUNS}`)
console.log(`Running ${selectedTasks.length * 2} repair trials, concurrency ${CONCURRENCY}…`)

const jobs = selectedTasks.flatMap(task => ([
  { task, arm: 'baseline' as const },
  { task, arm: 'treatment' as const },
]))
const trials = await pool(jobs, CONCURRENCY, async job => {
  const trial = await runTrial(job.task, job.arm)
  console.log(`  ${trial.arm} ${trial.task}: ${trial.passed ? 'PASS' : 'FAIL'} `
    + `(in=${trial.inputTokens} out=${trial.outputTokens} tools=${trial.toolCalls.length})`)
  return trial
})

const baseline = trials.filter(trial => trial.arm === 'baseline')
const treatment = trials.filter(trial => trial.arm === 'treatment')
const sum = (items: Trial[], field: 'inputTokens' | 'outputTokens' | 'wallMs'): number =>
  items.reduce((total, item) => total + item[field], 0)
const baselinePasses = baseline.filter(trial => trial.passed).length
const treatmentPasses = treatment.filter(trial => trial.passed).length
const total = selectedTasks.length
const tokenChange = baseline.length === 0
  ? 0
  : (sum(treatment, 'inputTokens') - sum(baseline, 'inputTokens')) / Math.max(1, sum(baseline, 'inputTokens'))
const passWins = treatmentPasses - baselinePasses
const keepDefault = passWins >= 2 || (passWins >= 0 && tokenChange <= -0.15)

const doc = {
  experiment: 'repairs-ab',
  generatedAt: new Date().toISOString(),
  model: 'deepseek-flash',
  dsh: '0.2.1-rc.2 (source checkout)',
  tasks: total,
  decisionRule: 'keep repairs default if treatment passes >= baseline + 2, or passes >= baseline with >=15% fewer input tokens',
  summary: {
    baselinePasses,
    treatmentPasses,
    total,
    baselineInputTokens: sum(baseline, 'inputTokens'),
    treatmentInputTokens: sum(treatment, 'inputTokens'),
    baselineOutputTokens: sum(baseline, 'outputTokens'),
    treatmentOutputTokens: sum(treatment, 'outputTokens'),
    baselineWallMs: sum(baseline, 'wallMs'),
    treatmentWallMs: sum(treatment, 'wallMs'),
    tokenChange: Math.round(tokenChange * 10_000) / 10_000,
    passWins,
    baselineHintSessions: baseline.filter(trial => trial.injectedHints > 0).length,
    treatmentHintSessions: treatment.filter(trial => trial.injectedHints > 0).length,
    keepDefault,
  },
  trials,
}
writeFileSync(join(RESULTS, 'repairs-ab-bench.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log('\nSummary')
console.log(`passes: baseline ${baselinePasses}/${total}, treatment ${treatmentPasses}/${total}`)
console.log(`input tokens: baseline ${sum(baseline, 'inputTokens')}, treatment ${sum(treatment, 'inputTokens')} (${(tokenChange * 100).toFixed(1)}%)`)
console.log(`hint sessions: baseline ${doc.summary.baselineHintSessions}, treatment ${doc.summary.treatmentHintSessions}`)
console.log(`decision: ${keepDefault ? 'keep repairs default' : 'move repairs to opt-in'}`)
