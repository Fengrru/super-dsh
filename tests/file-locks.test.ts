/**
 * Cross-process file lock tests against a real temporary lock directory.
 * No global ~/.dsh state is touched: every test passes an explicit `dir`.
 *
 * Run: bun test tests/file-locks.test.ts
 */

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireFileLocks } from '../src/file-locks.ts'
import { sha256 } from '../src/shared.ts'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function lockFileFor(dir: string, path: string): string {
  return join(dir, `${sha256(resolve(path))}.lock`)
}

function lockRecord(pid: number, owner: string, path: string, expiresAt: number) {
  return {
    pid,
    owner,
    at: Date.now() - 1_000,
    expiresAt,
    path: resolve(path),
  }
}

describe('file locks', () => {
  test('acquires one lock file per canonical path and releases it', async () => {
    const root = tempDir('super-dsh-locks-basic-')
    const dir = join(root, 'locks')
    const a = join(root, 'a.ts')
    const b = join(root, 'b.ts')

    const handle = await acquireFileLocks([b, a], { dir, owner: 'test-owner' })
    expect(handle.locks).toEqual([resolve(a), resolve(b)].sort())

    const files = readdirSync(dir).sort()
    expect(files).toEqual([
      `${sha256(resolve(a))}.lock`,
      `${sha256(resolve(b))}.lock`,
    ].sort())

    const record = JSON.parse(readFileSync(lockFileFor(dir, a), 'utf8'))
    expect(record.pid).toBe(process.pid)
    expect(record.owner).toBe('test-owner')
    expect(record.path).toBe(resolve(a))
    expect(record.expiresAt).toBeGreaterThan(record.at)

    handle.release()
    expect(readdirSync(dir)).toHaveLength(0)

    // Release is idempotent.
    handle.release()
    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('a second contender times out and reports the holder', async () => {
    const dir = tempDir('super-dsh-locks-contention-')
    const path = join(dir, 'resource.ts')

    const first = await acquireFileLocks([path], { dir: join(dir, 'locks'), owner: 'first-host' })
    let failure: unknown
    try {
      await acquireFileLocks([path], {
        dir: join(dir, 'locks'),
        owner: 'second-host',
        timeoutMs: 120,
      })
    } catch (error: unknown) {
      failure = error
    }

    expect(failure).toBeDefined()
    const message = String((failure as Error).message)
    expect(message).toContain('file lock timeout')
    expect(message).toContain('first-host')
    expect(message).toContain(String(process.pid))
    expect(message).toContain(resolve(path))

    first.release()
    const afterRelease = await acquireFileLocks([path], {
      dir: join(dir, 'locks'),
      owner: 'second-host',
      timeoutMs: 500,
    })
    afterRelease.release()
  })

  test('takes over an expired lock and leaves the old owner unable to release it', async () => {
    const root = tempDir('super-dsh-locks-stale-')
    const dir = join(root, 'locks')
    const path = join(root, 'stale.ts')
    const stale = await acquireFileLocks([path], { dir, owner: 'stale-owner', ttlMs: 60_000 })
    const file = lockFileFor(dir, path)

    // Force the recorded TTL into the past while keeping a live pid.
    writeFileSync(file, JSON.stringify({
      ...JSON.parse(readFileSync(file, 'utf8')),
      expiresAt: Date.now() - 1,
    }))

    const takeover = await acquireFileLocks([path], {
      dir,
      owner: 'new-owner',
      timeoutMs: 500,
    })
    const record = JSON.parse(readFileSync(file, 'utf8'))
    expect(record.owner).toBe('new-owner')
    expect(record.pid).toBe(process.pid)

    // The stale handle no longer owns the file, so its release must not remove
    // the new owner's lock.
    stale.release()
    expect(existsSync(file)).toBe(true)

    takeover.release()
    expect(existsSync(file)).toBe(false)
  })

  test('takes over a lock whose owner process no longer exists', async () => {
    const root = tempDir('super-dsh-locks-dead-')
    const lockDir = join(root, 'locks')
    const path = join(root, 'dead.ts')
    // A pid that cannot exist; process.kill throws and the lock is stale.
    const deadPid = 2_147_483_647
    const file = join(lockDir, `${sha256(resolve(path))}.lock`)
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(file, JSON.stringify(lockRecord(deadPid, 'dead-owner', path, Date.now() + 60_000)))

    const handle = await acquireFileLocks([path], { dir: lockDir, owner: 'live-owner', timeoutMs: 500 })
    expect(JSON.parse(readFileSync(file, 'utf8')).owner).toBe('live-owner')
    handle.release()
    expect(existsSync(file)).toBe(false)
  })

  test('sorts and deduplicates paths before acquiring', async () => {
    const root = tempDir('super-dsh-locks-sort-')
    const dir = join(root, 'locks')
    const a = join(root, 'a.ts')
    const b = join(root, 'b.ts')
    const c = join(root, 'c.ts')

    const handle = await acquireFileLocks([c, a, b, a, c], { dir })
    expect(handle.locks).toEqual([resolve(a), resolve(b), resolve(c)])
    expect(readdirSync(dir)).toHaveLength(3)
    handle.release()
  })

  test('release only removes lock files still owned by this pid and owner', async () => {
    const root = tempDir('super-dsh-locks-owner-')
    const dir = join(root, 'locks')
    const path = join(root, 'owned.ts')
    const handle = await acquireFileLocks([path], { dir, owner: 'mine' })
    const file = lockFileFor(dir, path)

    // Simulate a takeover after a stale judgement: the file is now someone
    // else's, even though this closure is still open.
    writeFileSync(file, JSON.stringify(lockRecord(process.pid, 'someone-else', path, Date.now() + 60_000)))
    handle.release()
    expect(existsSync(file)).toBe(true)
    unlinkSync(file)
  })

  test('uses a custom lock directory and ignores an empty paths list', async () => {
    const root = tempDir('super-dsh-locks-custom-')
    const dir = join(root, 'custom-locks')
    const path = join(root, 'file.ts')

    const empty = await acquireFileLocks([], { dir })
    expect(empty.locks).toEqual([])
    empty.release()

    const handle = await acquireFileLocks([path], { dir })
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(existsSync(lockFileFor(dir, path))).toBe(true)
    handle.release()
  })
})
