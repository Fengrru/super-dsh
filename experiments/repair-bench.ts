/**
 * Experiment — cross-session repair memory.
 *
 * Treatment: record five fix hints in one "session", then create a new
 * instance/session over the same workspace store and replay 20 tool errors.
 * Known errors are the recorded failure shapes with different paths, line
 * numbers, UUIDs, and counts (the normalization must still match). Unknown
 * errors include the same tools/codes with unrelated messages, plus entirely
 * different tools, and must not receive a hint.
 *
 * Metrics: hit rate on known errors, correct-hint rate, false-positive rate on
 * unknown errors, and injected characters. A useful memory must raise the first
 * without raising the third.
 *
 * Run: bun experiments/repair-bench.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRepairs } from '../src/features/repairs.ts'
import type { PluginContext, ToolDefinitionLike } from '../src/plugin-types.ts'

interface Fix {
  tool: string
  errorCode: string
  message: string
  variant: string
  hint: string
}

interface ErrorCase {
  tool: string
  errorCode: string
  message: string
}

const FIXES: Fix[] = [
  {
    tool: 'read',
    errorCode: 'ENOENT',
    message: "ENOENT: no such file or directory, open '/srv/app/src/config.ts' (request 550e8400-e29b-41d4-a716-446655440000)",
    variant: "ENOENT: no such file or directory, open 'C:\\work\\app\\src\\config.ts' (request 123e4567-e89b-12d3-a456-426614174000)",
    hint: 'Re-read the directory listing and retry with the current path; the file may have moved.',
  },
  {
    tool: 'bash',
    errorCode: 'EACCES',
    message: 'bash: line 42: ./scripts/deploy.sh: Permission denied',
    variant: 'bash: line 7: /home/bob/scripts/deploy.sh: Permission denied',
    hint: 'Run chmod +x on the script (or invoke it through bash with the right interpreter) before retrying.',
  },
  {
    tool: 'edit',
    errorCode: 'EDIT_MISMATCH',
    message: 'old_string not found in src/app.ts after 2 attempts',
    variant: 'old_string not found in lib\\main.ts after 17 attempts',
    hint: 'Read the file again and copy the exact current text, including indentation, before editing.',
  },
  {
    tool: 'bash',
    errorCode: 'ETIMEDOUT',
    message: 'Command timed out after 120000ms (pid 8123)',
    variant: 'Command timed out after 300000ms (pid 99001)',
    hint: 'Split the command into smaller steps or raise the timeout explicitly, then retry.',
  },
  {
    tool: 'apply_patch',
    errorCode: 'PATCH_FAILED',
    message: 'Patch context mismatch at line 42 in src/config.ts',
    variant: 'Patch context mismatch at line 9 in src/config.ts',
    hint: 'Re-read the target file and regenerate the patch against the current content.',
  },
]

/** Same tool/code as recorded fixes, unrelated message: must not match. */
const UNKNOWN_CASES: ErrorCase[] = [
  { tool: 'read', errorCode: 'ENOENT', message: 'lunar telemetry checksum mismatch in antenna azimuth log' },
  { tool: 'bash', errorCode: 'EACCES', message: 'orchestral score transposition halted at measure' },
  { tool: 'edit', errorCode: 'EDIT_MISMATCH', message: 'botanical sample taxonomy disputed by curator' },
  { tool: 'bash', errorCode: 'ETIMEDOUT', message: 'glacier melt sensor calibration exceeded thermal envelope' },
  { tool: 'apply_patch', errorCode: 'PATCH_FAILED', message: 'mosaic tile adhesion failed during kiln firing' },
  { tool: 'grep', errorCode: 'NO_MATCH', message: 'no occurrences of syntax marker in generated catalog' },
  { tool: 'fetch', errorCode: 'HTTP_500', message: 'upstream geyser pressure feed returned anomalous wave' },
  { tool: 'sqlite', errorCode: 'LOCKED', message: 'database page checksum rotated during vacuum' },
  { tool: 'compile', errorCode: 'TYPE_ERROR', message: 'quantum flux capacitor annotation mismatch' },
  { tool: 'image_resize', errorCode: 'DIMENSION', message: 'portrait aspect ratio collided with frame' },
]

interface SimulatedResult {
  tool: string
  errorCode: string
  hit: boolean
  chars: number
  injected: string
}

