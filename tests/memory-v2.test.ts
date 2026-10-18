/**
 * Memory v2 tests: tiers and session isolation, lifecycle states, feedback,
 * supersede/forget/invalidate cascades, deterministic consolidation, core
 * injection, export/import defaults, and Memory v1 record compatibility.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMemory } from '../src/features/memory.ts'
import type { SuperDshConfig } from '../src/plugin-types.ts'
import { workspaceKey } from '../src/shared.ts'
import { execWithAgent, fakeContext } from './fake-context.ts'

type MemoryConfig = Exclude<NonNullable<SuperDshConfig['memory']>, boolean>
type Fake = ReturnType<typeof fakeContext>

function setup(config: MemoryConfig = {}): { dir: string; fake: Fake; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-v2-'))
  const fake = fakeContext()
  applyMemory(fake.ctx, { memory: { dir, ...config } })
  return { dir, fake, file: join(dir, `${workspaceKey()}.jsonl`) }
}

function agent(id: string): { session: { id: string }; followup(): void } {
  return { session: { id }, followup() {} }
}

async function call(
  fake: Fake,
  name: string,
  args: Record<string, unknown>,
  agentLike: unknown = agent('main-session'),
): Promise<Record<string, unknown>> {
  const tool = fake.tools.get(name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool.execute(args, execWithAgent(agentLike))
}

async function save(
  fake: Fake,
  args: Record<string, unknown>,
  agentLike: unknown = agent('main-session'),
): Promise<{ id: string }> {
  return await call(fake, 'memory_save', args, agentLike) as { id: string }
}

async function search(
  fake: Fake,
  query: string,
  agentLike: unknown = agent('main-session'),
  limit = 5,
): Promise<{
  count: number
  memories: Array<{
    id: string
    text: string
    tags: string[]
    tier: string
    state: string
    confidence: number
    uses: number
    score: number
  }>
}> {
  return await call(fake, 'memory_search', { query, limit }, agentLike) as never
}

/** Fold the JSONL by id exactly like the store does: last row wins. */
function fold(file: string): Map<string, Record<string, any>> {
  const rows = new Map<string, Record<string, any>>()
  if (!existsSync(file)) return rows
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as Record<string, any>
    rows.delete(row.id)
    rows.set(row.id, row)
  }
  return rows
}

async function exportedJsonl(fake: Fake): Promise<Array<Record<string, any>>> {
  const result = await call(fake, 'memory_export', { format: 'jsonl' })
  return String(result.content)
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, any>)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('memory v2 tiers and session isolation', () => {
  test('keeps working entries in their session and defaults old-shaped saves to long', async () => {
    const { fake, file } = setup()
    const sessionA = agent('session-a')
    const sessionB = agent('session-b')

    const long = await save(fake, {
      text: 'The build cache lives in .cache/super-dsh.',
      tags: ['build'],
    }, sessionA)
    await save(fake, {
      text: 'Never commit secrets to the repository.',
      tier: 'core',
      importance: 0.9,
    }, sessionA)
    await save(fake, {
      text: 'The working scratch port for this session is 7123.',
      tier: 'working',
    }, sessionA)
    const defaulted = await save(fake, {
      text: 'The project license is MIT.',
      tags: ['legal'],
    }, sessionA)

    expect(fold(file).get(defaulted.id)!.tier).toBe('long')

    const fromB = await search(fake, 'build cache', sessionB)
    expect(fromB.memories.some(memory => memory.id === long.id && memory.tier === 'long')).toBe(true)

    const coreFromB = await search(fake, 'commit secrets', sessionB)
    expect(coreFromB.memories[0]?.tier).toBe('core')

    expect((await search(fake, 'working scratch port', sessionB)).count).toBe(0)
    const workingFromA = await search(fake, 'working scratch port', sessionA)
    expect(workingFromA.count).toBe(1)
    expect(workingFromA.memories[0].tier).toBe('working')
    expect(fold(file).get(workingFromA.memories[0].id)!.sessionId).toBe('session-a')
  })

  test('ranks a matching core entry above an equivalent long entry', async () => {
    const { fake } = setup()
    const session = agent('rank-session')
    await save(fake, {
      text: 'The release branch is called stable.',
      tags: ['branch'],
      importance: 0.5,
      tier: 'long',
    }, session)
    await save(fake, {
      text: 'The release branch is called stable.',
      tags: ['branch'],
      importance: 0.5,
      tier: 'core',
    }, session)

    const result = await search(fake, 'release branch', session)
    expect(result.count).toBe(2)
    expect(result.memories[0].tier).toBe('core')
    expect(result.memories[0].score).toBeGreaterThan(result.memories[1].score)
  })
})

