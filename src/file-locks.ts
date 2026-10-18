/**
 * Cross-process advisory file locks.
 *
 * dsh may run several agents, sessions, or plugin hosts against the same
 * workspace at once. `apply_patch` needs a lock per target file so two hosts
 * cannot read the same pre-image and then overwrite each other's result.
 *
 * Protocol: one JSON file per canonical path, named
 * `sha256(resolve(path)).lock` inside a shared lock directory. Lock files are
 * created with `openSync(file, 'wx')`, which is atomic on every supported
 * platform. A lock is stale when its TTL expired or when its owner process no
 * longer exists; a stale file is removed and creation is retried.
 *
 * A waiter polls with a small randomized delay (25-50ms). Paths are acquired
 * in sorted order, so two callers that lock overlapping sets cannot form an
 * acquisition cycle (deadlock). If any acquisition fails, every lock already
 * taken by this call is released before the error is thrown.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { dshHome, sha256 } from './shared.ts'

export interface FileLockOptions {
  /** Lock directory. Default: `<dsh home>/super-dsh/locks`. */
  dir?: string
  /** Identity recorded in the lock file. Default: unique per acquisition. */
  owner?: string
  /** Total time allowed for acquiring every path. Default: 5000ms. */
  timeoutMs?: number
  /** Lock lifetime after which it is considered stale. Default: 120000ms. */
  ttlMs?: number
}

export interface FileLockHandle {
  /** Idempotent best-effort release; never throws. */
  release(): void
  /**
   * Canonical absolute paths whose locks are held, sorted and deduplicated.
   * The corresponding lock files live in `dir` under hashed names.
   */
  locks: string[]
}

interface LockRecord {
  pid: number
  owner: string
  at: number
  expiresAt: number
  path: string
}

