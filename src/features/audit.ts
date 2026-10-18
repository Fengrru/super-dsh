/**
 * Tamper-evident audit ledger: the event log is the source of truth, and
 * every record is chained.
 *
 * dsh already persists a canonical session log. This feature does not replace
 * it: it appends a compact hash-chained index beside it, so an operator can
 * verify that neither the ledger nor its ordering was altered after the fact.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, SuperDshConfig, ToolDefinitionLike } from '../plugin-types.ts'
import { canonicalJson, dshHome, sha256, warn } from '../shared.ts'

interface LedgerHead {
  v: 1
  records: number
  seq: number
  hash: string
  updatedAt: number
}

interface LedgerRecord {
  v: 1
  seq: number
  prev: string
  hash: string
  time: number
  type: string
  dataHash: string
  summary?: Record<string, unknown>
  /** HMAC-SHA256(key, hash), present only when audit signing is configured. */
  sig?: string
}

const GENESIS = '0'.repeat(64)
/** Upper bound for records embedded by audit_export. */
const MAX_EXPORT_RECORDS = 5000

export function applyAudit(ctx: PluginContext, config: SuperDshConfig): void {
  const options = typeof config.audit === 'object' ? config.audit : {}
  const dir = options.dir ?? join(dshHome(), 'super-dsh', 'audit')
  const signingKey = resolveSigningKey(options)
  const heads = new Map<string, LedgerHead>()

  ctx.systemPrompt.section({
    name: 'super-dsh:audit',
    order: 130,
    text: 'Every session event is mirrored into a tamper-evident audit ledger. '
      + 'Use `audit_verify` to check a session ledger when the user asks whether the execution record is intact, '
      + 'and `audit_export` to export a ledger with its head anchor.',
  })

  ctx.on('session/event', (session: { id?: unknown }, event: {
    seq?: unknown
    time?: unknown
    type?: unknown
    data?: unknown
  }) => {
    try {
      const sessionId = typeof session.id === 'string' ? session.id : 'unknown-session'
      const seq = typeof event.seq === 'number' ? event.seq : 0
      const type = typeof event.type === 'string' ? event.type : 'unknown'
      const time = typeof event.time === 'number' ? event.time : Date.now()
      const dataHash = sha256(canonicalJson(event.data ?? null))
      const file = join(dir, `${safeName(sessionId)}.jsonl`)
      const head = heads.get(sessionId) ?? readHead(file) ?? {
        v: 1 as const,
        records: 0,
        seq: -1,
        hash: GENESIS,
        updatedAt: Date.now(),
      }
      const summary = summarize(event.data)
      const core = {
        v: 1 as const,
        seq,
        prev: head.hash,
        time,
        type,
        dataHash,
        ...(summary === undefined ? {} : { summary }),
      }
      const hash = sha256(canonicalJson(core))
      const record: LedgerRecord = {
        ...core,
        hash,
        ...(signingKey === undefined ? {} : { sig: signHash(signingKey, hash) }),
      }
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      const nextHead: LedgerHead = {
        v: 1,
        records: head.records + 1,
        seq,
        hash: record.hash,
        updatedAt: Date.now(),
      }
      writeHead(file, nextHead)
      heads.set(sessionId, nextHead)
    } catch (error: unknown) {
      warn(ctx.logger, 'could not append audit record', error)
    }
  })

  const verifyTool: ToolDefinitionLike = {
    name: 'audit_verify',
    description: 'Verify the tamper-evident audit ledger of one session, or of every session when no id is given. '
      + 'Checks the hash chain, sequence continuity, the head anchor, and record signatures when a signing key is configured.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id to verify. Omit to verify every ledger.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          ledgers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                session: { type: 'string' },
                records: { type: 'integer' },
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                broken_at: { type: 'integer' },
              },
              required: ['session', 'records', 'ok'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'ledgers'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const ledgers = value.ledgers as Array<{ session: string; records: number; ok: boolean; reason?: string; broken_at?: number }>
        const lines = ledgers.map((ledger) => {
          if (ledger.ok) return `OK ${ledger.session}: ${ledger.records} records, chain intact`
          const at = ledger.broken_at === undefined ? '' : ` at record ${ledger.broken_at}`
          return `FAIL ${ledger.session}${at}: ${ledger.reason ?? 'integrity check failed'}`
        })
        return [{ type: 'text', text: lines.length === 0 ? 'No audit ledgers found.' : lines.join('\n') }]
      },
    },
    async execute(rawArgs: Record<string, unknown>) {
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id : undefined
      const files = listLedgers(dir)
      const targets = requested === undefined
        ? files
        : files.filter(file => file.session === requested || file.path.endsWith(`${safeName(requested)}.jsonl`))
      if (requested !== undefined && targets.length === 0) {
        throw new Error(`No audit ledger found for session "${requested}".`)
      }
      const ledgers = targets.map(target => verifyLedger(target.path, signingKey))
      return { ok: ledgers.every(ledger => ledger.ok), ledgers }
    },
  }

  const evidenceTool: ToolDefinitionLike = {
    name: 'audit_evidence',
    description: 'Look up a content hash in the audit ledger. Use the data hash reported by an audit record to prove that an event payload existed at a given sequence.',
    parameters: {
      type: 'object',
      properties: {
        data_hash: { type: 'string', description: 'SHA-256 hex digest of the event data.' },
        session_id: { type: 'string', description: 'Optional session id to restrict the search.' },
      },
      required: ['data_hash'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          session: { type: 'string' },
          seq: { type: 'integer' },
          type: { type: 'string' },
          time: { type: 'integer' },
        },
        required: ['found'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found === true
          ? `Evidence found in ${String(value.session)} at seq ${String(value.seq)} (${String(value.type)}).`
          : 'No matching evidence in the audit ledger.',
      }],
    },
    async execute(rawArgs: Record<string, unknown>) {
      const hash = typeof rawArgs.data_hash === 'string' ? rawArgs.data_hash.trim().toLowerCase() : ''
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('data_hash must be a 64-character SHA-256 hex digest')
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id : undefined
      const files = listLedgers(dir).filter(file => requested === undefined || file.session === safeName(requested))
      for (const file of files) {
        for (const line of readFileSync(file.path, 'utf8').split(/\r?\n/)) {
          if (line.trim().length === 0) continue
          try {
            const record = JSON.parse(line) as LedgerRecord
            if (record.dataHash !== hash) continue
            return {
              found: true,
              session: file.session,
              seq: record.seq,
              type: record.type,
              time: record.time,
            }
          } catch {
            // A torn line cannot contain a verified evidence record.
          }
        }
      }
      return { found: false }
    },
  }

  const exportTool: ToolDefinitionLike = {
    name: 'audit_export',
    description: 'Export the tamper-evident audit ledger of one session together with its head anchor and verification result. '
      + 'Optionally embed up to 5000 ledger records; larger ledgers are truncated and marked.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id to export. Omit to export the most recently updated ledger.' },
        include_records: { type: 'boolean', description: 'Embed ledger records (maximum 5000). Default: false.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          head: {
            type: 'object',
            properties: {
              records: { type: 'integer' },
              seq: { type: 'integer' },
              hash: { type: 'string' },
            },
            required: ['records', 'seq', 'hash'],
            additionalProperties: false,
          },
          verify: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['ok'],
            additionalProperties: false,
          },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                v: { type: 'integer' },
                seq: { type: 'integer' },
                prev: { type: 'string' },
                hash: { type: 'string' },
                time: { type: 'integer' },
                type: { type: 'string' },
                dataHash: { type: 'string' },
                summary: { type: 'object', additionalProperties: true },
                sig: { type: 'string' },
              },
              required: ['v', 'seq', 'prev', 'hash', 'time', 'type', 'dataHash'],
              additionalProperties: false,
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['session', 'head', 'verify'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const head = value.head as { records: number; seq: number; hash: string }
        const verify = value.verify as { ok: boolean; reason?: string }
        const lines = [
          `Session ${String(value.session)}: ${head.records} records (head seq ${head.seq}, hash ${head.hash.slice(0, 12)})`,
          verify.ok ? 'Verify: OK, chain and head anchor intact' : `Verify: FAIL, ${verify.reason ?? 'integrity check failed'}`,
        ]
        if (Array.isArray(value.records)) {
          lines.push(`Records: ${value.records.length}${value.truncated === true ? ` (truncated to ${MAX_EXPORT_RECORDS})` : ''}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs: Record<string, unknown>) {
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id : undefined
      const includeRecords = rawArgs.include_records === true
      const target = selectLedger(dir, requested)
      return exportLedger(target.path, target.session, includeRecords, signingKey)
    },
  }

  try {
    ctx.tools.register(evidenceTool)
    ctx.tools.register(verifyTool)
    ctx.tools.register(exportTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register audit tools', error)
  }
}

function listLedgers(dir: string): Array<{ path: string; session: string }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .sort()
    .map(name => ({ path: join(dir, name), session: name.slice(0, -'.jsonl'.length) }))
}

function verifyLedger(file: string, signingKey?: string): {
  session: string
  records: number
  ok: boolean
  reason?: string
  broken_at?: number
} {
  const session = file.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? file
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim().length > 0)
  } catch (error: unknown) {
    return { session, records: 0, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  let prev = GENESIS
  let lastSeq = -1
  let lastHash = GENESIS
  for (let index = 0; index < lines.length; index++) {
    let record: LedgerRecord
    try {
      const parsed = JSON.parse(lines[index]) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { session, records: lines.length, ok: false, reason: 'unparseable record', broken_at: index }
      }
      record = parsed as LedgerRecord
    } catch {
      return { session, records: lines.length, ok: false, reason: 'unparseable record', broken_at: index }
    }
    const { hash, sig, ...core } = record
    const expected = sha256(canonicalJson(core))
    if (hash !== expected) {
      return { session, records: lines.length, ok: false, reason: 'record hash mismatch', broken_at: index }
    }
    if (signingKey !== undefined && !signatureMatches(signingKey, hash, sig)) {
      return { session, records: lines.length, ok: false, reason: 'record signature mismatch', broken_at: index }
    }
    if (record.prev !== prev) {
      return { session, records: lines.length, ok: false, reason: 'chain link mismatch', broken_at: index }
    }
    if (record.seq <= lastSeq) {
      return { session, records: lines.length, ok: false, reason: 'sequence not strictly increasing', broken_at: index }
    }
    prev = hash
    lastSeq = record.seq
    lastHash = hash
  }

  const head = readHead(file)
  if (head === undefined) {
    return { session, records: lines.length, ok: false, reason: 'missing head anchor' }
  }
  if (head.records !== lines.length) {
    return { session, records: lines.length, ok: false, reason: `head anchor expects ${head.records} records` }
  }
  if (head.hash !== lastHash || head.seq !== lastSeq) {
    return { session, records: lines.length, ok: false, reason: 'head anchor does not match the last record' }
  }
  return { session, records: lines.length, ok: true }
}

function readHead(file: string): LedgerHead | undefined {
  try {
    const raw = readFileSync(`${file}.head`, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LedgerHead>
    if (parsed.v !== 1 || typeof parsed.records !== 'number' || typeof parsed.hash !== 'string') return undefined
    return {
      v: 1,
      records: parsed.records,
      seq: Number(parsed.seq ?? -1),
      hash: parsed.hash,
      updatedAt: Number(parsed.updatedAt ?? 0),
    }
  } catch {
    return undefined
  }
}

function writeHead(file: string, head: LedgerHead): void {
  const tmp = `${file}.head.tmp`
  writeFileSync(tmp, JSON.stringify(head), 'utf8')
  renameSync(tmp, `${file}.head`)
}

/** Resolve the optional HMAC key once, preferring the environment over inline config. */
function resolveSigningKey(options: { signingKeyEnv?: string; signingKey?: string }): string | undefined {
  if (typeof options.signingKeyEnv === 'string' && options.signingKeyEnv.length > 0) {
    const value = process.env[options.signingKeyEnv]
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (typeof options.signingKey === 'string' && options.signingKey.length > 0) return options.signingKey
  return undefined
}

/** HMAC-SHA256(key, record hash), hex encoded. The key itself is never persisted. */
function signHash(key: string, hash: string): string {
  return createHmac('sha256', key).update(hash, 'utf8').digest('hex')
}

function signatureMatches(key: string, hash: string, sig: unknown): boolean {
  if (typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig)) return false
  const expected = Buffer.from(signHash(key, hash), 'hex')
  const actual = Buffer.from(sig, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function selectLedger(dir: string, requested: string | undefined): { path: string; session: string } {
  const files = listLedgers(dir)
  if (requested !== undefined) {
    const target = files.find(file => file.session === requested || file.path.endsWith(`${safeName(requested)}.jsonl`))
    if (target === undefined) throw new Error(`No audit ledger found for session "${requested}".`)
    return target
  }
  if (files.length === 0) throw new Error('No audit ledgers found.')
  let target = files[0]
  let targetTime = readHead(target.path)?.updatedAt ?? 0
  for (const file of files.slice(1)) {
    const time = readHead(file.path)?.updatedAt ?? 0
    if (time > targetTime) {
      target = file
      targetTime = time
    }
  }
  return target
}

function exportLedger(
  file: string,
  session: string,
  includeRecords: boolean,
  signingKey: string | undefined,
): Record<string, unknown> {
  const head = readHead(file) ?? deriveHead(readLedgerRecords(file))
  const verified = verifyLedger(file, signingKey)
  const result: Record<string, unknown> = {
    session,
    head: { records: head.records, seq: head.seq, hash: head.hash },
    verify: verified.ok ? { ok: true } : { ok: false, reason: verified.reason ?? 'integrity check failed' },
  }
  if (includeRecords) {
    const records = readLedgerRecords(file)
    result.records = records.slice(0, MAX_EXPORT_RECORDS)
    result.truncated = records.length > MAX_EXPORT_RECORDS
  }
  return result
}

function readLedgerRecords(file: string): LedgerRecord[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records: LedgerRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as LedgerRecord)
      }
    } catch {
      // Skip torn lines; verify reports them separately.
    }
  }
  return records
}

function deriveHead(records: LedgerRecord[]): LedgerHead {
  const last = records[records.length - 1]
  return {
    v: 1,
    records: records.length,
    seq: typeof last?.seq === 'number' ? last.seq : -1,
    hash: typeof last?.hash === 'string' ? last.hash : GENESIS,
    updatedAt: 0,
  }
}

function summarize(data: unknown): Record<string, unknown> | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  if (typeof record.name === 'string') summary.tool = record.name
  if (typeof record.toolName === 'string') summary.tool = record.toolName
  if (typeof record.callId === 'string') summary.call_id = record.callId
  if (record.message !== null && typeof record.message === 'object') {
    const message = record.message as Record<string, unknown>
    if (typeof message.toolCallId === 'string') summary.call_id = message.toolCallId
    if (message.isError === true) summary.is_error = true
  }
  if (record.reason !== null && typeof record.reason === 'object') {
    const reason = record.reason as Record<string, unknown>
    if (typeof reason.kind === 'string') summary.reason = reason.kind
  }
  return Object.keys(summary).length === 0 ? undefined : summary
}

function safeName(sessionId: string): string {
  const base = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  if (base.length === 0) return 'session'
  const suffix = sha256(sessionId).slice(0, 8)
  return `${base}-${suffix}`
}