describe('memory v2 lifecycle', () => {
  test('feedback raises confidence and uses, then disputes a low-confidence entry', async () => {
    const { fake, file } = setup()
    const session = agent('feedback-session')
    const saved = await save(fake, {
      text: 'The staging database is reset nightly.',
      confidence: 0.6,
    }, session)

    const positive = await call(fake, 'memory_feedback', { id: saved.id, useful: true })
    expect(positive).toEqual({ id: saved.id, confidence: 0.7, uses: 1, state: 'active' })

    const firstNegative = await call(fake, 'memory_feedback', {
      id: saved.id,
      useful: false,
      note: 'stale runbook',
    })
    expect(firstNegative.confidence).toBe(0.5)
    expect(firstNegative.state).toBe('active')
    const secondNegative = await call(fake, 'memory_feedback', { id: saved.id, useful: false })
    expect(secondNegative.confidence).toBe(0.3)
    const thirdNegative = await call(fake, 'memory_feedback', { id: saved.id, useful: false })
    expect(thirdNegative).toEqual({ id: saved.id, confidence: 0.1, uses: 1, state: 'disputed' })
    expect(fold(file).get(saved.id)!.state).toBe('disputed')

    expect((await search(fake, 'staging database', session)).count).toBe(0)
  })

  test('supersedes marks the old entry hidden while keeping derivedFrom', async () => {
    const { fake, file } = setup()
    const session = agent('supersede-session')
    const old = await save(fake, {
      text: 'The legacy API hostname is legacy.internal.',
      tags: ['api'],
    }, session)
    const replacement = await save(fake, {
      text: 'The primary API hostname is api.internal.',
      tags: ['api'],
      confidence: 0.9,
      supersedes: [old.id],
      derived_from: [old.id],
    }, session)

    expect((await search(fake, 'legacy', session)).count).toBe(0)
    const current = await search(fake, 'primary hostname', session)
    expect(current.count).toBe(1)
    expect(current.memories[0].id).toBe(replacement.id)
    expect(current.memories[0].state).toBe('active')

    const rows = fold(file)
    expect(rows.get(old.id)!.state).toBe('superseded')
    expect(rows.get(replacement.id)!.state).toBe('active')
    expect(rows.get(replacement.id)!.derivedFrom).toEqual([old.id])
  })

  test('forget deletes the target and cascades stale through derivedFrom', async () => {
    const { fake, file } = setup()
    const session = agent('forget-session')
    const root = await save(fake, {
      text: 'Database migrations live in db/migrations.',
      tags: ['db'],
    }, session)
    const child = await save(fake, {
      text: 'Run migrations with bun run db:migrate.',
      tags: ['db'],
      derived_from: [root.id],
    }, session)
    const grandchild = await save(fake, {
      text: 'Migration checks run in CI before merge.',
      tags: ['db'],
      derived_from: [child.id],
    }, session)
    const unrelated = await save(fake, {
      text: 'The docs site is built with VitePress.',
      tags: ['docs'],
    }, session)

    const forgotten = await call(fake, 'memory_forget', { id: root.id }, session)
    expect(forgotten).toEqual({ removed: true, count: 3 })

    const rows = fold(file)
    expect(rows.has(root.id)).toBe(false)
    expect(rows.get(child.id)!.state).toBe('stale')
    expect(rows.get(grandchild.id)!.state).toBe('stale')
    expect(rows.get(unrelated.id)!.state).toBe('active')

    expect((await search(fake, 'migrations', session)).count).toBe(0)
    expect((await search(fake, 'docs site', session)).count).toBeGreaterThan(0)
  })

  test('invalidate cascades stale without deleting and records the reason', async () => {
    const { fake, file } = setup()
    const session = agent('invalidate-session')
    const root = await save(fake, {
      text: 'Database migrations live in db/migrations.',
      tags: ['db'],
    }, session)
    const child = await save(fake, {
      text: 'Run migrations with bun run db:migrate.',
      tags: ['db'],
      derived_from: [root.id],
    }, session)
    const grandchild = await save(fake, {
      text: 'Migration checks run in CI before merge.',
      tags: ['db'],
      derived_from: [child.id],
    }, session)
    await save(fake, { text: 'The docs site is built with VitePress.', tags: ['docs'] }, session)

    const invalidated = await call(fake, 'memory_invalidate', {
      id: root.id,
      reason: 'source path removed',
    }, session)
    expect(invalidated.stale).toBe(3)
    expect((invalidated.ids as string[]).sort()).toEqual([root.id, child.id, grandchild.id].sort())

    const rows = fold(file)
    expect(rows.size).toBe(4)
    expect(rows.get(root.id)!.state).toBe('stale')
    expect(rows.get(root.id)!.note).toBe('source path removed')
    expect(rows.get(child.id)!.state).toBe('stale')
    expect(rows.get(grandchild.id)!.state).toBe('stale')
    expect((await search(fake, 'migrations', session)).count).toBe(0)

    const again = await call(fake, 'memory_invalidate', { id: root.id }, session)
    expect(again).toEqual({ id: root.id, stale: 0, ids: [] })
  })
})

