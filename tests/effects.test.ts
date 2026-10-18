/**
 * Deterministic checks for the side-effect intent/commit ledger. No model
 * calls, no network, no real dsh process.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEffects } from '../src/features/effects.ts'
import { canonicalJson, sha256 } from '../src/shared.ts'
import { execWithAgent, fakeContext } from './fake-context.ts'

interface EffectLine {
  v: number
  at: number
  callId: string
  key: string
  tool: string
  argsHash: string
  effectClass: string
  status: string
  finishedAt?: number
  error?: string
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'super-dsh-effects-'))
}

function agentFor(id: string) {
  return { session: { id }, followup() {} }
}

function ledgerLines(dir: string, session: string): EffectLine[] {
  const raw = readFileSync(join(dir, `${session}.jsonl`), 'utf8')
  return raw.trim().split('\n').map(line => JSON.parse(line) as EffectLine)
}

function enterNext() {
  return async () => ({ kind: 'enter' })
}

describe('effect ledger', () => {
  test('records pending then committed and exposes status counts', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-1')
    const args = { file_path: 'a.ts', content: 'hello' }
    const call = execWithAgent(agent, { callId: 'call-1', name: 'write', arguments: args })

    const decisions = await fake.emit('tools/pre-execute', call, enterNext())
    expect(decisions).toEqual([{ kind: 'enter' }])

    let lines = ledgerLines(dir, 'session-1')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      v: 1,
      callId: 'call-1',
      tool: 'write',
      effectClass: 'reversible',
      status: 'pending',
    })
    expect(lines[0].key).toBe(sha256(`write\n${canonicalJson(args)}`))
    expect(lines[0].argsHash).toBe(sha256(canonicalJson(args)))
    expect(lines[0].at).toBeGreaterThan(0)

    const [result] = await fake.emit('tools/result', call, { isError: false }) as unknown[]
    expect(result).toBeUndefined()
    lines = ledgerLines(dir, 'session-1')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      callId: 'call-1',
      key: lines[0].key,
      status: 'committed',
    })
    expect(lines[1].finishedAt).toBeGreaterThanOrEqual(lines[1].at)

    const status = await fake.tools.get('effect_status')!.execute({}, call)
    expect(status).toMatchObject({
      ok: true,
      session: 'session-1',
      unresolved: [],
      counts: { pending: 0, unknown: 0, committed: 1, failed: 0, total: 1 },
    })
  })

  test('records a failed result with finishedAt and error', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-failure')
    const call = execWithAgent(agent, {
      callId: 'call-fail',
      name: 'edit',
      arguments: { file_path: 'b.ts', old_string: 'a', new_string: 'b' },
    })

    await fake.emit('tools/pre-execute', call, enterNext())
    await fake.emit('tools/result', call, { isError: true, error: { message: 'disk full' } })

    const lines = ledgerLines(dir, 'session-failure')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      callId: 'call-fail',
      status: 'failed',
      error: 'disk full',
    })
    expect(lines[1].finishedAt).toBeGreaterThan(0)

    const status = await fake.tools.get('effect_status')!.execute({}, call)
    expect(status.counts).toMatchObject({ pending: 0, failed: 1, committed: 0 })
    expect(status.unresolved).toEqual([])
  })

  test('marks pending intents unknown on the first agent/created of a new instance', async () => {
    const dir = tempDir()
    const agent = agentFor('session-restart')
    const call = execWithAgent(agent, {
      callId: 'call-crash',
      name: 'shell',
      arguments: { command: 'rm -rf /tmp/super-dsh-data' },
    })

    const first = fakeContext()
    applyEffects(first.ctx, { effects: { dir } })
    await first.emit('tools/pre-execute', call, enterNext())
    expect(ledgerLines(dir, 'session-restart')[0].effectClass).toBe('irreversible')

    // A second apply simulates a new dsh process resuming the same session.
    const second = fakeContext()
    applyEffects(second.ctx, { effects: { dir } })
    await second.emit('agent/created', { agent })

    const lines = ledgerLines(dir, 'session-restart')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      v: 1,
      callId: 'call-crash',
      key: lines[0].key,
      tool: 'shell',
      effectClass: 'irreversible',
      status: 'unknown',
    })
    expect(lines[1].finishedAt).toBeGreaterThan(0)

    const status = await second.tools.get('effect_status')!.execute(
      { session_id: 'session-restart' },
      call,
    )
    expect(status.counts).toMatchObject({ pending: 0, unknown: 1, total: 1 })
    expect(status.unresolved).toHaveLength(1)
    expect(status.unresolved[0]).toMatchObject({
      key: lines[0].key,
      tool: 'shell',
      class: 'irreversible',
      status: 'unknown',
    })

    // Reconciliation is once per session per instance.
    await second.emit('agent/created', { agent })
    expect(ledgerLines(dir, 'session-restart')).toHaveLength(2)
  })

  test('denies a repeated unresolved irreversible call but allows pure calls', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir, denyUnresolvedIrreversible: true } })
    const agent = agentFor('session-deny')

    let nextCalls = 0
    const next = async () => {
      nextCalls++
      return { kind: 'enter' }
    }

    const shellArgs = { command: 'git push origin main' }
    const [firstShell] = await fake.emit(
      'tools/pre-execute',
      execWithAgent(agent, { callId: 'shell-1', name: 'bash', arguments: shellArgs }),
      next,
    ) as Array<{ kind: string }>
    expect(firstShell.kind).toBe('enter')

    const [duplicateShell] = await fake.emit(
      'tools/pre-execute',
      execWithAgent(agent, { callId: 'shell-2', name: 'bash', arguments: shellArgs }),
      next,
    ) as Array<{ kind: string; reason?: string }>
    expect(nextCalls).toBe(1)
    expect(duplicateShell.kind).toBe('deny')
    expect(duplicateShell.reason).toContain('unresolved')

    const readArgs = { file_path: 'a.ts' }
    await fake.emit(
      'tools/pre-execute',
      execWithAgent(agent, { callId: 'read-1', name: 'read', arguments: readArgs }),
      next,
    )
    const [secondRead] = await fake.emit(
      'tools/pre-execute',
      execWithAgent(agent, { callId: 'read-2', name: 'read', arguments: readArgs }),
      next,
    ) as Array<{ kind: string }>
    expect(secondRead.kind).toBe('enter')
    expect(nextCalls).toBe(3)

    const lines = ledgerLines(dir, 'session-deny')
    expect(lines.filter(line => line.status === 'pending')).toHaveLength(4)
    expect(lines.find(line => line.callId === 'read-1')?.effectClass).toBe('pure')
  })

  test('honors the configured irreversibleTools override', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, {
      effects: { dir, denyUnresolvedIrreversible: true, irreversibleTools: ['custom_publish'] },
    })
    const agent = agentFor('session-override')
    const args = { target: 'production' }

    await fake.emit(
      'tools/pre-execute',
      execWithAgent(agent, { callId: 'custom-1', name: 'custom_publish', arguments: args }),
      enterNext(),
    )
    const [denied] = await fake.emit(
      'tools/pre-execute',
      execWithAgent(agent, { callId: 'custom-2', name: 'custom_publish', arguments: args }),
      enterNext(),
    ) as Array<{ kind: string }>
    expect(denied.kind).toBe('deny')
    expect(ledgerLines(dir, 'session-override')[0].effectClass).toBe('irreversible')
  })

  test('classifies safe and dangerous shell commands', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-shell')
    const cases: Array<[string, string]> = [
      ['echo hello', 'reversible'],
      ['git status', 'reversible'],
      ['rm -rf /tmp/super-dsh', 'irreversible'],
      ['git push origin main', 'irreversible'],
      ['git reset --hard HEAD', 'irreversible'],
      ['npm publish', 'irreversible'],
      ['npm run deploy', 'irreversible'],
      ['kubectl apply -f deployment.yaml', 'irreversible'],
      ['kubectl delete pod api-0', 'irreversible'],
      ['sendmail -t', 'irreversible'],
      ['curl -X POST https://example.test/hook', 'irreversible'],
    ]
    for (let index = 0; index < cases.length; index++) {
      const [command] = cases[index]
      await fake.emit(
        'tools/pre-execute',
        execWithAgent(agent, { callId: `shell-${index}`, name: 'shell', arguments: { command } }),
        enterNext(),
      )
    }
    const lines = ledgerLines(dir, 'session-shell')
    for (let index = 0; index < cases.length; index++) {
      expect(lines[index].effectClass).toBe(cases[index][1])
    }
  })

  test('writes a completion record even when the intent is missing', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-orphan')
    const call = execWithAgent(agent, {
      callId: 'orphan-call',
      name: 'write',
      arguments: { file_path: 'orphan.ts' },
    })

    await fake.emit('tools/result', call, { isError: false })
    const lines = ledgerLines(dir, 'session-orphan')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      callId: 'orphan-call',
      tool: 'write',
      status: 'committed',
      effectClass: 'reversible',
    })
    expect(lines[0].finishedAt).toBeGreaterThan(0)
  })

  test('effect_status does not report its own in-flight call as unresolved', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-self')
    const statusCall = execWithAgent(agent, { callId: 'status-call', name: 'effect_status', arguments: {} })

    // dsh records the pending intent for effect_status before execute runs.
    await fake.emit('tools/pre-execute', statusCall, enterNext())
    const status = await fake.tools.get('effect_status')!.execute({}, statusCall)
    expect(status.counts).toMatchObject({ pending: 0, total: 0 })
    expect(status.unresolved).toEqual([])
  })
})
