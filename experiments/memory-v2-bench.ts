/**
 * Experiment — Memory v2 consolidation.
 *
 * Generates 60 facts for one workspace: 15 unique facts (including a
 * derivedFrom dependency chain), 15 near-duplicate pairs, 5 contradiction
 * pairs resolved with `supersedes`, and 5 expired entries. It then measures
 * retrieval before and after deterministic `memory_consolidate`:
 *
 *   entries / active entries, recall@3 (predefined query -> expected fact),
 *   stale injections, and injected characters.
 *
 * The run exits with code 1 if any stale memory is injected after
 * consolidation or if recall@3 decreases.
 *
 * Run: bun experiments/memory-v2-bench.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMemory } from '../src/features/memory.ts'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import { workspaceKey } from '../src/shared.ts'
import { execWithAgent, fakeContext } from '../tests/fake-context.ts'

interface QueryCase {
  query: string
  expected: string
}

interface Measurement {
  entries: number
  activeEntries: number
  recallHits: number
  recallAt3: number
  staleInjected: number
  injectionChars: number
}

interface ConsolidateResult {
  dry_run: boolean
  merged: number
  archived: number
  promoted: number
  remaining: number
}

const agent = { session: { id: 'memory-v2-bench-session' }, followup() {} }
const dir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-v2-bench-'))
const fake = fakeContext()
applyMemory(fake.ctx, {
  memory: {
    dir,
    injectTopK: 5,
    injectMaxChars: 900,
    coreMaxChars: 260,
  },
})
const file = join(dir, `${workspaceKey()}.jsonl`)
let callSequence = 0

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool: ToolDefinitionLike | undefined = fake.tools.get(name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  callSequence++
  return tool.execute(args, execWithAgent(agent, {
    callId: `bench-${callSequence}`,
    name,
    arguments: args,
  }))
}

async function save(args: Record<string, unknown>): Promise<string> {
  const result = await call('memory_save', args)
  return String(result.id)
}

function fold(filePath: string): Map<string, Record<string, any>> {
  const rows = new Map<string, Record<string, any>>()
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as Record<string, any>
    rows.delete(row.id)
    rows.set(row.id, row)
  }
  return rows
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function lineText(line: string): string {
  return line.replace(/ \[[^\]]*\]$/, '').replace(/^- /, '')
}

async function main(): Promise<void> {
  const queries: QueryCase[] = []
  const neverActive = new Set<string>()
  const duplicatePairs: Array<[string, string]> = []
  let facts = 0

  // 15 unique facts, five of them a derivedFrom chain rooted in a core rule.
  const root = await save({
    text: 'The zephyr scheduler stores its queue in Redis.',
    tags: ['bench', 'zephyr'],
    tier: 'core',
    importance: 0.9,
  })
  facts++
  queries.push({ query: 'zephyr scheduler queue redis', expected: 'stores its queue in Redis' })

  let parent = root
  const chain = [
    {
      text: 'The zephyr scheduler retries failed jobs three times.',
      tags: ['bench', 'zephyr'],
      query: 'zephyr retries failed jobs',
      expected: 'retries failed jobs three times',
    },
    {
      text: 'Zephyr retry metadata is written to the audit log.',
      tags: ['bench', 'zephyr'],
      query: 'zephyr retry metadata audit log',
      expected: 'retry metadata is written to the audit log',
    },
    {
      text: 'The zephyr audit log rotates every night.',
      tags: ['bench', 'zephyr'],
      query: 'zephyr audit log rotates',
      expected: 'rotates every night',
    },
    {
      text: 'Zephyr audit rotation keeps seven daily files.',
      tags: ['bench', 'zephyr'],
      query: 'zephyr audit rotation files',
      expected: 'seven daily files',
    },
  ]
  for (const fact of chain) {
    parent = await save({
      text: fact.text,
      tags: fact.tags,
      derived_from: [parent],
    })
    facts++
    queries.push({ query: fact.query, expected: fact.expected })
  }

  const unique: Array<QueryCase & { text: string; tags: string[] }> = [
    {
      text: 'The quasar billing service uses Stripe webhooks for invoices.',
      tags: ['bench', 'quasar'],
      query: 'quasar billing stripe webhooks invoices',
      expected: 'Stripe webhooks',
    },
    {
      text: 'Quasar invoice retries happen after two minutes.',
      tags: ['bench', 'quasar'],
      query: 'quasar invoice retries two minutes',
      expected: 'after two minutes',
    },
    {
      text: 'The nebula search index is rebuilt with bun run index:build.',
      tags: ['bench', 'nebula'],
      query: 'rebuild nebula search index bun',
      expected: 'bun run index:build',
    },
    {
      text: 'Nebula index builds write artifacts to .cache/nebula.',
      tags: ['bench', 'nebula'],
      query: 'nebula index builds cache artifacts',
      expected: '.cache/nebula',
    },
    {
      text: 'The orion frontend uses React Server Components.',
      tags: ['bench', 'orion'],
      query: 'orion frontend react server components',
      expected: 'React Server Components',
    },
    {
      text: 'Orion component tests run with bun test --coverage.',
      tags: ['bench', 'orion'],
      query: 'orion component tests coverage',
      expected: 'bun test --coverage',
    },
    {
      text: 'The pulsar worker pool has eight processes.',
      tags: ['bench', 'pulsar'],
      query: 'pulsar worker pool processes',
      expected: 'eight processes',
    },
    {
      text: 'Pulsar workers read configuration from workers.toml.',
      tags: ['bench', 'pulsar'],
      query: 'pulsar workers configuration file',
      expected: 'workers.toml',
    },
    {
      text: 'The vega CLI writes logs to var/vega.log.',
      tags: ['bench', 'vega'],
      query: 'vega writes logs',
      expected: 'var/vega.log',
    },
    {
      text: 'The vega CLI supports a dry-run flag.',
      tags: ['bench', 'vega'],
      query: 'vega dry-run flag',
      expected: 'dry-run flag',
    },
  ]
  for (const fact of unique) {
    await save({ text: fact.text, tags: fact.tags })
    facts++
    queries.push({ query: fact.query, expected: fact.expected })
  }

  // 15 near-duplicate pairs: same tier and tag set, token-set Jaccard 0.9.
  for (let index = 0; index < 15; index++) {
    const topic = `helios-${index}`
    const first = `The ${topic} pipeline runs on every push to the release branch.`
    const second = `The ${topic} pipeline runs on every push to release branch.`
    await save({ text: first, tags: ['bench', topic] })
    await save({ text: second, tags: ['bench', topic] })
    duplicatePairs.push([first, second])
    facts += 2
    queries.push({ query: topic, expected: `${topic} pipeline` })
  }

  // 5 contradictions resolved by supersedes; the old text must never inject.
  const contradictions: Array<[number, number]> = [[30, 60], [45, 90], [10, 20], [5, 15], [120, 300]]
  for (let index = 0; index < contradictions.length; index++) {
    const [before, after] = contradictions[index]
    const topic = `sol-${index}`
    const oldText = `The ${topic} API timeout is ${before} seconds.`
    const newText = `The ${topic} API timeout is ${after} seconds.`
    const oldId = await save({ text: oldText, tags: ['bench', topic] })
    await save({
      text: newText,
      tags: ['bench', topic],
      supersedes: [oldId],
    })
    neverActive.add(oldText)
    facts += 2
    queries.push({ query: `${topic} API timeout`, expected: `${after} seconds` })
  }

  // 5 expired entries; their state stays active until consolidation archives them.
  for (let index = 0; index < 5; index++) {
    const text = `The temporary ttl-${index} benchmark credential already expired.`
    await save({
      text,
      tags: ['bench', 'ttl'],
      ttl_days: 0.000001,
    })
    neverActive.add(text)
    facts++
  }

  if (facts !== 60) throw new Error(`expected 60 facts, generated ${facts}`)
  // Let the micro-TTLs elapse.
  await sleep(200)

  const measure = async (): Promise<Measurement> => {
    const rows = [...fold(file).values()]
    let recallHits = 0
    let staleInjected = 0
    let injectionChars = 0
    for (let index = 0; index < queries.length; index++) {
      const item = queries[index]
      const result = await call('memory_search', { query: item.query, limit: 3 })
      const memories = result.memories as Array<{ text: string }>
      if (memories.some(memory => memory.text.toLowerCase().includes(item.expected.toLowerCase()))) {
        recallHits++
      }

      const next = async () => ({ kind: 'enter', messages: [] as unknown[] })
      const [decision] = await fake.emit('agent/pre-step', {
        agent,
        messages: [{ content: [{ type: 'text', text: item.query }] }],
        turn: index + 1,
        step: 1,
      }, next) as Array<{ messages: Array<{ content: Array<{ text: string }> }> }>
      const message = decision?.messages?.[decision.messages.length - 1]
      const body = message === undefined ? '' : message.content.map(part => part.text).join('\n')
      injectionChars += body.length
      const lines = body.split(/\r?\n/).map(lineText)
      for (const text of neverActive) {
        if (lines.includes(text)) staleInjected++
      }
    }
    const activeRows = rows.filter(row => row.state === 'active').length
    return {
      entries: rows.length,
      activeEntries: activeRows,
      recallHits,
      recallAt3: round(recallHits / queries.length),
      staleInjected,
      injectionChars,
    }
  }

  const before = await measure()
  const consolidation = await call('memory_consolidate', {}) as unknown as ConsolidateResult

  // After consolidation, entries absorbed by a merge are also inactive. Learn
  // which side of each pair survived from the active export.
  const activeTexts = new Set(
    String((await call('memory_export', { format: 'jsonl' })).content)
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as { text: string })
      .map(row => row.text),
  )
  for (const [first, second] of duplicatePairs) {
    if (activeTexts.has(first) && !activeTexts.has(second)) neverActive.add(second)
    else if (activeTexts.has(second) && !activeTexts.has(first)) neverActive.add(first)
  }

  const after = await measure()
  const rows = [...fold(file).values()]
  const states = rows.reduce<Record<string, number>>((counts, row) => {
    const state = String(row.state ?? 'active')
    counts[state] = (counts[state] ?? 0) + 1
    return counts
  }, {})

  const recallNotWorse = after.recallAt3 >= before.recallAt3
  const noStaleInjection = before.staleInjected === 0 && after.staleInjected === 0
  const passed = recallNotWorse && noStaleInjection
  const result = {
    experiment: 'memory-v2-bench',
    generatedAt: new Date().toISOString(),
    hypothesis: 'Deterministic consolidation removes duplicate/expired entries and reduces injected characters '
      + 'without lowering recall@3 or injecting stale memories.',
    facts,
    queries: queries.length,
    before,
    after,
    consolidation,
    states,
    delta: {
      activeEntryReduction: before.activeEntries - after.activeEntries,
      injectionCharReduction: before.injectionChars - after.injectionChars,
      recallAt3Change: round(after.recallAt3 - before.recallAt3),
    },
    passed,
  }

  const resultsDir = join(import.meta.dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'memory-v2-bench.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log('Memory v2 consolidation benchmark')
  console.log(`facts / queries      ${facts} / ${queries.length}`)
  console.log('                       before     after')
  console.log(`entries              ${String(before.entries).padStart(6)}    ${String(after.entries).padStart(6)}`)
  console.log(`active entries       ${String(before.activeEntries).padStart(6)}    ${String(after.activeEntries).padStart(6)}`)
  console.log(`recall@3             ${before.recallAt3.toFixed(3).padStart(6)}    ${after.recallAt3.toFixed(3).padStart(6)}`)
  console.log(`stale injections     ${String(before.staleInjected).padStart(6)}    ${String(after.staleInjected).padStart(6)}`)
  console.log(`injection chars      ${String(before.injectionChars).padStart(6)}    ${String(after.injectionChars).padStart(6)}`)
  console.log(`consolidate          merged ${consolidation.merged}, archived ${consolidation.archived}, `
    + `promoted ${consolidation.promoted}, remaining ${consolidation.remaining}`)
  console.log(`wrote ${join(resultsDir, 'memory-v2-bench.json')}`)

  if (!passed) {
    console.error(noStaleInjection
      ? `RECALL REGRESSION: ${before.recallAt3} -> ${after.recallAt3}`
      : `STALE INJECTION: ${before.staleInjected} before / ${after.staleInjected} after consolidation`)
    process.exitCode = 1
  }
}

await main()