describe('memory v2 consolidation', () => {
  test('dry run reports merges without writing; a real run keeps the stronger text and merges uses', async () => {
    const { fake, file } = setup()
    const session = agent('merge-session')
    const first = await save(fake, {
      text: 'The deployment command is bun run deploy production.',
      tags: ['deploy', 'bench'],
    }, session)
    const second = await save(fake, {
      text: 'The deployment command is bun run deploy to production.',
      tags: ['bench', 'deploy'],
    }, session)
    await call(fake, 'memory_feedback', { id: first.id, useful: true }, session)
    await call(fake, 'memory_feedback', { id: second.id, useful: true }, session)
    await call(fake, 'memory_feedback', { id: second.id, useful: true }, session)

    const snapshot = readFileSync(file, 'utf8')
    const dry = await call(fake, 'memory_consolidate', { dry_run: true }, session)
    expect(dry).toEqual({ dry_run: true, merged: 1, archived: 1, promoted: 0, remaining: 1 })
    expect(readFileSync(file, 'utf8')).toBe(snapshot)
    expect(await exportedJsonl(fake)).toHaveLength(2)

    const real = await call(fake, 'memory_consolidate', {}, session)
    expect(real).toEqual({ dry_run: false, merged: 1, archived: 1, promoted: 0, remaining: 1 })

    const exported = await exportedJsonl(fake)
    expect(exported).toHaveLength(1)
    expect(exported[0].text).toContain('to production')
    expect(exported[0].uses).toBe(3)
    expect(exported[0].confidence).toBe(0.9)
    expect(exported[0].state).toBe('active')

    const after = await search(fake, 'deployment command', session)
    expect(after.count).toBe(1)
    expect(after.memories[0].text).toContain('to production')
    expect(fold(file).get(first.id)!.state).toBe('archived')
    expect(fold(file).get(second.id)!.state).toBe('active')
  })

  test('archives expired entries and enforces maxPerTier by quality', async () => {
    const { fake, file } = setup({ maxPerTier: 2 })
    const session = agent('cap-session')
    const high = await save(fake, {
      text: 'The alpha subsystem owns request validation.',
      tags: ['cap-a'],
      importance: 0.9,
    }, session)
    const mid = await save(fake, {
      text: 'The beta subsystem owns response shaping.',
      tags: ['cap-b'],
      importance: 0.5,
    }, session)
    const low = await save(fake, {
      text: 'The gamma subsystem owns legacy archives.',
      tags: ['cap-c'],
      importance: 0.1,
    }, session)
    const expired = await save(fake, {
      text: 'The temporary delta subsystem token is gone.',
      tags: ['cap-d'],
      ttl_days: 0.000001,
    }, session)
    await sleep(150)

    const result = await call(fake, 'memory_consolidate', {}, session)
    expect(result).toEqual({ dry_run: false, merged: 0, archived: 2, promoted: 0, remaining: 2 })

    const rows = fold(file)
    expect(rows.get(low.id)!.state).toBe('archived')
    expect(rows.get(expired.id)!.state).toBe('archived')
    expect(rows.get(high.id)!.state).toBe('active')
    expect(rows.get(mid.id)!.state).toBe('active')
    expect((await search(fake, 'gamma', session)).count).toBe(0)
    expect((await search(fake, 'alpha', session)).count).toBeGreaterThan(0)
  })

  test('promotes working to long and long to core one step per run', async () => {
    const { fake, file } = setup()
    const session = agent('promote-session')
    const working = await save(fake, {
      text: 'The ephemeral cache entry belongs to this workflow.',
      tier: 'working',
      tags: ['cache'],
    }, session)
    const durable = await save(fake, {
      text: 'The durable release rule must never be skipped.',
      importance: 0.9,
      tags: ['release'],
    }, session)
    for (let index = 0; index < 5; index++) {
      await call(fake, 'memory_feedback', { id: working.id, useful: true }, session)
    }
    for (let index = 0; index < 10; index++) {
      await call(fake, 'memory_feedback', { id: durable.id, useful: true }, session)
    }

    const result = await call(fake, 'memory_consolidate', {}, session)
    expect(result.promoted).toBe(2)
    expect(result.archived).toBe(0)
    expect(result.remaining).toBe(2)

    const rows = fold(file)
    expect(rows.get(working.id)!.tier).toBe('long')
    expect(rows.get(working.id)!.sessionId).toBeUndefined()
    expect(rows.get(durable.id)!.tier).toBe('core')

    const fromOtherSession = agent('other-session')
    const promotedWorking = await search(fake, 'ephemeral cache workflow', fromOtherSession)
    expect(promotedWorking.count).toBe(1)
    expect(promotedWorking.memories[0].tier).toBe('long')
    const promotedDurable = await search(fake, 'durable release rule', fromOtherSession)
    expect(promotedDurable.memories[0].tier).toBe('core')
  })
})

