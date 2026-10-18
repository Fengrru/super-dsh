/**
 * Audit anchor-gap detection: simulate the crash window where a valid record
 * was appended but the head anchor was not updated. The ledger must fail
 * verification instead of silently accepting the extra record.
 */

import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyAudit } from '../src/features/audit.ts'
import { canonicalJson, sha256 } from '../src/shared.ts'
import { fakeContext, exec } from '../tests/fake-context.ts'

const dir = mkdtempSync(join(tmpdir(), 'super-dsh-kill9-audit-'))
const fake = fakeContext()
applyAudit(fake.ctx, { audit: { dir } })
const session = { id: 'audit-anchor-session' }
for (let seq = 0; seq < 3; seq++) {
  await fake.emit('session/event', session, {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'turn/start',
    data: { turn: seq + 1 },
  })
}
const file = join(dir, readdirSync(dir).find(name => name.endsWith('.jsonl'))!)
const verify = fake.tools.get('audit_verify')!
const before = await verify.execute({ session_id: 'audit-anchor-session' }, exec())

const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
const last = JSON.parse(lines[lines.length - 1]) as { hash: string }
const core = {
  v: 1,
  seq: 3,
  prev: last.hash,
  time: 1_700_000_000_003,
  type: 'turn/start',
  dataHash: sha256(canonicalJson({ turn: 4 })),
}
const forged = { ...core, hash: sha256(canonicalJson(core)) }
appendFileSync(file, `${JSON.stringify(forged)}\n`, 'utf8')
const after = await verify.execute({ session_id: 'audit-anchor-session' }, exec())

const clean = readFileSync(file, 'utf8').trim().split(/\r?\n/)
writeFileSync(file, `${clean.slice(0, -1).join('\n')}\n`, 'utf8')
const restored = await verify.execute({ session_id: 'audit-anchor-session' }, exec())

const result = {
  experiment: 'kill9-audit-anchor',
  generatedAt: new Date().toISOString(),
  simulatedCrashWindow: 'record appended, head anchor not updated',
  beforeOk: before.ok,
  detected: after.ok === false,
  reason: (after.ledgers as Array<{ reason?: string }>)[0]?.reason,
  restoredOk: restored.ok,
  ok: before.ok === true && after.ok === false && restored.ok === true,
}
const resultsDir = join(import.meta.dir, 'results')
mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'kill9-audit-anchor.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(`before=${before.ok} detected=${result.detected} reason=${result.reason} restored=${restored.ok} ok=${result.ok}`)
if (!result.ok) process.exitCode = 1
