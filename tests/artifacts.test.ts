/**
 * Deterministic checks for the content-addressed artifact store. No network
 * and no shared store: each test uses its own temporary directory.
 */

import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyArtifacts } from '../src/features/artifacts.ts'
import { exec, fakeContext } from './fake-context.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'super-dsh-artifacts-'))
}

function artifactPath(dir: string, hash: string): string {
  return join(dir, hash.slice(0, 2), hash)
}

function tool(fake: ReturnType<typeof fakeContext>, name: string) {
  const definition = fake.tools.get(name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

describe('artifact store', () => {
  test('round-trips UTF-8 text and verifies it', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })
    const content = 'hello 世界\nline two\n'

    const stored = await tool(fake, 'artifact_put').execute({
      content,
      media_type: 'text/plain; charset=utf-8',
      name: 'hello.txt',
    }, exec())
    expect(stored.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.size).toBe(Buffer.byteLength(content, 'utf8'))
    expect(stored.uri).toBe(`artifact://${String(stored.hash)}`)

    const got = await tool(fake, 'artifact_get').execute({ hash: stored.hash }, exec())
    expect(got).toEqual({
      content,
      encoding: 'utf8',
      hash: stored.hash,
      size: stored.size,
    })

    const verified = await tool(fake, 'artifact_verify').execute({ hash: stored.hash }, exec())
    expect(verified).toMatchObject({
      ok: true,
      expected: stored.hash,
      actual: stored.hash,
      size: stored.size,
    })
  })

  test('round-trips binary content as base64', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])
    const encoded = bytes.toString('base64')

    const stored = await tool(fake, 'artifact_put').execute({
      content_base64: encoded,
      media_type: 'image/png',
      name: 'pixel.png',
    }, exec())
    expect(stored.size).toBe(bytes.length)

    const got = await tool(fake, 'artifact_get').execute({ hash: stored.hash }, exec())
    expect(got).toMatchObject({ encoding: 'base64', hash: stored.hash, size: bytes.length })
    expect(got.content_base64).toBe(encoded)
    expect(Buffer.from(String(got.content_base64), 'base64').equals(bytes)).toBe(true)

    const verified = await tool(fake, 'artifact_verify').execute({ hash: stored.hash }, exec())
    expect(verified.ok).toBe(true)
  })

  test('detects binary content without an explicit media type', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01])
    const stored = await tool(fake, 'artifact_put').execute({
      content_base64: bytes.toString('base64'),
    }, exec())

    const got = await tool(fake, 'artifact_get').execute({ hash: stored.hash }, exec())
    expect(got.encoding).toBe('base64')
    expect(got.content_base64).toBe(bytes.toString('base64'))
  })

  test('duplicate puts are idempotent', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })

    const first = await tool(fake, 'artifact_put').execute({ content: 'same bytes', name: 'first.txt' }, exec())
    const second = await tool(fake, 'artifact_put').execute({ content: 'same bytes', name: 'second.txt' }, exec())
    expect(second).toEqual(first)

    const list = await tool(fake, 'artifact_list').execute({}, exec())
    expect(list.count).toBe(1)
    const indexLines = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
    expect(indexLines).toHaveLength(1)
  })

  test('detects a tampered artifact and get refuses it', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })
    const stored = await tool(fake, 'artifact_put').execute({ content: 'original' }, exec())
    const hash = String(stored.hash)

    writeFileSync(artifactPath(dir, hash), Buffer.from('tampered'), 'utf8')

    const verified = await tool(fake, 'artifact_verify').execute({ hash }, exec())
    expect(verified.ok).toBe(false)
    expect(verified.reason).toBe('hash mismatch')
    expect(verified.actual).not.toBe(hash)

    await expect(tool(fake, 'artifact_get').execute({ hash }, exec())).rejects.toThrow(/failed integrity check/)
  })

  test('a new instance can read existing artifacts after restart', async () => {
    const dir = tempDir()
    const first = fakeContext()
    applyArtifacts(first.ctx, { artifacts: { dir } })
    const text = await tool(first, 'artifact_put').execute({ content: 'persisted text', name: 'note.txt' }, exec())
    const binary = await tool(first, 'artifact_put').execute({
      content_base64: Buffer.from([0, 1, 2, 3]).toString('base64'),
      media_type: 'application/octet-stream',
    }, exec())

    const second = fakeContext()
    applyArtifacts(second.ctx, { artifacts: { dir } })

    const gotText = await tool(second, 'artifact_get').execute({ hash: text.hash }, exec())
    expect(gotText).toMatchObject({ content: 'persisted text', encoding: 'utf8' })
    const gotBinary = await tool(second, 'artifact_get').execute({ hash: binary.hash }, exec())
    expect(gotBinary).toMatchObject({ encoding: 'base64' })

    const verified = await tool(second, 'artifact_verify').execute({ hash: text.hash }, exec())
    expect(verified.ok).toBe(true)

    const list = await tool(second, 'artifact_list').execute({}, exec())
    expect(list.count).toBe(2)
  })

  test('rejects malformed hashes on get, but verify returns ok:false', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })

    await expect(tool(fake, 'artifact_get').execute({ hash: '../../index.jsonl' }, exec()))
      .rejects.toThrow(/64-character/)
    await expect(tool(fake, 'artifact_get').execute({ hash: 'A'.repeat(64) }, exec()))
      .rejects.toThrow(/64-character/)

    const invalid = await tool(fake, 'artifact_verify').execute({ hash: 'not-a-hash' }, exec())
    expect(invalid).toMatchObject({ ok: false, reason: 'invalid hash format' })
    const missing = await tool(fake, 'artifact_verify').execute({ hash: '0'.repeat(64) }, exec())
    expect(missing).toMatchObject({ ok: false, reason: 'artifact not found' })
  })

  test('lists newest first, deduplicates, merges names, and skips bad index lines', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })
    const one = await tool(fake, 'artifact_put').execute({ content: 'one', name: 'one.txt' }, exec())
    await tool(fake, 'artifact_put').execute({ content: 'two' }, exec())
    await tool(fake, 'artifact_put').execute({ content: 'three' }, exec())
    const hash = String(one.hash)

    const indexPath = join(dir, 'index.jsonl')
    appendFileSync(indexPath, 'this is not json\n', 'utf8')
    appendFileSync(indexPath, `${JSON.stringify({
      hash,
      size: one.size,
      media_type: 'text/plain',
      name: 'one-renamed.txt',
      createdAt: Date.now(),
    })}\n`, 'utf8')

    const all = await tool(fake, 'artifact_list').execute({}, exec())
    expect(all.count).toBe(3)
    expect(all.artifacts[0]).toMatchObject({ hash, name: 'one-renamed.txt' })

    const limited = await tool(fake, 'artifact_list').execute({ limit: 2 }, exec())
    expect(limited.count).toBe(2)
    expect(limited.artifacts[0].hash).toBe(hash)
    expect(new Set((limited.artifacts as Array<{ hash: string }>).map(entry => entry.hash)).size).toBe(2)
  })

  test('reindexes valid blobs after index loss and skips tampered blobs', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyArtifacts(fake.ctx, { artifacts: { dir } })
    const one = await tool(fake, 'artifact_put').execute({ content: 'one', name: 'one.txt' }, exec())
    const two = await tool(fake, 'artifact_put').execute({ content: 'two' }, exec())
    const hashOne = String(one.hash)
    const hashTwo = String(two.hash)

    rmSync(join(dir, 'index.jsonl'), { force: true })
    const rebuilt = await tool(fake, 'artifact_reindex').execute({}, exec())
    expect(rebuilt).toMatchObject({ indexed: 2, skipped: 0, total: 2 })
    const listed = await tool(fake, 'artifact_list').execute({}, exec())
    expect(new Set((listed.artifacts as Array<{ hash: string }>).map(entry => entry.hash)))
      .toEqual(new Set([hashOne, hashTwo]))

    writeFileSync(artifactPath(dir, hashOne), 'corrupted', 'utf8')
    const afterTamper = await tool(fake, 'artifact_reindex').execute({}, exec())
    expect(afterTamper.skipped).toBe(1)
    expect(afterTamper.total).toBe(1)
    const fetched = await tool(fake, 'artifact_get').execute({ hash: hashTwo }, exec())
    expect(fetched.content).toBe('two')
  })
})
