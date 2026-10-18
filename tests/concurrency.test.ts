/**
 * Cross-process store checks: two independent Bun processes append to the same
 * memory, repair, and knowledge files at once. The advisory lock plus reload
 * under the lock must keep every row parseable and preserve version/count
 * invariants.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const WORKER = join(import.meta.dir, 'fixtures', 'concurrent-writer.ts')
const COUNT = 25

function runWorker(mode: 'memory' | 'repairs' | 'knowledge', root: string, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, mode, root, String(COUNT), prefix], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${mode} writer ${prefix} exited ${String(code)}: ${stderr.slice(-2000)}`))
    })
  })
}

function onlyJsonl(dir: string): string {
  const names = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
  expect(names).toHaveLength(1)
  return join(dir, names[0]!)
}

function rows(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('cross-process stores', () => {
  test('memory saves from two processes are all preserved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'super-dsh-concurrent-memory-'))
    await Promise.all([
      runWorker('memory', root, 'alpha'),
      runWorker('memory', root, 'beta'),
    ])

    const entries = rows(onlyJsonl(join(root, 'memory')))
    expect(entries).toHaveLength(COUNT * 2)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(COUNT * 2)
    const texts = entries.map(entry => entry.text)
    expect(texts.filter(text => String(text).startsWith('alpha '))).toHaveLength(COUNT)
    expect(texts.filter(text => String(text).startsWith('beta '))).toHaveLength(COUNT)
  }, 30_000)

  test('repair counts include every same-signature write from two processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'super-dsh-concurrent-repairs-'))
    await Promise.all([
      runWorker('repairs', root, 'alpha'),
      runWorker('repairs', root, 'beta'),
    ])

    const records = rows(onlyJsonl(join(root, 'repairs')))
    expect(records).toHaveLength(COUNT * 2)
    const latest = records.at(-1)!
    expect(latest.successCount).toBe(COUNT * 2)
    expect(latest.signature).toBe(records[0]!.signature)
  }, 30_000)

  test('knowledge versions are contiguous and ids are unique across processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'super-dsh-concurrent-knowledge-'))
    await Promise.all([
      runWorker('knowledge', root, 'alpha'),
      runWorker('knowledge', root, 'beta'),
    ])

    const entries = rows(onlyJsonl(join(root, 'knowledge')))
    expect(entries).toHaveLength(COUNT * 2)
    expect(entries.map(entry => entry.version).sort((left, right) => Number(left) - Number(right)))
      .toEqual(Array.from({ length: COUNT * 2 }, (_, index) => index + 1))
    expect(new Set(entries.map(entry => entry.id)).size).toBe(COUNT * 2)
    expect(entries.every(entry => entry.key === 'concurrent-key')).toBe(true)
  }, 30_000)
})
