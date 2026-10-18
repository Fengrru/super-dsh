/**
 * Deterministic checks for the side-effect intent/commit ledger. No model
 * calls, no network, no real dsh process.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyEffects,
  effectTransition,
} from '../src/features/effects.ts'
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
  compensation?: string
  resolutionNote?: string
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

function toolCall(agent: unknown, callId: string, name: string, args: unknown = {}) {
  return execWithAgent(agent, { callId, name, arguments: args })
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
    expect(lines.filter(line => line.status === 'pending')).toHaveLength(3)
    expect(lines.find(line => line.callId === 'shell-2')).toBeUndefined()
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

describe('effect state machine', () => {
  test('moves unresolved intents into every resolution state', () => {
    expect(effectTransition('pending', 'commit')).toBe('committed')
    expect(effectTransition('pending', 'fail')).toBe('failed')
    expect(effectTransition('pending', 'mark-unknown')).toBe('unknown')
    expect(effectTransition('pending', 'compensate')).toBe('compensated')
    expect(effectTransition('pending', 'abandon')).toBe('abandoned')
    expect(effectTransition('unknown', 'commit')).toBe('committed')
    expect(effectTransition('unknown', 'failed')).toBe('failed')
    expect(effectTransition('unknown', 'compensated')).toBe('compensated')
    expect(effectTransition('unknown', 'abandoned')).toBe('abandoned')
  })

  test('rejects regressions, terminal rewrites, and unknown events', () => {
    expect(effectTransition('committed', 'abandon')).toBe('committed')
    expect(effectTransition('committed', 'pending')).toBe('committed')
    expect(effectTransition('failed', 'compensate')).toBe('failed')
    expect(effectTransition('compensated', 'commit')).toBe('compensated')
    expect(effectTransition('abandoned', 'commit')).toBe('abandoned')
    expect(effectTransition('unknown', 'intent')).toBe('unknown')
    expect(effectTransition('pending', 'not-an-event')).toBe('pending')
  })
})

describe('effect policies', () => {
  test('effectPolicies override classification and persist compensation', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, {
      effects: {
        dir,
        effectPolicies: {
          write: { class: 'irreversible' },
          fetch_remote: { class: 'idempotent' },
          custom_pure: { class: 'pure' },
          edit: { compensation: 'git checkout -- <file>' },
        },
      },
    })
    const agent = agentFor('session-policy')
    const calls = [
      toolCall(agent, 'policy-1', 'write', { file_path: 'a.ts' }),
      toolCall(agent, 'policy-2', 'fetch_remote', { url: 'https://example.test' }),
      toolCall(agent, 'policy-3', 'custom_pure', {}),
      toolCall(agent, 'policy-4', 'edit', { file_path: 'b.ts' }),
    ]
    for (const call of calls) await fake.emit('tools/pre-execute', call, enterNext())

    const lines = ledgerLines(dir, 'session-policy')
    expect(lines.map(line => line.effectClass)).toEqual([
      'irreversible', 'idempotent', 'pure', 'reversible',
    ])
    expect(lines[3].compensation).toBe('git checkout -- <file>')
    expect(lines[0].compensation).toBeUndefined()
  })

  test('irreversibleTools wins over a relaxing effectPolicy', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, {
      effects: {
        dir,
        irreversibleTools: ['guarded_tool'],
        effectPolicies: { guarded_tool: { class: 'pure' } },
      },
    })
    const agent = agentFor('session-policy-safety')
    await fake.emit(
      'tools/pre-execute',
      toolCall(agent, 'guarded-1', 'guarded_tool', { target: 'prod' }),
      enterNext(),
    )
    expect(ledgerLines(dir, 'session-policy-safety')[0].effectClass).toBe('irreversible')
  })
})

describe('effect_reconcile', () => {
  test('plans replay, compensate, and query decisions without executing anything', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, {
      effects: {
        dir,
        irreversibleTools: ['deploy_prod'],
        effectPolicies: {
          fetch_remote: { class: 'idempotent' },
          edit: { compensation: 'git checkout -- <file>' },
          cache_put: { class: 'reversible' },
        },
      },
    })
    const agent = agentFor('session-reconcile')
    const calls = [
      toolCall(agent, 'rec-read', 'read', { file_path: 'a.ts' }),
      toolCall(agent, 'rec-idem', 'fetch_remote', { url: 'https://example.test' }),
      toolCall(agent, 'rec-comp', 'edit', { file_path: 'b.ts' }),
      toolCall(agent, 'rec-rev', 'cache_put', { key: 'x' }),
      toolCall(agent, 'rec-irrev', 'deploy_prod', { target: 'prod' }),
    ]
    for (const call of calls) await fake.emit('tools/pre-execute', call, enterNext())
    const linesBefore = ledgerLines(dir, 'session-reconcile').length

    const reconcile = fake.tools.get('effect_reconcile')!
    const reconcileCall = toolCall(agent, 'reconcile-1', 'effect_reconcile')
    const dry = await reconcile.execute({ session_id: 'session-reconcile', dry_run: true }, reconcileCall)
    const live = await reconcile.execute({ session_id: 'session-reconcile' }, reconcileCall)

    expect(live).toEqual(dry)
    expect(dry.summary).toEqual({ replay: 2, compensate: 1, query: 2, unknown: 0, total: 5 })
    expect(dry.plan.map(entry => entry.callId)).toEqual([
      'rec-read', 'rec-idem', 'rec-comp', 'rec-rev', 'rec-irrev',
    ])
    const byCall = new Map(dry.plan.map(entry => [entry.callId, entry]))
    expect(byCall.get('rec-read')).toMatchObject({
      tool: 'read', effectClass: 'pure', status: 'pending', decision: 'replay',
    })
    expect(byCall.get('rec-idem')).toMatchObject({
      effectClass: 'idempotent', decision: 'replay',
    })
    expect(byCall.get('rec-comp')).toMatchObject({
      effectClass: 'reversible',
      decision: 'compensate',
      compensation: 'git checkout -- <file>',
    })
    expect(byCall.get('rec-rev')).toMatchObject({
      effectClass: 'reversible', decision: 'query',
    })
    expect(byCall.get('rec-rev')?.compensation).toBeUndefined()
    expect(byCall.get('rec-irrev')).toMatchObject({
      effectClass: 'irreversible', decision: 'query',
    })
    expect(byCall.get('rec-comp')?.reason).toContain('compensation')

    // Neither mode touches the ledger or any external state.
    expect(ledgerLines(dir, 'session-reconcile')).toHaveLength(linesBefore)
  })

  test('reports unknown intents and uses a configured compensation for legacy records', async () => {
    const dir = tempDir()
    const session = 'session-reconcile-restart'
    const agent = agentFor(session)
    const args = { file_path: 'legacy.ts' }
    const legacy = {
      v: 1,
      at: 1,
      callId: 'legacy-call',
      key: sha256(`edit\n${canonicalJson(args)}`),
      tool: 'edit',
      argsHash: sha256(canonicalJson(args)),
      effectClass: 'reversible',
      status: 'pending',
    }
    // A v1 record written by an older version has no compensation field.
    writeFileSync(join(dir, `${session}.jsonl`), `${JSON.stringify(legacy)}\n`, 'utf8')

    const fake = fakeContext()
    applyEffects(fake.ctx, {
      effects: {
        dir,
        effectPolicies: { edit: { compensation: 'git checkout -- legacy.ts' } },
      },
    })
    await fake.emit('agent/created', { agent })

    const reconcileCall = toolCall(agent, 'reconcile-2', 'effect_reconcile')
    const reconcile = fake.tools.get('effect_reconcile')!
    const result = await reconcile.execute({ session_id: session, dry_run: true }, reconcileCall)
    expect(result.plan).toHaveLength(1)
    expect(result.plan[0]).toMatchObject({
      callId: 'legacy-call',
      tool: 'edit',
      effectClass: 'reversible',
      status: 'unknown',
      decision: 'compensate',
      compensation: 'git checkout -- legacy.ts',
    })
    expect(result.summary).toEqual({ replay: 0, compensate: 1, query: 0, unknown: 1, total: 1 })

    const status = await fake.tools.get('effect_status')!.execute({ session_id: session }, reconcileCall)
    expect(status.counts).toMatchObject({ pending: 0, unknown: 1, total: 1 })

    // Resolve the recovered intent and confirm the index and file agree.
    const resolve = fake.tools.get('effect_resolve')!
    const resolverCall = toolCall(agent, 'resolver-2', 'effect_resolve')
    const resolved = await resolve.execute(
      { callId: 'legacy-call', resolution: 'committed', note: 'verified target exists' },
      resolverCall,
    )
    expect(resolved).toEqual({
      resolved: true,
      callId: 'legacy-call',
      status: 'committed',
      unresolved: 0,
    })
    const lines = ledgerLines(dir, session)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatchObject({
      v: 1,
      callId: 'legacy-call',
      key: legacy.key,
      status: 'committed',
      resolutionNote: 'verified target exists',
    })
    expect(lines[2].finishedAt).toBeGreaterThan(0)
  })

  test('does not report its own in-flight call as unresolved', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-reconcile-self')
    await fake.emit(
      'tools/pre-execute',
      toolCall(agent, 'target-1', 'write', { file_path: 'c.ts' }),
      enterNext(),
    )

    const reconcileCall = toolCall(agent, 'reconcile-self', 'effect_reconcile')
    await fake.emit('tools/pre-execute', reconcileCall, enterNext())
    const result = await fake.tools.get('effect_reconcile')!.execute({}, reconcileCall)
    expect(result.summary.total).toBe(1)
    expect(result.plan.map(entry => entry.callId)).toEqual(['target-1'])
  })
})

describe('effect_resolve', () => {
  test('appends a resolution, updates the index, and refuses terminal regressions', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-resolve')
    const target = toolCall(agent, 'resolve-target', 'write', { file_path: 'r.ts' })
    await fake.emit('tools/pre-execute', target, enterNext())

    const resolve = fake.tools.get('effect_resolve')!
    const resolverCall = toolCall(agent, 'resolver-1', 'effect_resolve')
    const first = await resolve.execute(
      { callId: 'resolve-target', resolution: 'compensated', note: 'reverted by hand' },
      resolverCall,
    )
    expect(first).toEqual({
      resolved: true,
      callId: 'resolve-target',
      status: 'compensated',
      unresolved: 0,
    })

    let lines = ledgerLines(dir, 'session-resolve')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({
      v: 1,
      callId: 'resolve-target',
      key: lines[0].key,
      tool: 'write',
      effectClass: 'reversible',
      status: 'compensated',
      resolutionNote: 'reverted by hand',
    })
    expect(lines[1].finishedAt).toBeGreaterThan(0)

    const status = await fake.tools.get('effect_status')!.execute({}, resolverCall)
    expect(status.counts).toMatchObject({
      pending: 0,
      unknown: 0,
      committed: 0,
      failed: 0,
      compensated: 1,
      abandoned: 0,
      total: 1,
    })
    expect(status.unresolved).toEqual([])

    // Repeating the same resolution is idempotent.
    const again = await resolve.execute(
      { callId: 'resolve-target', resolution: 'compensated' },
      resolverCall,
    )
    expect(again).toEqual({
      resolved: true,
      callId: 'resolve-target',
      status: 'compensated',
      unresolved: 0,
    })
    expect(ledgerLines(dir, 'session-resolve')).toHaveLength(2)

    // A terminal effect cannot be rewritten by another resolution.
    const regress = await resolve.execute(
      { callId: 'resolve-target', resolution: 'abandoned' },
      resolverCall,
    )
    expect(regress).toMatchObject({
      resolved: false,
      callId: 'resolve-target',
      status: 'compensated',
      unresolved: 0,
    })
    expect(ledgerLines(dir, 'session-resolve')).toHaveLength(2)

    await expect(
      resolve.execute({ callId: 'missing-call', resolution: 'committed' }, resolverCall),
    ).rejects.toThrow(/no effect record/)
  })

  test('folding ignores a pending record that follows a terminal record', async () => {
    const dir = tempDir()
    const session = 'session-fold-regression'
    const agent = agentFor(session)
    const terminal = {
      v: 1,
      at: 1,
      callId: 'fold-call',
      key: sha256('write\n{}'),
      tool: 'write',
      argsHash: sha256('{}'),
      effectClass: 'reversible',
      status: 'committed',
      finishedAt: 2,
    }
    const stale = { ...terminal, at: 3, status: 'pending' }
    writeFileSync(
      join(dir, `${session}.jsonl`),
      `${JSON.stringify(terminal)}\n${JSON.stringify(stale)}\n`,
      'utf8',
    )

    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const status = await fake.tools.get('effect_status')!.execute(
      { session_id: session },
      toolCall(agent, 'status-fold', 'effect_status'),
    )
    expect(status.counts).toMatchObject({ pending: 0, committed: 1, total: 1 })
    expect(status.unresolved).toEqual([])
  })
})

describe('effect ledger performance', () => {
  test('records 2000 pre-execute+result pairs in under 3 seconds', async () => {
    const dir = tempDir()
    const fake = fakeContext()
    applyEffects(fake.ctx, { effects: { dir } })
    const agent = agentFor('session-perf')
    const next = enterNext()

    const started = performance.now()
    for (let index = 0; index < 2000; index++) {
      const call = toolCall(agent, `perf-${index}`, 'write', { file_path: `src/f-${index}.ts` })
      await fake.emit('tools/pre-execute', call, next)
      await fake.emit('tools/result', call, { isError: false })
    }
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(3000)
    const status = await fake.tools.get('effect_status')!.execute(
      {},
      toolCall(agent, 'status-perf', 'effect_status'),
    )
    expect(status.counts).toMatchObject({ pending: 0, unknown: 0, committed: 2000, total: 2000 })
    expect(ledgerLines(dir, 'session-perf')).toHaveLength(4000)
  }, 60_000)
})