function makeHarness(workspace: string, repairsDir: string, sessionId: string) {
  const tools = new Map<string, ToolDefinitionLike>()
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  const ctx = {
    tools: {
      register(definition: ToolDefinitionLike) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: { section() { return () => {} } },
    fs: {
      resolve: async () => ({}),
      readText: async () => '',
      writeText: async () => ({}),
      editText: async () => ({ before: '', after: '', version: 1 }),
    },
    workingDirectory: { ensure: async () => workspace },
    on(event: string, listener: (...args: any[]) => any) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return () => {}
    },
    logger: { warn() {}, info() {} },
  } as unknown as PluginContext
  applyRepairs(ctx, { repairs: { dir: repairsDir } })

  const agent = { session: { id: sessionId }, followup() {} }
  const execution = (name: string) => ({
    callId: `call-${name}`,
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })

  const runTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool.execute(args, execution(name))
  }

  const simulate = async (name: string, message: string, errorCode?: string): Promise<SimulatedResult> => {
    const decision = { kind: 'accept' }
    let final: any = decision
    for (const handler of handlers.get('tools/post-execute') ?? []) {
      final = await handler(
        execution(name),
        { isError: true, error: { ...(errorCode === undefined ? {} : { code: errorCode }), message } },
        async () => decision,
      )
    }
    const contexts: unknown[] = Array.isArray(final?.additionalContexts) ? final.additionalContexts : []
    const texts: string[] = []
    for (const context of contexts) {
      const content = (context as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string') texts.push(text)
        }
      }
    }
    const injected = texts.join('\n')
    return { tool: name, errorCode: errorCode ?? '', hit: injected.length > 0, chars: injected.length, injected }
  }

  return { runTool, simulate }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'super-dsh-repair-bench-'))
  const workspace = join(root, 'workspace')
  const repairsDir = join(root, 'repairs')

  // Session 1 records the fixes.
  const recorder = makeHarness(workspace, repairsDir, 'repair-bench-recorder')
  const recorded: Array<{ tool: string; errorCode: string; signature: string; successCount: number }> = []
  for (const fix of FIXES) {
    const result = await recorder.runTool('repair_record', {
      tool: fix.tool,
      error_message: fix.message,
      error_code: fix.errorCode,
      hint: fix.hint,
    })
    recorded.push({
      tool: fix.tool,
      errorCode: fix.errorCode,
      signature: String(result.signature),
      successCount: Number(result.successCount),
    })
  }

  // Session 2 (new instance) replays known and unknown errors.
  const replay = makeHarness(workspace, repairsDir, 'repair-bench-replay')
  const known: SimulatedResult[] = []
  for (const fix of FIXES) {
    known.push(await replay.simulate(fix.tool, fix.message, fix.errorCode))
    known.push(await replay.simulate(fix.tool, fix.variant, fix.errorCode))
  }
  const unknown: SimulatedResult[] = []
  for (const errorCase of UNKNOWN_CASES) {
    unknown.push(await replay.simulate(errorCase.tool, errorCase.message, errorCase.errorCode))
  }

  const knownHits = known.filter(result => result.hit).length
  const correctHints = known.filter((result, index) => result.injected.includes(FIXES[Math.floor(index / 2)]!.hint)).length
  const falseHits = unknown.filter(result => result.hit).length
  const injectedChars = [...known, ...unknown].reduce((sum, result) => sum + result.chars, 0)
  const maxInjectedChars = Math.max(0, ...known.map(result => result.chars))

  const result = {
    experiment: 'repair-bench',
    generatedAt: new Date().toISOString(),
    hypothesis: 'Signature-normalized repair hints recorded once are retrieved in a later session for recurring errors, without injecting hints for unrelated errors.',
    recordedRepairs: recorded.length,
    simulatedErrors: known.length + unknown.length,
    known: {
      cases: known.length,
      hits: knownHits,
      hitRate: round(knownHits / known.length),
      correctHints,
      correctHintRate: round(correctHints / known.length),
      injectedChars: known.reduce((sum, item) => sum + item.chars, 0),
      avgInjectedChars: round(known.reduce((sum, item) => sum + item.chars, 0) / known.length),
      maxInjectedChars,
    },
    unknown: {
      cases: unknown.length,
      falseHits,
      falsePositiveRate: round(falseHits / unknown.length),
      injectedChars: unknown.reduce((sum, item) => sum + item.chars, 0),
    },
    totalInjectedChars: injectedChars,
    recorded,
    details: {
      known: known.map(item => ({ tool: item.tool, errorCode: item.errorCode, hit: item.hit, chars: item.chars })),
      unknown: unknown.map(item => ({ tool: item.tool, errorCode: item.errorCode, hit: item.hit, chars: item.chars })),
    },
  }

  const resultsDir = join(import.meta.dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'repair-bench.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log('Cross-session repair memory benchmark')
  console.log(`recorded repairs      ${recorded.length}`)
  console.log(`known errors          ${knownHits}/${known.length} hit (${(result.known.hitRate * 100).toFixed(1)}%)`)
  console.log(`correct hints         ${correctHints}/${known.length} (${(result.known.correctHintRate * 100).toFixed(1)}%)`)
  console.log(`unknown errors        ${falseHits}/${unknown.length} false hit(s) (${(result.unknown.falsePositiveRate * 100).toFixed(1)}%)`)
  console.log(`injected characters   ${injectedChars} total, ${result.known.avgInjectedChars} avg/hit, ${maxInjectedChars} max`)
  console.log(`wrote ${join(resultsDir, 'repair-bench.json')}`)

  if (knownHits !== known.length || correctHints !== known.length || falseHits !== 0) {
    console.error('HYPOTHESIS NOT SUPPORTED: repair memory missed a known error, injected a wrong hint, or matched an unrelated error')
    process.exitCode = 1
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

await main()
