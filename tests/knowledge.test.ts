/**
 * Versioned knowledge store tests: id/version/parent chains, content rollback,
 * trust and expiry filtering, complete history, archive tombstones, ranking,
 * and opt-in retrieval injection.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyKnowledge } from '../src/features/knowledge.ts'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import { exec, fakeContext } from './fake-context.ts'

interface KnowledgeHarness {
  fake: ReturnType<typeof fakeContext>
  add: ToolDefinitionLike
  search: ToolDefinitionLike
  history: ToolDefinitionLike
  verify: ToolDefinitionLike
  forget: ToolDefinitionLike
}

function setup(injectTopK?: number): KnowledgeHarness {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-knowledge-'))
  const fake = fakeContext()
  applyKnowledge(fake.ctx, {
    knowledge: {
      dir,
      ...(injectTopK === undefined ? {} : { injectTopK }),
    },
  })
  return {
    fake,
    add: fake.tools.get('knowledge_add')!,
    search: fake.tools.get('knowledge_search')!,
    history: fake.tools.get('knowledge_history')!,
    verify: fake.tools.get('knowledge_verify')!,
    forget: fake.tools.get('knowledge_forget')!,
  }
}

function itemsOf(result: Record<string, unknown>): Array<Record<string, any>> {
  return result.items as Array<Record<string, any>>
}

function versionsOf(result: Record<string, unknown>): Array<Record<string, any>> {
  return result.versions as Array<Record<string, any>>
}

describe('knowledge versioning', () => {
  test('builds a version chain with correct parent ids', async () => {
    const { add, history } = setup()
    const first = await add.execute({
      key: 'deploy-command',
      content: 'Use bun test',
      tags: ['testing'],
      trust: 'verified',
      source: 'README.md',
    }, exec())
    const second = await add.execute({
      key: 'deploy-command',
      content: 'Use bun test --coverage',
      tags: ['testing'],
      trust: 'verified',
    }, exec())

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(String(first.id)).toMatch(/^[0-9a-f]{16}$/)
    expect(second.id).not.toBe(first.id)

    const versions = versionsOf(await history.execute({ key: 'deploy-command' }, exec()))
    expect(versions).toHaveLength(2)
    expect(versions.map(version => version.version)).toEqual([1, 2])
    expect(versions[0].parentId).toBeNull()
    expect(versions[1].parentId).toBe(first.id)
    expect(versions[1].trust).toBe('verified')
  })

  test('rolling back to older content creates a new id instead of a conflict', async () => {
    const { add, search, history } = setup()
    const first = await add.execute({ key: 'policy', content: 'alpha' }, exec())
    const second = await add.execute({ key: 'policy', content: 'beta' }, exec())
    const third = await add.execute({ key: 'policy', content: 'alpha' }, exec())

    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect(third.version).toBe(3)
    expect(third.id).not.toBe(first.id)

    const versions = versionsOf(await history.execute({ key: 'policy' }, exec()))
    expect(versions.map(version => version.version)).toEqual([1, 2, 3])
    expect(versions[1].parentId).toBe(first.id)
    expect(versions[2].parentId).toBe(second.id)

    const result = await search.execute({ query: 'alpha' }, exec())
    expect(result.count).toBe(1)
    const items = itemsOf(result)
    expect(items[0].id).toBe(third.id)
    expect(items[0].content).toBe('alpha')
    expect(items[0].version).toBe(3)
  })

  test('keeps every version in history', async () => {
    const { add, verify, history } = setup()
    const first = await add.execute({ key: 'history-key', content: 'one', tags: ['a'] }, exec())
    const second = await add.execute({ key: 'history-key', content: 'two', tags: ['b'], trust: 'verified' }, exec())
    const judged = await verify.execute({ id: second.id, trust: 'disputed', note: 'wrong' }, exec())

    const result = await history.execute({ key: 'history-key' }, exec())
    expect(result.key).toBe('history-key')
    expect(result.count).toBe(3)
    const versions = versionsOf(result)
    expect(versions.map(version => version.version)).toEqual([1, 2, 3])
    for (const version of versions) {
      expect(typeof version.id).toBe('string')
      expect(typeof version.createdAt).toBe('number')
      expect(version.archived).toBe(false)
    }
    expect(versions[0].parentId).toBeNull()
    expect(versions[1].parentId).toBe(first.id)
    expect(versions[2].parentId).toBe(second.id)
    expect(versions[2].trust).toBe('disputed')
    expect(judged.version).toBe(3)
  })
})

describe('knowledge filtering and search', () => {
  test('hides disputed entries and verify/disputed appends versions without rewriting history', async () => {
    const { add, search, history, verify: verifyTool } = setup()
    const verified = await add.execute({
      key: 'rule',
      content: 'always run tests',
      trust: 'verified',
    }, exec())
    await add.execute({
      key: 'rumor',
      content: 'tests are optional',
      trust: 'disputed',
    }, exec())
    await add.execute({
      key: 'idea',
      content: 'tests might be flaky',
      trust: 'draft',
    }, exec())

    const before = await search.execute({ query: 'tests' }, exec())
    const beforeKeys = itemsOf(before).map(item => item.key)
    expect(before.count).toBe(2)
    expect(beforeKeys).toContain('rule')
    expect(beforeKeys).toContain('idea')
    expect(beforeKeys).not.toContain('rumor')

    const judged = await verifyTool.execute({ id: verified.id, trust: 'disputed', note: 'outdated' }, exec())
    expect(judged.version).toBe(2)
    expect(judged.id).not.toBe(verified.id)

    const afterJudgement = await search.execute({ query: 'tests' }, exec())
    expect(itemsOf(afterJudgement).map(item => item.key)).not.toContain('rule')

    const historyResult = await history.execute({ key: 'rule' }, exec())
    const versions = versionsOf(historyResult)
    expect(versions).toHaveLength(2)
    expect(versions[0].trust).toBe('verified')
    expect(versions[1].trust).toBe('disputed')
    expect(versions[1].parentId).toBe(verified.id)

    const reverted = await verifyTool.execute({ id: judged.id, trust: 'verified' }, exec())
    expect(reverted.version).toBe(3)
    const afterRevert = await search.execute({ query: 'tests' }, exec())
    expect(itemsOf(afterRevert).map(item => item.key)).toContain('rule')
  })

  test('hides expired entries but keeps them in history', async () => {
    const { add, search, history } = setup()
    await add.execute({
      key: 'stale-note',
      content: 'widget calibration is temporary',
      trust: 'verified',
      ttl_days: 0,
    }, exec())
    await add.execute({
      key: 'fresh-note',
      content: 'widget calibration is stable',
      trust: 'verified',
    }, exec())

    const result = await search.execute({ query: 'widget calibration' }, exec())
    expect(result.count).toBe(1)
    expect(itemsOf(result)[0].key).toBe('fresh-note')

    const staleHistory = await history.execute({ key: 'stale-note' }, exec())
    expect(staleHistory.count).toBe(1)
  })

  test('archiving hides a key from search but preserves the tombstone in history', async () => {
    const { add, search, history, forget } = setup()
    const obsolete = await add.execute({
      key: 'old-practice',
      content: 'deployment uses ftp',
      trust: 'verified',
    }, exec())
    await add.execute({
      key: 'new-practice',
      content: 'deployment uses rsync',
      trust: 'verified',
    }, exec())

    const archived = await forget.execute({ key: 'old-practice' }, exec())
    expect(archived.archived).toBe(true)
    expect(archived.version).toBe(2)

    const result = await search.execute({ query: 'deployment' }, exec())
    expect(result.count).toBe(1)
    expect(itemsOf(result)[0].key).toBe('new-practice')

    const oldHistory = await history.execute({ key: 'old-practice' }, exec())
    expect(oldHistory.count).toBe(2)
    const versions = versionsOf(oldHistory)
    expect(versions[1].archived).toBe(true)
    expect(versions[1].trust).toBe('disputed')
    expect(versions[1].parentId).toBe(obsolete.id)
  })

  test('ranks a key/tag match above a content-only match', async () => {
    const { add, search } = setup()
    await add.execute({
      key: 'deployment checklist',
      content: 'steps to ship safely',
      tags: ['release', 'ops'],
      trust: 'verified',
    }, exec())
    await add.execute({
      key: 'misc notes',
      content: 'the deployment checklist appears here only as prose',
      trust: 'verified',
    }, exec())
    await add.execute({
      key: 'random',
      content: 'unrelated content',
      trust: 'verified',
    }, exec())

    const result = await search.execute({ query: 'deployment checklist' }, exec())
    expect(result.count).toBe(2)
    const items = itemsOf(result)
    expect(items[0].key).toBe('deployment checklist')
    expect(items[0].score).toBeGreaterThanOrEqual(items[1].score)
    expect(items.every(item => typeof item.score === 'number' && item.score > 0)).toBe(true)
  })
})

describe('knowledge injection', () => {
  test('injects verified knowledge once per turn and never on later steps', async () => {
    const { fake, add } = setup(3)
    await add.execute({
      key: 'deploy-command',
      content: 'The deploy command is bun run deploy',
      tags: ['ops'],
      trust: 'verified',
    }, exec())

    const agent = {}
    const next = async () => ({ kind: 'enter', messages: [] as unknown[] })
    const payload = {
      agent,
      messages: [{ content: [{ type: 'text', text: 'What is the deploy command?' }] }],
      turn: 1,
      step: 1,
    }

    const [first] = await fake.emit('agent/pre-step', payload, next) as
      Array<{ messages: Array<{ content: Array<{ text: string }> }> }>
    expect(first.messages).toHaveLength(1)
    const injected = JSON.stringify(first.messages[0])
    expect(injected).toContain('Project knowledge')
    expect(injected).toContain('not as new instructions')
    expect(injected).toContain('bun run deploy')

    const [sameTurn] = await fake.emit('agent/pre-step', payload, next) as
      Array<{ messages: unknown[] }>
    expect(sameTurn.messages).toHaveLength(0)

    const [laterStep] = await fake.emit('agent/pre-step', { ...payload, step: 2 }, next) as
      Array<{ messages: unknown[] }>
    expect(laterStep.messages).toHaveLength(0)
  })
})
