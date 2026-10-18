/**
 * Experiment 4 — tamper evidence for the audit ledger.
 *
 * Baseline: a plain append-only JSONL log with no integrity metadata.
 * Treatment: SuperDSH's hash-chained ledger plus a head anchor.
 *
 * Scenarios: record edit, record deletion, tail truncation, record reordering.
 * A hash chain detects all four; a plain log detects none.
 *
 * Run: bun experiments/audit-bench.ts
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyAudit } from '../src/features/audit.ts'
import type { PluginContext, ToolDefinitionLike } from '../src/plugin-types.ts'

const N = 200

function fakeContext(): {
  ctx: PluginContext
  tools: Map<string, ToolDefinitionLike>
  handlers: Map<string, Array<(...args: any[]) => any>>
  emit(event: string, ...args: unknown[]): Promise<unknown[]>
} {
  const tools = new Map<string, ToolDefinitionLike>()
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  const ctx = {
    tools: { register(definition: ToolDefinitionLike) { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section() { return () => {} } },
    fs: {
      resolve: async () => ({}),
      readText: async () => '',
      editText: async () => ({ before: '', after: '', version: 1 }),
    },
    on(event: string, listener: (...args: any[]) => any) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return () => {}
    },
    logger: { warn() {}, info() {} },
  } as unknown as PluginContext
  return {
    ctx,
    tools,
    handlers,
    async emit(event, ...args) {
      const results: unknown[] = []
      for (const handler of handlers.get(event) ?? []) results.push(await handler(...args))
      return results
    },
  }
}

function makeEvents(count: number): Array<{ seq: number; time: number; type: string; data: unknown }> {
  const types = ['turn/start', 'step/start', 'tool/call', 'tool/result', 'step/end', 'turn/end']
  return Array.from({ length: count }, (_, seq) => ({
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    type: types[seq % types.length],
    data: seq % types.length === 2
      ? { name: 'edit', callId: `call-${seq}`, arguments: { file_path: 'src/app.ts' } }
      : { turn: Math.floor(seq / 10), step: seq % 10 },
  }))
}

function verifyPlain(file: string): { ok: boolean; reason?: string } {
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    for (const line of lines) JSON.parse(line)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
}

function tamper(file: string, kind: string): void {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const records = lines.map(line => JSON.parse(line) as Record<string, any>)
  switch (kind) {
    case 'edit':
      records[Math.floor(records.length / 2)].type = 'forged/type'
      break
    case 'delete': {
      const index = Math.floor(records.length / 3)
      records.splice(index, 1)
      break
    }
    case 'truncate':
      records.pop()
      break
    case 'reorder': {
      const index = Math.floor(records.length / 4)
      const [moved] = records.splice(index, 1)
      records.splice(index + 3, 0, moved)
      break
    }
    default:
      throw new Error(`unknown tamper kind ${kind}`)
  }
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-bench-'))
  const auditDir = join(dir, 'audit')
  const base = fakeContext()
  applyAudit(base.ctx, { audit: { dir: auditDir } })
  const events = makeEvents(N)
  const session = { id: 'audit-bench-session' }

  const started = performance.now()
  for (const event of events) await base.emit('session/event', session, event)
  const appendMs = performance.now() - started

  const ledgerFile = join(auditDir, 'audit-bench-session-9e9894d7.jsonl')
  const plainFile = join(dir, 'plain.jsonl')
  writeFileSync(plainFile, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')

  const verifyTool = base.tools.get('audit_verify')!
  const valid = await verifyTool.execute({ session_id: 'audit-bench-session' }, {
    callId: 'check',
    name: 'audit_verify',
    arguments: {},
    signal: new AbortController().signal,
  }) as { ok: boolean; ledgers: Array<{ records: number; ok: boolean }> }

  const scenarios: Array<{ kind: string; chainDetected: boolean; plainDetected: boolean; chainReason: string }> = []
  for (const kind of ['edit', 'delete', 'truncate', 'reorder']) {
    // Rebuild a fresh ledger for each scenario so mutations do not stack.
    const scenarioDir = join(dir, `audit-${kind}`)
    const scenario = fakeContext()
    applyAudit(scenario.ctx, { audit: { dir: scenarioDir } })
    for (const event of events) await scenario.emit('session/event', session, event)
    const chainFile = join(scenarioDir, 'audit-bench-session-9e9894d7.jsonl')
    tamper(chainFile, kind)
    const chainResult = await scenario.tools.get('audit_verify')!.execute(
      { session_id: 'audit-bench-session' },
      { callId: 'check', name: 'audit_verify', arguments: {}, signal: new AbortController().signal },
    ) as { ok: boolean; ledgers: Array<{ reason?: string }> }

    const plainCopy = join(dir, `plain-${kind}.jsonl`)
    writeFileSync(plainCopy, readFileSync(plainFile, 'utf8'), 'utf8')
    tamper(plainCopy, kind)
    const plainResult = verifyPlain(plainCopy)

    scenarios.push({
      kind,
      chainDetected: chainResult.ok === false,
      plainDetected: plainResult.ok === false,
      chainReason: chainResult.ledgers[0]?.reason ?? '',
    })
  }

  const result = {
    experiment: 'audit-bench',
    generatedAt: new Date().toISOString(),
    hypothesis: 'A hash-chained ledger with a head anchor detects record edits, deletions, truncation, and reordering; a plain JSONL log detects none of them.',
    records: N,
    appendMs: Math.round(appendMs),
    appendPerSecond: Math.round(N / (appendMs / 1000)),
    validLedger: valid.ok && valid.ledgers[0]?.records === N,
    scenarios,
    detectionRate: scenarios.filter(scenario => scenario.chainDetected).length / scenarios.length,
    plainDetectionRate: scenarios.filter(scenario => scenario.plainDetected).length / scenarios.length,
  }
  const resultsDir = join(import.meta.dir, 'results')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'audit-bench.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log('Audit ledger integrity benchmark')
  console.log(`records              ${N}`)
  console.log(`append throughput    ${result.appendPerSecond} records/s`)
  console.log(`valid ledger         ${result.validLedger ? 'OK' : 'FAILED'}`)
  console.log('tamper scenario        chain   plain')
  for (const scenario of scenarios) {
    console.log(`${scenario.kind.padEnd(22)} ${(scenario.chainDetected ? 'detect' : 'miss').padStart(6)}  ${(scenario.plainDetected ? 'detect' : 'miss').padStart(5)}  ${scenario.chainReason}`)
  }
  console.log(`wrote ${join(resultsDir, 'audit-bench.json')}`)

  if (!result.validLedger || result.detectionRate < 1) {
    console.error('HYPOTHESIS NOT SUPPORTED: chain did not detect every tamper scenario')
    process.exitCode = 1
  }
}

await main()