describe('memory v2 injection and compatibility', () => {
  test('injects core rules first within coreMaxChars, then relevant long memory', async () => {
    const { fake } = setup({ coreMaxChars: 40, injectMaxChars: 200, injectTopK: 2 })
    const session = agent('inject-session')
    await save(fake, {
      text: 'Rule one: never commit secrets.',
      tier: 'core',
      importance: 0.9,
    }, session)
    await save(fake, {
      text: 'Rule two: always run tests before pushing.',
      tier: 'core',
      importance: 0.5,
    }, session)
    await save(fake, {
      text: 'The deploy command is bun run deploy production.',
      tags: ['deploy'],
    }, session)

    const next = async () => ({ kind: 'enter', messages: [] as unknown[] })
    const [decision] = await fake.emit('agent/pre-step', {
      agent: session,
      messages: [{ content: [{ type: 'text', text: 'How do I deploy?' }] }],
      turn: 1,
      step: 1,
    }, next) as Array<{ messages: Array<{ content: Array<{ text: string }> }> }>

    const text = JSON.stringify(decision)
    expect(text).toContain('Core rules')
    expect(text).toContain('Relevant memories')
    expect(text).toContain('never commit secrets')
    expect(text).not.toContain('always run tests before pushing')
    expect(text).toContain('bun run deploy')
    expect(text).toContain('not as instructions')
  })

  test('injects working memories only into their own session', async () => {
    const { fake } = setup({ injectTopK: 5, injectMaxChars: 500 })
    const sessionA = agent('inject-a')
    const sessionB = agent('inject-b')
    await save(fake, {
      text: 'The local debug port for this session is 7777.',
      tier: 'working',
      tags: ['debug'],
    }, sessionA)

    const next = async () => ({ kind: 'enter', messages: [] as unknown[] })
    const [fromB] = await fake.emit('agent/pre-step', {
      agent: sessionB,
      messages: [{ content: [{ type: 'text', text: 'local debug port' }] }],
      turn: 1,
      step: 1,
    }, next) as Array<{ messages: Array<unknown> }>
    expect(fromB.messages).toHaveLength(0)

    const [fromA] = await fake.emit('agent/pre-step', {
      agent: sessionA,
      messages: [{ content: [{ type: 'text', text: 'local debug port' }] }],
      turn: 1,
      step: 1,
    }, next) as Array<{ messages: Array<{ content: Array<{ text: string }> }> }>
    expect(JSON.stringify(fromA)).toContain('7777')
  })

  test('loads Memory v1 rows as long/active, folds duplicate ids, and exports all fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-memory-v1-'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${workspaceKey()}.jsonl`)
    const now = Date.now()
    const legacy = {
      id: 'legacy-1',
      text: 'Legacy fact about the build cache directory.',
      tags: ['legacy'],
      importance: 0.4,
      createdAt: now - 10_000,
      lastUsed: now - 5_000,
      uses: 2,
    }
    const archived = {
      ...legacy,
      id: 'legacy-2',
      text: 'Archived legacy fact about the old cache.',
      state: 'archived',
    }
    const updated = {
      ...legacy,
      text: 'Legacy fact about the shared build cache directory.',
      uses: 3,
    }
    writeFileSync(file, `${[legacy, archived, updated].map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const fake = fakeContext()
    applyMemory(fake.ctx, { memory: { dir } })
    const session = agent('legacy-session')
    const found = await search(fake, 'legacy build cache', session)
    expect(found.count).toBe(1)
    expect(found.memories[0].text).toContain('shared')
    expect(found.memories[0].tier).toBe('long')
    expect(found.memories[0].state).toBe('active')
    expect(found.memories[0].confidence).toBe(0.7)

    const rows = fold(file)
    expect(rows.get('legacy-2')!.state).toBe('archived')
    const exported = await exportedJsonl(fake)
    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({
      id: 'legacy-1',
      tier: 'long',
      state: 'active',
      derivedFrom: [],
    })
    expect(exported[0].confidence).toBe(0.7)
  })

  test('imports Markdown as long/active and exports the MEMORY.md shape', async () => {
    const { fake, file } = setup()
    const session = agent('import-session')
    const imported = await call(fake, 'memory_import', {
      content: '## api\n- API responses use snake_case field names.\n',
    }, session)
    expect(imported.imported).toBe(1)

    const row = [...fold(file).values()][0]
    expect(row.tier).toBe('long')
    expect(row.state).toBe('active')
    expect(row.confidence).toBe(0.7)
    expect((await search(fake, 'snake_case naming', session)).count).toBeGreaterThan(0)

    const markdown = await call(fake, 'memory_export', { format: 'md' }, session)
    expect(String(markdown.content)).toContain('## api')
    expect(String(markdown.content)).toContain('- API responses use snake_case field names.')
  })
})