interface LockInspection {
  stale: boolean
  record?: LockRecord
  /** Exact bytes observed; used to avoid deleting a successor's fresh lock. */
  raw: string
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_TTL_MS = 120_000
const POLL_MIN_MS = 25
const POLL_JITTER_MS = 25

export async function acquireFileLocks(
  paths: string[],
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  const targets = [...new Set(paths.map(path => resolvePath(path)))].sort()
  if (targets.length === 0) return { release() {}, locks: [] }

  const dir = lockDirectory(options.dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const owner = typeof options.owner === 'string' && options.owner.length > 0
    ? options.owner
    : `super-dsh-${process.pid}-${randomUUID()}`
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const ttlMs = normalizeTtl(options.ttlMs)
  const deadline = Date.now() + timeoutMs

  const heldFiles: string[] = []
  try {
    for (const target of targets) {
      const lockFile = join(dir, `${sha256(target)}.lock`)
      const record: LockRecord = {
        pid: process.pid,
        owner,
        at: Date.now(),
        expiresAt: Date.now() + ttlMs,
        path: target,
      }

      for (;;) {
        if (tryCreateLock(lockFile, record)) {
          heldFiles.push(lockFile)
          break
        }

        const inspection = inspectLock(lockFile, ttlMs)
        // The holder released between our create attempt and the read: retry
        // immediately instead of sleeping.
        if (inspection === undefined) continue

        if (inspection.stale) {
          removeStaleLock(lockFile, inspection.raw)
          continue
        }

        if (Date.now() >= deadline) {
          throw lockTimeoutError(target, lockFile, inspection.record, timeoutMs)
        }
        await sleep(POLL_MIN_MS + Math.floor(Math.random() * POLL_JITTER_MS))
      }
    }
  } catch (error: unknown) {
    releaseOwnedLocks(heldFiles, owner)
    throw error
  }

  let released = false
  return {
    locks: targets,
    release() {
      if (released) return
      released = true
      releaseOwnedLocks(heldFiles, owner)
    },
  }
}

/**
 * Run a read-modify-write against one file while holding its advisory lock.
 * The callback runs after acquisition, so it observes the latest committed
 * contents; release is guaranteed even when the callback throws.
 */
export async function withFileLock<T>(
  path: string,
  callback: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLocks([path], options)
  try {
    return await callback()
  } finally {
    lock.release()
  }
}

function lockDirectory(dir: string | undefined): string {
  if (typeof dir === 'string' && dir.length > 0) return resolvePath(dir)
  return join(dshHome(), 'super-dsh', 'locks')
}

/** Atomically create the lock file. Returns false when another holder won. */
function tryCreateLock(file: string, record: LockRecord): boolean {
  let fd: number
  try {
    fd = openSync(file, 'wx')
  } catch (error: unknown) {
    // Windows may report EPERM instead of EEXIST when two processes race to
    // create the same lock. Treat it as contention and retry; a persistent
    // permission problem becomes a lock timeout rather than a hard crash.
    if (isErrno(error, 'EEXIST') || isErrno(error, 'EPERM')) return false
    throw error
  }

  try {
    writeFileSync(fd, JSON.stringify(record))
  } catch (error: unknown) {
    try {
      closeSync(fd)
    } catch {
      // The write failure is the interesting error.
    }
    try {
      unlinkSync(file)
    } catch {
      // Best effort: do not mask the write failure.
    }
    throw error
  }

  try {
    closeSync(fd)
  } catch {
    // A failed close does not invalidate the lock file; leave it for release.
  }
  return true
}

/** Read a lock file and classify it. `undefined` means it vanished. */
function inspectLock(file: string, ttlMs: number): LockInspection | undefined {
  let raw: string
  let mtimeMs: number
  try {
    raw = readFileSync(file, 'utf8')
    mtimeMs = statSync(file).mtimeMs
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EPERM')) return undefined
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }

  const record = lockRecordOf(parsed)
  if (record === undefined) {
    // A writer may be between openSync and writeFileSync. Treat the file as
    // stale only once it is older than a full TTL; unreadable is not proof of
    // death.
    return { stale: Date.now() - mtimeMs > ttlMs, raw }
  }

  if (record.expiresAt < Date.now()) return { stale: true, record, raw }
  if (!processExists(record.pid)) return { stale: true, record, raw }
  return { stale: false, record, raw }
}

/**
 * Best-effort removal of a lock already classified as stale. The file is
 * re-read first: when another waiter replaced it in the meantime, that new
 * lock must survive.
 */
function removeStaleLock(file: string, expectedRaw: string): void {
  try {
    if (readFileSync(file, 'utf8') !== expectedRaw) return
    unlinkSync(file)
  } catch (error: unknown) {
    if (!isErrno(error, 'ENOENT') && !isErrno(error, 'EPERM') && !isErrno(error, 'EBUSY')) throw error
  }
}

/** Release only lock files this process still owns with the same owner tag. */
function releaseOwnedLocks(files: readonly string[], owner: string): void {
  for (const file of files) {
    try {
      const record = lockRecordOf(JSON.parse(readFileSync(file, 'utf8')))
      if (record === undefined) continue
      if (record.pid !== process.pid || record.owner !== owner) continue
      unlinkSync(file)
    } catch {
      // Missing, unreadable, or replaced by another holder: nothing safe to do.
    }
  }
}

function lockRecordOf(value: unknown): LockRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid)) return undefined
  if (typeof record.owner !== 'string') return undefined
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return undefined
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return undefined
  if (typeof record.path !== 'string') return undefined
  return {
    pid: record.pid,
    owner: record.owner,
    at: record.at,
    expiresAt: record.expiresAt,
    path: record.path,
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockTimeoutError(
  target: string,
  lockFile: string,
  record: LockRecord | undefined,
  timeoutMs: number,
): Error {
  const holder = record === undefined
    ? `the lock file is unreadable or malformed (${lockFile})`
    : `held by pid ${record.pid} owner "${record.owner}" until ${new Date(record.expiresAt).toISOString()} (${lockFile})`
  return new Error(`file lock timeout after ${timeoutMs}ms for ${target}: ${holder}`)
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS
}

function normalizeTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TTL_MS
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === code
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}
