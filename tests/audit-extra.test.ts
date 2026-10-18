/**
 * Extended audit ledger checks:
 * - optional HMAC-SHA256 signatures over each record hash,
 * - the audit_export tool (head anchor, verification, bounded records),
 * - a golden fixture pinning the canonical JSON hashing format.
 *
 * Deterministic: no model calls, no network, temp directories only.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyAudit } from '../src/features/audit.ts'
import { canonicalJson, sha256 } from '../src/shared.ts'
import { exec, fakeContext, type FakeContext } from './fake-context.ts'

const GENESIS = '0'.repeat(64)
const SECRET = 'audit-test-secret-key'
const ENV_KEY = 'SUPER_DSH_AUDIT_TEST_KEY'

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'audit-v1.json'), 'utf8'),
) as {
  event: { seq: number; time: number; type: string; data: unknown }
  expected: { dataHash: string; recordHash: string }
}

interface RecordLike {
  v: number
  seq: number
  prev: string
  hash: string
  time: number
  type: string
  dataHash: string
  summary?: Record<string, unknown>
  sig?: string
}

interface HeadLike {
  v: number
  records: number
  seq: number
  hash: string
  updatedAt: number
}

function ledgerPath(dir: string): string {
  const files = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  return join(dir, files[0])
}

function readRecords(dir: string): RecordLike[] {
  return readFileSync(ledgerPath(dir), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RecordLike)
}

function readHead(dir: string): HeadLike {
  return JSON.parse(readFileSync(`${ledgerPath(dir)}.head`, 'utf8')) as HeadLike
}

function hmac(key: string, hash: string): string {
  return createHmac('sha256', key).update(hash).digest('hex')
}

async function emit(
  fake: FakeContext,
  sessionId: string,
  seq: number,
  data: unknown,
  type = 'turn/start',
): Promise<void> {
  await fake.emit('session/event', { id: sessionId }, {
    seq,
    time: 1_700_000_000_000 + seq,
    type,
    data,
  })
}

function rewriteLedger(dir: string, records: RecordLike[]): void {
  writeFileSync(ledgerPath(dir), `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe('audit signatures', () => {
  test('keeps unsigned behavior when no key is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-plain-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir } })

    await emit(fake, 'session-plain', 0, { turn: 1 })
    // The head anchor is still written on every event.
    expect(readHead(dir).records).toBe(1)
    await emit(fake, 'session-plain', 1, { name: 'read', callId: 'c1' }, 'tool/call')
    expect(readHead(dir).records).toBe(2)

    const records = readRecords(dir)
    expect(records).toHaveLength(2)
    expect(records.every(record => record.sig === undefined)).toBe(true)
    expect(records[0].prev).toBe(GENESIS)
    expect(records[1].prev).toBe(records[0].hash)
    expect(readHead(dir).hash).toBe(records[1].hash)

    const verified = await fake.tools.get('audit_verify')!.execute({ session_id: 'session-plain' }, exec())
    expect(verified.ok).toBe(true)

    const evidence = await fake.tools.get('audit_evidence')!.execute({ data_hash: records[1].dataHash }, exec())
    expect(evidence.found).toBe(true)
    expect(evidence.seq).toBe(1)
  })

  test('signs every record with HMAC-SHA256(key, hash) and never persists the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-signed-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir, signingKey: SECRET } })

    for (let seq = 0; seq < 3; seq++) {
      await emit(fake, 'session-signed', seq, { turn: seq })
    }

    const records = readRecords(dir)
    expect(records).toHaveLength(3)
    for (const record of records) {
      expect(record.sig).toBe(hmac(SECRET, record.hash))
      expect(record.sig).toMatch(/^[a-f0-9]{64}$/)
      // The signature is not part of the hashed record core.
      const { hash, sig: _sig, ...core } = record
      expect(sha256(canonicalJson(core))).toBe(hash)
    }

    const stored = readdirSync(dir)
      .map(name => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
    expect(stored).not.toContain(SECRET)

    const verified = await fake.tools.get('audit_verify')!.execute({ session_id: 'session-signed' }, exec())
    expect(verified.ok).toBe(true)

    // Evidence lookup keeps working on signed ledgers.
    const evidence = await fake.tools.get('audit_evidence')!.execute({ data_hash: records[1].dataHash }, exec())
    expect(evidence.found).toBe(true)
    expect(evidence.type).toBe('turn/start')
  })

  test('prefers signingKeyEnv and falls back to signingKey when it is unset', async () => {
    process.env[ENV_KEY] = 'env-secret'
    const envDir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-env-'))
    const envFake = fakeContext()
    applyAudit(envFake.ctx, {
      audit: { dir: envDir, signingKeyEnv: ENV_KEY, signingKey: 'inline-secret' },
    })
    await emit(envFake, 'session-env', 0, { turn: 1 })
    const [envRecord] = readRecords(envDir)
    expect(envRecord.sig).toBe(hmac('env-secret', envRecord.hash))
    expect((await envFake.tools.get('audit_verify')!.execute({ session_id: 'session-env' }, exec())).ok).toBe(true)

    delete process.env[ENV_KEY]
    const inlineDir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-inline-'))
    const inlineFake = fakeContext()
    applyAudit(inlineFake.ctx, {
      audit: { dir: inlineDir, signingKeyEnv: ENV_KEY, signingKey: 'inline-secret' },
    })
    await emit(inlineFake, 'session-inline', 0, { turn: 1 })
    const [inlineRecord] = readRecords(inlineDir)
    expect(inlineRecord.sig).toBe(hmac('inline-secret', inlineRecord.hash))
    expect((await inlineFake.tools.get('audit_verify')!.execute({ session_id: 'session-inline' }, exec())).ok).toBe(true)
  })

  test('rejects a ledger verified with the wrong key, but verifies it without a key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-wrong-key-'))
    const writer = fakeContext()
    applyAudit(writer.ctx, { audit: { dir, signingKey: SECRET } })
    await emit(writer, 'session-wrong-key', 0, { turn: 1 })

    const wrongKey = fakeContext()
    applyAudit(wrongKey.ctx, { audit: { dir, signingKey: 'wrong-secret' } })
    const rejected = await wrongKey.tools.get('audit_verify')!.execute({ session_id: 'session-wrong-key' }, exec())
    expect(rejected.ok).toBe(false)
    expect(JSON.stringify(rejected)).toContain('record signature mismatch')

    // Without a key, the signature is an extra field and the existing hash chain rules apply.
    const noKey = fakeContext()
    applyAudit(noKey.ctx, { audit: { dir } })
    const accepted = await noKey.tools.get('audit_verify')!.execute({ session_id: 'session-wrong-key' }, exec())
    expect(accepted.ok).toBe(true)
  })

  test('detects content tampering, rehashed records, and stripped signatures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-tamper-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir, signingKey: SECRET } })
    for (let seq = 0; seq < 3; seq++) await emit(fake, 'session-tamper', seq, { turn: seq })
    const verify = fake.tools.get('audit_verify')!
    const original = readRecords(dir)

    // Content changed without rehashing: the record hash no longer matches.
    const changed = structuredClone(original)
    changed[1].type = 'tampered'
    rewriteLedger(dir, changed)
    const hashFailure = await verify.execute({ session_id: 'session-tamper' }, exec())
    expect(hashFailure.ok).toBe(false)
    expect(JSON.stringify(hashFailure)).toContain('record hash mismatch')

    // Rehashed tampered content still fails because the old signature is retained.
    const { hash: _oldHash, sig: oldSig, ...tamperedCore } = changed[1]
    changed[1] = { ...tamperedCore, hash: sha256(canonicalJson(tamperedCore)), sig: oldSig }
    rewriteLedger(dir, changed)
    const signatureFailure = await verify.execute({ session_id: 'session-tamper' }, exec())
    expect(signatureFailure.ok).toBe(false)
    expect(JSON.stringify(signatureFailure)).toContain('record signature mismatch')

    const exported = await fake.tools.get('audit_export')!.execute({ session_id: 'session-tamper' }, exec())
    expect(exported.verify).toEqual({ ok: false, reason: 'record signature mismatch' })

    // Removing the signature is also a downgrade attempt while a key is configured.
    const stripped = structuredClone(original)
    delete stripped[0].sig
    rewriteLedger(dir, stripped)
    const strippedFailure = await verify.execute({ session_id: 'session-tamper' }, exec())
    expect(strippedFailure.ok).toBe(false)
    expect(JSON.stringify(strippedFailure)).toContain('record signature mismatch')
  })
})

describe('audit_export', () => {
  test('returns the head and verification, and records only when requested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-export-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir, signingKey: SECRET } })
    await emit(fake, 'session-export', 0, { turn: 1 })
    await emit(fake, 'session-export', 1, { name: 'read', callId: 'c1' }, 'tool/call')

    const tool = fake.tools.get('audit_export')!
    const summary = await tool.execute({ session_id: 'session-export' }, exec())
    expect(summary.records).toBeUndefined()
    expect(summary.verify).toEqual({ ok: true })
    const head = summary.head as { records: number; seq: number; hash: string }
    expect(head).toEqual({ records: 2, seq: 1, hash: readRecords(dir)[1].hash })
    expect(String(summary.session)).toBe(ledgerPath(dir).split(/[\\/]/).pop()!.replace(/\.jsonl$/, ''))

    // With a single ledger, omitting session_id exports the most recent one.
    const defaultExport = await tool.execute({}, exec())
    expect(defaultExport.session).toBe(summary.session)
    expect(defaultExport.head).toEqual(head)
    expect(defaultExport.records).toBeUndefined()

    const full = await tool.execute({ session_id: 'session-export', include_records: true }, exec())
    const records = full.records as RecordLike[]
    expect(records).toHaveLength(2)
    expect(records.map(record => record.seq)).toEqual([0, 1])
    expect(records[0].prev).toBe(GENESIS)
    expect(records[1].prev).toBe(records[0].hash)
    expect(records.every(record => typeof record.sig === 'string')).toBe(true)
    expect(full.truncated).toBe(false)

    const rendered = tool.output.render({}, full)[0].text
    expect(rendered).toContain('Session ')
    expect(rendered).toContain('2 records')
    expect(rendered).toContain('Verify: OK')
    expect(rendered).toContain('Records: 2')

    const schema = tool.output.schema as {
      properties: { records: { type: string }; head: { required: string[] }; verify: { required: string[] } }
      required: string[]
    }
    expect(schema.properties.records.type).toBe('array')
    expect(schema.properties.head.required).toEqual(['records', 'seq', 'hash'])
    expect(schema.properties.verify.required).toEqual(['ok'])
    expect(schema.required).toEqual(['session', 'head', 'verify'])
  })

  test('truncates exports above 5000 records and marks them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-export-bulk-'))
    const session = 'bulk-session'
    const file = join(dir, `${session}-${sha256(session).slice(0, 8)}.jsonl`)
    const lines: string[] = []
    let prev = GENESIS
    let lastSeq = -1
    let lastHash = GENESIS
    const total = 5002
    for (let seq = 0; seq < total; seq++) {
      const core = {
        v: 1,
        seq,
        prev,
        time: 1_700_000_000_000 + seq,
        type: 'turn/start',
        dataHash: sha256(canonicalJson({ seq })),
      }
      const hash = sha256(canonicalJson(core))
      lines.push(JSON.stringify({ ...core, hash }))
      prev = hash
      lastSeq = seq
      lastHash = hash
    }
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    writeFileSync(`${file}.head`, JSON.stringify({
      v: 1,
      records: total,
      seq: lastSeq,
      hash: lastHash,
      updatedAt: Date.now(),
    }), 'utf8')

    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir } })
    const result = await fake.tools.get('audit_export')!.execute({
      session_id: session,
      include_records: true,
    }, exec())
    expect(result.verify).toEqual({ ok: true })
    expect(result.truncated).toBe(true)
    const records = result.records as RecordLike[]
    expect(records).toHaveLength(5000)
    expect(records[0].seq).toBe(0)
    expect(records[4999].seq).toBe(4999)
    expect((result.head as { records: number }).records).toBe(total)
  })
})

describe('audit golden fixture', () => {
  test('pins canonical data and record hashes for a fixed event', async () => {
    // Canonical JSON sorts keys recursively and drops undefined values.
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(canonicalJson(fixture.event.data))
      .toBe('{"enabled":false,"nested":{"a":[true,null,"x"],"z":1},"turn":7}')

    const dataHash = sha256(canonicalJson(fixture.event.data))
    expect(dataHash).toBe(fixture.expected.dataHash)

    const core = {
      v: 1,
      seq: fixture.event.seq,
      prev: GENESIS,
      time: fixture.event.time,
      type: fixture.event.type,
      dataHash,
    }
    expect(sha256(canonicalJson(core))).toBe(fixture.expected.recordHash)

    // A freshly generated ledger reproduces the fixture byte-for-byte in its hashes.
    const dir = mkdtempSync(join(tmpdir(), 'super-dsh-audit-golden-'))
    const fake = fakeContext()
    applyAudit(fake.ctx, { audit: { dir } })
    await fake.emit('session/event', { id: 'golden-session' }, fixture.event)

    const [record] = readRecords(dir)
    expect(record.prev).toBe(GENESIS)
    expect(record.seq).toBe(fixture.event.seq)
    expect(record.time).toBe(fixture.event.time)
    expect(record.type).toBe(fixture.event.type)
    expect(record.dataHash).toBe(fixture.expected.dataHash)
    expect(record.hash).toBe(fixture.expected.recordHash)
    expect(record.summary).toBeUndefined()

    const verified = await fake.tools.get('audit_verify')!.execute({ session_id: 'golden-session' }, exec())
    expect(verified.ok).toBe(true)
  })
})
