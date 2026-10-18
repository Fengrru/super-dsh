/**
 * Deterministic checks for cold audit-ledger retention. Every test uses its
 * own temporary audit/archive pair; there is no network and no shared state.
 *
 * Run: bun test tests/retention.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'
import { applyRetention } from '../src/features/retention.ts'
import { exec, fakeContext } from './fake-context.ts'

const DAY_MS = 24 * 60 * 60 * 1000

interface Env {
  root: string
  auditDir: string
  retentionDir: string
  fake: ReturnType<typeof fakeContext>
}

interface LedgerFiles {
  jsonl: string
  head: string
  headContent: string
}

function setup(retention: {
  maxAgeDays?: number
  maxTotalBytes?: number
  deleteSource?: boolean
} = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'super-dsh-retention-'))
  const auditDir = join(root, 'audit')
  const retentionDir = join(root, 'retention')
  mkdirSync(auditDir, { recursive: true })
  const fake = fakeContext()
  applyRetention(fake.ctx, {
    audit: { dir: auditDir },
    retention: {
      dir: retentionDir,
      maxAgeDays: retention.maxAgeDays ?? 2,
      ...(retention.maxTotalBytes === undefined ? {} : { maxTotalBytes: retention.maxTotalBytes }),
      ...(retention.deleteSource === undefined ? {} : { deleteSource: retention.deleteSource }),
    },
  })
  return { root, auditDir, retentionDir, fake }
}

function tool(fake: ReturnType<typeof fakeContext>, name: string): ToolDefinitionLike {
  const definition = fake.tools.get(name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function writeLedger(
  dir: string,
  stem: string,
  content: string,
  ageDays = 5,
  withHead = true,
): LedgerFiles {
  const jsonl = join(dir, `${stem}.jsonl`)
  writeFileSync(jsonl, content, 'utf8')
  const head = `${jsonl}.head`
  const headContent = JSON.stringify({
    v: 1,
    records: content.split('\n').filter(line => line.length > 0).length,
    seq: 0,
    hash: 'a'.repeat(64),
    updatedAt: Date.now(),
  })
  if (withHead) writeFileSync(head, headContent, 'utf8')
  ageFile(jsonl, ageDays)
  if (withHead) ageFile(head, ageDays)
  return { jsonl, head, headContent }
}

function ageFile(file: string, ageDays: number): void {
  const when = new Date(Date.now() - ageDays * DAY_MS)
  utimesSync(file, when, when)
}

function readManifest(path: unknown): {
  v: number
  createdAt: string
  sourceDir: string
  deleted: boolean
  entries: Array<{
    name: string
    source: string
    sha256: string
    gzSha256: string
    bytes: number
    gzBytes: number
    mtime: number
  }>
} {
  return JSON.parse(readFileSync(String(path), 'utf8'))
}

describe('retention', () => {
  test('is opt-in and registers both tools only when retention is enabled', () => {
    const fake = fakeContext()
    applyRetention(fake.ctx, {})
    applyRetention(fake.ctx, { retention: false })
    expect(fake.tools.size).toBe(0)

    applyRetention(fake.ctx, { retention: true })
    expect(fake.tools.has('archive_ledgers')).toBe(true)
    expect(fake.tools.has('restore_archive')).toBe(true)
  })

  test('archives old ledgers and matching .head files with a verified manifest', async () => {
    const env = setup({ maxAgeDays: 2 })
    const content = '{"seq":1,"type":"a"}\n{"seq":2,"type":"b"}\n'
    const old = writeLedger(env.auditDir, 'session-old', content, 5)
    const fresh = writeLedger(env.auditDir, 'session-fresh', '{"seq":3}\n', 0)

    const result = await tool(env.fake, 'archive_ledgers').execute({}, exec())
    expect(result.ok).toBe(true)
    expect(result.archived).toBe(2)
    expect(result.deleted).toBe(0)
    expect(result.errors).toBeUndefined()
    expect(result.bytes).toBe(Buffer.byteLength(content) + Buffer.byteLength(old.headContent))

    const manifest = readManifest(result.manifest)
    expect(manifest.v).toBe(1)
    expect(manifest.sourceDir).toBe(resolve(env.auditDir))
    expect(manifest.deleted).toBe(false)
    expect(typeof manifest.createdAt).toBe('string')
    expect(manifest.entries.map(entry => entry.name)).toEqual([
      'session-old.jsonl',
      'session-old.jsonl.head',
    ])

    for (const entry of manifest.entries) {
      const sourceBytes = readFileSync(entry.source)
      expect(entry.source).toBe(resolve(join(env.auditDir, entry.name)))
      expect(entry.sha256).toBe(sha256(sourceBytes))
      expect(entry.bytes).toBe(sourceBytes.length)
      expect(entry.gzBytes).toBeGreaterThan(0)
      expect(Number.isFinite(entry.mtime)).toBe(true)

      const gz = readFileSync(join(env.retentionDir, `${entry.name}.gz`))
      expect(entry.gzSha256).toBe(sha256(gz))
      expect(gunzipSync(gz).equals(sourceBytes)).toBe(true)
    }

    // Sources are kept unless delete_source was requested.
    expect(existsSync(old.jsonl)).toBe(true)
    expect(existsSync(old.head)).toBe(true)
    expect(existsSync(fresh.jsonl)).toBe(true)
    expect(existsSync(fresh.head)).toBe(true)
    expect(existsSync(join(env.retentionDir, 'session-fresh.jsonl.gz'))).toBe(false)
  })

  test('selects one session by safeFileStem prefix without matching longer ids', async () => {
    const env = setup({ maxAgeDays: 30 })
    const wanted = writeLedger(env.auditDir, 'alpha-1234', '{"seq":1}\n', 0, false)
    const longer = writeLedger(env.auditDir, 'alphabet-5678', '{"seq":2}\n', 0, false)

    const result = await tool(env.fake, 'archive_ledgers').execute({ session_id: 'alpha' }, exec())
    expect(result.ok).toBe(true)
    expect(result.archived).toBe(1)
    expect(existsSync(join(env.retentionDir, 'alpha-1234.jsonl.gz'))).toBe(true)
    expect(existsSync(join(env.retentionDir, 'alphabet-5678.jsonl.gz'))).toBe(false)
    expect(existsSync(wanted.jsonl)).toBe(true)
    expect(existsSync(longer.jsonl)).toBe(true)
  })

  test('delete_source removes verified sources and records it in the manifest', async () => {
    const env = setup({ deleteSource: true })
    const ledger = writeLedger(env.auditDir, 'session-delete', '{"seq":1}\n{"seq":2}\n', 5)

    const result = await tool(env.fake, 'archive_ledgers').execute({}, exec())
    expect(result.ok).toBe(true)
    expect(result.archived).toBe(2)
    expect(result.deleted).toBe(2)
    expect(existsSync(ledger.jsonl)).toBe(false)
    expect(existsSync(ledger.head)).toBe(false)

    const manifest = readManifest(result.manifest)
    expect(manifest.deleted).toBe(true)
    expect(manifest.entries).toHaveLength(2)
  })

  test('honors delete_source from the tool argument when the config is false', async () => {
    const env = setup({ deleteSource: false })
    const ledger = writeLedger(env.auditDir, 'session-arg-delete', '{"seq":1}\n', 5, false)

    const result = await tool(env.fake, 'archive_ledgers').execute({ delete_source: true }, exec())
    expect(result.ok).toBe(true)
    expect(result.deleted).toBe(1)
    expect(existsSync(ledger.jsonl)).toBe(false)
    expect(readManifest(result.manifest).deleted).toBe(true)
  })

  test('restores archives to the manifest sourceDir byte-for-byte', async () => {
    const env = setup({ deleteSource: true })
    const content = '{"seq":1}\n{"seq":2,"text":"世界"}\n'
    const ledger = writeLedger(env.auditDir, 'session-restore', content, 5)
    const archived = await tool(env.fake, 'archive_ledgers').execute({}, exec())
    expect(existsSync(ledger.jsonl)).toBe(false)

    const restored = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(String(archived.manifest)),
    }, exec())
    expect(restored).toEqual({ ok: true, restored: 2, skipped: 0, errors: [] })
    expect(readFileSync(ledger.jsonl, 'utf8')).toBe(content)
    expect(readFileSync(ledger.head, 'utf8')).toBe(ledger.headContent)
  })

  test('dry_run validates every archive without writing files', async () => {
    const env = setup({ deleteSource: true })
    const ledger = writeLedger(env.auditDir, 'session-dry', '{"seq":1}\n', 5)
    const archived = await tool(env.fake, 'archive_ledgers').execute({}, exec())

    const dry = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(String(archived.manifest)),
      dry_run: true,
    }, exec())
    expect(dry).toEqual({ ok: true, restored: 0, skipped: 0, errors: [] })
    expect(existsSync(ledger.jsonl)).toBe(false)
    expect(existsSync(ledger.head)).toBe(false)

    const real = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(String(archived.manifest)),
    }, exec())
    expect(real.ok).toBe(true)
    expect(real.restored).toBe(2)
  })

  test('refuses to overwrite an existing target and keeps the existing bytes', async () => {
    const env = setup({ deleteSource: true })
    const first = writeLedger(env.auditDir, 'a-ledger', '{"old":true}\n', 5, false)
    const second = writeLedger(env.auditDir, 'b-ledger', '{"new":true}\n', 5, false)
    const archived = await tool(env.fake, 'archive_ledgers').execute({}, exec())

    writeFileSync(first.jsonl, '{"existing":true}\n', 'utf8')

    const restored = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(String(archived.manifest)),
    }, exec())
    expect(restored.ok).toBe(false)
    expect(restored.restored).toBe(1)
    expect(restored.skipped).toBe(1)
    const errors = restored.errors as string[]
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('a-ledger.jsonl')
    expect(errors[0]).toContain('not overwritten')

    expect(readFileSync(first.jsonl, 'utf8')).toBe('{"existing":true}\n')
    expect(readFileSync(second.jsonl, 'utf8')).toBe('{"new":true}\n')
  })

  test('rejects manifest path traversal, absolute paths, and unsafe entry names', async () => {
    const env = setup()
    writeLedger(env.auditDir, 'session-safe', '{"seq":1}\n', 5)
    const archived = await tool(env.fake, 'archive_ledgers').execute({}, exec())
    const restore = tool(env.fake, 'restore_archive')

    await expect(restore.execute({ manifest: '../archive-evil.json' }, exec()))
      .rejects.toThrow(/inside the retention directory/)
    await expect(restore.execute({ manifest: join(env.root, basename(String(archived.manifest))) }, exec()))
      .rejects.toThrow(/inside the retention directory/)
    await expect(restore.execute({ manifest: 'notes.json' }, exec()))
      .rejects.toThrow(/archive-/)

    // A tampered manifest entry cannot escape the source directory.
    const manifestPath = String(archived.manifest)
    const manifest = readManifest(manifestPath)
    manifest.entries[0].name = '../escape.jsonl'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const restored = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(manifestPath),
    }, exec())
    expect(restored.ok).toBe(false)
    expect(restored.restored).toBe(0)
    expect((restored.errors as string[]).length).toBeGreaterThan(0)
    expect(existsSync(join(env.root, 'escape.jsonl'))).toBe(false)
  })

  test('fails restore cleanly when a gzip archive is corrupted', async () => {
    const env = setup({ deleteSource: true })
    const ledger = writeLedger(env.auditDir, 'session-corrupt', '{"seq":1}\n', 5, false)
    const archived = await tool(env.fake, 'archive_ledgers').execute({}, exec())
    expect(existsSync(ledger.jsonl)).toBe(false)

    writeFileSync(join(env.retentionDir, 'session-corrupt.jsonl.gz'), 'not a gzip stream', 'utf8')

    const restored = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(String(archived.manifest)),
    }, exec())
    expect(restored.ok).toBe(false)
    expect(restored.restored).toBe(0)
    expect(restored.skipped).toBe(0)
    expect((restored.errors as string[]).length).toBeGreaterThan(0)
    expect(existsSync(ledger.jsonl)).toBe(false)
  })

  test('fails restore when the manifest hash does not match the archive', async () => {
    const env = setup({ deleteSource: true })
    const ledger = writeLedger(env.auditDir, 'session-hash', '{"seq":1}\n', 5, false)
    const archived = await tool(env.fake, 'archive_ledgers').execute({}, exec())

    const manifestPath = String(archived.manifest)
    const manifest = readManifest(manifestPath)
    manifest.entries[0].sha256 = '0'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const restored = await tool(env.fake, 'restore_archive').execute({
      manifest: basename(manifestPath),
    }, exec())
    expect(restored.ok).toBe(false)
    expect(restored.restored).toBe(0)
    expect(existsSync(ledger.jsonl)).toBe(false)
  })

  test('throws when nothing matches the selection', async () => {
    const env = setup({ maxAgeDays: 30 })
    writeLedger(env.auditDir, 'session-fresh', '{"seq":1}\n', 0, false)
    await expect(tool(env.fake, 'archive_ledgers').execute({}, exec()))
      .rejects.toThrow(/No audit ledger files matched/)
    await expect(tool(env.fake, 'archive_ledgers').execute({ session_id: 'missing' }, exec()))
      .rejects.toThrow(/No audit ledger files matched/)
  })

  test('uses the DSH_HOME defaults for source and archive directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'super-dsh-retention-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const auditDir = join(root, 'super-dsh', 'audit')
      mkdirSync(auditDir, { recursive: true })
      writeLedger(auditDir, 'default-old', '{"seq":1}\n', 40, false)

      const fake = fakeContext()
      applyRetention(fake.ctx, { retention: true })
      const result = await tool(fake, 'archive_ledgers').execute({}, exec())

      expect(result.ok).toBe(true)
      expect(result.archived).toBe(1)
      const retentionDir = join(root, 'super-dsh', 'retention')
      expect(String(result.manifest).startsWith(retentionDir)).toBe(true)
      expect(existsSync(join(retentionDir, 'default-old.jsonl.gz'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  test('enforces maxTotalBytes by pruning the oldest archive group', async () => {
    const env = setup({ maxTotalBytes: 1, deleteSource: true })
    writeLedger(env.auditDir, 'first-ledger', '{"first":true}\n', 5, false)
    const first = await tool(env.fake, 'archive_ledgers').execute({}, exec())
    const firstManifest = String(first.manifest)
    expect(existsSync(firstManifest)).toBe(true)

    writeLedger(env.auditDir, 'second-ledger', '{"second":true}\n', 5, false)
    const second = await tool(env.fake, 'archive_ledgers').execute({}, exec())

    expect(second.ok).toBe(true)
    expect(existsSync(firstManifest)).toBe(false)
    expect(existsSync(join(env.retentionDir, 'first-ledger.jsonl.gz'))).toBe(false)
    expect(existsSync(String(second.manifest))).toBe(true)
    expect(existsSync(join(env.retentionDir, 'second-ledger.jsonl.gz'))).toBe(true)
  })

  test('does not follow a symlinked source file', async () => {
    const env = setup()
    const outside = join(env.root, 'outside.jsonl')
    writeFileSync(outside, '{"outside":true}\n', 'utf8')
    const link = join(env.auditDir, 'linked.jsonl')
    let linked = false
    try {
      // Windows may require developer mode; skip the assertion when linking fails.
      symlinkSync(outside, link, 'file')
      linked = true
    } catch {
      // Symlinks unavailable; the dirent.isFile() guard still applies on all platforms.
    }
    if (linked) {
      await expect(tool(env.fake, 'archive_ledgers').execute({}, exec()))
        .rejects.toThrow(/No audit ledger files matched/)
      expect(existsSync(join(env.retentionDir, 'linked.jsonl.gz'))).toBe(false)
      unlinkSync(link)
    }
  })
})
